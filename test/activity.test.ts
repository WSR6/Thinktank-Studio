import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityLog } from '../server/orchestrator/activity.js';

const agents = [{ id: 'a', name: 'Alpha', status: 'idle' as const }];

test('ActivityLog: records readable lines and skips session/limits events', () => {
  const log = new ActivityLog();
  log.record(undefined, 'a', { kind: 'status', status: 'working' });
  log.record(undefined, 'a', { kind: 'tool', name: 'shell', detail: 'npm test' });
  log.record(undefined, 'a', { kind: 'session', id: 's1' });
  log.record(undefined, 'a', { kind: 'text', text: '   ' });
  assert.deepEqual(log.history(['a', 'b']).a.map((l) => l.text), ['── turn started ──', '▸ shell npm test']);
  assert.deepEqual(log.history(['a', 'b']).b, []);
});

test('ActivityLog.since: only what is new since the cursors, and new cursors back', () => {
  const log = new ActivityLog();
  log.record(undefined, 'a', { kind: 'log', text: 'one' });
  const first = log.since(agents, undefined);
  assert.match(first.text, /^### Alpha \(idle\)\n\d\d:\d\d:\d\d one$/);
  assert.deepEqual(first.cursors, { a: 1 });
  assert.equal(log.since(agents, first.cursors).text, '');
  log.record(undefined, 'a', { kind: 'log', text: 'two\nlines' });
  assert.match(log.since(agents, first.cursors).text, /two ⏎ lines$/);
});

test('ActivityLog: lines go to team/activity/<id>.jsonl and load back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-activity-'));
  try {
    const log = new ActivityLog();
    log.load(dir, ['a']); // creates team/activity
    log.record(dir, 'a', { kind: 'log', text: 'saved' });
    await new Promise((r) => setTimeout(r, 50));
    assert.match(readFileSync(join(dir, 'activity', 'a.jsonl'), 'utf8'), /"text":"saved"/);
    const again = new ActivityLog();
    again.load(dir, ['a']);
    assert.deepEqual(again.history(['a']).a.map((l) => l.text), ['saved']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
