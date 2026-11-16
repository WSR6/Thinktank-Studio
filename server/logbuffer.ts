/**
 * Keeps the last few hundred lines the server printed, so the App helper can see what went wrong
 * without the user copying logs around. Wraps console.* and records uncaught errors.
 */
const MAX_LINES = 400;
const lines: string[] = [];
let total = 0;

function record(level: string, args: unknown[]): void {
  const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  for (const line of text.split('\n')) {
    lines.push(`${new Date().toISOString().slice(11, 19)} ${level} ${line}`);
    total++;
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function captureConsole(): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level === 'log' ? 'info' : level, args);
      orig(...args);
    };
  }
  // Record, then exit as Node would without a listener: a half-broken server is worse than a restart,
  // and the supervisor uses the crash to roll back a bad update.
  const fatal = (kind: string) => (err: unknown) => {
    console.error(`${kind}:`, err);
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled rejection'));
}

/** Lines printed since `since` (a value from a previous call), capped at `max`. */
export function logsSince(since: number, max = 80): { lines: string[]; cursor: number } {
  const available = Math.min(total - since, lines.length);
  return { lines: available > 0 ? lines.slice(-available).slice(-max) : [], cursor: total };
}
