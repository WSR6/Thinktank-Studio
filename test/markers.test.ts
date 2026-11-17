import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASK_RE, DM_RE, DONE_RE, MENTION_RE, OPTIONS_RE, PASS_RE, REQUEST_RE, USER_RE, namesTask } from '../server/orchestrator.js';

/** All matches of a global pattern, as arrays of capture groups (matchAll works on a copy, so lastIndex never leaks). */
const all = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m.slice(1));

// ── [[done: …]] ─────────────────────────────────────────────────────────

test('DONE_RE: task, attempt, outcome and summary', () => {
  assert.deepEqual(all(DONE_RE, 'Finished. [[done: t3#2 | done | wrote the parser]]'), [['t3', '2', 'done', 'wrote the parser']]);
});

test('DONE_RE: attempt and summary are optional', () => {
  assert.deepEqual(all(DONE_RE, '[[done: t3 | done | summary]]'), [['t3', undefined, 'done', 'summary']]);
  assert.deepEqual(all(DONE_RE, '[[done: t3#4 | blocked]]'), [['t3', '4', 'blocked', undefined]]);
  assert.deepEqual(all(DONE_RE, '[[done: t3 | partial |]]'), [['t3', undefined, 'partial', '']]);
});

test('DONE_RE: spacing and case are loose', () => {
  assert.deepEqual(all(DONE_RE, '[[ DONE : t3 # 2|Blocked|  needs a key  ]]'), [['t3', '2', 'Blocked', 'needs a key']]);
  assert.deepEqual(all(DONE_RE, '[[done:t3|PARTIAL]]'), [['t3', undefined, 'PARTIAL', undefined]]);
});

test('DONE_RE: task ids may have dots, dashes and underscores', () => {
  assert.deepEqual(all(DONE_RE, '[[done: api-v2.1_fix#3 | done | ok]]').map((m) => m[0]), ['api-v2.1_fix']);
});

test('DONE_RE: every report in a reply is found', () => {
  const text = 'Two things.\n[[done: t1 | done | first]]\nand\n[[done: t2#2 | blocked | second]] [[done: t3 | partial]]';
  assert.deepEqual(all(DONE_RE, text).map(([id, n, outcome]) => `${id}/${n ?? '-'}/${outcome}`), ['t1/-/done', 't2/2/blocked', 't3/-/partial']);
});

test('DONE_RE: a summary may hold pipes but not a closing bracket', () => {
  assert.deepEqual(all(DONE_RE, '[[done: t1 | done | a | b | c]]'), [['t1', undefined, 'done', 'a | b | c']]);
  assert.deepEqual(all(DONE_RE, '[[done: t1 | done | see items[0] here]]'), []);
});

test('DONE_RE: malformed reports are not matched', () => {
  for (const text of [
    '[[done: t1]]', // no outcome
    '[[done: t1 | finished | x]]', // unknown outcome
    '[[done: t1 | done-ish]]',
    '[[done: | done | x]]', // no task
    '[[done: t1#two | done]]', // attempt must be a number
    '[[done: t1 t2 | done]]',
    '[done: t1 | done]',
    '[[done: t1 | done | x]',
    'done: t1 | done | x',
  ])
    assert.deepEqual(all(DONE_RE, text), [], text);
});

// ── [[ask: …]] and [[to: …]] ────────────────────────────────────────────

test('ASK_RE: the marker must open the reply; the rest is the question', () => {
  const text = '[[ask: codex]] Which port should the API use?';
  const m = text.match(ASK_RE);
  assert.equal(m?.[1], 'codex');
  assert.equal(text.slice(m![0].length), 'Which port should the API use?');
});

test('ASK_RE: leading space, @ and case are accepted', () => {
  assert.equal('  \n[[ ASK : @Agent-2 ]]\nquestion'.match(ASK_RE)?.[1], 'Agent-2');
  assert.equal('[[ask:grok_1]]q'.match(ASK_RE)?.[1], 'grok_1');
});

test('ASK_RE: not matched later in the reply or when malformed', () => {
  assert.equal('I could write [[ask: codex]] but I will not.'.match(ASK_RE), null);
  assert.equal('Intro line\n[[ask: codex]] question'.match(ASK_RE), null);
  assert.equal('[[ask: ]] question'.match(ASK_RE), null);
  assert.equal('[[ask: two words]] question'.match(ASK_RE), null);
  assert.equal('[[ask codex]] question'.match(ASK_RE), null);
  assert.equal('[ask: codex] question'.match(ASK_RE), null);
});

test('DM_RE: a private message starts with [[to: id]]', () => {
  const text = '[[to: grok]] psst, a private note';
  const m = text.match(DM_RE);
  assert.equal(m?.[1], 'grok');
  assert.equal(text.slice(m![0].length), 'psst, a private note');
  assert.equal(' [[TO:@claude]]hi'.match(DM_RE)?.[1], 'claude');
});

test('DM_RE: not matched mid-reply, and ask is not to', () => {
  assert.equal('Sending [[to: grok]] later.'.match(DM_RE), null);
  assert.equal('[[ask: grok]] hello'.match(DM_RE), null);
  assert.equal('[[to: grok]] hello'.match(ASK_RE), null);
  assert.equal('[[to: ]] hello'.match(DM_RE), null);
});

// ── [[phase: …]] / [[merge: …]] ─────────────────────────────────────────

