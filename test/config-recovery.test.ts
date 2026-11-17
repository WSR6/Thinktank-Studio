import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/** A damaged agents.config.json: kept aside, replaced by the .bak or the default team, and reported. */

const dir = mkdtempSync(join(tmpdir(), 'tts-config-'));
const file = join(dir, 'agents.config.json');
let config: typeof import('../server/config.js');
const saved = process.env.TTS_AGENTS_CONFIG;

before(async () => {
  process.env.TTS_AGENTS_CONFIG = file; // read when the module loads
  config = await import('../server/config.js');
});
after(() => {
  if (saved === undefined) delete process.env.TTS_AGENTS_CONFIG;
  else process.env.TTS_AGENTS_CONFIG = saved;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const copies = () => readdirSync(dir).filter((f) => f.startsWith('agents.config.json.corrupt-'));
const one = { id: 'solo', name: 'Solo', adapter: 'mock', command: 'mock' };

test('a good file loads as before', () => {
  writeFileSync(file, JSON.stringify({ agents: [one] }));
  const told: string[] = [];
  assert.deepEqual(config.loadAgentConfigs((t) => told.push(t)).map((a) => a.id), ['solo']);
  assert.deepEqual(told, []);
});

test('damaged with a good .bak: the .bak comes back (helper entry too)', () => {
  writeFileSync(`${file}.bak`, JSON.stringify({ agents: [one], helper: { adapter: 'codex' } }));
  writeFileSync(file, '{"agents": [');
  const told: string[] = [];
  assert.deepEqual(config.loadAgentConfigs((t) => told.push(t)).map((a) => a.id), ['solo']);
  assert.equal(copies().length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).helper, { adapter: 'codex' });
  assert.match(told[0], /agents\.config\.json was damaged .*last saved version \(agents\.config\.json\.bak\).*kept as agents\.config\.json\.corrupt-/);
});

test('damaged with no usable .bak: the default team, written back so Setup can save over it', () => {
  rmSync(`${file}.bak`);
  writeFileSync(file, 'not json at all');
  const told: string[] = [];
  const agents = config.loadAgentConfigs((t) => told.push(t));
  assert.deepEqual(agents.map((a) => a.id), ['claude', 'codex', 'grok']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).agents.map((a: { id: string }) => a.id), ['claude', 'codex', 'grok']);
  assert.match(told[0], /default team/);
});

test('a file that parses but has a mistake still stops with that mistake', () => {
  writeFileSync(file, JSON.stringify({ agents: [{ ...one, id: 'Bad Id' }] }));
  assert.throws(() => config.loadAgentConfigs(), /Invalid agent id/);
});
