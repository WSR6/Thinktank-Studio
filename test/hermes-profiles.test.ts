import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Orchestrator } from '../server/orchestrator.js';
import type { AgentConfig } from '../server/types.js';

/**
 * Hermes profiles: listing them, each profile's own models, the config checks, and switching an
 * agent's profile. A fake Hermes folder (HERMES_HOME) with a "coder" and a "writer" profile.
 */

const scratch = mkdtempSync(join(tmpdir(), 'tts-hermes-profiles-'));
const root = join(scratch, 'hermes');
const saved: Record<string, string | undefined> = {};
let orch: Orchestrator;

const config = (model: string, provider = 'openrouter') => `model:\n  default: ${model}\n  provider: ${provider}\n`;

before(async () => {
  mkdirSync(join(root, 'profiles', 'coder'), { recursive: true });
  mkdirSync(join(root, 'profiles', 'writer'), { recursive: true });
  mkdirSync(join(root, 'profiles', '.trash'), { recursive: true });
  mkdirSync(join(root, 'profiles', 'bad name'), { recursive: true });
  // Not profiles: a folder with no profile files, and a name Hermes would never use (ids are lowercase).
  mkdirSync(join(root, 'profiles', 'logs'), { recursive: true });
  mkdirSync(join(root, 'profiles', 'Upper'), { recursive: true });
  writeFileSync(join(root, 'profiles', 'Upper', 'config.yaml'), config('x'));
  writeFileSync(join(root, 'config.yaml'), config('grok-4.7', 'xai'));
  writeFileSync(join(root, 'profiles', 'coder', 'config.yaml'), config('qwen3-coder'));
  writeFileSync(join(root, 'profiles', 'writer', 'config.yaml'), config('claude-sonnet'));
  // Only the main folder has the model-list cache; profiles fall back to it.
  writeFileSync(join(root, 'provider_models_cache.json'), JSON.stringify({ openrouter: { models: ['qwen3-coder', 'claude-sonnet'] }, xai: { models: ['grok-4.7'] } }));
  const env = { HERMES_HOME: root, TTS_PROJECTS_DIR: join(scratch, 'projects'), HOME: scratch, USERPROFILE: scratch };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { Orchestrator } = await import('../server/orchestrator.js');
  const hermes: AgentConfig = { id: 'herm', name: 'Herm', adapter: 'hermes', command: 'hermes', profile: 'coder', model: 'qwen3-coder' };
  orch = new Orchestrator([hermes], true);
  await orch.open('hermes-profiles-test', true);
});

