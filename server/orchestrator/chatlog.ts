/**
 * The team chat: team/chat.jsonl on disk holds every message ever posted (append-only, never trimmed);
 * memory holds only the newest ones. Indexes into the chat (an agent's lastSeen, a debate's
 * hideAgentsFrom) are absolute message numbers in the whole log, so dropping old messages from memory
 * never shifts them.
 */
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, open, stat } from 'node:fs/promises';
import type { ChatMessage } from '../types.js';

/** Messages kept in memory after loading or trimming. */
export const CHAT_KEEP = 1500;
/** Memory is trimmed back to CHAT_KEEP once it passes this many. */
export const CHAT_MAX = 2000;
/** Messages sent to the page at once (on connect, and per "Load earlier messages"). */
export const CHAT_PAGE = 200;

const NL = 0x0a;

/** Messages for the page, and whether older ones can be loaded. */
export interface ChatPage {
  messages: ChatMessage[];
  earlier: boolean;
}

function parseLine(line: string): ChatMessage | undefined {
  try {
    const m = JSON.parse(line);
    return m && typeof m === 'object' && typeof m.id === 'string' ? (m as ChatMessage) : undefined;
  } catch {
    return undefined; // a torn or hand-broken line: skipped, the rest of the log still loads
  }
}

export class ChatLog {
  /** The newest messages, oldest first. */
  messages: ChatMessage[] = [];
  /** Absolute number of messages[0] in the whole log (messages before it are on disk only). */
  base = 0;

  constructor(
    private keep = CHAT_KEEP,
    private max = CHAT_MAX,
  ) {}

  /** Number of messages in the whole log, in memory or not. */
  get total(): number {
    return this.base + this.messages.length;
  }

  reset(): void {
    this.messages = [];
    this.base = 0;
  }

  /**
   * Load the newest messages of `file`, streaming it (a huge log doesn't block the server or fill memory).
   * A last line cut off by a crash gets its newline, so the next message doesn't end up glued to it.
   */
  async load(file: string): Promise<void> {
    this.reset();
    if (!existsSync(file)) return;
    const size = (await stat(file)).size;
    if (size && (await lastByte(file, size)) !== NL) await appendFile(file, '\n');
    // Numbered the same way everywhere (see eachMessage): a damaged line never counts as a message.
    let count = 0;
    let tail: ChatMessage[] = [];
    await eachMessage(file, (m) => {
      count++;
      tail.push(m);
      if (tail.length > this.keep * 2) tail = tail.slice(-this.keep);
    });
    tail = tail.slice(-this.keep);
    this.base = count - tail.length;
    this.messages = tail;
  }

  /** Add a message; drops the oldest from memory (not from disk) past the cap. Returns how many were dropped. */
  push(m: ChatMessage): number {
    this.messages.push(m);
    if (this.messages.length <= this.max) return 0;
    const drop = this.messages.length - this.keep;
    this.messages = this.messages.slice(drop);
    this.base += drop;
    return drop;
  }

  /** The newest `n` messages for the page, and whether older ones exist (in memory or on disk). */
  page(n = CHAT_PAGE): { messages: ChatMessage[]; earlier: boolean } {
    return { messages: this.messages.slice(-n), earlier: this.total > n };
  }
}

/**
 * Every message in `file`, oldest first, streamed. The absolute number of a message is its position
 * in this sequence: lines that don't parse are skipped and never counted, so numbers stay the same
 * however much of the log is in memory.
 */
async function eachMessage(file: string, visit: (m: ChatMessage, index: number) => void): Promise<void> {
  let index = 0;
  let rest = '';
  const line = (l: string) => {
    if (!l.trim()) return;
    const m = parseLine(l);
    if (m) visit(m, index++);
  };
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const p of parts) line(p);
  }
  line(rest);
}

