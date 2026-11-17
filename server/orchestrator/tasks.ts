/**
 * team/tasks.json: reading it (tolerating an agent's half-written rewrite), the app's own edits to it
 * (queued, each on the latest file), and the dependency / hand-off helpers over a task list.
 */
import { existsSync, readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeText, readTeamFiles, type ProjectInfo } from '../project.js';
import { TASKS_PARSE_GRACE_MS, type Task } from './types.js';

/** What the task store needs from the orchestrator. */
export interface TaskStoreHost {
  project(): ProjectInfo | undefined;
  /** tasks.json has stayed unparseable past the grace period (told once per broken spell). */
  broken(file: string, message: string): void;
}

export class TaskStore {
  /** The task list from the last time tasks.json parsed, used while it's mid-rewrite or broken. */
  last: Task[] = [];
  /** When tasks.json started failing to parse (0 = it parses), and whether that was announced. */
  private parseSince = 0;
  private parseAnnounced = false;
  /** Numbers each tasks.json read, so a slow, older read can't overwrite a newer result. */
  private readSeq = 0;
  private readDone = 0;
  /** All app edits to tasks.json go through this queue, each reading the latest file. */
  private writes: Promise<unknown> = Promise.resolve();
  private writeSeq = 0;

  constructor(private host: TaskStoreHost) {}

  /** A project was opened: forget the old one's list and warning state. */
  reset(): void {
    this.parseSince = 0;
    this.parseAnnounced = false;
    this.last = [];
  }

  async read(): Promise<Task[]> {
    const project = this.host.project();
    if (!project) return [];
    const file = join(project.teamDir, 'tasks.json');
    const readNo = ++this.readSeq;
    const raw = (await readTeamFiles(project)).tasks;
    // The project was switched while reading: don't let its tasks or errors leak into the new one.
    if (this.host.project() !== project) return [];
    // A newer read already finished: don't roll the cached list or the warning state back.
    if (readNo < this.readDone) return this.last;
    this.readDone = readNo;
    // A new project starts with {"tasks": []}, so only a missing file means "no tasks";
    // an empty one (e.g. a failed PowerShell rewrite) is broken.
    if (!raw.trim() && !existsSync(file)) return [];
    try {
      const tasks = JSON.parse(raw).tasks;
      this.parseSince = 0;
      this.parseAnnounced = false;
      this.last = Array.isArray(tasks) ? tasks.filter((t: any) => t && typeof t.id === 'string') : [];
      return this.last;
    } catch (err) {
      // An agent may be mid-rewrite. Keep working from the last list that parsed (an empty list
      // would stop autopilot and tell agents they own nothing), and if it's still broken a few
      // seconds later, tell everyone once per broken spell.
      const msg = (err as Error).message;
      if (!this.parseSince) {
        this.parseSince = Date.now();
        setTimeout(() => void this.read(), TASKS_PARSE_GRACE_MS + 500);
      } else if (!this.parseAnnounced && Date.now() - this.parseSince >= TASKS_PARSE_GRACE_MS) {
        this.parseAnnounced = true;
        this.host.broken(file, msg);
      }
      return this.last;
    }
  }

  /**
   * Change one task in tasks.json. Edits are queued one at a time, each re-reading the latest file
   * (with a unique temp name), so two agents finishing together can't overwrite each other. `patch`
   * can be a function of the task as it is now; returning undefined leaves it alone.
   */
  update(taskId: string, patch: Partial<Task> | ((t: Task) => Partial<Task> | undefined)): Promise<boolean> {
    const project = this.host.project();
    if (!project) return Promise.resolve(false);
    const run = async (): Promise<boolean> => {
      if (this.host.project() !== project) return false;
      const file = join(project.teamDir, 'tasks.json');
      try {
        // Agents edit tasks.json too: if one saved while this edit was being written, redo it on their version.
        for (let tries = 0; ; tries++) {
          const raw = readFileSync(file);
          const data = JSON.parse(decodeText(raw));
          const t = (data.tasks ?? []).find((x: any) => x?.id === taskId);
          if (!t) return false;
          const change = typeof patch === 'function' ? patch(t) : patch;
          if (!change) return false;
          Object.assign(t, change);
          const tmp = `${file}.${process.pid}.${++this.writeSeq}.tmp`;
          await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
          if (tries < 3 && !readFileSync(file).equals(raw)) {
            await unlink(tmp).catch(() => {});
            continue;
          }
          await rename(tmp, file);
          return true;
        }
      } catch (e) {
        console.error('could not update tasks.json:', (e as Error).message);
        return false;
      }
    };
    const result = this.writes.then(run, run);
    this.writes = result;
    return result;
  }
}

// ── Dependencies and hand-offs ────────────────────────────────────────

/** The tasks this one comes "after". */
export function depsOf(t: Task): string[] {
  return Array.isArray(t.after) ? t.after.filter((d): d is string => typeof d === 'string') : [];
}

/** Ready = every task it comes "after" is accepted (done, and through review if review is on). */
export function isReady(t: Task, tasks: Task[], accepted: (t: Task) => boolean): boolean {
  return depsOf(t).every((d) => {
    const dep = tasks.find((x) => x.id === d);
    return !dep || accepted(dep);
  });
}

/** A task's hand-off note as one line (it may be a string or an object of fields). */
export function handoffText(t: Task): string {
  const h = t.handoff;
  if (!h) return '';
  if (typeof h === 'string') return h;
  if (typeof h === 'object') {
    return Object.entries(h as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join('; ');
  }
  return '';
}

/** The hand-off notes of the tasks this one depends on, for the agent picking it up. */
export function handoffsFor(t: Task, tasks: Task[], nameOf: (id: string) => string): string {
  return depsOf(t)
    .map((d) => tasks.find((x) => x.id === d))
    .filter((d): d is Task => Boolean(d))
    .map((d) => `- ${d.id} "${d.title ?? ''}" by ${nameOf(d.owner ?? '')}: ${handoffText(d) || 'no hand-off note left'}`)
    .join('\n');
}