after(async () => {
  orch?.stopAll();
  (orch as unknown as { watcher?: { close(): void } })?.watcher?.close();
  await new Promise((r) => setTimeout(r, 200));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('profiles: default first, then real profile folders only', async () => {
  const { hermesProfiles } = await import('../server/agents/models.js');
  assert.deepEqual(hermesProfiles(root, root), { names: ['default', 'coder', 'writer'], active: 'default' });
  writeFileSync(join(root, 'active_profile'), 'writer\n');
  assert.equal(hermesProfiles(root, root).active, 'writer');
  rmSync(join(root, 'active_profile'));
});

test('a deleted sticky profile is named as missing, never passed off as default', async () => {
  const { hermesProfiles } = await import('../server/agents/models.js');
  writeFileSync(join(root, 'active_profile'), 'gone');
  assert.deepEqual(hermesProfiles(root, root), { names: ['default', 'coder', 'writer'], active: 'gone', activeMissing: true });
  rmSync(join(root, 'active_profile'));
});

test('HERMES_HOME naming a profile folder is what a run with no -p uses, whatever is sticky', async () => {
  const { hermesProfiles } = await import('../server/agents/models.js');
  writeFileSync(join(root, 'active_profile'), 'writer');
  assert.equal(hermesProfiles(root, join(root, 'profiles', 'coder')).active, 'coder');
  assert.equal(hermesProfiles(root, join(root, 'profiles', 'Coder')).active, 'coder', 'the id, whatever the spelling of the path');
  rmSync(join(root, 'active_profile'));
});

test('a profile Hermes marked deleted is not offered', async () => {
  const { hermesProfiles } = await import('../server/agents/models.js');
  mkdirSync(join(root, 'profiles', '.deleted'), { recursive: true });
  writeFileSync(join(root, 'profiles', '.deleted', 'writer'), '');
  writeFileSync(join(root, 'active_profile'), 'writer');
  assert.deepEqual(hermesProfiles(root, root), { names: ['default', 'coder'], active: 'writer', activeMissing: true });
  rmSync(join(root, 'profiles', '.deleted'), { recursive: true });
  rmSync(join(root, 'active_profile'));
});

test('with the active profile gone and no readable config, the picker still gets the profiles', async () => {
  const { modelCatalog } = await import('../server/agents/models.js');
  const lone = mkdtempSync(join(scratch, 'lone-'));
  writeFileSync(join(lone, 'active_profile'), 'writer');
  const saved = process.env.HERMES_HOME;
  process.env.HERMES_HOME = lone;
  try {
    const cat = modelCatalog('hermes')!;
    assert.deepEqual(cat.profiles, ['default']);
    assert.equal(cat.activeProfile, 'writer');
    assert.equal(cat.activeMissing, true);
  } finally {
    process.env.HERMES_HOME = saved;
  }
});

test("each profile's catalog has its own default model, and lists the profiles", async () => {
  const { modelCatalog } = await import('../server/agents/models.js');
  const coder = modelCatalog('hermes', undefined, 'coder')!;
  assert.equal(coder.cliDefaultModel, 'qwen3-coder');
  assert.deepEqual(coder.models.map((m) => m.id), ['qwen3-coder', 'claude-sonnet']);
  assert.deepEqual(coder.profiles, ['default', 'coder', 'writer']);
  assert.equal(modelCatalog('hermes', undefined, 'default')!.cliDefaultModel, 'grok-4.7');
  // No profile picked: the sticky one, or the main folder.
  assert.equal(modelCatalog('hermes')!.cliDefaultModel, 'grok-4.7');
  writeFileSync(join(root, 'active_profile'), 'writer');
  assert.equal(modelCatalog('hermes')!.cliDefaultModel, 'claude-sonnet');
  rmSync(join(root, 'active_profile'));
  assert.equal(modelCatalog('codex')?.profiles, undefined);
});

test('config: a profile only for Hermes, and only a plain name', async () => {
  const { validateAgentConfigs } = await import('../server/config.js');
  const base = { id: 'h', name: 'H', adapter: 'hermes', command: 'hermes' };
  assert.equal(validateAgentConfigs([{ ...base, profile: 'coder' }])[0].profile, 'coder');
  assert.equal(validateAgentConfigs([{ ...base, profile: '' }])[0].profile, undefined);
  assert.equal(validateAgentConfigs([{ ...base, profile: 'Coder' }])[0].profile, 'coder', 'stored as the lowercase id Hermes uses');
  assert.throws(() => validateAgentConfigs([{ ...base, profile: '-p evil' }]), /letters, digits/);
  assert.throws(() => validateAgentConfigs([{ ...base, adapter: 'codex', command: 'codex', profile: 'coder' }]), /Hermes program only/);
});

type Inside = {
  agents: Map<string, { sessionId?: string; turnProfile?: string }>;
  emitAgent(id: string, e: { kind: 'session'; id: string }): void;
  saveMeta(): void;
};
const inside = (o: Orchestrator) => o as unknown as Inside;
const agentOf = (o: Orchestrator) => o.state().agents.find((a) => a.id === 'herm')!;

test("switching profile: the new profile's own defaults, not the configured profile's, and a new session", () => {
  const agent = () => agentOf(orch);
  const runtime = inside(orch).agents.get('herm')!;
  assert.equal(agent().settings.profile, 'coder', 'starts on the profile from agents.config.json');
  assert.equal(agent().settings.model, 'qwen3-coder');
  assert.equal(agent().defaults.model, 'qwen3-coder');

  runtime.sessionId = 'old-session';
  orch.setSettings('herm', { profile: 'writer' });
  assert.equal(agent().settings.profile, 'writer');
  assert.equal(agent().settings.model, '', "writer's own default, not the configured coder model");
  assert.equal(agent().defaults.model, '', 'so the picker offers "profile default"');
  assert.equal(runtime.sessionId, undefined);
  assert.equal(agent().catalog?.cliDefaultModel, 'claude-sonnet');

  // "Default" picked on writer stays writer's default.
  orch.setSettings('herm', { model: 'qwen3-coder' });
  orch.setSettings('herm', { model: '' });
  assert.equal(agent().settings.model, '');

  // The same profile again changes nothing; back on the configured profile, its configured model returns.
  orch.setSettings('herm', { model: 'qwen3-coder' });
  runtime.sessionId = 'kept';
  orch.setSettings('herm', { profile: 'writer' });
  assert.equal(agent().settings.model, 'qwen3-coder');
  assert.equal(runtime.sessionId, 'kept');
  orch.setSettings('herm', { profile: 'Coder' });
  assert.equal(agent().settings.profile, 'coder', 'stored lowercase');
  assert.equal(agent().settings.model, 'qwen3-coder');

  assert.throws(() => orch.setSettings('herm', { profile: '../x' }), /Profile/);
});

test("a turn started on the old profile can't hand its session to the new one", () => {
  const runtime = inside(orch).agents.get('herm')!;
  orch.setSettings('herm', { profile: 'coder' });
  runtime.turnProfile = 'coder'; // a turn is running as coder
  orch.setSettings('herm', { profile: 'writer' }); // switched meanwhile
  inside(orch).emitAgent('herm', { kind: 'session', id: 'coder-session' });
  assert.equal(runtime.sessionId, undefined);
  runtime.turnProfile = 'writer'; // the next turn, as writer
  inside(orch).emitAgent('herm', { kind: 'session', id: 'writer-session' });
  assert.equal(runtime.sessionId, 'writer-session');
});

test("reopening keeps the project's profile with its own default model", async () => {
  orch.setSettings('herm', { profile: 'writer' });
  assert.equal(agentOf(orch).settings.model, '');
  inside(orch).saveMeta();
  await new Promise((r) => setTimeout(r, 500)); // let the save land
  const { Orchestrator } = await import('../server/orchestrator.js');
  const again = new Orchestrator([{ id: 'herm', name: 'Herm', adapter: 'hermes', command: 'hermes', profile: 'coder', model: 'qwen3-coder' }], true);
  try {
    await again.open('hermes-profiles-test', false);
    assert.equal(agentOf(again).settings.profile, 'writer');
    assert.equal(agentOf(again).settings.model, '', 'not the configured coder model');
  } finally {
    again.stopAll();
    (again as unknown as { watcher?: { close(): void } }).watcher?.close();
  }
});
