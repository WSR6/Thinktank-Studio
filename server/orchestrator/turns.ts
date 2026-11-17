/**
 * The pieces of an agent's turn that don't need the orchestrator: its queue slots (`next` and
 * `nextAsk`), which chat messages go into the prompt and who the reply goes to, and how a reply's
 * [[ask:]] / [[to:]] prefix routes it.
 */
import type { ChatMessage } from '../types.js';
import { ASK_RE, DM_RE } from './markers.js';
import { HISTORY_WINDOW, type Ask, type Runtime, type TurnPlan, type TurnWatch } from './types.js';

/** One turn as it runs: what runTurnBody's steps share. */
export interface TurnCtx {
  r: Runtime;
  id: string;
  /** The project generation and the agent's stop counter the turn runs under. */
  gen: number;
  stopGen: number;
  /** This is the one retry of a failed turn. */
  retry: boolean;
  plan: TurnPlan;
  /** The question this turn answers, if any. */
  owed?: Ask;
  /** When this turn took its instructions: a review requested after this belongs to a later turn. */
  startedAt: number;
  /** The review stages open as this turn started: a stand-in verdict in its reply can only be about these. */
  openAtStart: Record<string, string>;
  /** Build attempts as this turn started: its done reports count only if no send-back happens meanwhile. */
  attemptsAtStart: Record<string, number>;
  /** A new conversation (no session to resume): the prompt carries the preamble and recent history. */
  fresh: boolean;
  replyTo: string;
  /** lastSeen once the turn succeeds. */
  seenUpTo: number;
  watch: TurnWatch;
  /** The last-resort time limit; cleared when the turn ends or is retried. */
  timer?: NodeJS.Timeout;
}

/** What a turn knows once it has taken its plan, before its prompt is built. */
export type TurnStart = Pick<TurnCtx, 'r' | 'id' | 'gen' | 'stopGen' | 'retry' | 'plan' | 'owed' | 'startedAt' | 'openAtStart' | 'attemptsAtStart'>;

/** Switched off, or out of usage (unless you messaged it directly). */
export function isAway(r: Runtime, plan: TurnPlan, now = Date.now()): boolean {
  return Boolean(r.disabled || (r.outUntil && r.outUntil > now && !plan.force));
}

/**
 * Put a plan in the agent's queue: a question's turn in a slot of its own (one open question per agent,
 * so it holds at most one); anything else merged with what's already queued, so a later plain enqueue
 * can't wipe a debate/phase instruction.
 */
export function queuePlan(r: Runtime, plan: TurnPlan): void {
  if (plan.askId) {
    r.nextAsk = plan;
    return;
  }
  const instruction = [r.next.instruction, plan.instruction].filter(Boolean).join('\n\n') || undefined;
  // A merged turn about more than one thing is no longer "only about that task".
  const forTask = r.hasNext && r.next.forTask !== plan.forTask ? undefined : plan.forTask;
  r.next = { ...r.next, ...plan, instruction, forTask };
  r.hasNext = true;
}

/** Take the plan for the turn starting now: a question's turn first, on its own. `more`: other work waits behind it. */
export function takePlan(r: Runtime): { plan: TurnPlan; more: boolean } {
  if (r.nextAsk) {
    const plan = r.nextAsk;
    r.nextAsk = undefined;
    return { plan, more: Boolean(r.hasNext) };
  }
  const plan = r.next;
  r.next = {};
  r.hasNext = false;
  return { plan, more: false };
}

/**
 * A failed turn is retried: keep anything queued while it ran (e.g. a review request) along with the
 * retried plan; a question's turn is retried on its own.
 */
export function requeueForRetry(r: Runtime, plan: TurnPlan): void {
  if (plan.askId) r.nextAsk = plan;
  else {
    const instruction = [plan.instruction, r.next.instruction].filter(Boolean).join('\n\n') || undefined;
    r.next = { ...r.next, ...plan, instruction };
    r.hasNext = true;
  }
}

/**
 * The chat messages a turn's prompt carries, who its reply goes to, and how far the agent will have
 * seen the chat once the turn succeeds.
 */
