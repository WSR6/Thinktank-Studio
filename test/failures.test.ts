import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure, failureHint, parseResetTime, type FailureKind } from '../server/failures.js';

const cases: [FailureKind, string][] = [
  // credits: the model needs paid credits on this plan
  ['credits', 'This model requires usage credits.'],
  ['credits', 'The selected model requires credits to run'],
  ['credits', 'That model is not included in your plan.'],
  ['credits', 'This model needs extra credits'],
  // limit: out of usage for now
  ['limit', 'Usage limit reached. Your limit resets at 5pm.'],
  ['limit', 'Error: 429 Too Many Requests'],
  ['limit', 'rate-limit exceeded, slow down'],
  ['limit', 'rate_limit_error'],
  ['limit', "You've hit your weekly limit"],
  ['limit', 'usage_limit_reached'],
  ['limit', 'Your credit balance is too low'],
  ['limit', 'You are out of credits. Try again in 2 hours.'],
  ['limit', 'Quota exhausted for this project'],
  // small_context: a local model server loaded with too small a window
  ['small_context', 'request (9000 tokens) exceeds the available context size (4096 tokens)'],
  ['small_context', '{"error":{"type":"exceed_context_size_error"}}'],
  // memory
  ['memory', 'CUDA error: out of memory'],
  ['memory', 'model requires more system memory (12 GiB) than is available'],
  ['memory', 'llama_init: failed to allocate buffer'],
  ['memory', 'process was killed by the OOM killer'],
  // missing_cli
  ['missing_cli', 'spawn grok ENOENT'],
  ['missing_cli', 'bash: codex: command not found'],
  ['missing_cli', "'codex' is not recognized as an internal or external command"],
  // auth
  ['auth', 'codex exited with 1: not logged in'],
  ['auth', 'Please run `grok login` first.'],
  ['auth', 'HTTP 401'],
  ['auth', 'status: 403'],
  ['auth', '401 Unauthorized'],
  ['auth', 'Invalid API key provided'],
  ['auth', 'Your token expired, sign in again'],
  ['auth', 'OAuth error: missing access_token'],
  // model
  ['model', 'The model `some-model-9` does not exist'],
  ['model', 'model some-model-9 is not supported with this account'],
  ['model', 'Unknown model: some-model-9'],
  ['model', 'error: no such model'],
  // context: the conversation got too long (the app retries with a fresh one)
  ['context', 'This request exceeds the maximum context length'],
  ['context', 'prompt is too long: 250000 tokens > 200000 maximum'],
  ['context', 'context_length_exceeded'],
  ['context', 'Input is too long for the requested model.'],
  // network
  ['network', 'connect ECONNREFUSED 127.0.0.1:1234'],
  ['network', 'getaddrinfo ENOTFOUND api.example.com'],
  ['network', 'TypeError: fetch failed'],
  ['network', '503 Service Unavailable'],
  ['network', 'The server is overloaded, try again'],
  // unknown
  ['unknown', ''],
  ['unknown', 'Something odd happened'],
  ['unknown', 'exited with code 1'],
  ['unknown', 'No conversation found with session ID: abc'],
];

for (const [kind, message] of cases) {
  test(`classifyFailure: ${kind} ← ${JSON.stringify(message)}`, () => {
    assert.equal(classifyFailure(message), kind);
  });
}

test('classifyFailure: a model that needs credits is not mistaken for a usage limit', () => {
  // Both rules could apply to a message that also says when a limit resets: credits is checked first.
  assert.equal(classifyFailure('This model requires usage credits. Your usage limit resets at 5pm.'), 'credits');
  // A plain limit message that suggests buying credits stays a limit.
  assert.equal(classifyFailure('Usage limit reached. Purchase more credits to continue.'), 'limit');
});

test('classifyFailure: numbers that only look like HTTP codes are not auth or network errors', () => {
  assert.equal(classifyFailure('listening on port 4013'), 'unknown');
  assert.equal(classifyFailure('wrote 401 lines'), 'unknown');
  assert.equal(classifyFailure('took 5021 ms'), 'unknown');
  assert.equal(classifyFailure('line 1429 failed to parse'), 'unknown');
});

test("classifyFailure: Codex's routine model-list warnings are not a bad model", () => {
  assert.equal(classifyFailure('Model metadata for `qwen3-coder` not found. Defaulting to fallback metadata.'), 'unknown');
  assert.equal(classifyFailure('failed to refresh available models: not found'), 'unknown');
});

test('classifyFailure: a too-small window on a model server is not an over-long conversation', () => {
  // small_context tells the user to reload the model; context makes the app start a fresh conversation.
  assert.equal(classifyFailure('the request exceeds the available context size, try increasing it'), 'small_context');
  assert.equal(classifyFailure('context window exceeded'), 'context');
});

test('classifyFailure: the first matching rule wins when a message fits several', () => {
  assert.equal(classifyFailure('429 rate limit: please sign in again'), 'limit');
  assert.equal(classifyFailure('spawn codex ENOENT (network drive?)'), 'missing_cli');
  assert.equal(classifyFailure('401 Unauthorized while contacting the network'), 'auth');
});

