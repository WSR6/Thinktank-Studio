import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import type { Orchestrator } from '../server/orchestrator.js';
import type { AgentConfig } from '../server/types.js';

/**
 * Stop all with a turn running and another queued behind it, on a real Orchestrator with a mock
 * agent whose turns never finish (TTS_MOCK_HANG). Needs git: opening a project creates a repository.
 */

const AGENT = 'hangman';
const config: AgentConfig = { id: AGENT, name: 'Hangman', adapter: 'mock', command: 'mock' };

let orch: Orchestrator;
let scratch: string;
/** How many turns the agent started (each one sets its status to working once). */
let turnsStarted = 0;
/** The agent's status line at the last 'state' event: what the panel was last told. */
let panelLine = '';
const saved: Record<string, string | undefined> = {};

const agent = () => orch.state().agents.find((a) => a.id === AGENT)!;

/** Resolves once `check` holds; it is tried again after every event from the app (and on a slow timer). */
function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(deadline);
      clearInterval(poll);
      orch.off('state', tick);
      orch.off('agent_event', tick);
      err ? reject(err) : resolve();
    };
    const tick = () => {
      if (check()) done();
    };
    const deadline = setTimeout(() => done(new Error(`Timed out waiting for: ${what}`)), ms);
    const poll = setInterval(tick, 25);
    orch.on('state', tick);
    orch.on('agent_event', tick);
    tick();
  });
}

/** Waits for sends to settle, but never forever: a turn Stop failed to end would otherwise hang the whole run. */
function settled(sends: Promise<void>[], ms = 10_000): Promise<void> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for the stopped turns to end')), ms);
  });
  return Promise.race([Promise.all(sends).then(() => undefined), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Leaves the agent idle whatever the test before did. If Stop all itself is what broke, the mock's
 * turn is ended directly, so one failure can't hang the later tests or the test process.
 */
async function quiet(): Promise<void> {
  if (!orch) return;
  orch.stopAll();
  const idle = () => !orch.busy() && agent().status !== 'working';
  try {
    await until(idle, 'everything to stop', 3_000);
  } catch {
    const runtime = (orch as unknown as { agents: Map<string, { current?: { kill(): void } }> }).agents.get(AGENT);
    for (let i = 0; i < 20 && !idle(); i++) {
      orch.stopAll();
      runtime?.current?.kill();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'tts-stop-all-'));
  // Projects and the app's own settings go to a scratch folder, never the real home folder.
  // Set before the server code loads: some of it works out its paths on import.
  const env = { TTS_PROJECTS_DIR: join(scratch, 'projects'), HOME: scratch, USERPROFILE: scratch, TTS_MOCK_HANG: AGENT };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { Orchestrator } = await import('../server/orchestrator.js');
  orch = new Orchestrator([config], true);
  orch.on('agent_event', (e: { agentId: string; event: { kind: string; status?: string } }) => {
    if (e.agentId === AGENT && e.event.kind === 'status' && e.event.status === 'working') turnsStarted++;
  });
  orch.on('state', () => {
    panelLine = agent().statusLine;
  });
  await orch.open('stop-all-test', true);
});

afterEach(quiet);

after(async () => {
  await quiet();
  // The folder watcher would keep the test process alive.
  (orch as unknown as { watcher?: { close(): void } })?.watcher?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Last writes of the app's state files may still be landing; a leftover temp folder is harmless.
  await new Promise((r) => setTimeout(r, 200));
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
});

/**
 * Send a message and wait until the agent's (never-ending) turn for it is running. `sent` settles when
 * that turn is over; it is wrapped in an object because an async function would wait for a bare promise.
 */
async function startHungTurn(text: string): Promise<{ sent: Promise<void> }> {
  const before = turnsStarted;
  const sent = orch.userSend(text, AGENT);
  await until(() => turnsStarted === before + 1 && agent().status === 'working', 'the turn to start');
  return { sent };
}

test('Stop all: the running turn ends, the queued one is dropped, and the panel hears about it', { timeout: 60_000 }, async () => {
  const { sent: first } = await startHungTurn('first message');
  const before = turnsStarted;
  // Sent while the first turn runs: it waits in line behind it.
  const second = orch.userSend('second message', AGENT);
  assert.equal(orch.busy(), true);

  orch.stopAll();
  await settled([first, second]);
  await until(() => !orch.busy() && agent().status === 'idle', 'the agent to be idle');

  assert.equal(agent().status, 'idle');
  assert.equal(turnsStarted, before, 'the message queued before the stop must not get a turn');
  assert.doesNotMatch(agent().statusLine, /queued/);
  // The last update sent to the page must not still say "queued".
  assert.doesNotMatch(panelLine, /queued/);
});

test('Stop all: a message sent right after the stop gets a turn', { timeout: 60_000 }, async () => {
  const { sent: first } = await startHungTurn('a message to interrupt');
  const before = turnsStarted;

  orch.stopAll();
  // The stopped turn is still ending at this point.
  const next = orch.userSend('sent right after the stop', AGENT);
  await until(() => turnsStarted === before + 1 && agent().status === 'working', 'the new message to get a turn');
  assert.equal(agent().status, 'working');

  orch.stopAll();
  await settled([first, next]);
  await until(() => !orch.busy() && agent().status === 'idle', 'the agent to be idle');
  assert.equal(turnsStarted, before + 1);
  assert.doesNotMatch(panelLine, /queued/);
});

test('Stop all: with one message queued before the stop and one sent after, exactly one more turn runs', { timeout: 60_000 }, async () => {
  const { sent: first } = await startHungTurn('running');
  const before = turnsStarted;
  const queued = orch.userSend('queued before the stop', AGENT);

  orch.stopAll();
  const next = orch.userSend('sent after the stop', AGENT);
  await until(() => turnsStarted === before + 1 && agent().status === 'working', 'the new message to get a turn');

  orch.stopAll();
  await settled([first, queued, next]);
  await until(() => !orch.busy() && agent().status === 'idle', 'the agent to be idle');
  assert.equal(turnsStarted, before + 1);
  assert.equal(agent().status, 'idle');
  assert.doesNotMatch(panelLine, /queued/);
});

test('Stop all with nothing running leaves the agent idle and free to take the next message', { timeout: 60_000 }, async () => {
  orch.stopAll();
  assert.equal(orch.busy(), false);
  assert.equal(agent().status, 'idle');

  const before = turnsStarted;
  const sent = orch.userSend('after an idle stop', AGENT);
  await until(() => turnsStarted === before + 1, 'the message to get a turn');
  orch.stopAll();
  await settled([sent]);
  await until(() => !orch.busy() && agent().status === 'idle', 'the agent to be idle');
});
