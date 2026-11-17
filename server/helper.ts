import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './agents/index.js';
import { trustGitDir } from './agents/codex.js';
import { ATTACHMENT_NOTE, describeAttachments, isImage, validAttachments } from './attachments.js';
import { classifyFailure, parseResetTime } from './failures.js';
import { logsSince } from './logbuffer.js';
import { OPERATOR_RULES, parseActions, type OperatorAction, type ProjectView } from './operator.js';
import { diffWithWorktree, gitIdentity, runGit } from './project.js';
import { isRecord, loadJsonFile, mayWrite } from './safe-json.js';
import { errText, logOnce } from './report.js';
import type { AgentAdapter, AgentConfig, AgentStatus, Turn } from './types.js';

/**
 * The App helper: a private chat with Claude about the app itself (not your projects).
 * It works in its own git worktree of the app's source on branch `app-helper`, so nothing it edits
 * touches the running app until you click Apply & restart. Apply typechecks, merges, and restarts
 * through scripts/supervisor.mjs, which also rolls back an update that crashes on startup.
 */

const BRANCH = 'app-helper';
const STATE_DIR = join(homedir(), '.thinktank');
// One helper chat per projects folder: a second app instance (tests, another team) keeps its own.
const STATE_FILE = join(
  STATE_DIR,
  process.env.TTS_PROJECTS_DIR ? `helper-${createHash('sha1').update(resolve(process.env.TTS_PROJECTS_DIR)).digest('hex').slice(0, 8)}.json` : 'helper.json',
);
const CLI_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', hermes: 'Hermes' };
const PENDING_FILE = join(STATE_DIR, 'pending-apply.json');
const ROLLBACK_NOTE = join(STATE_DIR, 'rollback-note.json');
const MAX_MESSAGES = 200;
/** After a restart, an update counts as healthy once the server has stayed up this long. */
const HEALTHY_AFTER_MS = 20_000;
/** Operator mode waits this long after something needs you, so you can act first if you're watching. */
const OPERATOR_DELAY_MS = Number(process.env.TTS_OPERATOR_DELAY_S ?? 45) * 1000;
/** Something the helper left for the user, still waiting this long later, gets one more look. */
const OPERATOR_RECHECK_MS = Number(process.env.TTS_OPERATOR_RECHECK_MIN ?? 30) * 60_000;
/** At most this many automatic project checks an hour, to protect your usage. */
const OPERATOR_MAX_PER_HOUR = 8;

export interface HelperMessage {
  id: string;
  ts: number;
  from: 'user' | 'helper' | 'system';
  text: string;
  /** Attached file names (images or text) in ~/.thinktank/attachments. */
  attachments?: string[];
}

interface HelperState {
  messages: HelperMessage[];
  sessionId?: string;
  /** Which CLI the session belongs to: a Claude session can't be resumed by Codex or Grok. */
  sessionAdapter?: string;
  /** The CLI changed: the next new conversation gets this chat's recent messages (kept until a turn succeeds). */
  carryOver?: boolean;
  editMode: boolean;
  /** "Run my project": the helper handles what waits on you in the open project (see operator.ts). */
  operate?: boolean;
  /** Last applied update, so Undo can go back to the version before it. */
  undo?: { sha: string; applied: string };
}

export interface HelperContext {
  /** Recent failures/notices from the team room, so the helper sees what you saw. */
  /** Notices shown to the user, with their absolute chat message numbers. */
  recentIssues: () => { at: number; text: string }[];
  /** The open project's folders; the helper may read them (never change them) when debugging. */
  project: () => { root: string; teamDir: string; repoDir: string; agentDirs: Record<string, string> } | undefined;
  /** Agents' recent activity (tool calls, CLI output, failures) since the given cursors. */
  activitySince: (cursors: Record<string, number> | undefined) => { text: string; cursors: Record<string, number> };
  agentsBusy: () => boolean;
  stopAgents: () => void;
  /** The open project as operator mode sees it: what waits on you, plus state and recent chat. */
  view: () => ProjectView | undefined;
  /** Carry out one [[act: ...]] from the helper; returns a line for the chat, throws with the reason. */
  act: (action: OperatorAction) => Promise<string>;
}

