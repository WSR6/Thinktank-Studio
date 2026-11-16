import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LimitWindow } from './types.js';

/**
 * Plan usage windows per CLI (5-hour and weekly), as each CLI last reported them. They belong to the
 * account, not a project, so they're kept in ~/.thinktank/plan-limits.json and survive a restart.
 * Everything here is display-only: any error means "no update", never a failed turn.
 */
export interface PlanLimits {
  windows: LimitWindow[];
  /** When the CLI reported them (epoch ms). */
  at: number;
}

const FILE = join(homedir(), '.thinktank', 'plan-limits.json');
let cache: Record<string, PlanLimits> | undefined;

function load(): Record<string, PlanLimits> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  // First run: take Codex's numbers from its newest session file, in the background.
  if (!cache!.codex) void codexLimits().then((l) => l && !cache!.codex && (cache!.codex = l));
  return cache!;
}

/** The last reported windows for a CLI kind (claude, codex, grok…), with windows that have reset shown as 0%. */
export function getLimits(kind: string): PlanLimits | null {
  const l = load()[kind];
  if (!l) return null;
  const now = Date.now();
  return { at: l.at, windows: l.windows.map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPct: 0, resetsAt: 0 } : w)) };
}

export function setLimits(kind: string, windows: LimitWindow[]): void {
  if (!windows.length) return;
  load()[kind] = { windows, at: Date.now() };
  try {
    mkdirSync(join(homedir(), '.thinktank'), { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch {
    /* display only; losing it is harmless */
  }
}

const windowName = (minutes: number) => (minutes === 300 ? '5h' : minutes === 10080 ? 'week' : `${minutes}m`);

/** Claude's `rate_limit_event` (stream-json): unifiedWindows.{five_hour,seven_day}.{utilization 0–1, resetsAt s}. */
export function claudeWindows(info: any): LimitWindow[] {
  const names: Record<string, string> = { five_hour: '5h', seven_day: 'week' };
  return Object.entries(info?.unifiedWindows ?? {})
    .filter(([, w]: [string, any]) => typeof w?.utilization === 'number')
    .map(([k, w]: [string, any]) => ({
      name: names[k] ?? k.replaceAll('_', ' '),
      usedPct: Math.round(w.utilization * 100),
      resetsAt: (Number(w.resetsAt) || 0) * 1000,
    }));
}

/** Codex's `rate_limits` (session file token_count): primary/secondary.{used_percent, window_minutes, resets_at s}. */
export function codexWindows(rl: any): LimitWindow[] {
  return [rl?.primary, rl?.secondary]
    .filter((w) => typeof w?.used_percent === 'number')
    .map((w) => ({ name: windowName(w.window_minutes), usedPct: Math.round(w.used_percent), resetsAt: (Number(w.resets_at) || 0) * 1000 }));
}

/** Only the end of a session file is read: they hold every tool result and can be very large. */
const TAIL_BYTES = 256 * 1024;
/** Thread id → its session file, so a long-lived thread is found once. */
const sessionPaths = new Map<string, string>();

/**
 * Codex doesn't put rate limits in `exec --json` output, but its session file has them on every
 * token_count. Reads the file for `threadId`, or the newest session file when there's none.
 */
export async function codexLimits(threadId?: string): Promise<PlanLimits | undefined> {
  try {
    const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    const file = threadId ? await findThreadFile(root, threadId) : await newestSessionFile(root);
    if (!file) return undefined;
    const fh = await open(file, 'r');
    let text: string;
    let mtime: number;
    try {
      const { size, mtimeMs } = await fh.stat();
      mtime = mtimeMs;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const ev = JSON.parse(lines[i]);
        const windows = codexWindows(ev.payload?.rate_limits ?? ev.rate_limits);
        if (windows.length) return { windows, at: mtime };
      } catch {
        /* the first line of the tail may be cut off; keep looking */
      }
    }
  } catch {
    /* display only */
  }
  return undefined;
}

const newestFirst = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();

/** sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl. A resumed thread stays in the folder of the day it began, so look through every day. */
async function findThreadFile(root: string, threadId: string): Promise<string | undefined> {
  const known = sessionPaths.get(threadId);
  if (known && (await stat(known).catch(() => null))) return known;
  for (const y of await newestFirst(root))
    for (const m of await newestFirst(join(root, y)))
      for (const d of await newestFirst(join(root, y, m))) {
        const hit = (await newestFirst(join(root, y, m, d))).find((f) => f.endsWith(`${threadId}.jsonl`));
        if (hit) {
          const path = join(root, y, m, d, hit);
          sessionPaths.set(threadId, path);
          return path;
        }
      }
  return undefined;
}

/** The most recently written session file in the newest day folder that has one (startup only). */
async function newestSessionFile(root: string): Promise<string | undefined> {
  let days = 0;
  for (const y of await newestFirst(root))
    for (const m of await newestFirst(join(root, y)))
      for (const d of await newestFirst(join(root, y, m))) {
        if (++days > 7) return undefined;
        const dir = join(root, y, m, d);
        const files = (await newestFirst(dir)).filter((f) => f.endsWith('.jsonl'));
        const stamped = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? -1 })));
        const best = stamped.filter((s) => s.t >= 0).sort((a, b) => b.t - a.t)[0];
        if (best) return join(dir, best.f);
      }
  return undefined;
}
