import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userWindowsSandbox } from '../server/agents/codex.js';

// Every call passes the settings text: with no argument the function reads the real Codex config.
const sandbox = (...lines: string[]) => userWindowsSandbox(lines.join('\n'));

test('[windows] sandbox = "…"', () => {
  assert.equal(sandbox('[windows]', 'sandbox = "elevated"'), 'elevated');
  assert.equal(sandbox('model = "x"', '', '[windows]', 'other = 1', 'sandbox = "unelevated"'), 'unelevated');
});

test('nothing set', () => {
  assert.equal(userWindowsSandbox(''), undefined);
  assert.equal(sandbox('model = "x"', '[features]', 'fast = true'), undefined);
  assert.equal(sandbox('[windows]'), undefined);
  assert.equal(sandbox('[windows]', 'other = "elevated"'), undefined);
});

test('the value may use single quotes, and the key may be quoted', () => {
  assert.equal(sandbox('[windows]', "sandbox = 'elevated'"), 'elevated');
  assert.equal(sandbox('[windows]', '"sandbox" = "elevated"'), 'elevated');
  assert.equal(sandbox('[windows]', "'sandbox'='read-only'"), 'read-only');
  assert.equal(sandbox('[windows]', '  sandbox\t=\t"with_underscore"  '), 'with_underscore');
});

test('a comment after the value or the header is ignored', () => {
  assert.equal(sandbox('[windows] # my Windows settings', 'sandbox = "elevated" # needs admin once'), 'elevated');
  assert.equal(sandbox('[windows]#x', 'sandbox = "elevated"'), 'elevated');
  // A comment with brackets and quotes in it.
  assert.equal(sandbox('[windows] # see ["docs"] [here]', 'sandbox = "elevated"'), 'elevated');
});

test('a commented-out setting or header does not count', () => {
  assert.equal(sandbox('[windows]', '# sandbox = "elevated"'), undefined);
  assert.equal(sandbox('# [windows]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[other]', '# [windows]', 'sandbox = "elevated"'), undefined);
});

test('the header may be quoted or padded', () => {
  assert.equal(sandbox('["windows"]', 'sandbox = "elevated"'), 'elevated');
  assert.equal(sandbox("['windows']", 'sandbox = "elevated"'), 'elevated');
  assert.equal(sandbox('[ windows ]', 'sandbox = "elevated"'), 'elevated');
  assert.equal(sandbox('  [windows]  ', 'sandbox = "elevated"'), 'elevated');
});

