/**
 * The [[…]] markers and @mentions agents write in their replies, and the pure functions that read them.
 * Nothing here touches the orchestrator's state.
 */
import type { ReviewEntry } from '../reviews.js';

/** Leader asks for a gated action by ending a reply with e.g. [[phase: build]] or [[merge: codex]]. */
export const REQUEST_RE = /\[\[\s*(phase|merge)\s*:\s*([a-z0-9_-]+)\s*\]\]/gi;
/** @mention not preceded by a word char or '.', so e-mail addresses don't trigger hand-offs. */
export const MENTION_RE = /(?<![\w.])@([A-Za-z0-9_-]+)/g;
/** An agent with nothing new to add replies just this; it isn't posted to the chat. */
export const PASS_RE = /^\s*(?:\[\[\s*pass\s*\]\]|pass\.?)\s*$/i;
/** A reply that starts with [[to: grok]] goes privately to that teammate (you still see it). */
/** "[[done: t3#2 | done | summary]]": a builder reports a task finished, blocked or partly done. */
export const DONE_RE = /\[\[\s*done\s*:\s*([\w.-]+)(?:\s*#\s*(\d+))?\s*\|\s*(done|blocked|partial)\s*(?:\|\s*([^\]]*?))?\s*\]\]/gi;
/** "[[options: A | B | C]]" with an @user question: shown as buttons on the needs-you banner. */
export const OPTIONS_RE = /\[\[\s*options\s*:\s*([^\]]+)\]\]/i;
export const DM_RE = /^\s*\[\[\s*to\s*:\s*@?([a-z0-9_-]+)\s*\]\]\s*/i;
/** "[[ask: codex]] question": ask a teammate and get its answer in your next turn. */
export const ASK_RE = /^\s*\[\[\s*ask\s*:\s*@?([a-z0-9_-]+)\s*\]\]\s*/i;
/** @user in a reply means "I need the user": flagged with a "needs you" badge. */
export const USER_RE = /(?<![\w.])@user\b/i;

/** Which stage and round a review is at, to tell whether a verdict is about the stage still open. */
export const reviewKey = (e: ReviewEntry) => `${e.rounds}:${e.stage}`;

/** The text mentions this task id as a whole word (t1 doesn't match t10). */
export function namesTask(text: string, taskId: string): boolean {
  return new RegExp(`(?<![\\w-])${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
}

/** This agent already approved a stage of the task since it was last sent back (one pair of eyes per stage). */
export function approvedThisRound(e: ReviewEntry, id: string): boolean {
  const from = Math.max(e.history.map((h) => h.verdict).lastIndexOf('changes') + 1, e.roundStart ?? 0);
  return e.history.slice(from).some((h) => h.by === id && h.verdict === 'approve');
}

/** Keep the verdict and its task together, so prose about other tasks can't redirect it. */
export function reviewVerdict(text: string, anywhere = false): { verdict?: 'approve' | 'changes'; taskId?: string } {
  // A line with both markers is a quote of the review instructions ("[[verdict: approve]] … or [[verdict: changes]]"), not a verdict.
  const lines = text.split('\n').filter((l) => !(/\[\[\s*verdict\s*:\s*approve/i.test(l) && /\[\[\s*verdict\s*:\s*changes/i.test(l)));
  const explicit = /\[\[\s*verdict\s*:\s*(approve|changes)(?:\s*(?:\|\s*|\s+)(t\d+)(?:\s*#\s*\d+)?)?\s*\]\]/gi;
  const all = [...lines.join('\n').matchAll(explicit)];
  // An explicit verdict always wins, even if a done marker appears later.
  const tail = lines.slice(-6).join('\n');
  const scope = anywhere ? lines.join('\n') : tail;
  const match = anywhere ? all.at(-1) : [...tail.matchAll(explicit)].at(-1);
  if (match) return { verdict: match[1].toLowerCase() as 'approve' | 'changes', taskId: match[2]?.toLowerCase() };
  const done = [...scope.matchAll(/\[\[\s*done\s*:\s*(t\d+)(?:\s*#\s*\d+)?\s*\|\s*(approved?|lgtm|changes|send\s+back|needs\s+changes)\b[^\]]*\]\]/gi)].at(-1);
  if (!done) return {};
  return { verdict: /^(?:approved?|lgtm)$/i.test(done[2]) ? 'approve' : 'changes', taskId: done[1].toLowerCase() };
}

/** The agent ids @mentioned in the text (lower-cased, each once, in order), keeping only `isAgent` ones. */
export function findMentions(text: string, isAgent: (id: string) => boolean): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const id = m[1].toLowerCase();
    if (isAgent(id)) found.add(id);
  }
  return [...found];
}

/**
 * Teammates a reply hands work to. A line counts when it asks them something ("@codex can you…?")
 * or is addressed to them ("@grok please run the tests"). A name in a list or a plan ("t2 (@codex)")
 * doesn't. `busyWithTasks(id)`: in BUILD with autopilot, an agent working through its own tasks gets
 * turns anyway, so a line addressed to it ("@grok the CLI is ready") only counts if it's a question.
 */
export function handoffTargets(from: string, text: string, isAgent: (id: string) => boolean, busyWithTasks: (id: string) => boolean): string[] {
  const found = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const ids = findMentions(line, isAgent).filter((t) => t !== from);
    if (!ids.length) continue;
    const question = line.includes('?');
    const listItem = /^([-*•]|\d+[.)])\s/.test(line);
    const addressed = !listItem && /^@[\w-]+\b/.test(line);
    for (const id of ids) if (question || (addressed && !busyWithTasks(id))) found.add(id);
  }
  return [...found];
}

/**
 * An @user reply as a "needs you" question: the line with @user (and the line before it, if that's
 * where the "?" is), not the whole reply; plus up to six [[options: …]] choices.
 */
export function parseNeedsYou(text: string): { question: string; options?: string[] } {
  const options = text
    .match(OPTIONS_RE)?.[1]
    .split('|')
    .map((o) => o.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 6);
  const lines = text.replace(OPTIONS_RE, '').trim().split('\n');
  const at = lines.findIndex((l) => /@user\b/i.test(l));
  const before = at > 0 && !lines[at].includes('?') && /\?\s*$/.test(lines[at - 1]) ? lines[at - 1] + '\n' : '';
  const question = (at < 0 ? lines.join('\n') : before + lines[at]).trim();
  return { question, options };
}
