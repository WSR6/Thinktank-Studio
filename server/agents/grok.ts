import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentConfig, Turn, TurnOptions, TurnUsage } from '../types.js';
import { runProcess, safeJson, summarize, toUsage } from './base.js';
import { DEFAULT_ALLOW_COMMANDS, autonomyArgs } from './catalog.js';

/**
 * Grok Build headless: `grok --prompt-file f --output-format streaming-json [-r id]`.
 * Grok ignores piped stdin, so the prompt goes through a temp file (no quoting/length issues).
 * Events: text/thought chunks (`data`), tool_call, end (`sessionId`), error (`message`).
 */
/** How long Grok gets to exit on its own after its `end` event before the adapter ends it. */
const END_GRACE_MS = 5_000;
/** Where Grok keeps what it's asked to remember (~/.grok/memory-v2, or GROK_HOME's). */
const GROK_MEMORY = join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'memory-v2').replaceAll('\\', '/');

export class GrokAdapter implements AgentAdapter {
  readonly supportsResume = true;
  constructor(private cfg: AgentConfig) {}

  runTurn(o: TurnOptions): Turn {
    let sessionId = o.sessionId;
    let errText = '';
    let usage: TurnUsage | undefined;
    // Text arrives in chunks; a tool call ends a segment. The last segment is the reply.
    let segment = '';
    let lastSegment = '';
    let endTimer: NodeJS.Timeout | undefined;
    /** Tool names by call id, so a finished call can be reported by name. */
    const toolNames = new Map<string, string>();
    let ended = false;
    const flush = () => {
      if (segment.trim()) {
        o.onEvent({ kind: 'text', text: segment });
        lastSegment = segment;
      }
      segment = '';
    };

    const dir = mkdtempSync(join(tmpdir(), 'tts-grok-'));
    const promptFile = join(dir, 'prompt.md');
    writeFileSync(promptFile, o.prompt);
    const { model, effort, autonomy } = o.settings;
    // A refused tool call ends a headless Grok turn on the spot, so whatever text it had written
    // ("I'll check X") would otherwise be posted as if it were the whole reply. Non-JSON output is
    // collected and scanned once at the end, so a message split across stderr chunks still matches.
    let plainOutput = '';

    const args = [
      '--prompt-file', promptFile,
      '--output-format', 'streaming-json',
      '--cwd', o.cwd,
      '--no-auto-update',
      // Without this, a headless Grok that has answered keeps running (and withholds `end`) while
      // background commands it started are still going, often until the turn times out.
      '--no-wait-for-background',
      ...autonomyArgs('grok', autonomy, this.cfg.allowCommands),
      // Headless acceptEdits still refuses edits inside --cwd (and the refusal ends the turn),
      // so grant the agent's own worktree explicitly. `./**` is relative to --cwd, so folder
      // names with glob characters like [ ] can't break the rule.
      ...(autonomy === 'edits' ? ['--allow', 'Edit(./**)'] : []),
      // Asked to "remember" something, Grok writes to its own memory folder; refused, that ends the turn.
      ...(autonomy === 'edits' ? ['--allow', `Write(${GROK_MEMORY}/**)`, '--allow', `Edit(${GROK_MEMORY}/**)`] : []),
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--effort', effort] : []),
      // Grok has no --add-dir; grant the extra dirs with absolute path rules instead.
      ...o.extraDirs.flatMap((d) => {
        const p = d.replaceAll('\\', '/');
        return ['--allow', `Read(${p}/**)`, '--allow', `Edit(${p}/**)`];
      }),
      ...(o.readDirs ?? []).flatMap((d) => ['--allow', `Read(${d.replaceAll('\\', '/')}/**)`]),
      ...(o.sessionId ? ['-r', o.sessionId] : []),
      ...(this.cfg.args ?? []),
    ];

    const proc = runProcess({
      command: this.cfg.command,
      args,
      cwd: o.cwd,
      onStdoutLine: (line) => {
        const ev = safeJson(line);
        if (!ev) {
          plainOutput += line + '\n';
          return o.onEvent({ kind: 'log', text: line });
        }
        switch (ev.type) {
          case 'text':
            segment += ev.data ?? '';
            break;
          case 'tool_call':
            flush();
            if (ev.toolCallId) toolNames.set(ev.toolCallId, ev.toolName ?? ev.title ?? 'tool');
            o.onEvent({ kind: 'tool', name: ev.toolName ?? ev.title ?? 'tool', detail: summarize(ev.rawInput) });
            break;
          case 'tool_call_update':
            if (ev.status === 'completed' || ev.status === 'failed') {
              const name = toolNames.get(ev.toolCallId) ?? 'tool';
              toolNames.delete(ev.toolCallId);
              o.onEvent({ kind: 'tool_end', name, ok: ev.status === 'completed', text: `${name} ${ev.status === 'completed' ? 'finished' : 'failed'}` });
            }
            break;
          case 'end':
            if (ev.sessionId) sessionId = ev.sessionId;
            // Cost is omitted when grok can't price every call; absent means unknown, not free.
            usage = toUsage(ev.usage, ev.total_cost_usd);
            // The reply is complete now. If Grok still doesn't exit (e.g. held open by its MCP
            // servers), show the reply and end it ourselves.
            flush();
            ended = true;
            endTimer ??= setTimeout(() => proc.finish(), END_GRACE_MS);
            break;
          case 'error':
            errText += ev.message ?? 'grok error';
            break;
        }
      },
      onStderr: (s) => {
        plainOutput += s;
        errText += s;
        o.onEvent({ kind: 'log', text: s });
      },
    });

    return {
      kill: proc.kill,
      pid: proc.pid,
      done: proc.done.then((code) => {
        clearTimeout(endTimer);
        flush();
        rmSync(dir, { recursive: true, force: true });
        if (proc.killed()) throw new Error('killed');
        const blocked = refusals(plainOutput);
        const allow = autonomy === 'edits' ? (this.cfg.allowCommands ?? DEFAULT_ALLOW_COMMANDS) : [];
        const note = blocked.length ? blockedNote(blocked, autonomy, Boolean(lastSegment.trim()), allow) : '';
        if (note) o.onEvent({ kind: 'log', text: note });
        // After `end` the turn is complete; a non-zero code then only means we ended a lingering process.
        if (code !== 0 && !lastSegment && !ended) {
          throw new Error([errText.trim() || `grok exited with ${code}`, note].filter(Boolean).join('\n'));
        }
        return { text: [lastSegment.trim(), note].filter(Boolean).join('\n\n'), sessionId, usage };
      }),
    };
  }
}

