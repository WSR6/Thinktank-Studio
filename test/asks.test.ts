import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AskBoard } from '../server/orchestrator/asks.js';
import type { Runtime, TurnPlan } from '../server/orchestrator/types.js';

/** A board over three fake agents; records every turn it queues. */
function board() {
  const agents = new Map(['a', 'b', 'c'].map((id) => [id, { cfg: { id, name: id.toUpperCase() }, stopGen: 0 } as unknown as Runtime]));
  const turns: { to: string; plan: TurnPlan }[] = [];
  const system: string[] = [];
  const b = new AskBoard({
    agent: (id) => agents.get(id),
    nameOf: (id) => id.toUpperCase(),
    enqueue: (to, plan) => void turns.push({ to, plan }),
    emitAgent: () => {},
    system: (t) => void system.push(t),
    saveMeta: () => {},
    changed: () => {},
    unavailableReason: () => 'switched off',
  });
  boards.push(b);
  return { b, agents, turns, system };
}
const boards: AskBoard[] = [];
afterEach(() => boards.splice(0).forEach((b) => b.reset(0))); // clears the expiry timers

test('one open question per target: the second waits, and is sent when the first is answered', () => {
  const { b, turns } = board();
  b.start('a', 'c', 'first?');
  b.start('b', 'c', 'second?');
  assert.deepEqual(turns.map((t) => [t.to, t.plan.askId]), [['c', 'q1']]);
  assert.equal(b.waitingOn('b')?.status, 'queued');
  b.answer(b.open('q1')!, 'yes');
  assert.deepEqual(turns.slice(1).map((t) => [t.to, t.plan.askId ?? null]), [['c', 'q2'], ['a', null]]);
  assert.match(turns[2].plan.instruction!, /^ANSWER from C to your question \(q1\):\nyes/);
  assert.equal(turns[2].plan.public, true);
  assert.equal(b.waitingOn('a'), undefined);
});

test('an asker stopped since it asked is not restarted by the answer', () => {
  const { b, agents, turns } = board();
  b.start('a', 'b', 'q?');
  agents.get('a')!.stopGen++;
  b.answer(b.open('q1')!, 'late');
  assert.deepEqual(turns.map((t) => t.to), ['b']);
});

test('failTo tells every asker waiting on that agent, without promoting a queued question', () => {
  const { b, turns } = board();
  b.start('a', 'c', 'one');
  b.start('b', 'c', 'two');
  b.failTo('c', 'it was stopped');
  assert.deepEqual(turns.slice(1).map((t) => t.to), ['a', 'b']);
  assert.match(turns[1].plan.instruction!, /C couldn't answer your question \(q1\): it was stopped\./);
  assert.equal(b.open('q2'), undefined);
});

test('the cap counts questions since your last message; ids keep counting after a reset', () => {
  const { b } = board();
  for (let i = 0; i < 4; i++) b.start('a', 'b', `q${i}`);
  assert.equal(b.canAsk(), false);
  b.newRound();
  assert.equal(b.canAsk(), true);
  b.reset(9);
  b.start('a', 'b', 'again');
  assert.ok(b.open('q10'));
});

test('a nested answer stays owed: resuming the asker keeps the question it was answering', () => {
  const { b, turns } = board();
  b.start('a', 'b', 'outer');
  b.open('q1')!.nested = true; // b asked c before answering a
  b.start('b', 'c', 'inner');
  b.answer(b.open('q2')!, 'inner answer');
  const resumed = turns.at(-1)!;
  assert.equal(resumed.to, 'b');
  assert.equal(resumed.plan.askId, 'q1');
  assert.equal(resumed.plan.public, false);
});
