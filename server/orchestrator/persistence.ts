/** Reading and writing the project's state files under team/ (best effort, never throwing on bad data). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listProjects, projectsRoot } from '../project.js';
import type { ChatMessage } from '../types.js';

/** A JSON file's content, or {} when it's missing or doesn't parse. */
export function readJson(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** One JSON value per line; lines that don't parse are skipped. */
export function readJsonl(path: string): ChatMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ChatMessage];
      } catch {
        return [];
      }
    });
}

/** Write via a temp file and rename, so a reader never sees a torn file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await writeFile(file + '.tmp', text);
  await rename(file + '.tmp', file);
}

/**
 * An agent's program changed: its conversations in the other projects belong to the old program, so
 * drop them (and the old model, for another kind of program). Best effort; a project that can't be
 * read is left alone and its fingerprint check catches it on open.
 */
export async function forgetSessionsElsewhere(currentProject: string | undefined, changed: { id: string; adapterChanged: boolean }[]): Promise<void> {
  for (const name of await listProjects().catch(() => [] as string[])) {
    if (name === currentProject) continue;
    const file = join(projectsRoot(), name, 'team', 'session.json');
    try {
      if (!existsSync(file)) continue;
      const meta = JSON.parse(readFileSync(file, 'utf8'));
      let dirty = false;
      for (const c of changed) {
        const s = meta.agents?.[c.id];
        if (!s) continue;
        delete s.sessionId;
        delete s.program;
        delete s.outUntil;
        if (c.adapterChanged) delete s.settings;
        dirty = true;
      }
      if (dirty) writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
    } catch (e) {
      console.error(`Couldn't update ${file}: ${(e as Error).message}`);
    }
  }
}
