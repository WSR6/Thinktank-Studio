import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewVerdict } from '../server/orchestrator.js';

// reviewVerdict is the rule that accepts a reviewed task or sends it back. (parseVerdict in
// reviews.ts is the simpler one, used for line comments; see reviews.test.ts.)

const lines = (n: number, text = 'a note') => Array.from({ length: n }, (_, i) => `${i + 1}. ${text}`).join('\n');

test('reviewVerdict: a verdict at the end of the reply', () => {
  assert.deepEqual(reviewVerdict('Looks good.\n[[verdict: approve]]'), { verdict: 'approve', taskId: undefined });
  assert.deepEqual(reviewVerdict('Two problems.\n[[ Verdict : CHANGES ]]\n1. fix this'), { verdict: 'changes', taskId: undefined });
});

test('reviewVerdict: no verdict', () => {
  assert.deepEqual(reviewVerdict(''), {});
  assert.deepEqual(reviewVerdict('I approve of this change.'), {});
  assert.deepEqual(reviewVerdict('[[verdict: maybe]]'), {});
  assert.deepEqual(reviewVerdict('[[verdict: approved]]'), {});
});

test('reviewVerdict: the verdict may name its task, with or without an attempt', () => {
  assert.deepEqual(reviewVerdict('[[verdict: approve | t3]]'), { verdict: 'approve', taskId: 't3' });
  assert.deepEqual(reviewVerdict('[[verdict: changes t12]]'), { verdict: 'changes', taskId: 't12' });
  assert.deepEqual(reviewVerdict('[[verdict: approve|T3#2]]'), { verdict: 'approve', taskId: 't3' });
  assert.deepEqual(reviewVerdict('[[verdict: changes | t3 # 4 ]]'), { verdict: 'changes', taskId: 't3' });
});

test('reviewVerdict: only ids like t3 are understood inside the marker', () => {
  // Pins today's rule: with any other kind of id the whole marker is not read as a verdict.
  assert.deepEqual(reviewVerdict('[[verdict: approve | api-1]]'), {});
  assert.deepEqual(reviewVerdict('[[verdict: approve | t3 and t4]]'), {});
});

test('reviewVerdict: the last of several verdicts wins', () => {
  assert.deepEqual(reviewVerdict('[[verdict: changes]]\nOn reflection it is fine.\n[[verdict: approve]]').verdict, 'approve');
  assert.deepEqual(reviewVerdict('[[verdict: approve | t1]]\n[[verdict: changes | t2]]'), { verdict: 'changes', taskId: 't2' });
});

test('reviewVerdict: only the last six lines count, unless told to look anywhere', () => {
  const early = `[[verdict: changes | t1]]\n${lines(6)}`;
  assert.deepEqual(reviewVerdict(early), {});
  assert.deepEqual(reviewVerdict(early, true), { verdict: 'changes', taskId: 't1' });
  // Five lines after it: still inside the six.
  assert.deepEqual(reviewVerdict(`[[verdict: changes | t1]]\n${lines(5)}`), { verdict: 'changes', taskId: 't1' });
});

test('reviewVerdict: looking anywhere still takes the last verdict', () => {
  const text = `[[verdict: changes]]\n${lines(8)}\n[[verdict: approve]]\n${lines(8)}`;
  assert.deepEqual(reviewVerdict(text), {});
  assert.deepEqual(reviewVerdict(text, true).verdict, 'approve');
});

test('reviewVerdict: a line quoting both markers is the instructions, not a verdict', () => {
  const quote = 'End with [[verdict: approve]] or [[verdict: changes]].';
  assert.deepEqual(reviewVerdict(quote), {});
  assert.deepEqual(reviewVerdict(quote, true), {});
  // A real verdict before or after the quoted line still counts.
  assert.deepEqual(reviewVerdict(`${quote}\nMine:\n[[verdict: changes]]`).verdict, 'changes');
  assert.deepEqual(reviewVerdict(`[[verdict: approve]]\n(I was asked to end with [[verdict: approve]] or [[verdict: changes]].)`).verdict, 'approve');
});

