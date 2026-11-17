/**
 * The review pipeline: once a task is done (and its "done" checked), it goes through the stages its
 * owner's pipeline sets (first / final / cross review by agents, then the tests and desktop tests the
 * app runs) until it's accepted, or sent back with the reviewer's notes. Also your Tasks-tab buttons
 * (approve, send back, restart, reassign the reviewer or the builder).
 */
import { agentWritableDirs, branchTip, type ProjectInfo } from '../project.js';
import { isMachineStage, MAX_REVIEW_ROUNDS, runTests, saveReviews, STAGE_LABELS, type ReviewEntry, type Reviews, type StageKind } from '../reviews.js';
import type { RoleAssignment, RolesState, ReviewMode } from '../roles.js';
import type { AgentEvent, Phase } from '../types.js';
import { approvedThisRound, namesTask, reviewKey, reviewVerdict } from './markers.js';
import { newOwnerInstruction, reviewInstruction, sendBackInstruction, verdictReaskInstruction, whichTaskInstruction } from './prompts.js';
import { handoffText } from './tasks.js';
import { NOT_ASKED_YET, type Runtime, type Task, type TurnPlan } from './types.js';

/** What the review pipeline needs from the orchestrator (read live: these change as the app runs). */
export interface ReviewHost {
  readonly agents: Map<string, Runtime>;
  readonly project: ProjectInfo | undefined;
  /** Bumped on project switch; work from an older generation is dropped. */
  readonly gen: number;
  readonly phase: Phase;
  readonly autopilot: boolean;
  readonly roles: RolesState;
  readonly reviewMode: ReviewMode;
  readonly testCommand: string;
  readonly desktopTestCommand: string;
  /** Build attempt per task, when each was last sent back, and which attempt's "done" was checked (see the orchestrator). */
  readonly attempts: Record<string, number>;
  readonly sentBack: Record<string, { at: number; tip?: string }>;
  readonly doneOk: Record<string, number>;
  readonly noCommits: Record<string, unknown>;
  /** Tasks already announced as accepted, so dependants are released once. */
  readonly acceptedSeen: Set<string>;
  attemptOf(taskId: string): number;
  doneChecked(t: Task): boolean;
  settleDone(id: string, t: Task, attempt: number, note: string, reported: boolean): Promise<void>;
  readTasks(): Promise<Task[]>;
  updateTask(taskId: string, patch: Partial<Task> | ((t: Task) => Partial<Task> | undefined)): Promise<boolean>;
  wakeForNewTasks(tasks: Task[]): void;
  onTaskAccepted(taskId: string): Promise<void>;
  checkAllDone(tasks: Task[]): void;
  roleOf(id: string): RoleAssignment;
  available(id: string): boolean;
  unavailableReason(r: Runtime): string;
  enqueue(id: string, plan?: TurnPlan): Promise<void>;
  reviewCheckout(owner: string, reviewer: string): Promise<{ dir: string; name: string }>;
  ensureSetup(key: string, dir: string, logTo?: string): Promise<void>;
  pendingSetup(dirs: string[]): Promise<void>[];
  /** The task reached its desktop-tests stage (see DesktopTests.queue). */
  queueDesktop(taskId: string): void;
  nameOf(id: string): string;
  system(text: string): void;
  notice(text: string): void;
  /** Log an error; with `text`, also tell the user (see Reporter). */
  report(key: string, e: unknown, text?: string): void;
  emitAgent(agentId: string, event: AgentEvent): void;
  emit(event: 'state'): void;
  saveMeta(): void;
}

const REVIEW_STEP_FAILED =
  'A review step for finished tasks failed, so a task may sit in review with nothing happening. In the Tasks tab you can Restart its review or Approve it yourself';
const SAVE_REVIEWS_FAILED = "Couldn't save review progress to team/reviews.json; it's kept in memory, but would be lost if the app closed now";

export class ReviewFlow {
  reviews: Reviews = {};
  /** Review steps run one at a time, so two triggers can't race. */
  reviewQueue: Promise<void> = Promise.resolve();

  /**
   * Run a review step after the ones already queued. A step that fails is logged and you're told
   * (a task may otherwise sit in review with nothing happening); the queue carries on either way.
   */
  queue(step: () => unknown): Promise<void> {
    this.reviewQueue = this.reviewQueue.then(step).then(
      () => undefined,
      (e) => this.o.report('review step', e, REVIEW_STEP_FAILED),
    );
    return this.reviewQueue;
  }
  /** Reviews already reported as waiting for an unavailable reviewer (task:stage:agent). */
  private parkNoticed = new Set<string>();
  /** When each task last passed review (ms), to spot a reopen from a turn that started before that. */
  private acceptedAt: Record<string, number> = {};
  /** The latest send-back instruction per task, so an acceptance can withdraw it if it hasn't run yet. */
  private queuedSendBacks: Record<string, { owner: string; text: string }> = {};