test('only the [windows] table counts, not others that look like it', () => {
  assert.equal(sandbox('[other]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[windows.extra]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[profiles.windows]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[Windows]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[[windows]]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('sandbox = "elevated"'), undefined);
});

test('the table ends at the next header', () => {
  assert.equal(sandbox('[windows]', 'x = 1', '[other]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[windows]', '[[plugins]]', 'sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[windows]', '[other] # comment', 'sandbox = "elevated"'), undefined);
  // …and can come after other tables.
  assert.equal(sandbox('[other]', 'sandbox = "no"', '[[plugins]]', 'sandbox = "no"', '[windows]', 'sandbox = "elevated"'), 'elevated');
});

test('dotted key at the top: windows.sandbox = "…"', () => {
  assert.equal(sandbox('windows.sandbox = "elevated"'), 'elevated');
  assert.equal(sandbox('model = "x"', 'windows . sandbox="unelevated"'), 'unelevated');
  assert.equal(sandbox('"windows"."sandbox" = \'elevated\''), 'elevated');
});

test('a dotted key inside another table belongs to that table', () => {
  assert.equal(sandbox('[profiles]', 'windows.sandbox = "elevated"'), undefined);
  assert.equal(sandbox('[windows]', 'windows.sandbox = "elevated"'), undefined);
  assert.equal(sandbox('other.windows.sandbox = "elevated"'), undefined);
  assert.equal(sandbox('windows.sandboxed = "elevated"'), undefined);
});

test('inline table at the top: windows = { sandbox = "…" }', () => {
  assert.equal(sandbox('windows = { sandbox = "elevated" }'), 'elevated');
  assert.equal(sandbox('windows={sandbox="elevated"}'), 'elevated');
  assert.equal(sandbox('windows = { other = 1, sandbox = \'unelevated\', more = "x" } # comment'), 'unelevated');
  assert.equal(sandbox('"windows" = { "sandbox" = "elevated" }'), 'elevated');
});

test('an inline table without the setting, or inside another table, does not count', () => {
  assert.equal(sandbox('windows = { other = "elevated" }'), undefined);
  assert.equal(sandbox('windows = { not_sandbox = "elevated" }'), undefined);
  assert.equal(sandbox('[profiles]', 'windows = { sandbox = "elevated" }'), undefined);
  assert.equal(sandbox('linux = { sandbox = "elevated" }'), undefined);
});

test('values that are not a plain quoted word are ignored', () => {
  assert.equal(sandbox('[windows]', 'sandbox = true'), undefined);
  assert.equal(sandbox('[windows]', 'sandbox = elevated'), undefined);
  assert.equal(sandbox('[windows]', 'sandbox = ""'), undefined);
  assert.equal(sandbox('[windows]', 'sandbox = "two words"'), undefined);
  assert.equal(sandbox('[windows]', 'sandbox = "a\\"; rm"'), undefined);
  assert.equal(sandbox('[windows]', 'sandboxed = "elevated"'), undefined);
  assert.equal(sandbox('[windows]', 'my.sandbox = "elevated"'), undefined);
});

test('the first usable setting wins', () => {
  assert.equal(sandbox('[windows]', 'sandbox = true', 'sandbox = "elevated"'), 'elevated');
  assert.equal(sandbox('windows.sandbox = "first"', '[windows]', 'sandbox = "second"'), 'first');
});

test('Windows line endings and a byte-order mark', () => {
  assert.equal(userWindowsSandbox('[windows]\r\nsandbox = "elevated"\r\n'), 'elevated');
  assert.equal(userWindowsSandbox('﻿[windows]\r\nsandbox = "elevated"\r\n'), 'elevated');
  assert.equal(userWindowsSandbox('﻿windows.sandbox = "elevated"'), 'elevated');
});

// ── Multi-line strings: their inside can look like settings ─────────────

test('a fake [windows] table inside a multi-line string is skipped', () => {
  assert.equal(sandbox('notes = """', '[windows]', 'sandbox = "fake"', '"""'), undefined);
  assert.equal(sandbox("notes = '''", '[windows]', 'sandbox = "fake"', "'''"), undefined);
  assert.equal(sandbox('notes = """', 'windows.sandbox = "fake"', 'windows = { sandbox = "fake" }', '"""'), undefined);
});

test('a real setting after the string closes is found', () => {
  assert.equal(sandbox('notes = """', '[windows]', 'sandbox = "fake"', '"""', '[windows]', 'sandbox = "real"'), 'real');
  assert.equal(sandbox("notes = '''", 'windows.sandbox = "fake"', "'''", 'windows.sandbox = "real"'), 'real');
});

test('a multi-line string inside [windows] does not end the table', () => {
  assert.equal(sandbox('[windows]', 'notes = """', '[other]', 'sandbox = "fake"', '"""', 'sandbox = "real"'), 'real');
});

test('a fake header in a string hides nothing after it: the real table before it still counts', () => {
  assert.equal(sandbox('[windows]', 'sandbox = "real"', 'notes = """', '[windows]', 'sandbox = "fake"', '"""'), 'real');
});

test('the line that closes a string is still part of it', () => {
  // Text before the closing quotes is string content, even if it looks like a setting.
  assert.equal(sandbox('[windows]', 'notes = """', 'sandbox = "fake" """'), undefined);
  assert.equal(sandbox('[windows]', 'notes = """', 'sandbox = "fake" """', 'sandbox = "real"'), 'real');
});

test('only the same kind of quotes closes a multi-line string', () => {
  assert.equal(sandbox('notes = """', "'''", '[windows]', 'sandbox = "fake"', '"""'), undefined);
  assert.equal(sandbox("notes = '''", '"""', '[windows]', 'sandbox = "fake"', "'''"), undefined);
  assert.equal(sandbox("notes = '''", '"""', "'''", '[windows]', 'sandbox = "real"'), 'real');
});

test('an escaped quote does not close a basic multi-line string', () => {
  assert.equal(sandbox('notes = """', 'still inside \\"""', '[windows]', 'sandbox = "fake"', '"""'), undefined);
  assert.equal(sandbox('notes = """', 'still inside \\"""', '"""', '[windows]', 'sandbox = "real"'), 'real');
});

test('a backslash is not an escape in a literal multi-line string', () => {
  // In '''…''' the backslash is plain text, so the quotes after it do close the string.
  assert.equal(sandbox("notes = '''", "ends here \\'''", '[windows]', 'sandbox = "real"'), 'real');
});

test('a string that opens and closes on one line leaves the next lines alone', () => {
  assert.equal(sandbox('notes = """one line"""', '[windows]', 'sandbox = "real"'), 'real');
  assert.equal(sandbox("a = '''x''' # then", 'windows.sandbox = "real"'), 'real');
  // Up to two extra quotes before the closing ones belong to the string.
  assert.equal(sandbox('notes = """quoted"""""', '[windows]', 'sandbox = "real"'), 'real');
  // Closed, then opened again on the same line.
  assert.equal(sandbox('a = ["""x""", """', '[windows]', 'sandbox = "fake"', '"""]'), undefined);
});

test('triple quotes inside a comment or a one-line string do not open a string', () => {
  assert.equal(sandbox('# docs say """ opens a string', '[windows]', 'sandbox = "real"'), 'real');
  assert.equal(sandbox('a = \'say """ here\'', '[windows]', 'sandbox = "real"'), 'real');
  assert.equal(sandbox('a = "say \'\'\' here"', '[windows]', 'sandbox = "real"'), 'real');
  assert.equal(sandbox('a = "escaped \\" then # not a comment"', '[windows]', 'sandbox = "real"'), 'real');
  assert.equal(sandbox('a = 1 # it\'s "fine', '[windows]', 'sandbox = "real"'), 'real');
});

test('a hash inside a one-line string does not hide a string opened later on that line', () => {
  assert.equal(sandbox('a = ["#", """', '[windows]', 'sandbox = "fake"', '"""]'), undefined);
});

test('a string left open to the end of the file hides everything after it', () => {
  assert.equal(sandbox('notes = """', '[windows]', 'sandbox = "fake"'), undefined);
});
