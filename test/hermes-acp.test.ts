import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentSettings, TurnOptions } from '../server/types.js';

/**
 * Hermes over ACP, against a fake `hermes acp` (test/fixtures/fake-acp-hermes.mjs): sessions, the
 * settings sent to it, permission answers, Stop, and a lost session.
 */

const scratch = mkdtempSync(join(tmpdir(), 'tts-hermes-acp-'));
const fixture = resolve(fileURLToPath(new URL('./fixtures/fake-acp-hermes.mjs', import.meta.url)));
const logFile = join(scratch, 'acp.log');
const work = join(scratch, 'work');
const team = join(scratch, 'team');
let command = '';
const saved: Record<string, string | undefined> = {};

before(() => {
  mkdirSync(work);
  mkdirSync(team);
  // A launcher named like a program, as the adapter runs `<command> [-p profile] acp`.
  if (process.platform === 'win32') {
    command = join(scratch, 'fake-hermes.cmd');
    writeFileSync(command, `@node "${fixture}" %*\r\n`);
  } else {
    command = join(scratch, 'fake-hermes');
    writeFileSync(command, `#!/bin/sh\nexec node "${fixture}" "$@"\n`);
    chmodSync(command, 0o755);
  }
  // A Hermes home of our own, so the profile default comes from here and not the real install.
  const home = join(scratch, 'hermes');
  mkdirSync(home);
  writeFileSync(join(home, 'config.yaml'), 'model:\n  default: base-model\n  provider: openrouter\n');
  for (const [k, v] of Object.entries({ FAKE_ACP_LOG: logFile, HERMES_HOME: home })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sent = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const clearLog = () => rmSync(logFile, { force: true });

async function adapter() {
  const { HermesAdapter } = await import('../server/agents/hermes-acp.js');
  return new HermesAdapter({ id: 'h', name: 'Hermes', adapter: 'hermes', command });
}

function opts(prompt: string, settings: Partial<AgentSettings> = {}, sessionId?: string) {
  const events: AgentEvent[] = [];
  const o: TurnOptions = {
    prompt,
    cwd: work,
    extraDirs: [team],
    settings: { model: '', effort: '', autonomy: 'edits', ...settings },
    sessionId,
    onEvent: (e) => events.push(e),
  };
  return { o, events };
}

test('a turn: new session, its text and usage, and only the settings that differ', async () => {
  clearLog();
  const a = await adapter();
  try {
    const t1 = opts('hi', { model: 'coder-model', effort: 'high' });
    const r1 = await a.runTurn(t1.o).done;
    assert.equal(r1.text, 'hello there');
    assert.equal(r1.sessionId, 's1');
    assert.deepEqual(r1.usage, { input: 100, output: 7, cached: 40 });
    assert.ok(t1.events.some((e) => e.kind === 'session' && e.id === 's1'));
    assert.ok(t1.events.some((e) => e.kind === 'text' && e.text === 'hello there'));
    const m1 = sent();
    assert.deepEqual(m1.map((m) => m.method).filter(Boolean), [
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/set_model',
      'session/set_config_option',
      'session/prompt', // the /reasoning command: the in-process server ignores the config option
      'session/prompt',
    ]);
    assert.equal(m1[2].params.value, 'ask', 'edits → Hermes asks the app about every edit');
    assert.equal(m1[3].params.modelId, 'coder-model');
    assert.equal(m1[5].params.prompt[0].text, '/reasoning high');
    assert.equal(t1.events.filter((e) => e.kind === 'text').length, 1, 'the /reasoning reply is not shown');

    // Same settings, same session: only the prompt, in the same Hermes.
    clearLog();
    const r2 = await a.runTurn(opts('again', { model: 'coder-model', effort: 'high' }, 's1').o).done;
    assert.equal(r2.text, 'hello there');
    const m2 = sent();
    assert.deepEqual(m2.map((m) => m.method), ['session/prompt']);
    assert.equal(m2[0].pid, m1[0].pid, 'the Hermes kept running');

    // Back to the profile's own default model, and Auto: the policy and model change.
    clearLog();
    await a.runTurn(opts('again', { model: '', effort: 'high', autonomy: 'auto' }, 's1').o).done;
    const m3 = sent();
    assert.equal(m3.find((m) => m.method === 'session/set_config_option')?.params.value, 'session');
    assert.equal(m3.find((m) => m.method === 'session/set_model')?.params.modelId, 'base-model');
  } finally {
    a.dispose();
  }
});

test('edits inside its folders are allowed, outside refused, never a lasting grant', async () => {
  const a = await adapter();
  try {
    const inside = opts(`EDIT ${join(work, 'x.txt')}`);
    assert.equal((await a.runTurn(inside.o).done).text, 'wrote it');
    assert.ok(inside.events.some((e) => e.kind === 'tool' && e.name.startsWith('write_file')));
    assert.ok(inside.events.some((e) => e.kind === 'tool_end' && e.ok));
    const teamFile = opts(`EDIT ${join(team, 'PLAN.md')}`);
    assert.equal((await a.runTurn(teamFile.o).done).text, 'wrote it');
    const outside = opts(`EDIT ${join(scratch, 'elsewhere.txt')}`);
    assert.equal((await a.runTurn(outside.o).done).text, 'was refused');
    assert.ok(outside.events.some((e) => e.kind === 'log' && e.text.includes('refused edit outside')));
    assert.ok(outside.events.some((e) => e.kind === 'tool_end' && !e.ok));
  } finally {
    a.dispose();
  }
});

test('permission answers by autonomy', async () => {
  const { permissionAnswer, within } = await import('../server/agents/hermes-acp.js');
  const opts3 = [
    { optionId: 'allow_once', kind: 'allow_once' },
    { optionId: 'allow_always', kind: 'allow_always' },
    { optionId: 'deny', kind: 'reject_once' },
  ];
  const cmd = { toolCall: { kind: 'execute', title: 'rm -rf build' }, options: opts3 };
  assert.equal(permissionAnswer(cmd, 'auto', [work]).optionId, 'deny', 'a command Hermes flags needs Full access');
  assert.equal(permissionAnswer(cmd, 'full', [work]).optionId, 'allow_once', 'full: allowed, but only once');
  const rel = { toolCall: { kind: 'edit', locations: [{ path: 'src/a.ts' }] }, options: opts3 };
  assert.equal(permissionAnswer(rel, 'edits', [work]).optionId, 'allow_once', 'a relative path is inside its folder');
  const sneaky = { toolCall: { kind: 'edit', locations: [{ path: join(work, '..', 'out.txt') }] }, options: opts3 };
  assert.equal(permissionAnswer(sneaky, 'edits', [work]).optionId, 'deny');
  const noPath = { toolCall: { kind: 'edit' }, options: opts3 };
  assert.equal(permissionAnswer(noPath, 'auto', [work]).optionId, 'deny', 'an edit with no path is refused');
  assert.equal(permissionAnswer({ toolCall: { kind: 'execute' }, options: [{ optionId: 'ok', kind: 'allow_once' }] }, 'auto', [work]).optionId, undefined, 'no reject option: cancelled');
  assert.ok(within(join(work, 'a', 'b'), work));
  assert.ok(within(join(work, '..notes.txt'), work), 'a name starting with two dots is inside');
  assert.ok(!within(join(work, '..', 'x'), work));
  if (process.platform !== 'win32') {
    // On Linux a backslash is part of a name: work/a\b is one entry, not a folder a with b inside.
    const { realPath } = await import('../server/agents/hermes-acp.js');
    assert.equal(realPath(`${work}/a\\b/c.txt`), `${realPath(work)}/a\\b/c.txt`);
    assert.equal(realPath(`${work}/\\\\?\\x/c.txt`), `${realPath(work)}/\\\\?\\x/c.txt`, 'no Windows prefix stripping');
  }
  assert.ok(!within(`${work}-other`, work), 'a sibling with the same prefix is outside');
});

test("the gateway's settled reply with its reasoning block is shown once", async () => {
  const { cleanReply } = await import('../server/agents/hermes-acp.js');
  const dup = 'Created notes.txt; not committed.\n\n💭 **Reasoning:**\n```\n**Writing the text file**\n```\n\nCreated notes.txt; not committed.';
  assert.equal(cleanReply(dup), 'Created notes.txt; not committed.');
  assert.equal(cleanReply('💭 **Reasoning:**\n```\nthinking\n```\n\nOnly the reply.'), 'Only the reply.', 'nothing streamed first');
  assert.equal(cleanReply('Plain reply with ``` code ```.'), 'Plain reply with ``` code ```.');
  assert.equal(cleanReply('# API\n\n# API errors\n\nDetails'), '# API\n\n# API errors\n\nDetails', 'an ordinary reply is left alone');
});

test("the gateway's settled last chunk that repeats the streamed reply replaces it", async () => {
  const { settleReply } = await import('../server/agents/hermes-acp.js');
  // The text from the live test.
  const reply = 'The write was refused by the ACP client; no file was created.';
  const note = '⚠️ File-mutation verifier: 1 file edit(s) FAILED';
  assert.equal(settleReply(reply, `\n\n${reply}\n\n${note}`), `${reply}\n\n${note}`);
  // An ordinary reply's last chunk is only added on, even when earlier text repeats a heading.
  assert.equal(settleReply('# API\n\n# API errors', '\n\nDetails'), '# API\n\n# API errors\n\nDetails');
  assert.equal(settleReply('# API', '\n\n# API errors\n\nDetails'), '# API\n\n# API errors\n\nDetails', 'a short heading repeated');
  const long = 'The configuration loader reads tts.yaml first';
  assert.equal(settleReply(long, `\n\n${long} and then the env.`), `${long}\n\n${long} and then the env.`, 'repeated, but not up to a line break');
  // A last chunk repeating only part of what came before is not a settled reply.
  assert.equal(settleReply('One. Two.', '\n\nOne.'), 'One. Two.\n\nOne.');
  // Through the adapter, with the fake Hermes sending exactly that.
  const a = await adapter();
  try {
    assert.equal((await a.runTurn(opts('DUP').o).done).text, 'The write to escape.txt was refused by the app.\n\n⚠️ note');
  } finally {
    a.dispose();
  }
});

test('Stop cancels the running turn; the session stays usable', async () => {
  clearLog();
  const a = await adapter();
  try {
    const first = await a.runTurn(opts('hi').o).done;
    const t = a.runTurn(opts('SLOW', {}, first.sessionId).o);
    await new Promise((r) => setTimeout(r, 300));
    t.kill();
    await assert.rejects(t.done, /killed/);
    assert.ok(sent().some((m) => m.method === 'session/cancel' && m.params.sessionId === first.sessionId));
    assert.equal((await a.runTurn(opts('hi', {}, first.sessionId).o).done).text, 'hello there');
  } finally {
    a.dispose();
  }
});

test('a session Hermes no longer has fails the turn, so the app starts a fresh one', async () => {
  const a = await adapter();
  try {
    await assert.rejects(a.runTurn(opts('hi', {}, 'gone-session').o).done, /couldn't resume session gone-session/);
  } finally {
    a.dispose();
  }
});

test('after a restart the saved session is resumed and its settings sent again', async () => {
  const a = await adapter();
  const first = await a.runTurn(opts('hi', { model: 'coder-model' }).o).done;
  a.dispose();
  clearLog();
  process.env.FAKE_ACP_SESSIONS = first.sessionId; // the new Hermes still has it on disk
  const b = await adapter();
  try {
    assert.equal((await b.runTurn(opts('hi', { model: 'coder-model' }, first.sessionId).o).done).text, 'hello there');
    const m = sent().map((x) => x.method);
    assert.deepEqual(m.slice(0, 2), ['initialize', 'session/resume']);
    assert.ok(m.includes('session/set_model'), 'a resumed session gets its model again');
    const effort = sent().find((x) => x.method === 'session/set_config_option' && x.params.configId === 'reasoning_effort');
    assert.equal(effort?.params.value, 'medium', 'and the default effort, which it may have lost');
  } finally {
    delete process.env.FAKE_ACP_SESSIONS;
    b.dispose();
  }
});

test('stopping a queued turn leaves the running one alone', async () => {
  clearLog();
  const a = await adapter();
  try {
    const first = await a.runTurn(opts('hi').o).done;
    const running = a.runTurn(opts('SLOW', {}, first.sessionId).o);
    const queued = a.runTurn(opts('hi', {}, first.sessionId).o);
    await new Promise((r) => setTimeout(r, 300));
    queued.kill();
    await assert.rejects(queued.done, /killed/);
    assert.ok(!sent().some((m) => m.method === 'session/cancel'), 'the running turn was not cancelled');
    running.kill();
    await assert.rejects(running.done, /killed/);
    assert.equal((await a.runTurn(opts('hi', {}, first.sessionId).o).done).text, 'hello there', 'same Hermes still serving');
  } finally {
    a.dispose();
  }
});

test('a link inside its folder that points elsewhere does not let an edit out', async (t) => {
  const { permissionAnswer, within } = await import('../server/agents/hermes-acp.js');
  const outside = join(scratch, 'outside');
  mkdirSync(outside, { recursive: true });
  const link = join(work, 'link');
  try {
    symlinkSync(outside, link, 'junction');
  } catch {
    return t.skip('links not allowed here');
  }
  try {
    assert.ok(!within(join(link, 'new.txt'), work), 'a file to be created through the link');
    const opts3 = [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
    assert.equal(permissionAnswer({ toolCall: { kind: 'edit', locations: [{ path: join(link, 'x.txt') }] }, options: opts3 }, 'edits', [work]).optionId, 'deny');
  } finally {
    rmSync(link, { force: true, recursive: false });
  }
});

test('a link to a place that does not exist yet does not let an edit out either', async (t) => {
  const { within } = await import('../server/agents/hermes-acp.js');
  const outside = join(scratch, 'outside2');
  mkdirSync(outside, { recursive: true });
  const dirLink = join(work, 'dangling-dir');
  const fileLink = join(work, 'dangling.txt');
  let made = 0;
  try {
    symlinkSync(join(outside, 'not-yet'), dirLink, 'junction');
    made++;
    assert.ok(!within(join(dirLink, 'new.txt'), work), 'through a junction to a missing folder');
  } catch (e) {
    if (made) throw e;
  }
  try {
    symlinkSync(join(outside, 'new.txt'), fileLink, 'file');
    made++;
    assert.ok(!within(fileLink, work), 'a file link to a missing file');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; // file links need Developer Mode on Windows
  }
  for (const l of [dirLink, fileLink]) rmSync(l, { force: true });
  const loopA = join(work, 'loop-a');
  try {
    symlinkSync(join(work, 'loop-b'), loopA, 'junction');
    symlinkSync(loopA, join(work, 'loop-b'), 'junction');
    assert.ok(!within(join(loopA, 'x.txt'), work), 'a link loop counts as outside');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  } finally {
    for (const l of [loopA, join(work, 'loop-b')]) rmSync(l, { force: true });
  }
  if (!made) t.skip('links not allowed here');
});

test('Windows path forms: drive-relative and stream names refused, \\\\?\\ prefixes and short names understood', { skip: process.platform !== 'win32' }, async () => {
  const { permissionAnswer, realPath, within } = await import('../server/agents/hermes-acp.js');
  const opts3 = [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
  const ask = (path: string) => permissionAnswer({ toolCall: { kind: 'edit', locations: [{ path }] }, options: opts3 }, 'edits', [work]).optionId;
  assert.equal(ask('D:secret.txt'), 'deny', 'drive-relative');
  assert.equal(ask(`${work}\\a.txt:hidden`), 'deny', 'an NTFS stream');
  assert.equal(ask(`\\\\?\\${work}\\a.txt`), 'allow_once', 'the \\\\?\\ form of a path inside');
  assert.equal(realPath('\\\\?\\UNC\\server\\share\\x\\new.txt'), '\\\\server\\share\\x\\new.txt');
  // A short (8.3) name: C:\PROGRA~1 is C:\Program Files where the drive keeps short names.
  if (existsSync('C:\\PROGRA~1') && existsSync('C:\\Program Files')) {
    assert.ok(within('C:\\PROGRA~1\\new.txt', 'C:\\Program Files'), 'short name, new file');
    assert.ok(within('C:\\Program Files\\x', 'C:\\PROGRA~1'), 'and the other way round');
  }
});

test('".." after a link is applied where the link leads, not to the text', async (t) => {
  const { permissionAnswer, realPath, within } = await import('../server/agents/hermes-acp.js');
  const sub = join(scratch, 'outside3', 'subdir');
  mkdirSync(sub, { recursive: true });
  const hop = join(work, 'hop');
  try {
    symlinkSync(sub, hop, 'junction');
  } catch {
    return t.skip('links not allowed here');
  }
  try {
    // work/hop/../new.txt is outside3/new.txt on disk, though the text says work/new.txt.
    assert.ok(!within(`${hop}${sep}..${sep}new.txt`, work));
    // Out of a folder that doesn't exist and back into the link: still followed.
    assert.ok(!within(`${work}${sep}missing${sep}..${sep}hop${sep}secret.txt`, work), 'missing/../link');
    const opts3 = [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
    assert.equal(permissionAnswer({ toolCall: { kind: 'edit', locations: [{ path: `hop${sep}..${sep}new.txt` }] }, options: opts3 }, 'edits', [work]).optionId, 'deny', 'relative too');
    // Compared with the work folder's own real path: a temp folder may be under a short 8.3 name.
    assert.equal(realPath(join(work, 'plain', '..', 'new.txt')).toLowerCase(), join(realPath(work), 'new.txt').toLowerCase(), 'without links, .. is ordinary');
    try {
      symlinkSync(`hop${sep}..${sep}new.txt`, join(work, 'link.txt'), 'file');
      assert.ok(!within(join(work, 'link.txt'), work), 'a link whose own target goes through a link and ..');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; // file links need Developer Mode on Windows
    }
  } finally {
    for (const l of [hop, join(work, 'link.txt')]) rmSync(l, { force: true });
  }
});

test('read-only turns and "transport": "chat" use hermes chat', async () => {
  clearLog();
  const { HermesAdapter } = await import('../server/agents/hermes-acp.js');
  const a = new HermesAdapter({ id: 'h', name: 'Hermes', adapter: 'hermes', command });
  await assert.rejects(a.runTurn(opts('hi', { autonomy: 'read' }).o).done); // the fake has no `chat`
  const c = new HermesAdapter({ id: 'h', name: 'Hermes', adapter: 'hermes', command, transport: 'chat' });
  await assert.rejects(c.runTurn(opts('hi').o).done);
  assert.equal(sent().length, 0, 'no ACP Hermes was started');
});

test('config: transport only for Hermes, acp or chat', async () => {
  const { validateAgentConfigs } = await import('../server/config.js');
  const base = { id: 'h', name: 'H', adapter: 'hermes', command: 'hermes' };
  assert.equal(validateAgentConfigs([{ ...base, transport: 'chat' }])[0].transport, 'chat');
  assert.throws(() => validateAgentConfigs([{ ...base, transport: 'ssh' }]), /"acp" or "chat"/);
  assert.throws(() => validateAgentConfigs([{ ...base, adapter: 'codex', command: 'codex', transport: 'acp' }]), /Hermes program only/);
});