/**
 * Messages numbered [from, to) in `file` that pass `keep`, with their numbers; only the last `last` of
 * them when given. Messages that pass `also` are returned too, whatever `last` says (merged in order).
 * For turns whose context reaches back past what memory holds (see Orchestrator.earlierContext).
 */
export async function readMessageRange(
  file: string,
  from: number,
  to: number,
  keep: (m: ChatMessage, index: number) => boolean = () => true,
  last = Infinity,
  also: (m: ChatMessage, index: number) => boolean = () => false,
): Promise<(readonly [ChatMessage, number])[]> {
  if (!existsSync(file) || to <= from) return [];
  let out: (readonly [ChatMessage, number])[] = [];
  const extra: (readonly [ChatMessage, number])[] = [];
  await eachMessage(file, (m, i) => {
    if (i < from || i >= to) return;
    if (keep(m, i)) {
      out.push([m, i] as const);
      if (out.length > last * 2) out = out.slice(-last);
    } else if (also(m, i)) extra.push([m, i] as const);
  });
  const kept = Number.isFinite(last) ? out.slice(-last) : out;
  return extra.length ? [...kept, ...extra].sort((a, b) => a[1] - b[1]) : kept;
}

/**
 * How much of `line` (ending in a newline) a failed append left at the end of `file`: all of it, all but
 * the newline, or not all of it ('no': a partial line or nothing).
 */
export async function lineLanded(file: string, line: string): Promise<'all' | 'all-but-newline' | 'no'> {
  if (!existsSync(file)) return 'no';
  const want = Buffer.from(line, 'utf8');
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const tail = async (n: number) => {
      if (n > size) return Buffer.alloc(0);
      const b = Buffer.alloc(n);
      await fh.read(b, 0, n, size - n);
      return b;
    };
    if ((await tail(want.length)).equals(want)) return 'all';
    if ((await tail(want.length - 1)).equals(want.subarray(0, -1))) return 'all-but-newline';
    return 'no';
  } finally {
    await fh.close();
  }
}

async function lastByte(file: string, size: number): Promise<number> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, size - 1);
    return b[0];
  } finally {
    await fh.close();
  }
}

/**
 * Up to `n` messages that come before the message `beforeId` in `file` (the newest `n` when beforeId is
 * undefined), reading the file backwards in chunks so paging through a huge log stays cheap.
 * `earlier`: more messages exist before the ones returned. `found` false: beforeId isn't in the log.
 */
export async function readMessagesBefore(
  file: string,
  beforeId: string | undefined,
  n = CHAT_PAGE,
  chunkSize = 256 * 1024,
): Promise<{ messages: ChatMessage[]; earlier: boolean; found: boolean }> {
  if (!existsSync(file)) return { messages: [], earlier: false, found: false };
  const fh = await open(file, 'r');
  try {
    let pos = (await fh.stat()).size;
    let rest = Buffer.alloc(0); // the start of a line whose beginning is in an earlier chunk
    let found = beforeId === undefined;
    const out: ChatMessage[] = []; // newest first
    // Each complete line, newest first; returns true once done.
    const take = (line: Buffer): boolean => {
      const text = line.toString('utf8');
      if (!text.trim()) return false;
      const m = parseLine(text);
      if (!found) {
        if (m?.id === beforeId) found = true;
        return false;
      }
      if (!m) return false;
      if (out.length === n) return true; // one more exists before the page: there's earlier history
      out.push(m);
      return false;
    };
    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, pos);
      let buf = Buffer.concat([chunk, rest]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== NL) continue;
        if (take(buf.subarray(i + 1, end))) return { messages: out.reverse(), earlier: true, found };
        end = i;
      }
      rest = Buffer.from(buf.subarray(0, end));
      buf = Buffer.alloc(0);
    }
    if (rest.length && take(rest)) return { messages: out.reverse(), earlier: true, found };
    return { messages: out.reverse(), earlier: false, found };
  } finally {
    await fh.close();
  }
}
