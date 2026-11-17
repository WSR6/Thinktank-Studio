/**
 * Stall detection for a running turn: is the agent quiet too long, stuck in a never-ending command,
 * or repeating the same tool call? Pure functions over the turn's TurnWatch; the orchestrator posts
 * the results (activity line, state push) and owns the timers.
 */
import type { AgentConfig, AgentEvent } from '../types.js';
import type { StallKind, TurnWatch } from './types.js';

/** A turn with no output for this long is flagged as possibly stuck (you choose: wait, nudge, stop). */
const STALL_QUIET_MS = Number(process.env.TTS_STALL_QUIET_MIN ?? 6) * 60_000;
/** Commands that usually never exit on their own (dev servers, watchers, apps) are flagged sooner. */
const STALL_LONG_RUNNING_MS = Number(process.env.TTS_STALL_LONGRUN_MIN ?? 2) * 60_000;
const LONG_RUNNING_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|--watch\b|\bnodemon\b|\bvite(?:\s|$)(?!.*\bbuild\b)|\bnext\s+dev\b|\belectron\s|\bhttp-server\b|\bpython3?\s+-m\s+http\.server\b|\btail\s+-f\b/i;
/** Test, build and install runs often stay quiet for many minutes: wait longer before calling them stuck. */
const STALL_SLOW_CMD_MS = Number(process.env.TTS_STALL_SLOWCMD_MIN ?? 20) * 60_000;
const SLOW_CMD_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|e2e|build|install|ci|typecheck|lint)\b|\b(?:npm|pnpm|yarn)\s+(?:i|add)\b|\b(?:pytest|vitest|jest|playwright|cargo\s+(?:build|test)|go\s+(?:build|test)|tsc|pip\s+install|uv\s+(?:sync|pip)|electron-builder|make)\b/i;
/** The same tool call this many times in a row looks like a loop. */
export const STALL_REPEAT = 4;
/** How often the watchdog checks a running turn. */
export const WATCH_TICK_MS = Math.min(15_000, STALL_QUIET_MS / 4);

/** Minutes of quiet before "may be stuck": the agent's own setting, else 30 for a model server (local models are slow), else the app default. */
export const quietMs = (c: AgentConfig) => (c.stuckMinutes ?? (c.server ? Number(process.env.TTS_STALL_SERVER_MIN ?? 30) : STALL_QUIET_MS / 60_000)) * 60_000;
const short = (s: string) => (s.length > 120 ? s.slice(0, 117) + '…' : s).replace(/\s+/g, ' ');

/** A new watch for a turn starting now. */
export function newWatch(now = Date.now()): TurnWatch {
  return { startedAt: now, lastEventAt: now, recentTools: [], texts: [], textsSinceTool: 0 };
}

/** What a stall check found: the turn looks stuck, for this reason. */
export interface StallFound {
  reason: string;
  kind: StallKind;
}

/** "Keep waiting" is in effect. */
export function snoozed(w: TurnWatch, now = Date.now()): boolean {
  return Boolean(w.snoozeUntil && now < w.snoozeUntil);
}

/**
 * Record an event from the running turn. Any output counts as progress; it also clears a stall flag
 * ('resumed'). A repeated tool call is flagged as a loop (returned, not yet set on the watch).
 */
export function noteProgress(w: TurnWatch, event: AgentEvent, now = Date.now()): 'resumed' | StallFound | undefined {
  w.lastEventAt = now;
  if (event.kind === 'tool') {
    w.lastTool = { name: event.name, detail: event.detail, at: w.lastEventAt };
    w.recentTools = [...w.recentTools, `${event.name} ${event.detail}`].slice(-STALL_REPEAT);
    w.textsSinceTool = 0;
  } else if (event.kind === 'tool_end' || (event.kind === 'log' && /^shell (?:finished|failed|declined)\b/.test(event.text))) {
    // The command finished: it's no longer "running" (Codex reports this as a log line until adapters send tool_end).
    w.lastTool = undefined;
    w.textsSinceTool = 0;
  } else if (event.kind === 'text' && event.text.trim()) {
    w.texts.push(event.text.trim());
    w.textsSinceTool++;
  }
  // A repeating call is still "output", so don't let it clear its own loop flag; and status
  // messages while a never-ending command runs don't mean it finished (only its tool_end does).
  const looping = w.recentTools.length >= STALL_REPEAT && new Set(w.recentTools).size === 1;
  const chatter = w.stall?.kind === 'longrun' && w.lastTool !== undefined && event.kind === 'text';
  if (w.stall && !looping && !chatter) {
    w.stall = undefined;
    return 'resumed';
  }
  if (!w.stall && looping && event.kind === 'tool' && !snoozed(w, now)) {
    return { reason: `ran the same command ${STALL_REPEAT} times in a row: ${short(w.recentTools[0])}`, kind: 'loop' };
  }
  return undefined;
}

/** Periodic check: quiet for too long, or quiet while running a command that never exits. */
export function checkStall(w: TurnWatch, cfg: AgentConfig, now = Date.now()): StallFound | undefined {
  if (w.stall || snoozed(w, now)) return undefined;
  const fmt = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
  // A command that usually never exits, still the last tool call: count from when it started,
  // even if the agent keeps posting "still waiting…" messages (Codex does) in the meantime.
  const cmd = w.lastTool && LONG_RUNNING_RE.test(w.lastTool.detail) ? w.lastTool : undefined;
  if (cmd) {
    const since = Math.max(cmd.at, w.snoozeUntil ? w.snoozeUntil - quietMs(cfg) : 0);
    if (now - since >= STALL_LONG_RUNNING_MS) {
      const chatter = w.textsSinceTool ? `, only posting status messages (${w.textsSinceTool})` : '';
      return { reason: `has been running ${short(`${cmd.name} ${cmd.detail}`)} for ${fmt(now - cmd.at)}${chatter} (a command that may never exit)`, kind: 'longrun' };
    }
    return undefined;
  }
  const quiet = now - w.lastEventAt;
  if (quiet < quietMs(cfg)) return undefined;
  // A test/build/install still running (lastTool clears when it ends): give it longer from when it
  // started, even if the agent posted progress or someone chose Keep waiting since, so nobody nudges
  // (and kills) a slow test run.
  if (w.lastTool && SLOW_CMD_RE.test(w.lastTool.detail) && now - w.lastTool.at < Math.max(STALL_SLOW_CMD_MS, quietMs(cfg))) return undefined;
  const running = w.lastTool && w.lastTool.at === w.lastEventAt ? w.lastTool : undefined;
  const what = running ? `, running ${short(`${running.name} ${running.detail}`)}` : '';
  return { reason: `has been quiet for ${fmt(quiet)}${what}`, kind: 'quiet' };
}

/** "Keep waiting": clear the flag and ask again after another full quiet period (or loop), counted from now. */
export function snooze(w: TurnWatch, cfg: AgentConfig, now = Date.now()): void {
  w.stall = undefined;
  w.snoozeUntil = now + quietMs(cfg);
  w.lastEventAt = now;
  w.recentTools = [];
}
