import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Orchestrator } from '../server/orchestrator.js';
import type { Task } from '../server/orchestrator/types.js';
import type { AgentConfig } from '../server/types.js';

/**
 * "All tasks done" with autopilot off: it is announced once per batch of work, and a batch added after
 * the project finished is announced again. Real Orchestrator, mock agent. Needs git.
 */

const config: AgentConfig = { id: 'solo', name: 'Solo', adapter: 'mock', command: 'mock' };
let orch: Orchestrator;
let scratch: string;
const saved: Record<string, string | undefined> = {};

/** The private parts this test drives directly. */
type Inside = {
  checkAllDone(tasks: Task[]): void;
  wakeForNewTasks(tasks: Task[]): void;
  allDoneAnnounced: boolean;
  autopilot: boolean;
  doneOk: Record<string, number>;
  attemptOf(id: string): number;
};
const inside = () => orch as unknown as Inside;
/** What the app records once it has checked a "done" against git. */
const checked = (...ids: string[]) => ids.forEach((id) => (inside().doneOk[id] = inside().attemptOf(id)));
const announced = () => orch.messages.filter((m) => m.from === 'system' && /All tasks in tasks\.json are done/.test(m.text)).length;

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'tts-all-done-'));
  const env = { TTS_PROJECTS_DIR: join(scratch, 'projects'), HOME: scratch, USERPROFILE: scratch };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { Orchestrator } = await import('../server/orchestrator.js');
  orch = new Orchestrator([config], true);
  await orch.open('all-done-test', true);
});

after(async () => {
  orch?.stopAll();
  // The folder watcher would keep the test process alive.
  (orch as unknown as { watcher?: { close(): void } })?.watcher?.close();
  await new Promise((r) => setTimeout(r, 200)); // let the last state writes land
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('a second batch of tasks is announced as done again, with autopilot off', () => {
  assert.equal(inside().autopilot, false);
  const first: Task[] = [{ id: 't1', owner: 'user', status: 'done' }];
  checked('t1');
  inside().wakeForNewTasks(first);
  inside().checkAllDone(first);
  inside().checkAllDone(first); // a second check of the same batch stays quiet
  assert.equal(announced(), 1);

  const second: Task[] = [...first, { id: 't2', owner: 'user', status: 'todo' }];
  inside().wakeForNewTasks(second);
  assert.equal(inside().allDoneAnnounced, false, 'new open work clears the "finished" mark');
  inside().checkAllDone(second); // t2 still open: not done yet
  assert.equal(announced(), 1);

  const finished: Task[] = [first[0], { id: 't2', owner: 'user', status: 'done' }];
  checked('t2');
  inside().checkAllDone(finished);
  assert.equal(announced(), 2);
});
