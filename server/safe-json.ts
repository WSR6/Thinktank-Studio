/**
 * Reading the app's saved JSON files without silently losing them. A file that won't parse (or has
 * the wrong shape) is renamed to <name>.corrupt-<time>, so nothing is lost and the next save can't
 * overwrite it; the caller starts clean and tells the user once, with the message this returns.
 * If the file can't be read, or can't be moved or copied aside, it is protected instead: the app's
 * writers check mayWrite() and leave it alone until a later read succeeds.
 */
import { constants, copyFileSync, existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const decode = (buf: Buffer): string => {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
};

export interface Loaded<T> {
  value: T;
  /** Set when the file was broken: a plain sentence for the user saying what happened. */
  problem?: string;
}

/** A filesystem-safe timestamp, e.g. 2026-11-17T10-42-05. */
export const stamp = (d = new Date()): string => d.toISOString().slice(0, 19).replace(/:/g, '-');

/** Files the app must not write: damaged or unreadable, and nothing of them could be kept aside. */
const protectedPaths = new Set<string>();
const key = (path: string) => path.toLowerCase();

/** Stop the app's writers from saving over `path` (no copy of it could be kept); a later good read lifts it. */
export function protect(path: string): void {
  protectedPaths.add(key(path));
}

/** False while `path` is protected (see above); writers skip it and log why. */
export function mayWrite(path: string): boolean {
  if (!protectedPaths.has(key(path))) return true;
  console.warn(`Not saving ${path}: it's damaged or unreadable and no copy of it could be kept.`);
  return false;
}

/** A unique, unused <path>.corrupt-<time>[-n] name. */
function corruptName(path: string): string {
  let to = `${path}.corrupt-${stamp()}`;
  for (let i = 2; existsSync(to); i++) to = `${path}.corrupt-${stamp()}-${i}`;
  return to;
}

/**
 * Copy `path` to a new <path>.corrupt-<time> (never over an existing file). An existing copy with the
 * same bytes is reused, so a file that stays broken isn't copied again on every start. Returns the
 * copy's file name, or undefined when no copy could be made.
 */
export function copyAside(path: string): string | undefined {
  try {
    const bytes = readFileSync(path);
    const dir = dirname(path);
    const prefix = `${basename(path)}.corrupt-`;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && readFileSync(join(dir, f)).equals(bytes)) return f;
    }
    for (let tries = 0; tries < 100; tries++) {
      const to = corruptName(path);
      try {
        copyFileSync(path, to, constants.COPYFILE_EXCL);
        return basename(to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  } catch (e) {
    console.error(`Couldn't keep a copy of ${path}: ${(e as Error).message}`);
  }
  return undefined;
}

/** Move a broken file out of the way (or, if it can't be moved, copy it). Returns the kept name, or undefined if both failed. */
export function quarantine(path: string): string | undefined {
  const to = corruptName(path);
  try {
    renameSync(path, to);
    return basename(to);
  } catch (e) {
    console.error(`Couldn't move broken ${path} aside: ${(e as Error).message}`);
    return copyAside(path);
  }
}

/**
 * The parsed content of `path`, or `fallback` when it's missing. When it doesn't parse, or `valid`
 * rejects it, the file is moved aside (see quarantine) and `problem` says so. `label` names the file
 * in that message (e.g. "team/reviews.json"); `what` says what starting clean means for the user.
 */
export function loadJsonFile<T>(
  path: string,
  fallback: T,
  o: { label: string; what: string; valid?: (v: unknown) => boolean },
): Loaded<T> {
  if (!existsSync(path)) {
    protectedPaths.delete(key(path));
    return { value: fallback };
  }
  let reason: string;
  try {
    const v = JSON.parse(decode(readFileSync(path)));
    if (!o.valid || o.valid(v)) {
      protectedPaths.delete(key(path));
      return { value: v as T };
    }
    reason = "it doesn't have the expected layout";
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // Can't read it at all (locked, no permission): leave it alone, and don't save over it.
    if (err.code) {
      console.error(`Couldn't read ${path}: ${err.message}`);
      protectedPaths.add(key(path));
      return {
        value: fallback,
        problem: `${o.label} couldn't be read (${err.code}), so ${o.what} for now. The app won't save over it; restart the app once it can be read again.`,
      };
    }
    reason = "it isn't valid JSON";
  }
  const kept = quarantine(path);
  console.error(`${path}: ${reason}; ${kept ? `kept as ${kept}` : 'left in place'}`);
  if (!kept) protectedPaths.add(key(path));
  return {
    value: fallback,
    problem: kept
      ? `${o.label} was damaged (${reason}), so ${o.what}. The damaged copy is kept as ${kept} next to it.`
      : `${o.label} was damaged (${reason}), so ${o.what}. It couldn't be moved or copied aside, so the app won't save over it; fix or delete it, then restart the app.`,
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
