import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterKind } from '../types.js';
import { CATALOG } from './catalog.js';

/**
 * Model and effort choices for the pickers, read from the model list each CLI keeps on disk
 * (refreshed by the CLI itself), so a CLI update that adds a model shows up without an app change.
 * Falls back to the built-in CATALOG when the file is missing or unreadable.
 */
export interface ModelInfo {
  id: string;
  /** Display name from the CLI, when it gives one. */
  label?: string;
  /** Efforts this model accepts; a turn with any other effort fails. */
  efforts: string[];
  defaultEffort?: string;
  /** Not offered in the picker, but kept so a hand-typed id still gets its effort limits. */
  hidden?: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  /** Efforts for a model id that isn't in `models` (typed by hand). */
  efforts: string[];
  /** What the CLI uses when the app passes no model / effort. */
  cliDefaultModel?: string;
  cliDefaultEffort?: string;
  source: 'cli' | 'built-in';
}

const cache = new Map<string, { mtime: number; value: unknown }>();

/** Parse a file once per change (mtime), so state() can call this freely. */
function cached<T>(path: string, parse: (text: string) => T): T | undefined {
  try {
    const mtime = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtime === mtime) return hit.value as T;
    const value = parse(readFileSync(path, 'utf8'));
    cache.set(path, { mtime, value });
    return value;
  } catch {
    return undefined; // no such file or not parseable: the CLI's built-in model list is used
  }
}

/** A `key = "value"` from a TOML file: top level by default, or inside `[section]`. */
function tomlValue(path: string, key: string, section = ''): string | undefined {
  const values = cached(path, (t) => {
    const out = new Map<string, string>();
    let current = '';
    for (const line of t.split(/\r?\n/)) {
      const head = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (head) current = head[1].trim();
      const kv = line.match(/^\s*([\w.-]+)\s*=\s*"([^"]*)"/);
      if (kv) out.set(`${current}\n${kv[1]}`, kv[2]);
    }
    return out;
  });
  return values?.get(`${section}\n${key}`);
}

function codex(): ModelCatalog | undefined {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const models = cached(join(home, 'models_cache.json'), (t): ModelInfo[] =>
    (JSON.parse(t).models ?? [])
      .filter((m: any) => m?.slug)
      .map((m: any) => ({
        id: m.slug,
        label: m.display_name,
        efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level,
        hidden: m.visibility !== 'list',
      })),
  );
  if (!models?.some((m) => !m.hidden)) return undefined;
  const config = join(home, 'config.toml');
  return {
    models,
    efforts: union(models),
    cliDefaultModel: tomlValue(config, 'model') ?? models.find((m) => !m.hidden)!.id,
    cliDefaultEffort: tomlValue(config, 'model_reasoning_effort'),
    source: 'cli',
  };
}

function grok(): ModelCatalog | undefined {
  const home = process.env.GROK_HOME || join(homedir(), '.grok');
  const models = cached(join(home, 'models_cache.json'), (t): ModelInfo[] =>
    Object.values<any>(JSON.parse(t).models ?? {})
      .map((m) => m?.info)
      .filter((i) => i?.id)
      .map((i) => {
        const efforts = (i.reasoning_efforts ?? []).filter((e: any) => e?.value);
        return {
          id: i.id,
          label: i.name,
          // Grok lists them high to low; show every CLI low to high.
          efforts: efforts.map((e: any) => e.value).reverse(),
          defaultEffort: efforts.find((e: any) => e.default)?.value ?? i.reasoning_effort,
          hidden: Boolean(i.hidden),
        };
      }),
  );
  if (!models?.some((m) => !m.hidden)) return undefined;
  // Grok's own precedence: env var, then [models] in config.toml, then the server-sent default.
  const config = join(home, 'config.toml');
  const settings = cached(join(home, 'settings_cache.json'), (t) => JSON.parse(JSON.parse(t).payload ?? '{}')?.settings);
  return {
    models,
    efforts: union(models),
    cliDefaultModel:
      process.env.GROK_DEFAULT_MODEL || tomlValue(config, 'default', 'models') || settings?.default_model || models.find((m) => !m.hidden)!.id,
    cliDefaultEffort: tomlValue(config, 'default_reasoning_effort', 'models'),
    source: 'cli',
  };
}

