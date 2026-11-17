#!/usr/bin/env node
// Runs every test/*.test.ts with Node's built-in test runner, through tsx.
// The files are listed here rather than with a glob in package.json: Node 20 doesn't expand
// globs for --test, and neither does the Windows shell npm uses.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('test', f));
if (!files.length) {
  console.error('No test files found in test/.');
  process.exit(1);
}
// Extra arguments go to the runner, e.g. `npm test -- --test-name-pattern=verdict`.
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
