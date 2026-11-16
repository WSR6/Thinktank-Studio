/**
 * Turn a CLI's raw failure text into a kind plus a plain-language next step, so the user sees
 * "Grok isn't logged in: run `grok login`" instead of a stack trace, and the app can decide
 * whether a retry could help (only for a lost session or an over-long conversation).
 */

export type FailureKind = 'credits' | 'limit' | 'memory' | 'small_context' | 'auth' | 'model' | 'missing_cli' | 'context' | 'network' | 'unknown';

const RULES: { kind: FailureKind; re: RegExp }[] = [
  // A model your plan only runs on paid credits ("Fable 5.1 requires usage credits"). Before 'limit':
  // a plain limit message may say "purchase more credits", which this doesn't match.
  { kind: 'credits', re: /requires (?:usage |paid |extra )?credits|needs? (?:usage |paid |extra )credits|not included in your (?:plan|subscription)/i },
  {
    kind: 'limit',
    re: /usage limit|rate.?limit|quota|\b429\b|too many requests|limit (?:reached|exceeded)|hit your (?:\w+ )?limit|(?:weekly|daily|monthly|hourly) limit|usage_limit_reached|usage_pool_exhausted|credit balance|out of credits|resets? (?:at|in)/i,
  },
  // A model server (LM Studio, Ollama, llama.cpp) that ran out of RAM or GPU memory for the model and its context.
  // A model server whose context window can't even hold Codex's own instructions (LM Studio, llama.cpp).
  { kind: 'small_context', re: /exceeds the available context size|exceed_context_size|context size has been exceeded/i },
  { kind: 'memory', re: /out of memory|insufficient memory|requires more system memory|OutOfMemory|\bOOM\b|failed to allocate|cudaMalloc failed/i },
  { kind: 'missing_cli', re: /\bENOENT\b|command not found|is not recognized as an internal or external command|not installed/i },
  { kind: 'auth', re: /not logged in|log ?in (?:first|again|required)|please run .*login|\/login|unauthori[sz]ed|(?:HTTP|status|code|error)\W{0,3}40[13]\b|\b40[13]\W{0,3}(?:Unauthorized|Forbidden)|invalid (?:api )?key|authentication|expired token|token (?:expired|revoked)|sign in|re-?authenticate|missing access_token|credentials or agent init failed/i },
  { kind: 'model', re: /(?<!available )model(?! metadata)[^\n]{0,60}(?:not found|does not exist|not available|not supported|unknown|invalid)|(?:unknown|invalid|unsupported) model|no such model/i },
  { kind: 'context', re: /context (?:length|window)|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long/i },
  { kind: 'network', re: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up|fetch failed|service unavailable|\b50[234]\b|overloaded/i },
];

export function classifyFailure(message: string): FailureKind {
  return RULES.find((r) => r.re.test(message))?.kind ?? 'unknown';
}

/** One sentence the user can act on. `command` is the CLI name (claude, codex, grok). */
export function failureHint(kind: FailureKind, name: string, command: string, model?: string): string {
  // The agent's name may be older than its model (an agent named after a model you since switched).
  // Only agents on a model server pass `model`; anyone else's memory failure is about its own program.
  const server = model ? `${name}'s model server (running ${model})` : `${name}'s program`;
  switch (kind) {
    case 'credits':
      return `${name}'s chosen model needs paid usage credits on your plan, so its turn didn't run. Pick another model in its Model box.`;
    case 'limit':
      return `${name} hit a usage limit. Wait for it to reset, or switch to another saved setup.`;
    case 'small_context':
      return `${server} has too small a context window for the request. In the server's app (LM Studio, Ollama…) reload the model with a context length of 32k or more, then send the message again.`;
    case 'memory':
      return model
        ? `${server} ran out of memory. In the server's app (LM Studio, Ollama…) load a smaller model, give it a shorter context, or let it run 1 request at a time, then send the message again.`
        : `${server} ran out of memory. Close other heavy programs, then send the message again.`;
    case 'auth':
      return `${name} isn't signed in (or its login expired). In a terminal run \`${command === 'hermes' ? 'hermes model' : `${command} login`}\` (or open \`${command}\` once), then try again.`;
    case 'model':
      return `${name} doesn't recognize the chosen model. Pick another in its Model box, or clear it to use the default.`;
    case 'missing_cli':
      return `The \`${command}\` command isn't installed or isn't on your PATH. Install it, or fix "command" in agents.config.json.`;
    case 'context':
      return `${name}'s conversation got too long, so it's starting a fresh one with the recent chat.`;
    case 'network':
      return `${name} couldn't reach its service (network or provider outage). Try again in a minute.`;
    default:
      return '';
  }
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';

/**
 * When a usage limit lifts, from the CLI's message, as a timestamp. Understands e.g.
 * "try again at Oct 24th, 2026 3:16 AM", "try again at 10:10 PM", "resets at 5pm", "resets in 2h 30m".
 * A clock time without a date means the next time it comes round. Undefined when there's no time.
 */
export function parseResetTime(message: string, now = Date.now()): number | undefined {
  // Claude Code: "Claude AI usage limit reached|1761300000" (the reset time in Unix seconds).
  const unix = message.match(/limit reached\|(\d{10})\b/i);
  if (unix) return Number(unix[1]) * 1000;
  // Longer unit names first, each ending at a word boundary: "2 hours 30 minutes" and "2h 30m" both work.
  const rel = message.match(/\b(?:resets?|try again|available)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b\s*,?\s*(?:and\s+)?)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi)) {
      const k = u.toLowerCase();
      ms += Number(n) * (k.startsWith('d') ? 86_400_000 : k.startsWith('h') ? 3_600_000 : k.startsWith('s') ? 1000 : 60_000);
    }
    if (ms) return now + ms;
  }
  const dated = message.match(new RegExp(`\\b((?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?,?\\s*(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)?`, 'i'));
  if (dated) {
    const year = dated[2] ?? String(new Date(now).getFullYear());
    const t = Date.parse(`${dated[1]}, ${year} ${clock(dated[3], dated[4], dated[5])}`);
    if (!Number.isNaN(t)) return t < now - 86_400_000 && !dated[2] ? Date.parse(`${dated[1]}, ${Number(year) + 1} ${clock(dated[3], dated[4], dated[5])}`) : t;
  }
  // Optional weekday ("resets Mon 12:00am", "resets Thursday at 3:16 AM"): roll forward to that day.
  const DAY = '(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?\\s+)?(?:at\\s+)?';
  const time =
    message.match(new RegExp(`\\b(?:at|until|resets?)\\s+${DAY}(\\d{1,2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)`, 'i')) ??
    message.match(new RegExp(`\\b(?:at|until|resets?)\\s+${DAY}(\\d{1,2}):(\\d{2})\\b()`, 'i'));
  if (time) {
    const d = new Date(now);
    const [h, m] = to24(time[2], time[3], time[4]);
    d.setHours(h, m, 0, 0);
    if (time[1]) {
      const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(time[1].toLowerCase());
      d.setDate(d.getDate() + ((want - d.getDay() + 7) % 7));
      if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    } else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return undefined;
}

function to24(h: string, m: string | undefined, ampm: string | undefined): [number, number] {
  let hour = Number(h) % 24;
  const pm = /^p/i.test(ampm ?? '');
  if (ampm) hour = (hour % 12) + (pm ? 12 : 0);
  return [hour, Number(m ?? 0)];
}

function clock(h: string, m: string | undefined, ampm: string | undefined): string {
  const [hour, min] = to24(h, m, ampm);
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
