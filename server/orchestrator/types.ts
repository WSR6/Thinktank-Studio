/** The orchestrator's internal records (agents at runtime, tasks, questions, turn plans) and its limits. */
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSettings, AgentStatus, Turn } from '../types.js';

// ── Limits and timings ────────────────────────────────────────────────

/** Max agent→agent @mention hand-offs before control returns to the user. */
export const MAX_AUTO_HOPS = 6;
/** The helper may restart a cut chain this many times before it needs your say. */
export const MAX_CHAIN_RESTARTS = 3;
/** Messages resent to agents that can't resume their own session. */
export const HISTORY_WINDOW = 40;
/** How long tasks.json may stay unparseable (an agent mid-rewrite) before the user is told. */
export const TASKS_PARSE_GRACE_MS = 5_000;
/** Last-resort cap on one turn. Stalls are caught much earlier by the watchdog (see stall.ts). */
export const TURN_TIMEOUT_MS = Number(process.env.TTS_TURN_TIMEOUT_MIN ?? 120) * 60_000;
/** Autopilot: max continuation turns per agent per run, and consecutive no-progress turns before pausing. */
export const AUTOPILOT_MAX_TURNS = Number(process.env.TTS_AUTOPILOT_MAX_TURNS ?? 20);
export const AUTOPILOT_IDLE_LIMIT = 2;
/** How long the App helper's "Run now" for desktop tests counts down (you can Cancel) before the mouse moves. */
export const DESKTOP_COUNTDOWN_MS = Number(process.env.TTS_DESKTOP_COUNTDOWN_S ?? 20) * 1000;
/** Plan-phase discussion: after the first answers, up to this many rounds total; stops early when everyone passes. */
export const MAX_DISCUSSION_ROUNDS = Number(process.env.TTS_DISCUSSION_ROUNDS ?? 3);
/** Private agent-to-agent messages allowed per message from you, so two agents can't chat forever. */
export const MAX_AGENT_DMS = 4;
/** Questions between agents allowed per message from you, and how long one waits for its answer. */
export const MAX_ASKS = 4;
export const ASK_TIMEOUT_MS = Number(process.env.TTS_ASK_TIMEOUT_MIN ?? 15) * 60_000;
/** Activity lines kept per agent (memory and reload history). */
export const ACTIVITY_KEEP = 500;
/** askedAt while a review request is still being prepared: no turn counts as the review yet. */
export const NOT_ASKED_YET = Number.MAX_SAFE_INTEGER;
/** "Out until you click Try now": a limit message with no reset time (e.g. Grok's "try again later"). */
export const OUT_OPEN = 8.64e15;

// ── Records ───────────────────────────────────────────────────────────

export interface TurnPlan {
  /** Extra instruction appended to this turn's prompt (debate rounds). */
  instruction?: string;
  /** Hide other agents' messages at or after this index (independent debate proposals). */
  hideAgentsFrom?: number;
  /** More folders the agent may write this turn (e.g. the review checkout it tests in). */
  extraDirs?: string[];
  /** Run even if the agent is out of usage (you messaged it directly). Never overrides "switched off". */
  force?: boolean;
  /** Work that must not be lost while the agent is away (a send-back): kept and given to it when it's back. */
  keepIfAway?: boolean;
  /** Reply to the room even if the last message to it was private (resuming after an answered question). */
  public?: boolean;
  /** This turn answers that question: its reply goes back to the asker. */
  askId?: string;
  /** The turn is only about this task (a send-back): it's dropped if the task is accepted before it starts. */
  forTask?: string;
}

/**
 * A standalone job outside the agent's normal conversation (the merge arbiter): runs in its own
 * folder, with no chat history and no session resume, then reports back through onDone.
 */
export interface OneShot {
  instruction: string;
  cwd: string;
  extraDirs: string[];
  onDone: (ok: boolean, text: string) => Promise<void>;
  /** Always runs afterwards, even if the project was switched meanwhile (e.g. remove a temp worktree). */
  cleanup?: () => Promise<void>;
}

/** A question one agent asked another and is waiting on. */
export interface Ask {
  id: string;
  from: string;
  to: string;
  question: string;
  /** When it was asked. */
  at: number;
  /** queued: waits until the target's current question is settled; open: sent, waiting for the answer. */
  status: 'queued' | 'open' | 'answered' | 'expired' | 'failed';
  /** The asker's stop counter when it asked: if you stop the asker, no answer restarts it. */
  askerStop: number;
  /** The target asked someone else before answering; its next turn still owes this answer. */
  nested?: boolean;
  timer?: NodeJS.Timeout;
}

/** Running per-agent usage. Turns without a reported cost are counted so the UI can flag the total as partial. */
export interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  unpricedTurns: number;
}

export const emptyTotals = (): UsageTotals => ({ turns: 0, input: 0, output: 0, cached: 0, costUsd: 0, unpricedTurns: 0 });

export interface ActivityLine {
  ts: number;
  kind: AgentEvent['kind'];
  text: string;
}

