import type { AgentAdapter, AgentConfig, Autonomy, Turn, TurnOptions, TurnUsage } from '../types.js';
import { addUsage, runProcess, safeJson, toUsage, truncate } from './base.js';
import { autonomyArgs } from './catalog.js';
import { codexLimits } from '../limits.js';
import { serverContext } from './models.js';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Short instructions for local models (forward slashes: the path goes inside a TOML string). */
const SERVER_INSTRUCTIONS = fileURLToPath(new URL('./codex-server-instructions.md', import.meta.url)).replace(/\\/g, '/');

/**
 * Codex's own settings folder for model-server agents. Your normal ~/.codex can enable plugins and
 * tool servers (GitHub, browser, documents…) whose tool definitions go to the model on every request;
 * a local model with a small context window would spend most of it on them. This folder has none,
 * and needs no OpenAI login. TTS_CODEX_SERVER_HOME moves it.
 */
export function serverCodexHome(): string {
  const dir = process.env.TTS_CODEX_SERVER_HOME || join(homedir(), '.thinktank', 'codex-server');
  if (!existsSync(join(dir, 'config.toml'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.toml'),
      '# Codex settings for Thinktank Studio agents that use a model server (Setup -> Agents -> Model server).\n' +
        '# Kept empty on purpose: no plugins or tool servers, so the local model gets a small prompt.\n',
    );
  }
  shareSandboxSetup(dir);
  return dir;
}

/** Your own Codex settings folder (where your login, config and sandbox setup live). */
const userCodexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

/**
 * Codex's Windows sandbox runs commands as two Windows accounts that every Codex settings folder shares,
 * but each folder keeps its own copy of their passwords (.sandbox-secrets) and setup record (.sandbox).
 * A full setup in one folder resets the passwords, so the other folder's copy stops working and its next
 * run sets up again, each time with an administrator prompt: your own Codex and the model-server agents
 * would take turns forcing it. Link this folder's copies to your own, so there is only one.
 */
function shareSandboxSetup(dir: string): void {
  if (process.platform !== 'win32') return;
  // The real folder behind a path (junctions followed), compared without case as Windows does.
  const real = (p: string) => {
    try {
      return realpathSync.native(p).toLowerCase();
    } catch {
      return resolve(p).toLowerCase(); // doesn't exist (yet): compare the plain path
    }
  };
  const home = userCodexHome();
  if (real(home) === real(dir)) return;
  for (const name of ['.sandbox', '.sandbox-secrets']) {
    const target = join(home, name);
    const link = join(dir, name);
    try {
      if (!existsSync(target)) continue;
      const st = lstatSync(link, { throwIfNoEntry: false });
      // Already the same folder (our link, or any other alias of it): never delete it.
      if (st && real(link) === real(target)) continue;
      if (st && !st.isSymbolicLink() && !st.isDirectory()) continue;
      if (st) rmSync(link, { recursive: true, force: true });
      symlinkSync(target, link, 'junction');
    } catch {
      // Not fatal: Codex then keeps its own copy here (and may ask for administrator rights again).
    }
  }
}

/** The shell program (quoted path with spaces, or a bare word), then the rest of the line. */
const LAUNCHER_RE = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/;
/** Flags up to and including the one that takes the script, per shell. */
const SCRIPT_FLAG_RE = {
  ps: /^(?:-(?!c\b|command\b)\w+\s+)*-(?:c|command)\s+/i,
  sh: /^(?:-\w+\s+)*?-l?c\s+/,
  cmd: /^(?:\/\w\s+)*?\/c\s+/i,
};

/**
 * Codex runs every command through a shell, e.g. `"C:\…\powershell.exe" -Command "npm test"` or
 * `bash -lc 'npm test'`. Show just the command the agent asked for. Anything that isn't exactly
 * one shell with one script argument is shown unchanged.
 */
export function shellCommand(raw: string): string {
  const m = raw.match(LAUNCHER_RE);
  if (!m) return raw;
  const prog = (m[1] ?? m[2] ?? m[3]).split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  const kind = /^(?:powershell|pwsh)$/.test(prog) ? 'ps' : /^(?:ba|z|da)?sh$/.test(prog) ? 'sh' : prog === 'cmd' ? 'cmd' : undefined;
  const flag = kind && m[4].match(SCRIPT_FLAG_RE[kind]);
  if (!kind || !flag) return raw;
  const arg = m[4].slice(flag[0].length).trim();
  const script = kind === 'cmd' ? (/^".*"$/s.test(arg) ? arg.slice(1, -1) : arg) : unquote(arg, kind);
  return script?.trim() ? script : raw;
}

/** One whole quoted argument, unescaped; undefined if anything follows the closing quote. */
function unquote(arg: string, kind: 'ps' | 'sh'): string | undefined {
  const q = arg[0];
  if (q !== '"' && q !== "'") return kind === 'ps' || !/\s/.test(arg) ? arg : undefined;
  let out = '';
  for (let i = 1; i < arg.length; i++) {
    const c = arg[i];
    if (q === '"' && c === '\\' && arg[i + 1] === '"') out += arg[++i];
    else if (q === "'" && kind === 'ps' && c === "'" && arg[i + 1] === "'") out += arg[++i];
    else if (q === "'" && kind === 'sh' && arg.startsWith("'\\''", i)) (out += "'"), (i += 3);
    else if (c === q) return arg.slice(i + 1).trim() ? undefined : out;
    else out += c;
  }
  return undefined;
}

/** Assumed context window when the server doesn't report one (Ollama, llama.cpp): what the help asks for. */
const DEFAULT_SERVER_WINDOW = 32_768;

/**
 * Codex doesn't know a local model's context window and assumes a huge one, so it would never compact the
 * conversation before the server refuses it. Tell it the real size, and to compact at three quarters.
 */
function windowArgs(tokens: number): string[] {
  return ['-c', `model_context_window=${tokens}`, '-c', `model_auto_compact_token_limit=${Math.floor(tokens * 0.75)}`];
}

/**
 * Codex warnings that come with every model-server turn (its own model list and metadata don't know
 * the server's models). Shown in the log, but never the reason a turn failed.
 */
const WARNING_RE = /codex_models_manager|failed to refresh available models|Model metadata for .* not found|Unknown model .* is used/i;

/**
 * Point Codex at a model server (LM Studio, Ollama, llama.cpp…) instead of OpenAI. Codex speaks only the
 * Responses API (`wire_api = "chat"` is no longer accepted), so the server must offer /v1/responses.
 * Local models can think for many minutes before the first word, so Codex's own stream timeout is raised
 * to an hour; the app's stuck warning (stuckMinutes) still tells you sooner.
 */
export function serverArgs(server: string): string[] {
  const url = server.replace(/\/+$/, '');
  return [
    '-c', 'model_providers.ttsserver.name="Model server"',
    '-c', `model_providers.ttsserver.base_url="${url}"`,
    '-c', 'model_providers.ttsserver.wire_api="responses"',
    '-c', 'model_providers.ttsserver.stream_idle_timeout_ms=3600000',
    '-c', 'model_provider="ttsserver"',
    // Codex's built-in instructions are ~5k tokens on every request; a short set written for local models
    // leaves room in a small context window. Extra options can point model_instructions_file elsewhere.
    '-c', `model_instructions_file="${SERVER_INSTRUCTIONS}"`,
    ...windowsSandboxArgs(),
  ];
}

/**
 * The Windows sandbox mode from your own Codex settings (`[windows] sandbox = "elevated"`), or
 * undefined. Model-server agents use their own settings folder (serverCodexHome), which would
 * otherwise have no sandbox at all, and then Codex refuses every command at Edits and Auto
 * ("blocked by policy").
 */
export function userWindowsSandbox(text?: string): string | undefined {
  if (text === undefined) {
    const file = join(userCodexHome(), 'config.toml');
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return; // no Codex config file: nothing in it to check
    }
  }
  let section = '';
  // The multi-line string ("""…""" or '''…''') still open at the end of the last line, if any:
  // its inside can look like settings and must be skipped.
  let open: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const startsInside = open !== undefined;
    open = scanMultiline(raw, open);
    if (startsInside) continue;
    const line = raw.replace(/^﻿/, '').trim();
    // A table header, maybe quoted (["windows"]) or followed by a comment; [[x]] is never [windows].
    const head = /^\[\s*(?:"([^"]*)"|'([^']*)'|([^\]"'#]+?))\s*\](?!\])\s*(?:#.*)?$/.exec(line);
    if (head) {
      section = (head[1] ?? head[2] ?? head[3]).trim();
      continue;
    }
    if (/^\[\[/.test(line)) {
      section = '[[array]]';
      continue;
    }
    const key = section === 'windows' ? `["']?sandbox["']?` : section === '' ? `["']?windows["']?\\s*\\.\\s*["']?sandbox["']?` : undefined;
    if (!key) continue;
    const m = new RegExp(`^${key}\\s*=\\s*["']([A-Za-z_-]+)["']`).exec(line);
    if (m) return m[1];
    // Inline table at the top: windows = { sandbox = "elevated" }
    const inline = section === '' && /^["']?windows["']?\s*=\s*\{(.*)\}/.exec(line);
    const im = inline && /(?:^|[{,\s])["']?sandbox["']?\s*=\s*["']([A-Za-z_-]+)["']/.exec(inline[1]);
    if (im) return im[1];
  }
}

/**
 * Walks one TOML line and returns the multi-line string delimiter still open at its end. Only the
 * matching delimiter closes a string (\""" inside a basic one doesn't); comments and one-line strings
 * outside it are skipped, so quotes in them don't count.
 */
function scanMultiline(line: string, open: string | undefined): string | undefined {
  let i = 0;
  while (i < line.length) {
    if (open) {
      if (open === '"""' && line[i] === '\\') {
        i += 2;
        continue;
      }
      if (line.startsWith(open, i)) {
        // A closing """ may be followed by up to two more quotes that belong to the string.
        i += 3;
        while (line[i] === open[0]) i++;
        open = undefined;
        continue;
      }
      i++;
      continue;
    }
    const c = line[i];
    if (c === '#') break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      open = line.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      // A one-line string: skip to its end (basic strings have backslash escapes, literal ones don't).
      i++;
      while (i < line.length && line[i] !== c) i += c === '"' && line[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    i++;
  }
  return open;
}

function windowsSandboxArgs(): string[] {
  if (process.platform !== 'win32') return [];
  const mode = userWindowsSandbox();
  return mode ? ['-c', `windows.sandbox="${mode}"`] : [];
}

/** Name of the Codex permissions profile the app defines on the command line for "edits" and "auto". */
const PROFILE = 'tts-agent';

/** True for a folder inside a repository's .git (the shared parts an agent commits into). */
const inGitDir = (d: string) => /[\\/]\.git(?:[\\/]|$)/.test(d);

/**
 * Sandbox flags. At "edits" and "auto" a permissions profile replaces `--sandbox workspace-write`:
 * Codex keeps a worktree's .git read-only inside the sandbox, and in a git worktree that is the real
 * folder `repo/.git/worktrees/<name>` (index, HEAD), so the agent could edit files but never commit.
 * The profile is Codex's own workspace sandbox plus write access to exactly the extra folders the app
 * passes (the team folder and the parts of the shared .git a commit needs; never hooks/ or config).
 * Read-only and Full access keep their plain flags.
 */
export function permissionArgs(autonomy: Autonomy, dirs: string[], allow?: string[]): string[] {
  if (autonomy !== 'edits' && autonomy !== 'auto') return [...autonomyArgs('codex', autonomy, allow), ...dirs.flatMap((d) => ['--add-dir', d])];
  // Forward slashes and JSON quoting make each path a valid TOML key on every OS.
  const rules = dirs.map((d) => `${JSON.stringify(d.replace(/\\/g, '/'))}="write"`).join(', ');
  return [
    ...(autonomy === 'auto' ? ['--approve-for-me'] : []),
    '-c', `default_permissions="${PROFILE}"`,
    '-c', `permissions.${PROFILE}={extends=":workspace"${rules ? `, filesystem={${rules}}` : ''}}`,
  ];
}

/** git's own quoting for GIT_CONFIG_PARAMETERS: single quotes, with ' written as '\''. */
const gitQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Git settings for Codex's commands, through the environment (nothing is written to any config file).
 * On Windows Codex's sandbox runs commands as its own user, and git refuses a repository owned by
 * someone else ("detected dubious ownership"); trust just the folders this agent works in. Git's
 * automatic upkeep (gc, maintenance) after a commit rewrites shared .git files the sandbox blocks, so
 * it is turned off for the agent's commands. Git 2.45 also tries `.git/packed-refs.lock` on every
 * commit and prints "Unable to create … packed-refs.lock" when it can't; the commit still succeeds.
 */
export function gitEnv(cwd: string, dirs: string[], inherited = process.env.GIT_CONFIG_PARAMETERS): string {
  const trusted = [cwd, ...dirs.filter((d) => !inGitDir(d))].map((d) => d.replace(/\\/g, '/'));
  const params = [
    ...trusted.map((d) => `${gitQuote('safe.directory')}=${gitQuote(d)}`),
    `${gitQuote('maintenance.auto')}=${gitQuote('false')}`,
    `${gitQuote('gc.auto')}=${gitQuote('0')}`,
  ];
  return [inherited, ...params].filter(Boolean).join(' ');
}

/**
 * Trust one of the app's own folders for every git command this process and its agents run. A folder
 * made while the app ran as administrator is owned by the Administrators group, and git then refuses it
 * ("detected dubious ownership") when the app later runs as you. Set once, inherited by every child.
 */
export function trustGitDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const entry = `${gitQuote('safe.directory')}=${gitQuote(dir.replace(/\\/g, '/'))}`;
  const current = env.GIT_CONFIG_PARAMETERS ?? '';
  if (!current.includes(entry)) env.GIT_CONFIG_PARAMETERS = [current, entry].filter(Boolean).join(' ');
}

/** A worktree's own git folder, `<repo>/.git/worktrees/<name>`: the one Codex's sandbox locks. */
const WORKTREE_GITDIR_RE = /[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/;

/**
 * The deny entries Codex's sandbox writes, set directly on the folder (not inherited): for a Windows
 * SID that names no account (Codex's per-sandbox SIDs), with exactly Codex's rights (write, delete,
 * read permissions, delete child; the inherit-only twin adds generic write). A deny you add yourself
 * names a user or group, which icacls shows by name, or has other rights, so it never matches.
 */
const CODEX_DENY_RE = /S-1-5-21-[\d-]+:(?:\((?:OI|CI|IO|NP)\))*\(DENY\)\(W,D,Rc,(?:GW,)?DC\)/;

const ACL_SCRIPT =
  "$ErrorActionPreference='Stop'; $d=$env:TTS_ACL_DIR; $a=Get-Acl -LiteralPath $d; " +
  '$R=[System.Security.AccessControl.FileSystemRights]; $m=$R::Write -bor $R::Delete -bor $R::ReadPermissions -bor $R::DeleteSubdirectoriesAndFiles; ' +
  "$a.Access | Where-Object { $_.AccessControlType -eq 'Deny' -and -not $_.IsInherited -and " +
  "$_.IdentityReference.Value -match '^S-1-5-21-[0-9-]+$' -and (($_.FileSystemRights -band $m) -eq $m) } | " +
  'ForEach-Object { [void]$a.RemoveAccessRuleSpecific($_) }; Set-Acl -LiteralPath $d -AclObject $a';

const hasCodexDeny = (dir: string) => {
  const r = spawnSync('icacls', [dir], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  return CODEX_DENY_RE.test(r.stdout ?? '');
};

/** Folders whose cleanup failed once: not retried (PowerShell can take seconds) until the app restarts. */
const aclFailed = new Set<string>();

/**
 * Codex's Windows sandbox protects a .git folder inside its workspace by adding "deny write" entries
 * to its permissions, and never takes them off again. After one turn at the old `--sandbox
 * workspace-write` (or at Read-only) they stay on the worktree's git folder `repo/.git/worktrees/<name>`
 * and block commits even when the profile above allows them. Remove those leftover entries, and only
 * those: just Codex's own entries (see CODEX_DENY_RE), just on worktree git folders. (A Codex turn in
 * the main checkout leaves the same kind of entries on `repo/.git`; worktree folders inherit them, but
 * they name that other sandbox's SID and don't block an agent's commits, tested, so they are left
 * alone.) Each turn costs a quick `icacls` look; PowerShell starts only when there is something to
 * remove (normally once per worktree). Both are bounded by timeouts, and this runs on the server
 * thread because the orchestrator reads the turn's pid as soon as it starts. Returns a note for the
 * agent's log when an entry couldn't be removed.
 */
export function clearSandboxDenies(dirs: string[]): string | undefined {
  if (process.platform !== 'win32') return;
  const failed: string[] = [];
  for (const d of dirs) {
    if (!WORKTREE_GITDIR_RE.test(d) || !existsSync(d) || !hasCodexDeny(d)) continue;
    if (!aclFailed.has(d)) {
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
        env: { ...process.env, TTS_ACL_DIR: d },
        windowsHide: true,
        timeout: 20_000,
      });
      if (!hasCodexDeny(d)) continue;
      aclFailed.add(d);
    }
    failed.push(d);
  }
  if (failed.length)
    return (
      `Couldn't remove the leftover Codex sandbox lock on ${failed.join(', ')}, so this agent's commits may fail ` +
      '("Permission denied" on index.lock). Check that folder\'s Security settings, or use Full access for this agent.'
    );
}

/**
 * Codex headless: `codex exec --json [opts] [resume <thread_id>] -`, prompt on stdin.
 * Options go before `resume`; the exec parser accepts them there for both forms.
 */
export class CodexAdapter implements AgentAdapter {
  readonly supportsResume = true;
  constructor(private cfg: AgentConfig) {}

  runTurn(o: TurnOptions): Turn {
    let sessionId = o.sessionId;
    let errText = '';
    let stderrTail = '';
    let usage: TurnUsage | undefined;
    let failed = false;
    const texts: string[] = [];
    const { model, effort, autonomy } = o.settings;
    const server = this.cfg.server;

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      ...permissionArgs(autonomy, o.extraDirs, this.cfg.allowCommands),
      ...(server ? [...serverArgs(server), ...windowArgs(serverContext(server, model) ?? DEFAULT_SERVER_WINDOW)] : []),
      ...(model ? ['-m', model] : []),
      // A model server's models take no OpenAI effort levels (reasoning is set in the server's app).
      ...(effort && !server ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      ...(this.cfg.args ?? []),
      ...(o.sessionId ? ['resume', o.sessionId] : []),
      // After `resume` so it attaches to this turn either way; `=` form so it can't swallow the '-' below.
      ...(o.images?.length ? [`--image=${o.images.join(',')}`] : []),
      '-',
    ];

    const aclNote = autonomy === 'edits' || autonomy === 'auto' ? clearSandboxDenies(o.extraDirs) : undefined;
    if (aclNote) o.onEvent({ kind: 'log', text: `error: ${aclNote}` });
    const proc = runProcess({
      command: this.cfg.command,
      args,
      cwd: o.cwd,
      stdin: o.prompt,
      env: { GIT_CONFIG_PARAMETERS: gitEnv(o.cwd, o.extraDirs), ...(server ? { CODEX_HOME: serverCodexHome() } : {}) },
      onStdoutLine: (line) => {
        const ev = safeJson(line);
        if (!ev) return o.onEvent({ kind: 'log', text: line });
        if (ev.type === 'thread.started' && ev.thread_id) {
          sessionId = ev.thread_id;
          o.onEvent({ kind: 'session', id: ev.thread_id });
        }
        else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
          // Report a command when it starts, so a long-running one (a dev server, a watcher) is visible
          // while it runs; its completion is logged below.
          o.onEvent({ kind: 'tool', name: 'shell', detail: truncate(shellCommand(ev.item.command ?? '')) });
        } else if (ev.type === 'item.completed' && ev.item) {
          const it = ev.item;
          switch (it.type) {
            case 'agent_message':
              texts.push(it.text);
              o.onEvent({ kind: 'text', text: it.text });
              break;
            case 'reasoning':
              o.onEvent({ kind: 'log', text: `thinking: ${truncate(it.text ?? '')}` });
              break;
            case 'command_execution':
              // Already shown as a tool call when it started; a second tool event would look like a repeat.
              o.onEvent({
                kind: 'tool_end',
                name: 'shell',
                ok: it.status !== 'failed' && it.status !== 'declined' && !it.exit_code,
                text: `shell ${it.status === 'declined' ? 'declined' : it.status === 'failed' ? 'failed' : 'finished'}${it.exit_code == null ? '' : ` (exit ${it.exit_code})`}: ${truncate(shellCommand(it.command ?? ''), 120)}`,
              });
              break;
            case 'file_change':
              o.onEvent({ kind: 'tool', name: 'edit', detail: (it.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join(', ') });
              break;
            case 'mcp_tool_call':
              o.onEvent({ kind: 'tool', name: `mcp:${it.tool ?? '?'}`, detail: it.server ?? '' });
              break;
            case 'web_search':
              o.onEvent({ kind: 'tool', name: 'web_search', detail: it.query ?? '' });
              break;
            case 'error':
              // Switching model mid-conversation is allowed, and a model server's models have no OpenAI
              // metadata; Codex only warns about either.
              o.onEvent({ kind: 'log', text: `${/recorded with model|Model metadata for/.test(it.message ?? '') ? 'note' : 'error'}: ${it.message ?? ''}` });
              break;
          }
        } else if (ev.type === 'turn.completed') {
          usage = addUsage(usage, toUsage(ev.usage));
        } else if (ev.type === 'turn.failed') {
          failed = true;
          errText += ev.error?.message ?? 'turn failed';
        } else if (ev.type === 'error') {
          errText += ev.message ?? 'codex error';
        }
      },
      onStderr: (raw) => {
        // Codex colors its log lines; the panel shows plain text.
        const s = raw.replace(/\x1b\[[0-9;]*m/g, '');
        o.onEvent({ kind: 'log', text: s });
        // Whole lines only, so a warning can't hide a real error that arrives in the same chunk.
        const lines = (stderrTail + s).split('\n');
        stderrTail = lines.pop() ?? '';
        for (const line of lines) if (!WARNING_RE.test(line)) errText += line + '\n';
      },
    });

    return {
      kill: proc.kill,
      pid: proc.pid,
      done: proc.done.then((code) => {
        // The last agent_message is the final answer; earlier ones are progress notes.
        // Plan usage isn't in the JSON stream; Codex writes it to the session file. Read it in the
        // background so it never holds up the turn.
        if (sessionId) void codexLimits(sessionId).then((l) => l && o.onEvent({ kind: 'limits', windows: l.windows }));
        if (proc.killed()) throw new Error('killed');
        if (stderrTail && !WARNING_RE.test(stderrTail)) errText += stderrTail;
        const text = texts.at(-1) ?? '';
        if (failed || (code !== 0 && !text)) throw new Error(errText.trim() || `codex exited with ${code}`);
        return { text, sessionId, usage };
      }),
    };
  }
}
