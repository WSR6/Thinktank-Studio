/**
 * Desktop tests: the review stage whose command takes over the real mouse and screen (e.g. Playwright
 * drag tests). Tasks wait at this stage until you (or the App helper, after a countdown) press Run now;
 * one run at a time across every project, since they share the mouse.
 */
import { idleSeconds } from '../idle.js';
import type { ProjectInfo } from '../project.js';
import { runTests, type ReviewEntry, type StageKind } from '../reviews.js';
import { DESKTOP_COUNTDOWN_MS, type Task } from './types.js';

interface Run {
  task: string;
  startsAt: number;
  running: boolean;
  by: 'user' | 'helper';
  timer?: NodeJS.Timeout;
}

/** Ends the desktop test command that's running (any project): only one may hold the mouse. */
let killRunning: (() => void) | undefined;

/** What the desktop tests need from the orchestrator. */
export interface DesktopHost {
  project(): ProjectInfo | undefined;
  /** Bumped on project switch: a run from an older generation reports nothing. */
  gen(): number;
  command(): string;
  review(taskId: string): ReviewEntry | undefined;
  readTasks(): Promise<Task[]>;
  ensureSetup(key: string, dir: string, logTo?: string): Promise<void>;
  pendingSetup(dirs: string[]): Promise<void>[];
  system(text: string): void;
  /** Something the UI shows changed. */
  changed(): void;
  /** Run `fn` in the review queue, after the reviews already in it; resolves when it has run. */
  queueReview(fn: () => Promise<void> | void): Promise<void>;
  applyVerdict(taskId: string, by: string, stage: StageKind, verdict: 'approve' | 'changes', notes: string): Promise<void>;
}

export class DesktopTests {
  /** Tasks waiting at the desktop-tests stage: task id -> the stage it was queued for. */
  /** Each entry is unique (stage token + a counter), so a result from an earlier run never matches a later one. */
  private waiting = new Map<string, string>();
  private seq = 0;
  /** The desktop-test run in progress or counting down (one at a time: they share the mouse). */
  private run?: Run;

  constructor(private host: DesktopHost) {}

  /** A project was opened: end any run and forget what was waiting. */
  reset(): void {
    clearTimeout(this.run?.timer);
    killRunning?.();
    this.run = undefined;
    this.waiting.clear();
  }

  /** A run is counting down or running. */
  active(): boolean {
    return Boolean(this.run);
  }

  /** For the UI: tasks waiting for Run now, and the run in progress. */
  view() {
    return {
      waiting: [...this.waiting.keys()].filter((id) => this.current(id)),
      run: this.run ? { task: this.run.task, startsAt: this.run.startsAt, running: this.run.running, by: this.run.by } : null,
    };
  }

  /** The task reached its desktop-tests stage: it waits for Run now. */
  queue(taskId: string): void {
    if (this.run?.task === taskId) this.cancel(true);
    this.waiting.set(taskId, `${this.token(taskId)}#${++this.seq}`);
    this.host.system(`${taskId} → waiting for the desktop tests (\`${this.host.command()}\`). They use your mouse and screen for a while, so they start when you press Run now above the chat (or the App helper does, when Run my project is on and this computer is idle).`);
    this.host.changed();
  }

  /** The desktop test command was cleared: stop a run and move waiting tasks on. */
  turnedOff(): void {
    if (this.run) this.cancel(true);
    for (const id of [...this.waiting.keys()]) void this.finish(id, 'approve', 'Skipped: desktop tests were turned off.');
  }

  /**
   * Run the desktop tests for a waiting task. From you: now. From the App helper: after a countdown you
   * can cancel (the banner shows it), since they take over the mouse.
   */
  start(taskId: string, by: 'user' | 'helper'): void {
    if (!this.host.project()) throw new Error('No project open');
    if (!this.current(taskId)) throw new Error(`${taskId} isn't waiting for desktop tests`);
    if (killRunning) throw new Error('Desktop tests are still running');
    if (this.run) throw new Error(`Desktop tests for ${this.run.task} are already ${this.run.running ? 'running' : 'about to start'}`);
    const delay = by === 'helper' ? DESKTOP_COUNTDOWN_MS : 0;
    const run: Run = {
      task: taskId,
      startsAt: Date.now() + delay,
      running: false,
      by,
    };
    this.run = run;
    if (by === 'helper')
      this.host.system(`The App helper starts the desktop tests for ${taskId} in ${Math.round(delay / 1000)} seconds; they'll move the mouse. Press Cancel above the chat to stop it.`);
    run.timer = setTimeout(() => void this.begin(run), delay);
    this.host.changed();
  }

  cancel(quiet = false): void {
    const run = this.run;
    if (!run) return;
    clearTimeout(run.timer);
    // Already running: end the command (its result is dropped; the task waits for Run now again).
    if (run.running) killRunning?.();
    this.run = undefined;
    if (!quiet) this.host.system(`Desktop tests for ${run.task} cancelled; they wait for Run now.`);
    this.host.changed();
  }

