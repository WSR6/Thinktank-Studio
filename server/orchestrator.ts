import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { appendFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveModel, fitEffort, modelCatalog, onServerModelsChanged, refreshServerContext } from './agents/models.js';
import { createAdapter } from './agents/index.js';
import {
  branchDiff,
  branchStatus,
  createProject,
  MergeConflictError,
  mergeAgent,
  openProject,
  listProjects,
  projectsRoot,
  adoptArbiterResult,
  agentWritableDirs,
  conflictingAgents,
  createArbiterWorktree,
  removeArbiterWorktree,
  readTeamFiles,
  decodeText,
  changedFiles,
  syncAgent,
  workSnapshot,
  writePlan,
  prepareReviewWorktree,
  branchTip,
  committedChanges,
  teamFilesChangedSince,
  inMain,
  type ProjectInfo,
} from './project.js';
import { COMMENT_RE, FIXED_RE, loadComments, saveComments, type LineComment } from './comments.js';
import { ATTACHMENT_NOTE, describeAttachments, isImage, validAttachments } from './attachments.js';
import { classifyFailure, failureHint, parseResetTime } from './failures.js';
import { getLimits, setLimits } from './limits.js';
import { backupTeamFiles, restoreIfBroken } from './backups.js';
import { endLeftoverProcess } from './agents/base.js';
import { idleSeconds } from './idle.js';
import { copyIncludes, defaultSetup, readSetupConfig, runSetup, SETUP_FILE, setupHash, type SetupConfig } from './setup.js';
import { checkScope, findOverlaps, matches, overlapId, type Overlap } from './ownership.js';
import {
  cleanAssignment,
  dutyOf,
  loadPresets,
  REVIEW_MODES,
  ROLE_LABELS,
  savePresets,
  type Preset,
  type ReviewMode,
  type RoleAssignment,
  type RolesState,
} from './roles.js';
import {
  loadReviews,
  MAX_REVIEW_ROUNDS,
  parseVerdict,
  runTests,
  saveReviews,
  STAGE_LABELS,
  isMachineStage,
  type ReviewEntry,
  type Reviews,
  type StageKind,
} from './reviews.js';
import type {
  AgentAdapter,
  AgentConfig,
  AgentEvent,
  AgentSettings,
  AgentStatus,
  Autonomy,
  ChatMessage,
  Phase,
  Turn,
  TurnUsage,
} from './types.js';

/** Max agent→agent @mention hand-offs before control returns to the user. */
const MAX_AUTO_HOPS = 6;
/** The helper may restart a cut chain this many times before it needs your say. */
const MAX_CHAIN_RESTARTS = 3;
/** State files restored from team/backups when they won't parse. */
const STATE_FILES = ['session.json', 'reviews.json'];
/** Sent on Continue after a restart to each agent whose turn was cut off. */
const RESUME_NOTE =
  'RESUMED: the app was closed or restarted in the middle of your last turn, so that turn was cut off and its reply was lost. ' +
  'Check your worktree first (git status, git log -3) to see how far you got, then finish what you were doing and report as usual. ' +
  "Don't redo work that's already committed.";
/** Messages resent to agents that can't resume their own session. */
const HISTORY_WINDOW = 40;
const PHASES: Phase[] = ['plan', 'build', 'review'];
const AUTONOMY: Autonomy[] = ['read', 'edits', 'auto', 'full'];
/** Leader asks for a gated action by ending a reply with e.g. [[phase: build]] or [[merge: codex]]. */
export const REQUEST_RE = /\[\[\s*(phase|merge)\s*:\s*([a-z0-9_-]+)\s*\]\]/gi;
/** Model/effort ids go on the command line: safe characters, and no leading '-' so they can't become flags. */
const SAFE_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,63})?$/;
/** Model ids may also be provider-qualified (Hermes: "anthropic/claude-sonnet-4"), never start with - or /. */
const SAFE_MODEL = /^(?:[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127})?$/;
/** A hung CLI (e.g. waiting on a prompt it can't show) is killed after this long. */
/** How long tasks.json may stay unparseable (an agent mid-rewrite) before the user is told. */
const TASKS_PARSE_GRACE_MS = 5_000;
/** Last-resort cap on one turn. Stalls are caught much earlier by the watchdog below. */
const TURN_TIMEOUT_MS = Number(process.env.TTS_TURN_TIMEOUT_MIN ?? 120) * 60_000;
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
/** What counts as "the same program" for keeping an agent's conversation: a changed server is another one. */
const programKey = (c: AgentConfig) => `${c.adapter}|${c.command}|${(c.args ?? []).join(' ')}${c.server ? `|${c.server}` : ''}`;
/** Minutes of quiet before "may be stuck": the agent's own setting, else 30 for a model server (local models are slow), else the app default. */
const quietMs = (c: AgentConfig) => (c.stuckMinutes ?? (c.server ? Number(process.env.TTS_STALL_SERVER_MIN ?? 30) : STALL_QUIET_MS / 60_000)) * 60_000;
const short = (s: string) => (s.length > 120 ? s.slice(0, 117) + '…' : s).replace(/\s+/g, ' ');
/** The same tool call this many times in a row looks like a loop. */
const STALL_REPEAT = 4;
const WATCH_TICK_MS = Math.min(15_000, STALL_QUIET_MS / 4);
/** Autopilot: max continuation turns per agent per run, and consecutive no-progress turns before pausing. */
const AUTOPILOT_MAX_TURNS = Number(process.env.TTS_AUTOPILOT_MAX_TURNS ?? 20);
/** How long the App helper's "Run now" for desktop tests counts down (you can Cancel) before the mouse moves. */
const DESKTOP_COUNTDOWN_MS = Number(process.env.TTS_DESKTOP_COUNTDOWN_S ?? 20) * 1000;
const AUTOPILOT_IDLE_LIMIT = 2;
/** @mention not preceded by a word char or '.', so e-mail addresses don't trigger hand-offs. */
export const MENTION_RE = /(?<![\w.])@([A-Za-z0-9_-]+)/g;

