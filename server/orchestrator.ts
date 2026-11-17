import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { appendFile } from 'node:fs/promises';
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
  adoptArbiterResult,
  agentWritableDirs,
  conflictingAgents,
  createArbiterWorktree,
  removeArbiterWorktree,
  readTeamFiles,
  changedFiles,
  syncAgent,
  workSnapshot,
  writePlan,
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
  parseVerdict,
  saveReviews,
  isMachineStage,
  type Reviews,
  type StageKind,
} from './reviews.js';
import type {
  AgentConfig,
  AgentEvent,
  AgentSettings,
  AgentStatus,
  Autonomy,
  ChatMessage,
  Phase,
  TurnResult,
  TurnUsage,
} from './types.js';

import {
  DONE_RE,
  findMentions,
  handoffTargets,
  parseNeedsYou,
  PASS_RE,
  REQUEST_RE,
  reviewKey,
  USER_RE,
} from './orchestrator/markers.js';
import {
  AUTOPILOT_IDLE_LIMIT,
  AUTOPILOT_MAX_TURNS,
  clockTime,
  emptyTotals,
  MAX_AGENT_DMS,
  MAX_ASKS,
  MAX_AUTO_HOPS,
  MAX_CHAIN_RESTARTS,
  MAX_DISCUSSION_ROUNDS,
  NOT_ASKED_YET,
  OPEN,
  OUT_OPEN,
  programKey,
  TURN_TIMEOUT_MS,
  type ActivityLine,
  type OneShot,
  type PendingRequest,
  type Runtime,
  type StallInfo,
  type StallKind,
  type Task,
  type TurnPlan,
  type TurnWatch,
} from './orchestrator/types.js';
import { ActivityLog } from './orchestrator/activity.js';
import { WorktreeSetup } from './orchestrator/setup-runner.js';
import { AskBoard } from './orchestrator/asks.js';
import { DesktopTests } from './orchestrator/desktop-tests.js';
import { ReviewFlow } from './orchestrator/review-flow.js';
import { chatContext, isAway, queuePlan, requeueForRetry, routeReply, takePlan, type TurnCtx, type TurnStart } from './orchestrator/turns.js';
import { depsOf, handoffsFor, handoffText, isReady, TaskStore } from './orchestrator/tasks.js';
import { forgetSessionsElsewhere, readJson, readJsonl, writeAtomic } from './orchestrator/persistence.js';
import { checkStall, newWatch, noteProgress, snooze, WATCH_TICK_MS } from './orchestrator/stall.js';
import {
  activityOf,
  ALL_DONE_LEADER_INSTRUCTION,
  arbitrationInstruction,
  commentsInstruction,
  continueInstruction,
  DEBATE_CRITIQUE,
  DEBATE_PROPOSE,
  DEBATE_SYNTHESIS,
  desktopTestsLine,
  discussionRoundInstruction,
  modelLine,
  nudgeInstruction,
  oneShotPrompt,
  PHASE_HINT,
  phaseStartInstruction,
  preamble,
  RESUME_NOTE,
} from './orchestrator/prompts.js';

export type { PendingRequest, StallInfo } from './orchestrator/types.js';

