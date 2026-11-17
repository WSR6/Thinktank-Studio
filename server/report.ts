/**
 * Errors that matter but don't stop anything (a save that failed, a review step that threw): always
 * logged, and told to the user in the chat at most once per kind every few minutes, so a disk that
 * stays full doesn't flood the chat but a problem never goes unnoticed.
 */

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class Reporter {
  private told = new Map<string, number>();

  constructor(
    private tell: (text: string) => void,
    private quietMs = 10 * 60_000,
    private now: () => number = Date.now,
  ) {}

  /**
   * Log `e` under `key`; when `text` is given, also tell the user (text + the error) unless this key
   * was told within the quiet period. Returns whether the user was told.
   */
  report(key: string, e: unknown, text?: string): boolean {
    console.error(`${key}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    if (!text) return false;
    const last = this.told.get(key);
    if (last !== undefined && this.now() - last < this.quietMs) return false;
    this.told.set(key, this.now());
    this.tell(`⚠ ${text} (${errText(e)})`);
    return true;
  }

  /** A `.catch` handler that reports under `key`. */
  catcher(key: string, text?: string): (e: unknown) => void {
    return (e) => void this.report(key, e, text);
  }
}

/** For modules without a reporter: log once per key per process, so a repeating failure doesn't flood the log. */
const loggedOnce = new Set<string>();
export function logOnce(key: string, e: unknown): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.error(`${key} (further errors of this kind aren't logged): ${errText(e)}`);
}