test('REQUEST_RE: phase and merge requests', () => {
  assert.deepEqual(all(REQUEST_RE, 'The plan is ready.\n[[phase: build]]'), [['phase', 'build']]);
  assert.deepEqual(all(REQUEST_RE, '[[merge: codex]]'), [['merge', 'codex']]);
  assert.deepEqual(all(REQUEST_RE, '[[ Phase : Review ]] [[MERGE:agent_2-b]]'), [['Phase', 'Review'], ['MERGE', 'agent_2-b']]);
});

test('REQUEST_RE: other markers and malformed requests are not requests', () => {
  for (const text of ['[[verdict: approve]]', '[[done: t1 | done]]', '[[phase build]]', '[[phase: ]]', '[[phase: build now]]', '[phase: build]', '[[phases: build]]', '[[merge: codex]'])
    assert.deepEqual(all(REQUEST_RE, text), [], text);
});

test('REQUEST_RE: the value is captured as written, for the caller to validate', () => {
  // The orchestrator checks the value against the known phases and agents; the pattern does not.
  assert.deepEqual(all(REQUEST_RE, '[[phase: ship-it]]'), [['phase', 'ship-it']]);
});

// ── [[pass]] ────────────────────────────────────────────────────────────

test('PASS_RE: a reply that is only a pass', () => {
  for (const text of ['[[pass]]', '  [[ PASS ]]\n', 'pass', 'Pass.', '\npass\n', '[[Pass]]']) assert.equal(PASS_RE.test(text), true, JSON.stringify(text));
});

test('PASS_RE: anything more than a pass is a real reply', () => {
  for (const text of ['', 'I pass', 'pass the config along', '[[pass]] but one thing', 'pass!', 'passed', 'Nothing to add.\n[[pass]]', '[pass]'])
    assert.equal(PASS_RE.test(text), false, JSON.stringify(text));
});

// ── @mentions ───────────────────────────────────────────────────────────

test('MENTION_RE: @name hands off to that agent', () => {
  assert.deepEqual(all(MENTION_RE, '@codex can you check? cc @grok, @Agent-2.').flat(), ['codex', 'grok', 'Agent-2']);
  assert.deepEqual(all(MENTION_RE, '(@codex) "@grok" \n@claude').flat(), ['codex', 'grok', 'claude']);
});

test('MENTION_RE: e-mail addresses and dotted names do not mention anyone', () => {
  assert.deepEqual(all(MENTION_RE, 'mail someone@codex.example or first.last@grok.example').flat(), []);
  assert.deepEqual(all(MENTION_RE, 'the package.@scope name and a lone @ sign').flat(), []);
  assert.deepEqual(all(MENTION_RE, 'npm i @types/node').flat(), ['types']);
});

test('USER_RE: @user flags the reply as needing the user', () => {
  assert.equal(USER_RE.test('@user which database should I use?'), true);
  assert.equal(USER_RE.test('Done. (@User, please confirm.)'), true);
  assert.equal(USER_RE.test('ask @user.'), true);
});

test('USER_RE: longer names and addresses are not @user', () => {
  assert.equal(USER_RE.test('@username is taken'), false);
  assert.equal(USER_RE.test('@users table'), false);
  assert.equal(USER_RE.test('write to someone@user.example'), false);
  assert.equal(USER_RE.test('the user said so'), false);
  assert.equal(USER_RE.test('@user_id column'), false);
});

// ── [[options: …]] ──────────────────────────────────────────────────────

test('OPTIONS_RE: the choices offered with a question', () => {
  const text = '@user which database? [[options: SQLite | Postgres | You decide]]';
  assert.deepEqual(text.match(OPTIONS_RE)?.[1].split('|').map((s) => s.trim()), ['SQLite', 'Postgres', 'You decide']);
  assert.equal(text.replace(OPTIONS_RE, '').trim(), '@user which database?');
  assert.equal('[[ OPTIONS : Yes|No ]]'.match(OPTIONS_RE)?.[1].trim(), 'Yes|No');
});

test('OPTIONS_RE: only the first list counts, and an empty one is nothing', () => {
  assert.equal('[[options: A | B]] and [[options: C | D]]'.match(OPTIONS_RE)?.[1], 'A | B');
  assert.equal('[[options:]]'.match(OPTIONS_RE), null);
  assert.equal('[[option: A | B]]'.match(OPTIONS_RE), null);
});

// ── namesTask ───────────────────────────────────────────────────────────

test('namesTask: a task id counts only as a whole word', () => {
  assert.equal(namesTask('Reviewed t1: looks good.', 't1'), true);
  assert.equal(namesTask('(t1)', 't1'), true);
  assert.equal(namesTask('t1', 't1'), true);
  assert.equal(namesTask('Reviewed t10: looks good.', 't1'), false);
  assert.equal(namesTask('Reviewed at1.', 't1'), false);
  assert.equal(namesTask('see t1-extra and x-t1', 't1'), false);
  assert.equal(namesTask('t1_b', 't1'), false);
  assert.equal(namesTask('', 't1'), false);
});

test('namesTask: ids are matched literally and with their case', () => {
  assert.equal(namesTask('fixed api.v2 today', 'api.v2'), true);
  assert.equal(namesTask('fixed apixv2 today', 'api.v2'), false);
  assert.equal(namesTask('Reviewed T1.', 't1'), false);
  assert.equal(namesTask('about t1.', 't1'), true);
});
