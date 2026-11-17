/**
 * tts.yaml setup in agents' worktrees and review copies: copy the listed gitignored files, run the
 * setup commands when they (or a lockfile) changed, and tell turns and the status line how it went.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareReviewWorktree, type ProjectInfo } from '../project.js';
import { copyIncludes, defaultSetup, readSetupConfig, runSetup, SETUP_FILE, setupHash, type SetupConfig } from '../setup.js';
import type { AgentEvent } from '../types.js';
import { readJson, writeAtomic } from './persistence.js';

/** What the setup runner needs from the orchestrator. */
export interface SetupHost {
  project(): ProjectInfo | undefined;
  notice(text: string): void;
  emitAgent(agentId: string, event: AgentEvent): void;
  /** Something the UI shows changed (a setup started or ended). */
  changed(): void;
  nameOf(id: string): string;
}

export class WorktreeSetup {
  /** Setup runs by worktree folder, so a turn working there can wait for it; and the command running. */
  private runs = new Map<string, Promise<void>>();
  private running = new Map<string, string>();
  /** How setup last went in each folder (this run of the app; `ok` without `at` = done earlier, still current). */
  private results = new Map<string, { ok: boolean; at?: number; failed?: string }>();
  private stateWrite: Promise<void> = Promise.resolve();

  constructor(private host: SetupHost) {}

  /** The setup command running in this folder right now, if any (for the status line). */
  runningIn(dir: string): string | undefined {
    return this.running.get(dir);
  }

  /**
   * tts.yaml: copy the listed gitignored files into a worktree, and run the setup commands there when
   * they, or a lockfile, changed since setup last succeeded in it (so: new worktrees, and after a Sync
   * that brought new dependencies). Output goes to `logTo`'s activity panel; a failure is posted, and
   * turns go ahead anyway. Deduplicated per folder.
   */
  ensure(key: string, dir: string, logTo?: string): Promise<void> {
    const p = this.host.project();
    const running = this.runs.get(dir);
    if (!p || running) return running ?? Promise.resolve();
    let cfg: SetupConfig | undefined;
    try {
      // The worktree's own copy: one that hasn't synced main's tts.yaml yet has nothing to set up.
      cfg = readSetupConfig(dir);
      // No tts.yaml: still reinstall when package-lock.json changes (e.g. after a fast-forward to a teammate's branch).
      if (!cfg && !existsSync(join(dir, SETUP_FILE))) cfg = defaultSetup(dir);
    } catch (e) {
      this.host.notice(`${SETUP_FILE} couldn't be read, so no setup ran: ${(e as Error).message}`);
      return Promise.resolve();
    }
    if (!cfg) return Promise.resolve();
    const log = (text: string) => logTo && this.host.emitAgent(logTo, { kind: 'log', text: `setup: ${text}` });
    const copied = copyIncludes(p.repoDir, dir, cfg.include);
    if (copied.length) log(`copied ${copied.join(', ')} from repo/`);
    const stateFile = join(p.teamDir, 'setup-state.json');
    if (!cfg.setup.length) return Promise.resolve();
    if (readJson(stateFile)[key] === setupHash(dir, cfg)) {
      if (!this.results.has(dir)) this.results.set(dir, { ok: true });
      return Promise.resolve();
    }
    const setup = cfg;
    const run = (async () => {
      this.running.set(dir, setup.setup[0]);
      this.host.changed();
      const res = await runSetup(dir, setup, { TTS_ROOT: p.repoDir, TTS_WORKTREE: dir, TTS_AGENT: key }, (line) => log(line.slice(0, 300)));
      const label = key.startsWith('_review-') ? `the review copy of agent/${key.slice(8)}` : `${this.host.nameOf(key)}'s worktree`;
      if (res.ok) {
        // Hashed after the run: an install may rewrite the lockfile. One write at a time, tmp + rename,
        // so two setups finishing together both keep their entry.
        const hash = setupHash(dir, setup);
        this.stateWrite = this.stateWrite
          .then(async () => {
            const state = readJson(stateFile);
            state[key] = hash;
            await writeAtomic(stateFile, JSON.stringify(state, null, 2));
          })
          .catch((e) => console.error('setup state:', e));
        await this.stateWrite;
        this.results.set(dir, { ok: true, at: Date.now() });
        log('done');
      } else {
        this.results.set(dir, { ok: false, at: Date.now(), failed: `\`${res.failed}\` ${res.code === null ? 'was stopped' : `exited with ${res.code}`}` });
        this.host.notice(
          `Setup failed in ${label}: \`${res.failed}\` ${res.code === null ? 'was stopped' : `exited with ${res.code}`}. Turns there go ahead anyway; ` +
            `fix ${existsSync(join(dir, SETUP_FILE)) ? SETUP_FILE : 'the install (npm install)'} or run it there yourself. Last output:\n${res.tail.slice(-1500)}`,
        );
      }
    })()
      .catch((e) => console.error('setup failed:', e))
      .finally(() => {
        this.runs.delete(dir);
        this.running.delete(dir);
        this.host.changed();
      });
    this.runs.set(dir, run);
    return run;
  }

  /**
   * A fresh review copy of `owner`'s branch, then set up per its tts.yaml (logged to `reviewer`). A setup
   * still running in that copy finishes first, so the refresh can't change files under an install.
   */
  async reviewCheckout(p: ProjectInfo, owner: string, reviewer: string): Promise<{ dir: string; name: string }> {
    await this.runs.get(join(p.root, 'agents', `_review-${owner}`));
    const checkout = await prepareReviewWorktree(p, owner);
    void this.ensure(checkout.name, checkout.dir, reviewer);
    return checkout;
  }

  /** What the agent should know about tts.yaml setup in its worktree, so it doesn't guess (e.g. "no .venv"). */
  line(dir: string | undefined): string {
    if (!dir || (!existsSync(join(dir, SETUP_FILE)) && !this.runs.has(dir) && !this.results.has(dir))) return '';
    const time = (at?: number) => (at ? ` at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');
    if (this.runs.has(dir)) return `[setup: ${existsSync(join(dir, SETUP_FILE)) ? `${SETUP_FILE} setup` : 'automatic npm install'} is running in your worktree right now; dependencies may not be ready yet]`;
    const res = this.results.get(dir);
    if (!res) return '';
    const what = existsSync(join(dir, SETUP_FILE)) ? `${SETUP_FILE} setup` : 'automatic npm install';
    return res.ok
      ? `[setup: ${what} succeeded in your worktree${res.at ? time(res.at) : ' earlier and is current'}; its dependencies are installed there, so use them]`
      : `[setup: ${what} FAILED in your worktree${time(res.at)} (${res.failed}); dependencies may be missing. Say so if that blocks you]`;
  }

  /** Setup still running in any of these folders, when tts.yaml says turns wait for it. */
  pending(dirs: string[]): Promise<void>[] {
    const waits = (d: string) => {
      try {
        return readSetupConfig(d)?.waitForSetup !== false;
      } catch {
        return false; // a broken tts.yaml is reported when setup runs; turns don't wait on it
      }
    };
    return dirs.filter((d) => this.runs.has(d) && waits(d)).map((d) => this.runs.get(d)!);
  }
}