  constructor(private o: ReviewHost) {}

  // ── Review pipeline ───────────────────────────────────────────────────

  /** The checks a task owned by `owner` goes through once it's marked done. */
  /** Stages come from the roles as set, even if a reviewer is away right now: its stage waits (or you pick another). */
  pipelineFor(owner: string): StageKind[] {
    const stages: StageKind[] = [];
    if (this.o.reviewMode === 'chain' && this.o.roles.enabled) {
      if (this.holders('first_reviewer', owner, true).length) stages.push('first');
      if (this.holders('final_reviewer', owner, true).length) stages.push('final');
    } else if (this.o.reviewMode === 'cross' || this.o.reviewMode === 'chain') {
      // Chain with roles off falls back to a single cross-review.
      if ([...this.o.agents.keys()].some((id) => id !== owner)) stages.push('cross');
    }
    if (this.o.testCommand) stages.push('tests');
    if (this.o.desktopTestCommand) stages.push('desktop');
    return stages;
  }

  /** Agents holding a role, never the task's own owner (no reviewing your own work). */
  private holders(role: RoleAssignment['role'], owner: string, all = false): string[] {
    return [...this.o.agents.keys()].filter((id) => id !== owner && this.o.roleOf(id).role === role && (all || this.o.available(id)));
  }

  /**
   * The task was accepted: take its send-back out of the owner's queued turn or away-work if it hasn't run
   * yet, even when it was merged with other work. A queued turn left with nothing to do ends at once and
   * hands back to autopilot (see runTurn).
   */
  private dropSendBack(taskId: string): void {
    const q = this.queuedSendBacks[taskId];
    delete this.queuedSendBacks[taskId];
    const r = q ? this.o.agents.get(q.owner) : undefined;
    if (!q || !r) return;
    if (r.awayWork) r.awayWork = r.awayWork.map((w) => w.replace(q.text, '').trim()).filter(Boolean);
    if (r.hasNext && r.next.instruction?.includes(q.text)) {
      // The turn still runs for anything else it holds (e.g. your new messages); with nothing left it's dropped.
      const rest = r.next.instruction.replace(q.text, '').replace(/\n{3,}/g, '\n\n').trim();
      r.next = { ...r.next, instruction: rest || undefined, forTask: undefined };
    }
  }

  /** True when the owner hasn't started a turn since the task was accepted, so any reopen is out of date. */
  reopenedByStaleTurn(t: Task): boolean {
    const at = this.acceptedAt[t.id];
    const owner = t.owner ? this.o.agents.get(t.owner) : undefined;
    return Boolean(at && owner?.turnStartedAt && owner.turnStartedAt < at);
  }

  accepted(t: Task): boolean {
    if (t.status !== 'done') return false;
    if (this.reviews[t.id]?.status === 'passed') return true;
    return !this.pipelineFor(t.owner ?? '').length && this.o.doneChecked(t);
  }

  /** Agents that already approved a stage of this task since it was last sent back. */
  private roundReviewers(rec: ReviewEntry): string[] {
    const lastBack = Math.max(rec.history.map((h) => h.verdict).lastIndexOf('changes') + 1, rec.roundStart ?? 0);
    return rec.history.slice(lastBack).filter((h) => h.verdict === 'approve' && this.o.agents.has(h.by)).map((h) => h.by);
  }

  /** Who reviews this stage: the role holder, or for cross-review the least-busy other agent. */
  private reviewerFor(stage: StageKind, owner: string, rec?: ReviewEntry): string | undefined {
    // A re-review after changes goes back to whoever last reviewed this stage (a stand-in too):
    // they know what they asked for.
    const previous = [...(rec?.history ?? [])].reverse().find((h) => h.stage === stage && this.o.agents.has(h.by) && h.by !== owner && this.o.available(h.by))?.by;
    if (previous) return previous;
    if (stage === 'first') return this.holders('first_reviewer', owner)[0];
    if (stage === 'final') return this.holders('final_reviewer', owner)[0];
    const others = [...this.o.agents.values()].filter((r) => r.cfg.id !== owner && this.o.available(r.cfg.id));
    const load = (id: string) => Object.values(this.reviews).filter((e) => e.history.some((h) => h.by === id)).length;
    others.sort((a, b) => Number(a.status === 'working') - Number(b.status === 'working') || load(a.cfg.id) - load(b.cfg.id));
    return others[0]?.cfg.id;
  }

  /**
   * Look at tasks.json and move reviews along: a task newly marked done starts its pipeline;
   * a task reopened by its owner cancels its review. Serialized so two triggers can't race.
   */
  advanceReviews(): void {
    void this.queue(() => this.advanceReviewsNow());
  }

