import { execFile, spawn } from 'node:child_process';
import type { TurnUsage } from '../types.js';

/** Programs a saved agent pid may belong to; anything else means the pid was reused, so it's left alone. */
const AGENT_PROGRAMS = /^(?:cmd|claude|codex|grok|hermes|node)(?:\.exe)?$/i;

/** End a CLI left running by a crash (and its children), if that pid is still one of ours. Never throws. */
export async function endLeftoverProcess(pid: number | undefined): Promise<void> {
  if (!pid || !Number.isInteger(pid)) return;
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((res) => execFile(cmd, args, { windowsHide: true }, (_e, out) => res(String(out ?? ''))));
  if (process.platform === 'win32') {
    const name = (await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).match(/^"([^"]+)"/)?.[1] ?? '';
    if (AGENT_PROGRAMS.test(name)) await run('taskkill', ['/pid', String(pid), '/T', '/F']);
  } else {
    const name = (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim().split('/').pop() ?? '';
    if (AGENT_PROGRAMS.test(name)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

export interface ProcHandle {
  done: Promise<number | null>;
  kill(): void;
  /** End a CLI that reported it's done but didn't exit; unlike kill(), the turn still counts. */
  finish(): void;
  /** True once kill() was called; adapters must then reject even if some text streamed. */
  killed(): boolean;
  /** The spawned process (on Windows, the cmd.exe that runs the CLI). */
  pid?: number;
}

/**
 * Child env without Claude Code's session markers: if this server is started from inside a
 * Claude Code session, a nested `claude -p` would otherwise refuse to run.
 */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDECODE') && k !== 'CLAUDE_CODE_ENTRYPOINT'));
}

interface ProcOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  /** Extra environment variables for this run (override the app's own). */
  env?: Record<string, string>;
  onStdoutLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Quote one argument for cmd.exe when it contains spaces or shell characters. */
export function winQuote(a: string): string {
  return a === '' || /[\s"&|<>^()%!]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a;
}

/** Spawn a CLI, feed the prompt on stdin, and stream stdout line by line. */
export function runProcess(o: ProcOptions): ProcHandle {
  const opts = { cwd: o.cwd, env: { ...childEnv(), ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  // .cmd shims on Windows need a shell. Build the quoted command line ourselves (passing an args
  // array with shell:true makes Node join them unquoted, and warns about it).
  const child =
    process.platform === 'win32'
      ? spawn([o.command, ...o.args].map(winQuote).join(' '), { ...opts, shell: true })
      : spawn(o.command, o.args, opts);

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) o.onStdoutLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => o.onStderr?.(chunk));
  child.stdin.on('error', () => {}); // CLI may exit before reading stdin
  child.stdin.end(o.stdin ?? '');

  const done = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      o.onStderr?.(String(err));
      resolve(-1);
    });
    child.on('close', (code) => {
      if (buf.trim()) o.onStdoutLine(buf);
      resolve(code);
    });
  });

  let killed = false;
  const terminate = () => {
    if (child.exitCode !== null) return;
    // On Windows the child is cmd.exe; killing it alone leaves the CLI running and holding our
    // pipes, so the turn never ends. Kill the whole tree instead.
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); // fails only if the tree already exited
    else child.kill('SIGTERM');
  };
  return {
    done,
    kill: () => {
      killed = true;
      terminate();
    },
    finish: terminate,
    killed: () => killed,
    pid: child.pid,
  };
}

/** Normalize snake_case usage objects from Claude / Codex / Grok events. */
export function toUsage(u: any, cost?: unknown): TurnUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cached: n(u.cache_read_input_tokens ?? u.cached_input_tokens),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined,
  };
}

/** Sum usages across several usage events in one turn. */
export function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const cost = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, costUsd: cost };
}

export function safeJson(line: string): any | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // CLIs mix plain text into their JSON output: those lines just aren't events
  }
}

/** One-line description of a tool call's input for the activity panel. */
export function summarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
      if (typeof o[k] === 'string') return truncate(o[k] as string);
    }
  }
  return truncate(typeof input === 'string' ? input : JSON.stringify(input ?? ''));
}

export function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
