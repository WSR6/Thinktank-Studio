import { execFile, spawn } from 'node:child_process';
import { type Dirent, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Layout:
 *   <root>/<name>/repo          main worktree (branch main) — leader merges here
 *   <root>/<name>/agents/<id>   one git worktree per agent (branch agent/<id>)
 *   <root>/<name>/team          shared PLAN.md, tasks.json, chat log (outside git)
 */
export interface ProjectInfo {
  name: string;
  root: string;
  repoDir: string;
  teamDir: string;
  agentDirs: Record<string, string>;
}

export function projectsRoot(): string {
  return resolve(process.env.TTS_PROJECTS_DIR ?? join(homedir(), 'ThinktankProjects'));
}

/**
 * Every server-side git call runs with hooks pointed at a dir that doesn't exist. Agents share
 * repo/.git, so otherwise an agent could plant .git/hooks/post-merge and have it run when you click Merge.
 */
const NO_HOOKS = ['-c', `core.hooksPath=${join(tmpdir(), 'tts-no-hooks-dir')}`];
const git = (cwd: string, ...args: string[]) => exec('git', [...NO_HOOKS, ...args], { cwd, maxBuffer: 50 * 1024 * 1024 });
export { git as runGit, identity as gitIdentity };

/**
 * Dirs outside its worktree an agent may write: the shared team folder, plus the parts of the
 * shared .git that committing from a worktree needs. Not hooks/ or config.
 */
export function agentWritableDirs(p: ProjectInfo, worktreeName: string): string[] {
  const g = join(p.repoDir, '.git');
  return [p.teamDir, join(g, 'worktrees', worktreeName), join(g, 'objects'), join(g, 'refs'), join(g, 'logs')];
}

/**
 * A throwaway, detached checkout of an agent's branch for reviewers to run and test, so they never
 * merge the branch under review into their own. Refreshed to the branch tip for each review; ignored
 * files (node_modules, build output) are kept between reviews to save reinstalling.
 */
export async function prepareReviewWorktree(p: ProjectInfo, owner: string): Promise<{ dir: string; name: string }> {
  const name = `_review-${owner}`;
  const dir = join(p.root, 'agents', name);
  if (!existsSync(dir)) {
    await git(p.repoDir, 'worktree', 'prune').catch(() => {});
    await git(p.repoDir, 'worktree', 'add', '--detach', dir, `agent/${owner}`);
  } else {
    await git(dir, 'checkout', '--detach', '--force', `agent/${owner}`);
    await git(dir, 'clean', '-fd');
  }
  return { dir, name };
}

/** Use the user's git identity when set; otherwise a fallback so commits/merges don't fail. */
async function identity(cwd: string): Promise<string[]> {
  try {
    await git(cwd, 'config', 'user.email');
    return [];
  } catch {
    return ['-c', 'user.name=Thinktank Studio', '-c', 'user.email=tts@localhost'];
  }
}

function paths(name: string, agentIds: string[]): ProjectInfo {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Project name: letters, numbers, - and _ only');
  const root = join(projectsRoot(), name);
  return {
    name,
    root,
    repoDir: join(root, 'repo'),
    teamDir: join(root, 'team'),
    agentDirs: Object.fromEntries(agentIds.map((id) => [id, join(root, 'agents', id)])),
  };
}

const PLAN_TEMPLATE = (name: string) => `# ${name} — Plan

## Goal

## Architecture

## Components & owners

## Open questions
`;

export async function createProject(name: string, agentIds: string[]): Promise<ProjectInfo> {
  const p = paths(name, agentIds);
  if (existsSync(p.root)) throw new Error(`Project "${name}" already exists`);
  await mkdir(p.repoDir, { recursive: true });
  await mkdir(p.teamDir, { recursive: true });
  await mkdir(join(p.root, 'agents'), { recursive: true });

  await git(p.repoDir, 'init', '-b', 'main');
  await keepLineEndings(p.repoDir);
  await writeFile(join(p.repoDir, 'README.md'), `# ${name}\n`);
  await writeFile(join(p.repoDir, '.gitignore'), 'node_modules\n.env\n');
  await git(p.repoDir, 'add', '-A');
  await git(p.repoDir, ...(await identity(p.repoDir)), 'commit', '-m', 'Initial commit');

  await writeFile(join(p.teamDir, 'PLAN.md'), PLAN_TEMPLATE(name));
  await writeFile(join(p.teamDir, 'tasks.json'), JSON.stringify({ tasks: [] }, null, 2) + '\n');

  await ensureWorktrees(p);
  return p;
}

export async function openProject(name: string, agentIds: string[]): Promise<ProjectInfo> {
  const p = paths(name, agentIds);
  if (!existsSync(join(p.repoDir, '.git'))) throw new Error(`Project "${name}" not found`);
  await mkdir(p.teamDir, { recursive: true });
  await keepLineEndings(p.repoDir).catch(() => {});
  // Worktrees store absolute paths; repair them in case the project folder was moved.
  await git(p.repoDir, 'worktree', 'repair', ...Object.values(p.agentDirs).filter((d) => existsSync(d))).catch(() => {});
  await ensureWorktrees(p);
  return p;
}

/**
 * Store files exactly as written, whatever the machine's git default (Git for Windows converts
 * line endings). Avoids "LF will be replaced by CRLF" noise and diffs that only change line endings.
 * Set in the repo's own config, which all worktrees share, so agents' own git commands follow it too.
 */
async function keepLineEndings(repoDir: string): Promise<void> {
  await git(repoDir, 'config', 'core.autocrlf', 'false');
}

/** Adds a worktree for any agent that doesn't have one yet (e.g. agent added to config later). */
async function ensureWorktrees(p: ProjectInfo): Promise<void> {
  const { stdout } = await git(p.repoDir, 'branch', '--list', 'agent/*');
  const branches = new Set(stdout.split('\n').map((b) => b.replace(/^[*+]?\s*/, '').trim()));
  for (const [id, dir] of Object.entries(p.agentDirs)) {
    if (existsSync(dir)) continue;
    const branch = `agent/${id}`;
    if (branches.has(branch)) await git(p.repoDir, 'worktree', 'add', dir, branch);
    else await git(p.repoDir, 'worktree', 'add', dir, '-b', branch);
  }
}

export async function listProjects(): Promise<string[]> {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'repo', '.git')))
    .map((e) => e.name)
    .sort();
}

