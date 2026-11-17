import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatContext, isAway, queuePlan, requeueForRetry, routeReply, takePlan } from '../server/orchestrator/turns.js';
import type { Ask, Runtime } from '../server/orchestrator/types.js';
import type { ChatMessage } from '../server/types.js';

const runtime = (over: Partial<Runtime> = {}) => ({ next: {}, disabled: false, ...over }) as Runtime;
const isAgent = (id: string) => ['a', 'b', 'c'].includes(id);
let n = 0;
const msg = (from: string, to: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${n++}`, ts: 0, from, to, text, ...extra });
const ask = (from: string): Ask => ({ id: 'q1', from, to: 'a', question: '?', at: 0, status: 'open', askerStop: 0 });

test('isAway: switched off always; out of usage unless messaged directly', () => {
  assert.equal(isAway(runtime({ disabled: true }), { force: true }), true);
  assert.equal(isAway(runtime({ outUntil: 2000 }), {}, 1000), true);
  assert.equal(isAway(runtime({ outUntil: 2000 }), { force: true }, 1000), false);
  assert.equal(isAway(runtime({ outUntil: 500 }), {}, 1000), false);
});

test('queuePlan merges instructions, keeps a question apart, and drops forTask once a turn is about two things', () => {
  const r = runtime();
  queuePlan(r, { instruction: 'one', forTask: 't1' });
  queuePlan(r, { instruction: 'two', forTask: 't1' });
  assert.deepEqual({ ...r.next }, { instruction: 'one\n\ntwo', forTask: 't1' });
  queuePlan(r, { force: true });
  assert.deepEqual({ ...r.next }, { instruction: 'one\n\ntwo', forTask: undefined, force: true });
  queuePlan(r, { askId: 'q1', instruction: 'question' });
  assert.deepEqual(r.nextAsk, { askId: 'q1', instruction: 'question' });
  assert.equal(r.next.instruction, 'one\n\ntwo');
});

test('takePlan: the question first (with the rest still queued), then the merged plan', () => {
  const r = runtime();
  queuePlan(r, { instruction: 'work' });
  queuePlan(r, { askId: 'q1', instruction: 'question' });
  assert.deepEqual(takePlan(r), { plan: { askId: 'q1', instruction: 'question' }, more: true });
  assert.deepEqual(takePlan(r), { plan: { instruction: 'work', forTask: undefined }, more: false });
  assert.equal(r.hasNext, false);
  assert.deepEqual({ ...r.next }, {});
});

test('requeueForRetry puts the failed plan in front of work queued meanwhile', () => {
  const r = runtime();
  queuePlan(r, { instruction: 'review t2' });
  requeueForRetry(r, { instruction: 'build t1', forTask: 't1' });
  assert.equal(r.next.instruction, 'build t1\n\nreview t2');
  requeueForRetry(r, { askId: 'q1' });
  assert.deepEqual(r.nextAsk, { askId: 'q1' });
});

test('chatContext: a resumed turn sees what is new and replies privately to a DM', () => {
  const messages = [msg('user', 'all', 'hello'), msg('b', 'a', 'psst'), msg('a', 'all', 'mine'), msg('c', 'b', 'not for a')];
  const r = chatContext(messages, { id: 'a', lastSeen: 1, plan: {}, fresh: false, isAgent, canSee: (m) => m.to === 'all' || m.to === 'a' || m.from === 'a' });
  assert.deepEqual(r.context.map(([m]) => m.text), ['psst']);
  assert.equal(r.replyTo, 'b');
  assert.equal(r.seenUpTo, 4);
});

test('chatContext: hidden debate proposals stay unseen; a question turn carries no chat and replies to the asker', () => {
  const messages = [msg('user', 'all', 'topic'), msg('b', 'all', 'my proposal'), msg('user', 'all', 'later', { attachments: ['x.png'] })];
  const canSee = () => true;
  const debate = chatContext(messages, { id: 'a', lastSeen: 0, plan: { hideAgentsFrom: 1 }, fresh: true, isAgent, canSee });
  assert.deepEqual(debate.context.map(([m]) => m.text), ['topic', 'later']);
  assert.deepEqual(debate.newAttachments, ['x.png']);
  assert.equal(debate.seenUpTo, 1);
  const q = chatContext(messages, { id: 'a', lastSeen: 2, plan: { askId: 'q1' }, owed: ask('c'), fresh: false, isAgent, canSee });
  assert.deepEqual(q.context, []);
  assert.equal(q.replyTo, 'c');
  assert.equal(q.seenUpTo, 2);
});

test('routeReply: [[ask:]] and [[to:]] prefixes, the ask cap, and answers going back to the asker', () => {
  const o = { id: 'a', replyTo: 'all', isAgent, canAsk: true };
  assert.deepEqual(routeReply('[[ask: b]] why?', o), { text: 'why?', to: 'b', askTo: 'b', askRefused: false });
  assert.deepEqual(routeReply('[[ask: b]] why?', { ...o, canAsk: false }), { text: 'why?', to: 'all', askTo: undefined, askRefused: true });
  assert.deepEqual(routeReply('[[ask: zed]] why?', o), { text: 'why?', to: 'all', askTo: undefined, askRefused: false });
  assert.deepEqual(routeReply('[[to: c]] fyi', o), { text: 'fyi', to: 'c', askTo: undefined, askRefused: false });
  assert.deepEqual(routeReply('[[to: user]] fyi', o), { text: 'fyi', to: 'user', askTo: undefined, askRefused: false });
  assert.deepEqual(routeReply('[[to: c]] the answer', { ...o, owed: ask('b') }), { text: '[[to: c]] the answer', to: 'b', askTo: undefined, askRefused: false });
});