export class AppHelper extends EventEmitter {
  readonly appRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  // One worktree per app copy, in case you have more than one clone.
  readonly wtDir = join(STATE_DIR, `app-helper-${createHash('sha1').update(this.appRoot).digest('hex').slice(0, 8)}`);
  private state: HelperState = { messages: [], editMode: false };
  private adapter: AgentAdapter;
  private status: AgentStatus = 'idle';
  private current?: Turn;
  private logCursor = 0;
  private issuesSeen = 0;
  /** The project `issuesSeen` counts in. */
  private issuesProject?: string;
  private activityCursors?: Record<string, number>;
  private gitOk = false;
  private ready: Promise<void>;
  /** Operator mode: items already looked at, the pending check, and when recent checks ran. */
  /** Item key → when it was looked at (Infinity: looked at twice, it's the user's now). */
  private handled = new Map<string, number>();
  /** The helper's CLI is out of usage until then: no automatic checks before it. */
  private limitUntil = 0;
  private opTimer?: NodeJS.Timeout;
  /** When the pending check fires, so a new item can bring it forward. */
  private opTimerAt = 0;
  private opRuns: number[] = [];
  private opCapNoted = false;
  /** Set (synchronously) when a chat message or project check starts; cleared after its last action. */
  private busy = false;
  /** Bumped each time Run my project is switched, so a reply from before the switch can't act. */
  private opGen = 0;
  /** Whose conversation a saved session id is: the CLI, or 'mock' (a mock id must never reach a real CLI). */
  private sessionTag = '';
  /** Set by a chat send: the hand-over stops before the message being sent (it's in the prompt already). */
  private handoverUpTo?: number;

  constructor(
    private cfg: AgentConfig,
    mock: boolean,
    private ctx: HelperContext,
  ) {
    super();
    this.adapter = createAdapter(cfg, mock);
    this.sessionTag = mock ? 'mock' : cfg.adapter;
    this.load();
    this.ready = this.setup().catch((e) => console.error('App helper setup failed:', e.message));
  }

  get supervised(): boolean {
    return process.env.TTS_SUPERVISED === '1';
  }

  /** Run my project is on. */
  get operating(): boolean {
    return Boolean(this.state?.operate);
  }

  async snapshot() {
    await this.ready;
    return {
      messages: this.state.messages,
      status: this.status,
      editMode: this.state.editMode,
      operate: Boolean(this.state.operate),
      automaticPause: this.automaticPause(),
      gitOk: this.gitOk,
      supervised: this.supervised,
      undoAvailable: Boolean(this.state.undo),
      changes: await this.changes().catch((e) => {
        logOnce('helper changes', e); // shown as no changes; gitOk tells the page when git itself is missing
        return { files: [] as string[], ahead: 0 };
      }),
    };
  }

  private automaticPause(): { reason: 'usage' | 'hourly'; until: number | 'message' } | null {
    const now = Date.now();
    if (this.limitUntil === Infinity) return { reason: 'usage', until: 'message' };
    const runs = this.opRuns.filter((t) => now - t < 3_600_000);
    const capUntil = runs.length >= OPERATOR_MAX_PER_HOUR ? runs[0] + 3_600_000 : 0;
    const until = Math.max(this.limitUntil, capUntil);
    return until > now ? { reason: capUntil > this.limitUntil ? 'hourly' : 'usage', until } : null;
  }

  // ── Setup ─────────────────────────────────────────────────────────────

  private load(): void {
    const saved = loadJsonFile<Partial<HelperState>>(STATE_FILE, {}, {
      label: `The helper's chat file (.thinktank/${basename(STATE_FILE)} in your home folder)`,
      what: 'the helper starts a new chat',
      valid: (v) => isRecord(v) && (v.messages === undefined || Array.isArray(v.messages)),
    });
    this.state = { ...this.state, ...saved.value };
    if (saved.problem) this.post('system', `⚠ ${saved.problem}`);
    // The helper's CLI changed (or an older file without the tag): start a new session for this CLI.
    if ((this.state.sessionAdapter ?? 'claude') !== this.sessionTag && (this.state.sessionId || this.state.messages.length)) {
      this.state.sessionId = undefined;
      this.state.sessionAdapter = this.sessionTag;
      this.state.carryOver = this.state.messages.length > 0;
      if (this.state.carryOver) this.post('system', `The helper now runs on ${CLI_NAMES[this.cfg.adapter] ?? this.cfg.adapter}: a new conversation starts, and it gets this chat's recent messages.`);
      else this.save();
    }
  }