test('failureHint gives a next step for every known kind and nothing for unknown', () => {
  const kinds: FailureKind[] = ['credits', 'limit', 'memory', 'small_context', 'auth', 'model', 'missing_cli', 'context', 'network'];
  for (const k of kinds) assert.match(failureHint(k, 'Agent One', 'codex'), /\S/, k);
  assert.equal(failureHint('unknown', 'Agent One', 'codex'), '');
});

test('failureHint names the right login command', () => {
  assert.match(failureHint('auth', 'Agent One', 'grok'), /`grok login`/);
  assert.match(failureHint('auth', 'Agent Two', 'hermes'), /`hermes model`/);
});

test('failureHint: a memory failure blames the model server only when the agent uses one', () => {
  assert.match(failureHint('memory', 'Local', 'codex', 'some-local-model'), /model server \(running some-local-model\)/);
  assert.match(failureHint('memory', 'Agent One', 'claude'), /Agent One's program ran out of memory/);
});

// ── parseResetTime ──────────────────────────────────────────────────────

/** A fixed "now" in local time: Wednesday 3 June 2026, 14:00. */
const NOW = new Date(2026, 5, 3, 14, 0, 0, 0).getTime();
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();

test('parseResetTime: a Unix timestamp after "limit reached|"', () => {
  assert.equal(parseResetTime('Usage limit reached|1761300000', NOW), 1761300000 * 1000);
});

test('parseResetTime: relative times', () => {
  assert.equal(parseResetTime('resets in 2h 30m', NOW), NOW + 150 * 60_000);
  assert.equal(parseResetTime('Try again in 2 hours 30 minutes.', NOW), NOW + 150 * 60_000);
  assert.equal(parseResetTime('try again in 45 seconds', NOW), NOW + 45_000);
  assert.equal(parseResetTime('available in 1 day, 2 hours and 5 min', NOW), NOW + 86_400_000 + 2 * 3_600_000 + 5 * 60_000);
});

test('parseResetTime: a clock time means the next time it comes round', () => {
  assert.equal(parseResetTime('Your limit resets at 5pm.', NOW), local(2026, 5, 3, 17));
  // 9am has passed today: tomorrow.
  assert.equal(parseResetTime('resets at 9am', NOW), local(2026, 5, 4, 9));
  assert.equal(parseResetTime('try again at 10:10 PM', NOW), local(2026, 5, 3, 22, 10));
  assert.equal(parseResetTime('resets at 12:00am', NOW), local(2026, 5, 4, 0));
  assert.equal(parseResetTime('resets at 12pm', NOW), local(2026, 5, 4, 12));
  // 24-hour clock without am/pm.
  assert.equal(parseResetTime('blocked until 16:30', NOW), local(2026, 5, 3, 16, 30));
});

test('parseResetTime: a weekday rolls forward to that day', () => {
  // NOW is a Wednesday.
  assert.equal(parseResetTime('resets Mon 12:00am', NOW), local(2026, 5, 8, 0));
  assert.equal(parseResetTime('resets Thursday at 3:16 AM', NOW), local(2026, 5, 4, 3, 16));
  // Today's weekday at a time already past: next week.
  assert.equal(parseResetTime('resets Wed 9am', NOW), local(2026, 5, 10, 9));
  assert.equal(parseResetTime('resets Wed 5pm', NOW), local(2026, 5, 3, 17));
});

test('parseResetTime: a full date', () => {
  assert.equal(parseResetTime('try again at Oct 24th, 2026 3:16 AM', NOW), local(2026, 9, 24, 3, 16));
  // No year: this year, or next year when that date is well past.
  assert.equal(parseResetTime('resets Jun 20 at 5pm', NOW), local(2026, 5, 20, 17));
  assert.equal(parseResetTime('resets Jan 5 at 5pm', NOW), local(2027, 0, 5, 17));
});

test('parseResetTime: undefined when the message has no time', () => {
  assert.equal(parseResetTime('Usage limit reached.', NOW), undefined);
  assert.equal(parseResetTime('', NOW), undefined);
  assert.equal(parseResetTime('resets soon', NOW), undefined);
});

test('parseResetTime: a clock time equal to now means the next day', () => {
  assert.equal(parseResetTime('resets at 2pm', NOW), local(2026, 5, 4, 14));
  assert.equal(parseResetTime('resets at 14:00', NOW), local(2026, 5, 4, 14));
  assert.equal(parseResetTime('resets at 2:01pm', NOW), local(2026, 5, 3, 14, 1));
});

test('parseResetTime: a date without a year stays this year until it is more than a day old', () => {
  // Five hours ago: kept as it is (already past, so the agent is simply back).
  assert.equal(parseResetTime('resets Jun 3 at 9am', NOW), local(2026, 5, 3, 9));
  // More than a day ago: it must mean next year.
  assert.equal(parseResetTime('resets Jun 1 at 9am', NOW), local(2027, 5, 1, 9));
  // With the year written out it is never moved.
  assert.equal(parseResetTime('resets Jun 1, 2026 at 9am', NOW), local(2026, 5, 1, 9));
});