  private async advanceReviewsNow(): Promise<void> {
    if (!this.o.project) return;
    const gen = this.o.gen;
    const tasks = await this.o.readTasks();
    if (gen !== this.o.gen) return; // project switched while reading
    this.o.wakeForNewTasks(tasks);
    let changed = false;
    for (const t of tasks) {
      const rec = this.reviews[t.id];
      if (t.status === 'done' && !this.o.doneChecked(t) && rec?.status !== 'passed') {
        // Not checked yet: nothing starts on it (review, acceptance, dependants) until it is. Its owner's
        // running turn gets it checked when it ends; otherwise check it now.
        const owner = t.owner ? this.o.agents.get(t.owner) : undefined;
        if (owner?.current) continue;
        if (owner) await this.o.settleDone(owner.cfg.id, t, this.o.attemptOf(t.id), '', false);
        else {
          this.o.doneOk[t.id] = this.o.attemptOf(t.id); // no agent owns it (e.g. yours): nothing to check
          this.advanceReviews();
        }
        continue;
      }
      // Reopened: a later "done" is checked again.
      if (t.status !== 'done' && t.id in this.o.doneOk) delete this.o.doneOk[t.id];
      if (t.status === 'done') {
        if (rec && rec.status !== 'changes') continue;
        const stages = this.pipelineFor(t.owner ?? '');
        if (!stages.length) {
          // No review step: done means accepted, so release anything waiting on it.
          await this.o.onTaskAccepted(t.id);
          continue;
        }
        this.reviews[t.id] = { status: 'in_review', stages, stage: 0, rounds: rec?.rounds ?? 0, history: rec?.history ?? [], roundStart: rec?.roundStart };
        changed = true;
        await this.dispatchStage(t);
      } else if (rec?.status === 'passed' && this.reopenedByStaleTurn(t)) {
        // Accepted while its owner's turn was already running: that turn's "doing" is out of date.
        this.o.doneOk[t.id] = this.o.attemptOf(t.id); // still the accepted attempt, so its "done" stays checked
        await this.o.updateTask(t.id, (cur) => (cur.status !== 'done' ? { status: 'done', note: '' } : undefined));
        this.o.system(`${t.id} was already accepted, so it stays done (a change from before the acceptance had reopened it).`);
      } else if (rec && (rec.status === 'in_review' || rec.status === 'passed')) {
        // The owner reopened it: start over when it's done again, as a new round (earlier approvals
        // were for the old version, so they don't rule anyone out as a reviewer).
        if (rec.status === 'passed') this.o.acceptedSeen.delete(t.id); // a later acceptance releases and merges again
        rec.status = 'changes';
        rec.waitingOn = undefined;
        rec.roundStart = rec.history.length;
        changed = true;
      }
    }
    if (changed) this.saveReviewState();
    await this.dispatchParked();
  }

