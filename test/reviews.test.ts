import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMachineStage, parseVerdict } from '../server/reviews.js';

test('parseVerdict reads approve and changes at the end of a reply', () => {
  assert.equal(parseVerdict('Looks good.\n[[verdict: approve]]'), 'approve');
  assert.equal(parseVerdict('Two problems.\n[[verdict: changes]]'), 'changes');
});

test('parseVerdict ignores case and spacing inside the marker', () => {
  assert.equal(parseVerdict('[[ Verdict : APPROVE ]]'), 'approve');
  assert.equal(parseVerdict('[[VERDICT:Changes]]'), 'changes');
  assert.equal(parseVerdict('[[verdict:\tapprove\t]]'), 'approve');
});

test('parseVerdict returns undefined when there is no usable marker', () => {
  assert.equal(parseVerdict(''), undefined);
  assert.equal(parseVerdict('   \n\n  '), undefined);
  assert.equal(parseVerdict('I approve of this change.'), undefined);
  assert.equal(parseVerdict('[[verdict: maybe]]'), undefined);
  assert.equal(parseVerdict('[[verdict: approved]]'), undefined);
  assert.equal(parseVerdict('[[verdict]]'), undefined);
  assert.equal(parseVerdict('[verdict: approve]'), undefined);
  assert.equal(parseVerdict('[[verdict: approve]'), undefined);
});

test('parseVerdict only looks at the last six lines', () => {
  const notes = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. a note`).join('\n');
  // The marker followed by five lines of notes is the sixth line from the end: still counted.
  assert.equal(parseVerdict(`Reviewed t1.\n[[verdict: changes]]\n${notes(5)}`), 'changes');
  // Six lines after it: too far up, e.g. a marker quoted early in a long reply.
  assert.equal(parseVerdict(`Reviewed t1.\n[[verdict: changes]]\n${notes(6)}`), undefined);
});

test('parseVerdict does not count blank lines around the reply', () => {
  assert.equal(parseVerdict(`\n\n[[verdict: approve]]\n\n\n\n\n\n\n\n\n`), 'approve');
  // Blank lines inside the reply do count towards the six.
  assert.equal(parseVerdict('[[verdict: approve]]\n\n\n\n\n\nthe end'), undefined);
});

test('parseVerdict works with Windows line endings', () => {
  assert.equal(parseVerdict('Looks good.\r\n[[verdict: approve]]\r\n'), 'approve');
  assert.equal(parseVerdict('a\r\n[[verdict: changes]]\r\n1. fix it\r\n2. and this\r\n'), 'changes');
});

test('parseVerdict finds a marker in the middle of a line', () => {
  assert.equal(parseVerdict('All fine, so [[verdict: approve]] from me.'), 'approve');
});

test('parseVerdict takes the first of two markers in the last lines', () => {
  // Pins what this function returns: the earlier one. It is not the rule that accepts or sends back
  // a reviewed task: that is reviewVerdict in orchestrator.ts, where the last marker wins
  // (see review-verdict.test.ts). parseVerdict is only used for line comments.
  assert.equal(parseVerdict('[[verdict: changes]]\nOn reflection:\n[[verdict: approve]]'), 'changes');
  assert.equal(parseVerdict('[[verdict: approve]]\n[[verdict: changes]]'), 'approve');
});

test('parseVerdict ignores an old marker above the last six lines when a new one is at the end', () => {
  const filler = Array.from({ length: 8 }, () => 'more detail').join('\n');
  assert.equal(parseVerdict(`[[verdict: changes]]\n${filler}\n[[verdict: approve]]`), 'approve');
});

test('isMachineStage is true only for the stages the app runs itself', () => {
  assert.equal(isMachineStage('tests'), true);
  assert.equal(isMachineStage('desktop'), true);
  assert.equal(isMachineStage('first'), false);
  assert.equal(isMachineStage('final'), false);
  assert.equal(isMachineStage('cross'), false);
  assert.equal(isMachineStage(undefined), false);
});