  private save(): void {
    if (!mayWrite(STATE_FILE)) return; // damaged and no copy could be kept: the chat stays in memory only
    mkdirSync(STATE_DIR, { recursive: true });
    this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  /** Create (or repair) the helper's worktree, and report what happened to the last update. */
  private async setup(): Promise<void> {
    mkdirSync(this.attachmentsDir, { recursive: true }); // must exist: it's passed to the CLI as a readable dir
    this.gitOk = existsSync(join(this.appRoot, '.git'));
    if (this.gitOk) {
      mkdirSync(STATE_DIR, { recursive: true });
      trustGitDir(this.wtDir); // its folder may have been made by an administrator run of the app
      await runGit(this.appRoot, 'worktree', 'prune');
      if (!existsSync(this.wtDir)) {
        const exists = await runGit(this.appRoot, 'rev-parse', '--verify', '--quiet', BRANCH).then(() => true, () => false);
        if (exists) await runGit(this.appRoot, 'worktree', 'add', this.wtDir, BRANCH);
        else await runGit(this.appRoot, 'worktree', 'add', '-b', BRANCH, this.wtDir, 'HEAD');
      }
      // Share the app's node_modules so the helper can typecheck; keep the link out of git status.
      const nm = join(this.wtDir, 'node_modules');
      if (!existsSync(nm) && existsSync(join(this.appRoot, 'node_modules'))) {
        symlinkSync(join(this.appRoot, 'node_modules'), nm, 'junction');
      }
      const exclude = join(this.appRoot, '.git', 'info', 'exclude');
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!/^node_modules$/m.test(current)) {
        mkdirSync(join(this.appRoot, '.git', 'info'), { recursive: true });
        writeFileSync(exclude, current + (current.endsWith('\n') || !current ? '' : '\n') + 'node_modules\n');
      }
    }

    if (existsSync(ROLLBACK_NOTE)) {
      rmSync(ROLLBACK_NOTE, { force: true });
      this.state.undo = undefined;
      this.post('system', 'The last update crashed the app on startup, so it was rolled back automatically. The change is still on the helper branch: ask me what went wrong.');
    } else if (existsSync(PENDING_FILE)) {
      // Survived startup; if it's still up after a while, the update is good.
      setTimeout(() => {
        rmSync(PENDING_FILE, { force: true });
        this.post('system', 'Update applied and the app restarted fine.');
      }, HEALTHY_AFTER_MS).unref();
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────

  readonly attachmentsDir = join(STATE_DIR, 'attachments');

  async send(text: string, attachments?: unknown): Promise<void> {
    await this.ready;
    if (this.busy) throw new Error('The helper is still working (on your last message or a project check). Wait, or press Stop.');
    const files = validAttachments(this.attachmentsDir, attachments);
    if (!text.trim() && !files.length) return;
    // Taken before any await, so a project check can't start a second CLI turn alongside this one.
    this.busy = true;
    this.limitUntil = 0;
    try {
      this.handoverUpTo = this.state.messages.length;
      this.post('user', text, files);
      await this.syncToApp();

      const fresh = !this.state.sessionId;
      const logs = logsSince(fresh ? 0 : this.logCursor, fresh ? 60 : 80);
      this.logCursor = logs.cursor;
      const issues = this.ctx.recentIssues();
      // Message numbers are per project: after a project switch, start from that project's recent notices.
      const root = this.ctx.project()?.root;
      const sameProject = root === this.issuesProject;
      this.issuesProject = root;
      if (!sameProject) this.issuesSeen = 0; // even when this project has no notices yet
      const newIssues = (fresh || !sameProject ? issues.slice(-10) : issues.filter((i) => i.at >= this.issuesSeen)).map((i) => i.text);
      const activity = this.ctx.activitySince(fresh ? undefined : this.activityCursors);
      this.activityCursors = activity.cursors;
      if (issues.length) this.issuesSeen = issues[issues.length - 1].at + 1;
      const view = this.state.operate ? this.ctx.view() : undefined;
      const prompt = [
        fresh ? this.preamble() : '',
        await this.modeLine(),
        logs.lines.length ? `Server log${fresh ? ' (recent)' : ' since your last turn'}:\n\`\`\`\n${logs.lines.join('\n')}\n\`\`\`` : '',
        newIssues.length ? `Problems shown to the user in the app:\n${newIssues.map((i) => `- ${i}`).join('\n')}` : '',
        activity.text ? `Agent activity${fresh ? ' (recent)' : ' since your last message'}, oldest first:\n${activity.text}` : '',
        view ? `${OPERATOR_RULES}\n\n${view.text}` : '',
        `User: ${text || '(no text, just the attached files)'}`,
        files.length ? `${describeAttachments(this.attachmentsDir, files)}\n${ATTACHMENT_NOTE}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      // Without git there's no safe sandbox to edit in, so stay read-only.
      await this.turn(prompt, this.state.editMode && this.gitOk ? 'edits' : 'read', files.filter(isImage).map((i) => join(this.attachmentsDir, i)), Boolean(view));
    } finally {
      this.busy = false;
      // Something may have come up in the project meanwhile.
      this.poke();
    }
  }

  private async modeLine(): Promise<string> {
    const project = this.ctx.project();
    const head = this.gitOk ? await runGit(this.appRoot, 'rev-parse', '--short', 'HEAD').then((r) => r.stdout.trim(), () => 'unknown') : 'unknown';
    return `[edit mode: ${this.state.editMode ? 'ON, you may change files' : 'OFF, read and explain only'} | running app version: ${head} | open project: ${project ? `${project.root} (read-only)` : 'none'}${this.state.operate ? ' | operator mode: ON' : ''}]`;
  }

  /**
   * One CLI turn (the caller holds `busy`); posts the reply and, in operator mode, carries out its
   * [[act: ...]] lines before the helper counts as idle. Returns how the turn ended.
   */
  private async turn(prompt: string, autonomy: 'read' | 'edits', images: string[], operate: boolean, retried = false): Promise<'ok' | 'killed' | 'failed'> {
    const original = prompt;
    const resumed = Boolean(this.state.sessionId);
    const project = this.ctx.project();
    // Actions only count for the switch setting and project this turn started with.
    const gen = this.opGen;
    const stillValid = () => this.state.operate && this.opGen === gen && this.ctx.project()?.root === project?.root;
    this.setStatus('working');
    const handover = !this.state.sessionId && this.state.carryOver;
    const upTo = this.handoverUpTo;
    this.handoverUpTo = undefined;
    // Captured now: the switch can change while the CLI thinks.
    const operateWasOn = this.state.operate;
    if (handover) {
      const clip = (t: string) => (t.length > 600 ? `${t.slice(0, 600)}…` : t);
      const earlier = this.state.messages.slice(0, upTo).filter((m) => m.from !== 'system').slice(-12);
      if (earlier.length)
        prompt = `Earlier in this chat (from a conversation you can't see), oldest first:\n${earlier.map((m) => `${m.from}: ${clip(m.text)}`).join('\n')}\n\n${prompt}`;
    }
    const turn = this.adapter.runTurn({
      prompt,
      cwd: this.gitOk ? this.wtDir : this.appRoot,
      extraDirs: [],
      readDirs: [this.attachmentsDir, ...(project ? [project.root] : [])],
      images,
      settings: { model: this.cfg.model ?? '', effort: this.cfg.effort ?? '', autonomy },
      sessionId: this.state.sessionId,
      onEvent: (event) => this.emit('event', event),
    });
    this.current = turn;
    try {
      const res = await turn.done;
      if (res.sessionId) Object.assign(this.state, { sessionId: res.sessionId, sessionAdapter: this.sessionTag });
      if (handover) this.state.carryOver = false;
      this.current = undefined;
      // Act lines never show as raw text; with Run my project off they're dropped, with a note.
      const parsed = parseActions(res.text);
      const actions = operate ? parsed.actions : [];
      // Even a marker inside a code block stays out of the chat.
      const shown = parsed.text.split('\n').filter((l) => !/^\s*\[\[act:/i.test(l)).join('\n').trim();
      if (shown) this.post('helper', shown);
      const hidden = parsed.text.split('\n').filter((l) => /^\s*\[\[act:/i.test(l)).length;
      if (hidden) this.post('system', `Not done: ${hidden === 1 ? 'an action line was' : `${hidden} action lines were`} inside a code block or not in the right form, so ${hidden === 1 ? 'it' : 'they'} didn't run.`);
      if (!operate && parsed.actions.length) {
        const what = parsed.actions.length === 1 ? 'that action' : 'those actions';
        this.post('system', operateWasOn ? `Not done: no project is open for ${what}.` : `Not done: ${what} need${parsed.actions.length === 1 ? 's' : ''} Run my project switched on.`);
      }
      for (let i = 0; i < actions.length; i++) {
        if (!stillValid()) {
          this.post('system', `Skipped ${actions.length - i} action(s): Run my project was switched off, or another project was opened, while I was thinking.`);
          break;
        }
        try {
          this.post('system', `✓ ${await this.ctx.act(actions[i])}`);
        } catch (e) {
          this.post('system', `✗ Couldn't do that (${actions[i].verb}): ${(e as Error).message}`);
        }
      }
      this.setStatus('idle');
      return 'ok';
    } catch (err) {
      const msg = (err as Error).message;
      const kind = msg === 'killed' ? undefined : classifyFailure(msg);
      if (msg === 'killed') this.post('system', 'Stopped.');
      else if (kind === 'limit' || kind === 'credits') {
        const parked = this.limitUntil > Date.now();
        // No reset time to wait for (paid-credits model, or "try again later"): park until you message me.
        const reset = kind === 'limit' ? parseResetTime(msg) : undefined;
        this.limitUntil = reset ? Math.max(reset, Date.now() + 60_000) : Infinity;
        const at = reset ? new Date(this.limitUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        const waiting = this.state.operate ? " What's waiting stays in the banners." : '';
        // Said once per limit: retrying can't help until the reset.
        if (!parked)
          this.post(
            'system',
            kind === 'credits'
              ? `My model needs paid usage credits on your plan, so I can't run. Pick another model for the helper (the "helper" entry in agents.config.json), then send me a message.${waiting}`
              : reset
                ? `I'm out of usage until about ${at} (I run on the same plan as your ${CLI_NAMES[this.cfg.adapter] ?? this.cfg.adapter} CLI, so a busy agent can use it up).${waiting} I'll check the project again after the reset.`
                : `I'm out of usage and the CLI didn't say until when (I run on the same plan as your ${CLI_NAMES[this.cfg.adapter] ?? this.cfg.adapter} CLI).${waiting} Send me a message when it's back and I'll start checking again.`,
          );
      } else if (kind === 'unknown' && resumed && !retried && this.opGen === gen && this.ctx.project()?.root === project?.root) {
        // (Only while the project and operator switch are as this turn started: the prompt describes them.)
        // Most often a lost session (or a CLI that won't resume after a settings change, like Hermes):
        // start a fresh one now, with the instructions and the earlier chat in its prompt.
        this.state.sessionId = undefined;
        this.state.carryOver = true;
        this.handoverUpTo = upTo;
        this.current = undefined;
        this.emit('event', { kind: 'log', text: `Helper session couldn't be resumed (${msg.slice(0, 200)}); starting a fresh one.` });
        return await this.turn(`${this.preamble()}\n\n${original}`, autonomy, images, operate, true);
      } else {
        // The next message starts a fresh session.
        this.state.sessionId = undefined;
        this.post('system', `The helper failed: ${msg.slice(0, 400)}`);
      }
      this.setStatus(msg === 'killed' ? 'idle' : 'error');
      return msg === 'killed' ? 'killed' : 'failed';
    } finally {
      this.current = undefined;
      this.save();
      this.emit('state');
    }
  }

  // ── Operator mode ("Run my project") ──────────────────────────────────

  setOperate(on: boolean): void {
    this.state.operate = on;
    this.opGen++;
    this.handled.clear();
    this.opCapNoted = false;
    if (!on && this.opTimer) {
      clearTimeout(this.opTimer);
      this.opTimer = undefined;
    }
    this.post(
      'system',
      on
        ? 'Run my project is on: when something in the open project waits on you (a request, a question, a stalled agent), I look at it and handle what I can, then report here. Real decisions stay with you.'
        : 'Run my project is off: I only answer your messages.',
    );
    this.save();
    this.emit('state');
    if (on) this.poke();
  }

  /** The project changed: if something new waits on the user, check it after a short delay. */
  poke(): void {
    if (!this.state.operate) return;
    const view = this.ctx.view();
    const now = Date.now();
    const due = Math.min(...(view?.items ?? []).map((i) => this.dueAt(i.key, now)));
    if (!Number.isFinite(due) || this.limitUntil === Infinity) return;
    const pause = this.automaticPause();
    const pauseUntil = typeof pause?.until === 'number' ? pause.until : 0;
    const delay = Math.max(OPERATOR_DELAY_MS, due - now, pauseUntil - now);
    // A check already set for sooner stays; a later one (e.g. a 30-min recheck) gives way to a new item.
    if (this.opTimer) {
      if (this.opTimerAt <= now + delay) return;
      clearTimeout(this.opTimer);
    }
    this.opTimerAt = now + delay;
    this.opTimer = setTimeout(() => {
      this.opTimer = undefined;
      this.operatorCheck().catch((e) => this.post('system', `Couldn't check the project: ${(e as Error).message.slice(0, 300)}`));
    }, delay);
    this.opTimer.unref();
  }

  /** When an item is next worth a look: now if new, once more after OPERATOR_RECHECK_MS, then never. */
  private dueAt(key: string, now: number): number {
    const seen = this.handled.get(key);
    return seen === undefined ? now : seen + OPERATOR_RECHECK_MS;
  }

  private async operatorCheck(): Promise<void> {
    await this.ready;
    // While the helper is busy, its turn pokes again when it ends.
    if (!this.state.operate || this.busy) return;
    const view = this.ctx.view();
    if (!view) return;
    const now = Date.now();
    if (this.limitUntil > now) return this.poke();
    // Keep only keys still present: the rest are gone for good (their ids don't repeat).
    this.handled = new Map(view.items.filter((i) => this.handled.has(i.key)).map((i) => [i.key, this.handled.get(i.key)!]));
    const fresh = view.items.filter((i) => this.dueAt(i.key, now) <= now);
    if (!fresh.length) return this.poke();
    const again = fresh.filter((i) => this.handled.has(i.key));
    this.opRuns = this.opRuns.filter((t) => now - t < 3_600_000);
    if (this.opRuns.length >= OPERATOR_MAX_PER_HOUR) {
      if (!this.opCapNoted) this.post('system', `I've checked the project ${OPERATOR_MAX_PER_HOUR} times this hour, so I'm pausing automatic checks for now to save usage. What's waiting stays in the banners for you.`);
      this.opCapNoted = true;
      this.emit('state');
      this.poke();
      return;
    }
    this.busy = true;
    try {
      this.opCapNoted = false;
      this.opRuns.push(now);
      this.post('system', `Checking the project: ${fresh.map((i) => i.line.slice(0, 160)).join('; ')}`);
      const prompt = [
        this.state.sessionId ? '' : this.preamble(),
        await this.modeLine(),
        OPERATOR_RULES,
        view.text,
        `OPERATOR CHECK (automatic, the user is away). New since your last check, handle only these:\n${fresh.map((i) => `- ${i.line}${this.handled.has(i.key) ? ` (still waiting ${Math.round(OPERATOR_RECHECK_MS / 60_000)}+ min after you left it for the user: act now if the brief and plan now make the answer clear; otherwise leave it)` : ''}`).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      // Operator turns only act through [[act: ...]]; they never edit files.
      const ended = await this.turn(prompt, 'read', [], true);
      // A failed check leaves its items to be looked at again (within the hourly cap); Stop means leave them.
      // Out of usage isn't a check: it doesn't count against the cap, and poke() waits for the reset.
      if (ended === 'failed' && this.limitUntil > Date.now()) this.opRuns.pop();
      this.emit('state');
      if (ended !== 'failed') for (const i of fresh) this.handled.set(i.key, again.includes(i) ? Infinity : Date.now());
    } finally {
      this.busy = false;
      this.poke();
    }
  }

  stop(): void {
    this.current?.kill();
  }

  setEditMode(on: boolean): void {
    this.state.editMode = on;
    this.post('system', on ? 'Edits on: the helper may change the app’s code (on its own branch until you apply).' : 'Edits off: the helper only reads and explains.');
    this.save();
    this.emit('state');
  }

  /** New conversation (keeps any pending changes). */
  reset(): void {
    this.stop();
    this.state.sessionId = undefined;
    this.state.messages = [];
    this.state.carryOver = false;
    this.post('system', 'New conversation.');
    this.save();
    this.emit('state');
  }

  private preamble(): string {
    const p = this.ctx.project();
    return `You are the App helper built into Thinktank Studio, a local web app that coordinates Claude Code, Codex and Grok Build CLIs in one chat.
You help the user understand, fix and extend the APP ITSELF, not their projects.

- You are in a git worktree of the app's source at ${this.wtDir}, on branch ${BRANCH}. The running app is at ${this.appRoot}.
  Your edits do not affect the running app until the user clicks "Apply & restart", which typechecks, merges your branch and restarts.
- README.md explains the architecture: server/ is the Node/TypeScript backend (orchestrator.ts, agents/*, project.ts), web/ is the UI (app.js, style.css).
- Edit mode is shown on each message. When OFF: read and explain, and describe the change you'd make; tell the user to tick "Allow edits" if they want it.
  When ON: make the smallest change that does the job, run \`npx tsc --noEmit -p .\` (and \`node --check web/app.js\` if you touched it), and commit with a clear message.
- Each message includes new server log lines, problems the user saw in the app, and each agent's recent activity
  (tool calls, CLI output, and why a turn failed). Use them to diagnose; quote the relevant line when you explain.
${
  p
    ? `- The open project is at ${p.root}. You may READ it but must never change it: the app blocks file edits there, and you must not run commands that change it either (no git commit/reset/checkout, npm install, or scripts that write files in that folder). Layout:
  repo/ = main branch; ${Object.entries(p.agentDirs).map(([id, d]) => `${id}'s worktree = ${d}`).join('; ')};
  team/ = PLAN.md, tasks.json, chat.jsonl (team chat), session.json (agent settings/sessions), activity/<agent>.jsonl (full agent activity).
  Read these when a problem involves the project or an agent's work.\n`
    : ''
}- The user is new to git and coding: answer plainly and briefly, and say what to click next.`;
  }

  // ── Changes, apply, undo ──────────────────────────────────────────────

  /** Files changed on the helper branch (committed or not) compared with the running app. */
  async changes(): Promise<{ files: string[]; ahead: number }> {
    if (!this.gitOk || !existsSync(this.wtDir)) return { files: [], ahead: 0 };
    const [ahead, committed, status] = await Promise.all([
      runGit(this.appRoot, 'rev-list', '--count', `HEAD..${BRANCH}`),
      runGit(this.appRoot, 'diff', '--name-only', `HEAD...${BRANCH}`),
      runGit(this.wtDir, 'status', '--porcelain'),
    ]);
    const files = new Set(committed.stdout.split('\n').filter(Boolean));
    for (const line of status.stdout.split('\n')) if (line.length > 3) files.add(line.slice(3));
    return { files: [...files].sort(), ahead: Number(ahead.stdout.trim()) };
  }

  async diff() {
    if (!this.gitOk) throw new Error('The app folder is not a git repository, so changes can’t be tracked.');
    return diffWithWorktree(this.appRoot, `HEAD...${BRANCH}`, this.wtDir);
  }

  /** With no pending changes, move the helper branch up to whatever the app is running now. */
  private async syncToApp(): Promise<void> {
    if (!this.gitOk) return;
    const { files } = await this.changes();
    if (files.length) return;
    const head = (await runGit(this.appRoot, 'rev-parse', 'HEAD')).stdout.trim();
    await runGit(this.wtDir, 'reset', '--hard', head).catch((e) => console.error(`helper: couldn't move its copy to the app's latest version: ${errText(e)}`));
  }

  /**
   * Typecheck the helper's branch, merge it into the running app, and restart.
   * `force` stops busy agents first (a restart would kill their turns anyway).
   */
  async apply(force: boolean): Promise<void> {
    await this.ready;
    if (!this.gitOk) throw new Error('The app folder is not a git repository, so updates can’t be applied safely.');
    if (this.status === 'working') throw new Error('Wait for the helper to finish (or Stop it) before applying.');
    if (this.ctx.agentsBusy() && !force) throw Object.assign(new Error('Agents are working. Applying restarts the app and stops them.'), { code: 'busy' });

    if ((await runGit(this.appRoot, 'status', '--porcelain')).stdout.trim()) {
      throw new Error('The app folder has uncommitted changes of its own (edited outside the helper). Commit or discard them first.');
    }
    if ((await runGit(this.wtDir, 'status', '--porcelain')).stdout.trim()) {
      await runGit(this.wtDir, 'add', '-A');
      await runGit(this.wtDir, ...(await gitIdentity(this.wtDir)), 'commit', '-m', 'App helper: uncommitted changes');
    }
    const { ahead } = await this.changes();
    if (!ahead) throw new Error('There are no changes to apply.');

    this.post('system', 'Checking the update (typecheck)…');
    const check = await this.check();
    if (check) {
      this.post('system', `Not applied: the update has errors. Ask the helper to fix them.\n${check}`);
      return;
    }

    const undo = (await runGit(this.appRoot, 'rev-parse', 'HEAD')).stdout.trim();
    try {
      await runGit(this.appRoot, ...(await gitIdentity(this.appRoot)), 'merge', '--no-edit', BRANCH);
    } catch (err) {
      await runGit(this.appRoot, 'merge', '--abort').catch(() => {}); // cleanup after the failure thrown below; fails only if no merge was left in progress
      throw new Error(`Couldn't merge the update: ${(err as Error).message.slice(0, 300)}`);
    }
    const applied = (await runGit(this.appRoot, 'rev-parse', 'HEAD')).stdout.trim();
    const changed = (await runGit(this.appRoot, 'diff', '--name-only', undo, applied)).stdout;
    if (/^package(-lock)?\.json$/m.test(changed)) {
      this.post('system', 'Dependencies changed; running npm install…');
      await import('node:child_process').then(({ execSync }) =>
        // A plain command string: on Windows npm is a .cmd that needs the shell; no args array to join.
        execSync('npm install', { cwd: this.appRoot, stdio: 'ignore' }),
      );
    }

    this.state.undo = { sha: undo, applied };
    this.save();
    writeFileSync(PENDING_FILE, JSON.stringify({ undo, applied }));
    this.restart(force, `Applied ${changed.split('\n').filter(Boolean).length} changed file(s).`);
  }

  /** Go back to the version before the last applied update. */
  async undo(force: boolean): Promise<void> {
    await this.ready;
    const u = this.state.undo;
    if (!u) throw new Error('Nothing to undo.');
    if (this.ctx.agentsBusy() && !force) throw Object.assign(new Error('Agents are working. Undo restarts the app and stops them.'), { code: 'busy' });
    const head = (await runGit(this.appRoot, 'rev-parse', 'HEAD')).stdout.trim();
    if (head !== u.applied) throw new Error('The app has changed since that update, so it can’t be undone automatically.');
    if ((await runGit(this.appRoot, 'status', '--porcelain')).stdout.trim()) throw new Error('The app folder has uncommitted changes; can’t undo safely.');
    await runGit(this.appRoot, 'reset', '--hard', u.sha);
    this.state.undo = undefined;
    this.save();
    rmSync(PENDING_FILE, { force: true });
    this.restart(force, `Went back to version ${u.sha.slice(0, 7)}. The undone change is still on the helper branch.`);
  }

  /** Throw away the helper's pending (unapplied) changes. */
  async discard(): Promise<void> {
    await this.ready;
    if (!this.gitOk) return;
    if (this.status === 'working') throw new Error('Stop the helper first.');
    const head = (await runGit(this.appRoot, 'rev-parse', 'HEAD')).stdout.trim();
    await runGit(this.wtDir, 'reset', '--hard', head);
    await runGit(this.wtDir, 'clean', '-fd');
    this.post('system', 'Pending changes discarded.');
    this.emit('state');
  }

  /** Typecheck + syntax-check the helper's worktree. Returns error output, or '' when clean. */
  private async check(): Promise<string> {
    const { execFile } = await import('node:child_process');
    const run = (cmd: string, args: string[]) =>
      new Promise<string>((resolve) =>
        execFile(cmd, args, { cwd: this.wtDir, timeout: 180_000 }, (err, stdout, stderr) =>
          resolve(err ? `${stdout}${stderr}`.trim().slice(0, 3000) || err.message : ''),
        ),
      );
    return (await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'])) || (await run(process.execPath, ['--check', 'web/app.js']));
  }

  private restart(stopAgents: boolean, summary: string): void {
    if (stopAgents) this.ctx.stopAgents();
    if (this.supervised) {
      this.post('system', `${summary} Restarting the app…`);
      this.emit('restarting');
      // Let the message reach the browser, then ask the supervisor for a restart.
      setTimeout(() => process.exit(75), 500);
    } else {
      this.post('system', `${summary} Restart the app to load it: in its terminal press Ctrl+C, then run npm start. (Started with npm start, this happens automatically.)`);
    }
    this.emit('state');
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private post(from: HelperMessage['from'], text: string, attachments: string[] = []): void {
    const msg: HelperMessage = { id: randomUUID(), ts: Date.now(), from, text, ...(attachments.length ? { attachments } : {}) };
    this.state.messages.push(msg);
    this.emit('message', msg);
    this.save();
    appendFile(join(STATE_DIR, 'helper-log.jsonl'), JSON.stringify(msg) + '\n').catch((e) => logOnce('helper-log.jsonl', e)); // a debugging log; the chat itself is saved by save()
  }

  private setStatus(s: AgentStatus): void {
    this.status = s;
    this.emit('event', { kind: 'status', status: s });
  }
}
