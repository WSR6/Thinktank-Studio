import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeText } from './project.js';

/**
 * Rotating backups of the team's state files (team/backups/<name>.1 is the newest of KEEP), taken when a
 * project opens. A file that won't parse is restored from the newest backup that does, so a torn or
 * hand-broken session.json doesn't silently reset every setting.
 */
const KEEP = 3;

const parses = (path: string): boolean => {
  try {
    JSON.parse(decodeText(readFileSync(path)));
    return true;
  } catch {
    return false;
  }
};

/** Back up each file that parses, unless it's identical to the newest backup. Never throws. */
export function backupTeamFiles(teamDir: string, names: string[]): void {
  const dir = join(teamDir, 'backups');
  for (const name of names) {
    try {
      const file = join(teamDir, name);
      if (!existsSync(file) || !parses(file)) continue;
      const newest = join(dir, `${name}.1`);
      if (existsSync(newest) && readFileSync(newest).equals(readFileSync(file))) continue;
      mkdirSync(dir, { recursive: true });
      for (let i = KEEP - 1; i >= 1; i--) {
        const from = join(dir, `${name}.${i}`);
        if (existsSync(from)) renameSync(from, join(dir, `${name}.${i + 1}`));
      }
      copyFileSync(file, newest);
    } catch (e) {
      console.error(`backup of ${name} failed:`, (e as Error).message);
    }
  }
}

/**
 * When `name` exists but won't parse, put the newest backup that parses in its place (the broken file is
 * kept as <name>.broken-<time>). Returns the backup used, or undefined when nothing was restored.
 */
export function restoreIfBroken(teamDir: string, name: string): string | undefined {
  const file = join(teamDir, name);
  if (!existsSync(file) || parses(file)) return undefined;
  for (let i = 1; i <= KEEP; i++) {
    const backup = join(teamDir, 'backups', `${name}.${i}`);
    if (!existsSync(backup) || !parses(backup)) continue;
    try {
      // Keep the broken copy, then swap the backup in whole (tmp + rename), so a failure leaves the original.
      copyFileSync(file, `${file}.broken-${Date.now()}`);
      writeFileSync(`${file}.restore`, readFileSync(backup));
      renameSync(`${file}.restore`, file);
      return `backups/${name}.${i}`;
    } catch (e) {
      console.error(`restoring ${name} from ${backup} failed:`, (e as Error).message);
    }
  }
  return undefined;
}
