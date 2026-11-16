import type { AgentAdapter, AgentConfig, Turn, TurnOptions, TurnResult, TurnUsage } from '../types.js';
import { runProcess, safeJson, summarize } from './base.js';
import { autonomyArgs } from './catalog.js';

/**
 * Hermes Agent headless: `hermes chat --query-file - --format stream-json [--resume id]`, prompt on stdin.
 * Events (one JSON object per line): system/init {session_id, model}, text {text} in small chunks,
 * tool_use {name, input}, tool_result {name, output}, result {session_id, exit_code, text, tokens, error}.
 * `--source tool` keeps the app's sessions out of the user's own Hermes session list.
 * A session keeps the settings it was created with. Repeating them on a resume is fine; after the
 * user changes the model, effort or autonomy, Hermes refuses the resume; the turn fails and the
 * orchestrator's lost-session retry starts a new session with the full chat in its prompt.
 */
export class HermesAdapter implements AgentAdapter {
  readonly supportsResume = true;
  constructor(private cfg: AgentConfig) {}

  runTurn(o: TurnOptions): Turn {
    const resumeId = o.sessionId;
    let sessionId = resumeId;
    let errText = '';
    let usage: TurnUsage | undefined;
    let finalText: string | undefined;
    let failed = false;
    /** A result event without an error: the turn really finished. */
    let completed = false;
    // Text arrives a few characters at a time; a tool call ends a segment.
    let segment = '';
    let lastSegment = '';
    const flush = () => {
      if (segment.trim()) {
        o.onEvent({ kind: 'text', text: segment });
        lastSegment = segment;
      }
      segment = '';
    };
    const { model, effort, autonomy } = o.settings;

    const args = [
      'chat',
      '--query-file', '-',
      '--format', 'stream-json',
      '--source', 'tool',
      // Work in the agent's own folder (a resume checks it is still the session's folder).
      '--in', o.cwd,
      // Attached images are named in the prompt; every level's toolsets include vision to read them.
      ...autonomyArgs('hermes', autonomy),
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--reasoning', effort] : []),
      ...(resumeId ? ['--resume', resumeId] : []),
      ...(this.cfg.args ?? []),
    ];

    const proc = runProcess({
      command: this.cfg.command,
      args,
      cwd: o.cwd,
      stdin: o.prompt,
      onStdoutLine: (line) => {
        const ev = safeJson(line);
        if (!ev) return o.onEvent({ kind: 'log', text: line });
        // A refused resume reports an empty session id; only a real id replaces the one we have.
        if (typeof ev.session_id === 'string' && ev.session_id && ev.session_id !== sessionId) {
          sessionId = ev.session_id;
          o.onEvent({ kind: 'session', id: ev.session_id });
        }
        switch (ev.type) {
          case 'text':
            segment += ev.text ?? '';
            break;
          case 'tool_use':
            flush();
            o.onEvent({ kind: 'tool', name: ev.name ?? 'tool', detail: summarize(ev.input) });
            break;
          case 'tool_result': {
            const name = ev.name ?? 'tool';
            // Failures come back as is_error, or as output JSON like {"error": "Refusing to overwrite…"} / {"success": false}.
            const out = String(ev.output ?? '');
            const ok = !ev.error && !ev.is_error && !/^\s*\{\s*"error"\s*:/.test(out) && !/^\s*\{\s*"success"\s*:\s*false/.test(out);
            o.onEvent({ kind: 'tool_end', name, ok, text: `${name} ${ok ? 'finished' : 'failed'}` });
            break;
          }
          case 'result': {
            flush();
            const t = ev.tokens;
            if (t && typeof t === 'object') {
              const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
              usage = { input: n(t.input), output: n(t.output), cached: n(t.cache_read) };
            }
            if (ev.error || (typeof ev.exit_code === 'number' && ev.exit_code !== 0)) {
              failed = true;
              errText += String(ev.error || `hermes exited with ${ev.exit_code}`);
            } else {
              completed = true;
              if (typeof ev.text === 'string') finalText = ev.text;
            }
            break;
          }
          case 'error':
            errText += String(ev.message ?? ev.error ?? 'hermes error');
            break;
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
      done: proc.done.then((code): TurnResult => {
        flush();
        if (proc.killed()) throw new Error('killed');
        const text = (finalText ?? lastSegment).trim();
        // Text without a finished result is an interrupted turn ("I'll check X…"), not a reply.
        if (failed || !completed) throw new Error(errText.trim() || `hermes exited with ${code}${text ? ' before finishing' : ''}`);
        return { text, sessionId, usage };
      }),
    };
  }
}