interface TurnPlan {
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
interface OneShot {
  instruction: string;
  cwd: string;
  extraDirs: string[];
  onDone: (ok: boolean, text: string) => Promise<void>;
  /** Always runs afterwards, even if the project was switched meanwhile (e.g. remove a temp worktree). */
  cleanup?: () => Promise<void>;
}

/** Plan-phase discussion: after the first answers, up to this many rounds total; stops early when everyone passes. */
const MAX_DISCUSSION_ROUNDS = Number(process.env.TTS_DISCUSSION_ROUNDS ?? 3);
/** Private agent-to-agent messages allowed per message from you, so two agents can't chat forever. */
const MAX_AGENT_DMS = 4;
/** An agent with nothing new to add replies just this; it isn't posted to the chat. */
export const PASS_RE = /^\s*(?:\[\[\s*pass\s*\]\]|pass\.?)\s*$/i;
/** A reply that starts with [[to: grok]] goes privately to that teammate (you still see it). */
/** "[[done: t3#2 | done | summary]]": a builder reports a task finished, blocked or partly done. */
export const DONE_RE = /\[\[\s*done\s*:\s*([\w.-]+)(?:\s*#\s*(\d+))?\s*\|\s*(done|blocked|partial)\s*(?:\|\s*([^\]]*?))?\s*\]\]/gi;
/** "[[options: A | B | C]]" with an @user question: shown as buttons on the needs-you banner. */
export const OPTIONS_RE = /\[\[\s*options\s*:\s*([^\]]+)\]\]/i;
export const DM_RE = /^\s*\[\[\s*to\s*:\s*@?([a-z0-9_-]+)\s*\]\]\s*/i;
/** "[[ask: codex]] question": ask a teammate and get its answer in your next turn. */
export const ASK_RE = /^\s*\[\[\s*ask\s*:\s*@?([a-z0-9_-]+)\s*\]\]\s*/i;
const MAX_ASKS = 4;
const ASK_TIMEOUT_MS = Number(process.env.TTS_ASK_TIMEOUT_MIN ?? 15) * 60_000;

/** A question one agent asked another and is waiting on. */
interface Ask {
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
/** @user in a reply means "I need the user": flagged with a "needs you" badge. */
export const USER_RE = /(?<![\w.])@user\b/i;

/** Running per-agent usage. Turns without a reported cost are counted so the UI can flag the total as partial. */
interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  unpricedTurns: number;
}

const emptyTotals = (): UsageTotals => ({ turns: 0, input: 0, output: 0, cached: 0, costUsd: 0, unpricedTurns: 0 });

interface ActivityLine {
  ts: number;
  kind: AgentEvent['kind'];
  text: string;
}

/** Activity lines kept per agent (memory and reload history). */
const ACTIVITY_KEEP = 500;

interface Task {
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

/** Autopilot state for one agent in BUILD: keeps it working through its tasks until done or stuck. */
interface WorkLoop {
  active: boolean;
  turns: number;
  /** Consecutive turns with no commit, no file change and no task-status change. */
  idle: number;
  /** Why autopilot paused it with tasks still open (shown in its status line). */
  stopped?: string;
}

const OPEN = (t: Task) => t.status !== 'done' && t.status !== 'blocked';

/** Which stage and round a review is at, to tell whether a verdict is about the stage still open. */
/** askedAt while a review request is still being prepared: no turn counts as the review yet. */
const NOT_ASKED_YET = Number.MAX_SAFE_INTEGER;

const reviewKey = (e: ReviewEntry) => `${e.rounds}:${e.stage}`;

/** The text mentions this task id as a whole word (t1 doesn't match t10). */
export function namesTask(text: string, taskId: string): boolean {
  return new RegExp(`(?<![\\w-])${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
}

/** This agent already approved a stage of the task since it was last sent back (one pair of eyes per stage). */
function approvedThisRound(e: ReviewEntry, id: string): boolean {
  const from = Math.max(e.history.map((h) => h.verdict).lastIndexOf('changes') + 1, e.roundStart ?? 0);
  return e.history.slice(from).some((h) => h.by === id && h.verdict === 'approve');
}

/** Keep the verdict and its task together, so prose about other tasks can't redirect it. */
export function reviewVerdict(text: string, anywhere = false): { verdict?: 'approve' | 'changes'; taskId?: string } {
  // A line with both markers is a quote of the review instructions ("[[verdict: approve]] … or [[verdict: changes]]"), not a verdict.
  const lines = text.split('\n').filter((l) => !(/\[\[\s*verdict\s*:\s*approve/i.test(l) && /\[\[\s*verdict\s*:\s*changes/i.test(l)));
  const explicit = /\[\[\s*verdict\s*:\s*(approve|changes)(?:\s*(?:\|\s*|\s+)(t\d+)(?:\s*#\s*\d+)?)?\s*\]\]/gi;
  const all = [...lines.join('\n').matchAll(explicit)];
  // An explicit verdict always wins, even if a done marker appears later.
  const tail = lines.slice(-6).join('\n');
  const scope = anywhere ? lines.join('\n') : tail;
  const match = anywhere ? all.at(-1) : [...tail.matchAll(explicit)].at(-1);
  if (match) return { verdict: match[1].toLowerCase() as 'approve' | 'changes', taskId: match[2]?.toLowerCase() };
  const done = [...scope.matchAll(/\[\[\s*done\s*:\s*(t\d+)(?:\s*#\s*\d+)?\s*\|\s*(approved?|lgtm|changes|send\s+back|needs\s+changes)\b[^\]]*\]\]/gi)].at(-1);
  if (!done) return {};
  return { verdict: /^(?:approved?|lgtm)$/i.test(done[2]) ? 'approve' : 'changes', taskId: done[1].toLowerCase() };
}

/** "Out until you click Try now": a limit message with no reset time (e.g. Grok's "try again later"). */
const OUT_OPEN = 8.64e15;

/** "3:16 AM", or "Oct 25, 3:16 AM" when it isn't today. */
function clockTime(ms: number): string {
  if (ms >= OUT_OPEN) return 'you click Try now';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

interface Runtime {
  cfg: AgentConfig;
  adapter: AgentAdapter;
  settings: AgentSettings;
  sessionId?: string;
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
interface TurnWatch {
  startedAt: number;
  lastEventAt: number;
  /** The last tool call and when it started (CLIs report a call when it starts, not when it ends). */
  lastTool?: { name: string; detail: string; at: number };
  /** Recent tool calls, newest last, for loop detection. */
  recentTools: string[];
  /** Text the agent said so far, kept if the turn is cut off. */
  texts: string[];
  /** Set while the turn looks stuck; cleared by new output or Keep waiting. */
  stall?: { reason: string; since: number; kind: 'quiet' | 'longrun' | 'loop' };
  /** Text messages since the last tool call (agents like Codex post "still waiting…" while a command runs). */
  textsSinceTool: number;
  /** "Keep waiting" pushes the next check out to here. */
  snoozeUntil?: number;
}

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

export class Orchestrator extends EventEmitter {
  messages: ChatMessage[] = [];
  leader: 'user' | string = 'user';
  phase: Phase = 'plan';
  /** Approval gates: leader requests for phase changes / merges wait for the user. */
  gates = true;
  /** BUILD autopilot: after each turn, agents with unfinished tasks get another turn automatically. */
  autopilot = false;
  private allDoneAnnounced = false;
  /** Task ids seen in tasks.json so far: one that appears later is new work (e.g. added after "finished"). */
  private knownTasks = new Set<string>();
  /** Overlaps already announced (by overlapId), so a tasks.json edit only reports new ones. */
  private overlapSeen = new Set<string>();
  /** When tasks.json started failing to parse (0 = it parses), and whether that was announced. */
  private tasksParseSince = 0;
  private tasksParseAnnounced = false;
  /** The task list from the last time tasks.json parsed, used while it's mid-rewrite or broken. */
  private lastGoodTasks: Task[] = [];
  /** Automatic merges of accepted work run one at a time. */
  private mergeQueue: Promise<unknown> = Promise.resolve();
  /** Numbers each tasks.json read, so a slow, older read can't overwrite a newer result. */
  private tasksReadSeq = 0;
  private tasksReadDone = 0;
  /** Optional roles (off by default) and how finished tasks are reviewed. Saved per project. */
  roles: RolesState = { enabled: false, assignments: {} };
  reviewMode: ReviewMode = 'off';
  /** Run before a task is accepted (e.g. "npm test"); empty = no tests step. */
  testCommand = '';
  /** Tests that need the real mouse and screen (e.g. Playwright drag tests): run only when you (or the App helper) press Run now. */
  desktopTestCommand = '';
  /** Tasks waiting at the desktop-tests stage: task id -> when it started waiting. */
  /** Each entry is unique (stage token + a counter), so a result from an earlier run never matches a later one. */
  private desktopWaiting = new Map<string, string>();
  private desktopSeq = 0;
  /** Ends the desktop test command that's running (any project): only one may hold the mouse. */
  private static desktopKill?: () => void;
  /** The desktop-test run in progress or counting down (one at a time: they share the mouse). */
  private desktopRun?: { task: string; startsAt: number; running: boolean; by: 'user' | 'helper'; timer?: NodeJS.Timeout };
  reviews: Reviews = {};
  /** Set when an agent fails with a usage/rate limit, so the UI can offer to switch setups. */
  limitHit?: { agent: string; name: string; text: string };
  /** Agents that were mid-turn, or on autopilot, when the app last closed: offered a Continue. */
  resumeOffer?: { working: string[]; looping: string[]; at: number; instructions: Record<string, string>; pids: Record<string, number> };
  /** tts.yaml setup runs by worktree folder, so a turn working there can wait for it; and the command running. */
  private setupRuns = new Map<string, Promise<void>>();
  /** Setup → Agents save in progress. */
  private savingTeam = false;
  private setupRunning = new Map<string, string>();
  /** How setup last went in each folder (this run of the app; `ok` without `at` = done earlier, still current). */
  private setupResults = new Map<string, { ok: boolean; at?: number; failed?: string }>();
  private setupStateWrite: Promise<void> = Promise.resolve();
  private reviewQueue: Promise<void> = Promise.resolve();
  /** Agents that wrote @user: questions only you can answer. Cleared when you reply. */
  needsYou: { agent: string; name: string; text: string; ts: number; options?: string[] }[] = [];
  /** Tasks already announced as accepted, so dependants are released once. */
  private acceptedSeen = new Set<string>();
  /** When each task last passed review (ms), to spot a reopen from a turn that started before that. */
  private acceptedAt: Record<string, number> = {};
  /** The latest send-back instruction per task, so an acceptance can withdraw it if it hasn't run yet. */
  private queuedSendBacks: Record<string, { owner: string; text: string }> = {};
  /** Line comments on agents' branch diffs (team/comments.json). */
  comments: LineComment[] = [];
  /** Reviews already reported as waiting for an unavailable reviewer (task:stage:agent). */
  private parkNoticed = new Set<string>();
  /** Build attempt per task: 1 at first, +1 each time it's sent back. A done report from an older attempt is ignored. */
  private attempts: Record<string, number> = {};
  /** Per task, when it was last sent back and the branch tip then: attempt N's work is what came after. */
  private sentBack: Record<string, { at: number; tip?: string }> = {};
  /**
   * Per task, the attempt whose "done" the app has checked against git. A "done" in tasks.json counts
   * (starts review, is accepted, releases dependants) only once it's checked for the current attempt.
   */
  private doneOk: Record<string, number> = {};
  /** Tasks reported done whose check found no commits, for the App helper (see doneButNoCommits). */
  private noCommits: Record<string, { agent: string; why: string; attempt: number; at: number; root: string }> = {};
  /** All app edits to tasks.json go through this queue, each reading the latest file. */
  private taskWrites: Promise<unknown> = Promise.resolve();
  private taskWriteSeq = 0;
  /** Bumped on each message from you, ending any discussion rounds still going. */
  private discussionGen = 0;
  private agentDms = 0;
  /** Questions between agents ([[ask: id]]); open ones hold the asker's autopilot until answered. */
  private asks: Ask[] = [];
  private askSeq = 0;
  /** Asks started since your last message (capped like DMs). */
  private askCount = 0;
  requests: PendingRequest[] = [];
  debating = false;
  project?: ProjectInfo;
  private agents = new Map<string, Runtime>();
  private hops = 0;
  /** Set when the hand-off chain was cut at MAX_AUTO_HOPS: who was about to be woken. The App helper restarts it (resumeChain). */
  private hopPause?: { at: number; from: string; targets: string[] };
  /** Times the helper restarted a cut chain since your last message: capped so two agents can't ping-pong forever. */
  private chainRestarts = 0;
  private watcher?: FSWatcher;
  /**
   * Recent activity per agent (tool calls, CLI output, turn start/end/failure), kept in memory and in
   * team/activity/<id>.jsonl so the panels survive a reload and the App helper can see what happened.
   */
  private activity = new Map<string, ActivityLine[]>();
  /** Lines ever recorded per agent; lets the helper ask for "what's new since last time". */
  private activityTotal = new Map<string, number>();
  /** Bumped on project switch; turns from an older generation are discarded. */
  private gen = 0;
  private debateCancelled = false;
  private metaWrite: Promise<void> = Promise.resolve();

  constructor(configs: AgentConfig[], private mock: boolean) {
    super();
    // A model server's list arrives after the first state push: send the pickers the new choices.
    onServerModelsChanged(() => this.emit('state'));
    // Keep model servers' lists current while the app sits idle (a server started later, a model loaded).
    setInterval(() => {
      for (const r of this.agents.values()) if (r.cfg.server) modelCatalog(r.cfg.adapter, r.cfg.server);
    }, 60_000).unref();
    // Agents commit mid-turn: refresh branch badges while anyone is working.
    setInterval(() => {
      if (this.project && [...this.agents.values()].some((r) => r.status === 'working')) this.emit('branches');
    }, 20_000).unref();
    for (const cfg of configs) this.agents.set(cfg.id, this.newRuntime(cfg));
    // Bring agents back when their usage limit resets.
    setInterval(() => this.availabilityTick(), 30_000).unref();
  }

  state() {
    return {
      project: this.project ? { name: this.project.name, root: this.project.root } : null,
      leader: this.leader,
      phase: this.phase,
      gates: this.gates,
      autopilot: this.autopilot,
      autopilotMaxTurns: AUTOPILOT_MAX_TURNS,
      requests: this.requests,
      debating: this.debating,
      allTasksAccepted: this.lastGoodTasks.length > 0 && this.lastGoodTasks.every((t) => this.accepted(t)),
      roles: this.roles,
      reviewMode: this.reviewMode,
      testCommand: this.testCommand,
      desktopTests: {
        command: this.desktopTestCommand,
        waiting: [...this.desktopWaiting.keys()].filter((id) => this.desktopCurrent(id)),
        run: this.desktopRun ? { task: this.desktopRun.task, startsAt: this.desktopRun.startsAt, running: this.desktopRun.running, by: this.desktopRun.by } : null,
      },
      reviews: this.reviews,
      comments: this.comments,
      presets: loadPresets(),
      limitHit: this.limitHit ?? null,
      resume: this.resumeOffer ? { ...this.resumeOffer, names: this.resumeOffer.working.map((id) => this.nameOf(id)) } : null,
      needsYou: this.needsYou,
      stalls: this.stalls(),
      agents: [...this.agents.values()].map((r) => ({
        id: r.cfg.id,
        name: r.cfg.name,
        color: r.cfg.color ?? '#888',
        status: r.status,
        settings: r.settings,
        totals: r.totals,
        loop: r.loop,
        statusLine: this.statusLine(r),
        waitingFor: this.asks.find((a) => (a.status === 'open' || a.status === 'queued') && a.from === r.cfg.id)?.to ?? null,
        catalog: modelCatalog(r.cfg.adapter, r.cfg.server) ?? null,
        defaults: this.defaultSettings(r.cfg),
        disabled: r.disabled,
        outUntil: r.outUntil ?? null,
        // A model server has no plan limits; Codex's OpenAI usage would be misleading there.
        limits: r.cfg.server ? null : getLimits(r.cfg.adapter),
      })),
    };
  }

  // ── Projects ──────────────────────────────────────────────────────────

  async open(name: string, create: boolean): Promise<void> {
    if (this.savingTeam) throw new Error('The team is being saved (Setup → Agents); open the project again in a moment.');
    const ids = [...this.agents.keys()];
    const next = create ? await createProject(name, ids) : await openProject(name, ids);
    // Retire the old project's turns: anything still running or queued is killed and its result dropped.
    this.gen++;
    this.stopAll();
    await Promise.allSettled([...this.agents.values()].map((r) => r.chain));
    await this.reviewQueue.catch(() => {});
    await this.metaWrite;
    this.project = next;
    this.tasksParseSince = 0;
    this.tasksParseAnnounced = false;
    this.lastGoodTasks = [];
    this.messages = this.readJsonl(join(this.project.teamDir, 'chat.jsonl'));
    // A state file that won't parse comes back from its newest good backup; then back up the good ones.
    const restored = STATE_FILES.map((f) => [f, restoreIfBroken(this.project!.teamDir, f)] as const).filter(([, b]) => b);
    backupTeamFiles(this.project.teamDir, [...STATE_FILES, 'tasks.json']);
    const meta = this.readJson(join(this.project.teamDir, 'session.json'));
    this.leader = meta.leader ?? 'user';
    this.phase = meta.phase ?? 'plan';
    this.gates = meta.gates ?? true;
    this.autopilot = meta.autopilot ?? false;
    this.roles = { enabled: Boolean(meta.roles?.enabled), assignments: meta.roles?.assignments ?? {} };
    this.reviewMode = REVIEW_MODES.includes(meta.reviewMode) ? meta.reviewMode : 'off';
    this.testCommand = typeof meta.testCommand === 'string' ? meta.testCommand : '';
    this.desktopTestCommand = typeof meta.desktopTestCommand === 'string' ? meta.desktopTestCommand : '';
    clearTimeout(this.desktopRun?.timer);
    Orchestrator.desktopKill?.();
    this.desktopRun = undefined;
    this.desktopWaiting.clear();
    this.reviews = loadReviews(this.project.teamDir);
    // A review request that was still being prepared when the app stopped: ask again.
    for (const e of Object.values(this.reviews)) if (e.status === 'in_review' && e.askedAt === NOT_ASKED_YET) e.waitingOn = undefined;
    this.comments = loadComments(this.project.teamDir);
    this.attempts = meta.attempts && typeof meta.attempts === 'object' ? meta.attempts : {};
    this.sentBack = meta.sentBack && typeof meta.sentBack === 'object' ? meta.sentBack : {};
    this.doneOk = meta.doneOk && typeof meta.doneOk === 'object' ? meta.doneOk : {};
    const legacy = !meta.doneOk;
    // Question ids keep counting across restarts, so q1 never means two different questions in one project.
    this.askSeq = Number.isInteger(meta.askSeq) && meta.askSeq > 0 ? meta.askSeq : 0;
    this.limitHit = undefined;
    // Questions and approval requests still waiting for you survive a restart.
    const isStr = (v: unknown) => typeof v === 'string';
    this.needsYou = Array.isArray(meta.needsYou)
      ? meta.needsYou.filter((n: any) => n && this.agents.has(n.agent) && isStr(n.text) && typeof n.ts === 'number')
      : [];
    this.requests = Array.isArray(meta.requests)
      ? meta.requests.filter((q: any) => q && isStr(q.id) && isStr(q.from) && (q.kind === 'phase' || q.kind === 'merge') && isStr(q.value))
      : [];
    this.debating = false;
    this.allDoneAnnounced = false;
    this.hops = 0;
    this.hopPause = undefined;
    this.chainRestarts = 0;
    this.agentDms = 0;
    this.askCount = 0;
    for (const a of this.asks) clearTimeout(a.timer);
    this.asks = [];
    for (const r of this.agents.values()) {
      const s = { ...(meta.agents?.[r.cfg.id] ?? {}) };
      const program = programKey(r.cfg);
      if (typeof s.program === 'string' && s.program !== program) {
        // Setup changed this agent's program since this project last ran: new conversation; a new kind of program also drops the old model.
        s.sessionId = undefined;
        s.outUntil = undefined;
        if (s.program.split('|')[0] !== r.cfg.adapter || (s.program.split('|')[3] ?? '') !== (r.cfg.server ?? '')) s.settings = undefined;
      }
      r.sessionId = s.sessionId;
      r.lastSeen = Math.min(s.lastSeen ?? 0, this.messages.length);
      // An empty saved model/effort means "default", which is the agents.config.json value when set.
      const saved = s.settings ?? {};
      const model = saved.model || r.cfg.model || '';
      const effort = fitEffort(r.cfg.adapter, model, r.cfg.server ? '' : saved.effort || r.cfg.effort || '', r.cfg.effort);
      r.settings = { ...this.defaultSettings(r.cfg), ...saved, model, effort };
      r.totals = { ...emptyTotals(), ...s.totals };
      // Why autopilot had paused it (you stopped it, no progress, a failed turn…) survives a restart.
      r.loop = { active: false, turns: 0, idle: 0, ...(isStr(s.loopStopped) ? { stopped: s.loopStopped } : {}) };
      r.scopeWarned = new Set();
      r.status = 'idle';
      r.disabled = Boolean(s.disabled);
      r.outUntil = typeof s.outUntil === 'number' && s.outUntil > Date.now() ? s.outUntil : undefined;
      r.lastOutcome = undefined;
    }
    // Limits that reset while the app was closed: those agents are back now.
    const returned = [...this.agents.values()].filter((r) => {
      const s = meta.agents?.[r.cfg.id] ?? {};
      return typeof s.outUntil === 'number' && s.outUntil <= Date.now() && !r.disabled;
    });
    this.loadActivity();
    this.watchTeam();
    // Remember current overlaps and accepted tasks without re-announcing them.
    const tasksNow = await this.readTasks();
    // A project from before done checks: its finished tasks stay finished.
    if (legacy) for (const t of tasksNow) if (t.status === 'done') this.doneOk[t.id] = this.attemptOf(t.id);
    this.overlapSeen = new Set(findOverlaps(tasksNow).map(overlapId));
    this.acceptedSeen = new Set(tasksNow.filter((t) => this.accepted(t)).map((t) => t.id));
    this.knownTasks = new Set(tasksNow.map((t) => t.id));
    if (create) this.system(`Project "${name}" created at ${this.project.root}. Phase: plan.`);
    for (const [file, backup] of restored) this.system(`team/${file} couldn't be read, so it was restored from team/${backup}. The broken copy is kept next to it.`);
    if (this.requests.length || this.needsYou.length) {
      const what = [
        this.requests.length ? `${this.requests.length} request${this.requests.length > 1 ? 's' : ''} for your approval` : '',
        this.needsYou.length ? `${this.needsYou.length} question${this.needsYou.length > 1 ? 's' : ''} for you` : '',
      ].filter(Boolean);
      this.system(`Still waiting from before the restart: ${what.join(' and ')} (above the chat).`);
    }
    // Tests that were running when the app closed never reported: run them again.
    for (const [id, e] of Object.entries(this.reviews)) {
      const t = tasksNow.find((x) => x.id === id);
      if (t && e.status === 'in_review' && isMachineStage(e.stages[e.stage])) void this.dispatchStage(t);
    }
    // Closed while agents were working: their turns were cut off. Offer to pick up where they left off.
    const known = (ids: unknown) => (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && this.agents.has(id)) : []);
    const working = known(meta.running?.working);
    const looping = known(meta.running?.looping);
    const saved = (key: 'inFlight' | 'pid') =>
      Object.fromEntries(working.map((id) => [id, meta.agents?.[id]?.[key]]).filter(([, v]) => v !== undefined && v !== null));
    this.resumeOffer =
      working.length || looping.length
        ? { working, looping, at: Number(meta.running?.at) || 0, instructions: saved('inFlight'), pids: saved('pid') }
        : undefined;
    if (this.resumeOffer) {
      const who = working.length ? `${working.map((id) => this.nameOf(id)).join(', ')} ${working.length > 1 ? 'were' : 'was'} working` : 'autopilot was running';
      this.system(`The app closed while ${who}. Continue or dismiss above the chat.`);
    }
    for (const r of returned) {
      this.system(`${r.cfg.name}'s usage limit reset while the app was closed; it's back on the team.`);
      this.comeBack(r);
    }
    // Reviews that waited (e.g. for an away reviewer) get another chance now.
    this.reviewQueue = this.reviewQueue.then(() => this.dispatchParked()).catch(console.error);
    for (const [id, dir] of Object.entries(this.project.agentDirs)) void this.ensureSetup(id, dir, id);
    this.emit('messages');
    this.emit('state');
    this.emit('team');
    this.emit('branches');
  }

  /**
   * tts.yaml: copy the listed gitignored files into a worktree, and run the setup commands there when
   * they, or a lockfile, changed since setup last succeeded in it (so: new worktrees, and after a Sync
   * that brought new dependencies). Output goes to `logTo`'s activity panel; a failure is posted, and
   * turns go ahead anyway. Deduplicated per folder.
   */
  private ensureSetup(key: string, dir: string, logTo?: string): Promise<void> {
    const p = this.project;
    const running = this.setupRuns.get(dir);
    if (!p || running) return running ?? Promise.resolve();
    let cfg: SetupConfig | undefined;
    try {
      // The worktree's own copy: one that hasn't synced main's tts.yaml yet has nothing to set up.
      cfg = readSetupConfig(dir);
      // No tts.yaml: still reinstall when package-lock.json changes (e.g. after a fast-forward to a teammate's branch).
      if (!cfg && !existsSync(join(dir, SETUP_FILE))) cfg = defaultSetup(dir);
    } catch (e) {
      this.notice(`${SETUP_FILE} couldn't be read, so no setup ran: ${(e as Error).message}`);
      return Promise.resolve();
    }
    if (!cfg) return Promise.resolve();
    const log = (text: string) => logTo && this.emitAgent(logTo, { kind: 'log', text: `setup: ${text}` });
    const copied = copyIncludes(p.repoDir, dir, cfg.include);
    if (copied.length) log(`copied ${copied.join(', ')} from repo/`);
    const stateFile = join(p.teamDir, 'setup-state.json');
    if (!cfg.setup.length) return Promise.resolve();
    if (this.readJson(stateFile)[key] === setupHash(dir, cfg)) {
      if (!this.setupResults.has(dir)) this.setupResults.set(dir, { ok: true });
      return Promise.resolve();
    }
    const setup = cfg;
    const run = (async () => {
      this.setupRunning.set(dir, setup.setup[0]);
      this.emit('state');
      const res = await runSetup(dir, setup, { TTS_ROOT: p.repoDir, TTS_WORKTREE: dir, TTS_AGENT: key }, (line) => log(line.slice(0, 300)));
      const label = key.startsWith('_review-') ? `the review copy of agent/${key.slice(8)}` : `${this.nameOf(key)}'s worktree`;
      if (res.ok) {
        // Hashed after the run: an install may rewrite the lockfile. One write at a time, tmp + rename,
        // so two setups finishing together both keep their entry.
        const hash = setupHash(dir, setup);
        this.setupStateWrite = this.setupStateWrite
          .then(async () => {
            const state = this.readJson(stateFile);
            state[key] = hash;
            await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2));
            await rename(stateFile + '.tmp', stateFile);
          })
          .catch((e) => console.error('setup state:', e));
        await this.setupStateWrite;
        this.setupResults.set(dir, { ok: true, at: Date.now() });
        log('done');
      } else {
        this.setupResults.set(dir, { ok: false, at: Date.now(), failed: `\`${res.failed}\` ${res.code === null ? 'was stopped' : `exited with ${res.code}`}` });
        this.notice(
          `Setup failed in ${label}: \`${res.failed}\` ${res.code === null ? 'was stopped' : `exited with ${res.code}`}. Turns there go ahead anyway; ` +
            `fix ${existsSync(join(dir, SETUP_FILE)) ? SETUP_FILE : 'the install (npm install)'} or run it there yourself. Last output:\n${res.tail.slice(-1500)}`,
        );
      }
    })()
      .catch((e) => console.error('setup failed:', e))
      .finally(() => {
        this.setupRuns.delete(dir);
        this.setupRunning.delete(dir);
        this.emit('state');
      });
    this.setupRuns.set(dir, run);
    return run;
  }

  /**
   * A fresh review copy of `owner`'s branch, then set up per its tts.yaml (logged to `reviewer`). A setup
   * still running in that copy finishes first, so the refresh can't change files under an install.
   */
  private async reviewCheckout(owner: string, reviewer: string): Promise<{ dir: string; name: string }> {
    const p = this.requireProject();
    await this.setupRuns.get(join(p.root, 'agents', `_review-${owner}`));
    const checkout = await prepareReviewWorktree(p, owner);
    void this.ensureSetup(checkout.name, checkout.dir, reviewer);
    return checkout;
  }

  /** What the agent should know about tts.yaml setup in its worktree, so it doesn't guess (e.g. "no .venv"). */
  private setupLine(dir: string | undefined): string {
    if (!dir || (!existsSync(join(dir, SETUP_FILE)) && !this.setupRuns.has(dir) && !this.setupResults.has(dir))) return '';
    const time = (at?: number) => (at ? ` at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');
    if (this.setupRuns.has(dir)) return `[setup: ${existsSync(join(dir, SETUP_FILE)) ? `${SETUP_FILE} setup` : 'automatic npm install'} is running in your worktree right now; dependencies may not be ready yet]`;
    const res = this.setupResults.get(dir);
    if (!res) return '';
    const what = existsSync(join(dir, SETUP_FILE)) ? `${SETUP_FILE} setup` : 'automatic npm install';
    return res.ok
      ? `[setup: ${what} succeeded in your worktree${res.at ? time(res.at) : ' earlier and is current'}; its dependencies are installed there, so use them]`
      : `[setup: ${what} FAILED in your worktree${time(res.at)} (${res.failed}); dependencies may be missing. Say so if that blocks you]`;
  }

  /** Setup still running in any of these folders, when tts.yaml says turns wait for it. */
  private pendingSetup(dirs: string[]): Promise<void>[] {
    const waits = (d: string) => {
      try {
        return readSetupConfig(d)?.waitForSetup !== false;
      } catch {
        return false;
      }
    };
    return dirs.filter((d) => this.setupRuns.has(d) && waits(d)).map((d) => this.setupRuns.get(d)!);
  }

  async teamFiles(): Promise<{ plan: string; tasks: string; overlaps: Overlap[] }> {
    if (!this.project) return { plan: '', tasks: '', overlaps: [] };
    const files = await readTeamFiles(this.project);
    return { ...files, overlaps: findOverlaps(await this.readTasks()) };
  }

  /** Warn once per distinct set of overlapping file claims in tasks.json. */
  private async checkOverlaps(): Promise<void> {
    const overlaps = findOverlaps(await this.readTasks());
    // Only new overlaps; one that was fixed and comes back is new again.
    const now = new Set(overlaps.map(overlapId));
    const fresh = overlaps.filter((o) => !this.overlapSeen.has(overlapId(o)));
    this.overlapSeen = now;
    if (!fresh.length) return;
    const list = fresh
      .slice(0, 3)
      .map((o) => `${o.a.task} (${this.nameOf(o.a.owner)}: ${o.a.pattern}) and ${o.b.task} (${this.nameOf(o.b.owner)}: ${o.b.pattern})`)
      .join('; ');
    const more = fresh.length > 3 ? ` and ${fresh.length - 3} more (all listed in the Tasks tab)` : '';
    this.notice(`File areas may overlap in tasks.json: ${list}${more}. Give each shared file one owner, or make one task come "after" the other.`);
  }

  /**
   * After a BUILD turn: flag files the agent changed that belong to another agent's task, or that
   * none of its own tasks claim. Tells the user, and the agent (it sees the note next turn).
   */
  private async checkScopeAfterTurn(r: Runtime): Promise<void> {
    if (this.phase !== 'build' || !this.project) return;
    const tasks = await this.readTasks();
    const report = checkScope(r.cfg.id, await changedFiles(this.project, r.cfg.id).catch(() => []), tasks);
    const foreign = report.foreign.filter((f) => !r.scopeWarned.has(f.file));
    const outside = report.outside.filter((f) => !r.scopeWarned.has(f));
    if (!foreign.length && !outside.length) return;
    foreign.forEach((f) => r.scopeWarned.add(f.file));
    outside.forEach((f) => r.scopeWarned.add(f));
    const parts = (whose: string) => [
      ...foreign.map((f) => `${f.file} (belongs to ${this.nameOf(f.owner)}'s ${f.task})`),
      ...(outside.length ? [`${outside.join(', ')} (not in any of ${whose} tasks' files)`] : []),
    ].join('; ');
    this.notice(`${r.cfg.name} edited outside its area: ${parts('its')}.`);
    this.add({
      from: 'system',
      to: r.cfg.id,
      text: `You changed files outside your tasks' "files": ${parts('your')}. Undo these or ask the owner (@mention) to make the change, unless the user agrees.`,
    });
  }

  async savePlan(plan: string): Promise<void> {
    await writePlan(this.requireProject(), plan);
  }

  diff(agentId: string) {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`);
    return branchDiff(this.requireProject(), agentId);
  }

  /** Zero the running token/cost counters (e.g. at the start of a billing period). */
  resetUsage(): void {
    for (const r of this.agents.values()) r.totals = emptyTotals();
    this.saveMeta();
    this.emit('state');
  }

  /** Branch status plus, per agent, files changed outside its claimed area. */
  async branches() {
    if (!this.project) return [];
    const project = this.project;
    const [statuses, tasks] = await Promise.all([branchStatus(project), this.readTasks()]);
    return Promise.all(
      statuses.map(async (s) => {
        const scope = checkScope(s.agentId, await changedFiles(project, s.agentId).catch(() => []), tasks);
        return { ...s, foreign: scope.foreign, outside: scope.outside };
      }),
    );
  }

  /** PLAN.md / tasks.json change whenever an agent edits them; push those to the UI. */
  private watchTeam(): void {
    this.watcher?.close();
    let timer: NodeJS.Timeout | undefined;
    this.watcher = watch(this.project!.teamDir, (_e, file) => {
      if (file && !['PLAN.md', 'tasks.json'].includes(String(file))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.emit('team');
        void this.checkOverlaps();
        this.advanceReviews();
      }, 200);
    });
  }

  // ── Room controls ─────────────────────────────────────────────────────

  setLeader(leader: string): void {
    if (leader !== 'user' && !this.agents.has(leader)) throw new Error(`Unknown agent ${leader}`);
    this.leader = leader;
    this.system(`Leader is now ${this.nameOf(leader)}.`);
    this.saveMeta();
    this.emit('state');
  }

  setPhase(phase: Phase): void {
    if (!PHASES.includes(phase)) throw new Error(`Unknown phase ${phase}`);
    this.phase = phase;
    // Requests to move to the phase we're now in are done with, however many were sent.
    this.requests = this.requests.filter((r) => !(r.kind === 'phase' && r.value === phase));
    const hint: Record<Phase, string> = {
      plan: 'Discuss and refine PLAN.md. No code yet.',
      build: 'Each agent builds its assigned tasks from tasks.json in its own worktree and commits to its branch.',
      review: "Review each other's branches. Leader merges approved work into main.",
    };
    this.system(`Phase → ${phase.toUpperCase()}. ${hint[phase]}`);
    if (phase !== 'build') for (const r of this.agents.values()) r.loop.active = false;
    this.saveMeta();
    this.emit('state');
    this.kickPhase(phase);
  }

  /** Start work when a phase begins, so approving BUILD actually starts the build. */
  private kickPhase(phase: Phase): void {
    if (!this.project || phase === 'plan') return;
    const instruction =
      phase === 'build'
        ? 'BUILD phase has started. Work on the tasks you own in tasks.json: set them to "doing", implement them in your worktree, commit, then set them to "done". Reply briefly with what you finished or what blocks you.'
        : "REVIEW phase has started. Review your teammates' branches (git log/diff main...agent/<id>) and report concrete issues. Don't edit their code.";
    if (phase === 'build' && this.autopilot) this.armLoops();
    if (phase !== 'build') {
      for (const id of this.agents.keys()) void this.enqueue(id, { instruction });
      return;
    }
    void this.readTasks().then((tasks) => {
      const waiting: string[] = [];
      for (const r of this.agents.values()) {
        const open = tasks.filter((t) => t.owner === r.cfg.id && OPEN(t));
        // Nothing of its own to build (and there is a task list): don't spend a turn on "nothing to do".
        if (!open.length && tasks.length) {
          // Inactive, so a task assigned later starts its loop (wakeForNewTasks / resumeIdleLoops).
          r.loop.active = false;
          continue;
        }
        // An agent whose open tasks all wait on others sits out; it starts when they're accepted.
        if (open.length && !open.some((t) => this.isReady(t, tasks))) {
          r.loop.active = false;
          waiting.push(`${r.cfg.name} (${open.map((t) => `${t.id} after ${this.depsOf(t).join(', ')}`).join('; ')})`);
          continue;
        }
        void this.enqueue(r.cfg.id, { instruction });
      }
      if (waiting.length) this.system(`Waiting for other tasks first: ${waiting.join(', ')}. They start automatically once those are accepted.`);
    });
  }

  // ── Autopilot (BUILD work loop) ───────────────────────────────────────

  setAutopilot(on: boolean): void {
    this.autopilot = on;
    if (!on) for (const r of this.agents.values()) r.loop.active = false;
    this.system(
      on
        ? `Autopilot on: in BUILD, agents keep working through their tasks (up to ${AUTOPILOT_MAX_TURNS} turns each) until done, blocked, or stuck.`
        : 'Autopilot off: agents take one turn per message.',
    );
    this.saveMeta();
    this.emit('state');
    if (on && this.phase === 'build') void this.startLoops();
  }

  /** Reset every agent's loop counters and mark it running. */
  private armLoops(): void {
    this.allDoneAnnounced = false;
    for (const r of this.agents.values()) r.loop = { active: true, turns: 0, idle: 0 };
  }

  /**
   * Autopilot switched on mid-BUILD: start idle agents that still have open tasks. After a restart, only
   * the agents that were looping (`only`); those getting a resumed turn (`resumed`) carry on after it.
   */
  private async startLoops(only?: string[], resumed: string[] = []): Promise<void> {
    if (only) {
      this.allDoneAnnounced = false;
      for (const id of only) {
        const r = this.agents.get(id);
        if (r) r.loop = { active: true, turns: 0, idle: 0 };
      }
    } else this.armLoops();
    const tasks = await this.readTasks();
    for (const r of this.agents.values()) {
      if (only && !only.includes(r.cfg.id)) continue;
      const next = tasks.find((t) => t.owner === r.cfg.id && OPEN(t) && this.isReady(t, tasks));
      if (!next) {
        r.loop.active = false;
        continue;
      }
      if (resumed.includes(r.cfg.id)) continue;
      if (r.status !== 'working' && !r.pending) void this.enqueue(r.cfg.id, { instruction: this.continueInstruction(next, tasks) });
    }
    this.emit('state');
  }

  /**
   * Tasks added to tasks.json during BUILD (by the leader or you, e.g. after "project finished") start
   * on their own under autopilot: each owner whose loop has ended gets going again, with no toggling.
   */
  private wakeForNewTasks(tasks: Task[]): void {
    const added = tasks.filter((t) => !this.knownTasks.has(t.id));
    for (const t of added) this.knownTasks.add(t.id);
    if (!added.length || this.phase !== 'build' || !this.autopilot) return;
    if (added.some(OPEN)) this.allDoneAnnounced = false; // a later "project finished" is news again
    const owners = new Set(
      added
        .filter((t) => OPEN(t) && this.isReady(t, tasks) && t.owner && this.agents.has(t.owner))
        .map((t) => t.owner!)
        .filter((id) => {
          const r = this.agents.get(id)!;
          return !r.loop.active && !r.current && !r.pending && this.available(id);
        }),
    );
    if (!owners.size) return;
    const list = [...owners];
    const ids = added.filter((t) => t.owner && owners.has(t.owner)).map((t) => t.id);
    this.system(`New task${ids.length > 1 ? 's' : ''} ${ids.join(', ')}: ${list.map((id) => this.nameOf(id)).join(' and ')} ${list.length > 1 ? 'start' : 'starts'} on ${ids.length > 1 ? 'them' : 'it'}.`);
    void this.startLoops(list);
  }

  private attemptOf(taskId: string): number {
    return this.attempts[taskId] ?? 1;
  }

  /**
   * [[done: t3#2 | outcome | summary]] reports in a builder's reply. The app settles the task in
   * tasks.json (so it counts even if the agent forgot to edit the file). A report counts only for the
   * attempt the turn worked on: if the task was sent back while the turn ran, or the report quotes
   * another attempt, it's ignored. "done" must be backed by committed work in the task's files (since
   * the send-back, for a later attempt); otherwise the task stays "doing" with a note saying why.
   */
  private async applyDoneReports(id: string, text: string, attemptsAtStart: Record<string, number>): Promise<Set<string>> {
    const settled = new Set<string>();
    const reports = [...text.matchAll(DONE_RE)];
    if (!reports.length || !this.project) return settled;
    const tasks = await this.readTasks();
    const name = this.nameOf(id);
    for (const [, taskId, attemptStr, outcome, summary = ''] of reports) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) {
        this.notice(`${name} reported ${taskId} ${outcome.toLowerCase()}, but there's no task ${taskId} in tasks.json.`);
        continue;
      }
      if (t.owner !== id) {
        this.notice(`${name} reported ${taskId} ${outcome.toLowerCase()}, but it's ${this.nameOf(t.owner ?? '?')}'s task; ignored.`);
        continue;
      }
      // Accepted after this turn started: its report is about work that's already settled.
      if (this.reviews[taskId]?.status === 'passed' && this.reopenedByStaleTurn(t)) {
        this.emitAgent(id, { kind: 'log', text: `(ignored a report for ${taskId}: it was accepted while this turn ran)` });
        settled.add(taskId);
        continue;
      }
      const workedOn = attemptsAtStart[taskId] ?? 1;
      const reported = attemptStr ? Number(attemptStr) : workedOn;
      // Checked again right before writing, in case a send-back lands while we look at git.
      const fresh = () => this.attemptOf(taskId) === reported && reported === workedOn;
      if (!fresh()) {
        this.emitAgent(id, { kind: 'log', text: `(ignored a stale report for ${taskId}: it was for attempt ${reported}, current is ${this.attemptOf(taskId)})` });
        continue;
      }
      const note = summary.trim().slice(0, 500);
      const kind = outcome.toLowerCase();
      if (kind === 'blocked' || kind === 'partial') {
        // The reason / what's left is saved even when the status is already right.
        const patch: Partial<Task> = kind === 'blocked' ? { status: 'blocked', note: note || 'blocked (no reason given)' } : { status: 'doing', note: note ? `Partly done: ${note}` : '' };
        await this.updateTask(taskId, () => (fresh() ? patch : undefined));
        continue;
      }
      // Already done and checked for this attempt (e.g. a repeated report after it was merged): nothing to redo.
      if (t.status === 'done' && this.doneChecked(t)) {
        settled.add(taskId);
        continue;
      }
      await this.settleDone(id, t, workedOn, note, true);
      settled.add(taskId);
    }
    return settled;
  }

  /**
   * Tasks still stuck at "reported done, but no commits": same project, same attempt, and not since
   * checked or accepted. The App helper looks at these when the owner is idle.
   */
  doneButNoCommits(): { task: string; agent: string; why: string; at: number }[] {
    return Object.entries(this.noCommits)
      .filter(([t, e]) => {
        const cur = this.lastGoodTasks.find((x) => x.id === t);
        return e.root === this.project?.root && cur?.owner === e.agent && cur.status === 'doing' && this.attemptOf(t) === e.attempt && this.doneOk[t] !== e.attempt;
      })
      .map(([task, e]) => ({ task, agent: e.agent, why: e.why, at: e.at }));
  }

  /** This task's "done" was checked for its current attempt. */
  private doneChecked(t: Task): boolean {
    return this.doneOk[t.id] === this.attemptOf(t.id);
  }