  /** Accept the task without its desktop tests (only you can do this, not the App helper). */
  skip(taskId: string): void {
    if (!this.current(taskId)) throw new Error(`${taskId} isn't waiting for desktop tests`);
    if (this.run?.task === taskId) throw new Error('They are already running or about to start; Cancel first');
    void this.finish(taskId, 'approve', 'Skipped by you.');
  }

  /** Desktop tests waiting for Run now, for the App helper's view (none while a run is counting down or running). */
  nextWaiting(): string[] {
    // One at a time (they share the mouse): when it's done, the next one is a new item for the helper.
    if (this.run || killRunning) return [];
    const next = [...this.waiting.keys()].find((id) => this.current(id));
    return next ? [next] : [];
  }

  private async begin(run: Run): Promise<void> {
    const project = this.host.project();
    if (this.run !== run || !project) return;
    const gen = this.host.gen();
    const tasks = await this.host.readTasks();
    const t = tasks.find((x) => x.id === run.task);
    if (gen !== this.host.gen() || this.run !== run) return;
    const token = this.waiting.get(run.task);
    if (!t || !this.current(run.task) || killRunning) {
      this.run = undefined;
      this.host.changed();
      return;
    }
    const p = this.host.project()!;
    const owner = t.owner ?? '';
    const dir = p.agentDirs[owner] ?? p.repoDir;
    if (p.agentDirs[owner]) void this.host.ensureSetup(owner, dir, owner);
    // A failed setup is already reported in the chat by the setup runner; the tests show what's missing.
    await Promise.all(this.host.pendingSetup([dir])).catch(() => {});
    if (this.run !== run || gen !== this.host.gen()) return;
    // The helper's run: check again right before the mouse moves (you may be back since the countdown began).
    if (run.by === 'helper') {
      const idle = await idleSeconds();
      if (this.run !== run || gen !== this.host.gen()) return;
      if (idle === undefined || idle < Number(process.env.TTS_DESKTOP_IDLE_S ?? 120)) {
        this.run = undefined;
        this.host.system(
          idle === undefined
            ? `Desktop tests for ${t.id} not started: the app couldn't tell whether this computer is in use. They wait for Run now.`
            : `Desktop tests for ${t.id} not started: this computer is in use again. They wait for Run now.`,
        );
        this.host.changed();
        return;
      }
    }
    run.running = true;
    this.host.changed();
    // Approved, sent back or cancelled in the moments before this: don't start.
    if (this.run !== run || !this.current(t.id)) {
      if (this.run === run) this.run = undefined;
      this.host.changed();
      return;
    }
    this.host.system(`${t.id} → running desktop tests: \`${this.host.command()}\` (hands off the mouse until they finish).`);
    let result: { ok: boolean; output: string };
    try {
      result = await runTests(this.host.command(), dir, (kill) => {
        killRunning = kill;
        // Cancelled between the check above and the start: end it at once.
        if (this.run !== run) kill();
      });
    } catch (e) {
      result = { ok: false, output: (e as Error).message };
    } finally {
      killRunning = undefined;
    }
    const cancelled = this.run !== run;
    if (!cancelled) this.run = undefined;
    if (gen !== this.host.gen()) return;
    if (cancelled) {
      this.host.changed();
      return;
    }
    await this.finish(t.id, result.ok ? 'approve' : 'changes', result.ok ? 'Desktop tests passed.' : result.output, token);
  }

  private async finish(taskId: string, verdict: 'approve' | 'changes', notes: string, entry = this.waiting.get(taskId)): Promise<void> {
    // Only for the same review round and stage it was started for: a restart, send-back or approval since makes it stale.
    await this.host.queueReview(() => {
      // A result for an earlier entry (restarted, sent back, done again since) changes nothing.
      if (!entry || this.waiting.get(taskId) !== entry) return;
      this.waiting.delete(taskId);
      this.host.changed();
      if (entry.split('#')[0] === this.token(taskId)) return this.host.applyVerdict(taskId, 'desktop', 'desktop', verdict, notes);
    });
  }

  /** The review round and stage a task's desktop tests belong to, or undefined if it isn't at that stage now. */
  private token(taskId: string): string | undefined {
    const rec = this.host.review(taskId);
    if (!rec || rec.status !== 'in_review' || rec.stages[rec.stage] !== 'desktop') return undefined;
    return `${rec.rounds}:${rec.stage}:${rec.roundStart ?? 0}:${rec.history.length}`;
  }

  /** Still waiting at the same desktop stage it was queued for; drops it (and a countdown for it) when not. */
  private current(taskId: string): boolean {
    const want = this.waiting.get(taskId);
    if (want !== undefined && want.split('#')[0] === this.token(taskId)) return true;
    if (want !== undefined) {
      this.waiting.delete(taskId);
      // Approved, sent back or restarted meanwhile: a countdown or a running command for it ends now.
      if (this.run?.task === taskId) this.cancel(true);
    }
    return false;
  }
}
