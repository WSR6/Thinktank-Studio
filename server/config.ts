import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from './types.js';
import { HERMES_PROFILE } from './agents/models.js';
import { isRecord, loadJsonFile, mayWrite } from './safe-json.js';

// TTS_AGENTS_CONFIG points at another file (tests, or a second team on the same machine).
const CONFIG_PATH = process.env.TTS_AGENTS_CONFIG || fileURLToPath(new URL('../agents.config.json', import.meta.url));

/** Programs the app can drive. 'mock' is for tests only and isn't offered in Setup. */
export const ADAPTERS = ['claude', 'codex', 'grok', 'hermes', 'generic', 'mock'] as const;

function readFile(): any {
  return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
}

/** The App helper's CLI (Claude Code by default); override with a "helper" entry in agents.config.json. */
export function loadHelperConfig(): AgentConfig {
  let parsed: any = {};
  try {
    parsed = readFile();
  } catch (e) {
    // Only if the damaged file couldn't be replaced (loadAgentConfigs already reported it): default helper.
    console.error(`agents.config.json: ${(e as Error).message}; using the default App helper`);
  }
  const cfg: AgentConfig = { id: 'helper', name: 'App helper', adapter: 'claude', command: 'claude', ...parsed.helper };
  // For testing another CLI without editing the file: TTS_HELPER_ADAPTER=codex|grok (command = adapter), TTS_HELPER_MODEL.
  const env = process.env.TTS_HELPER_ADAPTER;
  if (env) Object.assign(cfg, { adapter: env, command: env, model: undefined });
  if (process.env.TTS_HELPER_MODEL) cfg.model = process.env.TTS_HELPER_MODEL;
  // A profile is passed to the CLI as an argument: only a plain Hermes profile name.
  if (typeof cfg.profile === 'string') cfg.profile = cfg.profile.trim().toLowerCase();
  if (cfg.adapter !== 'hermes' || typeof cfg.profile !== 'string' || !HERMES_PROFILE.test(cfg.profile)) delete cfg.profile;
  return cfg;
}

/** Throws a plain-language error for the first problem in an agent list. */
export function validateAgentConfigs(agents: unknown): AgentConfig[] {
  if (!Array.isArray(agents)) throw new Error('"agents" must be a list');
  if (!agents.length) throw new Error('Keep at least one agent');
  const ids = new Set<string>();
  for (const a of agents as AgentConfig[]) {
    if (!a || typeof a !== 'object') throw new Error('Each agent must be an object');
    if (!a.id || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(a.id)) throw new Error(`Invalid agent id "${a.id ?? ''}" (starts with a lowercase letter or digit; then letters, digits, - and _)`);
    if (a.id === 'user' || a.id === 'all' || a.id === 'helper') throw new Error(`"${a.id}" is reserved; pick another id`);
    if (ids.has(a.id)) throw new Error(`Two agents have the id "${a.id}"`);
    if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 40) throw new Error(`Agent "${a.id}" needs a name (up to 40 characters)`);
    if (!(ADAPTERS as readonly string[]).includes(a.adapter)) throw new Error(`Unknown program type "${a.adapter}" for "${a.id}"`);
    if (typeof a.command !== 'string' || !/^[^\s"'`;&|<>]+$/.test(a.command.trim()))
      throw new Error(`"${a.name || a.id}" needs a command: the program to run, like ${a.adapter === 'generic' ? 'aider' : a.adapter} (no spaces; put options in Extra options)`);
    if (a.args !== undefined && !(Array.isArray(a.args) && a.args.every((x) => typeof x === 'string'))) throw new Error(`Extra options for "${a.id}" must be a list of words`);
    if (a.model !== undefined && (typeof a.model !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127})?$/.test(a.model))) throw new Error(`Model id for "${a.id}": letters, digits, . _ : / [ ] - only`);
    if (a.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(a.color))) throw new Error(`Color for "${a.id}" must look like #a1b2c3`);
    if (a.autonomy && !['read', 'edits', 'auto', 'full'].includes(a.autonomy)) throw new Error(`Bad autonomy "${a.autonomy}"`);
    if (a.server !== undefined) {
      if (a.adapter !== 'codex') throw new Error(`"${a.name}": a model server works with the Codex CLI program only`);
      if (typeof a.server !== 'string' || !/^https?:\/\/[^\s"'`\\]+$/.test(a.server)) throw new Error(`Model server for "${a.name}" must look like http://192.168.1.50:1234/v1`);
      // LM Studio and Ollama show the address without /v1, but the API lives under it.
      a.server = a.server.replace(/\/+$/, '');
      if (/^https?:\/\/[^/]+$/.test(a.server)) a.server += '/v1';
      if (!a.model) throw new Error(`"${a.name}" uses a model server, so it needs a model (the name the server shows, e.g. google/gemma-4-12b-qat)`);
    }
    if (a.profile !== undefined) {
      if (a.adapter !== 'hermes') throw new Error(`"${a.name}": a profile works with the Hermes program only`);
      // Hermes profile ids are lowercase (it lowercases -p itself); store the id it uses.
      if (typeof a.profile === 'string') a.profile = a.profile.trim().toLowerCase();
      if (typeof a.profile !== 'string' || (a.profile && !HERMES_PROFILE.test(a.profile))) throw new Error(`Profile for "${a.name}": letters, digits, - and _ only (a name from \`hermes profile list\`)`);
      if (!a.profile) delete a.profile;
    }
    if (a.transport !== undefined) {
      if (a.adapter !== 'hermes') throw new Error(`"${a.name}": "transport" works with the Hermes program only`);
      if (a.transport !== 'acp' && a.transport !== 'chat') throw new Error(`"transport" for "${a.name}" must be "acp" or "chat"`);
    }
    if (a.stuckMinutes !== undefined && !(typeof a.stuckMinutes === 'number' && a.stuckMinutes >= 1 && a.stuckMinutes <= 600)) {
      throw new Error(`"Stuck warning after" for "${a.name}" must be 1 to 600 minutes`);
    }
    if (a.allowCommands && !(Array.isArray(a.allowCommands) && a.allowCommands.every((c) => /^[A-Za-z0-9._-]+$/.test(c)))) {
      throw new Error(`allowCommands for "${a.id}" must be plain command names`);
    }
    ids.add(a.id);
  }
  return agents as AgentConfig[];
}