  /**
   * Check a "done" for this attempt against git and settle it: done (checked), or back to "doing" with
   * a note saying why. Only this agent's own commits count: since the send-back for a later attempt,
   * and never teammates' work brought in by a sync or merge.
   */
  private async settleDone(id: string, t: Task, attempt: number, note: string, reported: boolean): Promise<void> {
    if (!this.project) return;
    const taskId = t.id;
    const fresh = () => this.attemptOf(taskId) === attempt;
    const areas = Array.isArray(t.files) ? (t.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    const since = attempt > 1 ? this.sentBack[taskId]?.tip : undefined;
    let check: { committed: string[]; uncommitted: string[] } | undefined;
    // A later attempt with no recorded send-back tip can't be told apart from the earlier one.
    if (attempt === 1 || since) {
      try {
        check = await committedChanges(this.project, id, since);
      } catch (e) {
        console.error('done check:', (e as Error).message);
      }
    }
    const inArea = (files: string[]) => (areas.length ? files.filter((f) => areas.some((p) => matches(f, p))) : files);
    // Edits under team/ (outside the repo) the task's files name count as its work too: since the send-back,
    // or, on the first attempt, since the turn that reports it done began (there's no earlier marker to use).
    const sentAt = attempt > 1 ? this.sentBack[taskId]?.at : this.agents.get(id)?.turnStartedAt;
    const teamWork = sentAt && areas.length ? inArea(teamFilesChangedSince(this.project, sentAt)) : [];
    const committed = [...(check ? inArea(check.committed) : []), ...teamWork];
    const verb = reported ? 'reported' : 'marked';
    if (!committed.length) {
      const pending = check ? inArea(check.uncommitted) : [];
      const list = (fs: string[]) => `${fs.slice(0, 5).join(', ')}${fs.length > 5 ? '…' : ''}`;
      const elsewhere = check && areas.length ? check.committed.filter((f) => !committed.includes(f)) : [];
      const why = !check
        ? attempt > 1 && !since
          ? "the app has no record of its branch at the send-back, so it can't tell this attempt's work apart"
          : "the app couldn't check its branch"
        : `its branch has no commits of its own${areas.length ? ` in ${areas.join(', ')}` : ''}${since ? ' since the send-back' : ''}${pending.length ? ` (uncommitted: ${list(pending)}; commit them)` : ''}${elsewhere.length ? ` (its commits only change files outside the task: ${list(elsewhere)})` : ''}`;
      const changed = await this.updateTask(taskId, () => (fresh() ? { status: 'doing', note: `${reported ? 'Reported' : 'Marked'} done, but ${why}.` } : undefined));
      if (changed) {
        this.notice(`${this.nameOf(id)} ${verb} ${taskId} done, but ${why}. It stays "doing" until that's fixed; tell ${this.nameOf(id)} in the team chat if it needs a decision.`);
        this.noCommits[taskId] = { agent: id, why, attempt, at: Date.now(), root: this.project.root };
        this.emit('state');
      }
      return;
    }
    const ok = await this.updateTask(taskId, (cur) =>
      fresh() ? { status: 'done', note: '', ...(!this.handoffText(cur) && note ? { handoff: note } : {}) } : undefined,
    );
    if (!ok || !fresh()) return;
    this.doneOk[taskId] = attempt;
    delete this.noCommits[taskId];
    this.saveMeta();
    this.advanceReviews(); // now it can go to review (or be accepted)
  }

  /**
   * After an agent's turn: settle its tasks marked "done" in tasks.json without a [[done]] report the
   * app accepted. A turn that was running when the task was sent back wrote it for the old attempt, so
   * the task is reopened; otherwise the "done" is checked against git like a report.
   */
  private async settleMarkedDone(id: string, attemptsAtStart: Record<string, number>, settled: Set<string>): Promise<void> {
    for (const t of await this.readTasks()) {
      if (t.owner !== id || t.status !== 'done' || settled.has(t.id) || this.doneChecked(t)) continue;
      const workedOn = attemptsAtStart[t.id] ?? 1;
      if (workedOn !== this.attemptOf(t.id)) {
        await this.updateTask(t.id, (cur) =>
          cur.status === 'done' && !this.doneChecked(cur)
            ? { status: 'doing', note: `Reopened: marked done by a turn from before the send-back (attempt ${this.attemptOf(t.id)} is open)` }
            : undefined,
        );
        continue;
      }
      await this.settleDone(id, t, workedOn, '', false);
    }
  }

  private continueInstruction(t: Task, tasks: Task[] = []): string {
    const handoffs = this.handoffsFor(t, tasks);
    return (
      `AUTOPILOT: keep going. Next unfinished task: ${t.id} "${t.title ?? ''}" [${t.status ?? 'todo'}]. ` +
      'Implement it, run the relevant tests, commit, and set its status to "done" in tasks.json with a short "handoff". ' +
      `Then end your reply with [[done: ${t.id}#${this.attemptOf(t.id)} | done | one-line summary]] (or "| blocked | why" if you can't finish). ` +
      'If you cannot proceed without a decision or a teammate\'s work, set its status to "blocked" with a "note" saying why. ' +
      'Reply with one or two lines of progress.' +
      (handoffs ? `\n\nThis task builds on:\n${handoffs}` : '')
    );
  }

  // ── Task dependencies & hand-offs ─────────────────────────────────────

  private depsOf(t: Task): string[] {
    return Array.isArray(t.after) ? t.after.filter((d): d is string => typeof d === 'string') : [];
  }

  /** Ready = every task it comes "after" is accepted (done, and through review if review is on). */
  private isReady(t: Task, tasks: Task[]): boolean {
    return this.depsOf(t).every((d) => {
      const dep = tasks.find((x) => x.id === d);
      return !dep || this.accepted(dep);
    });
  }

  private handoffText(t: Task): string {
    const h = t.handoff;
    if (!h) return '';
    if (typeof h === 'string') return h;
    if (typeof h === 'object') {
      return Object.entries(h as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
        .join('; ');
    }
    return '';
  }

  /** The hand-off notes of the tasks this one depends on, for the agent picking it up. */
  private handoffsFor(t: Task, tasks: Task[]): string {
    return this.depsOf(t)
      .map((d) => tasks.find((x) => x.id === d))
      .filter((d): d is Task => Boolean(d))
      .map((d) => `- ${d.id} "${d.title ?? ''}" by ${this.nameOf(d.owner ?? '')}: ${this.handoffText(d) || 'no hand-off note left'}`)
      .join('\n');
  }

  /** A task was accepted: start any task that was waiting only on it. */
  private async onTaskAccepted(taskId: string): Promise<void> {
    if (this.acceptedSeen.has(taskId)) return;
    this.acceptedSeen.add(taskId);
    if (this.phase !== 'build') return;
    let tasks = await this.readTasks();
    // It passed review: put the reviewed commit into main now, so the tasks that build on it start from it.
    const owner = tasks.find((t) => t.id === taskId)?.owner;
    const rec = this.reviews[taskId];
    const merged = owner && this.agents.has(owner) && rec?.status === 'passed' ? await this.autoMerge(owner, rec.reviewedTip) : false;
    tasks = await this.readTasks();
    for (const t of tasks) {
      if (!this.depsOf(t).includes(taskId) || !OPEN(t) || !this.isReady(t, tasks) || !t.owner || !this.agents.has(t.owner)) continue;
      const r = this.agents.get(t.owner)!;
      if (this.autopilot) r.loop = { active: true, turns: 0, idle: 0 };
      // Bring its branch up to date with main (now holding that work), unless it's mid-turn.
      let fromMain = '';
      if (merged && t.owner !== owner) {
        if (!r.current) await this.sync(t.owner).catch((e) => console.error('sync:', e));
        else fromMain = ` ${taskId} is merged into main: run \`git merge main\` in your worktree before you start, and use that code (don't copy files from teammates' folders).`;
      }
      this.system(`${t.id} "${t.title ?? ''}" is unblocked (${taskId} accepted); ${this.nameOf(t.owner)} can start it.`);
      void this.enqueue(t.owner, { instruction: this.continueInstruction(t, tasks).replace('AUTOPILOT: keep going.', 'UNBLOCKED:') + fromMain });
    }
  }

  // ── Needs you & private agent messages ────────────────────────────────

  private flagNeedsYou(r: Runtime, text: string): void {
    const options = text
      .match(OPTIONS_RE)?.[1]
      .split('|')
      .map((o) => o.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);
    // The question is the line with @user (and the line before it, if that's where the "?" is), not the whole reply.
    const lines = text.replace(OPTIONS_RE, '').trim().split('\n');
    const at = lines.findIndex((l) => /@user\b/i.test(l));
    const before = at > 0 && !lines[at].includes('?') && /\?\s*$/.test(lines[at - 1]) ? lines[at - 1] + '\n' : '';
    const question = (at < 0 ? lines.join('\n') : before + lines[at]).trim();
    this.needsYou = [
      ...this.needsYou.filter((n) => n.agent !== r.cfg.id),
      { agent: r.cfg.id, name: r.cfg.name, text: question.slice(0, 500), ts: Date.now(), ...(options?.length ? { options } : {}) },
    ];
    this.saveMeta();
    this.emit('state');
  }

  dismissNeedsYou(agent?: string): void {
    this.needsYou = agent ? this.needsYou.filter((n) => n.agent !== agent) : [];
    this.saveMeta();
    this.emit('state');
  }

  /** Deliver an agent's private message to a teammate (capped per message from you). */
  private sendAgentDm(from: string, to: string): void {
    if (this.agentDms >= MAX_AGENT_DMS) {
      this.notice(`Private messages between agents reached the limit of ${MAX_AGENT_DMS} for now. Reply to continue.`);
      return;
    }
    this.agentDms++;
    void this.enqueue(to);
  }

  // ── Ask and wait ──────────────────────────────────────────────────────

  /** Room left for another question since your last message. */
  private canAsk(): boolean {
    return this.askCount < MAX_ASKS;
  }

  /** Register a question. One question per target at a time, so each gets its own turn and answer. */
  private startAsk(from: string, to: string, question: string): void {
    this.askCount++;
    const a: Ask = { id: `q${++this.askSeq}`, from, to, question, at: Date.now(), status: 'queued', askerStop: this.agents.get(from)!.stopGen };
    this.saveMeta(); // the id counter survives a restart
    this.asks.push(a);
    const ahead = this.asks.find((x) => x !== a && x.to === to && x.status === 'open');
    this.emitAgent(from, { kind: 'log', text: `❓ asked ${this.nameOf(to)} (${a.id})${ahead ? `; queued behind ${ahead.id}` : ''}; waiting for the answer` });
    if (!ahead) this.sendAsk(a);
    this.emit('state');
  }

  /** Sent once, in a turn of its own. If it can't be answered the asker is told; never resent blindly. */
  private sendAsk(a: Ask): void {
    a.status = 'open';
    a.timer = setTimeout(() => this.expireAsk(a), ASK_TIMEOUT_MS);
    void this.enqueue(a.to, {
      askId: a.id,
      instruction:
        `QUESTION from ${this.nameOf(a.from)} (${a.id}), who is waiting for your answer before continuing:\n${a.question.slice(0, 4000)}\n\n` +
        'Answer it directly and concisely in this reply; it goes back to them. Say plainly if you cannot answer.',
    });
  }

  /** A question is done (answered, failed, expired, cancelled): send the target's next one, if any. */
  private settleAsk(a: Ask, status: Ask['status'], promote = true): void {
    a.status = status;
    clearTimeout(a.timer);
    const next = promote && this.asks.find((x) => x.to === a.to && x.status === 'queued');
    if (next) this.sendAsk(next);
    this.emit('state');
  }

  /** Resume the asker with the outcome, unless you stopped it since it asked. */
  private resumeAsker(a: Ask, instruction: string): void {
    const asker = this.agents.get(a.from);
    if (!asker || asker.stopGen !== a.askerStop) return;
    // If the asker was itself answering someone when it asked, that answer is still owed.
    const owes = this.asks.find((x) => x.status === 'open' && x.to === a.from && x.nested);
    void this.enqueue(a.from, { public: !owes, ...(owes ? { askId: owes.id } : {}), instruction });
  }

  private answerAsk(a: Ask, answer: string): void {
    this.settleAsk(a, 'answered');
    const by = this.nameOf(a.to);
    this.emitAgent(a.from, { kind: 'log', text: answer ? `✔ ${by} answered ${a.id}` : `✖ ${by} couldn't answer ${a.id}` });
    this.resumeAsker(
      a,
      answer
        ? `ANSWER from ${by} to your question (${a.id}):\n${answer.slice(0, 6000)}\n\nContinue your work with this.`
        : `${by} couldn't answer your question (${a.id}). Continue without it, ask someone else, or ask the user (@user).`,
    );
  }

  /** The agent being asked can't answer (stopped, failed, timed out): tell its askers so they don't wait. */
  private failAsksTo(id: string, why: string): void {
    // All of them fail together, so none is promoted (that would start a turn on an agent just stopped).
    for (const a of this.asks.filter((x) => (x.status === 'open' || x.status === 'queued') && x.to === id)) {
      this.settleAsk(a, 'failed', false);
      this.resumeAsker(a, `${this.nameOf(id)} couldn't answer your question (${a.id}): ${why}. Continue without it, ask someone else, or ask the user (@user).`);
    }
  }

  /** A question's turn for an agent that is away (off or out of usage): the asker is told now, not at expiry. */
  private failAskAway(r: Runtime, plan: TurnPlan): void {
    const a = plan.askId ? this.asks.find((x) => x.id === plan.askId && x.status === 'open') : undefined;
    if (!a) return;
    this.settleAsk(a, 'failed');
    this.resumeAsker(a, `${r.cfg.name} is ${this.unavailableReason(r)}, so it can't answer your question (${a.id}). Continue without it, ask someone else, or ask the user (@user).`);
  }

  /** You stopped the asker (or everyone): its questions are withdrawn and nothing restarts it. */
  private cancelAsksFrom(id?: string): void {
    for (const a of this.asks.filter((x) => (x.status === 'open' || x.status === 'queued') && (!id || x.from === id))) this.settleAsk(a, 'failed');
  }

  private expireAsk(a: Ask): void {
    if (a.status !== 'open') return;
    // Being answered right now, or its turn is next in line: give it time rather than releasing the asker early.
    const target = this.agents.get(a.to);
    if (target?.answering === a.id || target?.nextAsk?.askId === a.id) {
      a.timer = setTimeout(() => this.expireAsk(a), ASK_TIMEOUT_MS);
      return;
    }
    this.settleAsk(a, 'expired');
    this.system(`${this.nameOf(a.to)} didn't answer ${this.nameOf(a.from)}'s question (${a.id}) within ${ASK_TIMEOUT_MS / 60_000} min.`);
    this.resumeAsker(
      a,
      `No answer from ${this.nameOf(a.to)} to your question (${a.id}) after ${ASK_TIMEOUT_MS / 60_000} min. Continue without it, or ask the user (@user). Don't ask the same question again unless something changed.`,
    );
  }

  /**
   * After a BUILD turn: give the agent another turn if it still has open tasks and is making progress.
   * Stops on: all its tasks done/blocked, no progress for AUTOPILOT_IDLE_LIMIT turns, or the turn cap.
   */
  private async continueLoop(r: Runtime, before: string | undefined): Promise<void> {
    const loop = r.loop;
    if (!loop.active || !this.autopilot || this.phase !== 'build' || !this.project) return;
    // Waiting for a teammate's answer: the answer starts its next turn.
    if (this.asks.some((a) => (a.status === 'open' || a.status === 'queued') && a.from === r.cfg.id)) return;
    const name = r.cfg.name;
    loop.turns++;
    const tasks = await this.readTasks();
    const mine = tasks.filter((t) => t.owner === r.cfg.id);
    const next = mine.find((t) => OPEN(t) && this.isReady(t, tasks));
    const waiting = mine.filter((t) => OPEN(t) && !this.isReady(t, tasks));
    const after = await workSnapshot(this.project, r.cfg.id).catch(() => undefined);
    const statusKey = JSON.stringify(mine.map((t) => [t.id, t.status]));
    loop.idle = before !== undefined && after !== undefined && before === after + statusKey ? loop.idle + 1 : 0;

    if (!next && waiting.length) {
      // Not stuck, just waiting: it restarts on its own when the dependency is accepted.
      loop.active = false;
      const on = (t: Task) => this.depsOf(t).filter((d) => !this.accepted(tasks.find((x) => x.id === d) ?? ({ id: d, status: 'done' } as Task)));
      this.system(`${name} is waiting: ${waiting.map((t) => `${t.id} needs ${on(t).join(', ')}`).join('; ')}. It resumes when those are accepted.`);
    } else if (!next) {
      loop.active = false;
      const blocked = mine.filter((t) => t.status === 'blocked');
      if (blocked.length) this.notice(`${name} is blocked: ${blocked.map((t) => `${t.id}${t.note ? ` (${t.note})` : ''}`).join(', ')}. Reply to unblock it.`);
      else if (mine.length) this.system(`${name} finished all its tasks.`);
      this.checkAllDone(tasks);
    } else if (loop.idle >= AUTOPILOT_IDLE_LIMIT) {
      loop.active = false;
      loop.stopped = `paused after ${AUTOPILOT_IDLE_LIMIT} turns without progress; reply to it`;
      this.notice(`${name} made no progress in ${AUTOPILOT_IDLE_LIMIT} turns, so autopilot paused it. Check its panel or reply to it.`);
    } else if (loop.turns >= AUTOPILOT_MAX_TURNS) {
      loop.active = false;
      loop.stopped = `paused at the ${AUTOPILOT_MAX_TURNS}-turn autopilot limit; toggle Autopilot`;
      this.notice(`${name} reached the autopilot limit of ${AUTOPILOT_MAX_TURNS} turns. Toggle Autopilot to continue.`);
    } else {
      void this.enqueue(r.cfg.id, { instruction: this.continueInstruction(next!, tasks) });
    }
    this.emit('state');
  }

  /** When every task is done, hand off to the leader (or tell the user) once. */
  private checkAllDone(tasks: Task[]): void {
    if (this.allDoneAnnounced || !tasks.length || !tasks.every((t) => this.accepted(t))) return;
    this.allDoneAnnounced = true;
    const owners = [...new Set(tasks.map((t) => t.owner).filter((o): o is string => Boolean(o && this.agents.has(o))))];
    // Reviewed work is merged by the app; only unreviewed work (review off) still needs a decision.
    if (owners.length && owners.every((o) => this.branchAccepted(o, tasks))) {
      void Promise.all(owners.map((o) => this.autoMerge(o))).then((ok) => {
        if (ok.every(Boolean)) this.system('✓ All tasks are done, reviewed and merged into main. The project is finished.');
      });
      return;
    }
    this.system(this.pipelineFor('').length ? 'All tasks are done and accepted.' : 'All tasks in tasks.json are done.');
    if (this.leader !== 'user') {
      void this.enqueue(this.leader, {
        instruction:
          'All BUILD tasks are done. Check each teammate\'s branch (git log/diff main...agent/<id>), then request merges with [[merge: <id>]] for the ones that are ready, and [[phase: review]] when done.',
      });
    } else {
      this.notice('Review the branches and merge, or switch to Review.');
    }
  }

  /** Snapshot of work + this agent's task statuses, taken before a BUILD turn. */
  private async loopSnapshot(r: Runtime): Promise<string | undefined> {
    if (!r.loop.active || this.phase !== 'build' || !this.project) return undefined;
    try {
      const mine = (await this.readTasks()).filter((t) => t.owner === r.cfg.id);
      return (await workSnapshot(this.project, r.cfg.id)) + JSON.stringify(mine.map((t) => [t.id, t.status]));
    } catch {
      return undefined;
    }
  }

  private async readTasks(): Promise<Task[]> {
    const project = this.project;
    if (!project) return [];
    const file = join(project.teamDir, 'tasks.json');
    const readNo = ++this.tasksReadSeq;
    const raw = (await readTeamFiles(project)).tasks;
    // The project was switched while reading: don't let its tasks or errors leak into the new one.
    if (this.project !== project) return [];
    // A newer read already finished: don't roll the cached list or the warning state back.
    if (readNo < this.tasksReadDone) return this.lastGoodTasks;
    this.tasksReadDone = readNo;
    // A new project starts with {"tasks": []}, so only a missing file means "no tasks";
    // an empty one (e.g. a failed PowerShell rewrite) is broken.
    if (!raw.trim() && !existsSync(file)) return [];
    try {
      const tasks = JSON.parse(raw).tasks;
      this.tasksParseSince = 0;
      this.tasksParseAnnounced = false;
      this.lastGoodTasks = Array.isArray(tasks) ? tasks.filter((t: any) => t && typeof t.id === 'string') : [];
      return this.lastGoodTasks;
    } catch (err) {
      // An agent may be mid-rewrite. Keep working from the last list that parsed (an empty list
      // would stop autopilot and tell agents they own nothing), and if it's still broken a few
      // seconds later, tell everyone once per broken spell.
      const msg = (err as Error).message;
      if (!this.tasksParseSince) {
        this.tasksParseSince = Date.now();
        setTimeout(() => void this.readTasks(), TASKS_PARSE_GRACE_MS + 500);
      } else if (!this.tasksParseAnnounced && Date.now() - this.tasksParseSince >= TASKS_PARSE_GRACE_MS) {
        this.tasksParseAnnounced = true;
        this.system(
          `${file} isn't valid JSON (${msg}). The app keeps using the last valid task list until it's fixed. ` +
            `${this.nameOf(this.leader)}, please repair it with your file-edit tool (plain UTF-8, not PowerShell Set-Content or >).`,
        );
      }
      return this.lastGoodTasks;
    }
  }

  setGates(on: boolean): void {
    this.gates = on;
    this.system(on ? 'Approval gates on: leader phase changes and merges need your OK.' : 'Approval gates off: leader requests apply immediately.');
    this.saveMeta();
    this.emit('state');
  }

  setSettings(id: string, patch: Partial<AgentSettings>): void {
    const r = this.agents.get(id);
    if (!r) throw new Error(`Unknown agent ${id}`);
    const next = { ...r.settings };
    if (patch.model !== undefined) {
      if (typeof patch.model !== 'string' || !SAFE_MODEL.test(patch.model)) throw new Error('Model id: letters, digits, . _ : / [ ] - only');
      next.model = patch.model || r.cfg.model || '';
    }
    if (patch.effort !== undefined) {
      if (typeof patch.effort !== 'string' || !SAFE_ID.test(patch.effort)) throw new Error('Effort: letters, digits, . _ : - only');
      next.effort = patch.effort || r.cfg.effort || '';
    }
    // A new model may not accept the current effort (the turn would fail).
    next.effort = r.cfg.server ? '' : fitEffort(r.cfg.adapter, next.model, next.effort, r.cfg.effort);
    // Remembered so a model that turns out to need paid credits can be switched back.
    if (next.model !== r.settings.model) r.prevModel = r.settings.model;
    if (patch.autonomy !== undefined) {
      if (!AUTONOMY.includes(patch.autonomy)) throw new Error('Bad autonomy level');
      next.autonomy = patch.autonomy;
    }
    r.settings = next;
    this.saveMeta();
    this.emit('state');
  }

  /** Kill the running turn and drop anything queued for this agent. */
  stop(id: string): void {
    const r = this.agents.get(id);
    if (!r) return;
    r.stopGen++;
    r.next = {};
    r.nextAsk = undefined;
    r.hasNext = false;
    r.loop.active = false;
    r.loop.stopped = 'stopped by you';
    if (r.current) {
      r.killReason = 'stopped';
      r.stopping = true;
      r.current.kill();
    }
    // Stopped on purpose: a restart mustn't offer to continue it.
    if (this.resumeOffer) {
      const without = (ids: string[]) => ids.filter((x) => x !== id);
      const { working, looping } = this.resumeOffer;
      this.resumeOffer = { ...this.resumeOffer, working: without(working), looping: without(looping) };
      if (!this.resumeOffer.working.length && !this.resumeOffer.looping.length) this.resumeOffer = undefined;
    }
    this.saveMeta();
    // Its own questions are withdrawn; questions to it (even ones not started yet) fail, and their askers are told.
    this.cancelAsksFrom(id);
    this.failAsksTo(id, 'it was stopped');
    this.emit('state');
  }

  /** Any agent running or queued (a restart would cut it off). */
  busy(): boolean {
    return [...this.agents.values()].some((r) => r.current || r.pending);
  }

  /** Recent problems shown to the user (failures, timeouts, warnings), for the App helper. */
  recentIssues(): string[] {
    return this.messages.filter((m) => m.from === 'system' && m.to === 'user').map((m) => m.text);
  }

  stopAll(): void {
    if (this.desktopRun) this.cancelDesktopTests();
    if (this.debating) this.debateCancelled = true;
    this.discussionGen++; // ends any plan-phase discussion rounds
    // Withdraw every question first, so stopping one agent can't restart another with a "no answer" turn.
    this.cancelAsksFrom();
    for (const id of this.agents.keys()) this.stop(id);
  }

  // ── Roles & saved setups ──────────────────────────────────────────────

  setRolesEnabled(on: boolean): void {
    this.roles.enabled = on;
    this.system(on ? 'Roles on: each agent gets its role with every turn.' : 'Roles off: agents have no assigned jobs.');
    this.saveMeta();
    this.emit('state');
  }

  setRole(id: string, assignment: unknown): void {
    if (!this.agents.has(id)) throw new Error(`Unknown agent ${id}`);
    this.roles.assignments[id] = cleanAssignment(assignment);
    this.saveMeta();
    this.emit('state');
  }

  setReviewMode(mode: ReviewMode): void {
    if (!REVIEW_MODES.includes(mode)) throw new Error('Unknown review mode');
    this.reviewMode = mode;
    const label = { off: 'off', chain: 'role chain (builder → first reviewer → final reviewer)', cross: 'any other agent reviews once' }[mode];
    this.system(`Review of finished tasks: ${label}.`);
    this.saveMeta();
    this.emit('state');
  }

  setDesktopTestCommand(cmd: string): void {
    this.desktopTestCommand = String(cmd).trim().slice(0, 300);
    this.system(
      this.desktopTestCommand
        ? `Finished tasks also wait for the desktop tests (\`${this.desktopTestCommand}\`), which run when you press Run now.`
        : 'No desktop tests for finished tasks.',
    );
    if (!this.desktopTestCommand) {
      // Nothing to wait for any more: stop a run and move waiting tasks on.
      if (this.desktopRun) this.cancelDesktopTests(true);
      for (const id of [...this.desktopWaiting.keys()]) void this.finishDesktop(id, 'approve', 'Skipped: desktop tests were turned off.');
    }
    this.saveMeta();
    this.emit('state');
  }

  /**
   * Run the desktop tests for a waiting task. From you: now. From the App helper: after a countdown you
   * can cancel (the banner shows it), since they take over the mouse.
   */
  runDesktopTests(taskId: string, by: 'user' | 'helper'): void {
    if (!this.project) throw new Error('No project open');
    if (!this.desktopCurrent(taskId)) throw new Error(`${taskId} isn't waiting for desktop tests`);
    if (Orchestrator.desktopKill) throw new Error('Desktop tests are still running');
    if (this.desktopRun) throw new Error(`Desktop tests for ${this.desktopRun.task} are already ${this.desktopRun.running ? 'running' : 'about to start'}`);
    const delay = by === 'helper' ? DESKTOP_COUNTDOWN_MS : 0;
    const run: { task: string; startsAt: number; running: boolean; by: 'user' | 'helper'; timer?: NodeJS.Timeout } = {
      task: taskId,
      startsAt: Date.now() + delay,
      running: false,
      by,
    };
    this.desktopRun = run;
    if (by === 'helper')
      this.system(`The App helper starts the desktop tests for ${taskId} in ${Math.round(delay / 1000)} seconds; they'll move the mouse. Press Cancel above the chat to stop it.`);
    run.timer = setTimeout(() => void this.startDesktop(run), delay);
    this.emit('state');
  }

  cancelDesktopTests(quiet = false): void {
    const run = this.desktopRun;
    if (!run) return;
    clearTimeout(run.timer);
    // Already running: end the command (its result is dropped; the task waits for Run now again).
    if (run.running) Orchestrator.desktopKill?.();
    this.desktopRun = undefined;
    if (!quiet) this.system(`Desktop tests for ${run.task} cancelled; they wait for Run now.`);
    this.emit('state');
  }

  /** Accept the task without its desktop tests (only you can do this, not the App helper). */
  skipDesktopTests(taskId: string): void {
    if (!this.desktopCurrent(taskId)) throw new Error(`${taskId} isn't waiting for desktop tests`);
    if (this.desktopRun?.task === taskId) throw new Error('They are already running or about to start; Cancel first');
    void this.finishDesktop(taskId, 'approve', 'Skipped by you.');
  }

  private async startDesktop(run: { task: string; startsAt: number; running: boolean; by: 'user' | 'helper'; timer?: NodeJS.Timeout }): Promise<void> {
    if (this.desktopRun !== run || !this.project) return;
    const gen = this.gen;
    const tasks = await this.readTasks();
    const t = tasks.find((x) => x.id === run.task);
    if (gen !== this.gen || this.desktopRun !== run) return;
    const token = this.desktopWaiting.get(run.task);
    if (!t || !this.desktopCurrent(run.task) || Orchestrator.desktopKill) {
      this.desktopRun = undefined;
      this.emit('state');
      return;
    }
    const owner = t.owner ?? '';
    const dir = this.project.agentDirs[owner] ?? this.project.repoDir;
    if (this.project.agentDirs[owner]) void this.ensureSetup(owner, dir, owner);
    await Promise.all(this.pendingSetup([dir])).catch(() => {});
    if (this.desktopRun !== run || gen !== this.gen) return;
    // The helper's run: check again right before the mouse moves (you may be back since the countdown began).
    if (run.by === 'helper') {
      const idle = await idleSeconds();
      if (this.desktopRun !== run || gen !== this.gen) return;
      if (idle === undefined || idle < Number(process.env.TTS_DESKTOP_IDLE_S ?? 120)) {
        this.desktopRun = undefined;
        this.system(
          idle === undefined
            ? `Desktop tests for ${t.id} not started: the app couldn't tell whether this computer is in use. They wait for Run now.`
            : `Desktop tests for ${t.id} not started: this computer is in use again. They wait for Run now.`,
        );
        this.emit('state');
        return;
      }
    }
    run.running = true;
    this.emit('state');
    // Approved, sent back or cancelled in the moments before this: don't start.
    if (this.desktopRun !== run || !this.desktopCurrent(t.id)) {
      if (this.desktopRun === run) this.desktopRun = undefined;
      this.emit('state');
      return;
    }
    this.system(`${t.id} → running desktop tests: \`${this.desktopTestCommand}\` (hands off the mouse until they finish).`);
    let result: { ok: boolean; output: string };
    try {
      result = await runTests(this.desktopTestCommand, dir, (kill) => {
        Orchestrator.desktopKill = kill;
        // Cancelled between the check above and the start: end it at once.
        if (this.desktopRun !== run) kill();
      });
    } catch (e) {
      result = { ok: false, output: (e as Error).message };
    } finally {
      Orchestrator.desktopKill = undefined;
    }
    const cancelled = this.desktopRun !== run;
    if (!cancelled) this.desktopRun = undefined;
    if (gen !== this.gen) return;
    if (cancelled) {
      this.emit('state');
      return;
    }
    await this.finishDesktop(t.id, result.ok ? 'approve' : 'changes', result.ok ? 'Desktop tests passed.' : result.output, token);
  }

  private async finishDesktop(taskId: string, verdict: 'approve' | 'changes', notes: string, entry = this.desktopWaiting.get(taskId)): Promise<void> {
    // Only for the same review round and stage it was started for: a restart, send-back or approval since makes it stale.
    this.reviewQueue = this.reviewQueue
      .then(() => {
        // A result for an earlier entry (restarted, sent back, done again since) changes nothing.
        if (!entry || this.desktopWaiting.get(taskId) !== entry) return;
        this.desktopWaiting.delete(taskId);
        this.emit('state');
        if (entry.split('#')[0] === this.desktopToken(taskId)) return this.applyVerdict(taskId, 'desktop', 'desktop', verdict, notes);
      })
      .catch(console.error);
    await this.reviewQueue;
  }

  /** Desktop tests waiting for Run now, for the App helper's view (none while a run is counting down or running). */
  desktopTestsWaiting(): string[] {
    // One at a time (they share the mouse): when it's done, the next one is a new item for the helper.
    if (this.desktopRun || Orchestrator.desktopKill) return [];
    const next = [...this.desktopWaiting.keys()].find((id) => this.desktopCurrent(id));
    return next ? [next] : [];
  }

  /** The review round and stage a task's desktop tests belong to, or undefined if it isn't at that stage now. */
  private desktopToken(taskId: string): string | undefined {
    const rec = this.reviews[taskId];
    if (!rec || rec.status !== 'in_review' || rec.stages[rec.stage] !== 'desktop') return undefined;
    return `${rec.rounds}:${rec.stage}:${rec.roundStart ?? 0}:${rec.history.length}`;
  }

  /** Still waiting at the same desktop stage it was queued for; drops it (and a countdown for it) when not. */
  private desktopCurrent(taskId: string): boolean {
    const want = this.desktopWaiting.get(taskId);
    if (want !== undefined && want.split('#')[0] === this.desktopToken(taskId)) return true;
    if (want !== undefined) {
      this.desktopWaiting.delete(taskId);
      // Approved, sent back or restarted meanwhile: a countdown or a running command for it ends now.
      if (this.desktopRun?.task === taskId) this.cancelDesktopTests(true);
    }
    return false;
  }

  setTestCommand(cmd: string): void {
    this.testCommand = String(cmd).trim().slice(0, 300);
    this.system(this.testCommand ? `Tasks are accepted only after \`${this.testCommand}\` passes.` : 'No test step for finished tasks.');
    this.saveMeta();
    this.emit('state');
  }

  /** Apply a saved setup: roles, leader, review mode and any model overrides, all at once. */
  applyPreset(name: string): void {
    const preset = loadPresets().find((p) => p.name === name);
    if (!preset) throw new Error(`No saved setup called "${name}"`);
    this.roles = { enabled: true, assignments: {} };
    for (const id of this.agents.keys()) this.roles.assignments[id] = cleanAssignment(preset.roles[id] ?? { role: 'none' });
    if (preset.leader && (preset.leader === 'user' || this.agents.has(preset.leader))) this.leader = preset.leader;
    if (preset.review && REVIEW_MODES.includes(preset.review)) this.reviewMode = preset.review;
    for (const [id, model] of Object.entries(preset.models ?? {})) {
      if (this.agents.has(id)) this.setSettings(id, { model });
    }
    this.limitHit = undefined;
    const who = [...this.agents.keys()]
      .map((id) => `${this.nameOf(id)}: ${ROLE_LABELS[this.roles.assignments[id].role]}`)
      .join(', ');
    this.system(`Setup "${name}" applied. ${who}. Leader: ${this.nameOf(this.leader)}. Takes effect from each agent's next turn.`);
    this.saveMeta();
    this.emit('state');
  }

  /** Save the current roles/leader/review mode (and each agent's model) as a named setup. */
  savePreset(name: string): void {
    const clean = String(name).trim().slice(0, 60);
    if (!clean) throw new Error('Give the setup a name');
    const preset: Preset = {
      name: clean,
      roles: { ...this.roles.assignments },
      leader: this.leader,
      review: this.reviewMode,
      models: Object.fromEntries([...this.agents.values()].filter((r) => r.settings.model).map((r) => [r.cfg.id, r.settings.model])),
    };
    savePresets([...loadPresets().filter((p) => p.name !== clean), preset]);
    this.system(`Saved setup "${clean}".`);
    this.emit('state');
  }

  deletePreset(name: string): void {
    savePresets(loadPresets().filter((p) => p.name !== name));
    this.emit('state');
  }

  dismissLimit(): void {
    this.limitHit = undefined;
    this.emit('state');
  }

  /**
   * After a restart: Continue gives each agent whose turn was cut off a turn to pick it back up (in its
   * own CLI session, so it remembers), restarts autopilot, and asks again for reviews that were in progress.
   */
  async resumeAction(action: 'continue' | 'dismiss'): Promise<void> {
    const offer = this.resumeOffer;
    this.resumeOffer = undefined;
    // A reviewer being resumed finishes its own review (its instruction is resent); any other review whose
    // reviewer was cut off is asked again, so it can't wait forever.
    const resuming = new Set(action === 'continue' ? (offer?.working ?? []) : []);
    let reset = false;
    for (const e of Object.values(this.reviews))
      if (e.status === 'in_review' && e.waitingOn && !isMachineStage(e.stages[e.stage]) && !resuming.has(e.waitingOn) && this.agents.get(e.waitingOn)?.status !== 'working') {
        e.waitingOn = undefined;
        reset = true;
      }
    if (reset && this.project) void saveReviews(this.project.teamDir, this.reviews);
    // Dismissed: those agents stay paused (autopilot doesn't pick them up again on its own).
    if (offer && action === 'dismiss') {
      for (const id of new Set([...offer.working, ...offer.looping])) {
        const r = this.agents.get(id);
        if (r && !r.loop.active) r.loop.stopped = 'paused: you dismissed Continue after the restart; toggle Autopilot to resume';
      }
    }
    this.saveMeta();
    this.emit('state');
    if (!offer || action === 'dismiss') return;
    // After a crash the old CLI can still be running in the same worktree: end it before starting again.
    await Promise.all(offer.working.map((id) => endLeftoverProcess(offer.pids[id])));
    for (const id of offer.working) {
      const was = offer.instructions[id];
      void this.enqueue(id, { instruction: was ? `${RESUME_NOTE}\n\nThe instruction for that cut-off turn was:\n\n${was}` : RESUME_NOTE });
    }
    if (offer.looping.length && this.autopilot && this.phase === 'build') void this.startLoops(offer.looping, offer.working);
    this.reviewQueue = this.reviewQueue.then(() => this.dispatchParked()).catch(console.error);
  }

  private roleOf(id: string): RoleAssignment {
    return this.roles.enabled ? this.roles.assignments[id] ?? { role: 'none' } : { role: 'none' };
  }

  /** "Your role: …" line for the turn header, so a role change applies from the next turn. */
  private roleLine(id: string): string {
    const a = this.roleOf(id);
    const duty = dutyOf(a);
    return duty ? `Your role: ${ROLE_LABELS[a.role]}. ${duty}` : '';
  }

  /**
   * A usage-limit failure: mark the agent out until its reset time (from the message), skip it for
   * turns, reviews and hand-offs meanwhile, and offer to switch setups. With no reset time it stays
   * out until you click Try now (or message it directly and it answers), rather than retrying blindly.
   */
  private noteLimit(r: Runtime, message: string): void {
    if (classifyFailure(message) !== 'limit') return;
    const reset = parseResetTime(message);
    r.outUntil = reset && reset > Date.now() ? reset : OUT_OPEN;
    r.loop.active = false;
    const until = r.outUntil === OUT_OPEN ? 'you click Try now in its panel (its message gives no reset time)' : clockTime(r.outUntil);
    const reviews = Object.entries(this.reviews).filter(([, e]) => e.status === 'in_review' && e.waitingOn === r.cfg.id).map(([id]) => id);
    const waiting = this.lastGoodTasks.filter((t) => t.owner === r.cfg.id && OPEN(t)).map((t) => t.id);
    const moved = reviews.length ? ` Its review of ${reviews.join(', ')} goes to a teammate.` : '';
    if (waiting.length) {
      // Its own tasks wait for it: offer to switch to a setup that gives them to someone else.
      this.limitHit = { agent: r.cfg.id, name: r.cfg.name, text: message.slice(0, 200) };
      this.notice(`${r.cfg.name} is out of usage until ${until}.${moved} Its tasks (${waiting.join(', ')}) wait until then and continue on their own, or switch to another saved setup above.`);
    } else {
      // Nothing waits for it: the app works around it.
      this.system(`${r.cfg.name} is out of usage until ${until}.${moved} Nothing to do: it rejoins on its own.`);
    }
    this.releaseReviewsOf(r.cfg.id);
    this.saveMeta();
    this.emit('state');
  }

  // ── Availability (switched off / out of usage) ───────────────────────

  private available(id: string): boolean {
    const r = this.agents.get(id);
    return Boolean(r && !r.disabled && !(r.outUntil && r.outUntil > Date.now()));
  }

  private unavailableReason(r: Runtime): string {
    return r.disabled ? 'switched off' : `out of usage until ${clockTime(r.outUntil!)}`;
  }

  private noteSkipped(r: Runtime): void {
    if (r.skipNoticeAt && Date.now() - r.skipNoticeAt < 10 * 60_000) return;
    r.skipNoticeAt = Date.now();
    this.emitAgent(r.cfg.id, { kind: 'log', text: `(skipped: ${this.unavailableReason(r)})` });
  }

  /** Reviews waiting on an agent that just became unavailable go back in line for another reviewer. */
  private releaseReviewsOf(id: string): void {
    let changed = false;
    for (const e of Object.values(this.reviews)) {
      if (e.status === 'in_review' && e.waitingOn === id) {
        e.waitingOn = undefined;
        changed = true;
      }
    }
    if (!changed) return;
    this.saveReviewState();
    this.reviewQueue = this.reviewQueue.then(() => this.dispatchParked()).catch(console.error);
  }

  private newRuntime(cfg: AgentConfig): Runtime {
    return {
      cfg,
      adapter: createAdapter(cfg, this.mock),
      settings: this.defaultSettings(cfg),
      lastSeen: 0,
      status: 'idle',
      stopGen: 0,
      pending: false,
      next: {},
      totals: emptyTotals(),
      loop: { active: false, turns: 0, idle: 0 },
      scopeWarned: new Set(),
      disabled: false,
      chain: Promise.resolve(),
    };
  }

  /** The agent list as Setup edits it (agents.config.json entries). */
  agentConfigs(): AgentConfig[] {
    return [...this.agents.values()].map((r) => r.cfg);
  }

  /**
   * Replace the team (Setup → Agents) while nobody is working: new agents get their own copy of the
   * project, removed ones stop taking turns (their branch and copy stay on disk). Already validated.
   */
  async setAgentConfigs(configs: AgentConfig[], persist: () => void): Promise<string[]> {
    if (this.savingTeam) throw new Error('Already saving the team; wait a moment.');
    // Taken before any await: turns and project switches wait for the save (runTurn, open()).
    this.savingTeam = true;
    try {
      // A turn counts as busy from when it's queued (its chain hasn't settled), not only once it runs.
      const unsettled = async (p: Promise<unknown>) => Promise.race([p.then(() => false, () => false), Promise.resolve().then(() => true)]);
      const busy: string[] = [];
      for (const r of this.agents.values()) if (r.status === 'working' || r.loop.active || r.pending || (await unsettled(r.chain))) busy.push(r.cfg.name);
      if (busy.length || this.debating) throw new Error(`Wait until no agent is working (${busy.join(', ') || 'debate running'}), or press Stop all, then save again.`);
      const before = new Map(this.agents);
      const removed = [...before.values()].filter((r) => !configs.some((c) => c.id === r.cfg.id));
      const added = configs.filter((c) => !before.has(c.id));
      // Prepare first (copies of the project for new agents, then the file); nothing changes if either fails.
      const project = this.project ? await openProject(this.project.name, configs.map((c) => c.id)) : undefined;
      persist();
      const next = new Map<string, Runtime>();
      const changedProgram: { id: string; adapterChanged: boolean }[] = [];
      for (const cfg of configs) {
        const old = before.get(cfg.id);
        if (!old) {
          next.set(cfg.id, this.newRuntime(cfg));
          continue;
        }
        if (programKey(old.cfg) === programKey(cfg)) {
          old.cfg = cfg;
          next.set(cfg.id, old);
          continue;
        }
        // Another program (or its options): keep the counters and place in the chat, start a new conversation.
        const r = this.newRuntime(cfg);
        Object.assign(r, { totals: old.totals, lastSeen: old.lastSeen, disabled: old.disabled });
        // "Out of usage" was the old program's (or OpenAI's) limit, not the new one's.
        if (this.limitHit?.agent === cfg.id) this.limitHit = undefined;
        // Stopped by you (or paused) stays stopped: autopilot mustn't pick the new runtime up on its own.
        r.loop = { active: false, turns: 0, idle: 0, ...(old.loop.stopped ? { stopped: old.loop.stopped } : {}) };
        // A new kind of program, or a model server added/removed/moved: the old model id means nothing there.
        changedProgram.push({ id: cfg.id, adapterChanged: old.cfg.adapter !== cfg.adapter || (old.cfg.server ?? '') !== (cfg.server ?? '') });
        // A model server added, removed or moved: its models differ, so the new runtime keeps cfg's model.
        if (old.cfg.adapter === cfg.adapter && (old.cfg.server ?? '') === (cfg.server ?? '')) r.settings = old.settings;
        next.set(cfg.id, r);
      }
      this.agents = next;
      if (project && this.project?.name === project.name) {
        this.project = project;
        for (const c of added) void this.ensureSetup(c.id, project.agentDirs[c.id], c.id);
      }
      for (const r of removed) this.releaseReviewsOf(r.cfg.id);
      if (changedProgram.length) await this.forgetSessionsElsewhere(changedProgram);
      const notes: string[] = [];
    if (removed.length) {
      const names = removed.map((r) => r.cfg.name).join(', ');
      if (removed.some((r) => r.cfg.id === this.leader)) {
        this.leader = 'user';
        notes.push('You are the leader now');
      }
      for (const r of removed) delete this.roles.assignments[r.cfg.id];
      this.needsYou = this.needsYou.filter((n) => this.agents.has(n.agent));
      const owned = this.lastGoodTasks.filter((t) => removed.some((r) => r.cfg.id === t.owner) && !this.accepted(t)).map((t) => t.id);
      notes.push(`Removed ${names}${owned.length ? `; give its open tasks (${owned.join(', ')}) a new owner in team/tasks.json` : ''}`);
    }
    if (added.length) notes.push(`Added ${added.map((c) => c.name).join(', ')}`);
      this.saveMeta();
      if (notes.length) this.system(`Team changed: ${notes.join('. ')}.`);
      this.emit('state');
      return notes;
    } finally {
      this.savingTeam = false;
    }
  }

  /**
   * An agent's program changed: its conversations in the other projects belong to the old program, so
   * drop them (and the old model, for another kind of program). Best effort; a project that can't be
   * read is left alone and its fingerprint check catches it on open.
   */
  private async forgetSessionsElsewhere(changed: { id: string; adapterChanged: boolean }[]): Promise<void> {
    for (const name of await listProjects().catch(() => [] as string[])) {
      if (name === this.project?.name) continue;
      const file = join(projectsRoot(), name, 'team', 'session.json');
      try {
        if (!existsSync(file)) continue;
        const meta = JSON.parse(readFileSync(file, 'utf8'));
        let dirty = false;
        for (const c of changed) {
          const s = meta.agents?.[c.id];
          if (!s) continue;
          delete s.sessionId;
          delete s.program;
          delete s.outUntil;
          if (c.adapterChanged) delete s.settings;
          dirty = true;
        }
        if (dirty) writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
      } catch (e) {
        console.error(`Couldn't update ${file}: ${(e as Error).message}`);
      }
    }
  }

  /** Switch an agent on or off. Off stops its turn and hands its pending reviews to others. */
  setAgentEnabled(id: string, on: boolean): void {
    const r = this.agents.get(id);
    if (!r) throw new Error(`Unknown agent ${id}`);
    if (r.disabled === !on) return;
    r.disabled = !on;
    r.skipNoticeAt = undefined;
    if (!on) {
      this.stop(id);
      this.system(`${r.cfg.name} switched off: no turns, reviews or hand-offs until you switch it back on.`);
      this.releaseReviewsOf(id);
    } else {
      this.system(`${r.cfg.name} switched back on.`);
      this.comeBack(r);
    }
    this.saveMeta();
    this.emit('state');
  }

  /** "Try now": clear an out-of-usage mark early (e.g. you upgraded or the limit reset sooner). */
  clearOutOfUsage(id: string): void {
    const r = this.agents.get(id);
    if (!r?.outUntil) return;
    r.outUntil = undefined;
    r.skipNoticeAt = undefined;
    if (this.limitHit?.agent === id) this.limitHit = undefined;
    this.system(`${r.cfg.name} marked available again.`);
    this.comeBack(r);
    this.saveMeta();
    this.emit('state');
  }

  private availabilityTick(): void {
    for (const r of this.agents.values()) {
      if (!r.outUntil || r.outUntil > Date.now()) continue;
      r.outUntil = undefined;
      r.skipNoticeAt = undefined;
      if (this.limitHit?.agent === r.cfg.id) this.limitHit = undefined;
      if (!this.project) continue;
      this.system(`${r.cfg.name}'s usage limit should have reset; it's back on the team.`);
      this.comeBack(r);
      this.saveMeta();
      this.emit('state');
    }
    this.resumeIdleLoops();
  }

  /**
   * Autopilot on in BUILD: an agent that's available and idle, with a ready task and no recorded reason
   * to wait (e.g. its pause reason was lost in a restart while it was out of usage), gets going again.
   */
  private resumeIdleLoops(): void {
    if (!this.project || this.phase !== 'build' || !this.autopilot || this.resumeOffer) return;
    const idle = [...this.agents.values()].filter(
      (r) =>
        !r.loop.active &&
        !r.loop.stopped &&
        r.status === 'idle' &&
        !r.pending &&
        !r.current &&
        this.available(r.cfg.id) &&
        !this.asks.some((a) => (a.status === 'open' || a.status === 'queued') && a.from === r.cfg.id),
    );
    if (!idle.length) return;
    const gen = this.gen;
    void this.readTasks().then((tasks) => {
      if (gen !== this.gen || !this.autopilot || this.phase !== 'build') return;
      // Rechecked after the read: you may have stopped it, or it may have started, meanwhile.
      const ids = idle.filter((r) => !r.loop.active && !r.loop.stopped && r.status === 'idle' && !r.pending && this.available(r.cfg.id) && tasks.some((t) => t.owner === r.cfg.id && OPEN(t) && this.isReady(t, tasks))).map((r) => r.cfg.id);
      if (!ids.length) return;
      this.system(`Autopilot: ${ids.map((id) => this.nameOf(id)).join(' and ')} ${ids.length > 1 ? 'have' : 'has'} ready tasks and nothing holding ${ids.length > 1 ? 'them' : 'it'} back, so ${ids.length > 1 ? 'they continue' : 'it continues'}.`);
      void this.startLoops(ids);
    });
  }

  /** Back from off / out of usage: take waiting reviews, and resume its BUILD work under autopilot. */
  private comeBack(r: Runtime): void {
    if (!this.project || !this.available(r.cfg.id)) return;
    const gen = this.gen;
    // Reviews waiting for it first (each gets a turn of its own), then its own work.
    this.reviewQueue = this.reviewQueue
      .then(async () => {
        await this.dispatchParked();
        if (gen !== this.gen || !this.available(r.cfg.id)) return;
        const building = this.phase === 'build' && this.autopilot;
        // Changes requested while it was away: they come first.
        const owed = r.awayWork?.splice(0) ?? [];
        if (owed.length) {
          if (building) r.loop = { active: true, turns: 0, idle: 0 };
          void this.enqueue(r.cfg.id, { instruction: owed.join('\n\n'), keepIfAway: true });
          return;
        }
        if (!building) return;
        const tasks = await this.readTasks();
        const next = tasks.find((t) => t.owner === r.cfg.id && OPEN(t) && this.isReady(t, tasks));
        if (!next) return;
        r.loop = { active: true, turns: 0, idle: 0 };
        // Busy (e.g. with a review just handed to it): autopilot picks its tasks up after that turn.
        if (r.status === 'working' || r.pending) return;
        void this.enqueue(r.cfg.id, { instruction: this.continueInstruction(next, tasks) });
      })
      .catch(console.error);
  }

  // ── Review pipeline ───────────────────────────────────────────────────

  /** The checks a task owned by `owner` goes through once it's marked done. */
  /** Stages come from the roles as set, even if a reviewer is away right now: its stage waits (or you pick another). */
  private pipelineFor(owner: string): StageKind[] {
    const stages: StageKind[] = [];
    if (this.reviewMode === 'chain' && this.roles.enabled) {
      if (this.holders('first_reviewer', owner, true).length) stages.push('first');
      if (this.holders('final_reviewer', owner, true).length) stages.push('final');
    } else if (this.reviewMode === 'cross' || this.reviewMode === 'chain') {
      // Chain with roles off falls back to a single cross-review.
      if ([...this.agents.keys()].some((id) => id !== owner)) stages.push('cross');
    }
    if (this.testCommand) stages.push('tests');
    if (this.desktopTestCommand) stages.push('desktop');
    return stages;
  }

  /** Agents holding a role, never the task's own owner (no reviewing your own work). */
  private holders(role: RoleAssignment['role'], owner: string, all = false): string[] {
    return [...this.agents.keys()].filter((id) => id !== owner && this.roleOf(id).role === role && (all || this.available(id)));
  }

  /**
   * The task was accepted: take its send-back out of the owner's queued turn or away-work if it hasn't run
   * yet, even when it was merged with other work. A queued turn left with nothing to do ends at once and
   * hands back to autopilot (see runTurn).
   */
  private dropSendBack(taskId: string): void {
    const q = this.queuedSendBacks[taskId];
    delete this.queuedSendBacks[taskId];
    const r = q ? this.agents.get(q.owner) : undefined;
    if (!q || !r) return;
    if (r.awayWork) r.awayWork = r.awayWork.map((w) => w.replace(q.text, '').trim()).filter(Boolean);
    if (r.hasNext && r.next.instruction?.includes(q.text)) {
      // The turn still runs for anything else it holds (e.g. your new messages); with nothing left it's dropped.
      const rest = r.next.instruction.replace(q.text, '').replace(/\n{3,}/g, '\n\n').trim();
      r.next = { ...r.next, instruction: rest || undefined, forTask: undefined };
    }
  }

  /** True when the owner hasn't started a turn since the task was accepted, so any reopen is out of date. */
  private reopenedByStaleTurn(t: Task): boolean {
    const at = this.acceptedAt[t.id];
    const owner = t.owner ? this.agents.get(t.owner) : undefined;
    return Boolean(at && owner?.turnStartedAt && owner.turnStartedAt < at);
  }

  private accepted(t: Task): boolean {
    if (t.status !== 'done') return false;
    if (this.reviews[t.id]?.status === 'passed') return true;
    return !this.pipelineFor(t.owner ?? '').length && this.doneChecked(t);
  }

  /** Agents that already approved a stage of this task since it was last sent back. */
  private roundReviewers(rec: ReviewEntry): string[] {
    const lastBack = Math.max(rec.history.map((h) => h.verdict).lastIndexOf('changes') + 1, rec.roundStart ?? 0);
    return rec.history.slice(lastBack).filter((h) => h.verdict === 'approve' && this.agents.has(h.by)).map((h) => h.by);
  }

  /** Who reviews this stage: the role holder, or for cross-review the least-busy other agent. */
  private reviewerFor(stage: StageKind, owner: string, rec?: ReviewEntry): string | undefined {
    // A re-review after changes goes back to whoever last reviewed this stage (a stand-in too):
    // they know what they asked for.
    const previous = [...(rec?.history ?? [])].reverse().find((h) => h.stage === stage && this.agents.has(h.by) && h.by !== owner && this.available(h.by))?.by;
    if (previous) return previous;
    if (stage === 'first') return this.holders('first_reviewer', owner)[0];
    if (stage === 'final') return this.holders('final_reviewer', owner)[0];
    const others = [...this.agents.values()].filter((r) => r.cfg.id !== owner && this.available(r.cfg.id));
    const load = (id: string) => Object.values(this.reviews).filter((e) => e.history.some((h) => h.by === id)).length;
    others.sort((a, b) => Number(a.status === 'working') - Number(b.status === 'working') || load(a.cfg.id) - load(b.cfg.id));
    return others[0]?.cfg.id;
  }

  /**
   * Look at tasks.json and move reviews along: a task newly marked done starts its pipeline;
   * a task reopened by its owner cancels its review. Serialized so two triggers can't race.
   */
  private advanceReviews(): void {
    this.reviewQueue = this.reviewQueue.then(() => this.advanceReviewsNow()).catch((e) => console.error('review update failed:', e));
  }

  private async advanceReviewsNow(): Promise<void> {
    if (!this.project) return;
    const gen = this.gen;
    const tasks = await this.readTasks();
    if (gen !== this.gen) return; // project switched while reading
    this.wakeForNewTasks(tasks);
    let changed = false;
    for (const t of tasks) {
      const rec = this.reviews[t.id];
      if (t.status === 'done' && !this.doneChecked(t) && rec?.status !== 'passed') {
        // Not checked yet: nothing starts on it (review, acceptance, dependants) until it is. Its owner's
        // running turn gets it checked when it ends; otherwise check it now.
        const owner = t.owner ? this.agents.get(t.owner) : undefined;
        if (owner?.current) continue;
        if (owner) await this.settleDone(owner.cfg.id, t, this.attemptOf(t.id), '', false);
        else {
          this.doneOk[t.id] = this.attemptOf(t.id); // no agent owns it (e.g. yours): nothing to check
          this.advanceReviews();
        }
        continue;
      }
      // Reopened: a later "done" is checked again.
      if (t.status !== 'done' && t.id in this.doneOk) delete this.doneOk[t.id];
      if (t.status === 'done') {
        if (rec && rec.status !== 'changes') continue;
        const stages = this.pipelineFor(t.owner ?? '');
        if (!stages.length) {
          // No review step: done means accepted, so release anything waiting on it.
          await this.onTaskAccepted(t.id);
          continue;
        }
        this.reviews[t.id] = { status: 'in_review', stages, stage: 0, rounds: rec?.rounds ?? 0, history: rec?.history ?? [], roundStart: rec?.roundStart };
        changed = true;
        await this.dispatchStage(t);
      } else if (rec?.status === 'passed' && this.reopenedByStaleTurn(t)) {
        // Accepted while its owner's turn was already running: that turn's "doing" is out of date.
        this.doneOk[t.id] = this.attemptOf(t.id); // still the accepted attempt, so its "done" stays checked
        await this.updateTask(t.id, (cur) => (cur.status !== 'done' ? { status: 'done', note: '' } : undefined));
        this.system(`${t.id} was already accepted, so it stays done (a change from before the acceptance had reopened it).`);
      } else if (rec && (rec.status === 'in_review' || rec.status === 'passed')) {
        // The owner reopened it: start over when it's done again, as a new round (earlier approvals
        // were for the old version, so they don't rule anyone out as a reviewer).
        if (rec.status === 'passed') this.acceptedSeen.delete(t.id); // a later acceptance releases and merges again
        rec.status = 'changes';
        rec.waitingOn = undefined;
        rec.roundStart = rec.history.length;
        changed = true;
      }
    }
    if (changed) this.saveReviewState();
    await this.dispatchParked();
  }

  /** Start the current stage of a task's review: ask the reviewer, or run the tests. */
  private async dispatchStage(t: Task): Promise<void> {
    const rec = this.reviews[t.id];
    if (!rec || rec.status !== 'in_review' || !this.project) return;
    const stage = rec.stages[rec.stage];
    const owner = t.owner ?? '';
    if (stage === 'desktop') {
      // Waits for Run now: these tests take over the mouse, so they never start on their own.
      rec.waitingOn = undefined;
      if (!this.desktopTestCommand) {
        rec.history.push({ ts: Date.now(), by: 'desktop', stage, verdict: 'approve', notes: 'Skipped: no desktop test command.' });
        return this.nextStage(t);
      }
      if (this.desktopRun?.task === t.id) this.cancelDesktopTests(true);
      {
        this.desktopWaiting.set(t.id, `${this.desktopToken(t.id)}#${++this.desktopSeq}`);
        this.system(`${t.id} → waiting for the desktop tests (\`${this.desktopTestCommand}\`). They use your mouse and screen for a while, so they start when you press Run now above the chat (or the App helper does, when Run my project is on and this computer is idle).`);
        this.emit('state');
      }
      return;
    }
    if (stage === 'tests') {
      rec.waitingOn = undefined;
      this.system(`${t.id} → running tests: \`${this.testCommand}\``);
      const dir = this.project.agentDirs[owner] ?? this.project.repoDir;
      const gen = this.gen;
      // In the background: a long test run mustn't hold up other reviews. After setup there, if it's running.
      // Set up again first if its dependency files changed since (the owner may have fast-forwarded to another branch).
      if (this.project.agentDirs[owner]) void this.ensureSetup(owner, dir, owner);
      void Promise.all(this.pendingSetup([dir]))
        .then(() => runTests(this.testCommand, dir))
        .then((result) => {
        if (gen !== this.gen) return;
        this.reviewQueue = this.reviewQueue
          .then(() => this.applyVerdict(t.id, 'tests', 'tests', result.ok ? 'approve' : 'changes', result.ok ? 'Tests passed.' : result.output))
          .catch(console.error);
      });
      return;
    }
    let reviewer = this.reviewerFor(stage, owner, rec);
    // Two stages are two pairs of eyes: someone who already approved this round doesn't do the next
    // stage too. Hand it to another available agent if there is one, else wait for you to pick.
    if (reviewer && this.roundReviewers(rec).includes(reviewer)) {
      const already = reviewer;
      reviewer = [...this.agents.keys()].find((id) => id !== owner && this.available(id) && !this.roundReviewers(rec).includes(id));
      if (reviewer) {
        this.system(`${this.nameOf(already)} already did an earlier stage of ${t.id}, so ${this.nameOf(reviewer)} does the ${STAGE_LABELS[stage]}.`);
      } else {
        const key = `${t.id}:${rec.stage}:repeat:${already}`;
        if (!this.parkNoticed.has(key)) {
          this.parkNoticed.add(key);
          this.notice(
            `${t.id} "${t.title ?? ''}" waits for its ${STAGE_LABELS[stage]}: ${this.nameOf(already)} already did an earlier stage and no one else is available. ` +
              'Pick a reviewer under "Review by" in the Tasks tab when one is back, or Approve it yourself.',
          );
        }
        rec.waitingOn = undefined;
        return;
      }
    }
    // The reviewer for this stage exists but is off or out of usage: wait for it (or for you to pick another).
    const absent = !reviewer
      ? stage === 'cross'
        ? [...this.agents.keys()].find((id) => id !== owner)
        : this.holders(stage === 'first' ? 'first_reviewer' : 'final_reviewer', owner, true)[0]
      : undefined;
    if (!reviewer && absent) {
      rec.waitingOn = undefined;
      const key = `${t.id}:${rec.stage}:${absent}`;
      if (!this.parkNoticed.has(key)) {
        this.parkNoticed.add(key);
        this.notice(
          `${t.id} "${t.title ?? ''}" waits for its ${STAGE_LABELS[stage]}: ${this.nameOf(absent)} is ${this.unavailableReason(this.agents.get(absent)!)}. ` +
            'It starts when they are back, or pick another reviewer under "Review by" in the Tasks tab.',
        );
      }
      return;
    }
    if (!reviewer) {
      rec.history.push({ ts: Date.now(), by: 'system', stage, verdict: 'skip', notes: 'No reviewer available for this stage.' });
      return this.nextStage(t);
    }
    // One review at a time per reviewer, so each verdict clearly belongs to one task.
    if (Object.entries(this.reviews).some(([id, e]) => id !== t.id && e.status === 'in_review' && e.waitingOn === reviewer)) {
      rec.waitingOn = undefined;
      return;
    }
    rec.waitingOn = reviewer;
    rec.askedAt = NOT_ASKED_YET;
    this.system(`${t.id} "${t.title ?? ''}" → ${STAGE_LABELS[stage]} by ${this.nameOf(reviewer)}.`);
    // A fresh checkout of their branch to run and test, so the reviewer never merges it into its own.
    const checkout = await this.reviewCheckout(owner, reviewer).catch((e) => {
      console.error('review checkout:', e);
      return undefined;
    });
    rec.reviewedTip = await branchTip(this.project, owner).catch(() => rec.reviewedTip);
    // Stamped only now: a turn the reviewer started while the checkout (and its setup) was being
    // prepared, e.g. its own build turn, isn't the review and mustn't count as one.
    rec.askedAt = Date.now();
    void this.enqueue(reviewer, {
      instruction: this.reviewInstruction(t, stage, rec, checkout?.dir),
      extraDirs: checkout ? [checkout.dir, ...agentWritableDirs(this.project, checkout.name).slice(1, 2)] : [],
    });
  }

  private reviewInstruction(t: Task, stage: StageKind, rec: ReviewEntry, checkout?: string): string {
    const owner = t.owner ?? '';
    const earlier = rec.history
      .filter((h) => h.verdict === 'approve' && !isMachineStage(h.stage))
      .slice(-2)
      .map((h) => `- ${this.nameOf(h.by)} (${STAGE_LABELS[h.stage]}) approved: ${h.notes.slice(0, 600)}`)
      .join('\n');
    const files = Array.isArray(t.files) && t.files.length ? ` It owns: ${(t.files as string[]).join(', ')}.` : '';
    return [
      `REVIEW REQUEST (${STAGE_LABELS[stage]}): task ${t.id} "${t.title ?? ''}", built by ${this.nameOf(owner)} on branch agent/${owner}.${files}`,
      `Look at the work with \`git diff main...agent/${owner}\` and \`git log main..agent/${owner}\` (run them in your worktree; branches are shared).`,
      checkout
        ? `Their branch is checked out at ${checkout} for you: install, build, run the tests and try it there (for UI work, launch it and look). ` +
          "It's a throwaway copy: don't commit there, and never merge or check out their branch in your own worktree."
        : "Don't merge or check out their branch in your own worktree; read it with git diff/show.",
      'Run the tests rather than only reading the code. To point at a specific line, add a line [[comment: path/to/file:LINE]] your note (LINE in the new version).',
      stage === 'final'
        ? 'You are the final check before this task is accepted. Be strict: look for what the builder and the first reviewer missed.'
        : 'Check that it works, matches PLAN.md and the task, handles edge cases, and has tests where it should.',
      this.handoffText(t) ? `The builder's hand-off note: ${this.handoffText(t)}` : '',
      earlier ? `Earlier reviews:\n${earlier}` : '',
      "Don't edit their code. End your reply with exactly one line: [[verdict: approve]] if it's ready, or [[verdict: changes]] followed by a numbered list of the changes required.",
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ── Line comments on branch diffs ─────────────────────────────────────

  private saveCommentState(): void {
    if (this.project) void saveComments(this.project.teamDir, this.comments);
    this.emit('state');
  }

  private nextCommentId(): string {
    const max = this.comments.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
    return `c${max + 1}`;
  }

  /** You pin a comment to a line of an agent's diff (Branches → Diff). */
  addComment(agent: string, file: string, line: number, side: 'new' | 'old', lineText: string, text: string, by = 'user'): LineComment {
    this.requireProject();
    if (!this.agents.has(agent)) throw new Error(`Unknown agent ${agent}`);
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('Write a comment first');
    if (!file || !Number.isInteger(line) || line < 1) throw new Error('Pick a line in the diff');
    const c: LineComment = {
      id: this.nextCommentId(),
      agent,
      file: String(file).slice(0, 400),
      line,
      side: side === 'old' ? 'old' : 'new',
      lineText: String(lineText ?? '').slice(0, 300),
      text: clean.slice(0, 2000),
      by,
      status: 'open',
      rounds: 0,
      at: Date.now(),
    };
    this.comments.push(c);
    this.saveCommentState();
    return c;
  }

  commentAction(id: string, action: 'delete' | 'resolve' | 'reopen'): void {
    const c = this.comments.find((x) => x.id === id);
    if (!c) throw new Error(`No comment ${id}`);
    if (action === 'delete') this.comments = this.comments.filter((x) => x !== c);
    else c.status = action === 'resolve' ? 'resolved' : c.rounds ? 'sent' : 'open';
    this.saveCommentState();
  }

  private describeComment(c: LineComment): string {
    const where = `${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`;
    const code = c.lineText.trim() ? ` \`${c.lineText.trim().slice(0, 120)}\`` : '';
    const by = c.by === 'user' ? 'you' : this.nameOf(c.by);
    return `${c.id}. ${where}${code}: ${c.text}  [from ${by}${c.rounds ? `; still open after ${c.rounds} round${c.rounds > 1 ? 's' : ''}` : ''}]`;
  }

  /** "Send to builder": every comment on its branch not yet resolved, in one message. */
  sendComments(agent: string): void {
    const r = this.agents.get(agent);
    if (!r) throw new Error(`Unknown agent ${agent}`);
    const batch = this.comments.filter((c) => c.agent === agent && c.status !== 'resolved');
    if (!batch.length) throw new Error(`No open comments on ${r.cfg.name}'s branch`);
    for (const c of batch) {
      c.status = 'sent';
      c.rounds++;
    }
    this.system(`${batch.length} line comment${batch.length === 1 ? '' : 's'} sent to ${r.cfg.name}: ${batch.map((c) => c.id).join(', ')}.`);
    if (this.autopilot && this.phase === 'build') r.loop = { active: true, turns: 0, idle: 0 };
    void this.enqueue(agent, {
      instruction:
        `CHANGES REQUESTED (line comments on your branch agent/${agent}):\n${batch.map((c) => this.describeComment(c)).join('\n')}\n\n` +
        'Address each one, run the tests and commit. Then add a line [[fixed: c1, c2]] listing the comments you dealt with; ' +
        "for any you disagree with, say why instead of listing it. Unlisted ones are sent again next round.",
    });
    this.saveCommentState();
  }

  /** [[comment: path:line]] from a reviewer pins a comment on the branch it's reviewing; [[fixed: …]] from a builder resolves its own. */
  private onCommentMarkers(id: string, text: string): void {
    let changed = false;
    for (const m of text.matchAll(FIXED_RE)) {
      for (const cid of m[1].split(/[\s,]+/).filter(Boolean)) {
        const c = this.comments.find((x) => x.id === cid.toLowerCase() && x.agent === id && x.status !== 'resolved');
        if (c) {
          c.status = 'resolved';
          changed = true;
        }
      }
    }
    const pins = [...text.matchAll(COMMENT_RE)];
    if (pins.length) {
      const review = Object.entries(this.reviews).find(([, e]) => e.status === 'in_review' && e.waitingOn === id);
      const owner = review ? this.lastGoodTasks.find((t) => t.id === review[0])?.owner : undefined;
      if (!owner) {
        this.emitAgent(id, { kind: 'log', text: '(line comments ignored: not reviewing a task right now)' });
      } else {
        // With a "changes" verdict the notes already go to the builder, so the pins count as sent.
        const sent = parseVerdict(text) === 'changes';
        for (const [, file, line, note] of pins) {
          const c = this.addCommentQuiet(owner, file, Number(line), note.trim() || '(see review)', id);
          if (sent && c) {
            c.status = 'sent';
            c.rounds = 1;
          }
        }
        changed = true;
      }
    }
    if (changed) this.saveCommentState();
  }

  private addCommentQuiet(agent: string, file: string, line: number, text: string, by: string): LineComment | undefined {
    if (!Number.isInteger(line) || line < 1) return undefined;
    const c: LineComment = { id: this.nextCommentId(), agent, file: file.slice(0, 400), line, side: 'new', lineText: '', text: text.slice(0, 2000), by, status: 'open', rounds: 0, at: Date.now() };
    this.comments.push(c);
    return c;
  }

  /** A reviewer's reply: apply its verdict to the task it was reviewing. */
  /**
   * `openAtStart`: the review stage (and round) each task was at when this turn started, so a stand-in
   * verdict can't land on a later stage it never saw. `anywhere`: look for the verdict in the whole
   * text (a reply cut off by a nudge or the turn limit may end with status text after it).
   */
  private onReviewReply(id: string, text: string, turnStartedAt: number, openAtStart: Record<string, string> = {}, anywhere = false): void {
    const { verdict, taskId: markerTask } = reviewVerdict(text, anywhere);
    // A turn already running when the review was requested isn't the review.
    const entry = Object.entries(this.reviews).find(
      ([, e]) => e.status === 'in_review' && e.waitingOn === id && (e.askedAt ?? 0) <= turnStartedAt,
    );
    // The reply names another task under review, not the one assigned: the verdict is for that one.
    const elsewhere =
      entry && (markerTask ? markerTask !== entry[0].toLowerCase() : !namesTask(text, entry[0]) && Object.keys(this.reviews).some((t) => t !== entry[0] && this.reviews[t].status === 'in_review' && namesTask(text, t)));
    if (elsewhere) {
      // Its own review wasn't done: release it so it's asked again (or someone else is) instead of staying stuck.
      const [ownId, own] = entry;
      own.history.push({ ts: Date.now(), by: id, stage: own.stages[own.stage], verdict: 'none', notes: `Replied about another task instead of ${ownId}.` });
      own.waitingOn = undefined;
      this.saveReviewState();
    }
    if (!entry || elsewhere) {
      // Not the assigned reviewer (or not this task): a stand-in's verdict still counts (see applyStandInVerdict).
      this.reviewQueue = this.reviewQueue
        .then(async () => {
          if (verdict) await this.applyStandInVerdict(id, text, verdict, openAtStart, markerTask);
          if (elsewhere) await this.dispatchParked();
        })
        .catch(console.error);
      return;
    }
    const [taskId, rec] = entry;
    const stage = rec.stages[rec.stage];
    const notes = text.replace(/\[\[\s*verdict[^\]]*\]\]/gi, '').trim();
    // One pair of eyes per stage: an approval from someone who already approved this round doesn't count.
    if (verdict === 'approve' && approvedThisRound(rec, id)) {
      rec.history.push({ ts: Date.now(), by: id, stage, verdict: 'none', notes: 'Already approved an earlier stage this round.' });
      rec.waitingOn = undefined;
      this.notice(`${this.nameOf(id)} already approved ${taskId} this round, so its approval of the ${STAGE_LABELS[stage]} doesn't count; another agent or you must do it.`);
      this.reviewQueue = this.reviewQueue.then(() => this.dispatchParked()).catch(console.error);
      this.saveReviewState();
      return;
    }
    if (!verdict) {
      rec.history.push({ ts: Date.now(), by: id, stage, verdict: 'none', notes: notes.slice(0, 2000) });
      // Usually it just forgot the marker line: ask it once to add one, before bothering you.
      if (rec.reasked !== reviewKey(rec)) {
        rec.reasked = reviewKey(rec);
        rec.askedAt = Date.now();
        this.emitAgent(id, { kind: 'log', text: `(reviewed ${taskId} without the verdict line; the app asked for one)` });
        void this.enqueue(id, {
          instruction:
            `Your review of ${taskId} (${STAGE_LABELS[stage]}) ended without the verdict line, so the app couldn't record it. ` +
            "Don't redo the review: reply with your conclusion in a sentence, ending with exactly one line: " +
            '[[verdict: approve]] if it is ready, or [[verdict: changes]] followed by a numbered list of the changes required.',
        });
        this.saveReviewState();
        return;
      }
      this.notice(`${this.nameOf(id)} reviewed ${taskId} but twice didn't say approve or changes. Decide in the Tasks tab: Approve, or Send back.`);
      this.saveReviewState();
      return;
    }
    this.reviewQueue = this.reviewQueue.then(() => this.applyVerdict(taskId, id, stage, verdict, notes)).catch(console.error);
  }

  /**
   * A verdict from an agent that wasn't asked (e.g. it stood in for a reviewer who ran out of usage).
   * It counts for the task's current stage if the agent didn't build it and it's clear which task:
   * the reply names exactly one task under review, or only one is under review.
   */
  /** This agent holds the role for a stage of this review that hasn't come yet (so it will be asked then). */
  private reviewsLater(e: ReviewEntry, id: string): boolean {
    const role = this.roleOf(id).role;
    return e.stages.some((st, i) => i > e.stage && ((st === 'first' && role === 'first_reviewer') || (st === 'final' && role === 'final_reviewer')));
  }

  /** "Which task?" re-asks already sent (agent + the reviews it could mean), so it's asked once. */
  private whichTaskAsked = new Set<string>();

  private async applyStandInVerdict(id: string, text: string, verdict: 'approve' | 'changes', openAtStart: Record<string, string>, markerTask?: string): Promise<void> {
    const gen = this.gen;
    const tasks = await this.readTasks();
    if (gen !== this.gen) return;
    // Only reviews this turn could see: the same stage and round as when it started (so a late reply
    // to a stage that has since moved on, e.g. from the original reviewer, can't approve the next one).
    const open = Object.entries(this.reviews).filter(
      ([taskId, e]) =>
        e.status === 'in_review' &&
        !isMachineStage(e.stages[e.stage]) &&
        tasks.find((t) => t.id === taskId)?.owner !== id &&
        openAtStart[taskId] === reviewKey(e) &&
        !approvedThisRound(e, id),
    );
    const names = (taskId: string) => markerTask ? taskId.toLowerCase() === markerTask : namesTask(text, taskId);
    const named = open.filter(([taskId]) => names(taskId));
    // It names a task under review that it can't give the verdict on: say why, and don't guess another.
    const barred = named.length
      ? []
      : Object.keys(this.reviews).filter((t) => this.reviews[t].status === 'in_review' && names(t) && !open.some(([o]) => o === t));
    if (barred.length || !open.length || (markerTask && !named.length)) {
      for (const t of barred) {
        const e = this.reviews[t];
        const own = tasks.find((x) => x.id === t)?.owner === id;
        if (!own && !approvedThisRound(e, id) && this.reviewsLater(e, id)) {
          this.emitAgent(id, { kind: 'log', text: `(verdict on ${t} came before its stage; it will be asked at its stage)` });
          continue;
        }
        this.notice(
          tasks.find((x) => x.id === t)?.owner === id
            ? `${this.nameOf(id)} can't give the verdict on its own task ${t}; a teammate or you must review it.`
            : approvedThisRound(e, id)
              ? `${this.nameOf(id)} already approved ${t} this round, so its verdict doesn't count again; another agent or you must do this stage.`
              : `${this.nameOf(id)}'s verdict on ${t} was for an earlier stage, so it doesn't count; use Approve / Send back in the Tasks tab.`,
        );
      }
      return;
    }
    const pick = named.length === 1 ? named[0] : !named.length && open.length === 1 ? open[0] : undefined;
    if (!pick) {
      const candidates = named.length ? named : open;
      // Share the missing-verdict guard: one clarification per stage and round, never a loop.
      const askKey = `${id}:${candidates.map(([t, rec]) => `${t}@${reviewKey(rec)}`).join(',')}`;
      if (!this.whichTaskAsked.has(askKey)) {
        this.whichTaskAsked.add(askKey);
        this.emitAgent(id, { kind: 'log', text: '(gave a verdict without a clear task id; the app asked it to name the task)' });
        void this.enqueue(id, {
          instruction:
            `Your verdict could be for ${candidates.map(([t]) => t).join(', ')}, so the app couldn't record it. ` +
            "Don't redo the review: reply with [[verdict: approve]] or [[verdict: changes]] plus the task id it is for. " +
            'Put the id in the marker, for example [[verdict: approve t16]] or [[verdict: changes t16]].',
        });
        this.saveReviewState();
        return;
      }
      this.notice(
        `${this.nameOf(id)} gave a verdict, but it's not clear which task it's for (${(named.length ? named : open).map(([t]) => t).join(', ')}). ` +
          'Ask it to name the task id, or use Approve / Send back in the Tasks tab.',
      );
      return;
    }
    const [taskId, rec] = pick;
    const stage = rec.stages[rec.stage];
    const assigned = rec.waitingOn ? this.nameOf(rec.waitingOn) : 'the assigned reviewer';
    if (rec.waitingOn !== id) this.system(`${this.nameOf(id)} reviewed ${taskId} in place of ${assigned}; its verdict counts for the ${STAGE_LABELS[stage]}.`);
    const notes = text.replace(/\[\[\s*verdict[^\]]*\]\]/gi, '').trim();
    await this.applyVerdict(taskId, id, stage, verdict, notes);
  }

  private async applyVerdict(taskId: string, by: string, stage: StageKind, verdict: 'approve' | 'changes', notes: string): Promise<void> {
    const gen = this.gen;
    const tasks = await this.readTasks();
    if (gen !== this.gen) return; // project switched: this verdict belongs to the old one
    const rec = this.reviews[taskId];
    if (!rec || rec.status !== 'in_review') return;
    rec.history.push({ ts: Date.now(), by, stage, verdict, notes: notes.slice(0, 4000) });
    rec.waitingOn = undefined;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return this.saveReviewState();
    if (verdict === 'approve') await this.nextStage(task);
    else await this.sendBack(task, by, stage, notes);
    await this.dispatchParked();
    this.saveReviewState();
  }

  private async nextStage(t: Task): Promise<void> {
    const rec = this.reviews[t.id];
    rec.stage++;
    if (rec.stage < rec.stages.length) return this.dispatchStage(t);
    rec.status = 'passed';
    this.acceptedAt[t.id] = Date.now();
    this.dropSendBack(t.id);
    if (/^Changes requested by /.test(t.note ?? '')) await this.updateTask(t.id, { note: '' });
    const trail = rec.history
      .slice(-rec.stages.length)
      .filter((h) => h.verdict === 'approve')
      .map((h) => (h.stage === 'tests' ? 'tests passed' : h.stage === 'desktop' ? (h.notes.startsWith('Skipped') ? 'desktop tests skipped' : 'desktop tests passed') : `${STAGE_LABELS[h.stage]}: ${this.nameOf(h.by)}`))
      .join(', ');
    this.system(`✓ ${t.id} "${t.title ?? ''}" accepted${trail ? ` (${trail})` : ''}.`);
    await this.onTaskAccepted(t.id);
    this.checkAllDone(await this.readTasks());
  }

  /** Changes requested: reopen the task for its owner with the reviewer's notes. */
  private async sendBack(t: Task, by: string, stage: StageKind, notes: string): Promise<void> {
    const rec = this.reviews[t.id];
    const owner = t.owner ?? '';
    rec.rounds++;
    const who = by === 'tests' ? 'the tests' : by === 'desktop' ? 'the desktop tests' : by === 'user' ? 'you' : `${this.nameOf(by)} (${STAGE_LABELS[stage]})`;
    // The cap stops reviewer loops; your own Send back always reaches the builder.
    if (rec.rounds > MAX_REVIEW_ROUNDS && by !== 'user') {
      rec.status = 'stuck';
      this.notice(`${t.id} has been sent back ${MAX_REVIEW_ROUNDS} times. Decide in the Tasks tab: approve it, send it back again, or restart its review.`);
      return;
    }
    rec.status = 'changes';
    this.attempts[t.id] = this.attemptOf(t.id) + 1;
    this.sentBack[t.id] = { at: Date.now(), tip: owner ? await branchTip(this.project!, owner).catch(() => undefined) : undefined };
    this.saveMeta();
    await this.updateTask(t.id, { status: 'doing', note: `Changes requested by ${who}` });
    this.system(`↩ ${t.id} sent back to ${this.nameOf(owner)} by ${who} (round ${rec.rounds}).`);
    if (owner && this.agents.has(owner)) {
      const ro = this.agents.get(owner)!;
      if (this.autopilot && this.phase === 'build') ro.loop = { active: true, turns: 0, idle: 0 };
      const instruction =
        `CHANGES REQUESTED on ${t.id} "${t.title ?? ''}" by ${who} (attempt ${this.attemptOf(t.id)}):\n${notes.slice(0, 4000)}\n\n` +
        `Make these changes, run the tests, commit, and set ${t.id} back to "done" in tasks.json. ` +
        `End your reply with [[done: ${t.id}#${this.attemptOf(t.id)} | done | what you changed]].`;
      // Remembered so accepting the task before this turn runs can take it back out (see dropSendBack).
      this.queuedSendBacks[t.id] = { owner, text: instruction };
      void this.enqueue(owner, { instruction, keepIfAway: true, forTask: t.id });
    }
  }

  /**
   * Re-try every review parked because its reviewer was busy (in review, no reviewer asked yet).
   * dispatchStage parks it again if its reviewer is still busy. Tests run in the background, so skip them.
   */
  private async dispatchParked(): Promise<void> {
    const parked = Object.entries(this.reviews).filter(([, e]) => e.status === 'in_review' && !e.waitingOn && !isMachineStage(e.stages[e.stage]));
    if (!parked.length) return;
    const gen = this.gen;
    const tasks = await this.readTasks();
    if (gen !== this.gen) return;
    for (const [id, e] of parked) {
      const t = tasks.find((x) => x.id === id);
      if (t && e.status === 'in_review' && !e.waitingOn) await this.dispatchStage(t);
    }
  }

  /** The user's buttons in the Tasks tab: approve, send back with a note, or restart the review. */
  async reviewAction(taskId: string, action: 'approve' | 'send_back' | 'restart' | 'reassign' | 'set_owner', note = ''): Promise<void> {
    const task = (await this.readTasks()).find((t) => t.id === taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    const rec = this.reviews[taskId];
    if (action === 'set_owner') {
      await this.setOwner(task, note.trim());
      return;
    }
    if (action === 'restart') {
      delete this.reviews[taskId];
      this.saveReviewState();
      this.advanceReviews();
      return;
    }
    if (!rec) throw new Error(`${taskId} isn't in review`);
    const stage = rec.stages[Math.min(rec.stage, rec.stages.length - 1)];
    if (action === 'reassign') {
      // "Review by": you pick who does the current stage (e.g. the usual reviewer is out of usage).
      const by = note.trim();
      if (rec.status !== 'in_review' || isMachineStage(stage)) throw new Error(`${taskId} isn't waiting for a reviewer`);
      if (!this.agents.has(by) || by === task.owner) throw new Error('Pick an agent other than the builder');
      if (!this.available(by)) throw new Error(`${this.nameOf(by)} is ${this.unavailableReason(this.agents.get(by)!)}`);
      const busy = Object.entries(this.reviews).find(([id, e]) => id !== taskId && e.status === 'in_review' && e.waitingOn === by);
      if (busy) throw new Error(`${this.nameOf(by)} is already reviewing ${busy[0]}; pick someone else, or wait until that review is done`);
      if (this.roundReviewers(rec).includes(by)) {
        throw new Error(`${this.nameOf(by)} already reviewed ${taskId} in this round; pick someone else, or Approve it yourself`);
      }
      rec.waitingOn = by;
      rec.askedAt = NOT_ASKED_YET;
      this.system(`${taskId} "${task.title ?? ''}" → ${STAGE_LABELS[stage]} by ${this.nameOf(by)} (your pick).`);
      const owner = task.owner ?? '';
      const checkout = this.project && owner ? await this.reviewCheckout(owner, by).catch(() => undefined) : undefined;
      rec.askedAt = Date.now(); // see dispatchStage
      void this.enqueue(by, {
        instruction: this.reviewInstruction(task, stage, rec, checkout?.dir),
        extraDirs: checkout && this.project ? [checkout.dir, ...agentWritableDirs(this.project, checkout.name).slice(1, 2)] : [],
      });
      this.saveReviewState();
      return;
    }
    if (action === 'approve') {
      rec.history.push({ ts: Date.now(), by: 'user', stage, verdict: 'approve', notes: 'Approved by you.' });
      rec.status = 'passed';
      rec.waitingOn = undefined;
      this.acceptedAt[taskId] = Date.now();
      this.dropSendBack(taskId);
      // Your acceptance settles this attempt: its "done" counts as checked (no "no commits since the send-back").
      this.doneOk[taskId] = this.attemptOf(taskId);
      delete this.noCommits[taskId];
      this.saveMeta();
      // The task may still read "doing" from a send-back you've overruled: it's done now.
      await this.updateTask(taskId, (t) => (t.status !== 'done' || /^Changes requested by /.test(t.note ?? '') ? { status: 'done', note: '' } : undefined));
      this.system(`✓ ${taskId} accepted by you.`);
      await this.onTaskAccepted(taskId);
      await this.dispatchParked(); // its reviewer is free for the next one
      this.checkAllDone(await this.readTasks());
    } else {
      rec.status = 'in_review';
      await this.applyVerdict(taskId, 'user', stage, 'changes', note.trim() || 'Sent back by the user.');
    }
    this.saveReviewState();
  }

  /**
   * "Builder" in the Tasks tab: hand a task to another agent (e.g. its owner is out of usage). The review
   * starts over, so the old builder's send-backs, "no commits since the send-back" mark and review rounds
   * don't count against the new one; the new builder gets a turn to pick it up.
   */
  private async setOwner(task: Task, to: string): Promise<void> {
    const taskId = task.id;
    const from = task.owner ?? '';
    if (!this.agents.has(to)) throw new Error(`Pick one of the agents as builder`);
    if (to === from) throw new Error(`${this.nameOf(to)} is already the builder of ${taskId}`);
    if (this.reviews[taskId]?.status === 'passed') throw new Error(`${taskId} is already accepted; use Re-review instead`);
    if (!this.available(to)) throw new Error(`${this.nameOf(to)} is ${this.unavailableReason(this.agents.get(to)!)}`);
    // Always "doing": the new builder reports it done itself, and only its commits from now on count.
    const ok = await this.updateTask(taskId, { owner: to, status: 'doing', note: `Reassigned from ${from ? this.nameOf(from) : 'nobody'} to ${this.nameOf(to)}.` });
    if (!ok) throw new Error(`Couldn't change the builder of ${taskId} in tasks.json`);
    this.dropSendBack(taskId);
    delete this.reviews[taskId];
    delete this.noCommits[taskId];
    delete this.doneOk[taskId];
    // A new attempt, so a late report from the old builder is stale; its commit baseline is the new builder's
    // branch now, so only work from here on counts (and the done check has a tip to compare with).
    this.attempts[taskId] = this.attemptOf(taskId) + 1;
    this.sentBack[taskId] = { at: Date.now(), tip: await branchTip(this.project!, to).catch(() => undefined) };
    this.saveMeta();
    this.saveReviewState();
    this.system(`${taskId} "${task.title ?? ''}" → builder is now ${this.nameOf(to)} (your pick), review restarted.`);
    const fromBranch = from && this.project?.agentDirs[from] ? ` Its earlier work, if any, is on branch agent/${from} (use \`git merge agent/${from}\` in your worktree to build on it).` : '';
    void this.enqueue(to, {
      instruction:
        `${taskId} "${task.title ?? ''}" is now yours: the user moved it from ${from ? this.nameOf(from) : 'nobody'} to you.${fromBranch}` +
        `Finish it, then end your reply with [[done: ${taskId}#${this.attemptOf(taskId)} | done | one-line summary]].`,
    });
    this.advanceReviews();
  }

  /** Small read-modify-write of one task in tasks.json (the app's only edit to that file). */
  /**
   * Change one task in tasks.json. Edits are queued one at a time, each re-reading the latest file
   * (with a unique temp name), so two agents finishing together can't overwrite each other. `patch`
   * can be a function of the task as it is now; returning undefined leaves it alone.
   */
  private updateTask(taskId: string, patch: Partial<Task> | ((t: Task) => Partial<Task> | undefined)): Promise<boolean> {
    const project = this.project;
    if (!project) return Promise.resolve(false);
    const run = async (): Promise<boolean> => {
      if (this.project !== project) return false;
      const file = join(project.teamDir, 'tasks.json');
      try {
        // Agents edit tasks.json too: if one saved while this edit was being written, redo it on their version.
        for (let tries = 0; ; tries++) {
          const raw = readFileSync(file);
          const data = JSON.parse(decodeText(raw));
          const t = (data.tasks ?? []).find((x: any) => x?.id === taskId);
          if (!t) return false;
          const change = typeof patch === 'function' ? patch(t) : patch;
          if (!change) return false;
          Object.assign(t, change);
          const tmp = `${file}.${process.pid}.${++this.taskWriteSeq}.tmp`;
          await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
          if (tries < 3 && !readFileSync(file).equals(raw)) {
            await unlink(tmp).catch(() => {});
            continue;
          }
          await rename(tmp, file);
          return true;
        }
      } catch (e) {
        console.error('could not update tasks.json:', (e as Error).message);
        return false;
      }
    };
    const result = this.taskWrites.then(run, run);
    this.taskWrites = result;
    return result;
  }

  private saveReviewState(): void {
    if (this.project) void saveReviews(this.project.teamDir, this.reviews);
    this.emit('state');
  }

  // ── Merge arbiter ─────────────────────────────────────────────────────

  /**
   * Pick a neutral agent for a conflict between agent/<id> and others' merged work: not the branch
   * owner and not anyone whose work is on the other side. Prefers the Arbiter role, then reviewers.
   */
  private arbiterFor(id: string, others: string[]): string | undefined {
    const rank = (a: string) => ['arbiter', 'final_reviewer', 'first_reviewer'].indexOf(this.roleOf(a).role) >>> 0;
    const pick = (ids: string[]) => ids.sort((a, b) => rank(a) - rank(b))[0];
    const all = [...this.agents.keys()].filter((a) => a !== id);
    return pick(all.filter((a) => !others.includes(a))) ?? pick(all);
  }

  /** Hand a conflict to a neutral agent in a throwaway worktree; adopt the result if it's clean. */
  private async arbitrate(id: string, files: string[], afterward: string, then?: () => Promise<unknown>): Promise<boolean> {
    const p = this.requireProject();
    const others = (await conflictingAgents(p, files)).filter((a) => a !== id && this.agents.has(a));
    const arbiter = this.arbiterFor(id, others);
    if (!arbiter) return false;
    const ws = await createArbiterWorktree(p, id);
    const sides = others.length ? others.map((a) => this.nameOf(a)).join(' and ') : 'work already merged into main';
    this.system(`Conflict between ${this.nameOf(id)}'s branch and ${sides} in: ${files.join(', ')}. ${this.nameOf(arbiter)} will resolve it as a neutral arbiter.`);
    const instruction = [
      `ARBITRATION: branch agent/${id} (${this.nameOf(id)}) conflicts with main (${sides}) in: ${files.join(', ')}.`,
      `This folder is a copy of agent/${id} on branch ${ws.branch}. Run \`git merge main\`, then resolve every conflict keeping what BOTH sides intended.`,
      `Learn each side's intent first: \`git log main..agent/${id}\`, \`git log agent/${id}..main\`, and the tasks in ${p.teamDir}/tasks.json. Don't simply pick one side.`,
      this.testCommand ? `Then run \`${this.testCommand}\` and fix anything the merge broke.` : 'Then check the result builds and works.',
      'Commit the merge (no conflict markers left), and reply with a short summary naming each decision you made.',
    ].join('\n');
    void this.enqueueOneShot(arbiter, {
      instruction,
      cwd: ws.dir,
      extraDirs: agentWritableDirs(p, ws.name),
      onDone: async (ok, text) => {
        try {
          if (!ok) throw new Error(text);
          await adoptArbiterResult(p, id);
          this.system(`${this.nameOf(arbiter)} resolved the conflict; ${this.nameOf(id)}'s branch now includes main. ${afterward}`);
          await then?.();
        } catch (e) {
          this.notice(`Arbitration for ${this.nameOf(id)}'s branch didn't finish: ${(e as Error).message}. You can Sync and ask ${this.nameOf(id)} to resolve it instead.`);
        }
      },
      cleanup: () => removeArbiterWorktree(p, id),
    });
    return true;
  }

  // ── Merging ───────────────────────────────────────────────────────────

  /** Merge an agent's branch into main. `auto`: accepted work merged by the app, retried after an arbiter resolves a conflict. */
  async merge(agentId: string, auto = false, rev?: string): Promise<boolean> {
    const p = this.requireProject();
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`);
    try {
      await mergeAgent(p, agentId, rev);
      this.system(auto ? `✓ ${this.nameOf(agentId)}'s accepted work is merged into main.` : `Merged agent/${agentId} into main.`);
      return true;
    } catch (err) {
      if (err instanceof MergeConflictError) {
        const handled = await this.arbitrate(
          agentId,
          err.files,
          auto ? '' : 'Click Merge again to put it into main.',
          // The arbiter merged main into the whole branch, so what goes in now is the whole branch,
          // once everything on it is accepted (otherwise when the rest is).
          auto
            ? async () => {
                if (!(await this.autoMerge(agentId))) this.system(`${this.nameOf(agentId)}'s reviewed work goes into main once the rest of its branch is accepted.`);
              }
            : undefined,
        ).catch(() => false);
        if (!handled) {
          this.notice(
            `${this.nameOf(agentId)}'s work couldn't be merged into main: it conflicts with merged work in ${err.files.join(', ')}. ` +
              `Click Sync on ${this.nameOf(agentId)}'s branch in the Branches tab; ${this.nameOf(agentId)} is then asked to resolve it.`,
          );
        }
        return false;
      }
      throw err;
    } finally {
      this.emit('branches');
    }
  }

  /**
   * Every task this agent started has passed review (and tests), so its branch can go into main
   * without asking you. Tasks it hasn't started don't hold it back; unchecked work on the branch does.
   */
  private branchAccepted(agentId: string, tasks: Task[]): boolean {
    const mine = tasks.filter((t) => t.owner === agentId);
    const passed = (t: Task) => t.status === 'done' && this.reviews[t.id]?.status === 'passed';
    return mine.some(passed) && mine.every((t) => passed(t) || (t.status ?? 'todo') === 'todo');
  }

  /**
   * Merge an agent's accepted work into main, one merge at a time. Resolves true once it's in main.
   * `rev`: just the commit a review approved; otherwise the whole branch, once all its work is accepted.
   */
  private autoMerge(agentId: string, rev?: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (!this.project || !this.agents.has(agentId)) return false;
      if (rev) return (await inMain(this.project, rev)) || this.merge(agentId, true, rev);
      if (!this.branchAccepted(agentId, await this.readTasks())) return false;
      const st = (await branchStatus(this.project)).find((b) => b.agentId === agentId);
      if (!st?.ahead) return true; // nothing new: already in main
      return this.merge(agentId, true);
    };
    const result = this.mergeQueue.then(run, run).catch((e) => {
      this.notice(`Merging ${this.nameOf(agentId)}'s accepted work failed: ${(e as Error).message}`);
      return false;
    });
    this.mergeQueue = result;
    return result;
  }

  /** Merge main into an agent's branch so it builds on everyone's merged work. */
  async sync(agentId: string): Promise<void> {
    const p = this.requireProject();
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`);
    try {
      await syncAgent(p, agentId);
      this.system(`Synced main into agent/${agentId}.`);
      void this.ensureSetup(agentId, p.agentDirs[agentId], agentId); // new dependencies from main
    } catch (err) {
      if (err instanceof MergeConflictError) {
        if (await this.arbitrate(agentId, err.files, 'It now builds on everyone\'s merged work.').catch(() => false)) return;
        this.add({
          from: 'system',
          to: agentId,
          text: `Syncing main into your branch conflicts in: ${err.files.join(', ')}. Run \`git merge main\` in your worktree, resolve the conflicts, and commit.`,
        });
        this.system(`Sync of agent/${agentId} hit conflicts (${err.files.join(', ')}); asked ${this.nameOf(agentId)} to resolve.`);
        void this.enqueue(agentId);
      } else throw err;
    } finally {
      this.emit('branches');
    }
  }

  // ── Approval requests ─────────────────────────────────────────────────

  async resolveRequest(id: string, approve: boolean, reason = '', by: 'user' | 'helper' = 'user'): Promise<void> {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error('Request no longer pending');
    this.requests = this.requests.filter((r) => r !== req);
    this.saveMeta();
    this.emit('state');
    if (!approve) {
      const why = reason.trim().slice(0, 2000);
      this.system(`${by === 'helper' ? 'The App helper rejected' : 'You rejected'} ${this.nameOf(req.from)}'s request (${req.kind} ${req.value})${by === 'helper' ? ' for you' : ''}${why ? `: ${why}` : '.'}`);
      // With a reason, the requester gets a turn to act on it.
      if (why && this.agents.has(req.from)) {
        void this.enqueue(req.from, {
          instruction: `${by === 'helper' ? 'The App helper, acting for the user,' : 'The user'} said no to your request to ${req.kind === 'phase' ? `move to the ${req.value.toUpperCase()} phase` : `merge ${this.nameOf(req.value)}'s branch`}. Their reason: ${why}\nAddress it, then ask again when it's ready.`,
        });
      }
      return;
    }
    await this.applyRequest(req);
  }

  private async applyRequest(req: PendingRequest): Promise<void> {
    if (req.kind === 'phase') this.setPhase(req.value as Phase);
    else await this.merge(req.value).then(() => undefined);
  }

  /** Pull [[phase: x]] / [[merge: id]] markers out of the leader's reply. */
  private collectRequests(from: string, text: string): void {
    if (from !== this.leader) return;
    // Only markers at the end of the reply count, so quoting one mid-sentence doesn't trigger it.
    const tail = text.trim().split('\n').slice(-3).join('\n');
    for (const m of tail.matchAll(REQUEST_RE)) {
      const kind = m[1].toLowerCase() as PendingRequest['kind'];
      const value = m[2].toLowerCase();
      if (kind === 'phase' && !PHASES.includes(value as Phase)) continue;
      if (kind === 'merge' && !this.agents.has(value)) continue;
      // Already there (e.g. you started Build from its question): nothing to approve.
      if (kind === 'phase' && value === this.phase) continue;
      const req: PendingRequest = { id: randomUUID(), from, kind, value };
      // Work that passed review and tests is merged without asking you.
      if (kind === 'merge' && this.branchAccepted(value, this.lastGoodTasks)) {
        void this.autoMerge(value);
        continue;
      }
      // Everything is reviewed and merged: a review phase adds nothing.
      if (kind === 'phase' && value === 'review' && this.allDoneAnnounced && this.lastGoodTasks.length && this.lastGoodTasks.every((t) => this.branchAccepted(t.owner ?? '', this.lastGoodTasks))) {
        continue;
      }
      if (!this.gates) {
        this.applyRequest(req).catch((e) => this.system(`Request failed: ${e.message}`));
        continue;
      }
      // Asking again replaces the earlier request, so repeats don't stack up as extra banners.
      const again = this.requests.some((r) => r.from === from && r.kind === kind && r.value === value);
      this.requests = this.requests.filter((r) => !(r.from === from && r.kind === kind && r.value === value));
      this.requests.push(req);
      this.saveMeta();
      this.system(`${this.nameOf(from)} ${again ? 'asks again' : 'requests'}: ${kind} ${value}. Approve or reject above the chat.`);
    }
    this.emit('state');
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  /** User posts to the room ('all') or DMs one agent. */
  /** Where this project's chat images live (inside team/, which every agent can read). */
  attachmentsDir(): string | undefined {
    return this.project ? join(this.project.teamDir, 'attachments') : undefined;
  }

  async userSend(text: string, to: string, attachments?: unknown): Promise<void> {
    this.requireProject();
    if (to !== 'all' && !this.agents.has(to)) throw new Error(`Unknown agent ${to}`);
    if (to !== 'all' && this.agents.get(to)!.disabled) throw new Error(`${this.nameOf(to)} is switched off. Switch it on in the Agents tab first.`);
    this.hops = 0;
    const cutTargets = this.hopPause?.targets ?? []; // woken below, so any message lets a cut chain carry on
    this.chainRestarts = 0;
    this.agentDms = 0;
    this.askCount = 0;
    const images = validAttachments(this.attachmentsDir(), attachments);
    if (!text.trim() && !images.length) return;
    this.add({ from: 'user', to, text, ...(images.length ? { attachments: images } : {}) });
    // Replying answers the "needs you" flags of whoever this reaches.
    const reached = to !== 'all' ? [to] : this.mentions(text).length ? this.mentions(text) : [...this.agents.keys()];
    if (this.needsYou.some((n) => reached.includes(n.agent))) {
      this.needsYou = this.needsYou.filter((n) => !reached.includes(n.agent));
      this.saveMeta();
      this.emit('state');
    }
    const discussion = ++this.discussionGen;
    const gen = this.gen;

    let targets: string[];
    // Named directly (DM or @mention): it runs even if out of usage, so you can check whether the limit lifted.
    let named = true;
    if (to !== 'all') targets = [to];
    else {
      const raw = this.mentions(text);
      const mentioned = raw.filter((id) => !this.agents.get(id)!.disabled);
      // Everyone you @mentioned is switched off: say so instead of falling back to the whole room.
      if (raw.length && !mentioned.length) {
        this.system(`Not delivered: ${raw.map((id) => `${this.nameOf(id)} is switched off`).join(', ')}. Switch it on in the Agents tab, or message someone else.`);
        // Any message from you still lets a paused hand-off chain carry on.
        const wake = cutTargets.filter((t) => this.agents.has(t) && this.available(t));
        if (this.hopPause && wake.length) {
          const left = cutTargets.filter((t) => !wake.includes(t));
          this.hopPause = left.length ? { ...this.hopPause, targets: left } : undefined;
          for (const t of wake) void this.enqueue(t);
          this.emit('state');
        }
        return;
      }
      named = mentioned.length > 0;
      targets = named ? mentioned : [...this.agents.keys()].filter((id) => this.available(id));
      const away = [...this.agents.values()].filter((r) => !this.available(r.cfg.id) && (named ? this.mentions(text).includes(r.cfg.id) && r.disabled : true));
      if (away.length) this.system(`Not answering: ${away.map((r) => `${r.cfg.name} (${this.unavailableReason(r)})`).join(', ')}.`);
    }
    for (const t of cutTargets) if (!targets.includes(t) && this.agents.has(t) && this.available(t)) targets.push(t);
    // Cleared only for those actually woken; one that can't run yet stays paused for the helper.
    if (this.hopPause) {
      const left = cutTargets.filter((t) => !targets.includes(t));
      this.hopPause = left.length ? { ...this.hopPause, targets: left } : undefined;
    }
    // Leader speaks first so the others can react to it.
    if (this.leader !== 'user' && targets.includes(this.leader)) {
      targets = [this.leader, ...targets.filter((t) => t !== this.leader)];
    }

    if (this.phase === 'build' && to === 'all') {
      await Promise.all(targets.map((t) => this.enqueue(t, { force: named })));
      return;
    }
    for (const t of targets) await this.enqueue(t, { force: named });

    // Plan-phase group discussion: more rounds while anyone still has something new to say.
    // Each later round asks for new points only; a round where everyone passes ends it.
    if (this.phase !== 'plan' || to !== 'all' || this.mentions(text).length || this.debating) return;
    for (let round = 2; round <= MAX_DISCUSSION_ROUNDS; round++) {
      const spoke = targets.some((t) => this.agents.get(t)!.lastOutcome === 'spoke');
      if (!spoke || discussion !== this.discussionGen || gen !== this.gen) return;
      for (const t of targets) {
        if (discussion !== this.discussionGen || gen !== this.gen) return;
        await this.enqueue(t, {
          instruction: `Discussion round ${round} of ${MAX_DISCUSSION_ROUNDS}: reply only if you have something NEW to add (a disagreement, a gap, or a concrete improvement to what teammates said). Otherwise reply exactly [[pass]].`,
        });
      }
    }
    if (discussion === this.discussionGen && gen === this.gen && targets.some((t) => this.agents.get(t)!.lastOutcome === 'spoke')) {
      this.system(`Discussion reached ${MAX_DISCUSSION_ROUNDS} rounds. Reply to continue, or move on.`);
    }
  }

  /**
   * Debate: everyone proposes independently (in parallel, blind to each other),
   * then critiques the others, then the leader synthesizes into PLAN.md.
   */
  async debate(text: string, attachments?: unknown): Promise<void> {
    this.requireProject();
    if (this.debating) throw new Error('A debate is already running');
    this.debating = true;
    this.debateCancelled = false;
    this.hops = 0;
    this.hopPause = undefined;
    this.emit('state');
    const ids = [...this.agents.keys()];
    try {
      // Files go to every agent in round 1 (attached to this message), and aren't re-sent in later rounds.
      const files = validAttachments(this.attachmentsDir(), attachments);
      this.add({ from: 'user', to: 'all', text: `🗳 Debate: ${text}`, ...(files.length ? { attachments: files } : {}) });
      const start = this.messages.length;
      this.system('Debate round 1: independent proposals.');
      await Promise.all(
        ids.map((id) =>
          this.enqueue(id, {
            hideAgentsFrom: start,
            instruction:
              'DEBATE ROUND 1: propose your own approach to the topic independently. Cover architecture, key risks and how you would split the work. Do not edit files.',
          }),
        ),
      );
      if (this.debateCancelled) return this.system('Debate stopped.');
      this.system('Debate round 2: critiques.');
      await Promise.all(
        ids.map((id) =>
          this.enqueue(id, {
            instruction:
              "DEBATE ROUND 2: critique your teammates' proposals. Name the strongest ideas, the real flaws, and what the final plan should keep. Be concise. Do not edit files.",
          }),
        ),
      );
      if (this.debateCancelled) return this.system('Debate stopped.');
      if (this.leader !== 'user') {
        this.system(`Debate synthesis: ${this.nameOf(this.leader)}.`);
        await this.enqueue(this.leader, {
          instruction:
            'DEBATE SYNTHESIS: as leader, merge the best ideas into one plan. Write it to PLAN.md and the task split to tasks.json, then summarize the decisions in chat.',
        });
      } else {
        this.system('Debate done. Pick the plan, or make an agent leader to synthesize it.');
      }
    } finally {
      this.debating = false;
      this.emit('state');
    }
  }

  /** Queue a standalone job (see OneShot) after whatever this agent is already doing. */
  private enqueueOneShot(id: string, job: OneShot): Promise<void> {
    const r = this.agents.get(id)!;
    const gen = this.gen;
    const stopGen = r.stopGen;
    r.chain = r.chain.then(() => this.runOneShot(r, job, gen, stopGen)).catch((err) => console.error(err));
    return r.chain;
  }

  private async runOneShot(r: Runtime, job: OneShot, gen: number, stopGen: number): Promise<void> {
    // A model server's current context size, so Codex compacts in time (at most a few seconds).
    if (r.cfg.server) await refreshServerContext(r.cfg.server);
    if (!this.project || gen !== this.gen || stopGen !== r.stopGen) {
      try {
        if (gen === this.gen) await job.onDone(false, 'cancelled');
      } finally {
        await job.cleanup?.().catch(console.error);
      }
      return;
    }
    const id = r.cfg.id;
    const prompt = [
      `You are ${r.cfg.name} (@${id}), working for a team of AI agents and the user on project "${this.project.name}".`,
      this.modelLine(r),
      'This is a standalone job in its own folder (your working directory), separate from your usual worktree.',
      job.instruction,
    ].join('\n\n');
    r.killReason = undefined;
    this.setStatus(r, 'working');
    const turn = r.adapter.runTurn({ prompt, cwd: job.cwd, extraDirs: job.extraDirs, settings: r.settings, onEvent: (e) => this.emitAgent(id, e) });
    r.current = turn;
    const timer = setTimeout(() => {
      r.killReason = 'timeout';
      turn.kill();
    }, TURN_TIMEOUT_MS);
    try {
      const res = await turn.done;
      if (gen !== this.gen) return;
      this.addUsage(r, res.usage);
      this.setStatus(r, 'idle');
      if (res.text.trim()) this.add({ from: id, to: 'all', text: res.text.trim() });
      await job.onDone(true, res.text);
    } catch (err) {
      if (gen !== this.gen) return;
      const msg = r.killReason === 'stopped' ? 'stopped' : r.killReason === 'timeout' ? 'timed out' : (err as Error).message;
      this.emitAgent(id, { kind: 'log', text: `✖ job failed: ${msg.slice(0, 500)}` });
      this.setStatus(r, r.killReason === 'stopped' ? 'idle' : 'error');
      this.noteLimit(r, msg);
      await job.onDone(false, msg);
    } finally {
      clearTimeout(timer);
      if (r.current === turn) r.current = undefined;
      await job.cleanup?.().catch(console.error);
      if (gen === this.gen) this.emit('branches');
    }
  }

  private enqueue(id: string, plan: TurnPlan = {}): Promise<void> {
    const r = this.agents.get(id)!;
    // Switched off, or out of usage (unless you messaged it directly): it catches up on the chat when it's back.
    if (r.disabled || (r.outUntil && r.outUntil > Date.now() && !plan.force)) {
      this.noteSkipped(r);
      if (plan.keepIfAway && plan.instruction) (r.awayWork ??= []).push(plan.instruction);
      this.failAskAway(r, plan);
      return Promise.resolve();
    }
    if (plan.askId) {
      // A question gets a turn of its own (one open question per agent, so this slot holds at most one).
      r.nextAsk = plan;
    } else {
      // Merge with a plan already queued so a later plain enqueue can't wipe a debate/phase instruction.
      const instruction = [r.next.instruction, plan.instruction].filter(Boolean).join('\n\n') || undefined;
      // A merged turn about more than one thing is no longer "only about that task".
      const forTask = r.hasNext && r.next.forTask !== plan.forTask ? undefined : plan.forTask;
      r.next = { ...r.next, ...plan, instruction, forTask };
      r.hasNext = true;
    }
    // Already waiting: it will see every new message when its turn starts.
    if (r.pending) return r.chain;
    r.pending = true;
    const gen = this.gen;
    const stopGen = r.stopGen;
    r.chain = r.chain.then(() => this.runTurn(r, gen, stopGen)).catch((err) => console.error(err));
    return r.chain;
  }

  /** Queue one more turn after the current one (for work left in `next` behind a question's turn). */
  private requeue(r: Runtime, gen: number, stopGen: number): void {
    if (r.pending) return;
    r.pending = true;
    r.chain = r.chain.then(() => this.runTurn(r, gen, stopGen)).catch((err) => console.error(err));
  }

  private async runTurn(r: Runtime, gen: number, stopGen: number, retry = false): Promise<void> {
    try {
      await this.runTurnBody(r, gen, stopGen, retry);
    } finally {
      // The panel shows "queued" while a turn waits: a turn that ends, or is skipped or dropped
      // before it starts, must refresh it.
      if (gen === this.gen) this.emit('state');
    }
  }

  private async runTurnBody(r: Runtime, gen: number, stopGen: number, retry: boolean): Promise<void> {
    // Setup → Agents is changing the team: start after it, and not at all for an agent it replaced.
    while (this.savingTeam) await new Promise((res) => setTimeout(res, 100));
    if (this.agents.get(r.cfg.id) !== r) return;
    r.pending = false;
    // Queued before a Stop: dropped. Anything queued after the Stop found this slot taken and waited
    // on it, so this same call runs it (whoever awaits the queue then waits for that turn).
    if (stopGen !== r.stopGen && !retry) {
      if (gen !== this.gen || (!r.hasNext && !r.nextAsk)) {
        r.lastOutcome = 'skipped';
        return;
      }
      stopGen = r.stopGen;
    }
    r.lastOutcome = 'skipped';
    // A question's turn goes first, on its own; other queued work runs in the turn after it.
    let plan: TurnPlan;
    if (r.nextAsk) {
      plan = r.nextAsk;
      r.nextAsk = undefined;
      if (r.hasNext) this.requeue(r, gen, stopGen);
    } else {
      plan = r.next;
      r.next = {};
      r.hasNext = false;
    }
    // The question this turn answers (if it's still waiting): its reply goes back to the asker.
    const owed = plan.askId ? this.asks.find((a) => a.id === plan.askId && a.status === 'open') : undefined;
    // That question was withdrawn, failed or expired meanwhile: nothing to answer.
    if (plan.askId && !owed) return;
    // Queued before the agent went out (or was switched off): don't run it now. Its reviews were
    // released when it went out, so they go to someone else.
    if (r.disabled || (r.outUntil && r.outUntil > Date.now() && !plan.force)) {
      this.noteSkipped(r);
      if (plan.keepIfAway && plan.instruction) (r.awayWork ??= []).push(plan.instruction);
      this.failAskAway(r, plan);
      return;
    }
    // A send-back whose task you accepted while it waited: nothing left to do.
    if (plan.forTask && this.reviews[plan.forTask]?.status === 'passed') {
      this.emitAgent(r.cfg.id, { kind: 'log', text: `(skipped the queued turn for ${plan.forTask}: it was accepted meanwhile)` });
      // Autopilot carries on with its other ready tasks (or ends the run if there are none).
      if (r.loop.active) void this.startLoops([r.cfg.id]);
      return;
    }
    r.activity = this.activityOf(plan.instruction);
    // When this turn took its instructions: a review requested after this belongs to a later turn.
    const startedAt = Date.now();
    if (!retry || !r.turnStartedAt) r.turnStartedAt = startedAt;
    // The review stages open as this turn starts: a stand-in verdict in its reply can only be about these.
    const openAtStart = Object.fromEntries(Object.entries(this.reviews).filter(([, e]) => e.status === 'in_review').map(([t, e]) => [t, reviewKey(e)]));
    // tts.yaml or a dependency file may have arrived or changed in its worktree since the last turn (e.g. a
    // merge it ran itself): set up again first. A no-op when nothing changed.
    if (this.project) void this.ensureSetup(r.cfg.id, this.project.agentDirs[r.cfg.id], r.cfg.id);
    // Its worktree (or a review copy it's given) is still being set up: wait, so the work starts with dependencies.
    const setups = this.project ? this.pendingSetup([this.project.agentDirs[r.cfg.id], ...(plan.extraDirs ?? [])]) : [];
    if (setups.length) {
      this.emitAgent(r.cfg.id, { kind: 'log', text: 'waiting for setup to finish…' });
      await Promise.all(setups);
    }
    // A model server's current context size, so Codex compacts in time (at most a few seconds).
    if (r.cfg.server) await refreshServerContext(r.cfg.server);
    // Dropped: project switched or Stop pressed since this turn was queued.
    if (!this.project || gen !== this.gen || stopGen !== r.stopGen) return;
    r.answering = owed?.id;
    // Attempts as this turn starts: its done reports count only if no send-back happens meanwhile.
    const attemptsAtStart = { ...this.attempts };
    let settled = new Set<string>();
    const project = this.project;
    const id = r.cfg.id;
    const fresh = !r.sessionId || !r.adapter.supportsResume;
    const hidden = (m: ChatMessage, i: number) =>
      plan.hideAgentsFrom !== undefined && i >= plan.hideAgentsFrom && this.agents.has(m.from) && m.from !== id;
    const visible = (m: ChatMessage, i: number) => this.canSee(id, m) && !hidden(m, i);

    const indexed = this.messages.map((m, i) => [m, i] as const);
    // Messages posted while this prompt is being built (e.g. a notice from reading tasks.json) aren't in it.
    const snapshotLength = this.messages.length;
    // A question's turn carries only the question: messages that arrived since its last turn are left
    // for its next one, so whatever they ask for gets a turn (and a reply to the room) of its own.
    const asked = Boolean(owed);
    const context = fresh
      ? indexed.filter(([m, i]) => visible(m, i) && (!asked || i < r.lastSeen)).slice(-HISTORY_WINDOW)
      : asked
        ? []
        : indexed.slice(r.lastSeen).filter(([m, i]) => visible(m, i) && m.from !== id);
    if (!context.length && !plan.instruction) {
      // Nothing left to do (e.g. its send-back was withdrawn by an acceptance): autopilot carries on.
      if (r.loop.active) void this.startLoops([id]);
      return;
    }

    // Attachments go along only with the message they were attached to, not with every later turn.
    const newAttachments = context.filter(([m, i]) => i >= r.lastSeen && m.attachments?.length).flatMap(([m]) => m.attachments!);
    const newImages = newAttachments.filter(isImage).map((a) => join(project.teamDir, 'attachments', a));

    // A turn answering a private message replies privately to whoever sent it (you or a teammate),
    // so DMs don't leak to the others.
    const lastPrivate = [...context].reverse().find(([m]) => m.from !== 'system' && m.from !== id && !m.ask)?.[0];
    const replyTo = owed
      ? owed.from
      : !plan.public && lastPrivate && lastPrivate.to === id
        ? lastPrivate.from === 'user'
          ? 'user'
          : lastPrivate.from
        : 'all';

    const prompt = [
      fresh ? this.preamble(r) : '',
      `[phase: ${this.phase} | leader: ${this.nameOf(this.leader)}${this.leader === id ? ' (you)' : ''}]`,
      this.modelLine(r),
      this.setupLine(project.agentDirs[id]),
      this.roleLine(id),
      this.desktopTestCommand && this.phase === 'build'
        ? `[desktop tests: never run \`${this.desktopTestCommand}\` yourself: it takes over the user's real mouse and screen. The app runs it on the desktop after you mark a task done (when the user, or the App helper on an idle computer, presses Run now) and sends you the output if it fails. Don't mark a task blocked because you can't run these.]`
        : '',
      await this.taskDigest(id),
      context.length ? (fresh ? 'Conversation so far:' : 'New messages since your last turn:') : '',
      context.map(([m]) => this.format(m)).join('\n\n'),
      plan.instruction ?? `Reply as ${r.cfg.name}. To hand off to a teammate, start a line with @id.`,
      replyTo === 'user'
        ? 'This is a private message from the user; your reply goes only to them.'
        : owed
          ? `Your reply goes back only to ${this.nameOf(owed.from)} (the user can see it).`
          : replyTo !== 'all'
          ? `This is a private message from ${this.nameOf(replyTo)}; your reply goes back only to them (the user can see it). If nothing more is needed, reply exactly [[pass]] to end the exchange.`
          : '',
      newAttachments.length ? ATTACHMENT_NOTE : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Only commit lastSeen when the turn succeeds; hidden debate proposals stay unseen for next turn.
    const firstHidden = indexed.find(([m, i]) => i >= r.lastSeen && hidden(m, i))?.[1];
    const seenUpTo = asked ? r.lastSeen : (firstHidden ?? snapshotLength);

    const before = await this.loopSnapshot(r);
    r.killReason = undefined;
    r.stopping = false;
    r.inFlight = plan.instruction;
    this.setStatus(r, 'working');
    const eff = effectiveModel(r.cfg.adapter, r.settings.model, r.settings.effort, r.cfg.server);
    this.emitAgent(id, { kind: 'log', text: `model: ${eff.model} · effort: ${eff.effort} · ${r.settings.autonomy}` });
    const watch: TurnWatch = { startedAt: Date.now(), lastEventAt: Date.now(), recentTools: [], texts: [], textsSinceTool: 0 };
    r.watch = watch;
    const turn = r.adapter.runTurn({
      prompt,
      cwd: project.agentDirs[id],
      extraDirs: [...agentWritableDirs(project, id), ...(plan.extraDirs ?? [])],
      settings: r.settings,
      images: newImages,
      sessionId: r.adapter.supportsResume ? r.sessionId : undefined,
      onEvent: (event) => {
        if (gen !== this.gen) return;
        // Plan usage can arrive after the turn ends (Codex reads it from a file); it isn't turn progress.
        if (event.kind !== 'limits' && event.kind !== 'session') this.noteProgress(r, watch, event);
        this.emitAgent(id, event);
      },
    });
    r.current = turn;
    r.pid = turn.pid;
    this.saveMeta();
    const timer = setTimeout(() => {
      r.killReason = 'timeout';
      turn.kill();
    }, TURN_TIMEOUT_MS);
    const watchdog = setInterval(() => this.checkStall(r, watch), WATCH_TICK_MS);

    try {
      const res = await turn.done;
      if (gen !== this.gen) return; // project switched mid-turn: drop the late result
      if (res.sessionId) r.sessionId = res.sessionId;
      r.lastSeen = seenUpTo;
      this.addUsage(r, res.usage);
      this.setStatus(r, 'idle');
      if (r.outUntil) {
        // It answered, so the limit has lifted early.
        r.outUntil = undefined;
        if (this.limitHit?.agent === id) this.limitHit = undefined;
        this.system(`${r.cfg.name} answered, so its usage limit has lifted.`);
        this.comeBack(r);
        this.emit('state');
      }
      let text = res.text.trim();
      let to: string = replyTo;
      // A question to a teammate: post it privately to them; the asker gets the answer next turn.
      let askTo: string | undefined;
      const ask = text.match(ASK_RE);
      if (ask) {
        const target = ask[1].toLowerCase();
        text = text.slice(ask[0].length).trim();
        if (this.agents.has(target) && target !== id && this.canAsk()) {
          askTo = target;
          to = target;
        } else {
          // Over the limit (or not a teammate): the text goes to the room instead of a private question.
          to = 'all';
          if (!this.canAsk()) this.notice(`Questions between agents reached the limit of ${MAX_ASKS} for now, so ${r.cfg.name}'s question went to the room. Reply to continue.`);
        }
      }
      if (owed && askTo) owed.nested = true; // it asked someone else first; its next turn still owes the answer
      if (owed && !askTo) to = owed.from; // the answer goes to the asker, whatever else the reply says
      const dm = askTo || owed ? null : text.match(DM_RE);
      if (dm) {
        const target = dm[1].toLowerCase();
        text = text.slice(dm[0].length).trim();
        if (this.agents.has(target) && target !== id) to = target;
        else if (target === 'user' || target === 'all') to = target;
      }
      if (owed && !askTo) {
        // A Grok turn cut short by a refused command returns a fragment plus a warning, not an answer.
        if (/turn ended early: .*refused/i.test(text)) {
          this.settleAsk(owed, 'failed');
          this.resumeAsker(owed, `${r.cfg.name}'s turn was cut short by a refused command before it could answer your question (${owed.id}). Continue without it, ask someone else, or ask the user (@user).`);
        } else this.answerAsk(owed, !text || PASS_RE.test(text) ? '' : text);
      }
      if (!text || PASS_RE.test(text)) {
        r.lastOutcome = 'passed';
        if (text) this.emitAgent(id, { kind: 'log', text: '(passed: nothing new to add)' });
      } else {
        r.lastOutcome = 'spoke';
        // Question and answer lines are marked so they don't make a later turn look like a private exchange.
        this.add({ from: id, to, text, ...(askTo || owed ? { ask: true } : {}) });
        if (USER_RE.test(text)) this.flagNeedsYou(r, text);
        // Verdicts and [[phase:]]/[[merge:]] requests are explicit markers: honor them even in a private reply.
        this.collectRequests(id, text);
        settled = await this.applyDoneReports(id, text, attemptsAtStart).catch((e) => (console.error('done report:', e), settled));
        this.onReviewReply(id, text, startedAt, openAtStart);
        this.onCommentMarkers(id, text);
        if (askTo) {
          this.startAsk(id, askTo, text);
        } else if (to === 'all') {
          if (!this.debating) this.routeMentions(id, text);
        } else if (to !== 'user' && this.agents.has(to) && !owed) {
          // A reply to a question already went back to the asker via answerAsk.
          this.sendAgentDm(id, to);
        }
      }
      // Before autopilot decides what's next: a "done" from this turn is checked (or reopened if stale).
      await this.settleMarkedDone(id, attemptsAtStart, settled).catch((e) => console.error('done check:', e));
      await this.checkScopeAfterTurn(r).catch(() => {});
      this.advanceReviews();
      await this.continueLoop(r, before);
    } catch (err) {
      if (gen !== this.gen) return;
      const reason = r.killReason;
      // Any failure pauses this agent's autopilot (a retry below re-checks the loop on success).
      const wasLooping = r.loop.active;
      const prevStopped = r.loop.stopped;
      if (reason || fresh || retry) {
        r.loop.active = false;
        // A usage limit governs its own return (out of usage until the reset, then it continues), so it
        // isn't a pause that needs you.
        r.loop.stopped = classifyFailure((err as Error).message) === 'limit' && !reason ? undefined : 'paused after a failed turn; see its panel';
      }
      if (reason === 'stopped') {
        this.setStatus(r, 'idle');
        this.notice(`${r.cfg.name} stopped.`);
        this.failAsksTo(id, 'it was stopped');
        return;
      }
      if (reason === 'timeout' || reason === 'nudge') {
        // Keep what it said before being cut off: it may already hold the answer (e.g. a verdict).
        const partial = watch.texts.join('\n\n').trim();
        if (partial) {
          this.add({ from: id, to: replyTo, text: partial, ...(owed ? { ask: true } : {}) });
          r.lastSeen = seenUpTo;
          this.collectRequests(id, partial);
          this.onReviewReply(id, partial, startedAt, openAtStart, true);
        }
        const kept = partial ? ' What it said before that is posted above.' : '';
        if (reason === 'timeout') {
          this.emitAgent(id, { kind: 'log', text: `✖ turn stopped at the ${TURN_TIMEOUT_MS / 60_000}-min limit` });
          this.setStatus(r, 'error');
          this.notice(`${r.cfg.name} was stopped at the ${TURN_TIMEOUT_MS / 60_000}-min turn limit.${kept}`);
          this.failAsksTo(id, 'its turn hit the time limit');
          return;
        }
        // Nudge: stop the stuck turn and start a new one that says why.
        const stuck = watch.stall?.reason ?? 'went quiet';
        this.emitAgent(id, { kind: 'log', text: `↻ nudged: ${stuck}` });
        this.setStatus(r, 'idle');
        this.system(`${r.cfg.name} was nudged (${stuck}).${kept}`);
        if (wasLooping) r.loop.active = true;
        // A question it was answering stays open: the continued turn still owes the answer.
        const still = owed && owed.status === 'open' ? { askId: owed.id } : {};
        void this.enqueue(id, {
          ...still,
          instruction:
            `NUDGE: your last turn was stopped because it ${stuck}. ` +
            "Don't run commands that never exit on their own (dev servers, watchers, the app itself) in the foreground: " +
            'run them in the background with a time limit, or skip them and say what you could not check. ' +
            'Look at where you got to, then continue.',
        });
        return;
      }
      // A resumed turn that fails outright usually means the CLI lost the session
      // (cleaned up, expired, other machine). Start fresh once: the fresh prompt resends recent chat.
      r.lastOutcome = 'failed';
      const message = (err as Error).message;
      const kind = classifyFailure(message);
      // Retry with a fresh session only when that can help: a lost session (unknown failure on a
      // resumed turn) or a conversation that grew too long. Never for limits, logins or bad models.
      if (!retry && ((!fresh && kind === 'unknown') || (kind === 'context' && r.sessionId))) {
        this.notice(kind === 'context' ? failureHint(kind, r.cfg.name, r.cfg.command) : `${r.cfg.name}'s session couldn't be resumed; starting a fresh one.`);
        r.sessionId = undefined;
        // Keep anything queued while this turn ran (e.g. a review request) along with the retried plan;
        // a question's turn is retried on its own.
        if (plan.askId) r.nextAsk = plan;
        else {
          const instruction = [plan.instruction, r.next.instruction].filter(Boolean).join('\n\n') || undefined;
          r.next = { ...r.next, ...plan, instruction };
          r.hasNext = true;
        }
        r.current = undefined;
        clearTimeout(timer);
        // Awaited, so this attempt's finally (which clears `answering`) runs only after the retry finishes.
        return await this.runTurn(r, gen, stopGen, true);
      }
      // A model that needs paid credits can't run at all: go back to the model it had before, and retry once.
      const fallback = r.prevModel;
      if (!retry && kind === 'credits' && fallback !== undefined && fallback !== r.settings.model) {
        const tried = r.settings.model;
        this.setSettings(id, { model: fallback });
        // The retry carries on the autopilot run this turn was part of; it pauses again only if it fails.
        r.loop.active = wasLooping;
        r.loop.stopped = prevStopped;
        this.notice(`${r.cfg.name}'s model ${tried} needs paid usage credits on your plan, so I switched it back to ${fallback || 'its default model'} and retried. Change it in its Model box if you want another.`);
        if (plan.askId) r.nextAsk = plan;
        else {
          const instruction = [plan.instruction, r.next.instruction].filter(Boolean).join('\n\n') || undefined;
          r.next = { ...r.next, ...plan, instruction };
          r.hasNext = true;
        }
        r.current = undefined;
        clearTimeout(timer);
        return await this.runTurn(r, gen, stopGen, true);
      }
      this.emitAgent(id, { kind: 'log', text: `✖ turn failed (${kind}): ${message.slice(0, 1000)}` });
      this.setStatus(r, 'error');
      this.noteLimit(r, message);
      // A usage limit is handled (noteLimit said what happens), so it isn't reported as a failure.
      const hint = failureHint(kind, r.cfg.name, r.cfg.command, r.cfg.server ? r.settings.model : undefined);
      if (kind !== 'limit') this.notice(`${r.cfg.name} failed: ${hint || message.slice(0, 500)}${hint ? ` (details: ${message.slice(0, 200)})` : ''}${wasLooping ? ' Autopilot paused for it.' : ''}`);
      this.failAsksTo(id, `its turn failed (${kind})`);
    } finally {
      clearTimeout(timer);
      clearInterval(watchdog);
      if (r.watch === watch) {
        const wasStalled = Boolean(watch.stall);
        r.watch = undefined;
        if (wasStalled && gen === this.gen) this.emit('state');
      }
      if (r.answering === owed?.id) r.answering = undefined;
      if (r.current === turn) r.current = undefined;
      if (gen === this.gen) {
        this.saveMeta();
        this.emit('branches'); // the agent may have committed
        // A "done" this turn wrote but didn't get checked (e.g. the turn failed) is checked now it's over.
        this.advanceReviews();
      }
    }
  }

  // ── Status line ───────────────────────────────────────────────────────

  /** A short label for what a turn is for, from its instruction. */
  private activityOf(instruction?: string): string {
    const i = instruction ?? '';
    let m: RegExpMatchArray | null;
    if ((m = i.match(/REVIEW REQUEST \(([^)]+)\): task (\S+) "[^"]*", built by (\S+)/))) return `${m[1]} of ${m[2]} for ${m[3]}`;
    if ((m = i.match(/CHANGES REQUESTED on (\S+)/))) return `fixing ${m[1]} after review`;
    if (/CHANGES REQUESTED \(line comments/.test(i)) return 'working through line comments';
    if ((m = i.match(/(?:AUTOPILOT: keep going|UNBLOCKED:)\. Next unfinished task: (\S+)/) ?? i.match(/UNBLOCKED:.*?task: (\S+)/))) return `building ${m[1]}`;
    if ((m = i.match(/QUESTION from (\S+)/))) return `answering ${m[1]}'s question`;
    if ((m = i.match(/ANSWER from (\S+)/))) return `continuing with ${m[1]}'s answer`;
    if (/BUILD phase has started/.test(i)) return 'starting its build tasks';
    if (/REVIEW phase has started/.test(i)) return "reviewing teammates' branches";
    if (/Discussion round (\d+)/.test(i)) return `discussion round ${i.match(/Discussion round (\d+)/)![1]}`;
    if (/NUDGE:/.test(i)) return 'continuing after a nudge';
    return 'replying';
  }

  /** "working: building t3" / "waiting on t1 (Claude)" / "blocked: t2 …" / "idle", from what's known now. */
  private statusLine(r: Runtime): string {
    const id = r.cfg.id;
    if (r.status === 'working') return `working: ${r.activity ?? 'replying'}`;
    const setting = this.project && this.setupRunning.get(this.project.agentDirs[id]);
    if (setting) return `setting up its worktree: ${setting}`;
    if (r.pending) return 'queued: its turn is next';
    if (r.status === 'error') return 'last turn failed (see its activity)';
    if (r.disabled) return 'off: switched off in its panel';
    if (r.outUntil && r.outUntil > Date.now()) return `out of usage until ${clockTime(r.outUntil)}`;
    const asked = this.asks.find((a) => (a.status === 'open' || a.status === 'queued') && a.from === id);
    if (asked) return `waiting for ${this.nameOf(asked.to)}'s answer (${asked.id})`;
    const tasks = this.lastGoodTasks;
    const reviewing = Object.entries(this.reviews).find(([, e]) => e.status === 'in_review' && e.waitingOn === id);
    if (reviewing) return `review of ${reviewing[0]} requested`;
    const mine = tasks.filter((t) => t.owner === id);
    const blocked = mine.find((t) => t.status === 'blocked');
    if (blocked) return `blocked: ${blocked.id}${blocked.note ? ` (${String(blocked.note).slice(0, 80)})` : ''}`;
    const open = mine.filter((t) => OPEN(t));
    const waiting = open.filter((t) => !this.isReady(t, tasks));
    if (open.length && waiting.length === open.length) {
      const deps = this.depsOf(waiting[0]).filter((d) => !this.accepted(tasks.find((x) => x.id === d) ?? ({ id: d, status: 'done' } as Task)));
      const by = deps.map((d) => `${d} (${this.nameOf(tasks.find((x) => x.id === d)?.owner ?? '?')})`).join(', ');
      return `idle: ${waiting[0].id} waits on ${by}`;
    }
    const inReview = mine.filter((t) => t.status === 'done' && this.reviews[t.id]?.status === 'in_review');
    if (inReview.length && !open.length) return `idle: ${inReview.map((t) => t.id).join(', ')} in review`;
    if (open.length && this.phase === 'build') {
      // Say why it isn't working on them, so it never just sits there.
      const why = !this.autopilot ? 'autopilot off' : r.loop.stopped ?? (r.loop.active ? '' : 'autopilot paused for it');
      return `idle: ${open.length} task${open.length > 1 ? 's' : ''} to do${why ? ` (${why})` : ''}`;
    }
    if (mine.length && !open.length && this.phase === 'build') return 'idle: all its tasks are done';
    return 'idle';
  }

  // ── Stall detection ───────────────────────────────────────────────────

  /** Any output counts as progress; it also clears a stall flag. */
  private noteProgress(r: Runtime, w: TurnWatch, event: AgentEvent): void {
    w.lastEventAt = Date.now();
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
      this.emitAgent(r.cfg.id, { kind: 'log', text: '(output resumed)' });
      this.emit('state');
    } else if (!w.stall && looping && event.kind === 'tool' && !this.snoozed(w)) {
      this.flagStall(r, w, `ran the same command ${STALL_REPEAT} times in a row: ${short(w.recentTools[0])}`, 'loop');
    }
  }

  private snoozed(w: TurnWatch): boolean {
    return Boolean(w.snoozeUntil && Date.now() < w.snoozeUntil);
  }

  /** Periodic check: quiet for too long, or quiet while running a command that never exits. */
  private checkStall(r: Runtime, w: TurnWatch): void {
    if (w.stall || this.snoozed(w) || r.watch !== w) return;
    const now = Date.now();
    const fmt = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
    // A command that usually never exits, still the last tool call: count from when it started,
    // even if the agent keeps posting "still waiting…" messages (Codex does) in the meantime.
    const cmd = w.lastTool && LONG_RUNNING_RE.test(w.lastTool.detail) ? w.lastTool : undefined;
    if (cmd) {
      const since = Math.max(cmd.at, w.snoozeUntil ? w.snoozeUntil - quietMs(r.cfg) : 0);
      if (now - since >= STALL_LONG_RUNNING_MS) {
        const chatter = w.textsSinceTool ? `, only posting status messages (${w.textsSinceTool})` : '';
        this.flagStall(r, w, `has been running ${short(`${cmd.name} ${cmd.detail}`)} for ${fmt(now - cmd.at)}${chatter} (a command that may never exit)`, 'longrun');
      }
      return;
    }
    const quiet = now - w.lastEventAt;
    if (quiet < quietMs(r.cfg)) return;
    // A test/build/install still running (lastTool clears when it ends): give it longer from when it
    // started, even if the agent posted progress or someone chose Keep waiting since, so nobody nudges
    // (and kills) a slow test run.
    if (w.lastTool && SLOW_CMD_RE.test(w.lastTool.detail) && now - w.lastTool.at < Math.max(STALL_SLOW_CMD_MS, quietMs(r.cfg))) return;
    const running = w.lastTool && w.lastTool.at === w.lastEventAt ? w.lastTool : undefined;
    const what = running ? `, running ${short(`${running.name} ${running.detail}`)}` : '';
    this.flagStall(r, w, `has been quiet for ${fmt(quiet)}${what}`, 'quiet');
  }

  private flagStall(r: Runtime, w: TurnWatch, reason: string, kind: 'quiet' | 'longrun' | 'loop'): void {
    w.stall = { reason, since: Date.now(), kind };
    this.emitAgent(r.cfg.id, { kind: 'log', text: `⚠ may be stuck: ${reason}` });
    this.emit('state');
  }

  private stalls(): StallInfo[] {
    return [...this.agents.values()]
      .filter((r) => r.watch?.stall)
      .map((r) => ({ agent: r.cfg.id, name: r.cfg.name, reason: r.watch!.stall!.reason, since: r.watch!.stall!.since }));
  }

  /** Your answer to a stall banner: keep waiting, nudge (restart the turn with a hint), or stop. */
  stallAction(agentId: string, action: 'wait' | 'nudge' | 'stop'): void {
    const r = this.agents.get(agentId);
    const w = r?.watch;
    if (!r || !w || !r.current) return;
    if (action === 'stop') return this.stop(agentId);
    if (action === 'wait') {
      // Ask again after another full quiet period (or loop), counted from now.
      w.stall = undefined;
      w.snoozeUntil = Date.now() + quietMs(r.cfg);
      w.lastEventAt = Date.now();
      w.recentTools = [];
      this.emitAgent(agentId, { kind: 'log', text: '(you chose to keep waiting)' });
      this.emit('state');
      return;
    }
    r.killReason = 'nudge';
    r.current.kill();
  }

  /** The hand-off chain the app cut at the hop limit and nobody has restarted yet, for the App helper. */
  hopPaused(): { at: number; from: string; targets: string[]; restarts: number } | undefined {
    return this.hopPause && this.project ? { ...this.hopPause, restarts: this.chainRestarts } : undefined;
  }

  /** Restart a chain cut at the hop limit: the agents it was about to wake get their turns (the helper's action). */
  resumeChain(): string[] {
    const cut = this.hopPause;
    if (!cut) throw new Error('no hand-off chain is paused');
    if (this.chainRestarts >= MAX_CHAIN_RESTARTS) {
      throw new Error(`the chain was already restarted ${MAX_CHAIN_RESTARTS} times without a message from you; it needs your decision`);
    }
    // Only agents that can take a turn: an out-of-usage one stays paused (and doesn't use up a restart).
    const targets = cut.targets.filter((t) => this.agents.has(t) && this.available(t));
    if (!targets.length) throw new Error('nobody the chain was about to wake can take a turn right now (switched off or out of usage)');
    this.chainRestarts++;
    const left = cut.targets.filter((t) => !targets.includes(t));
    this.hopPause = left.length ? { ...cut, targets: left } : undefined;
    this.hops = 0;
    this.system(`The hand-off chain restarted (${targets.map((t) => this.nameOf(t)).join(', ') || 'nobody'}).`);
    for (const t of targets) void this.enqueue(t);
    this.emit('state');
    return targets;
  }

  /** Agents only see the room, DMs to them, and their own messages. */
  private canSee(id: string, m: ChatMessage): boolean {
    return m.to === 'all' || m.to === id || m.from === id;
  }

  /** In BUILD/REVIEW, remind each agent of the tasks it owns so it doesn't drift from tasks.json. */
  private async taskDigest(id: string): Promise<string> {
    if (this.phase === 'plan' || !this.project) return '';
    try {
      const tasks = await this.readTasks();
      const mine = tasks.filter((t) => t.owner === id);
      if (!mine.length) return 'You own no tasks in tasks.json.';
      const files = (t: Task) => (Array.isArray(t.files) && t.files.length ? ` (files: ${(t.files as string[]).join(', ')})` : '');
      const wait = (t: Task) => (OPEN(t) && !this.isReady(t, tasks) ? ` (waiting on ${this.depsOf(t).join(', ')}: don't start yet)` : '');
      const note = (t: Task) => (OPEN(t) && t.note ? ` (note: ${String(t.note).slice(0, 300)})` : '');
      // Each task shows the id#attempt to quote in its [[done: …]] report.
      return (
        'Your tasks (report each with [[done: <id>#<attempt> | …]]):\n' +
        mine.map((t) => `- ${t.id}#${this.attemptOf(t.id)}: ${t.title} [${t.status ?? 'todo'}]${files(t)}${wait(t)}${note(t)}`).join('\n')
      );
    } catch {
      return '';
    }
  }

  /** Agents hand work to each other with @id; capped so they can't loop forever. */
  private routeMentions(from: string, text: string): void {
    const targets = this.handoffTargets(from, text);
    if (!targets.length) return;
    if (this.hops >= MAX_AUTO_HOPS) {
      this.hopPause ??= { at: Date.now(), from, targets }; // keep the first cut: later mentions mustn't replace who it stopped
      this.system(`The agents passed work to each other ${MAX_AUTO_HOPS} times in a row, so the app stopped the chain there to save usage. Send any message to let them carry on.`);
      this.emit('state');
      return;
    }
    this.hops++;
    for (const t of targets) void this.enqueue(t);
  }

  /**
   * Teammates a reply hands work to. A line counts when it asks them something ("@codex can you…?")
   * or is addressed to them ("@grok please run the tests"). A name in a list or a plan ("t2 (@codex)")
   * doesn't. In BUILD with autopilot, an agent working through its own tasks gets turns anyway, so a
   * line addressed to it ("@grok the CLI is ready") only counts if it's a question.
   */
  private handoffTargets(from: string, text: string): string[] {
    const busyWithTasks = (id: string) =>
      this.phase === 'build' && this.autopilot && this.lastGoodTasks.some((t) => t.owner === id && OPEN(t));
    const found = new Set<string>();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const ids = this.mentions(line).filter((t) => t !== from);
      if (!ids.length) continue;
      const question = line.includes('?');
      const listItem = /^([-*•]|\d+[.)])\s/.test(line);
      const addressed = !listItem && /^@[\w-]+\b/.test(line);
      for (const id of ids) if (question || (addressed && !busyWithTasks(id))) found.add(id);
    }
    return [...found];
  }

  private mentions(text: string): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(MENTION_RE)) {
      const id = m[1].toLowerCase();
      if (this.agents.has(id)) found.add(id);
    }
    return [...found];
  }

  private preamble(r: Runtime): string {
    const p = this.project!;
    const others = [...this.agents.values()]
      .filter((o) => o !== r)
      .map((o) => `@${o.cfg.id} (${o.cfg.name})`)
      .join(', ');
    return `You are ${r.cfg.name} (@${r.cfg.id}), one agent in a team chat with the user and ${others}.

Project: ${p.name}
- Your working directory is your own git worktree on branch agent/${r.cfg.id}. Only edit files there.
- Shared team files (not in git): ${p.teamDir}/PLAN.md and ${p.teamDir}/tasks.json.
  tasks.json format: {"tasks":[{"id":"t1","title":"...","owner":"<agent id>","status":"todo|doing|done|blocked","files":["src/api/**"],"after":["t0"],"handoff":"...","note":"optional, e.g. why blocked"}]}
  "after" lists tasks that must be accepted first; don't start a task until they are. When you mark a task done,
  add a short "handoff": what you built, files changed, and key decisions. Whoever builds on it, and reviewers, read it.
  Also end that reply with [[done: <task id>#<attempt> | done | one-line summary]] (attempt is given in your instructions;
  use "| blocked | why" or "| partial | what's left" when you can't finish). The app checks it against your branch.
  "files" lists the paths a task owns (repo-relative; ** = any depth). When planning, the leader gives each
  agent separate areas and puts shared files (package.json, routers, shared types) under exactly one owner.
- Main branch lives at ${p.repoDir}. The user merges agent branches there from the app.

Rules:
- PLAN phase: discuss and critique; don't write code. Only the leader edits PLAN.md and tasks.json.
- BUILD phase: work only on tasks you own, commit to your branch, update your task status. If you're stuck, set the task to "blocked" with a "note".
  Only edit files inside your tasks' "files". If you need a change in a file another agent owns, @mention them and ask.
  With autopilot on you'll get repeated turns until your tasks are done or blocked, so keep each reply short.
- REVIEW phase: review teammates' branches (git log/diff main..agent/<id>) and report issues.
- Keep chat replies concise; put long detail in files. To hand work to a teammate, start a line with @id (or ask @id a question); naming someone in a list or a status update doesn't wake them.
- If you have nothing new to add, reply exactly [[pass]] (it isn't posted).
- To message one teammate privately (the user still sees it), start your reply with [[to: <id>]]. Use it for FYI notes, not for doing work out of sight.
- To ask a teammate something you need before you can continue, start your reply with [[ask: <id>]] and the question. Your turn ends there; their answer arrives as your next turn (or a note if they can't answer). Ask once; don't repeat the question.
- If you need a decision or information only the user can give, write @user with your question; the app flags it for them.
  If there are clear choices, add [[options: choice A | choice B | choice C]] and the user can answer with one click.
- If you are the leader: when planning is complete, end your reply with [[phase: build]]. Don't ask the user whether to start building; the marker is how they approve it, in one step.
  Work that passes review is merged into main by the app; you don't need to request it. Only for work that wasn't reviewed, ask with [[merge: <agent id>]].`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Tells the agent which model and effort it runs on; the CLIs don't, so agents can't answer "what model are you?". */
  private modelLine(r: Runtime): string {
    if (r.cfg.adapter === 'mock' || r.cfg.adapter === 'generic') return '';
    const { model, effort } = effectiveModel(r.cfg.adapter, r.settings.model, r.settings.effort, r.cfg.server);
    return `[you are running on model: ${model} | reasoning effort: ${effort}]`;
  }

  private defaultSettings(cfg: AgentConfig): AgentSettings {
    return { model: cfg.model ?? '', effort: cfg.effort ?? '', autonomy: cfg.autonomy ?? 'edits' };
  }

  private addUsage(r: Runtime, u: TurnUsage | undefined): void {
    const t = r.totals;
    t.turns++;
    if (u) {
      t.input += u.input;
      t.output += u.output;
      t.cached += u.cached;
    }
    if (u?.costUsd === undefined) t.unpricedTurns++;
    else t.costUsd += u.costUsd;
    this.emit('state');
  }

  private requireProject(): ProjectInfo {
    if (!this.project) throw new Error('Open or create a project first');
    return this.project;
  }

  private format(m: ChatMessage): string {
    const dm = m.to !== 'all' ? ` (private to ${this.nameOf(m.to)})` : '';
    const files = m.attachments?.length && this.project ? '\n' + describeAttachments(join(this.project.teamDir, 'attachments'), m.attachments) : '';
    return `${this.nameOf(m.from)}${dm}: ${m.text}${files}`;
  }

  private nameOf(id: string): string {
    if (id === 'user') return 'User';
    if (id === 'system') return 'System';
    return this.agents.get(id)?.cfg.name ?? id;
  }

  private system(text: string): void {
    this.add({ from: 'system', to: 'all', text });
  }

  /** Status noise (stopped/failed/timed out) for the user only, kept out of agents' context. */
  private notice(text: string): void {
    this.add({ from: 'system', to: 'user', text });
  }

  private add(m: Omit<ChatMessage, 'id' | 'ts'>): void {
    const msg: ChatMessage = { id: randomUUID(), ts: Date.now(), ...m };
    this.messages.push(msg);
    this.emit('message', msg);
    if (this.project) {
      appendFile(join(this.project.teamDir, 'chat.jsonl'), JSON.stringify(msg) + '\n').catch(console.error);
    }
  }

  private setStatus(r: Runtime, status: AgentStatus): void {
    r.status = status;
    if (status !== 'working') {
      r.inFlight = undefined;
      r.pid = undefined;
      r.stopping = false;
    }
    this.saveMeta(); // keeps the "running" marker current, for resume after a restart
    this.emitAgent(r.cfg.id, { kind: 'status', status });
    this.emit('state'); // the status line changes with it
  }

  private emitAgent(agentId: string, event: AgentEvent): void {
    if (event.kind === 'session') {
      // Saved as soon as the CLI names it, so a turn cut off by a restart resumes the same conversation.
      const r = this.agents.get(agentId);
      if (r && r.sessionId !== event.id) {
        r.sessionId = event.id;
        this.saveMeta();
      }
      return;
    }
    if (event.kind === 'limits') {
      // Plan usage belongs to the CLI's account: shown in the agent panel, not the log.
      const kind = this.agents.get(agentId)?.cfg.adapter;
      if (kind) setLimits(kind, event.windows);
      this.emit('state');
      return;
    }
    this.emit('agent_event', { agentId, event });
    this.recordActivity(agentId, event);
  }

  // ── Activity log ──────────────────────────────────────────────────────

  private recordActivity(agentId: string, event: AgentEvent): void {
    if (event.kind === 'limits' || event.kind === 'session') return;
    const text =
      event.kind === 'status'
        ? { working: '── turn started ──', idle: '── turn finished ──', error: '── turn ended with an error ──' }[event.status]
        : event.kind === 'tool'
          ? `▸ ${event.name} ${event.detail}`
          : event.text.trim();
    if (!text) return;
    const line: ActivityLine = { ts: Date.now(), kind: event.kind, text: text.length > 2000 ? text.slice(0, 2000) + '…' : text };
    const buf = this.activity.get(agentId) ?? [];
    buf.push(line);
    if (buf.length > ACTIVITY_KEEP) buf.splice(0, buf.length - ACTIVITY_KEEP);
    this.activity.set(agentId, buf);
    this.activityTotal.set(agentId, (this.activityTotal.get(agentId) ?? 0) + 1);
    if (this.project) {
      appendFile(join(this.project.teamDir, 'activity', `${agentId}.jsonl`), JSON.stringify(line) + '\n').catch(() => {});
    }
  }

  private loadActivity(): void {
    this.activity.clear();
    this.activityTotal.clear();
    const dir = join(this.project!.teamDir, 'activity');
    mkdirSync(dir, { recursive: true });
    for (const id of this.agents.keys()) {
      const file = join(dir, `${id}.jsonl`);
      if (!existsSync(file)) continue;
      const lines = this.readJsonl(file) as unknown as ActivityLine[];
      const keep = lines.slice(-ACTIVITY_KEEP);
      // Trim the file now and then so it doesn't grow forever.
      if (statSync(file).size > 2_000_000) writeFileSync(file, keep.map((l) => JSON.stringify(l)).join('\n') + '\n');
      this.activity.set(id, keep);
      this.activityTotal.set(id, keep.length);
    }
  }

  /** Last `n` activity lines per agent (for the panels after a reload). */
  activityHistory(n = 200): Record<string, ActivityLine[]> {
    return Object.fromEntries([...this.agents.keys()].map((id) => [id, (this.activity.get(id) ?? []).slice(-n)]));
  }

  /**
   * Activity since the cursors from a previous call (or the last `firstTime` lines per agent),
   * as readable text for the App helper. Returns the new cursors.
   */
  activitySince(cursors: Record<string, number> | undefined, firstTime = 25, max = 40): { text: string; cursors: Record<string, number> } {
    const sections: string[] = [];
    const next: Record<string, number> = {};
    for (const [id, r] of this.agents) {
      const total = this.activityTotal.get(id) ?? 0;
      next[id] = total;
      const buf = this.activity.get(id) ?? [];
      const fresh = cursors === undefined ? firstTime : Math.min(total - (cursors[id] ?? 0), buf.length);
      const lines = fresh > 0 ? buf.slice(-fresh).slice(-max) : [];
      if (!lines.length) continue;
      const time = (ts: number) => new Date(ts).toISOString().slice(11, 19);
      sections.push(`### ${r.cfg.name} (${r.status})\n${lines.map((l) => `${time(l.ts)} ${l.text.replace(/\n/g, ' ⏎ ').slice(0, 400)}`).join('\n')}`);
    }
    return { text: sections.join('\n\n'), cursors: next };
  }

  private runningNow(): { working: string[]; looping: string[]; at: number } | undefined {
    const all = [...this.agents.values()];
    const busy = all.filter((r) => (r.status === 'working' && !r.stopping) || r.pending);
    const working = new Set([...busy.map((r) => r.cfg.id), ...(this.resumeOffer?.working ?? [])]);
    const looping = new Set([...all.filter((r) => r.loop.active).map((r) => r.cfg.id), ...(this.resumeOffer?.looping ?? [])]);
    return working.size || looping.size ? { working: [...working], looping: [...looping], at: Date.now() } : undefined;
  }

  private saveMeta(): void {
    if (!this.project) return;
    const agents = Object.fromEntries(
      [...this.agents.values()].map((r) => [
        r.cfg.id,
        {
          // Which program the session and settings belong to: another one (changed in Setup) starts fresh.
          program: programKey(r.cfg),
          sessionId: r.sessionId,
          lastSeen: r.lastSeen,
          settings: r.settings,
          totals: r.totals,
          disabled: r.disabled,
          outUntil: r.outUntil,
          loopStopped: r.loop.active ? undefined : r.loop.stopped,
          // The running turn (or the one a restart cut off and you haven't continued yet).
          inFlight: r.status === 'working' && !r.stopping ? r.inFlight : this.resumeOffer?.instructions[r.cfg.id],
          pid: r.status === 'working' && !r.stopping ? r.pid : this.resumeOffer?.pids[r.cfg.id],
        },
      ]),
    );
    const meta = {
      leader: this.leader,
      phase: this.phase,
      gates: this.gates,
      autopilot: this.autopilot,
      roles: this.roles,
      reviewMode: this.reviewMode,
      testCommand: this.testCommand,
      desktopTestCommand: this.desktopTestCommand,
      attempts: this.attempts,
      sentBack: this.sentBack,
      doneOk: this.doneOk,
      askSeq: this.askSeq,
      needsYou: this.needsYou,
      requests: this.requests,
      // Who is mid-turn or on autopilot right now (plus an unanswered offer from the last restart), so a
      // restart can offer to continue. Empty after a normal stop.
      running: this.runningNow(),
      agents,
    };
    const file = join(this.project.teamDir, 'session.json');
    // Serialized, and tmp+rename so two turns finishing together can't leave a torn file.
    this.metaWrite = this.metaWrite
      .then(async () => {
        await writeFile(file + '.tmp', JSON.stringify(meta, null, 2));
        await rename(file + '.tmp', file);
      })
      .catch(console.error);
  }

  private readJson(path: string): any {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    } catch {
      return {};
    }
  }

  private readJsonl(path: string): ChatMessage[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ChatMessage];
        } catch {
          return [];
        }
      });
  }
}
