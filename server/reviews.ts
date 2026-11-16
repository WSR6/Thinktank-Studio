import { exec, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Review pipeline state for finished tasks, kept in team/reviews.json (separate from tasks.json,
 * which agents edit, so the app and the agents never overwrite each other's changes).
 *
 * A task the owner marks "done" goes through stages (e.g. first review → final review → tests).
 * A reviewer ends its reply with [[verdict: approve]] or [[verdict: changes]]; "changes" sends the
 * task back to its owner and the review starts over once it's done again.
 */

export type StageKind = 'first' | 'final' | 'cross' | 'tests' | 'desktop';
/** Stages the app runs itself (no reviewer): the test command, and desktop tests that need the real mouse and screen. */
export const isMachineStage = (s: StageKind | undefined) => s === 'tests' || s === 'desktop';
export type ReviewStatus = 'in_review' | 'changes' | 'passed' | 'stuck';

export interface ReviewEntry {
  status: ReviewStatus;
  stages: StageKind[];
  stage: number;
  /** Times the task has been sent back. */
  rounds: number;
  /** The agent asked to review the current stage (not set for the tests stage). */
  waitingOn?: string;
  /** When the review was requested: only replies from turns that started after this count. */
  askedAt?: number;
  /** The builder's branch tip the latest review stage looked at: what gets merged when the task is accepted. */
  reviewedTip?: string;
  /** Stage and round (rounds:stage) for which the reviewer was already re-asked for a missing verdict line. */
  reasked?: string;
  /** History index where the current round began (set when the owner reopens the task). */
  roundStart?: number;
  history: { ts: number; by: string; stage: StageKind; verdict: 'approve' | 'changes' | 'none' | 'skip'; notes: string }[];
}

export type Reviews = Record<string, ReviewEntry>;

export const MAX_REVIEW_ROUNDS = 3;
export const VERDICT_RE = /\[\[\s*verdict\s*:\s*(approve|changes)\s*\]\]/i;

export const STAGE_LABELS: Record<StageKind, string> = {
  first: 'first review',
  final: 'final review',
  cross: 'review',
  tests: 'tests',
  desktop: 'desktop tests',
};

export function loadReviews(teamDir: string): Reviews {
  const file = join(teamDir, 'reviews.json');
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

let writing: Promise<void> = Promise.resolve();
export function saveReviews(teamDir: string, reviews: Reviews): Promise<void> {
  const file = join(teamDir, 'reviews.json');
  const data = JSON.stringify(reviews, null, 2);
  writing = writing
    .then(async () => {
      await writeFile(file + '.tmp', data);
      await rename(file + '.tmp', file);
    })
    .catch(console.error);
  return writing;
}

/** The verdict on the last lines of a reviewer's reply, if any. */
export function parseVerdict(text: string): 'approve' | 'changes' | undefined {
  const tail = text.trim().split('\n').slice(-6).join('\n');
  return tail.match(VERDICT_RE)?.[1]?.toLowerCase() as 'approve' | 'changes' | undefined;
}

export interface TestResult {
  ok: boolean;
  output: string;
}

/** Run the project's test command in a worktree (10 min cap). Output is trimmed to the end, where failures show. */
export function runTests(command: string, cwd: string, onStart?: (kill: () => void) => void): Promise<TestResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = exec(command, { cwd, maxBuffer: 20 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      clearTimeout(cap);
      const out = `${stdout}${stderr}`.trim();
      const tail = out.length > 4000 ? '…' + out.slice(-4000) : out;
      if (!err) return resolve({ ok: true, output: tail });
      const why = timedOut ? 'timed out after 10 minutes' : (err as any).killed ? 'was stopped' : `exited with code ${(err as any).code ?? '?'}`;
      resolve({ ok: false, output: `Test command ${why}.\n${tail}` });
    });
    // On Windows the child is a shell: end the whole tree (e.g. Playwright and its browser).
    const killTree = () => {
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      else child.kill('SIGTERM');
    };
    const cap = setTimeout(() => {
      timedOut = true;
      killTree();
    }, 10 * 60_000);
    onStart?.(killTree);
  });
}