// ── Branches ────────────────────────────────────────────────────────────

export interface BranchStatus {
  agentId: string;
  branch: string;
  /** Commits on the agent branch not yet in main. */
  ahead: number;
  /** Commits on main the agent branch hasn't picked up. */
  behind: number;
  dirty: boolean;
  lastCommit: string;
  /** Would merging into main conflict right now? null = unknown (git < 2.38). */
  conflicts: boolean | null;
  /** Short id of main's tip (the same for every agent), for the "Finished" banner. */
  mainCommit: string;
}

/** Dry-run merge with `git merge-tree --write-tree` (no worktree changes). Exit 1 = conflicts. */
async function wouldConflict(p: ProjectInfo, branch: string): Promise<boolean | null> {
  try {
    await git(p.repoDir, 'merge-tree', '--write-tree', '--name-only', 'main', branch);
    return false;
  } catch (err: any) {
    return err?.code === 1 ? true : null;
  }
}

export async function branchStatus(p: ProjectInfo): Promise<BranchStatus[]> {
  const mainCommit = (await git(p.repoDir, 'log', '-1', '--format=%h', 'main').catch(() => ({ stdout: '' }))).stdout.trim();
  return Promise.all(
    Object.entries(p.agentDirs).map(async ([agentId, dir]) => {
      const branch = `agent/${agentId}`;
      const count = async (range: string) => Number((await git(p.repoDir, 'rev-list', '--count', range)).stdout.trim());
      const [ahead, behind, status, last] = await Promise.all([
        count(`main..${branch}`),
        count(`${branch}..main`),
        git(dir, 'status', '--porcelain'),
        git(p.repoDir, 'log', '-1', '--format=%h %s', branch),
      ]);
      const conflicts = ahead && behind ? await wouldConflict(p, branch) : false;
      return { agentId, branch, ahead, behind, dirty: status.stdout.trim() !== '', lastCommit: last.stdout.trim(), conflicts, mainCommit };
    }),
  );
}

