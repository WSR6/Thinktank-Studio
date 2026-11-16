import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from './types.js';

// TTS_AGENTS_CONFIG points at another file (tests, or a second team on the same machine).
const CONFIG_PATH = process.env.TTS_AGENTS_CONFIG || fileURLToPath(new URL('../agents.config.json', import.meta.url));

/** Programs the app can drive. 'mock' is for tests only and isn't offered in Setup. */
export const ADAPTERS = ['claude', 'codex', 'grok', 'hermes', 'generic', 'mock'] as const;

function readFile(): any {
  return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
}

/** The App helper's CLI (Claude Code by default); override with a "helper" entry in agents.config.json. */
export function loadHelperConfig(): AgentConfig {
  const parsed = readFile();
  const cfg: AgentConfig = { id: 'helper', name: 'App helper', adapter: 'claude', command: 'claude', ...parsed.helper };
  // For testing another CLI without editing the file: TTS_HELPER_ADAPTER=codex|grok (command = adapter), TTS_HELPER_MODEL.
  const env = process.env.TTS_HELPER_ADAPTER;
  if (env) Object.assign(cfg, { adapter: env, command: env, model: undefined });
  if (process.env.TTS_HELPER_MODEL) cfg.model = process.env.TTS_HELPER_MODEL;
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

export function loadAgentConfigs(): AgentConfig[] {
  if (!existsSync(CONFIG_PATH)) throw new Error(`Missing ${CONFIG_PATH}`);
  return validateAgentConfigs(readFile().agents ?? []);
}

/** Saves the agent list, keeping the rest of the file (the helper entry); the old file goes to .bak. */
export function saveAgentConfigs(agents: AgentConfig[]): void {
  const parsed = readFile();
  parsed.agents = agents;
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n');
  renameSync(tmp, CONFIG_PATH);
}