test('reviewVerdict: quoted lines do not count towards the last six', () => {
  const quote = 'End with [[verdict: approve]] or [[verdict: changes]].';
  // Six lines follow the verdict, but one of them is the quote, which is dropped first.
  assert.deepEqual(reviewVerdict(`[[verdict: changes]]\n${lines(5)}\n${quote}`).verdict, 'changes');
});

test('reviewVerdict: a [[done: …]] marker with a review word stands in for a missing verdict', () => {
  assert.deepEqual(reviewVerdict('[[done: t2 | approved | all fine]]'), { verdict: 'approve', taskId: 't2' });
  assert.deepEqual(reviewVerdict('[[done: t2 | approve]]'), { verdict: 'approve', taskId: 't2' });
  assert.deepEqual(reviewVerdict('[[done: T2#3 | LGTM | nice]]'), { verdict: 'approve', taskId: 't2' });
  assert.deepEqual(reviewVerdict('[[done: t2 | changes | see notes]]'), { verdict: 'changes', taskId: 't2' });
  assert.deepEqual(reviewVerdict('[[done: t2 | send back | see notes]]'), { verdict: 'changes', taskId: 't2' });
  assert.deepEqual(reviewVerdict('[[done: t2 | needs changes]]'), { verdict: 'changes', taskId: 't2' });
});

test('reviewVerdict: a builder\'s own done report is not a verdict', () => {
  assert.deepEqual(reviewVerdict('[[done: t2 | done | wrote the parser]]'), {});
  assert.deepEqual(reviewVerdict('[[done: t2 | blocked | needs a key]]'), {});
  assert.deepEqual(reviewVerdict('[[done: t2 | partial]]'), {});
  // The review word must end at a word boundary: "approval" is not "approve".
  assert.deepEqual(reviewVerdict('[[done: t2 | approval pending]]'), {});
  // Words after it are fine.
  assert.deepEqual(reviewVerdict('[[done: t2 | changes requested]]'), { verdict: 'changes', taskId: 't2' });
});

test('reviewVerdict: with both inside the last six lines, an explicit verdict beats a done marker in either order', () => {
  assert.deepEqual(reviewVerdict('[[verdict: changes | t1]]\n[[done: t1 | approved]]'), { verdict: 'changes', taskId: 't1' });
  assert.deepEqual(reviewVerdict('[[done: t1 | changes]]\n[[verdict: approve]]'), { verdict: 'approve', taskId: undefined });
});

test('reviewVerdict: an explicit verdict above the last six lines loses to a done marker inside them', () => {
  // Pins today's rule: the explicit verdict is only looked for in the window, so the stand-in decides.
  const text = `[[verdict: approve | t1]]\n${lines(6)}\n[[done: t2 | changes]]`;
  assert.deepEqual(reviewVerdict(text), { verdict: 'changes', taskId: 't2' });
  // Looking anywhere, the explicit verdict wins again.
  assert.deepEqual(reviewVerdict(text, true), { verdict: 'approve', taskId: 't1' });
});

test('reviewVerdict: the done-marker stand-in follows the same six-line rule', () => {
  const early = `[[done: t2 | approved]]\n${lines(6)}`;
  assert.deepEqual(reviewVerdict(early), {});
  assert.deepEqual(reviewVerdict(early, true), { verdict: 'approve', taskId: 't2' });
  // The last such marker wins.
  assert.deepEqual(reviewVerdict('[[done: t1 | approved]]\n[[done: t2 | changes]]'), { verdict: 'changes', taskId: 't2' });
});

test('reviewVerdict: Windows line endings', () => {
  assert.deepEqual(reviewVerdict('Fine.\r\n[[verdict: approve | t4]]\r\n'), { verdict: 'approve', taskId: 't4' });
});