/** Cap so a huge generated file can't freeze the browser. */
const MAX_DIFF_BYTES = 400_000;

export interface BranchDiff {
  agentId: string;
  /** What a merge would bring into main: changes since the branch forked (main...agent/x). */
  committed: string;
  /** Edits in the agent's worktree that aren't committed yet (won't be merged). */
  uncommitted: string;
  stat: string;
  truncated: boolean;
}

export async function branchDiff(p: ProjectInfo, agentId: string): Promise<BranchDiff> {
  return { agentId, ...(await diffWithWorktree(p.repoDir, `main...agent/${agentId}`, p.agentDirs[agentId])) };
}

/**
 * Committed changes in `range` (run in repoDir) plus uncommitted and untracked edits in worktree `wt`.
 * Shared by the Branches tab and the App helper.
 */
export async function diffWithWorktree(repoDir: string, range: string, wt: string): Promise<Omit<BranchDiff, 'agentId'>> {
  const [committed, stat, tracked, untracked] = await Promise.all([
    git(repoDir, 'diff', '--no-color', range),
    git(repoDir, 'diff', '--no-color', '--stat', range),
    git(wt, 'diff', '--no-color', 'HEAD'),
    git(wt, 'ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  // New files the agent hasn't committed are the common case; `git diff HEAD` skips them.
  const newFiles = untracked.stdout.split('\0').filter(Boolean).slice(0, 50);
  const newDiffs = await Promise.all(
    newFiles.map((f) =>
      // --no-index exits 1 when the files differ, which is always here; the diff is still on stdout.
      git(wt, 'diff', '--no-color', '--no-index', '--', '/dev/null', f).then((r) => r.stdout, (e) => e.stdout ?? ''),
    ),
  );
  const uncommitted = tracked.stdout + newDiffs.join('');
  const cap = (s: string) => (s.length > MAX_DIFF_BYTES ? s.slice(0, MAX_DIFF_BYTES) : s);
  return {
    committed: cap(committed.stdout),
    uncommitted: cap(uncommitted),
    stat: stat.stdout.trim(),
    truncated: committed.stdout.length > MAX_DIFF_BYTES || uncommitted.length > MAX_DIFF_BYTES,
  };
}

export class MergeConflictError extends Error {
  constructor(public files: string[], target: string) {
    super(`Merge conflict in ${target}: ${files.join(', ')}`);
  }
}

/** Merge `from` into the branch checked out at `cwd`. On conflict: abort, throw the file list. */
async function mergeInto(cwd: string, from: string, label: string, message?: string): Promise<string> {
  const dirty = (await git(cwd, 'status', '--porcelain')).stdout.trim();
  if (dirty) throw new Error(`${label} has uncommitted changes — commit or stash them first`);
  try {
    const { stdout } = await git(cwd, ...(await identity(cwd)), 'merge', '--no-ff', ...(message ? ['-m', message] : ['--no-edit']), from);
    return stdout.trim();
  } catch (err) {
    const { stdout } = await git(cwd, 'diff', '--name-only', '--diff-filter=U');
    const files = stdout.split('\n').filter(Boolean);
    if (!files.length) throw err;
    await git(cwd, 'merge', '--abort');
    throw new MergeConflictError(files, label);
  }
}

/**
 * Merge an agent's branch into main. With `rev`, only up to that commit (the one that was reviewed):
 * later commits and uncommitted edits in its worktree stay out, so they don't block it either.
 */
export async function mergeAgent(p: ProjectInfo, agentId: string, rev?: string): Promise<string> {
  const dir = p.agentDirs[agentId];
  if (!rev && (await git(dir, 'status', '--porcelain')).stdout.trim()) {
    throw new Error(`agent/${agentId} has uncommitted changes — ask the agent to commit first`);
  }
  // Same message either way: conflictingAgents() finds each agent's merged work by it.
  return mergeInto(p.repoDir, rev ?? `agent/${agentId}`, 'main', `Merge branch 'agent/${agentId}'`);
}

/** This commit is already part of main. */
export async function inMain(p: ProjectInfo, rev: string): Promise<boolean> {
  return git(p.repoDir, 'merge-base', '--is-ancestor', rev, 'main').then(() => true, () => false);
}

// ── Arbiter workspace ──────────────────────────────────────────────────

/**
 * Agents whose merged work on main touched these files (from the "Merge branch 'agent/x'" commits),
 * i.e. the other side of a conflict with agent/<id>.
 */
export async function conflictingAgents(p: ProjectInfo, files: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const f of files.slice(0, 20)) {
    const { stdout } = await git(p.repoDir, 'log', 'main', '--first-parent', '--format=%s', '--', f).catch(() => ({ stdout: '' }));
    for (const m of stdout.matchAll(/agent\/([a-z0-9_-]+)/g)) found.add(m[1]);
  }
  return [...found];
}

/**
 * A throwaway worktree on branch arbiter/<id>, starting from agent/<id>, where a neutral agent
 * resolves the conflict without touching anyone's own working copy.
 */
export async function createArbiterWorktree(p: ProjectInfo, agentId: string): Promise<{ dir: string; name: string; branch: string }> {
  const name = `_arbiter-${agentId}`;
  const dir = join(p.root, 'agents', name);
  const branch = `arbiter/${agentId}`;
  await removeArbiterWorktree(p, agentId);
  await git(p.repoDir, 'worktree', 'add', '-B', branch, dir, `agent/${agentId}`);
  return { dir, name, branch };
}

export async function removeArbiterWorktree(p: ProjectInfo, agentId: string): Promise<void> {
  const dir = join(p.root, 'agents', `_arbiter-${agentId}`);
  if (existsSync(dir)) await git(p.repoDir, 'worktree', 'remove', '--force', dir).catch(() => {});
  await git(p.repoDir, 'worktree', 'prune').catch(() => {});
  await git(p.repoDir, 'branch', '-D', `arbiter/${agentId}`).catch(() => {});
}

/**
 * After arbitration: the resolved branch must contain main and have no conflict markers left.
 * Then fast-forward the agent's own branch to it (its worktree must be clean).
 */
export async function adoptArbiterResult(p: ProjectInfo, agentId: string): Promise<void> {
  const branch = `arbiter/${agentId}`;
  const ok = await git(p.repoDir, 'merge-base', '--is-ancestor', 'main', branch).then(() => true, () => false);
  if (!ok) throw new Error('the arbiter did not finish merging main into the branch');
  const markers = await git(p.repoDir, 'grep', '-l', '-E', '^(<<<<<<<|>>>>>>>) ', branch).then((r) => r.stdout.trim(), () => '');
  if (markers) throw new Error(`conflict markers are still in: ${markers.split('\n').map((l) => l.replace(/^[^:]*:/, '')).join(', ')}`);
  const wt = p.agentDirs[agentId];
  if ((await git(wt, 'status', '--porcelain')).stdout.trim()) throw new Error(`agent/${agentId} has uncommitted changes, so it can't take the resolution yet`);
  await git(wt, 'merge', '--ff-only', branch);
}

/** Bring main's merged work into an agent's worktree. */
export async function syncAgent(p: ProjectInfo, agentId: string): Promise<string> {
  return mergeInto(p.agentDirs[agentId], 'main', `agent/${agentId}`);
}

/** Files an agent has changed vs main: committed on its branch plus uncommitted/untracked in its worktree. */
export async function changedFiles(p: ProjectInfo, agentId: string): Promise<string[]> {
  const [committed, status] = await Promise.all([
    ownCommittedFiles(p, agentId),
    git(p.agentDirs[agentId], 'status', '--porcelain', '-z', '--untracked-files=all'),
  ]);
  const files = new Set(committed);
  // porcelain -z entries: "XY path", and a rename adds the old path as an extra entry.
  const entries = status.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    files.add(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return [...files].sort();
}

/**
 * Files the agent itself still changes on its branch (not yet in main): changed by commits it made,
 * and different now from before its first commit to that file. Teammates' work it merged in (even a
 * fast-forward) doesn't count: the branch's reflog tells commits made on it ("commit: …") from ones it
 * received ("merge …"). A rebase it ran is followed back to the commits it copied: a copy of its own
 * commit is its own, a copy of a teammate's commit stays theirs. Falls back to the first-parent
 * history when there's no reflog.
 */
async function ownCommittedFiles(p: ProjectInfo, agentId: string): Promise<string[]> {
  const branch = `agent/${agentId}`;
  const lines = (sha: string | Promise<{ stdout: string }>) => Promise.resolve(sha).then((r) => (typeof r === 'string' ? [r] : r.stdout.split('\n').filter(Boolean)));
  const pending = new Set(await lines(git(p.repoDir, 'rev-list', branch, '--not', 'main')));
  if (!pending.size) return [];
  const reflog = (await git(p.repoDir, 'reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--').catch(() => ({ stdout: '' }))).stdout
    .split('\n')
    .filter(Boolean);
  let mine: string[];
  // Merges it committed itself after resolving a conflict ("commit (merge): …").
  const resolutions: string[] = [];
  if (!reflog.length) {
    mine = await lines(git(p.repoDir, 'rev-list', '--reverse', '--first-parent', '--no-merges', branch, '--not', 'main'));
  } else {
    const made = new Set<string>();
    const picks: string[] = [];
    const rebases: { tip: string; onto: string; before?: string }[] = [];
    reflog.forEach((l, i) => {
      const own = l.match(/^([0-9a-f]{40}) (commit(?: \((?:amend|initial)\))?:|revert:)/)?.[1];
      if (own) made.add(own);
      const resolved = l.match(/^([0-9a-f]{40}) commit \(merge\):/)?.[1];
      if (resolved && pending.has(resolved)) resolutions.push(resolved);
      const pick = l.match(/^([0-9a-f]{40}) cherry-pick:/)?.[1];
      if (pick) picks.push(pick);
      // The branch reflog records only the end of a rebase: "rebase (finish): … onto <sha>"; the entry
      // below it is the branch tip before the rebase, whose commits the rebase copied.
      const rebase = l.match(/^([0-9a-f]{40}) rebase.*\bfinish(?:ed)?\b.*\bonto ([0-9a-f]{40})/);
      if (rebase) rebases.push({ tip: rebase[1], onto: rebase[2], before: reflog[i + 1]?.slice(0, 40) });
    });
    // A cherry-pick of a change that's already on a teammate's branch is theirs. Checked on the
    // picked commit itself (before any rebase rewrites it), so a later rebase keeps an own pick its own.
    if (picks.length) {
      const others = Object.keys(p.agentDirs).filter((id) => id !== agentId);
      for (const h of picks) {
        let theirs = false;
        for (const o of others) {
          const cherry = await git(p.repoDir, 'cherry', `agent/${o}`, h, `${h}^`).catch(() => ({ stdout: '' }));
          if (cherry.stdout.split('\n').some((l) => l.startsWith('- '))) theirs = true;
        }
        if (!theirs) made.add(h);
      }
    }
    // Oldest rebase first, so a copy of a copy is traced back too.
    for (const rb of rebases.reverse()) {
      const copies = await lines(git(p.repoDir, 'rev-list', rb.tip, '--not', rb.onto).catch(() => ({ stdout: '' })));
      const originals = rb.before ? await lines(git(p.repoDir, 'rev-list', rb.before, '--not', rb.onto).catch(() => ({ stdout: '' }))) : [];
      const ids = await patchIds(p.repoDir, [...copies, ...originals]);
      const ownIds = new Set(originals.filter((h) => made.has(h)).map((h) => ids.get(h)).filter(Boolean));
      const allIds = new Set(originals.map((h) => ids.get(h)).filter(Boolean));
      // A copy of its own commit is its own; a copy of nothing it had (edited while resolving) is its own too.
      for (const c of copies) if (ownIds.has(ids.get(c)) || !allIds.has(ids.get(c))) made.add(c);
    }
    // Oldest first, for "before its first commit to that file" below.
    mine = (await lines(git(p.repoDir, 'rev-list', '--reverse', '--topo-order', branch, '--not', 'main'))).filter((h) => made.has(h));
  }
  // A file it resolved by hand in a merge: the result matches neither side, so that's its own choice.
  const handResolved = new Set<string>();
  for (const m of resolutions) {
    const vs = async (parent: string) =>
      new Set((await git(p.repoDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', parent, m).catch(() => ({ stdout: '' }))).stdout.split('\0').filter(Boolean));
    const [a, b] = await Promise.all([vs(`${m}^1`), vs(`${m}^2`)]);
    for (const f of a) if (b.has(f)) handResolved.add(f);
  }
  if (!mine.length && !handResolved.size) return [];
  // The commit before its first change to each file.
  const firstBase = new Map<string, string>();
  for (const sha of mine) {
    const files = (await git(p.repoDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '-m', '--first-parent', sha)).stdout.split('\0').filter(Boolean);
    for (const f of files) if (!firstBase.has(f)) firstBase.set(f, `${sha}^`);
  }
  // Keep a file only if it differs now from before the agent first touched it (so A→B→A, or a
  // teammate's change it merged and then put back, isn't counted).
  const blobs = async (rev: string, files: string[]) => {
    const out = (await git(p.repoDir, 'ls-tree', '-r', '-z', rev, '--', ...files).catch(() => ({ stdout: '' }))).stdout;
    return new Map(out.split('\0').filter(Boolean).map((e) => [e.slice(e.indexOf('\t') + 1), e.split(' ')[2]?.split('\t')[0]]));
  };
  const files = [...new Set([...firstBase.keys(), ...handResolved])];
  const [now, onMain] = await Promise.all([blobs(branch, files), blobs('main', files)]);
  const byBase = new Map<string, string[]>();
  for (const [f, base] of firstBase) byBase.set(base, [...(byBase.get(base) ?? []), f]);
  const changed = new Set<string>();
  for (const [base, fs] of byBase) {
    const then = await blobs(base, fs);
    for (const f of fs) if (now.get(f) !== then.get(f)) changed.add(f);
  }
  // A hand resolution counts even if it put the file back the way it was (it can undo main's change).
  for (const f of handResolved) changed.add(f);
  // Only what it would still change in main: a file that now matches main (e.g. it kept main's side
  // when a sync conflicted) isn't its change any more.
  return [...changed].filter((f) => now.get(f) !== onMain.get(f)).sort();
}

/** `git patch-id --stable` for each commit: equal ids mean the same change. */
function patchIds(repoDir: string, shas: string[]): Promise<Map<string, string>> {
  if (!shas.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const show = spawn('git', [...NO_HOOKS, 'show', '--no-color', '--format=commit %H', '-p', '--no-ext-diff', ...shas], { cwd: repoDir });
    const pid = spawn('git', ['patch-id', '--stable'], { cwd: repoDir });
    show.stdout.pipe(pid.stdin);
    let out = '';
    pid.stdout.on('data', (d) => (out += d));
    const done = () => resolve(new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ').reverse() as [string, string])));
    pid.on('close', done);
    pid.on('error', done);
    show.on('error', () => pid.stdin.end());
  });
}

/** The commit an agent's branch points at now. */
export async function branchTip(p: ProjectInfo, agentId: string): Promise<string> {
  return (await git(p.repoDir, 'rev-parse', `agent/${agentId}`)).stdout.trim();
}

/**
 * What a "done" report can be checked against: files the branch changed in commits (vs main, or
 * since `since`, the tip saved when the task was sent back), and files changed but not committed.
 */
export async function committedChanges(p: ProjectInfo, agentId: string, since?: string): Promise<{ committed: string[]; uncommitted: string[] }> {
  // The agent's own commits: on its branch's first-parent line, not merges, not already on main, and
  // (for a later attempt) not before the send-back. Teammates' work brought in by Sync or a merge is
  // on main or behind a merge commit, so it doesn't count.
  const [diff, status] = await Promise.all([
    git(p.repoDir, 'log', '--first-parent', '--no-merges', '--format=', '--name-only', '-z', `agent/${agentId}`, '--not', 'main', ...(since ? [since] : [])),
    git(p.agentDirs[agentId], 'status', '--porcelain', '-z', '--untracked-files=all'),
  ]);
  const uncommitted: string[] = [];
  const entries = status.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].length < 4) continue;
    uncommitted.push(entries[i].slice(3));
    if (entries[i][0] === 'R' || entries[i][0] === 'C') i++;
  }
  const committed = [...new Set(diff.stdout.split(/[\0\n]/).filter(Boolean))];
  return { committed, uncommitted };
}

/**
 * Files under team/ changed after `sinceMs`, as "team/<path>". team/ lives outside the git repo, so
 * commits never show edits there (a docs-only fix in team/PLAN.md); the done check counts them by file time.
 */
const APP_TEAM_FILES = new Set(['tasks.json', 'chat.jsonl', 'session.json', 'reviews.json', 'comments.json', 'setup-state.json', 'activity', 'backups', 'attachments']);

export function teamFilesChangedSince(p: ProjectInfo, sinceMs: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // The app's own bookkeeping (rewritten on every send-back, review, turn) isn't the agent's work.
      if (/\.tmp$/.test(e.name) || (depth === 0 && APP_TEAM_FILES.has(e.name))) continue;
      const path = join(dir, e.name);
      const name = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < 3) walk(path, name, depth + 1);
      } else if (e.isFile()) {
        try {
          if (statSync(path).mtimeMs > sinceMs) found.push(name);
        } catch {
          /* gone again */
        }
      }
    }
  };
  walk(p.teamDir, 'team', 0);
  return found;
}

