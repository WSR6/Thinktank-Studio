import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { AgentAdapter, AgentConfig, AgentSettings, Turn, TurnOptions, TurnResult, TurnUsage } from '../types.js';
import { AcpConnection } from './acp.js';
import { summarize, truncate } from './base.js';
import { HermesChatAdapter } from './hermes.js';
import { modelCatalog } from './models.js';

/**
 * Hermes Agent over ACP (`hermes [-p profile] acp`): one Hermes kept running per agent, a turn is a
 * `session/prompt` on its session. Compared with one `hermes chat` per turn this gives a real Stop
 * (session/cancel), model and effort changes inside the same conversation, edit approvals answered
 * by the app, and no start-up wait after the first turn.
 *
 * Read-only turns, and agents configured with `"transport": "chat"`, use `hermes chat` instead:
 * only there can the toolsets be cut down to reading. If ACP can't start at all (an older Hermes),
 * this agent falls back to `hermes chat` for the rest of the run.
 */

/** Close Hermes after this long without a turn; the next turn starts it again and resumes the session. */
const IDLE_CLOSE_MS = 30 * 60_000;
/** After Stop, how long Hermes gets to end the turn before it is closed. */
const CANCEL_GRACE_MS = 15_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** What we last set on a session, so a turn only sends changes. `undefined` = not known (a resumed session). */
interface SessionState {
  model?: string;
  effort?: string;
  policy?: string;
}

interface ActiveTurn {
  sessionId: string;
  /** Ignore this turn's updates (a /reasoning command sent while preparing it). */
  muted: boolean;
  onUpdate(u: any): void;
  onPermission(p: any): unknown;
}

/**
 * Edit approval policy for an autonomy level ("read" never reaches ACP). At "edits" Hermes asks the app
 * about every edit ("ask"): its own "accept edits" mode also allows the whole temp folder.
 */
export function editPolicy(autonomy: AgentSettings['autonomy']): string {
  return autonomy === 'edits' ? 'ask' : 'session';
}

/** Split a path into its root ("C:\", "/", "") and its parts, without collapsing ".." (a link may come first). */
function pathParts(p: string): { root: string; parts: string[] } {
  // A junction's target may carry the \\?\ prefix; \\?\UNC\server\share is \\server\share.
  // Windows only: elsewhere those characters are part of a name.
  const clean = process.platform === 'win32' ? p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '') : p;
  const root = parse(clean).root;
  // A backslash separates folders only on Windows; elsewhere it is part of a name.
  const seps = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
  return { root, parts: clean.slice(root.length).split(seps).filter((x) => x && x !== '.') };
}

/**
 * Where `p` really is, the way the file system resolves it: one part at a time from the root, following
 * each link (symlink or Windows junction) as it is reached, even one whose target doesn't exist yet, and
 * applying ".." only to what is resolved so far. Parts that don't exist are taken as they are (a file
 * about to be created). Throws on a link loop.
 */
