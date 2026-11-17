import { exec, execFile } from 'node:child_process';
import { copyAside, isRecord, loadJsonFile, mayWrite, protect } from './safe-json.js';
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

const isEntry = (e: any): e is ReviewEntry =>
  isRecord(e) && typeof e.status === 'string' && Array.isArray(e.stages) && Number.isInteger(e.stage) && Array.isArray(e.history);

/**
 * team/reviews.json. A damaged file is moved aside and the reviews start over (onProblem tells the
 * user); single damaged entries are dropped so they can't break the review pipeline.
 */
export function loadReviews(teamDir: string, onProblem: (text: string) => void = () => {}): Reviews {
  const { value, problem } = loadJsonFile<Reviews>(join(teamDir, 'reviews.json'), {}, {
    label: 'team/reviews.json',
    what: 'the review progress of finished tasks starts over',
    valid: isRecord,
  });
  if (problem) onProblem(problem);
  const good = Object.entries(value).filter(([, e]) => isEntry(e));
  const dropped = Object.keys(value).length - good.length;
  if (dropped) {
    // The next save writes the list without them: keep the file as it is now first.
    const file = join(teamDir, 'reviews.json');
    const copy = copyAside(file);
    if (!copy) protect(file); // no copy: don't let the next save write the list without them
    onProblem(
      `${dropped} damaged entr${dropped === 1 ? 'y' : 'ies'} in team/reviews.json ${dropped === 1 ? 'was' : 'were'} skipped; those tasks' reviews start over when they're marked done again.` +
        (copy
          ? ` The file as it was is kept as ${copy}.`
          : " No copy of the file could be kept, so the app won't save review progress over it; fix or delete it, then restart the app."),
    );
  }
  return Object.fromEntries(good);
}

let writing: Promise<void> = Promise.resolve();
/** Saves are queued (tmp + rename). `onError`: a failed save (logged by default). */
export function saveReviews(teamDir: string, reviews: Reviews, onError: (e: unknown) => void = console.error): Promise<void> {
  const file = join(teamDir, 'reviews.json');
  const data = JSON.stringify(reviews, null, 2);
  writing = writing
    .then(async () => {
      if (!mayWrite(file)) return; // damaged and no copy could be kept: leave it for the user
      await writeFile(file + '.tmp', data);
      await rename(file + '.tmp', file);
    })
    .catch(onError);
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
      // No callback error to act on: if the tree is already gone there's nothing left to stop.
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