/** The team used when agents.config.json is damaged and there's no usable .bak: the three main CLIs, their default models. */
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'claude', name: 'Claude', adapter: 'claude', command: 'claude', autonomy: 'edits', color: '#d97757' },
  { id: 'codex', name: 'Codex', adapter: 'codex', command: 'codex', autonomy: 'edits', color: '#10a37f' },
  { id: 'grok', name: 'Grok', adapter: 'grok', command: 'grok', autonomy: 'auto', color: '#8b8bf5' },
];

/**
 * The team from agents.config.json. If the file isn't valid JSON, it's moved aside (kept as
 * .corrupt-<time>) and replaced by the last saved version (.bak) when that one is good, else by
 * DEFAULT_AGENTS; onProblem gets a sentence for the user. A file that parses but has a mistake in an
 * agent still stops with that mistake, since guessing would hide it.
 */
export function loadAgentConfigs(onProblem: (text: string) => void = () => {}): AgentConfig[] {
  if (!existsSync(CONFIG_PATH)) throw new Error(`Missing ${CONFIG_PATH}`);
  const loaded = loadJsonFile<any>(CONFIG_PATH, undefined, { label: 'agents.config.json', what: 'the team was set up again', valid: isRecord });
  if (!loaded.problem) return validateAgentConfigs(loaded.value.agents ?? []);
  let recovered: { agents: AgentConfig[]; helper?: unknown };
  let from = 'the default team (Claude, Codex, Grok); add or change agents in Setup → Agents';
  try {
    const bak = JSON.parse(readFileSync(`${CONFIG_PATH}.bak`, 'utf8'));
    recovered = { ...bak, agents: validateAgentConfigs(bak.agents) };
    from = 'its last saved version (agents.config.json.bak)';
  } catch {
    recovered = { agents: DEFAULT_AGENTS.map((a) => ({ ...a })) }; // no .bak, or it's no good either
  }
  try {
    // Written only when the damaged file was kept aside (else it stays as it is; see mayWrite).
    if (mayWrite(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(recovered, null, 2) + '\n');
  } catch (e) {
    console.error(`Couldn't write ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  onProblem(`${loaded.problem.replace('the team was set up again', `the team was set up again from ${from}`)}`);
  return recovered.agents;
}

/** Saves the agent list, keeping the rest of the file (the helper entry); the old file goes to .bak. */
export function saveAgentConfigs(agents: AgentConfig[]): void {
  if (!mayWrite(CONFIG_PATH)) throw new Error("agents.config.json couldn't be read or kept aside, so it isn't saved over. Fix or delete it, then restart the app.");
  const parsed = readFile();
  parsed.agents = agents;
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n');
  renameSync(tmp, CONFIG_PATH);
}
