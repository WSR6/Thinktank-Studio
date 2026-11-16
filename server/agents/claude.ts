import type { AgentAdapter, AgentConfig, Turn, TurnOptions, TurnUsage } from '../types.js';
import { runProcess, safeJson, summarize, toUsage } from './base.js';
import { autonomyArgs } from './catalog.js';
import { claudeWindows } from '../limits.js';

function readOnlyRules(dirs: string[]): string {
  return dirs
    .map((d) => d.replaceAll('\\', '/').replace(/^\/*/, '/'))
    // Edit(...) rules cover every file-editing tool (Write/NotebookEdit rules aren't matched and only warn).
    .map((d) => `Edit(/${d}/**)`)
    .join(',');
}

/** Claude Code headless: `claude -p --output-format stream-json --verbose [--resume id]`, prompt on stdin. */
export class ClaudeAdapter implements AgentAdapter {
  readonly supportsResume = true;
  constructor(private cfg: AgentConfig) {}

  runTurn(o: TurnOptions): Turn {
    let sessionId = o.sessionId;
    let finalText = '';
    let errText = '';
    let usage: TurnUsage | undefined;
    let failed = false;
    const texts: string[] = [];
    /** Tool names by tool_use id, so a finished call can be reported by name. */
    const toolNames = new Map<string, string>();
    const { model, effort, autonomy } = o.settings;

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      ...autonomyArgs('claude', autonomy, this.cfg.allowCommands),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...o.extraDirs.flatMap((d) => ['--add-dir', d]),
      // Read-only dirs: allowed in, but edits denied. `//` marks an absolute path in permission rules.
      ...(o.readDirs ?? []).flatMap((d) => ['--add-dir', d]),
      ...(o.readDirs?.length ? [`--disallowedTools=${readOnlyRules(o.readDirs)}`] : []),
      ...(o.sessionId ? ['--resume', o.sessionId] : []),
      ...(this.cfg.args ?? []),
    ];

    const proc = runProcess({
      command: this.cfg.command,
      args,
      cwd: o.cwd,
      // CLAUDE_CODE_EFFORT_LEVEL (if set on the machine) beats --effort, so set it to the chosen level too.
      env: effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : undefined,
      stdin: o.prompt,
      onStdoutLine: (line) => {
        const ev = safeJson(line);
        if (!ev) return o.onEvent({ kind: 'log', text: line });
        if (ev.session_id && ev.session_id !== sessionId) {
          sessionId = ev.session_id;
          o.onEvent({ kind: 'session', id: ev.session_id });
        }
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && b.text) {
              texts.push(b.text);
              o.onEvent({ kind: 'text', text: b.text });
            } else if (b.type === 'tool_use') {
              if (b.id) toolNames.set(b.id, b.name);
              o.onEvent({ kind: 'tool', name: b.name, detail: summarize(b.input) });
            }
          }
        } else if (ev.type === 'user') {
          // Tool results come back in a "user" message; report each finished call.
          for (const b of ev.message?.content ?? []) {
            if (b?.type !== 'tool_result') continue;
            const name = toolNames.get(b.tool_use_id) ?? 'tool';
            toolNames.delete(b.tool_use_id);
            o.onEvent({ kind: 'tool_end', name, ok: !b.is_error, text: `${name} ${b.is_error ? 'failed' : 'finished'}` });
          }
        } else if (ev.type === 'rate_limit_event') {
          const windows = claudeWindows(ev.rate_limit_info);
          if (windows.length) o.onEvent({ kind: 'limits', windows });
        } else if (ev.type === 'result') {
          usage = toUsage(ev.usage, ev.total_cost_usd);
          // Error results (e.g. "Please run /login") carry their message in `result`; don't post it as a reply.
          if (ev.is_error) {
            failed = true;
            errText += ev.result ?? ev.subtype ?? 'error';
          } else if (typeof ev.result === 'string') finalText = ev.result;
        }
      },
      onStderr: (s) => {
        errText += s;
        o.onEvent({ kind: 'log', text: s });
      },
    });

    return {
      kill: proc.kill,
      pid: proc.pid,
      done: proc.done.then((code) => {
        if (proc.killed()) throw new Error('killed');
        const text = finalText || texts.join('\n\n');
        if (failed || (code !== 0 && !text)) throw new Error(errText.trim() || `claude exited with ${code}`);
        return { text, sessionId, usage };
      }),
    };
  }
}
