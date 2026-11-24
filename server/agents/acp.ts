import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { winQuote } from './base.js';

/**
 * A client for the Agent Client Protocol (ACP): JSON-RPC 2.0, one message per line, over a CLI's
 * stdin/stdout. The CLI stays running between turns; we send requests (initialize, session/new,
 * session/prompt…) and answer the agent's own requests (session/request_permission).
 */

export interface AcpError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRequestError extends Error {
  constructor(readonly method: string, readonly error: AcpError) {
    super(`${method}: ${error.message}${error.data ? ` (${JSON.stringify(error.data).slice(0, 300)})` : ''}`);
  }
}

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export interface AcpHandlers {
  /** A notification from the agent (session/update…). */
  onNotification(method: string, params: any): void;
  /** A request from the agent; the returned value is the result. Throw to answer with an error. */
  onRequest(method: string, params: any): Promise<unknown> | unknown;
}

/** Child env without Claude Code's session markers (same rule as runProcess). */
function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDECODE') && k !== 'CLAUDE_CODE_ENTRYPOINT'));
  return { ...base, ...extra };
}

const live = new Set<AcpConnection>();
let exitHooked = false;
/** A long-lived CLI would otherwise outlive the app on Windows (children aren't ended with the parent). */
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const c of live) c.close();
  });
}

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buf = '';
  private stderrTail = '';
  private closedFlag = false;
  /** Resolves with the exit code once the CLI has exited. */
  readonly exited: Promise<number | null>;

  constructor(command: string, args: string[], cwd: string, private handlers: AcpHandlers, env?: Record<string, string>) {
    const opts = { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
    this.child =
      process.platform === 'win32'
        ? spawn([command, ...args].map(winQuote).join(' '), { ...opts, shell: true })
        : spawn(command, args, opts);
    live.add(this);
    hookExit();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.child.stdin.on('error', () => {}); // the CLI may exit while we write
    this.exited = new Promise((resolve) => {
      const end = (code: number | null) => {
        this.closedFlag = true;
        live.delete(this);
        const why = this.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 500);
        for (const p of this.pending.values()) p.reject(new Error(`${command} stopped (exit ${code})${why ? `: ${why}` : ''}`));
        this.pending.clear();
        resolve(code);
      };
      this.child.on('error', (err) => {
        this.stderrTail += String(err);
        end(-1);
      });
      this.child.on('close', end);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** The last lines the CLI wrote to stderr (its log), for error messages. */
  get stderr(): string {
    return this.stderrTail;
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closedFlag) return Promise.reject(new Error(`the agent program has stopped (${method})`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedFlag) this.write({ jsonrpc: '2.0', method, params });
  }

  /** End the CLI and its children. */
  close(): void {
    if (this.child.exitCode !== null || this.closedFlag) return;
    this.closedFlag = true;
    live.delete(this);
    // On Windows the child is cmd.exe: end the whole tree (fails only if it already exited).
    if (process.platform === 'win32' && this.child.pid) execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], () => {}); // fails only if the tree already exited
    else this.child.kill('SIGTERM');
  }

  private write(msg: unknown): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol message (a stray print); ignore
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (!hasId) {
        try {
          this.handlers.onNotification(msg.method, msg.params);
        } catch (e) {
          this.stderrTail += `\n[client] ${String(e)}`;
        }
        return;
      }
      void Promise.resolve()
        .then(() => this.handlers.onRequest(msg.method, msg.params))
        .then(
          (result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
          (e) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e as Error)?.message ?? e) } }),
        );
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    if (msg.error) p.reject(new AcpRequestError(p.method, msg.error));
    else p.resolve(msg.result);
  }
}
