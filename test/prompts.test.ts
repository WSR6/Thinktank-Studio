import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityOf,
  commentsInstruction,
  continueInstruction,
  discussionRoundInstruction,
  nudgeInstruction,
  phaseStartInstruction,
  questionInstruction,
  answerInstruction,
  reviewInstruction,
  sendBackInstruction,
} from '../server/orchestrator/prompts.js';
import { reviewVerdict } from '../server/orchestrator/markers.js';
import type { ReviewEntry } from '../server/reviews.js';

/**
 * The status line ("working: building t3") is read back from the instruction a turn was given, so
 * each instruction builder and activityOf must keep agreeing.
 */

const task = { id: 't3', title: 'Add login', owner: 'codex', status: 'doing', files: ['src/auth/**'] };
const rec: ReviewEntry = { status: 'in_review', stages: ['first', 'final'], stage: 0, rounds: 0, history: [] };
const names = (id: string) => ({ codex: 'Codex', claude: 'Claude' })[id] ?? id;

test('activityOf reads back what each instruction is for', () => {
  assert.equal(activityOf(continueInstruction(task, 2, '')), 'building t3');
  assert.equal(activityOf(continueInstruction(task, 1, '').replace('AUTOPILOT: keep going.', 'UNBLOCKED:')), 'building t3');
  assert.equal(activityOf(reviewInstruction(task, 'first', rec, names, '')), 'first review of t3 for Codex');
  assert.equal(activityOf(sendBackInstruction(task, 'Claude (review)', 2, 'fix it')), 'fixing t3 after review');
  assert.equal(activityOf(commentsInstruction('codex', ['c1. a.ts:3: x'])), 'working through line comments');
  assert.equal(activityOf(questionInstruction('Claude', 'q1', 'why?')), "answering Claude's question");
  assert.equal(activityOf(answerInstruction('Claude', 'q1', 'because')), "continuing with Claude's answer");
  assert.equal(activityOf(phaseStartInstruction('build')), 'starting its build tasks');
  assert.equal(activityOf(phaseStartInstruction('review')), "reviewing teammates' branches");
  assert.equal(activityOf(discussionRoundInstruction(2, 3)), 'discussion round 2');
  assert.equal(activityOf(nudgeInstruction('went quiet')), 'continuing after a nudge');
  assert.equal(activityOf(undefined), 'replying');
});

test('continueInstruction quotes the attempt in its done marker and adds hand-offs only when there are some', () => {
  assert.match(continueInstruction(task, 2, ''), /\[\[done: t3#2 \| done \| one-line summary\]\]/);
  assert.doesNotMatch(continueInstruction(task, 1, ''), /builds on/);
  assert.match(continueInstruction(task, 1, '- t1 "API" by Claude: routes'), /This task builds on:\n- t1/);
});

test('a review request names its files and hand-off, and quoting it is never read as a verdict', () => {
  const text = reviewInstruction(task, 'final', rec, names, 'added /login', '/tmp/review-codex');
  assert.match(text, /It owns: src\/auth\/\*\*\./);
  assert.match(text, /hand-off note: added \/login/);
  assert.match(text, /checked out at \/tmp\/review-codex/);
  assert.match(text, /final check before this task is accepted/);
  assert.deepEqual(reviewVerdict(text), {});
});
