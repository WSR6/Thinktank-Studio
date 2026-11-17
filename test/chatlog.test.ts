import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ChatLog, lineLanded, readMessageRange, readMessagesBefore } from '../server/orchestrator/chatlog.js';
import { chatContext } from '../server/orchestrator/turns.js';
import type { ChatMessage } from '../server/types.js';

const dir = mkdtempSync(join(tmpdir(), 'tts-chatlog-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const msg = (i: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${i}`, ts: i, from: 'user', to: 'all', text: `message ${i} ✓`, ...extra });
const writeLog = (name: string, count: number): string => {
  const file = join(dir, name);
  writeFileSync(file, Array.from({ length: count }, (_, i) => JSON.stringify(msg(i))).join('\n') + '\n');
  return file;
};
const ids = (ms: ChatMessage[]) => ms.map((m) => m.id);

test('ChatLog.load keeps only the newest messages in memory, with absolute numbering', async () => {
  const file = writeLog('big.jsonl', 5000);
  const log = new ChatLog(100, 150);
  await log.load(file);
  assert.equal(log.messages.length, 100);
  assert.equal(log.base, 4900);
  assert.equal(log.total, 5000);
  assert.equal(log.messages[0].id, 'm4900');
  assert.equal(log.messages[99].id, 'm4999');
});

test('ChatLog.load: a small log loads whole; a missing one is empty', async () => {
  const log = new ChatLog(100, 150);
  await log.load(writeLog('small.jsonl', 7));
  assert.deepEqual([log.base, log.total], [0, 7]);
  await log.load(join(dir, 'nope.jsonl'));
  assert.deepEqual([log.base, log.total, log.messages.length], [0, 0, 0]);
});

test('ChatLog.load skips a torn last line and ends it, so the next message is not glued to it', async () => {
  const file = writeLog('torn.jsonl', 3);
  appendFileSync(file, '{"id":"m3","ts":3,"fro');
  const log = new ChatLog();
  await log.load(file);
  assert.deepEqual(ids(log.messages), ['m0', 'm1', 'm2']);
  appendFileSync(file, JSON.stringify(msg(4)) + '\n');
  await log.load(file);
  assert.deepEqual(ids(log.messages), ['m0', 'm1', 'm2', 'm4']);
  assert.ok(readFileSync(file, 'utf8').includes('"fro\n{'));
});

test('ChatLog.push trims memory past the cap without changing absolute numbers', () => {
  const log = new ChatLog(3, 5);
  for (let i = 0; i < 5; i++) assert.equal(log.push(msg(i)), 0);
  assert.equal(log.push(msg(5)), 3);
  assert.deepEqual(ids(log.messages), ['m3', 'm4', 'm5']);
  assert.deepEqual([log.base, log.total], [3, 6]);
  assert.deepEqual(log.page(2), { messages: [msg(4), msg(5)], earlier: true });
  assert.equal(new ChatLog().page(10).earlier, false);
});

test('readMessagesBefore pages backwards through the whole log, across chunk edges', async () => {
  const file = writeLog('paged.jsonl', 1000);
  // Tiny chunks so lines (with multi-byte characters) straddle chunk boundaries.
  const newest = await readMessagesBefore(file, undefined, 10, 37);
  assert.deepEqual(ids(newest.messages), Array.from({ length: 10 }, (_, i) => `m${990 + i}`));
  assert.equal(newest.earlier, true);
  const page = await readMessagesBefore(file, 'm990', 10, 37);
  assert.deepEqual(ids(page.messages), Array.from({ length: 10 }, (_, i) => `m${980 + i}`));
  assert.deepEqual([page.earlier, page.found], [true, true]);
  const first = await readMessagesBefore(file, 'm5', 10, 37);
  assert.deepEqual(ids(first.messages), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal(first.earlier, false);
  const exact = await readMessagesBefore(file, 'm10', 10, 37);
  assert.equal(exact.messages.length, 10);
  assert.equal(exact.earlier, false);
  const missing = await readMessagesBefore(file, 'zzz', 10, 37);
  assert.deepEqual([missing.messages.length, missing.found], [0, false]);
});

test('chatContext with a trimmed window: indexes stay absolute', () => {
  const window = [msg(100, { from: 'b' }), msg(101, { from: 'b' }), msg(102, { from: 'user' })];
  const r = chatContext(window, { id: 'a', base: 100, lastSeen: 101, plan: {}, fresh: false, isAgent: (id) => id === 'a' || id === 'b', canSee: () => true });
  assert.deepEqual(r.context.map(([m, i]) => [m.id, i]), [['m101', 101], ['m102', 102]]);
  assert.equal(r.seenUpTo, 103);
  // Behind by more than memory holds: sees everything still in memory.
  const behind = chatContext(window, { id: 'a', base: 100, lastSeen: 3, plan: {}, fresh: false, isAgent: () => false, canSee: () => true });
  assert.equal(behind.context.length, 3);
  // A debate's hidden range is absolute too.
  const debate = chatContext(window, { id: 'a', base: 100, lastSeen: 100, plan: { hideAgentsFrom: 101 }, fresh: false, isAgent: (id) => id === 'b', canSee: () => true });
  assert.deepEqual(debate.context.map(([m]) => m.id), ['m100', 'm102']);
  assert.equal(debate.seenUpTo, 101);
});

test('a damaged line never counts as a message, so numbers stay the same however much is in memory', async () => {
  const file = join(dir, 'damaged.jsonl');
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify(msg(i)));
  lines[2] = '{"id": "half';
  writeFileSync(file, lines.join('\n') + '\n');
  const small = new ChatLog(3, 5);
  await small.load(file);
  const all = new ChatLog(100, 150);
  await all.load(file);
  assert.equal(all.total, 9);
  assert.equal(small.total, 9);
  // m9 has the same absolute number either way.
  assert.equal(small.base + ids(small.messages).indexOf('m9'), all.base + ids(all.messages).indexOf('m9'));
  const range = await readMessageRange(file, 0, 9);
  assert.deepEqual(range.map(([m, i]) => [m.id, i]).at(-1), ['m9', 8]);
});

test('readMessageRange: numbered range, filtered, last N', async () => {
  const file = writeLog('range.jsonl', 50);
  assert.deepEqual((await readMessageRange(file, 10, 13)).map(([m, i]) => [m.id, i]), [['m10', 10], ['m11', 11], ['m12', 12]]);
  const even = await readMessageRange(file, 0, 40, (m) => m.ts % 2 === 0, 3);
  assert.deepEqual(even.map(([m]) => m.id), ['m34', 'm36', 'm38']);
  assert.deepEqual(await readMessageRange(file, 5, 5), []);
});

test('chatContext: messages from before memory (read from disk) join the context as if never trimmed', () => {
  const window = [msg(100), msg(101)];
  const earlier = [[msg(97), 97], [msg(98), 98], [msg(99), 99]] as const;
  const r = chatContext(window, { id: 'a', base: 100, earlier: [...earlier], lastSeen: 98, plan: {}, fresh: false, isAgent: () => false, canSee: () => true });
  assert.deepEqual(r.context.map(([m, i]) => [m.id, i]), [['m98', 98], ['m99', 99], ['m100', 100], ['m101', 101]]);
  assert.equal(r.seenUpTo, 102);
});

test('contextVisible: a debate hides teammates from the hidden range on, for chatContext and the disk read alike', async () => {
  const { contextVisible } = await import('../server/orchestrator/turns.js');
  const { visible } = contextVisible({ id: 'a', plan: { hideAgentsFrom: 5 }, isAgent: (x) => x === 'b' || x === 'a', canSee: () => true });
  assert.equal(visible(msg(1, { from: 'b' }), 4), true);
  assert.equal(visible(msg(1, { from: 'b' }), 5), false);
  assert.equal(visible(msg(1, { from: 'a' }), 5), true);
  assert.equal(visible(msg(1, { from: 'user' }), 9), true);
});

test('readMessageRange: "also" messages come along whatever the last-N limit says, in order', async () => {
  const file = writeLog('also.jsonl', 30);
  const r = await readMessageRange(file, 0, 30, (m) => m.ts >= 25, 2, (m) => m.ts === 3);
  assert.deepEqual(r.map(([, i]) => i), [3, 28, 29]);
});

test('chatContext: a hidden proposal read from disk still holds the seen-cursor before it', () => {
  const isAgent = (x: string) => x === 'b';
  const earlier = [[msg(8, { from: 'user' }), 8], [msg(9, { from: 'b' }), 9]] as const;
  const window = [msg(10, { from: 'user' })];
  const r = chatContext(window, { id: 'a', base: 10, earlier: [...earlier], lastSeen: 8, plan: { hideAgentsFrom: 9 }, fresh: false, isAgent, canSee: () => true });
  assert.deepEqual(r.context.map(([m]) => m.id), ['m8', 'm10']);
  assert.equal(r.seenUpTo, 9);
});

test('lineLanded tells a retry how much of a failed append is already on disk', async () => {
  const file = writeLog('landed.jsonl', 2);
  const line = JSON.stringify(msg(9)) + '\n';
  assert.equal(await lineLanded(file, line), 'no');
  appendFileSync(file, line.slice(0, 10));
  assert.equal(await lineLanded(file, line), 'no', 'a partial line');
  writeLog('landed.jsonl', 2);
  appendFileSync(file, line.slice(0, -1));
  assert.equal(await lineLanded(file, line), 'all-but-newline');
  appendFileSync(file, '\n');
  assert.equal(await lineLanded(file, line), 'all');
  assert.equal(await lineLanded(join(dir, 'missing.jsonl'), line), 'no');
});
