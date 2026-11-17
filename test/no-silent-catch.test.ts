import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every place in server/ that ignores an error must say why, right there: an empty `.catch(() => {})`,
 * a no-op error callback, or a `catch {` without the error. Anything that isn't truly harmless should
 * log or report instead (see server/report.ts).
 */

const serverDir = fileURLToPath(new URL('../server', import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

const IGNORING = /\.catch\(\(\) => (\{\}|undefined|null|false|\[\]|\[\] as [\w[\]]+)\)|, \(\) => \{\}\)|\bcatch \{/;
const hasComment = (s: string) => /\/\/|\/\*/.test(s);

test('no error is ignored in server/ without a comment saying why', () => {
  const unexplained: string[] = [];
  for (const file of sources(serverDir)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!IGNORING.test(line)) return;
      // The reason may sit on the line itself, the line before, or (for catch blocks) the next two lines.
      const near = [lines[i - 1] ?? '', line, lines[i + 1] ?? '', /\bcatch \{/.test(line) ? (lines[i + 2] ?? '') : ''];
      if (!near.some(hasComment)) unexplained.push(`${file.slice(serverDir.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(unexplained, [], `Explain these (or log/report the error):\n${unexplained.join('\n')}`);
});