/** Hermes keeps each provider's model list in provider_models_cache.json; offer the configured provider's. */
function hermes(): ModelCatalog | undefined {
  const home =
    process.env.HERMES_HOME ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes') : join(homedir(), '.hermes'));
  const config = cached(join(home, 'config.yaml'), (t) => {
    const block = t.match(/^model:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m)?.[1] ?? '';
    const val = (k: string) => block.match(new RegExp(`^[ \\t]+${k}:[ \\t]*["']?([^"'\\r\\n#]+?)["']?[ \\t]*$`, 'm'))?.[1];
    const effort = t.match(/^[ \t]+reasoning_effort:[ \t]*["']?(\w+)/m)?.[1];
    return { model: val('default'), provider: val('provider'), effort };
  });
  const efforts = CATALOG.hermes!.efforts;
  const lists = cached(join(home, 'provider_models_cache.json'), (t) => JSON.parse(t) as Record<string, { models?: string[] }>);
  const ids = (config?.provider && lists?.[config.provider]?.models) || [];
  if (!ids.length) {
    return config?.model ? { models: [{ id: config.model, efforts }], efforts, cliDefaultModel: config.model, cliDefaultEffort: config.effort, source: 'cli' } : undefined;
  }
  return { models: ids.map((id) => ({ id, efforts })), efforts, cliDefaultModel: config?.model ?? ids[0], cliDefaultEffort: config?.effort, source: 'cli' };
}

function union(models: ModelInfo[]): string[] {
  return [...new Set(models.flatMap((m) => m.efforts))];
}

function builtIn(kind: AdapterKind): ModelCatalog | undefined {
  const c = CATALOG[kind];
  if (!c) return undefined;
  return { models: c.models.map((id) => ({ id, efforts: c.modelEfforts?.[id] ?? c.efforts })), efforts: c.efforts, source: 'built-in' };
}

/** Model lists read from model servers (GET <server>/models), refreshed in the background at most once a minute. */
const serverLists = new Map<string, { at: number; ids?: string[] }>();
/** Context length each loaded model was loaded with, when the server says (LM Studio does). */
const serverContexts = new Map<string, Map<string, number>>();

/**
 * LM Studio's own API (beside /v1) tells how big a context each loaded model has; other servers don't
 * have it. A failed or unreadable answer keeps what was known.
 */
const contextSeq = new Map<string, number>();
/** Newest lookup whose answer was stored: an older one finishing later can't overwrite it, a newer one can. */
const contextApplied = new Map<string, number>();
async function fetchContexts(url: string): Promise<void> {
  const seq = (contextSeq.get(url) ?? 0) + 1;
  contextSeq.set(url, seq);
  try {
    const r = await fetch(`${url.replace(/\/v1$/, '')}/api/v0/models`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return;
    const j: any = await r.json();
    if (!Array.isArray(j?.data)) return;
    const ctx = new Map<string, number>();
    for (const m of j.data) if (typeof m?.id === 'string' && Number(m.loaded_context_length) > 0) ctx.set(m.id, Number(m.loaded_context_length));
    if (seq > (contextApplied.get(url) ?? 0)) {
      contextApplied.set(url, seq);
      serverContexts.set(url, ctx);
    }
  } catch {
    // Not LM Studio, or not reachable: keep the last answer.
  }
}

/** Right before a turn: ask the server again, so a model loaded (or reloaded with another context) a moment ago counts. */
export async function refreshServerContext(server: string): Promise<void> {
  await fetchContexts(server.replace(/\/+$/, ''));
}

/** The context window a model server's model is loaded with, if the server reports it. */
export function serverContext(server: string, model: string): number | undefined {
  return serverContexts.get(server.replace(/\/+$/, ''))?.get(model);
}
let onServerModels: () => void = () => {};
/** Called when a model server's list changes, so the app can push the new picker choices. */
export function onServerModelsChanged(fn: () => void): void {
  onServerModels = fn;
}

function serverCatalog(server: string): ModelCatalog {
  const url = server.replace(/\/+$/, '');
  const hit = serverLists.get(url);
  if (!hit || Date.now() - hit.at > 60_000) {
    serverLists.set(url, { at: Date.now(), ids: hit?.ids });
    void fetch(`${url}/models`, { signal: AbortSignal.timeout(5_000) })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((j: any) => {
        // Embedding models can't chat; leave them out of the picker.
        const ids = (j?.data ?? []).map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === 'string' && !/embed/i.test(id));
        if (!Array.isArray(j?.data)) return;
        const changed = JSON.stringify(ids) !== JSON.stringify(serverLists.get(url)?.ids);
        serverLists.set(url, { at: Date.now(), ids });
        if (changed) onServerModels();
      })
      .catch(() => undefined); // server not reachable right now: keep the last list it gave
    void fetchContexts(url);
  }
  // Reasoning on/off is the server's own setting, so no effort picker.
  return { models: (serverLists.get(url)?.ids ?? []).map((id) => ({ id, efforts: [] })), efforts: [], source: 'cli' };
}

/** The pickers' choices: a model server's own list for an agent that uses one, else the CLI's. */
export function modelCatalog(kind: AdapterKind, server?: string): ModelCatalog | undefined {
  if (server) return serverCatalog(server);
  const live = kind === 'codex' ? codex() : kind === 'grok' ? grok() : kind === 'hermes' ? hermes() : undefined;
  return live ?? builtIn(kind);
}

/**
 * Make sure the effort is one the model accepts (any other fails the turn). An empty effort is
 * pinned too when the CLI's own default effort wouldn't fit. Unknown models are left alone.
 */
export function fitEffort(kind: AdapterKind, model: string, effort: string, preferred?: string): string {
  const cat = modelCatalog(kind);
  const m = cat?.models.find((x) => x.id === (model || cat.cliDefaultModel));
  if (!m?.efforts.length) return effort;
  const wanted = effort || cat?.cliDefaultEffort;
  if (!wanted || m.efforts.includes(wanted)) return effort;
  if (preferred && m.efforts.includes(preferred)) return preferred;
  return m.defaultEffort && m.efforts.includes(m.defaultEffort) ? m.defaultEffort : m.efforts[0];
}

/** The model and effort a turn will really run with, for the agent's own prompt and the activity log. */
export function effectiveModel(kind: AdapterKind, model: string, effort: string, server?: string): { model: string; effort: string } {
  if (server) return { model: model || 'server default', effort: 'set on the model server' };
  const cat = modelCatalog(kind);
  const m = model || cat?.cliDefaultModel || '';
  const e = effort || cat?.cliDefaultEffort || cat?.models.find((x) => x.id === m)?.defaultEffort || '';
  return { model: m || 'CLI default', effort: e || 'CLI default' };
}
