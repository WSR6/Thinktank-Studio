import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Orchestrator } from '../server/orchestrator.js';
import { CHAT_KEEP, CHAT_PAGE } from '../server/orchestrator/chatlog.js';
import type { AgentConfig } from '../server/types.js';

/**
 * Opening a real project (mock agent) with a very long chat, and with damaged state files.
 * Needs git: opening a project creates a repository.
 */

const config: AgentConfig = { id: 'mocky', name: 'Mocky', adapter: 'mock', command: 'mock' };
let orch: Orchestrator;
let scratch: string;
const saved: Record<string, string | undefined> = {};
const PROJECT = 'open-test';
const teamDir = () => orch.project!.teamDir;
/** The last open's state-file writes run in the background: let them land before changing the files. */
const settle = () => new Promise((r) => setTimeout(r, 400));

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'tts-open-'));
  const env = { TTS_PROJECTS_DIR: join(scratch, 'projects'), HOME: scratch, USERPROFILE: scratch };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { Orchestrator } = await import('../server/orchestrator.js');
  orch = new Orchestrator([config], true);
  await orch.open(PROJECT, true);
});

after(async () => {
  orch.stopAll();
  (orch as unknown as { watcher?: { close(): void } })?.watcher?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => setTimeout(r, 200));
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
});

test('a long chat: only the newest messages are in memory and on the page; older ones page in from disk', { timeout: 60_000 }, async () => {
  await settle();
  const total = CHAT_KEEP + 3000;
  const lines = Array.from({ length: total }, (_, i) => JSON.stringify({ id: `old${i}`, ts: i, from: 'user', to: 'all', text: `old message ${i}` }));
  writeFileSync(join(teamDir(), 'chat.jsonl'), lines.join('\n') + '\n');
  await orch.open(PROJECT, false);
  assert.ok(orch.messages.length <= CHAT_KEEP + 5, `${orch.messages.length} messages in memory`);
  assert.equal(orch.messages[0].id, `old${total - CHAT_KEEP}`);
  const page = orch.chatPage();
  assert.equal(page.messages.length, CHAT_PAGE);
  assert.equal(page.earlier, true);
  // Page back past what memory holds.
  let before = page.messages[0].id;
  let seen = page.messages.length;
  for (;;) {
    const older = await orch.earlierMessages(before);
    seen += older.messages.length;
    if (!older.earlier) break;
    before = older.messages[0].id;
  }
  assert.ok(seen >= total, `paged through ${seen} of ${total}`);
  await assert.rejects(orch.earlierMessages('no-such-id'), /Reload the page/);
  // New messages still land after the loaded window, with absolute numbering intact.
  const totalBefore = orch.messages.length;
  await orch.userSend('a new one', 'all');
  assert.ok(orch.messages.slice(totalBefore).some((m) => m.text === 'a new one'));
});

test('damaged state files with no backup: moved aside, started clean, and the chat says so once', { timeout: 60_000 }, async () => {
  const dir = teamDir();
  // Damage the files while another project is open (as after a crash): reopening the open project
  // would first save its in-memory settings over session.json.
  await orch.open('another-project', true);
  await settle();
  rmSync(join(dir, 'backups'), { recursive: true, force: true });
  writeFileSync(join(dir, 'session.json'), '{"leader": ');
  writeFileSync(join(dir, 'reviews.json'), '[1,2');
  writeFileSync(join(dir, 'comments.json'), 'garbage');
  writeFileSync(join(dir, 'tasks.json'), '{"tasks": [');
  await orch.open(PROJECT, false);
  // tasks.json's notice comes from the first read of the task list.
  await new Promise((r) => setTimeout(r, 300));
  const files = readdirSync(dir);
  for (const name of ['session.json', 'reviews.json', 'comments.json', 'tasks.json']) {
    assert.ok(files.some((f) => f.startsWith(`${name}.corrupt-`)), `a kept copy of ${name}`);
  }
  assert.ok(existsSync(join(dir, 'tasks.json')), 'tasks.json stays for the agents to repair');
  const texts = orch.messages.slice(-10).map((m) => m.text).join('\n');
  assert.match(texts, /team\/session\.json was damaged/);
  assert.match(texts, /team\/reviews\.json was damaged/);
  assert.match(texts, /team\/comments\.json was damaged/);
  assert.match(texts, /tasks\.json isn't valid JSON .*copy of the damaged file is kept as team\/tasks\.json\.corrupt-/);
  assert.equal(orch.state().phase, 'plan');
});

test('a chat line that fails to save is retried before newer ones, so the file has no hole', { timeout: 60_000 }, async () => {
  await orch.open('append-test', true);
  await settle();
  const file = join(teamDir(), 'chat.jsonl');
  const before = readFileSync(file, 'utf8');
  rmSync(file);
  mkdirSync(file); // appending to a folder fails, like a full disk
  const err = console.error;
  console.error = () => {};
  try {
    await orch.userSend('first, while saving fails', 'all');
    await settle();
  } finally {
    console.error = err;
  }
  assert.ok(orch.messages.some((m) => /couldn't add new messages/i.test(m.text)), 'you are told once');
  rmSync(file, { recursive: true });
  writeFileSync(file, before);
  await orch.userSend('second, after it works again', 'all');
  await settle();
  const saved = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l).text as string];
    } catch {
      return []; // the fresh-line guard can leave a blank or partial line
    }
  });
  const a = saved.indexOf('first, while saving fails');
  const b = saved.indexOf('second, after it works again');
  assert.ok(a >= 0 && b > a, `both saved, in order: ${a}, ${b}`);
});