/** Fingerprint of an agent's work (HEAD + uncommitted changes); unchanged across a turn = no progress. */
export async function workSnapshot(p: ProjectInfo, agentId: string): Promise<string> {
  const dir = p.agentDirs[agentId];
  const [head, status] = await Promise.all([git(dir, 'rev-parse', 'HEAD'), git(dir, 'status', '--porcelain')]);
  return head.stdout.trim() + '\n' + status.stdout;
}

// ── Team files ──────────────────────────────────────────────────────────

/**
 * Decode a team file whatever wrote it. Agents on Windows sometimes use PowerShell:
 * `Set-Content -Encoding utf8` adds a UTF-8 BOM, and `>` / `Out-File` write UTF-16 LE.
 * Both would otherwise reach JSON.parse as garbage.
 */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/**
 * Save a BOM or UTF-16 team file back as plain UTF-8, so agents' edit tools (which match UTF-8
 * text) can still change it. Skipped if the file changed since it was read.
 */
async function rewriteAsUtf8(path: string, original: Buffer, text: string): Promise<void> {
  // One rewrite per file at a time, each with its own temp file, so concurrent reads can't mix them.
  const prev = rewrites.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
    const tmp = `${path}.${process.pid}.${++rewriteSeq}.utf8.tmp`;
    try {
      await writeFile(tmp, text);
      // Check right before the swap: if an agent has rewritten the file meanwhile, keep its version.
      // (Not airtight against a write in the last instant, but the window is now a few microseconds.)
      if (readFileSync(path).equals(original)) renameSync(tmp, path);
    } catch {
      // Best effort: the decoded text is still used for this read.
    } finally {
      rmSync(tmp, { force: true });
    }
  });
  rewrites.set(path, next);
  await next;
  if (rewrites.get(path) === next) rewrites.delete(path);
}
const rewrites = new Map<string, Promise<void>>();
let rewriteSeq = 0;

export async function readTeamFiles(p: ProjectInfo): Promise<{ plan: string; tasks: string }> {
  const read = async (f: string) => {
    const path = join(p.teamDir, f);
    try {
      const buf = await readFile(path);
      const text = decodeText(buf);
      if (text !== buf.toString('utf8')) await rewriteAsUtf8(path, buf, text);
      return text;
    } catch {
      return '';
    }
  };
  const [plan, tasks] = await Promise.all([read('PLAN.md'), read('tasks.json')]);
  return { plan, tasks };
}

export async function writePlan(p: ProjectInfo, plan: string): Promise<void> {
  await writeFile(join(p.teamDir, 'PLAN.md'), plan);
}
