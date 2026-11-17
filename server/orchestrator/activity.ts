/**
 * Recent activity per agent (tool calls, CLI output, turn start/end/failure), kept in memory and in
 * team/activity/<id>.jsonl so the panels survive a reload and the App helper can see what happened.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, AgentStatus } from '../types.js';
import { readJsonl } from './persistence.js';
import { logOnce } from '../report.js';
import { ACTIVITY_KEEP, type ActivityLine } from './types.js';

export class ActivityLog {
  private lines = new Map<string, ActivityLine[]>();
  /** Lines ever recorded per agent; lets the helper ask for "what's new since last time". */
  private totals = new Map<string, number>();

  /** Add one event to an agent's activity (and to its file, when a project is open). */
  record(teamDir: string | undefined, agentId: string, event: AgentEvent): void {
    if (event.kind === 'limits' || event.kind === 'session') return;
    const text =
      event.kind === 'status'
        ? { working: '── turn started ──', idle: '── turn finished ──', error: '── turn ended with an error ──' }[event.status]
        : event.kind === 'tool'
          ? `▸ ${event.name} ${event.detail}`
          : event.text.trim();
    if (!text) return;
    const line: ActivityLine = { ts: Date.now(), kind: event.kind, text: text.length > 2000 ? text.slice(0, 2000) + '…' : text };
    const buf = this.lines.get(agentId) ?? [];
    buf.push(line);
    if (buf.length > ACTIVITY_KEEP) buf.splice(0, buf.length - ACTIVITY_KEEP);
    this.lines.set(agentId, buf);
    this.totals.set(agentId, (this.totals.get(agentId) ?? 0) + 1);
    if (teamDir) {
      // Kept in memory either way; the file only brings the panels back after a restart.
      appendFile(join(teamDir, 'activity', `${agentId}.jsonl`), JSON.stringify(line) + '\n').catch((e) => logOnce(`activity log ${agentId}`, e));
    }
  }

  /** Replace what's in memory with the project's saved activity for these agents. */
  load(teamDir: string, agentIds: Iterable<string>): void {
    this.lines.clear();
    this.totals.clear();
    const dir = join(teamDir, 'activity');
    mkdirSync(dir, { recursive: true });
    for (const id of agentIds) {
      const file = join(dir, `${id}.jsonl`);
      if (!existsSync(file)) continue;
      const lines = readJsonl(file) as unknown as ActivityLine[];
      const keep = lines.slice(-ACTIVITY_KEEP);
      // Trim the file now and then so it doesn't grow forever.
      if (statSync(file).size > 2_000_000) writeFileSync(file, keep.map((l) => JSON.stringify(l)).join('\n') + '\n');
      this.lines.set(id, keep);
      this.totals.set(id, keep.length);
    }
  }

  /** Last `n` activity lines per agent (for the panels after a reload). */
  history(agentIds: Iterable<string>, n = 200): Record<string, ActivityLine[]> {
    return Object.fromEntries([...agentIds].map((id) => [id, (this.lines.get(id) ?? []).slice(-n)]));
  }

  /**
   * Activity since the cursors from a previous call (or the last `firstTime` lines per agent),
   * as readable text for the App helper. Returns the new cursors.
   */
  since(
    agents: { id: string; name: string; status: AgentStatus }[],
    cursors: Record<string, number> | undefined,
    firstTime = 25,
    max = 40,
  ): { text: string; cursors: Record<string, number> } {
    const sections: string[] = [];
    const next: Record<string, number> = {};
    for (const { id, name, status } of agents) {
      const total = this.totals.get(id) ?? 0;
      next[id] = total;
      const buf = this.lines.get(id) ?? [];
      const fresh = cursors === undefined ? firstTime : Math.min(total - (cursors[id] ?? 0), buf.length);
      const lines = fresh > 0 ? buf.slice(-fresh).slice(-max) : [];
      if (!lines.length) continue;
      const time = (ts: number) => new Date(ts).toISOString().slice(11, 19);
      sections.push(`### ${name} (${status})\n${lines.map((l) => `${time(l.ts)} ${l.text.replace(/\n/g, ' ⏎ ').slice(0, 400)}`).join('\n')}`);
    }
    return { text: sections.join('\n\n'), cursors: next };
  }
}