/** Grok's message when a headless run refuses a tool call: "permission required: Execute `cmd` was not run, ...". */
const BLOCKED_RE = /permission required: ([\s\S]+?) was not run/g;

/**
 * The tool calls Grok refused during the turn. Refusals from Grok's own background workflows
 * ("... (workflow "review") was not run") come after a finished turn, so they don't count.
 */
function refusals(output: string): string[] {
  return [...output.matchAll(BLOCKED_RE)].map((m) => m[1].trim()).filter((what) => !what.includes('(workflow '));
}

function blockedNote(blocked: string[], autonomy: string, hadText: boolean, allow: string[]): string {
  const what = [...new Set(blocked)].slice(0, 3).map((b) => b.replace(/\s+/g, ' ').slice(0, 160)).join('; ');
  // grok 1.0.62 labels a refused shell call "Execute `cmd`"; some builds say "Run a terminal command".
  const commands = blocked.some((b) => b.startsWith('Execute') || b.startsWith('Run a terminal command'));
  return [
    `⚠ Grok's turn ended early: its "${autonomy}" permission level refused ${what}.`,
    hadText ? 'The reply above may be unfinished.' : '',
    commands && allow.length
      ? `Allowed programs at this level: ${allow.join(', ')}, plus read-only commands like ls and git status. ` +
        'Grok checks each part of a command line split on ; && || | and newlines (ignoring env-var prefixes and wrappers like timeout). ' +
        'Command substitution ($(...) or backticks), subshells, background & and control flow are always refused.'
      : '',
    'If it needs this, raise its autonomy.',
  ]
    .filter(Boolean)
    .join(' ');
}
