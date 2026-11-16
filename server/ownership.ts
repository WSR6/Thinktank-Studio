/**
 * File ownership: each task in tasks.json may claim paths with `"files": ["src/api/**", "README.md"]`.
 * Used to warn when two agents' tasks claim the same area, and when an agent edits outside its own.
 * Patterns are relative to the repo root. `**` = any depth, `*` = within one folder,
 * and a plain path also covers everything under it (`src/api` = `src/api/**`).
 */

import { LOCKFILES } from './setup.js';

/**
 * Lockfiles that tools generate (npm install, setup in tts.yaml): not anyone's area. Whoever owns the
 * manifest effectively owns them. requirements.txt is written by hand, so it still counts.
 */
const GENERATED = new Set(LOCKFILES.filter((f) => f !== 'requirements.txt'));
/** Output that test and review tools write into the worktree: nobody's area either. */
const SCRATCH_DIRS = ['.vitest/', 'test-results/', 'playwright-report/', '.final-review/', 'coverage/', '.pytest_cache/', '__pycache__/', '.nyc_output/'];
const generated = (file: string) =>
  GENERATED.has(file.split('/').pop() ?? file) || SCRATCH_DIRS.some((d) => file.startsWith(d) || file.includes(`/${d}`));

export interface OwnedTask {
  id: string;
  owner?: string;
  title?: string;
  files?: unknown;
  status?: string;
  after?: unknown;
}

const patternsOf = (t: OwnedTask): string[] =>
  Array.isArray(t.files) ? t.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(norm) : [];

function norm(p: string): string {
  return p.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function toRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` matches zero or more folders; a trailing `**` matches anything.
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern also covers everything beneath it (a folder name claims the folder).
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function matches(file: string, pattern: string): boolean {
  return toRegex(norm(pattern)).test(norm(file));
}

/** Path segments; a plain path also covers everything beneath it, so it gets a trailing `**`. */
function segments(pattern: string): string[] {
  const segs = norm(pattern).split('/').filter(Boolean);
  // A plain path covers what's under it; a wildcard name like *.js means files, not folders called x.js.
  const last = segs.at(-1) ?? '';
  if (last !== '**' && !/[*?]/.test(last)) segs.push('**');
  return segs;
}

const WILD = /[*?]/;

/** Could one folder/file name match both segment patterns? (Exact for literals; prefix/suffix check for two wildcards.) */
function segmentsMeet(x: string, y: string): boolean {
  if (!WILD.test(x) && !WILD.test(y)) return x === y;
  const seg = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`);
  if (!WILD.test(x)) return seg(y).test(x);
  if (!WILD.test(y)) return seg(x).test(y);
  // Both have wildcards: the literal text before the first and after the last wildcard must agree.
  const pre = (p: string) => p.slice(0, p.search(WILD));
  const suf = (p: string) => p.slice(Math.max(p.lastIndexOf('*'), p.lastIndexOf('?')) + 1);
  const [px, py, sx, sy] = [pre(x), pre(y), suf(x), suf(y)];
  return (px.startsWith(py) || py.startsWith(px)) && (sx.endsWith(sy) || sy.endsWith(sx));
}

/** True when the two patterns could match a common file, comparing folder by folder (`**` = any depth). */
function mayOverlap(a: string, b: string): boolean {
  const A = segments(a);
  const B = segments(b);
  const memo = new Map<string, boolean>();
  const meet = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key)!;
    let ok: boolean;
    if (i === A.length && j === B.length) ok = true;
    else if (A[i] === '**') ok = meet(i + 1, j) || (j < B.length && meet(i, j + 1));
    else if (B[j] === '**') ok = meet(i, j + 1) || (i < A.length && meet(i + 1, j));
    else if (i === A.length || j === B.length) ok = false;
    else ok = segmentsMeet(A[i], B[j]) && meet(i + 1, j + 1);
    memo.set(key, ok);
    return ok;
  };
  return meet(0, 0);
}

export interface Overlap {
  a: { task: string; owner: string; pattern: string };
  b: { task: string; owner: string; pattern: string };
}

/** Every task `t` comes after, directly or through others. */
function ancestors(t: OwnedTask, byId: Map<string, OwnedTask>, seen = new Set<string>()): Set<string> {
  for (const d of Array.isArray(t.after) ? t.after : []) {
    if (typeof d !== 'string' || seen.has(d)) continue;
    seen.add(d);
    const dep = byId.get(d);
    if (dep) ancestors(dep, byId, seen);
  }
  return seen;
}

/**
 * Claims by different owners that may cover the same files, for tasks that can run at the same
 * time: not when either is done, and not when one comes after the other (they run in turn).
 */
export function findOverlaps(tasks: OwnedTask[]): Overlap[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = tasks.filter((t) => t.owner && t.status !== 'done');
  const before = new Map(active.map((t) => [t.id, ancestors(t, byId)]));
  const claims = active.flatMap((t) => patternsOf(t).map((pattern) => ({ task: t.id, owner: t.owner!, pattern })));
  const out: Overlap[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.owner === b.owner) continue;
      if (before.get(a.task)!.has(b.task) || before.get(b.task)!.has(a.task)) continue;
      if (mayOverlap(a.pattern, b.pattern)) out.push({ a, b });
    }
  }
  return out;
}

/** Stable id for an overlap, so each is announced once. */
export const overlapId = (o: Overlap) => [`${o.a.task}:${o.a.pattern}`, `${o.b.task}:${o.b.pattern}`].sort().join(' | ');

export interface ScopeReport {
  /** Edited files no task of this agent claims (only reported if the agent claims something). */
  outside: string[];
  /** Edited files claimed by another agent's task. */
  foreign: { file: string; owner: string; task: string }[];
}

export function checkScope(agentId: string, files: string[], tasks: OwnedTask[]): ScopeReport {
  const own = tasks.filter((t) => t.owner === agentId);
  const mine = own.flatMap(patternsOf);
  // One of its tasks claims no files: it may touch anything not claimed by a teammate.
  const unrestricted = own.some((t) => !patternsOf(t).length);
  const others = tasks.filter((t) => t.owner && t.owner !== agentId);
  const outside: string[] = [];
  const foreign: ScopeReport['foreign'] = [];
  for (const f of files) {
    if (generated(f) || mine.some((p) => matches(f, p))) continue;
    const claim = others.find((t) => patternsOf(t).some((p) => matches(f, p)));
    if (claim) foreign.push({ file: f, owner: claim.owner!, task: claim.id });
    else if (mine.length && !unrestricted) outside.push(f);
  }
  return { outside, foreign };
}