  /** Start the current stage of a task's review: ask the reviewer, or run the tests. */
  async dispatchStage(t: Task): Promise<void> {
    const rec = this.reviews[t.id];
    if (!rec || rec.status !== 'in_review' || !this.o.project) return;
    const stage = rec.stages[rec.stage];
    const owner = t.owner ?? '';
    if (stage === 'desktop') {
      // Waits for Run now: these tests take over the mouse, so they never start on their own.
      rec.waitingOn = undefined;
      if (!this.o.desktopTestCommand) {
        rec.history.push({ ts: Date.now(), by: 'desktop', stage, verdict: 'approve', notes: 'Skipped: no desktop test command.' });
        return this.nextStage(t);
      }
      this.o.queueDesktop(t.id);
      return;
    }
    if (stage === 'tests') {
      rec.waitingOn = undefined;
      this.o.system(`${t.id} → running tests: \`${this.o.testCommand}\``);
      const dir = this.o.project.agentDirs[owner] ?? this.o.project.repoDir;
      const gen = this.o.gen;
      // In the background: a long test run mustn't hold up other reviews. After setup there, if it's running.
      // Set up again first if its dependency files changed since (the owner may have fast-forwarded to another branch).
      if (this.o.project.agentDirs[owner]) void this.o.ensureSetup(owner, dir, owner);
      void Promise.all(this.o.pendingSetup([dir]))
        .then(() => runTests(this.o.testCommand, dir))
        .then((result) => {
          if (gen !== this.o.gen) return;
          void this.queue(() => this.applyVerdict(t.id, 'tests', 'tests', result.ok ? 'approve' : 'changes', result.ok ? 'Tests passed.' : result.output));
        })
        .catch((e) =>
          this.o.report(`tests for ${t.id}`, e, `The tests for ${t.id} couldn't be run, so it waits in review. In the Tasks tab you can Restart its review or Approve it yourself.`),
        );
      return;
    }
    let reviewer = this.reviewerFor(stage, owner, rec);
    // Two stages are two pairs of eyes: someone who already approved this round doesn't do the next
    // stage too. Hand it to another available agent if there is one, else wait for you to pick.
    if (reviewer && this.roundReviewers(rec).includes(reviewer)) {
      const already = reviewer;
      reviewer = [...this.o.agents.keys()].find((id) => id !== owner && this.o.available(id) && !this.roundReviewers(rec).includes(id));
      if (reviewer) {
        this.o.system(`${this.o.nameOf(already)} already did an earlier stage of ${t.id}, so ${this.o.nameOf(reviewer)} does the ${STAGE_LABELS[stage]}.`);
      } else {
        const key = `${t.id}:${rec.stage}:repeat:${already}`;
        if (!this.parkNoticed.has(key)) {
          this.parkNoticed.add(key);
          this.o.notice(
            `${t.id} "${t.title ?? ''}" waits for its ${STAGE_LABELS[stage]}: ${this.o.nameOf(already)} already did an earlier stage and no one else is available. ` +
              'Pick a reviewer under "Review by" in the Tasks tab when one is back, or Approve it yourself.',
          );
        }
        rec.waitingOn = undefined;
        return;
      }
    }
    // The reviewer for this stage exists but is off or out of usage: wait for it (or for you to pick another).
    const absent = !reviewer
      ? stage === 'cross'
        ? [...this.o.agents.keys()].find((id) => id !== owner)
        : this.holders(stage === 'first' ? 'first_reviewer' : 'final_reviewer', owner, true)[0]
      : undefined;
    if (!reviewer && absent) {
      rec.waitingOn = undefined;
      const key = `${t.id}:${rec.stage}:${absent}`;
      if (!this.parkNoticed.has(key)) {
        this.parkNoticed.add(key);
        this.o.notice(
          `${t.id} "${t.title ?? ''}" waits for its ${STAGE_LABELS[stage]}: ${this.o.nameOf(absent)} is ${this.o.unavailableReason(this.o.agents.get(absent)!)}. ` +
            'It starts when they are back, or pick another reviewer under "Review by" in the Tasks tab.',
        );
      }
      return;
    }
    if (!reviewer) {
      rec.history.push({ ts: Date.now(), by: 'system', stage, verdict: 'skip', notes: 'No reviewer available for this stage.' });
      return this.nextStage(t);
    }
    // One review at a time per reviewer, so each verdict clearly belongs to one task.
    if (Object.entries(this.reviews).some(([id, e]) => id !== t.id && e.status === 'in_review' && e.waitingOn === reviewer)) {
      rec.waitingOn = undefined;
      return;
    }
    rec.waitingOn = reviewer;
    rec.askedAt = NOT_ASKED_YET;
    this.o.system(`${t.id} "${t.title ?? ''}" → ${STAGE_LABELS[stage]} by ${this.o.nameOf(reviewer)}.`);
    // A fresh checkout of their branch to run and test, so the reviewer never merges it into its own.
    const checkout = await this.o.reviewCheckout(owner, reviewer).catch((e) => {
      this.o.report('review checkout', e, `Couldn't prepare a fresh copy of ${this.o.nameOf(owner)}'s branch for ${this.o.nameOf(reviewer)} to review ${t.id}, so it reviews without one`);
      return undefined;
    });
    rec.reviewedTip = await branchTip(this.o.project, owner).catch((e) => {
      this.o.report('branch tip', e); // keeps the tip from the last review; only matters for which commit gets merged
      return rec.reviewedTip;
    });
    // Stamped only now: a turn the reviewer started while the checkout (and its setup) was being
    // prepared, e.g. its own build turn, isn't the review and mustn't count as one.
    rec.askedAt = Date.now();
    void this.o.enqueue(reviewer, {
      instruction: this.reviewInstruction(t, stage, rec, checkout?.dir),
      extraDirs: checkout ? [checkout.dir, ...agentWritableDirs(this.o.project, checkout.name).slice(1, 2)] : [],
    });
  }

  private reviewInstruction(t: Task, stage: StageKind, rec: ReviewEntry, checkout?: string): string {
    return reviewInstruction(t, stage, rec, (id) => this.o.nameOf(id), handoffText(t), checkout);
  }

