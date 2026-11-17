import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStall, newWatch, noteProgress, quietMs, snooze, STALL_REPEAT } from '../server/orchestrator/stall.js';
import type { AgentConfig } from '../server/types.js';

const cfg: AgentConfig = { id: 'a', name: 'A', adapter: 'mock', command: 'mock', stuckMinutes: 6 };
const MIN = 60_000;
const T0 = 1_000_000_000_000;

test('quietMs: the agent setting, else 30 min for a model server', () => {
  assert.equal(quietMs(cfg), 6 * MIN);
  assert.equal(quietMs({ id: 'b', name: 'B', adapter: 'codex', command: 'codex', server: 'http://localhost:1234' }), 30 * MIN);
});

test('checkStall: quiet past the limit is a stall; before it, not', () => {
  const w = newWatch(T0);
  assert.equal(checkStall(w, cfg, T0 + 5 * MIN), undefined);
  const found = checkStall(w, cfg, T0 + 6 * MIN);
  assert.equal(found?.kind, 'quiet');
  assert.match(found!.reason, /quiet for 6 min/);
});

test('checkStall: a never-ending command is flagged after 2 minutes, even with status chatter', () => {
  const w = newWatch(T0);
  noteProgress(w, { kind: 'tool', name: 'shell', detail: 'npm run dev' }, T0);
  noteProgress(w, { kind: 'text', text: 'still waiting…' }, T0 + 90_000);
  assert.equal(checkStall(w, cfg, T0 + 100_000), undefined);
  const found = checkStall(w, cfg, T0 + 2 * MIN);
  assert.equal(found?.kind, 'longrun');
  assert.match(found!.reason, /npm run dev.*only posting status messages \(1\)/);
});

test('checkStall: a slow test run gets 20 minutes before it counts as stuck', () => {
  const w = newWatch(T0);
  noteProgress(w, { kind: 'tool', name: 'shell', detail: 'npm test' }, T0);
  assert.equal(checkStall(w, cfg, T0 + 19 * MIN), undefined);
  assert.equal(checkStall(w, cfg, T0 + 20 * MIN)?.kind, 'quiet');
});

test('noteProgress: the same call repeated is a loop; other output clears a stall', () => {
  const w = newWatch(T0);
  let found;
  for (let i = 0; i < STALL_REPEAT; i++) found = noteProgress(w, { kind: 'tool', name: 'shell', detail: 'ls' }, T0 + i);
  assert.equal(typeof found === 'object' && found.kind, 'loop');
  w.stall = { reason: 'x', since: T0, kind: 'loop' };
  // Repeating the same call doesn't clear its own loop flag.
  assert.equal(noteProgress(w, { kind: 'tool', name: 'shell', detail: 'ls' }, T0 + 10), undefined);
  assert.equal(noteProgress(w, { kind: 'tool', name: 'shell', detail: 'pwd' }, T0 + 11), 'resumed');
  assert.equal(w.stall, undefined);
});

test('noteProgress: text while a long-running command is flagged does not clear it; its end does', () => {
  const w = newWatch(T0);
  noteProgress(w, { kind: 'tool', name: 'shell', detail: 'npm run dev' }, T0);
  w.stall = { reason: 'x', since: T0, kind: 'longrun' };
  assert.equal(noteProgress(w, { kind: 'text', text: 'still running' }, T0 + 1), undefined);
  assert.equal(noteProgress(w, { kind: 'tool_end', name: 'shell', ok: true, text: '' }, T0 + 2), 'resumed');
  assert.equal(w.lastTool, undefined);
});

test('snooze: clears the flag and waits another full quiet period from now', () => {
  const w = newWatch(T0);
  w.stall = { reason: 'x', since: T0, kind: 'quiet' };
  snooze(w, cfg, T0 + 6 * MIN);
  assert.equal(w.stall, undefined);
  assert.equal(checkStall(w, cfg, T0 + 11 * MIN), undefined);
  assert.equal(checkStall(w, cfg, T0 + 12 * MIN)?.kind, 'quiet');
});
