import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ProjectInfo } from '../server/project.js';
import { depsOf, handoffsFor, handoffText, isReady, TaskStore } from '../server/orchestrator/tasks.js';
import type { Task } from '../server/orchestrator/types.js';

const root = mkdtempSync(join(tmpdir(), 'tts-tasks-'));
after(() => rmSync(root, { recursive: true, force: true }));

function store(name: string, content: string) {
  const teamDir = join(root, name);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(join(teamDir, 'tasks.json'), content);
  const project: ProjectInfo = { name, root: teamDir, repoDir: teamDir, teamDir, agentDirs: {} };
  const broken: string[] = [];
  const s = new TaskStore({ project: () => project, broken: (_file, msg) => broken.push(msg) });
  return { s, teamDir, broken };
}

test('TaskStore.read: keeps tasks with an id, and the last good list while the file is broken', async () => {
  const { s, teamDir, broken } = store('read', JSON.stringify({ tasks: [{ id: 't1', owner: 'a' }, { title: 'no id' }, null] }));
  assert.deepEqual((await s.read()).map((t) => t.id), ['t1']);
  writeFileSync(join(teamDir, 'tasks.json'), '{"tasks": [');
  assert.deepEqual((await s.read()).map((t) => t.id), ['t1']);
  assert.deepEqual(broken, [], 'not reported inside the grace period');
  s.reset();
  assert.deepEqual(s.last, []);
});

test('TaskStore.update: queued edits all land, each on the latest file', async () => {
  const { s, teamDir } = store('update', JSON.stringify({ tasks: [{ id: 't1', status: 'todo' }, { id: 't2', status: 'todo' }] }));
  const results = await Promise.all([
    s.update('t1', { status: 'doing' }),
    s.update('t2', (t) => (t.status === 'todo' ? { status: 'done', note: 'x' } : undefined)),
    s.update('t1', (t) => (t.status === 'doing' ? { note: 'second edit saw the first' } : undefined)),
    s.update('t9', { status: 'done' }),
  ]);
  assert.deepEqual(results, [true, true, true, false]);
  const saved = JSON.parse(readFileSync(join(teamDir, 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(saved, [
    { id: 't1', status: 'doing', note: 'second edit saw the first' },
    { id: 't2', status: 'done', note: 'x' },
  ]);
});

test('depsOf / isReady / handoffsFor', () => {
  const tasks: Task[] = [
    { id: 't1', title: 'API', owner: 'claude', status: 'done', handoff: { files: ['a.ts', 'b.ts'], why: 'speed' } },
    { id: 't2', title: 'UI', owner: 'codex', status: 'todo', after: ['t1', 7, 'gone'] },
  ];
  assert.deepEqual(depsOf(tasks[1]), ['t1', 'gone']);
  assert.equal(isReady(tasks[1], tasks, () => true), true);
  assert.equal(isReady(tasks[1], tasks, (t) => t.id !== 't1'), false);
  assert.equal(handoffText(tasks[0]), 'files: a.ts, b.ts; why: speed');
  assert.equal(handoffsFor(tasks[1], tasks, (id) => id.toUpperCase()), '- t1 "API" by CLAUDE: files: a.ts, b.ts; why: speed');
});
