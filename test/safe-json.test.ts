import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadComments } from '../server/comments.js';
import { keepBrokenCopy } from '../server/orchestrator/persistence.js';
import { TaskStore } from '../server/orchestrator/tasks.js';
import type { ProjectInfo } from '../server/project.js';
import { loadReviews } from '../server/reviews.js';
import { isRecord, loadJsonFile } from '../server/safe-json.js';

const root = mkdtempSync(join(tmpdir(), 'tts-safe-json-'));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
let n = 0;
const dir = () => {
  const d = join(root, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const corruptCopies = (d: string, name: string) => readdirSync(d).filter((f) => f.startsWith(`${name}.corrupt-`));
const opts = { label: 'team/x.json', what: 'x starts empty', valid: isRecord };

test('loadJsonFile: missing → fallback, no problem; good → value (BOM is fine)', () => {
  const d = dir();
  assert.deepEqual(loadJsonFile(join(d, 'x.json'), { a: 0 }, opts), { value: { a: 0 } });
  writeFileSync(join(d, 'x.json'), '﻿{"a": 1}');
  assert.deepEqual(loadJsonFile(join(d, 'x.json'), {}, opts), { value: { a: 1 } });
});

test('loadJsonFile: a damaged file is moved aside, the caller starts clean, and the message says where it went', () => {
  const d = dir();
  writeFileSync(join(d, 'x.json'), '{"a": ');
  const r = loadJsonFile(join(d, 'x.json'), { clean: true }, opts);
  assert.deepEqual(r.value, { clean: true });
  const kept = corruptCopies(d, 'x.json');
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(d, kept[0]), 'utf8'), '{"a": ');
  assert.equal(existsSync(join(d, 'x.json')), false);
  assert.match(r.problem!, /team\/x\.json was damaged \(it isn't valid JSON\), so x starts empty\. The damaged copy is kept as x\.json\.corrupt-/);
  // Damaged twice in the same second: the second copy doesn't overwrite the first.
  writeFileSync(join(d, 'x.json'), '[[');
  loadJsonFile(join(d, 'x.json'), {}, opts);
  assert.equal(corruptCopies(d, 'x.json').length, 2);
});

test('loadJsonFile: valid JSON with the wrong layout counts as damaged', () => {
  const d = dir();
  writeFileSync(join(d, 'x.json'), '[1, 2]');
  const r = loadJsonFile(join(d, 'x.json'), {}, opts);
  assert.match(r.problem!, /expected layout/);
  assert.equal(corruptCopies(d, 'x.json').length, 1);
});

test('loadReviews and loadComments report damage instead of silently resetting', () => {
  const d = dir();
  writeFileSync(join(d, 'reviews.json'), '{ not json');
  writeFileSync(join(d, 'comments.json'), '{"oops": true}');
  const told: string[] = [];
  assert.deepEqual(loadReviews(d, (t) => told.push(t)), {});
  assert.deepEqual(loadComments(d, (t) => told.push(t)), []);
  assert.equal(told.length, 2);
  assert.match(told[0], /team\/reviews\.json was damaged/);
  assert.match(told[1], /team\/comments\.json was damaged/);
  assert.equal(corruptCopies(d, 'reviews.json').length + corruptCopies(d, 'comments.json').length, 2);
});

test('loadReviews drops single damaged entries and says how many', () => {
  const d = dir();
  const good = { status: 'passed', stages: ['tests'], stage: 0, rounds: 0, history: [] };
  writeFileSync(join(d, 'reviews.json'), JSON.stringify({ t1: good, t2: { status: 'in_review' }, t3: 'x' }));
  const told: string[] = [];
  assert.deepEqual(Object.keys(loadReviews(d, (t) => told.push(t))), ['t1']);
  assert.match(told.join(), /2 damaged entries in team\/reviews\.json were skipped/);
});

test('keepBrokenCopy copies a damaged tasks.json and leaves the original for the agents to repair', () => {
  const d = dir();
  const file = join(d, 'tasks.json');
  assert.equal(keepBrokenCopy(file), undefined);
  writeFileSync(file, '{"tasks": []}');
  assert.equal(keepBrokenCopy(file), undefined);
  writeFileSync(file, '{"tasks": [');
  const copy = keepBrokenCopy(file)!;
  assert.match(copy, /^tasks\.json\.corrupt-/);
  assert.equal(readFileSync(join(d, copy), 'utf8'), '{"tasks": [');
  assert.equal(readFileSync(file, 'utf8'), '{"tasks": [');
  // Damaged differently within the same second: the first copy survives.
  writeFileSync(file, '{"tasks": [{');
  const second = keepBrokenCopy(file)!;
  assert.notEqual(second, copy);
  assert.equal(readFileSync(join(d, copy), 'utf8'), '{"tasks": [');
  assert.equal(readFileSync(join(d, second), 'utf8'), '{"tasks": [{');
});

test('TaskStore: a tasks.json damaged at open is announced on the first read, naming the copy', async () => {
  const d = dir();
  writeFileSync(join(d, 'tasks.json'), '{"tasks": [');
  const project: ProjectInfo = { name: 'p', root: d, repoDir: d, teamDir: d, agentDirs: {} };
  const told: [string, string | undefined][] = [];
  const s = new TaskStore({ project: () => project, broken: (_f, msg, copy) => told.push([msg, copy]) });
  s.brokenAtOpen('tasks.json.corrupt-x');
  assert.deepEqual(await s.read(), []);
  assert.equal(told.length, 1);
  assert.equal(told[0][1], 'tasks.json.corrupt-x');
  await s.read();
  assert.equal(told.length, 1, 'told once per broken spell');
});

test('TaskStore: a tasks.json an agent breaks while the app runs is copied before it is reported', async () => {
  const d = dir();
  writeFileSync(join(d, 'tasks.json'), '{"tasks": []}');
  const project: ProjectInfo = { name: 'p', root: d, repoDir: d, teamDir: d, agentDirs: {} };
  const told: (string | undefined)[] = [];
  const s = new TaskStore({ project: () => project, broken: (_f, _msg, copy) => told.push(copy) });
  await s.read();
  writeFileSync(join(d, 'tasks.json'), '{"tasks": [ broken');
  s.brokenAtOpen('ignored'); // stands in for the grace period having passed
  (s as unknown as { brokenCopy?: string }).brokenCopy = undefined;
  await s.read();
  assert.equal(told.length, 1);
  assert.match(told[0]!, /^tasks\.json\.corrupt-/);
  assert.equal(readFileSync(join(d, told[0]!), 'utf8'), '{"tasks": [ broken');
});

test('an unreadable file is protected: writers leave it alone until a later read succeeds', async () => {
  const { mayWrite } = await import('../server/safe-json.js');
  const d = dir();
  const path = join(d, 'x.json');
  mkdirSync(path); // reading a folder fails with a code, like a locked or forbidden file
  const r = loadJsonFile(path, {}, opts);
  assert.match(r.problem!, /couldn't be read \(EISDIR\).*won't save over it/);
  assert.equal(mayWrite(path), false);
  rmSync(path, { recursive: true });
  writeFileSync(path, '{}');
  loadJsonFile(path, {}, opts);
  assert.equal(mayWrite(path), true);
});

test('a file that stays broken is copied once, not on every start', async () => {
  const { copyAside } = await import('../server/safe-json.js');
  const d = dir();
  const file = join(d, 'tasks.json');
  writeFileSync(file, '{"tasks": [');
  const first = copyAside(file);
  assert.equal(copyAside(file), first);
  assert.equal(corruptCopies(d, 'tasks.json').length, 1);
});

test('loadReviews keeps the file as it was before dropping damaged entries', () => {
  const d = dir();
  const good = { status: 'passed', stages: ['tests'], stage: 0, rounds: 0, history: [] };
  writeFileSync(join(d, 'reviews.json'), JSON.stringify({ t1: good, t2: 'x' }));
  const told: string[] = [];
  loadReviews(d, (t) => told.push(t));
  const kept = corruptCopies(d, 'reviews.json');
  assert.equal(kept.length, 1);
  assert.match(told.join(), new RegExp(`kept as ${kept[0].replace(/[.]/g, '\.')}`));
});
