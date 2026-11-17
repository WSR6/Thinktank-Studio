import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { saveComments } from '../server/comments.js';
import { ReviewFlow, type ReviewHost } from '../server/orchestrator/review-flow.js';
import { Reporter } from '../server/report.js';
import { saveReviews } from '../server/reviews.js';

const root = mkdtempSync(join(tmpdir(), 'tts-report-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Reporter logs to stderr; keep test output readable.
const quiet = <T>(fn: () => T): T => {
  const err = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = err;
  }
};

test('Reporter tells the user once per kind per quiet period, and always logs', () => {
  let now = 0;
  const told: string[] = [];
  const logged: string[] = [];
  const r = new Reporter((t) => told.push(t), 1000, () => now);
  const err = console.error;
  console.error = (s: string) => logged.push(s);
  try {
    assert.equal(r.report('save', new Error('disk full'), "Couldn't save"), true);
    assert.equal(r.report('save', new Error('disk full'), "Couldn't save"), false);
    assert.equal(r.report('other', new Error('x'), 'Other thing'), true);
    assert.equal(r.report('quiet', new Error('y')), false, 'no text: log only');
    now = 1500;
    assert.equal(r.report('save', 'still full', "Couldn't save"), true);
  } finally {
    console.error = err;
  }
  assert.deepEqual(told, ["⚠ Couldn't save (disk full)", '⚠ Other thing (x)', "⚠ Couldn't save (still full)"]);
  assert.equal(logged.length, 5);
});

test('ReviewFlow.queue: a failing step is reported to the user and the queue keeps going', async () => {
  const reports: [string, string | undefined][] = [];
  const host = { report: (key: string, _e: unknown, text?: string) => reports.push([key, text]) } as unknown as ReviewHost;
  const flow = new ReviewFlow(host);
  const ran: string[] = [];
  void flow.queue(() => ran.push('first'));
  void flow.queue(async () => {
    throw new Error('boom');
  });
  await flow.queue(() => ran.push('after the failure'));
  assert.deepEqual(ran, ['first', 'after the failure']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'review step');
  assert.match(reports[0][1]!, /Restart its review or Approve it yourself/);
  // The queue itself never rejects (project switches await it).
  await assert.doesNotReject(flow.reviewQueue);
});

test('saveReviews / saveComments report a failed save instead of only logging it', async () => {
  const missing = join(root, 'no', 'such', 'dir');
  const errors: unknown[] = [];
  await quiet(() => saveReviews(missing, {}, (e) => errors.push(e)));
  await quiet(() => saveComments(missing, [], (e) => errors.push(e)));
  assert.equal(errors.length, 2);
  assert.match(String((errors[0] as NodeJS.ErrnoException).code), /ENOENT/);
});
