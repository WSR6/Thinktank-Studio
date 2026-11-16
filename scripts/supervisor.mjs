#!/usr/bin/env node
// The `ttstudio` command (and `npm start`). Runs the server and restarts it on request, so the App helper can apply an update and reload the app.
// Exit code 75 = "restart me". If the server crashes soon after an update was applied, the update is
// rolled back automatically (git reset to the recorded version) and the server starts again.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART = 75;
const CRASH_WINDOW_MS = 30_000;
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = join(homedir(), '.thinktank');
const pendingFile = join(stateDir, 'pending-apply.json');
const rollbackNote = join(stateDir, 'rollback-note.json');

let child;
process.on('SIGTERM', () => child?.kill('SIGTERM'));

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', ...process.argv.slice(2)], {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, TTS_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART) {
      console.log('[supervisor] restarting…');
      return start();
    }
    if (signal || code === 0) process.exit(code ?? 0);
    if (existsSync(pendingFile) && Date.now() - startedAt < CRASH_WINDOW_MS) {
      const { undo, applied } = JSON.parse(readFileSync(pendingFile, 'utf8'));
      console.error(`[supervisor] the server crashed right after an update; rolling back to ${undo.slice(0, 7)}.`);
      execFileSync('git', ['reset', '--hard', undo], { cwd: appRoot, stdio: 'inherit' });
      rmSync(pendingFile, { force: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(rollbackNote, JSON.stringify({ undo, applied, at: Date.now() }));
      return start();
    }
    process.exit(code ?? 1);
  });
}

start();