export interface Task {
  id: string;
  title?: string;
  owner?: string;
  status?: string;
  note?: string;
  /** Paths this task owns, e.g. ["src/api/**"]. See ownership.ts. */
  files?: unknown;
  /** Task ids that must be accepted before this one starts, e.g. ["t1"]. */
  after?: unknown;
  /** What the owner leaves for whoever builds on it: what changed, files, decisions. */
  handoff?: unknown;
}

/** Still to do: not done and not blocked. */
export const OPEN = (t: Task) => t.status !== 'done' && t.status !== 'blocked';

/** Autopilot state for one agent in BUILD: keeps it working through its tasks until done or stuck. */
export interface WorkLoop {
  active: boolean;
  turns: number;
  /** Consecutive turns with no commit, no file change and no task-status change. */
  idle: number;
  /** Why autopilot paused it with tasks still open (shown in its status line). */
  stopped?: string;
}

export interface Runtime {
  cfg: AgentConfig;
  adapter: AgentAdapter;
  settings: AgentSettings;
  sessionId?: string;
  /** Hermes: the profile the running turn was started with (its session belongs to that profile). */
  turnProfile?: string;
  /** Index into messages of the next message this agent hasn't seen. */
  lastSeen: number;
  status: AgentStatus;
  current?: Turn;
  /** Why the current turn was killed, if it was. */
  killReason?: 'stopped' | 'timeout' | 'nudge';
  /** The running turn's instruction and CLI process, saved so a restart can resume it. */
  inFlight?: string;
  pid?: number;
  /** Stop was pressed and the turn is ending: not "running" for a restart's Continue. */
  stopping?: boolean;
  /** Progress of the running turn, for stall detection. */
  watch?: TurnWatch;
  /** Bumped by Stop so turns queued before it are dropped. */
  stopGen: number;
  pending: boolean;
  next: TurnPlan;
  totals: UsageTotals;
  loop: WorkLoop;
  /** Out-of-area files already reported, so each is flagged once. */
  scopeWarned: Set<string>;
  /** Switched off by you: gets no turns, reviews or hand-offs until switched back on. */
  disabled: boolean;
  /** Out of usage until this time (ms): skipped for turns, reviews and hand-offs, retried after. */
  outUntil?: number;
  /** When the "skipped because unavailable" notice was last shown, so it isn't repeated every turn. */
  skipNoticeAt?: number;
  /** Instructions that arrived while it was away (send-backs), given to it when it's back. */
  awayWork?: string[];
  /** How its last turn went, for discussion rounds ("did anyone say anything new?"). */
  lastOutcome?: 'spoke' | 'passed' | 'failed' | 'skipped';
  /** What the running turn is for ("building t3", "reviewing t2 for Claude"), for the status line. */
  activity?: string;
  /** The question the running turn is answering, if any. */
  answering?: string;
  /** A question's turn, kept apart from `next` so it gets a turn of its own and isn't merged with other work. */
  nextAsk?: TurnPlan;
  /** `next` holds a turn still to run (it may have no instruction: new messages are enough). */
  hasNext?: boolean;
  /** The model it used before the last change (this run of the app), to fall back to if the new one can't run. */
  prevModel?: string;
  /** When its latest turn started: a turn from before a task was accepted can't reopen that task. */
  turnStartedAt?: number;
  chain: Promise<void>;
}

/** What the watchdog knows about a running turn. */
export interface TurnWatch {
  startedAt: number;
  lastEventAt: number;
  /** The last tool call and when it started (CLIs report a call when it starts, not when it ends). */
  lastTool?: { name: string; detail: string; at: number };
  /** Recent tool calls, newest last, for loop detection. */
  recentTools: string[];
  /** Text the agent said so far, kept if the turn is cut off. */
  texts: string[];
  /** Set while the turn looks stuck; cleared by new output or Keep waiting. */
  stall?: { reason: string; since: number; kind: StallKind };
  /** Text messages since the last tool call (agents like Codex post "still waiting…" while a command runs). */
  textsSinceTool: number;
  /** "Keep waiting" pushes the next check out to here. */
  snoozeUntil?: number;
}

export type StallKind = 'quiet' | 'longrun' | 'loop';

export interface StallInfo {
  agent: string;
  name: string;
  reason: string;
  since: number;
}

export interface PendingRequest {
  id: string;
  from: string;
  kind: 'phase' | 'merge';
  value: string;
}

// ── Small helpers ─────────────────────────────────────────────────────

/** What counts as "the same program" for keeping an agent's conversation: a changed server is another one. */
export const programKey = (c: AgentConfig) =>
  `${c.adapter}|${c.command}|${(c.args ?? []).join(' ')}${c.server ? `|${c.server}` : ''}${c.transport === 'chat' ? '|chat' : ''}`;

/** "3:16 AM", or "Oct 25, 3:16 AM" when it isn't today. */
export function clockTime(ms: number): string {
  if (ms >= OUT_OPEN) return 'you click Try now';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}
