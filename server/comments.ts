import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Line comments on an agent's branch diff, kept in team/comments.json. You (or a reviewer agent via
 * [[comment: path:line]]) pin a comment to a line; "Send to builder" batches the open ones into one
 * message. Comments not marked resolved go again with the next batch, so nothing is silently dropped.
 */

export interface LineComment {
  id: string;
  /** Whose branch (agent id). */
  agent: string;
  file: string;
  /** Line number in the new version of the file ('new'), or in the old one for a removed line ('old'). */
  line: number;
  side: 'new' | 'old';
  /** The line's text when commented, so the builder sees what it refers to even after edits. */
  lineText: string;
  text: string;
  /** 'user' or the reviewer agent's id. */
  by: string;
  /** open: not sent yet · sent: waiting for the builder · resolved: done (by you or the builder's [[fixed:]]). */
  status: 'open' | 'sent' | 'resolved';
  /** How many times it has been sent. */
  rounds: number;
  at: number;
}

export function loadComments(teamDir: string): LineComment[] {
  const file = join(teamDir, 'comments.json');
  try {
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    return Array.isArray(data) ? data.filter((c) => c && typeof c.id === 'string') : [];
  } catch {
    return [];
  }
}

let writing: Promise<void> = Promise.resolve();
export function saveComments(teamDir: string, comments: LineComment[]): Promise<void> {
  const file = join(teamDir, 'comments.json');
  const data = JSON.stringify(comments, null, 2);
  writing = writing
    .then(async () => {
      await writeFile(file + '.tmp', data);
      await rename(file + '.tmp', file);
    })
    .catch(console.error);
  return writing;
}

/** "[[comment: src/api/x.ts:42]] text" lines in a reviewer's reply. */
export const COMMENT_RE = /\[\[\s*comment\s*:\s*([^\]\s:]+(?:[^\]:]*[^\]\s:])?)\s*:\s*(\d+)\s*\]\]\s*([^\n]*)/gi;
/** "[[fixed: c3, c5]]" from the builder: the comments it dealt with. */
export const FIXED_RE = /\[\[\s*fixed\s*:\s*([^\]]+)\]\]/gi;
