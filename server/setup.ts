import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

/**
 * Optional `tts.yaml` in the project repo: how to make a fresh agent worktree ready to build and test.
 *
 *   setup: npm install            # or a list, run in order, stopping at the first failure:
 *   setup:
 *     - npm install
 *     - npm run build
 *   include:                      # gitignored files copied from repo/ into each worktree when missing
 *     - .env
 *   waitForSetup: true            # turns wait until setup is done (default true)
 *
 * Only this small YAML subset is read: `key: value`, `key:` with `- item` lines, and # comments.
 */
export interface SetupConfig {
  setup: string[];
  include: string[];
  waitForSetup: boolean;
}

export const SETUP_FILE = 'tts.yaml';
/** Lockfiles whose change means dependencies must be installed again. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'requirements.txt', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock'];
/** Hand-written dependency lists (Python): not lockfiles, but a change still means setup runs again. */
const MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg'];
const SETUP_TIMEOUT_MS = 20 * 60_000;

const unquote = (v: string) => {
  const s = v.trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
};
/** A ` #` starts a comment unless it's inside quotes. */
const stripComment = (line: string) => {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) q = c === q ? '' : q;
    else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};

/** Parses the subset above. Unknown keys are ignored; a malformed line throws with its number. */
export function parseSetupFile(text: string): SetupConfig {
  const out: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) return;
    const item = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (item) {
      if (!listKey) throw new Error(`${SETUP_FILE} line ${i + 1}: a "- item" needs a "key:" line above it`);
      (out[listKey] as string[]).push(unquote(item[1]));
      return;
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`${SETUP_FILE} line ${i + 1}: expected "key: value"`);
    const [, key, value] = kv;
    if (value.trim()) {
      out[key] = unquote(value);
      listKey = undefined;
    } else {
      out[key] = [];
      listKey = key;
    }
  });
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
  const wait = out.waitForSetup;
  return { setup: list(out.setup), include: list(out.include), waitForSetup: typeof wait === 'string' ? !/^(false|no|off)$/i.test(wait) : true };
}

/** A checkout's setup file, or undefined when there's none. Throws when it can't be parsed. */
export function readSetupConfig(dir: string): SetupConfig | undefined {
  const file = join(dir, SETUP_FILE);
  if (!existsSync(file)) return undefined;
  return parseSetupFile(readFileSync(file, 'utf8'));
}

/**
 * What to run when the project has no tts.yaml setup of its own: `npm install` for a Node project with a
 * package-lock.json, so a lockfile that changes (a merge, or a fast-forward to a teammate's branch) never
 * leaves a worktree with stale node_modules. Not when node_modules is a link into someone else's folder.
 */
export function defaultSetup(dir: string): SetupConfig | undefined {
  if (!existsSync(join(dir, 'package.json')) || !existsSync(join(dir, 'package-lock.json'))) return undefined;
  try {
    if (lstatSync(join(dir, 'node_modules')).isSymbolicLink()) return undefined;
  } catch {
    /* no node_modules yet: install it */
  }
  return { setup: ['npm install'], include: [], waitForSetup: true };
}

/** Changes when the setup commands, a lockfile or a Python manifest in the worktree changes: setup must run again. */
export function setupHash(dir: string, cfg: SetupConfig): string {
  const h = createHash('sha256').update(JSON.stringify(cfg.setup));
  for (const f of [...LOCKFILES, ...MANIFESTS]) {
    const p = join(dir, f);
    if (existsSync(p)) h.update(f).update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Copies each listed file or folder from the main checkout into the worktree when it's missing there.
 * Paths must stay inside the repo. Returns what was copied.
 */
export function copyIncludes(repoDir: string, dir: string, include: string[]): string[] {
  const copied: string[] = [];
  for (const entry of include) {
    const rel = normalize(entry);
    if (isAbsolute(rel) || relative(repoDir, join(repoDir, rel)).startsWith('..')) continue;
    const from = join(repoDir, rel);
    const to = join(dir, rel);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      // Through links (junctions, symlinks) too: the source must really be in repo/, the target in the worktree.
      if (!inside(realpathSync(repoDir), realpathSync(from))) continue;
      mkdirSync(dirname(to), { recursive: true });
      if (!inside(realpathSync(dir), realpathSync(dirname(to)))) continue;
      cpSync(from, to, { recursive: statSync(from).isDirectory() });
      copied.push(entry);
    } catch {
      /* reported as missing when the agent needs it */
    }
  }
  return copied;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export interface SetupResult {
  ok: boolean;
  /** The failing command, when one failed. */
  failed?: string;
  code?: number | null;
  /** Last lines of output, for the failure notice. */
  tail: string;
}

/** Runs the setup commands in order in `dir`, streaming each output line; stops at the first failure. */
export async function runSetup(dir: string, cfg: SetupConfig, env: Record<string, string>, onLine: (line: string) => void): Promise<SetupResult> {
  const recent: string[] = [];
  const note = (line: string) => {
    if (!line.trim()) return;
    recent.push(line);
    if (recent.length > 15) recent.shift();
    onLine(line);
  };
  for (const cmd of cfg.setup) {
    note(`$ ${cmd}`);
    const code = await new Promise<number | null>((resolve) => {
      let settled = false;
      let buf = '';
      const finish = (c: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (buf) note(buf);
        resolve(c);
      };
      const child = spawn(cmd, { cwd: dir, shell: true, windowsHide: true, env: { ...process.env, ...env } });
      const feed = (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        lines.forEach(note);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      const timer = setTimeout(() => {
        note(`(stopped after ${SETUP_TIMEOUT_MS / 60_000} minutes)`);
        // The whole tree: on Windows the shell's children (npm, node) would otherwise keep running.
        if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); // fails only if the tree already exited
        else child.kill();
        setTimeout(() => finish(null), 5000); // even if a leftover child keeps the output open
      }, SETUP_TIMEOUT_MS);
      child.on('error', (e) => {
        note(`could not start: ${e.message}`);
        finish(null);
      });
      // 'close' waits for the output to end; a background child can hold it open, so 'exit' + a grace period also ends the step.
      child.on('close', (c) => finish(c));
      child.on('exit', (c) => setTimeout(() => finish(c), 3000));
    });
    if (code !== 0) return { ok: false, failed: cmd, code, tail: recent.join('\n') };
  }
  return { ok: true, tail: recent.join('\n') };
}