export function realPath(p: string): string {
  // "D:file" means D:'s current folder, which only Windows knows: never treat it as ours.
  if (process.platform === 'win32' && /^[a-z]:(?![\\/])/i.test(p)) throw new Error(`drive-relative path: ${p}`);
  const start = pathParts(isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`);
  let cur = start.root;
  const queue = [...start.parts];
  let links = 0;
  while (queue.length) {
    const part = queue.shift()!;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    // A ":" inside a name is a drive ("x\D:file") or an NTFS stream ("file:stream"): not a plain place.
    if (process.platform === 'win32' && part.includes(':')) throw new Error(`not a plain path: ${p}`);
    const next = join(cur, part);
    // Every part is looked at, even below one that doesn't exist: a ".." can climb back to real folders.
    let st;
    try {
      st = lstatSync(next);
    } catch {
      st = undefined; // not there (yet): taken as it is
    }
    if (st?.isSymbolicLink()) {
      if (++links > 40) throw new Error(`too many links: ${p}`);
      const target = pathParts(readlinkSync(next));
      // An absolute target starts again from its root; a relative one from the link's own folder (cur).
      if (target.root) cur = target.root;
      queue.unshift(...target.parts);
      continue;
    }
    // The name's real spelling (a short 8.3 alias becomes the long name). `cur` is already resolved,
    // so this resolves only this one part.
    cur = st ? realpathSync.native(next) : next;
  }
  return cur;
}

/** True when `p` is `dir` or inside it, following links (case-insensitive on Windows). Unsure = outside. */
export function within(p: string, dir: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? realPath(s).toLowerCase() : realPath(s));
  let rel: string;
  try {
    rel = relative(norm(dir), norm(p));
  } catch {
    return false; // a link loop, a drive-relative path or a stream name: can't tell where it ends up
  }
  // Only a ".." part means above `dir`; a name like "..notes.txt" is inside.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The app's answer to one of Hermes's permission requests. Edits are allowed inside the agent's own
 * folder and its extra writable folders (team files, the repo's .git); at "full" everything is
 * allowed. Commands Hermes flags as dangerous are allowed only at "full". Never a lasting grant.
 */
export function permissionAnswer(p: any, autonomy: AgentSettings['autonomy'], dirs: string[]): { optionId?: string; allowed: boolean; why: string } {
  const options: any[] = Array.isArray(p?.options) ? p.options : [];
  const once = (kind: string) => options.find((o) => o?.kind === kind)?.optionId as string | undefined;
  const tc = p?.toolCall ?? {};
  const kind = String(tc.kind ?? '');
  const paths: string[] = [];
  for (const l of Array.isArray(tc.locations) ? tc.locations : []) if (typeof l?.path === 'string') paths.push(l.path);
  for (const c of Array.isArray(tc.content) ? tc.content : []) if (typeof c?.path === 'string') paths.push(c.path);
  const what = truncate(String(tc.title ?? kind ?? 'request'), 120);
  let allowed = false;
  let why: string;
  if (autonomy === 'full') {
    allowed = true;
    why = `allowed (full access): ${what}`;
  } else if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    // A relative path is joined as text, not normalized: realPath applies its ".." after following links.
    const outside = paths.filter((x) => !dirs.some((d) => within(isAbsolute(x) ? x : `${dirs[0] ?? '.'}${sep}${x}`, d)));
    allowed = paths.length > 0 && outside.length === 0;
    why = allowed ? `allowed edit in its folders: ${what}` : `refused edit outside its folders: ${truncate(outside.join(', ') || what, 160)}`;
  } else {
    why = `refused (needs Full access): ${what}`;
  }
  const optionId = allowed ? once('allow_once') : once('reject_once');
  return { optionId, allowed, why };
}

const REASONING_BLOCK = /💭 \*\*Reasoning:\*\*\s*```[\s\S]*?```\s*/;

/**
 * Hermes's gateway sends the settled reply after the streamed one when they differ, and with
 * show_reasoning on the settled one starts with a "💭 **Reasoning:**" code block, so the reply
 * arrives as `<streamed>\n\n💭 **Reasoning:** ``` … ```\n\n<settled>`. Keep the settled reply.
 */
export function cleanReply(text: string): string {
  const m = REASONING_BLOCK.exec(text);
  if (m) {
    const settled = text.slice(m.index + m[0].length);
    return settled.trim() ? cleanReply(settled) : text.slice(0, m.index);
  }
  return text;
}

/**
 * The reply text at the end of a turn. When the settled reply differs from the streamed one (e.g. it
 * adds Hermes's file-mutation verifier note), the gateway sends it as the turn's last chunk,
 * `"\n\n" + settled`. If that last chunk repeats everything streamed before it, it is the reply;
 * otherwise the text is kept as it came. Nothing in the stream marks that chunk, so the match is kept
 * to what only the resend produces: one final chunk repeating at least 40 characters of earlier text
 * exactly, then a line break or nothing. A model streams in small pieces, so its own last piece won't.
 */
export function settleReply(before: string, last: string): string {
  const prior = before.trim();
  const settled = last.startsWith('\n\n') ? last.slice(2).trimStart() : undefined;
  if (settled !== undefined && prior.length >= 40 && settled.startsWith(prior)) {
    const after = settled.slice(prior.length);
    if (after === '' || after.startsWith('\n')) return settled;
  }
  return before + last;
}

function imageBlocks(images: string[] | undefined): any[] {
  const out: any[] = [];
  for (const file of images ?? []) {
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    try {
      if (!mimeType || statSync(file).size > MAX_IMAGE_BYTES) continue;
      out.push({ type: 'image', mimeType, data: readFileSync(file).toString('base64') });
    } catch {
      /* gone or unreadable: the prompt still names it */
    }
  }
  return out;
}

export class HermesAdapter implements AgentAdapter {
  readonly supportsResume = true;
  private chat: HermesChatAdapter;
  private conn?: AcpConnection;
  private connProfile = '';
  private ready?: Promise<void>;
  /** Why ACP can't be used on this machine; turns then go through `hermes chat`. */
  private acpBroken?: string;
  private sessions = new Map<string, SessionState>();
  private active?: ActiveTurn;
  /** One turn at a time on this agent's Hermes. */
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;

  constructor(private cfg: AgentConfig) {
    this.chat = new HermesChatAdapter(cfg);
  }

  runTurn(o: TurnOptions): Turn {
    if (this.cfg.transport === 'chat' || this.acpBroken || o.settings.autonomy === 'read' || o.readDirs?.length) return this.chat.runTurn(o);
    return this.runAcp(o);
  }

  /** End this agent's Hermes (the agent was removed or replaced). */
  dispose(): void {
    clearTimeout(this.idleTimer);
    this.conn?.close();
    this.conn = undefined;
    this.sessions.clear();
  }

  private connect(profile: string, cwd: string): AcpConnection {
    if (this.conn && !this.conn.closed && this.connProfile === profile) return this.conn;
    this.conn?.close();
    this.sessions.clear();
    const conn = new AcpConnection(this.cfg.command, [...(profile ? ['-p', profile] : []), 'acp'], cwd, {
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const a = this.active;
        if (a && !a.muted && params?.sessionId === a.sessionId) a.onUpdate(params.update ?? {});
      },
      onRequest: (method, params) => {
        const a = this.active;
        if (method === 'session/request_permission') {
          if (!a || params?.sessionId !== a.sessionId) return { outcome: { outcome: 'cancelled' } };
          return a.onPermission(params);
        }
        // We offer no file system or terminal to Hermes (it uses its own tools), and no one is there to answer questions.
        throw new Error(`${method} is not supported by this app`);
      },
    });
    this.conn = conn;
    this.connProfile = profile;
    this.ready = conn
      .request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'thinktank-studio', version: '0.1.0' },
      })
      .then(() => undefined);
    void conn.exited.then(() => {
      if (this.conn === conn) {
        this.conn = undefined;
        this.sessions.clear();
      }
    });
    return conn;
  }

  private runAcp(o: TurnOptions): Turn {
    clearTimeout(this.idleTimer);
    const profile = o.settings.profile ?? '';
    // Taken when this turn's place in the queue comes up: a turn still waiting must not touch the
    // running turn's Hermes (stopping it, or starting one for another profile).
    let conn: AcpConnection | undefined;
    let killed = false;
    let cancelTimer: NodeJS.Timeout | undefined;
    let sessionId: string | undefined;
    let fallback: Turn | undefined;
    let stopQueued: (e: Error) => void = () => {};
    const stoppedWhileQueued = new Promise<never>((_, reject) => (stopQueued = reject));
    stoppedWhileQueued.catch(() => {}); // only read through the race below

    const kill = () => {
      if (killed) return;
      killed = true;
      fallback?.kill();
      if (!conn) return stopQueued(new Error('killed')); // still queued: ends now, and is skipped when its turn comes
      if (sessionId && this.active?.sessionId === sessionId) {
        conn.notify('session/cancel', { sessionId });
        const c = conn;
        cancelTimer = setTimeout(() => c.close(), CANCEL_GRACE_MS);
      } else {
        // Starting up or opening the session (this turn's own, as turns run one at a time): end Hermes.
        conn.close();
      }
    };

    const run = async (): Promise<TurnResult> => {
      if (killed) throw new Error('killed');
      clearTimeout(this.idleTimer);
      const c = (conn = this.connect(profile, o.cwd));
      try {
        await this.ready;
      } catch (e) {
        if (killed) throw new Error('killed');
        // Hermes without ACP (older version or missing extras): use `hermes chat` from now on.
        this.acpBroken = (e as Error).message;
        conn.close();
        o.onEvent({ kind: 'log', text: `Hermes ACP unavailable, using hermes chat: ${truncate(this.acpBroken, 200)}` });
        fallback = this.chat.runTurn(o);
        return fallback.done;
      }
      if (killed) throw new Error('killed');

      sessionId = o.sessionId;
      if (sessionId && !this.sessions.has(sessionId)) {
        try {
          await c.request('session/resume', { sessionId, cwd: o.cwd, mcpServers: [] });
          this.sessions.set(sessionId, {});
        } catch (e) {
          if (killed) throw new Error('killed');
          // The orchestrator answers a failed resume with a fresh session that resends the recent chat.
          throw new Error(`Hermes couldn't resume session ${sessionId}: ${(e as Error).message}`);
        }
      }
      if (!sessionId) {
        const r = await c.request('session/new', { cwd: o.cwd, mcpServers: [] });
        sessionId = String(r?.sessionId ?? '');
        if (!sessionId) throw new Error('Hermes did not return a session id');
        this.sessions.set(sessionId, { model: '', effort: '', policy: '' });
        o.onEvent({ kind: 'session', id: sessionId });
      }
      if (killed) throw new Error('killed');

      // Turn state.
      // The text since the last tool call, kept as everything before the newest chunk plus that chunk.
      let before = '';
      let last = '';
      let lastSegment = '';
      const tools = new Map<string, string>();
      /** `end`: the turn is over, so the newest chunk may be the gateway's settled reply. */
      const flush = (end = false) => {
        const text = cleanReply(end ? settleReply(before, last) : before + last);
        if (text.trim()) {
          o.onEvent({ kind: 'text', text });
          lastSegment = text;
        }
        before = last = '';
      };
      const dirs = [o.cwd, ...o.extraDirs];
      const turn: ActiveTurn = {
        sessionId,
        muted: false,
        onUpdate: (u) => {
          switch (u.sessionUpdate) {
            case 'agent_message_chunk':
              if (u.content?.type === 'text' && typeof u.content.text === 'string') {
                before += last;
                last = u.content.text;
              }
              break;
            case 'tool_call': {
              flush();
              const id = String(u.toolCallId ?? '');
              const name = String(u.title ?? u.kind ?? 'tool');
              if (id) tools.set(id, name);
              const loc = Array.isArray(u.locations) && typeof u.locations[0]?.path === 'string' ? u.locations[0].path : '';
              o.onEvent({ kind: 'tool', name: truncate(name, 80), detail: loc || summarize(u.rawInput ?? '') });
              if (u.status === 'completed' || u.status === 'failed') {
                tools.delete(id);
                o.onEvent({ kind: 'tool_end', name, ok: u.status === 'completed', text: `${name} ${u.status === 'completed' ? 'finished' : 'failed'}` });
              }
              break;
            }
            case 'tool_call_update': {
              const id = String(u.toolCallId ?? '');
              const name = tools.get(id);
              if (name && (u.status === 'completed' || u.status === 'failed')) {
                tools.delete(id);
                o.onEvent({ kind: 'tool_end', name, ok: u.status === 'completed', text: `${name} ${u.status === 'completed' ? 'finished' : 'failed'}` });
              }
              break;
            }
          }
        },
        onPermission: (p) => {
          const a = permissionAnswer(p, o.settings.autonomy, dirs);
          o.onEvent({ kind: 'log', text: `${a.allowed ? '✓' : '✖'} ${a.why}` });
          return a.optionId ? { outcome: { outcome: 'selected', optionId: a.optionId } } : { outcome: { outcome: 'cancelled' } };
        },
      };
      this.active = turn;
      try {
        await this.applySettings(c, turn, o.settings, profile);
        if (killed) throw new Error('killed');
        const res = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: o.prompt }, ...imageBlocks(o.images)] });
        flush(true);
        if (killed || res?.stopReason === 'cancelled') throw new Error(killed ? 'killed' : 'Hermes cancelled the turn');
        if (res?.stopReason === 'refusal') throw new Error('Hermes refused to continue this turn');
        const u = res?.usage;
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        const usage: TurnUsage | undefined = u ? { input: n(u.inputTokens), output: n(u.outputTokens), cached: n(u.cachedReadTokens) } : undefined;
        return { text: lastSegment.trim(), sessionId, usage };
      } catch (e) {
        if (killed) throw new Error('killed');
        throw e;
      } finally {
        if (this.active === turn) this.active = undefined;
      }
    };

    const queued = (this.queue = this.queue.then(run, run)).finally(() => {
      clearTimeout(cancelTimer);
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.dispose(), IDLE_CLOSE_MS);
      this.idleTimer.unref?.();
    }) as Promise<TurnResult>;
    queued.catch(() => {}); // the caller reads it through `done`
    const done = Promise.race([queued, stoppedWhileQueued]);
    const thisConn = () => conn ?? this.conn;
    return {
      done,
      kill,
      get pid() {
        return thisConn()?.pid;
      },
    };
  }

  /** Send only what changed: edit policy, model, effort. */
  private async applySettings(conn: AcpConnection, turn: ActiveTurn, s: AgentSettings, profile: string): Promise<void> {
    const st = this.sessions.get(turn.sessionId) ?? {};
    this.sessions.set(turn.sessionId, st);
    const policy = editPolicy(s.autonomy);
    if (st.policy !== policy) {
      await conn.request('session/set_config_option', { sessionId: turn.sessionId, configId: 'edit_approval_policy', value: policy });
      st.policy = policy;
    }
    // An empty pick means the profile's own default; a known session already has it unless we changed it.
    const model = s.model || (st.model === '' ? '' : (modelCatalog('hermes', undefined, profile)?.cliDefaultModel ?? ''));
    if (model && st.model !== model) {
      await conn.request('session/set_model', { sessionId: turn.sessionId, modelId: model });
      st.model = model;
    } else if (!model) st.model = '';
    // Likewise for effort: the profile's default (Hermes's own is medium) unless the session is known to
    // still have it; a resumed session may carry an effort set before the restart.
    const effort = s.effort || (st.effort === '' ? '' : (modelCatalog('hermes', undefined, profile)?.cliDefaultEffort || 'medium'));
    if (effort && st.effort !== effort) {
      // Hermes's gateway takes it as a config option; its in-process server only as the /reasoning command.
      const r = await conn.request('session/set_config_option', { sessionId: turn.sessionId, configId: 'reasoning_effort', value: effort }).catch(() => undefined);
      const shown = Array.isArray(r?.configOptions) ? r.configOptions.find((x: any) => x?.id === 'reasoning_effort')?.currentValue : undefined;
      if (shown !== effort) {
        turn.muted = true;
        try {
          await conn.request('session/prompt', { sessionId: turn.sessionId, prompt: [{ type: 'text', text: `/reasoning ${effort}` }] });
        } finally {
          turn.muted = false;
        }
      }
      st.effort = effort;
    }
  }
}