/** State files restored from team/backups when they won't parse. */
const STATE_FILES = ['session.json', 'reviews.json'];
const PHASES: Phase[] = ['plan', 'build', 'review'];
const AUTONOMY: Autonomy[] = ['read', 'edits', 'auto', 'full'];
/** Model/effort ids go on the command line: safe characters, and no leading '-' so they can't become flags. */
const SAFE_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,63})?$/;
/** Model ids may also be provider-qualified (Hermes: "anthropic/claude-sonnet-4"), never start with - or /. */
const SAFE_MODEL = /^(?:[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127})?$/;

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
  /** team/tasks.json reads and the app's edits to it (see tasks.ts). */
  private tasks = new TaskStore({
    project: () => this.project,
    broken: (file, msg) =>
      this.system(
        `${file} isn't valid JSON (${msg}). The app keeps using the last valid task list until it's fixed. ` +
          `${this.nameOf(this.leader)}, please repair it with your file-edit tool (plain UTF-8, not PowerShell Set-Content or >).`,
      ),
  });
  /** Automatic merges of accepted work run one at a time. */
  private mergeQueue: Promise<unknown> = Promise.resolve();
  /** Optional roles (off by default) and how finished tasks are reviewed. Saved per project. */
  roles: RolesState = { enabled: false, assignments: {} };
  reviewMode: ReviewMode = 'off';
  /** Run before a task is accepted (e.g. "npm test"); empty = no tests step. */
  testCommand = '';
  /** Tests that need the real mouse and screen (e.g. Playwright drag tests): run only when you (or the App helper) press Run now. */
  desktopTestCommand = '';
  /** Desktop tests waiting for Run now, and the run in progress (see desktop-tests.ts). */
  private desktop = new DesktopTests({
    project: () => this.project,
    gen: () => this.gen,
    command: () => this.desktopTestCommand,
    review: (taskId) => this.reviews[taskId],
    readTasks: () => this.readTasks(),
    ensureSetup: (key, dir, logTo) => this.ensureSetup(key, dir, logTo),
    pendingSetup: (dirs) => this.pendingSetup(dirs),
    system: (text) => this.system(text),
    changed: () => this.emit('state'),
    queueReview: (fn) => {
      this.reviewQueue = this.reviewQueue.then(fn).catch(console.error);
      return this.reviewQueue;
    },
    applyVerdict: (taskId, by, stage, verdict, notes) => this.applyVerdict(taskId, by, stage, verdict, notes),
  });
  /** The review pipeline (see review-flow.ts); `reviews` and the review queue live there. */
  private review = this.newReviewFlow();
  /** Set when an agent fails with a usage/rate limit, so the UI can offer to switch setups. */
  limitHit?: { agent: string; name: string; text: string };
  /** Agents that were mid-turn, or on autopilot, when the app last closed: offered a Continue. */
  resumeOffer?: { working: string[]; looping: string[]; at: number; instructions: Record<string, string>; pids: Record<string, number> };
  /** tts.yaml setup in worktrees and review copies (see setup-runner.ts). */
  private setup = new WorktreeSetup({
    project: () => this.project,
    notice: (text) => this.notice(text),
    emitAgent: (agentId, event) => this.emitAgent(agentId, event),
    changed: () => this.emit('state'),
    nameOf: (id) => this.nameOf(id),
  });
  /** Setup → Agents save in progress. */
  private savingTeam = false;
  /** Agents that wrote @user: questions only you can answer. Cleared when you reply. */
  needsYou: { agent: string; name: string; text: string; ts: number; options?: string[] }[] = [];
  /** Tasks already announced as accepted, so dependants are released once. */
  private acceptedSeen = new Set<string>();
  /** Line comments on agents' branch diffs (team/comments.json). */
  comments: LineComment[] = [];
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
  /** Bumped on each message from you, ending any discussion rounds still going. */
  private discussionGen = 0;
  private agentDms = 0;
  /** Questions between agents ([[ask: id]]); open ones hold the asker's autopilot until answered. */
  private asks = new AskBoard({
    agent: (id) => this.agents.get(id),
    nameOf: (id) => this.nameOf(id),
    enqueue: (id, plan) => void this.enqueue(id, plan),
    emitAgent: (agentId, event) => this.emitAgent(agentId, event),
    system: (text) => this.system(text),
    saveMeta: () => this.saveMeta(),
    changed: () => this.emit('state'),
    unavailableReason: (r) => this.unavailableReason(r),
  });
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
  /** Recent activity per agent, for the panels and the App helper (see activity.ts). */
  private activity = new ActivityLog();
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
        ...this.desktop.view(),
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
        waitingFor: this.asks.waitingOn(r.cfg.id)?.to ?? null,
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
    this.tasks.reset();
    this.messages = readJsonl(join(this.project.teamDir, 'chat.jsonl'));
    // A state file that won't parse comes back from its newest good backup; then back up the good ones.
    const restored = STATE_FILES.map((f) => [f, restoreIfBroken(this.project!.teamDir, f)] as const).filter(([, b]) => b);
    backupTeamFiles(this.project.teamDir, [...STATE_FILES, 'tasks.json']);
    const meta = readJson(join(this.project.teamDir, 'session.json'));
    this.leader = meta.leader ?? 'user';
    this.phase = meta.phase ?? 'plan';
    this.gates = meta.gates ?? true;
    this.autopilot = meta.autopilot ?? false;
    this.roles = { enabled: Boolean(meta.roles?.enabled), assignments: meta.roles?.assignments ?? {} };
    this.reviewMode = REVIEW_MODES.includes(meta.reviewMode) ? meta.reviewMode : 'off';
    this.testCommand = typeof meta.testCommand === 'string' ? meta.testCommand : '';
    this.desktopTestCommand = typeof meta.desktopTestCommand === 'string' ? meta.desktopTestCommand : '';
    this.desktop.reset();
    this.reviews = loadReviews(this.project.teamDir);
    // A review request that was still being prepared when the app stopped: ask again.
    for (const e of Object.values(this.reviews)) if (e.status === 'in_review' && e.askedAt === NOT_ASKED_YET) e.waitingOn = undefined;
    this.comments = loadComments(this.project.teamDir);
    this.attempts = meta.attempts && typeof meta.attempts === 'object' ? meta.attempts : {};
    this.sentBack = meta.sentBack && typeof meta.sentBack === 'object' ? meta.sentBack : {};
    this.doneOk = meta.doneOk && typeof meta.doneOk === 'object' ? meta.doneOk : {};
    const legacy = !meta.doneOk;
    // Question ids keep counting across restarts, so q1 never means two different questions in one project.
    this.asks.reset(Number.isInteger(meta.askSeq) && meta.askSeq > 0 ? meta.askSeq : 0);
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

  /** tts.yaml setup in a worktree (see WorktreeSetup.ensure). */
  private ensureSetup(key: string, dir: string, logTo?: string): Promise<void> {
    return this.setup.ensure(key, dir, logTo);
  }

  /** A fresh, set-up review copy of `owner`'s branch (see WorktreeSetup.reviewCheckout). */
  private async reviewCheckout(owner: string, reviewer: string): Promise<{ dir: string; name: string }> {
    return this.setup.reviewCheckout(this.requireProject(), owner, reviewer);
  }

  /** What the agent should know about tts.yaml setup in its worktree. */
  private setupLine(dir: string | undefined): string {
    return this.setup.line(dir);
  }

  /** Setup still running in any of these folders, when tts.yaml says turns wait for it. */
  private pendingSetup(dirs: string[]): Promise<void>[] {
    return this.setup.pending(dirs);
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
    this.system(`Phase → ${phase.toUpperCase()}. ${PHASE_HINT[phase]}`);
    if (phase !== 'build') for (const r of this.agents.values()) r.loop.active = false;
    this.saveMeta();
    this.emit('state');
    this.kickPhase(phase);
  }

  /** Start work when a phase begins, so approving BUILD actually starts the build. */
  private kickPhase(phase: Phase): void {
    if (!this.project || phase === 'plan') return;
    const instruction = phaseStartInstruction(phase);
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
    return continueInstruction(t, this.attemptOf(t.id), this.handoffsFor(t, tasks));
  }

  // ── Task dependencies & hand-offs (see tasks.ts) ──────────────────────

  private depsOf(t: Task): string[] {
    return depsOf(t);
  }

  /** Ready = every task it comes "after" is accepted (done, and through review if review is on). */
  private isReady(t: Task, tasks: Task[]): boolean {
    return isReady(t, tasks, (dep) => this.accepted(dep));
  }

  private handoffText(t: Task): string {
    return handoffText(t);
  }

  /** The hand-off notes of the tasks this one depends on, for the agent picking it up. */
  private handoffsFor(t: Task, tasks: Task[]): string {
    return handoffsFor(t, tasks, (id) => this.nameOf(id));
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
    const { question, options } = parseNeedsYou(text);
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

  /**
   * After a BUILD turn: give the agent another turn if it still has open tasks and is making progress.
   * Stops on: all its tasks done/blocked, no progress for AUTOPILOT_IDLE_LIMIT turns, or the turn cap.
   */
  private async continueLoop(r: Runtime, before: string | undefined): Promise<void> {
    const loop = r.loop;
    if (!loop.active || !this.autopilot || this.phase !== 'build' || !this.project) return;
    // Waiting for a teammate's answer: the answer starts its next turn.
    if (this.asks.waitingOn(r.cfg.id)) return;
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
      void this.enqueue(this.leader, { instruction: ALL_DONE_LEADER_INSTRUCTION });
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

  private readTasks(): Promise<Task[]> {
    return this.tasks.read();
  }

  /** The task list from the last time tasks.json parsed. */
  private get lastGoodTasks(): Task[] {
    return this.tasks.last;
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
    this.asks.cancelFrom(id);
    this.asks.failTo(id, 'it was stopped');
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
    if (this.desktop.active()) this.cancelDesktopTests();
    if (this.debating) this.debateCancelled = true;
    this.discussionGen++; // ends any plan-phase discussion rounds
    // Withdraw every question first, so stopping one agent can't restart another with a "no answer" turn.
    this.asks.cancelFrom();
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
      this.desktop.turnedOff();
    }
    this.saveMeta();
    this.emit('state');
  }

  /**
   * Run the desktop tests for a waiting task. From you: now. From the App helper: after a countdown you
   * can cancel (the banner shows it), since they take over the mouse.
   */
  runDesktopTests(taskId: string, by: 'user' | 'helper'): void {
    this.desktop.start(taskId, by);
  }

  cancelDesktopTests(quiet = false): void {
    this.desktop.cancel(quiet);
  }

  /** Accept the task without its desktop tests (only you can do this, not the App helper). */
  skipDesktopTests(taskId: string): void {
    this.desktop.skip(taskId);
  }

  /** Desktop tests waiting for Run now, for the App helper's view (none while a run is counting down or running). */
  desktopTestsWaiting(): string[] {
    return this.desktop.nextWaiting();
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
      if (changedProgram.length) await forgetSessionsElsewhere(this.project?.name, changedProgram);
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
        !this.asks.waitingOn(r.cfg.id),
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

  /** The review pipeline's view of the orchestrator: live getters, so it always sees the current state. */
  private newReviewFlow(): ReviewFlow {
    const o = this;
    return new ReviewFlow({
      get agents() { return o.agents; },
      get project() { return o.project; },
      get gen() { return o.gen; },
      get phase() { return o.phase; },
      get autopilot() { return o.autopilot; },
      get roles() { return o.roles; },
      get reviewMode() { return o.reviewMode; },
      get testCommand() { return o.testCommand; },
      get desktopTestCommand() { return o.desktopTestCommand; },
      get attempts() { return o.attempts; },
      get sentBack() { return o.sentBack; },
      get doneOk() { return o.doneOk; },
      get noCommits() { return o.noCommits; },
      get acceptedSeen() { return o.acceptedSeen; },
      attemptOf: (taskId) => o.attemptOf(taskId),
      doneChecked: (t) => o.doneChecked(t),
      settleDone: (id, t, attempt, note, reported) => o.settleDone(id, t, attempt, note, reported),
      readTasks: () => o.readTasks(),
      updateTask: (taskId, patch) => o.updateTask(taskId, patch),
      wakeForNewTasks: (tasks) => o.wakeForNewTasks(tasks),
      onTaskAccepted: (taskId) => o.onTaskAccepted(taskId),
      checkAllDone: (tasks) => o.checkAllDone(tasks),
      roleOf: (id) => o.roleOf(id),
      available: (id) => o.available(id),
      unavailableReason: (r) => o.unavailableReason(r),
      enqueue: (id, plan) => o.enqueue(id, plan),
      reviewCheckout: (owner, reviewer) => o.reviewCheckout(owner, reviewer),
      ensureSetup: (key, dir, logTo) => o.ensureSetup(key, dir, logTo),
      pendingSetup: (dirs) => o.pendingSetup(dirs),
      queueDesktop: (taskId) => o.desktop.queue(taskId),
      nameOf: (id) => o.nameOf(id),
      system: (text) => o.system(text),
      notice: (text) => o.notice(text),
      emitAgent: (agentId, event) => o.emitAgent(agentId, event),
      emit: (event) => void o.emit(event),
      saveMeta: () => o.saveMeta(),
    });
  }

  // ── Review pipeline (see review-flow.ts) ──────────────────────────────

  get reviews(): Reviews {
    return this.review.reviews;
  }
  set reviews(v: Reviews) {
    this.review.reviews = v;
  }
  private get reviewQueue(): Promise<void> {
    return this.review.reviewQueue;
  }
  private set reviewQueue(v: Promise<void>) {
    this.review.reviewQueue = v;
  }

  /** The checks a task owned by `owner` goes through once it's marked done. */
  private pipelineFor(owner: string): StageKind[] {
    return this.review.pipelineFor(owner);
  }

  private reopenedByStaleTurn(t: Task): boolean {
    return this.review.reopenedByStaleTurn(t);
  }

  private accepted(t: Task): boolean {
    return this.review.accepted(t);
  }

  /** Move reviews along after tasks.json changed (serialized). */
  private advanceReviews(): void {
    this.review.advanceReviews();
  }

  private dispatchStage(t: Task): Promise<void> {
    return this.review.dispatchStage(t);
  }

  private onReviewReply(id: string, text: string, turnStartedAt: number, openAtStart: Record<string, string> = {}, anywhere = false): void {
    this.review.onReviewReply(id, text, turnStartedAt, openAtStart, anywhere);
  }

  private applyVerdict(taskId: string, by: string, stage: StageKind, verdict: 'approve' | 'changes', notes: string): Promise<void> {
    return this.review.applyVerdict(taskId, by, stage, verdict, notes);
  }

  private dispatchParked(): Promise<void> {
    return this.review.dispatchParked();
  }

  /** The user's buttons in the Tasks tab: approve, send back with a note, or restart the review. */
  reviewAction(taskId: string, action: 'approve' | 'send_back' | 'restart' | 'reassign' | 'set_owner', note = ''): Promise<void> {
    return this.review.reviewAction(taskId, action, note);
  }

  private saveReviewState(): void {
    this.review.saveReviewState();
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
      instruction: commentsInstruction(agent, batch.map((c) => this.describeComment(c))),
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


  /** Change one task in tasks.json (queued; see TaskStore.update). */
  private updateTask(taskId: string, patch: Partial<Task> | ((t: Task) => Partial<Task> | undefined)): Promise<boolean> {
    return this.tasks.update(taskId, patch);
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
    const instruction = arbitrationInstruction({ id, name: this.nameOf(id), sides, files, branch: ws.branch, teamDir: p.teamDir, testCommand: this.testCommand });
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
    this.asks.newRound();
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
        await this.enqueue(t, { instruction: discussionRoundInstruction(round, MAX_DISCUSSION_ROUNDS) });
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
            instruction: DEBATE_PROPOSE,
          }),
        ),
      );
      if (this.debateCancelled) return this.system('Debate stopped.');
      this.system('Debate round 2: critiques.');
      await Promise.all(
        ids.map((id) =>
          this.enqueue(id, { instruction: DEBATE_CRITIQUE }),
        ),
      );
      if (this.debateCancelled) return this.system('Debate stopped.');
      if (this.leader !== 'user') {
        this.system(`Debate synthesis: ${this.nameOf(this.leader)}.`);
        await this.enqueue(this.leader, { instruction: DEBATE_SYNTHESIS });
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
    const prompt = oneShotPrompt(r.cfg, this.project.name, this.modelLine(r), job.instruction);
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
    if (isAway(r, plan)) {
      this.skipAway(r, plan);
      return Promise.resolve();
    }
    queuePlan(r, plan);
    // Already waiting: it will see every new message when its turn starts.
    if (r.pending) return r.chain;
    r.pending = true;
    const gen = this.gen;
    const stopGen = r.stopGen;
    r.chain = r.chain.then(() => this.runTurn(r, gen, stopGen)).catch((err) => console.error(err));
    return r.chain;
  }

  /** A turn for an agent that is away: keep work that mustn't be lost, and tell a waiting asker now. */
  private skipAway(r: Runtime, plan: TurnPlan): void {
    this.noteSkipped(r);
    if (plan.keepIfAway && plan.instruction) (r.awayWork ??= []).push(plan.instruction);
    this.asks.failAway(r, plan);
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

  /** One turn: take its plan, build the prompt, run the CLI, then handle the reply or the failure. */
  private async runTurnBody(r: Runtime, gen: number, stopGen: number, retry: boolean): Promise<void> {
    const start = await this.startTurn(r, gen, stopGen, retry);
    if (!start) return;
    const ctx = await this.turnPrompt(start);
    if (!ctx) return;
    const { prompt, images } = ctx;
    const { id, plan } = ctx.c;
    const project = this.project!;

    const before = await this.loopSnapshot(r);
    r.killReason = undefined;
    r.stopping = false;
    r.inFlight = plan.instruction;
    this.setStatus(r, 'working');
    const eff = effectiveModel(r.cfg.adapter, r.settings.model, r.settings.effort, r.cfg.server);
    this.emitAgent(id, { kind: 'log', text: `model: ${eff.model} · effort: ${eff.effort} · ${r.settings.autonomy}` });
    const watch = newWatch();
    const c: TurnCtx = { ...ctx.c, watch };
    r.watch = watch;
    const turn = r.adapter.runTurn({
      prompt,
      cwd: project.agentDirs[id],
      extraDirs: [...agentWritableDirs(project, id), ...(plan.extraDirs ?? [])],
      settings: r.settings,
      images,
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
    c.timer = setTimeout(() => {
      r.killReason = 'timeout';
      turn.kill();
    }, TURN_TIMEOUT_MS);
    const watchdog = setInterval(() => this.checkStall(r, watch), WATCH_TICK_MS);

    try {
      const res = await turn.done;
      if (gen !== this.gen) return; // project switched mid-turn: drop the late result
      await this.onTurnDone(c, res, before);
    } catch (err) {
      if (gen !== this.gen) return;
      // Awaited, so this attempt's finally (which clears `answering`) runs only after a retry finishes.
      return await this.onTurnFailed(c, err as Error);
    } finally {
      clearTimeout(c.timer);
      clearInterval(watchdog);
      if (r.watch === watch) {
        const wasStalled = Boolean(watch.stall);
        r.watch = undefined;
        if (wasStalled && gen === this.gen) this.emit('state');
      }
      if (r.answering === c.owed?.id) r.answering = undefined;
      if (r.current === turn) r.current = undefined;
      if (gen === this.gen) {
        this.saveMeta();
        this.emit('branches'); // the agent may have committed
        // A "done" this turn wrote but didn't get checked (e.g. the turn failed) is checked now it's over.
        this.advanceReviews();
      }
    }
  }

  /**
   * Turn step 1: wait out a team save, drop a turn queued before a Stop, take the plan (a question's
   * first), skip it if there's nothing to do or the agent is away, and wait for worktree setup.
   * Undefined: no turn runs.
   */
  private async startTurn(
    r: Runtime,
    gen: number,
    stopGen: number,
    retry: boolean,
  ): Promise<TurnStart | undefined> {
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
    const { plan, more } = takePlan(r);
    if (more) this.requeue(r, gen, stopGen);
    // The question this turn answers (if it's still waiting): its reply goes back to the asker.
    const owed = this.asks.open(plan.askId);
    // That question was withdrawn, failed or expired meanwhile: nothing to answer.
    if (plan.askId && !owed) return;
    // Queued before the agent went out (or was switched off): don't run it now. Its reviews were
    // released when it went out, so they go to someone else.
    if (isAway(r, plan)) {
      this.skipAway(r, plan);
      return;
    }
    // A send-back whose task you accepted while it waited: nothing left to do.
    if (plan.forTask && this.reviews[plan.forTask]?.status === 'passed') {
      this.emitAgent(r.cfg.id, { kind: 'log', text: `(skipped the queued turn for ${plan.forTask}: it was accepted meanwhile)` });
      // Autopilot carries on with its other ready tasks (or ends the run if there are none).
      if (r.loop.active) void this.startLoops([r.cfg.id]);
      return;
    }
    r.activity = activityOf(plan.instruction);
    const startedAt = Date.now();
    if (!retry || !r.turnStartedAt) r.turnStartedAt = startedAt;
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
    return { r, id: r.cfg.id, gen, stopGen, retry, plan, owed, startedAt, openAtStart, attemptsAtStart: { ...this.attempts } };
  }

  /**
   * Turn step 2: the prompt (preamble on a fresh conversation, turn header, task digest, the chat it
   * hasn't seen, the instruction, where the reply goes). Undefined: nothing to do, so no turn runs.
   */
  private async turnPrompt(s: TurnStart): Promise<{ c: Omit<TurnCtx, 'watch'>; prompt: string; images: string[] } | undefined> {
    const { r, id, plan, owed } = s;
    const project = this.project!;
    const fresh = !r.sessionId || !r.adapter.supportsResume;
    const { context, newAttachments, replyTo, seenUpTo } = chatContext(this.messages, {
      id,
      lastSeen: r.lastSeen,
      plan,
      owed,
      fresh,
      isAgent: (a) => this.agents.has(a),
      canSee: (m) => this.canSee(id, m),
    });
    if (!context.length && !plan.instruction) {
      // Nothing left to do (e.g. its send-back was withdrawn by an acceptance): autopilot carries on.
      if (r.loop.active) void this.startLoops([id]);
      return;
    }
    const images = newAttachments.filter(isImage).map((a) => join(project.teamDir, 'attachments', a));

    const prompt = [
      fresh ? this.preamble(r) : '',
      `[phase: ${this.phase} | leader: ${this.nameOf(this.leader)}${this.leader === id ? ' (you)' : ''}]`,
      this.modelLine(r),
      this.setupLine(project.agentDirs[id]),
      this.roleLine(id),
      this.desktopTestCommand && this.phase === 'build'
        ? desktopTestsLine(this.desktopTestCommand)
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
    return { c: { ...s, fresh, replyTo, seenUpTo }, prompt, images };
  }

  /** Turn step 3a: the CLI answered. Post the reply, act on its markers, then let autopilot decide what's next. */
  private async onTurnDone(c: TurnCtx, res: TurnResult, before: string | undefined): Promise<void> {
    const { r, id, owed } = c;
    if (res.sessionId) r.sessionId = res.sessionId;
    r.lastSeen = c.seenUpTo;
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
    // A question to a teammate: post it privately to them; the asker gets the answer next turn.
    const { text, to, askTo, askRefused } = routeReply(res.text.trim(), {
      id,
      replyTo: c.replyTo,
      owed,
      isAgent: (a) => this.agents.has(a),
      canAsk: this.asks.canAsk(),
    });
    if (askRefused) this.notice(`Questions between agents reached the limit of ${MAX_ASKS} for now, so ${r.cfg.name}'s question went to the room. Reply to continue.`);
    if (owed && askTo) owed.nested = true; // it asked someone else first; its next turn still owes the answer
    if (owed && !askTo) {
      // A Grok turn cut short by a refused command returns a fragment plus a warning, not an answer.
      if (/turn ended early: .*refused/i.test(text)) {
        this.asks.settle(owed, 'failed');
        this.asks.resumeAsker(owed, `${r.cfg.name}'s turn was cut short by a refused command before it could answer your question (${owed.id}). Continue without it, ask someone else, or ask the user (@user).`);
      } else this.asks.answer(owed, !text || PASS_RE.test(text) ? '' : text);
    }
    let settled = new Set<string>();
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
      settled = await this.applyDoneReports(id, text, c.attemptsAtStart).catch((e) => (console.error('done report:', e), settled));
      this.onReviewReply(id, text, c.startedAt, c.openAtStart);
      this.onCommentMarkers(id, text);
      if (askTo) {
        this.asks.start(id, askTo, text);
      } else if (to === 'all') {
        if (!this.debating) this.routeMentions(id, text);
      } else if (to !== 'user' && this.agents.has(to) && !owed) {
        // A reply to a question already went back to the asker via answerAsk.
        this.sendAgentDm(id, to);
      }
    }
    // Before autopilot decides what's next: a "done" from this turn is checked (or reopened if stale).
    await this.settleMarkedDone(id, c.attemptsAtStart, settled).catch((e) => console.error('done check:', e));
    await this.checkScopeAfterTurn(r).catch(() => {});
    this.advanceReviews();
    await this.continueLoop(r, before);
  }

  /**
   * Turn step 3b: the turn failed or was cut off. Stopped: say so. Timed out or nudged: keep what it
   * said, then stop there or start a new turn that says why. A lost session or a too-long conversation:
   * retry once fresh. A model that needs paid credits: fall back to the previous model and retry once.
   */
  private async onTurnFailed(c: TurnCtx, err: Error): Promise<void> {
    const { r, id, plan, owed, retry, fresh, watch } = c;
    const reason = r.killReason;
    // Any failure pauses this agent's autopilot (a retry below re-checks the loop on success).
    const wasLooping = r.loop.active;
    const prevStopped = r.loop.stopped;
    if (reason || fresh || retry) {
      r.loop.active = false;
      // A usage limit governs its own return (out of usage until the reset, then it continues), so it
      // isn't a pause that needs you.
      r.loop.stopped = classifyFailure(err.message) === 'limit' && !reason ? undefined : 'paused after a failed turn; see its panel';
    }
    if (reason === 'stopped') {
      this.setStatus(r, 'idle');
      this.notice(`${r.cfg.name} stopped.`);
      this.asks.failTo(id, 'it was stopped');
      return;
    }
    if (reason === 'timeout' || reason === 'nudge') {
      // Keep what it said before being cut off: it may already hold the answer (e.g. a verdict).
      const partial = watch.texts.join('\n\n').trim();
      if (partial) {
        this.add({ from: id, to: c.replyTo, text: partial, ...(owed ? { ask: true } : {}) });
        r.lastSeen = c.seenUpTo;
        this.collectRequests(id, partial);
        this.onReviewReply(id, partial, c.startedAt, c.openAtStart, true);
      }
      const kept = partial ? ' What it said before that is posted above.' : '';
      if (reason === 'timeout') {
        this.emitAgent(id, { kind: 'log', text: `✖ turn stopped at the ${TURN_TIMEOUT_MS / 60_000}-min limit` });
        this.setStatus(r, 'error');
        this.notice(`${r.cfg.name} was stopped at the ${TURN_TIMEOUT_MS / 60_000}-min turn limit.${kept}`);
        this.asks.failTo(id, 'its turn hit the time limit');
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
        instruction: nudgeInstruction(stuck),
      });
      return;
    }
    // A resumed turn that fails outright usually means the CLI lost the session
    // (cleaned up, expired, other machine). Start fresh once: the fresh prompt resends recent chat.
    r.lastOutcome = 'failed';
    const message = err.message;
    const kind = classifyFailure(message);
    // Retry with a fresh session only when that can help: a lost session (unknown failure on a
    // resumed turn) or a conversation that grew too long. Never for limits, logins or bad models.
    if (!retry && ((!fresh && kind === 'unknown') || (kind === 'context' && r.sessionId))) {
      this.notice(kind === 'context' ? failureHint(kind, r.cfg.name, r.cfg.command) : `${r.cfg.name}'s session couldn't be resumed; starting a fresh one.`);
      r.sessionId = undefined;
      requeueForRetry(r, plan);
      r.current = undefined;
      clearTimeout(c.timer);
      return await this.runTurn(r, c.gen, c.stopGen, true);
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
      requeueForRetry(r, plan);
      r.current = undefined;
      clearTimeout(c.timer);
      return await this.runTurn(r, c.gen, c.stopGen, true);
    }
    this.emitAgent(id, { kind: 'log', text: `✖ turn failed (${kind}): ${message.slice(0, 1000)}` });
    this.setStatus(r, 'error');
    this.noteLimit(r, message);
    // A usage limit is handled (noteLimit said what happens), so it isn't reported as a failure.
    const hint = failureHint(kind, r.cfg.name, r.cfg.command, r.cfg.server ? r.settings.model : undefined);
    if (kind !== 'limit') this.notice(`${r.cfg.name} failed: ${hint || message.slice(0, 500)}${hint ? ` (details: ${message.slice(0, 200)})` : ''}${wasLooping ? ' Autopilot paused for it.' : ''}`);
    this.asks.failTo(id, `its turn failed (${kind})`);
  }

  // ── Status line ───────────────────────────────────────────────────────

  /** "working: building t3" / "waiting on t1 (Claude)" / "blocked: t2 …" / "idle", from what's known now. */
  private statusLine(r: Runtime): string {
    const id = r.cfg.id;
    if (r.status === 'working') return `working: ${r.activity ?? 'replying'}`;
    const setting = this.project && this.setup.runningIn(this.project.agentDirs[id]);
    if (setting) return `setting up its worktree: ${setting}`;
    if (r.pending) return 'queued: its turn is next';
    if (r.status === 'error') return 'last turn failed (see its activity)';
    if (r.disabled) return 'off: switched off in its panel';
    if (r.outUntil && r.outUntil > Date.now()) return `out of usage until ${clockTime(r.outUntil)}`;
    const asked = this.asks.waitingOn(id);
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

  // ── Stall detection (see stall.ts) ────────────────────────────────────

  /** Any output counts as progress; it also clears a stall flag. */
  private noteProgress(r: Runtime, w: TurnWatch, event: AgentEvent): void {
    const found = noteProgress(w, event);
    if (found === 'resumed') {
      this.emitAgent(r.cfg.id, { kind: 'log', text: '(output resumed)' });
      this.emit('state');
    } else if (found) this.flagStall(r, w, found.reason, found.kind);
  }

  /** Periodic check: quiet for too long, or quiet while running a command that never exits. */
  private checkStall(r: Runtime, w: TurnWatch): void {
    if (r.watch !== w) return;
    const found = checkStall(w, r.cfg);
    if (found) this.flagStall(r, w, found.reason, found.kind);
  }

  private flagStall(r: Runtime, w: TurnWatch, reason: string, kind: StallKind): void {
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
      snooze(w, r.cfg);
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

  private handoffTargets(from: string, text: string): string[] {
    // In BUILD with autopilot, an agent working through its own tasks gets turns anyway (see markers.ts).
    const busyWithTasks = (id: string) =>
      this.phase === 'build' && this.autopilot && this.lastGoodTasks.some((t) => t.owner === id && OPEN(t));
    return handoffTargets(from, text, (id) => this.agents.has(id), busyWithTasks);
  }

  private mentions(text: string): string[] {
    return findMentions(text, (id) => this.agents.has(id));
  }

  private preamble(r: Runtime): string {
    const others = [...this.agents.values()]
      .filter((o) => o !== r)
      .map((o) => `@${o.cfg.id} (${o.cfg.name})`)
      .join(', ');
    return preamble(r.cfg, others, this.project!);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Tells the agent which model and effort it runs on; the CLIs don't, so agents can't answer "what model are you?". */
  private modelLine(r: Runtime): string {
    return modelLine(r.cfg, r.settings);
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
    this.activity.record(this.project?.teamDir, agentId, event);
  }

  private loadActivity(): void {
    this.activity.load(this.project!.teamDir, this.agents.keys());
  }

  /** Last `n` activity lines per agent (for the panels after a reload). */
  activityHistory(n = 200): Record<string, ActivityLine[]> {
    return this.activity.history(this.agents.keys(), n);
  }

  /**
   * Activity since the cursors from a previous call (or the last `firstTime` lines per agent),
   * as readable text for the App helper. Returns the new cursors.
   */
  activitySince(cursors: Record<string, number> | undefined, firstTime = 25, max = 40): { text: string; cursors: Record<string, number> } {
    const agents = [...this.agents.values()].map((r) => ({ id: r.cfg.id, name: r.cfg.name, status: r.status }));
    return this.activity.since(agents, cursors, firstTime, max);
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
      askSeq: this.asks.seq,
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
      .then(() => writeAtomic(file, JSON.stringify(meta, null, 2)))
      .catch(console.error);
  }
}
