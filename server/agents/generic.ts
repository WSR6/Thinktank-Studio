import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentConfig, Turn, TurnOptions } from '../types.js';
import { runProcess, stripAnsi } from './base.js';

/**
 * Any CLI with a one-shot prompt mode that prints plain text.
 * No session resume, so the orchestrator resends recent chat each turn.
 * Model/effort/autonomy pickers don't apply; put those flags in `args`.
 */
export class GenericAdapter implements AgentAdapter {
  readonly supportsResume = false;
  constructor(private cfg: AgentConfig) {}

  runTurn(o: TurnOptions): Turn {
    const rawArgs = this.cfg.args ?? [];
    // {promptFile}: the prompt in a temporary file (safe for long, multi-line prompts on every OS).
    const fileDir = rawArgs.some((a) => a.includes('{promptFile}')) ? mkdtempSync(join(tmpdir(), 'tts-generic-')) : undefined;
    const promptFile = fileDir ? join(fileDir, 'prompt.md') : '';
    if (fileDir) writeFileSync(promptFile, o.prompt);
    const viaArg = Boolean(fileDir) || this.cfg.promptVia === 'arg' || rawArgs.some((a) => a.includes('{prompt}'));
    const args = rawArgs.map((a) => a.replaceAll('{promptFile}', promptFile).replaceAll('{prompt}', o.prompt));
    const lines: string[] = [];
    let errText = '';

    const proc = runProcess({
      command: this.cfg.command,
      args,
      cwd: o.cwd,
      stdin: viaArg ? '' : o.prompt,
      onStdoutLine: (line) => {
        const clean = stripAnsi(line);
        lines.push(clean);
        o.onEvent({ kind: 'text', text: clean });
      },
      onStderr: (s) => {
        errText += s;
        o.onEvent({ kind: 'log', text: stripAnsi(s) });
      },
    });

    return {
      kill: proc.kill,
      pid: proc.pid,
      done: proc.done.finally(() => fileDir && rmSync(fileDir, { recursive: true, force: true })).then((code) => {
        if (proc.killed()) throw new Error('killed');
        const text = lines.join('\n');
        if (code !== 0 && !text) throw new Error(errText.trim() || `${this.cfg.command} exited with ${code}`);
        return { text };
      }),
    };
  }
}