  /** A reviewer's reply: apply its verdict to the task it was reviewing. */
  /**
   * `openAtStart`: the review stage (and round) each task was at when this turn started, so a stand-in
   * verdict can't land on a later stage it never saw. `anywhere`: look for the verdict in the whole
   * text (a reply cut off by a nudge or the turn limit may end with status text after it).
   */
  onReviewReply(id: string, text: string, turnStartedAt: number, openAtStart: Record<string, string> = {}, anywhere = false): void {
    const { verdict, taskId: markerTask } = reviewVerdict(text, anywhere);
    // A turn already running when the review was requested isn't the review.
    const entry = Object.entries(this.reviews).find(
      ([, e]) => e.status === 'in_review' && e.waitingOn === id && (e.askedAt ?? 0) <= turnStartedAt,
    );
    // The reply names another task under review, not the one assigned: the verdict is for that one.
    const elsewhere =
      entry && (markerTask ? markerTask !== entry[0].toLowerCase() : !namesTask(text, entry[0]) && Object.keys(this.reviews).some((t) => t !== entry[0] && this.reviews[t].status === 'in_review' && namesTask(text, t)));
    if (elsewhere) {
      // Its own review wasn't done: release it so it's asked again (or someone else is) instead of staying stuck.
      const [ownId, own] = entry;
      own.history.push({ ts: Date.now(), by: id, stage: own.stages[own.stage], verdict: 'none', notes: `Replied about another task instead of ${ownId}.` });
      own.waitingOn = undefined;
      this.saveReviewState();
    }
    if (!entry || elsewhere) {
      // Not the assigned reviewer (or not this task): a stand-in's verdict still counts (see applyStandInVerdict).
      void this.queue(async () => {
        if (verdict) await this.applyStandInVerdict(id, text, verdict, openAtStart, markerTask);
        if (elsewhere) await this.dispatchParked();
      });
      return;
    }
    const [taskId, rec] = entry;
    const stage = rec.stages[rec.stage];
    const notes = text.replace(/\[\[\s*verdict[^\]]*\]\]/gi, '').trim();
    // One pair of eyes per stage: an approval from someone who already approved this round doesn't count.
    if (verdict === 'approve' && approvedThisRound(rec, id)) {
      rec.history.push({ ts: Date.now(), by: id, stage, verdict: 'none', notes: 'Already approved an earlier stage this round.' });
      rec.waitingOn = undefined;
      this.o.notice(`${this.o.nameOf(id)} already approved ${taskId} this round, so its approval of the ${STAGE_LABELS[stage]} doesn't count; another agent or you must do it.`);
      void this.queue(() => this.dispatchParked());
      this.saveReviewState();
      return;
    }
    if (!verdict) {
      rec.history.push({ ts: Date.now(), by: id, stage, verdict: 'none', notes: notes.slice(0, 2000) });
      // Usually it just forgot the marker line: ask it once to add one, before bothering you.
      if (rec.reasked !== reviewKey(rec)) {
        rec.reasked = reviewKey(rec);
        rec.askedAt = Date.now();
        this.o.emitAgent(id, { kind: 'log', text: `(reviewed ${taskId} without the verdict line; the app asked for one)` });
        void this.o.enqueue(id, {
          instruction: verdictReaskInstruction(taskId, stage),
        });
        this.saveReviewState();
        return;
      }
      this.o.notice(`${this.o.nameOf(id)} reviewed ${taskId} but twice didn't say approve or changes. Decide in the Tasks tab: Approve, or Send back.`);
      this.saveReviewState();
      return;
    }
    void this.queue(() => this.applyVerdict(taskId, id, stage, verdict, notes));
  }

  /**
   * A verdict from an agent that wasn't asked (e.g. it stood in for a reviewer who ran out of usage).
   * It counts for the task's current stage if the agent didn't build it and it's clear which task:
   * the reply names exactly one task under review, or only one is under review.
   */
  /** This agent holds the role for a stage of this review that hasn't come yet (so it will be asked then). */
  private reviewsLater(e: ReviewEntry, id: string): boolean {
    const role = this.o.roleOf(id).role;
    return e.stages.some((st, i) => i > e.stage && ((st === 'first' && role === 'first_reviewer') || (st === 'final' && role === 'final_reviewer')));
  }

  /** "Which task?" re-asks already sent (agent + the reviews it could mean), so it's asked once. */
  private whichTaskAsked = new Set<string>();

  private async applyStandInVerdict(id: string, text: string, verdict: 'approve' | 'changes', openAtStart: Record<string, string>, markerTask?: string): Promise<void> {
    const gen = this.o.gen;
    const tasks = await this.o.readTasks();
    if (gen !== this.o.gen) return;
    // Only reviews this turn could see: the same stage and round as when it started (so a late reply
    // to a stage that has since moved on, e.g. from the original reviewer, can't approve the next one).
    const open = Object.entries(this.reviews).filter(
      ([taskId, e]) =>
        e.status === 'in_review' &&
        !isMachineStage(e.stages[e.stage]) &&
        tasks.find((t) => t.id === taskId)?.owner !== id &&
        openAtStart[taskId] === reviewKey(e) &&
        !approvedThisRound(e, id),
    );
    const names = (taskId: string) => markerTask ? taskId.toLowerCase() === markerTask : namesTask(text, taskId);
    const named = open.filter(([taskId]) => names(taskId));
    // It names a task under review that it can't give the verdict on: say why, and don't guess another.
    const barred = named.length
      ? []
      : Object.keys(this.reviews).filter((t) => this.reviews[t].status === 'in_review' && names(t) && !open.some(([o]) => o === t));
    if (barred.length || !open.length || (markerTask && !named.length)) {
      for (const t of barred) {
        const e = this.reviews[t];
        const own = tasks.find((x) => x.id === t)?.owner === id;
        if (!own && !approvedThisRound(e, id) && this.reviewsLater(e, id)) {
          this.o.emitAgent(id, { kind: 'log', text: `(verdict on ${t} came before its stage; it will be asked at its stage)` });
          continue;
        }
        this.o.notice(
          tasks.find((x) => x.id === t)?.owner === id
            ? `${this.o.nameOf(id)} can't give the verdict on its own task ${t}; a teammate or you must review it.`
            : approvedThisRound(e, id)
              ? `${this.o.nameOf(id)} already approved ${t} this round, so its verdict doesn't count again; another agent or you must do this stage.`
              : `${this.o.nameOf(id)}'s verdict on ${t} was for an earlier stage, so it doesn't count; use Approve / Send back in the Tasks tab.`,
        );
      }
      return;
    }
    const pick = named.length === 1 ? named[0] : !named.length && open.length === 1 ? open[0] : undefined;
    if (!pick) {
      const candidates = named.length ? named : open;
      // Share the missing-verdict guard: one clarification per stage and round, never a loop.
      const askKey = `${id}:${candidates.map(([t, rec]) => `${t}@${reviewKey(rec)}`).join(',')}`;
      if (!this.whichTaskAsked.has(askKey)) {
        this.whichTaskAsked.add(askKey);
        this.o.emitAgent(id, { kind: 'log', text: '(gave a verdict without a clear task id; the app asked it to name the task)' });
        void this.o.enqueue(id, {
          instruction: whichTaskInstruction(candidates.map(([t]) => t)),
        });
        this.saveReviewState();
        return;
      }
      this.o.notice(
        `${this.o.nameOf(id)} gave a verdict, but it's not clear which task it's for (${(named.length ? named : open).map(([t]) => t).join(', ')}). ` +
          'Ask it to name the task id, or use Approve / Send back in the Tasks tab.',
      );
      return;
    }
    const [taskId, rec] = pick;
    const stage = rec.stages[rec.stage];
    const assigned = rec.waitingOn ? this.o.nameOf(rec.waitingOn) : 'the assigned reviewer';
    if (rec.waitingOn !== id) this.o.system(`${this.o.nameOf(id)} reviewed ${taskId} in place of ${assigned}; its verdict counts for the ${STAGE_LABELS[stage]}.`);
    const notes = text.replace(/\[\[\s*verdict[^\]]*\]\]/gi, '').trim();
    await this.applyVerdict(taskId, id, stage, verdict, notes);
  }

  async applyVerdict(taskId: string, by: string, stage: StageKind, verdict: 'approve' | 'changes', notes: string): Promise<void> {
    const gen = this.o.gen;
    const tasks = await this.o.readTasks();
    if (gen !== this.o.gen) return; // project switched: this verdict belongs to the old one
    const rec = this.reviews[taskId];
    if (!rec || rec.status !== 'in_review') return;
    rec.history.push({ ts: Date.now(), by, stage, verdict, notes: notes.slice(0, 4000) });
    rec.waitingOn = undefined;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return this.saveReviewState();
    if (verdict === 'approve') await this.nextStage(task);
    else await this.sendBack(task, by, stage, notes);
    await this.dispatchParked();
    this.saveReviewState();
  }

  private async nextStage(t: Task): Promise<void> {
    const rec = this.reviews[t.id];
    rec.stage++;
    if (rec.stage < rec.stages.length) return this.dispatchStage(t);
    rec.status = 'passed';
    this.acceptedAt[t.id] = Date.now();
    this.dropSendBack(t.id);
    if (/^Changes requested by /.test(t.note ?? '')) await this.o.updateTask(t.id, { note: '' });
    const trail = rec.history
      .slice(-rec.stages.length)
      .filter((h) => h.verdict === 'approve')
      .map((h) => (h.stage === 'tests' ? 'tests passed' : h.stage === 'desktop' ? (h.notes.startsWith('Skipped') ? 'desktop tests skipped' : 'desktop tests passed') : `${STAGE_LABELS[h.stage]}: ${this.o.nameOf(h.by)}`))
      .join(', ');
    this.o.system(`✓ ${t.id} "${t.title ?? ''}" accepted${trail ? ` (${trail})` : ''}.`);
    await this.o.onTaskAccepted(t.id);
    this.o.checkAllDone(await this.o.readTasks());
  }

  /** Changes requested: reopen the task for its owner with the reviewer's notes. */
  private async sendBack(t: Task, by: string, stage: StageKind, notes: string): Promise<void> {
    const rec = this.reviews[t.id];
    const owner = t.owner ?? '';
    rec.rounds++;
    const who = by === 'tests' ? 'the tests' : by === 'desktop' ? 'the desktop tests' : by === 'user' ? 'you' : `${this.o.nameOf(by)} (${STAGE_LABELS[stage]})`;
    // The cap stops reviewer loops; your own Send back always reaches the builder.
    if (rec.rounds > MAX_REVIEW_ROUNDS && by !== 'user') {
      rec.status = 'stuck';
      this.o.notice(`${t.id} has been sent back ${MAX_REVIEW_ROUNDS} times. Decide in the Tasks tab: approve it, send it back again, or restart its review.`);
      return;
    }
    rec.status = 'changes';
    this.o.attempts[t.id] = this.o.attemptOf(t.id) + 1;
    this.o.sentBack[t.id] = { at: Date.now(), tip: owner ? await this.tipOrNone(owner) : undefined };
    this.o.saveMeta();
    await this.o.updateTask(t.id, { status: 'doing', note: `Changes requested by ${who}` });
    this.o.system(`↩ ${t.id} sent back to ${this.o.nameOf(owner)} by ${who} (round ${rec.rounds}).`);
    if (owner && this.o.agents.has(owner)) {
      const ro = this.o.agents.get(owner)!;
      if (this.o.autopilot && this.o.phase === 'build') ro.loop = { active: true, turns: 0, idle: 0 };
      const instruction = sendBackInstruction(t, who, this.o.attemptOf(t.id), notes);
      // Remembered so accepting the task before this turn runs can take it back out (see dropSendBack).
      this.queuedSendBacks[t.id] = { owner, text: instruction };
      void this.o.enqueue(owner, { instruction, keepIfAway: true, forTask: t.id });
    }
  }

  /**
   * Re-try every review parked because its reviewer was busy (in review, no reviewer asked yet).
   * dispatchStage parks it again if its reviewer is still busy. Tests run in the background, so skip them.
   */
  async dispatchParked(): Promise<void> {
    const parked = Object.entries(this.reviews).filter(([, e]) => e.status === 'in_review' && !e.waitingOn && !isMachineStage(e.stages[e.stage]));
    if (!parked.length) return;
    const gen = this.o.gen;
    const tasks = await this.o.readTasks();
    if (gen !== this.o.gen) return;
    for (const [id, e] of parked) {
      const t = tasks.find((x) => x.id === id);
      if (t && e.status === 'in_review' && !e.waitingOn) await this.dispatchStage(t);
    }
  }

  /** The user's buttons in the Tasks tab: approve, send back with a note, or restart the review. */
  async reviewAction(taskId: string, action: 'approve' | 'send_back' | 'restart' | 'reassign' | 'set_owner', note = ''): Promise<void> {
    const task = (await this.o.readTasks()).find((t) => t.id === taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    const rec = this.reviews[taskId];
    if (action === 'set_owner') {
      await this.setOwner(task, note.trim());
      return;
    }
    if (action === 'restart') {
      delete this.reviews[taskId];
      this.saveReviewState();
      this.advanceReviews();
      return;
    }
    if (!rec) throw new Error(`${taskId} isn't in review`);
    const stage = rec.stages[Math.min(rec.stage, rec.stages.length - 1)];
    if (action === 'reassign') {
      // "Review by": you pick who does the current stage (e.g. the usual reviewer is out of usage).
      const by = note.trim();
      if (rec.status !== 'in_review' || isMachineStage(stage)) throw new Error(`${taskId} isn't waiting for a reviewer`);
      if (!this.o.agents.has(by) || by === task.owner) throw new Error('Pick an agent other than the builder');
      if (!this.o.available(by)) throw new Error(`${this.o.nameOf(by)} is ${this.o.unavailableReason(this.o.agents.get(by)!)}`);
      const busy = Object.entries(this.reviews).find(([id, e]) => id !== taskId && e.status === 'in_review' && e.waitingOn === by);
      if (busy) throw new Error(`${this.o.nameOf(by)} is already reviewing ${busy[0]}; pick someone else, or wait until that review is done`);
      if (this.roundReviewers(rec).includes(by)) {
        throw new Error(`${this.o.nameOf(by)} already reviewed ${taskId} in this round; pick someone else, or Approve it yourself`);
      }
      rec.waitingOn = by;
      rec.askedAt = NOT_ASKED_YET;
      this.o.system(`${taskId} "${task.title ?? ''}" → ${STAGE_LABELS[stage]} by ${this.o.nameOf(by)} (your pick).`);
      const owner = task.owner ?? '';
      const checkout =
        this.o.project && owner
          ? await this.o.reviewCheckout(owner, by).catch((e) => {
              this.o.report('review checkout', e, `Couldn't prepare a fresh copy of ${this.o.nameOf(owner)}'s branch for ${this.o.nameOf(by)} to review ${taskId}, so it reviews without one`);
              return undefined;
            })
          : undefined;
      rec.askedAt = Date.now(); // see dispatchStage
      void this.o.enqueue(by, {
        instruction: this.reviewInstruction(task, stage, rec, checkout?.dir),
        extraDirs: checkout && this.o.project ? [checkout.dir, ...agentWritableDirs(this.o.project, checkout.name).slice(1, 2)] : [],
      });
      this.saveReviewState();
      return;
    }
    if (action === 'approve') {
      rec.history.push({ ts: Date.now(), by: 'user', stage, verdict: 'approve', notes: 'Approved by you.' });
      rec.status = 'passed';
      rec.waitingOn = undefined;
      this.acceptedAt[taskId] = Date.now();
      this.dropSendBack(taskId);
      // Your acceptance settles this attempt: its "done" counts as checked (no "no commits since the send-back").
      this.o.doneOk[taskId] = this.o.attemptOf(taskId);
      delete this.o.noCommits[taskId];
      this.o.saveMeta();
      // The task may still read "doing" from a send-back you've overruled: it's done now.
      await this.o.updateTask(taskId, (t) => (t.status !== 'done' || /^Changes requested by /.test(t.note ?? '') ? { status: 'done', note: '' } : undefined));
      this.o.system(`✓ ${taskId} accepted by you.`);
      await this.o.onTaskAccepted(taskId);
      await this.dispatchParked(); // its reviewer is free for the next one
      this.o.checkAllDone(await this.o.readTasks());
    } else {
      rec.status = 'in_review';
      await this.applyVerdict(taskId, 'user', stage, 'changes', note.trim() || 'Sent back by the user.');
    }
    this.saveReviewState();
  }

  /**
   * "Builder" in the Tasks tab: hand a task to another agent (e.g. its owner is out of usage). The review
   * starts over, so the old builder's send-backs, "no commits since the send-back" mark and review rounds
   * don't count against the new one; the new builder gets a turn to pick it up.
   */
  private async setOwner(task: Task, to: string): Promise<void> {
    const taskId = task.id;
    const from = task.owner ?? '';
    if (!this.o.agents.has(to)) throw new Error(`Pick one of the agents as builder`);
    if (to === from) throw new Error(`${this.o.nameOf(to)} is already the builder of ${taskId}`);
    if (this.reviews[taskId]?.status === 'passed') throw new Error(`${taskId} is already accepted; use Re-review instead`);
    if (!this.o.available(to)) throw new Error(`${this.o.nameOf(to)} is ${this.o.unavailableReason(this.o.agents.get(to)!)}`);
    // Always "doing": the new builder reports it done itself, and only its commits from now on count.
    const ok = await this.o.updateTask(taskId, { owner: to, status: 'doing', note: `Reassigned from ${from ? this.o.nameOf(from) : 'nobody'} to ${this.o.nameOf(to)}.` });
    if (!ok) throw new Error(`Couldn't change the builder of ${taskId} in tasks.json`);
    this.dropSendBack(taskId);
    delete this.reviews[taskId];
    delete this.o.noCommits[taskId];
    delete this.o.doneOk[taskId];
    // A new attempt, so a late report from the old builder is stale; its commit baseline is the new builder's
    // branch now, so only work from here on counts (and the done check has a tip to compare with).
    this.o.attempts[taskId] = this.o.attemptOf(taskId) + 1;
    this.o.sentBack[taskId] = { at: Date.now(), tip: await this.tipOrNone(to) };
    this.o.saveMeta();
    this.saveReviewState();
    this.o.system(`${taskId} "${task.title ?? ''}" → builder is now ${this.o.nameOf(to)} (your pick), review restarted.`);
    const fromBranch = from && this.o.project?.agentDirs[from] ? ` Its earlier work, if any, is on branch agent/${from} (use \`git merge agent/${from}\` in your worktree to build on it).` : '';
    void this.o.enqueue(to, {
      instruction: newOwnerInstruction(task, from ? this.o.nameOf(from) : 'nobody', fromBranch, this.o.attemptOf(taskId)),
    });
    this.advanceReviews();
  }

  /**
   * The branch's tip commit, or undefined when git can't tell (logged): the done check then has no
   * baseline to compare with and goes by the agent's report alone.
   */
  private async tipOrNone(agent: string): Promise<string | undefined> {
    return branchTip(this.o.project!, agent).catch((e) => {
      this.o.report('branch tip', e);
      return undefined;
    });
  }

  saveReviewState(): void {
    if (this.o.project) void saveReviews(this.o.project.teamDir, this.reviews, (e) => this.o.report('save reviews', e, SAVE_REVIEWS_FAILED));
    this.o.emit('state');
  }
}
