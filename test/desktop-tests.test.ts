import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopTests } from '../server/orchestrator/desktop-tests.js';
import type { ReviewEntry } from '../server/reviews.js';

/** Desktop tests over one fake review at its desktop stage; records verdicts and system lines. */
function setup() {
  const rec: ReviewEntry = { status: 'in_review', stages: ['cross', 'desktop'], stage: 1, rounds: 0, history: [] };
  const verdicts: string[] = [];
  const system: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  const d = new DesktopTests({
    project: () => ({ name: 'p', root: '/p', repoDir: '/p/repo', teamDir: '/p/team', agentDirs: {} }),
    gen: () => 1,
    command: () => 'npm run e2e',
    review: (id) => (id === 't1' ? rec : undefined),
    readTasks: async () => [{ id: 't1', owner: 'a', status: 'done' }],
    ensureSetup: async () => {},
    pendingSetup: () => [],
    system: (t) => void system.push(t),
    changed: () => {},
    queueReview: (fn) => (queue = queue.then(fn).catch(console.error)),
    applyVerdict: async (taskId, by, stage, verdict, notes) => void verdicts.push(`${taskId} ${by} ${stage} ${verdict}: ${notes}`),
  });
  return { d, rec, verdicts, system };
}

test('a queued task waits for Run now; Skip approves it through the review queue', async () => {
  const { d, verdicts, system } = setup();
  d.queue('t1');
  assert.match(system[0], /^t1 → waiting for the desktop tests \(`npm run e2e`\)/);
  assert.deepEqual(d.view(), { waiting: ['t1'], run: null });
  assert.deepEqual(d.nextWaiting(), ['t1']);
  d.skip('t1');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(verdicts, ['t1 desktop desktop approve: Skipped by you.']);
  assert.deepEqual(d.view().waiting, []);
});

test('a task whose review moved on (sent back, restarted) is no longer waiting', () => {
  const { d, rec } = setup();
  d.queue('t1');
  rec.history.push({ ts: 0, by: 'user', stage: 'desktop', verdict: 'changes', notes: '' });
  assert.deepEqual(d.view().waiting, []);
  assert.throws(() => d.skip('t1'), /isn't waiting for desktop tests/);
});

test('the helper gets a countdown that Cancel stops; a second run is refused meanwhile', () => {
  const { d, system } = setup();
  d.queue('t1');
  d.start('t1', 'helper');
  assert.equal(d.active(), true);
  assert.match(system.at(-1)!, /The App helper starts the desktop tests for t1 in \d+ seconds/);
  assert.throws(() => d.start('t1', 'user'), /already about to start/);
  assert.deepEqual(d.nextWaiting(), []);
  d.cancel();
  assert.equal(d.active(), false);
  assert.match(system.at(-1)!, /Desktop tests for t1 cancelled; they wait for Run now\./);
  assert.deepEqual(d.nextWaiting(), ['t1']);
});
