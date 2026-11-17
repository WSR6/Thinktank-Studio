/**
 * Questions between agents ([[ask: id]]): one open question per target at a time, each answered in a
 * turn of its own; the asker waits (its autopilot holds) until the answer, a failure or the timeout.
 */
import type { AgentEvent } from '../types.js';
import { answerInstruction, noAnswerInstruction, questionInstruction } from './prompts.js';
import { ASK_TIMEOUT_MS, MAX_ASKS, type Ask, type Runtime, type TurnPlan } from './types.js';

/** What the question board needs from the orchestrator. */
export interface AskHost {
  agent(id: string): Runtime | undefined;
  nameOf(id: string): string;
  /** Queue a turn for the agent (fire and forget). */
  enqueue(id: string, plan: TurnPlan): void;
  emitAgent(agentId: string, event: AgentEvent): void;
  system(text: string): void;
  saveMeta(): void;
  /** Something the UI shows changed. */
  changed(): void;
  unavailableReason(r: Runtime): string;
}

const waiting = (a: Ask) => a.status === 'open' || a.status === 'queued';

export class AskBoard {
  private asks: Ask[] = [];
  /** Question ids keep counting across restarts (saved in session.json), so q1 never means two questions. */
  seq = 0;
  /** Asks started since your last message (capped like DMs). */
  private count = 0;

  constructor(private host: AskHost) {}

  /** A project was opened: drop every question, continue ids from the saved counter. */
  reset(seq: number): void {
    this.seq = seq;
    this.count = 0;
    for (const a of this.asks) clearTimeout(a.timer);
    this.asks = [];
  }

  /** A message from you: room for new questions again. */
  newRound(): void {
    this.count = 0;
  }

  /** The question this agent asked and is still waiting on, if any. */
  waitingOn(agentId: string): Ask | undefined {
    return this.asks.find((a) => waiting(a) && a.from === agentId);
  }

  /** The question with this id, if it's still waiting for its answer. */
  open(askId: string | undefined): Ask | undefined {
    return askId ? this.asks.find((a) => a.id === askId && a.status === 'open') : undefined;
  }

  /** Room left for another question since your last message. */
  canAsk(): boolean {
    return this.count < MAX_ASKS;
  }

  /** Register a question. One question per target at a time, so each gets its own turn and answer. */
  start(from: string, to: string, question: string): void {
    this.count++;
    const a: Ask = { id: `q${++this.seq}`, from, to, question, at: Date.now(), status: 'queued', askerStop: this.host.agent(from)!.stopGen };
    this.host.saveMeta(); // the id counter survives a restart
    this.asks.push(a);
    const ahead = this.asks.find((x) => x !== a && x.to === to && x.status === 'open');
    this.host.emitAgent(from, { kind: 'log', text: `❓ asked ${this.host.nameOf(to)} (${a.id})${ahead ? `; queued behind ${ahead.id}` : ''}; waiting for the answer` });
    if (!ahead) this.send(a);
    this.host.changed();
  }

  /** Sent once, in a turn of its own. If it can't be answered the asker is told; never resent blindly. */
  private send(a: Ask): void {
    a.status = 'open';
    a.timer = setTimeout(() => this.expire(a), ASK_TIMEOUT_MS);
    this.host.enqueue(a.to, {
      askId: a.id,
      instruction: questionInstruction(this.host.nameOf(a.from), a.id, a.question),
    });
  }

  /** A question is done (answered, failed, expired, cancelled): send the target's next one, if any. */
  settle(a: Ask, status: Ask['status'], promote = true): void {
    a.status = status;
    clearTimeout(a.timer);
    const next = promote && this.asks.find((x) => x.to === a.to && x.status === 'queued');
    if (next) this.send(next);
    this.host.changed();
  }

  /** Resume the asker with the outcome, unless you stopped it since it asked. */
  resumeAsker(a: Ask, instruction: string): void {
    const asker = this.host.agent(a.from);
    if (!asker || asker.stopGen !== a.askerStop) return;
    // If the asker was itself answering someone when it asked, that answer is still owed.
    const owes = this.asks.find((x) => x.status === 'open' && x.to === a.from && x.nested);
    this.host.enqueue(a.from, { public: !owes, ...(owes ? { askId: owes.id } : {}), instruction });
  }

  answer(a: Ask, answer: string): void {
    this.settle(a, 'answered');
    const by = this.host.nameOf(a.to);
    this.host.emitAgent(a.from, { kind: 'log', text: answer ? `✔ ${by} answered ${a.id}` : `✖ ${by} couldn't answer ${a.id}` });
    this.resumeAsker(a, answerInstruction(by, a.id, answer));
  }

  /** The agent being asked can't answer (stopped, failed, timed out): tell its askers so they don't wait. */
  failTo(id: string, why: string): void {
    // All of them fail together, so none is promoted (that would start a turn on an agent just stopped).
    for (const a of this.asks.filter((x) => waiting(x) && x.to === id)) {
      this.settle(a, 'failed', false);
      this.resumeAsker(a, noAnswerInstruction(this.host.nameOf(id), a.id, why));
    }
  }

  /** A question's turn for an agent that is away (off or out of usage): the asker is told now, not at expiry. */
  failAway(r: Runtime, plan: TurnPlan): void {
    const a = this.open(plan.askId);
    if (!a) return;
    this.settle(a, 'failed');
    this.resumeAsker(a, `${r.cfg.name} is ${this.host.unavailableReason(r)}, so it can't answer your question (${a.id}). Continue without it, ask someone else, or ask the user (@user).`);
  }

  /** You stopped the asker (or everyone): its questions are withdrawn and nothing restarts it. */
  cancelFrom(id?: string): void {
    for (const a of this.asks.filter((x) => waiting(x) && (!id || x.from === id))) this.settle(a, 'failed');
  }

  private expire(a: Ask): void {
    if (a.status !== 'open') return;
    // Being answered right now, or its turn is next in line: give it time rather than releasing the asker early.
    const target = this.host.agent(a.to);
    if (target?.answering === a.id || target?.nextAsk?.askId === a.id) {
      a.timer = setTimeout(() => this.expire(a), ASK_TIMEOUT_MS);
      return;
    }
    this.settle(a, 'expired');
    this.host.system(`${this.host.nameOf(a.to)} didn't answer ${this.host.nameOf(a.from)}'s question (${a.id}) within ${ASK_TIMEOUT_MS / 60_000} min.`);
    this.resumeAsker(
      a,
      `No answer from ${this.host.nameOf(a.to)} to your question (${a.id}) after ${ASK_TIMEOUT_MS / 60_000} min. Continue without it, or ask the user (@user). Don't ask the same question again unless something changed.`,
    );
  }
}