export function chatContext(
  messages: ChatMessage[],
  o: { id: string; lastSeen: number; plan: TurnPlan; owed?: Ask; fresh: boolean; isAgent: (id: string) => boolean; canSee: (m: ChatMessage) => boolean },
): { context: (readonly [ChatMessage, number])[]; newAttachments: string[]; replyTo: string; seenUpTo: number } {
  const { id, lastSeen, plan, owed, fresh } = o;
  const hidden = (m: ChatMessage, i: number) => plan.hideAgentsFrom !== undefined && i >= plan.hideAgentsFrom && o.isAgent(m.from) && m.from !== id;
  const visible = (m: ChatMessage, i: number) => o.canSee(m) && !hidden(m, i);

  const indexed = messages.map((m, i) => [m, i] as const);
  // Messages posted while this prompt is being built (e.g. a notice from reading tasks.json) aren't in it.
  const snapshotLength = messages.length;
  // A question's turn carries only the question: messages that arrived since its last turn are left
  // for its next one, so whatever they ask for gets a turn (and a reply to the room) of its own.
  const asked = Boolean(owed);
  const context = fresh
    ? indexed.filter(([m, i]) => visible(m, i) && (!asked || i < lastSeen)).slice(-HISTORY_WINDOW)
    : asked
      ? []
      : indexed.slice(lastSeen).filter(([m, i]) => visible(m, i) && m.from !== id);

  // Attachments go along only with the message they were attached to, not with every later turn.
  const newAttachments = context.filter(([m, i]) => i >= lastSeen && m.attachments?.length).flatMap(([m]) => m.attachments!);

  // A turn answering a private message replies privately to whoever sent it (you or a teammate),
  // so DMs don't leak to the others.
  const lastPrivate = [...context].reverse().find(([m]) => m.from !== 'system' && m.from !== id && !m.ask)?.[0];
  const replyTo = owed
    ? owed.from
    : !plan.public && lastPrivate && lastPrivate.to === id
      ? lastPrivate.from === 'user'
        ? 'user'
        : lastPrivate.from
      : 'all';

  // Only commit lastSeen when the turn succeeds; hidden debate proposals stay unseen for next turn.
  const firstHidden = indexed.find(([m, i]) => i >= lastSeen && hidden(m, i))?.[1];
  const seenUpTo = asked ? lastSeen : (firstHidden ?? snapshotLength);
  return { context, newAttachments, replyTo, seenUpTo };
}

/**
 * Where a reply goes, from its [[ask: id]] or [[to: id]] prefix (stripped from the text). `askTo`: it's
 * a question to that teammate. `askRefused`: it tried to ask but the per-message cap was reached, so it
 * goes to the room instead. A turn answering a question replies to the asker, unless it asks first.
 */
export function routeReply(
  raw: string,
  o: { id: string; replyTo: string; owed?: Ask; isAgent: (id: string) => boolean; canAsk: boolean },
): { text: string; to: string; askTo?: string; askRefused: boolean } {
  let text = raw;
  let to = o.replyTo;
  let askTo: string | undefined;
  let askRefused = false;
  const ask = text.match(ASK_RE);
  if (ask) {
    const target = ask[1].toLowerCase();
    text = text.slice(ask[0].length).trim();
    if (o.isAgent(target) && target !== o.id && o.canAsk) {
      askTo = target;
      to = target;
    } else {
      // Over the limit (or not a teammate): the text goes to the room instead of a private question.
      to = 'all';
      askRefused = !o.canAsk;
    }
  }
  if (o.owed && !askTo) to = o.owed.from; // the answer goes to the asker, whatever else the reply says
  const dm = askTo || o.owed ? null : text.match(DM_RE);
  if (dm) {
    const target = dm[1].toLowerCase();
    text = text.slice(dm[0].length).trim();
    if (o.isAgent(target) && target !== o.id) to = target;
    else if (target === 'user' || target === 'all') to = target;
  }
  return { text, to, askTo, askRefused };
}
