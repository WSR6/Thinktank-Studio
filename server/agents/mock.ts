import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentAdapter, AgentConfig, Turn, TurnOptions, TurnResult } from '../types.js';
import { decodeText } from '../project.js';

/**
 * In BUILD, pretend to do the next open task so the autopilot loop can be tried without real CLIs:
 * commit a file and mark it done, or mark it blocked if its title says "needs-decision".
 * Agents listed in TTS_MOCK_LAZY (comma-separated ids) do nothing, to show the no-progress pause.
 */
function simulateWork(cfg: AgentConfig, o: TurnOptions): string | undefined {
  if (/OPERATOR CHECK/.test(o.prompt)) return simulateOperator(o);
  if (/ARBITRATION:/.test(o.prompt)) return simulateArbitration(o);
  if (/REVIEW REQUEST/.test(o.prompt)) return simulateReview(cfg, o);
  // Asked again for a forgotten verdict line: give it.
  if (/ended without the verdict line/.test(o.prompt)) return 'Conclusion: it works and the tests pass.\n[[verdict: approve]]';
  if (!/AUTOPILOT|UNBLOCKED|BUILD phase has started|CHANGES REQUESTED/.test(o.prompt)) return undefined;
  if ((process.env.TTS_MOCK_LAZY ?? '').split(',').includes(cfg.id)) return 'Looked around, did nothing.';
  const file = o.extraDirs.map((d) => join(d, 'tasks.json')).find(existsSync);
  if (!file) return undefined;
  const data = JSON.parse(decodeText(readFileSync(file)));
  const tasks: any[] = data.tasks ?? [];
  const ready = (t: any) => !Array.isArray(t.after) || t.after.every((d: string) => tasks.find((x) => x.id === d)?.status === 'done');
  const task = tasks.find((t) => t.owner === cfg.id && t.status !== 'done' && t.status !== 'blocked' && ready(t));
  let report = '';
  if (!task) return 'No open tasks.';
  if (String(task.title).includes('needs-decision')) {
    Object.assign(task, { status: 'blocked', note: 'needs a decision from the user' });
  } else {
    // Write inside the task's claimed area (first "files" entry), else the repo root.
    const area = Array.isArray(task.files) && task.files[0] ? String(task.files[0]).replace(/\*.*$/, '') : '';
    const dir = join(o.cwd, area.endsWith('/') || !area ? area : dirname(area));
    mkdirSync(dir, { recursive: true });
    // Append, so a second pass after "changes requested" still has something to commit.
    appendFileSync(join(dir, `${task.id}.txt`), `${task.title}\n`);
    // A title like "... also-edit src/api/routes.ts" makes the mock stray outside its area.
    const stray = String(task.title).match(/also-edit (\S+)/)?.[1];
    if (stray) {
      mkdirSync(join(o.cwd, dirname(stray)), { recursive: true });
      writeFileSync(join(o.cwd, stray), 'edited by mistake\n');
    }
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=mock', '-c', 'user.email=mock@local', ...a], { cwd: o.cwd });
    git('add', '-A');
    git('commit', '-qm', `${task.id}: ${task.title}`);
    task.status = 'done';
    // Report it the way real agents are asked to; TTS_MOCK_STALE agents always quote attempt 1.
    const attempt = (process.env.TTS_MOCK_STALE ?? '').split(',').includes(cfg.id) ? '1' : o.prompt.match(new RegExp(`\\[\\[done: ${task.id}#(\\d+)`))?.[1];
    // TTS_MOCK_NOREPORT agents only edit tasks.json, like an agent that forgets the marker.
    if (!(process.env.TTS_MOCK_NOREPORT ?? '').split(',').includes(cfg.id)) report = ` [[done: ${task.id}${attempt ? `#${attempt}` : ''} | done | wrote ${task.id}.txt]]`;
    task.handoff = `${task.id} output is in ${area || '/'}${task.id}.txt`;
  }
  writeFileSync(file, JSON.stringify(data, null, 2));
  return `${task.id} → ${task.status}${report}`;
}

/** The App helper in operator mode: approve requests, answer questions with their first option, nudge stalls. */
function simulateOperator(o: TurnOptions): string {
  const waiting = o.prompt.split('handle only these:')[1] ?? '';
  const acts: string[] = [];
  for (const m of waiting.matchAll(/^- request (\S+):/gm)) acts.push(`[[act: approve ${m[1]}]]`);
  for (const m of waiting.matchAll(/^- question from (\S+):.*?\(options: ([^|)]+)/gm)) acts.push(`[[act: send ${m[1]} | ${m[2].trim()}]]`);
  for (const m of waiting.matchAll(/^- stall (\S+):/gm)) acts.push(`[[act: stall ${m[1]} nudge]]`);
  if (/^- hand-off chain paused:(?!.*user must decide)/m.test(waiting)) acts.push('[[act: chain restart]]');
  for (const m of waiting.matchAll(/^- desktop tests (\S+):/gm)) acts.push(`[[act: desktop run ${m[1]}]]`);
  return [acts.length ? `Handled ${acts.length} item(s).` : 'Nothing I can handle; it needs you.', ...acts].join('\n');
}

/**
 * Chat behaviors for testing coordination: pass on later discussion rounds (unless listed in
 * TTS_MOCK_CHATTY), "ask-user" → flag the user, "dm-<id>" → private message to that teammate,
 * and a teammate's private message → pass (ends the exchange).
 */
function simulateChat(cfg: AgentConfig, o: TurnOptions, _last: string): string | undefined {
  // Ask and wait: answer a QUESTION; acknowledge an ANSWER; "ask-<id>" from the user starts one.
  // TTS_MOCK_MUTE=<id> agents never answer questions (to test the timeout).
  const q = o.prompt.match(/QUESTION from (\S+) \((q\d+)\)/);
  if (q && !(process.env.TTS_MOCK_MUTE ?? '').split(',').includes(cfg.id)) return `Use port 4000 (${cfg.name}'s answer to ${q[2]} from ${q[1]}).`;
  if (q) return '[[pass]]';
  const answer = o.prompt.match(/ANSWER from \S+ to your question \((q\d+)\):\n(.*)/);
  if (answer) return `Got the answer to ${answer[1]}: ${answer[2]} Continuing.`;
  if (/couldn't answer your question|No answer from /.test(o.prompt)) return 'No answer; continuing without it.';
  const last = [...o.prompt.split('\n')].reverse().find((l) => /^User( \(private to [^)]*\))?:/.test(l)) ?? '';
  if (/private message from (?!the user)/.test(o.prompt)) return '[[pass]]';
  if (/Discussion round/.test(o.prompt) && !(process.env.TTS_MOCK_CHATTY ?? '').split(',').includes(cfg.id)) return '[[pass]]';
  // "pingpong": each agent hands the work to the next one, to hit the hop limit.
  if (/pingpong/.test(last) || /can you check the next step\?/.test(o.prompt.slice(-400))) {
    const next = { claude: 'codex', codex: 'grok', grok: 'claude' }[cfg.id] ?? 'claude';
    return `@${next} can you check the next step?`;
  }
  if (/request-build/.test(last)) return 'The plan and tasks are ready.\n[[phase: build]]';
  if (/md-demo/.test(last))
    return [
      '## Plan for the editor',
      'Here is what I **propose**, with `src/engine` owning the model:',
      '1. Build the *engine* first',
      '2. Then the UI shell',
      '- uses [Electron](https://www.electronjs.org)',
      '```ts',
      'const x = <b>1</b>;',
      '```',
      ...Array.from({ length: 30 }, (_, i) => `Detail line ${i + 1} about the design.`),
      '@user should the editor save automatically? [[options: Yes | No]]',
      'More notes after the question.',
    ].join('\n');
  const standIn = last.match(/standin-review (\S+)/)?.[1];
  if (standIn) return `Reviewed ${standIn} in place of the assigned reviewer: looks good.\n[[verdict: approve]]`;
  if (/ask-user/.test(last)) return `@user which database should I use? (${cfg.name}) [[options: SQLite | Postgres | You decide]]`;
  const askTo = last.match(/ask-([a-z]+)\b/)?.[1];
  if (askTo && askTo !== 'user' && askTo !== cfg.id) return `[[ask: ${askTo}]] Which port should the API listen on?`;
  const reportDone = last.match(/report-done (\S+)/)?.[1];
  if (reportDone) return `Finished it. [[done: ${reportDone} | done | said done without committing]]`;
  const dm = last.match(/dm-([a-z0-9_-]+)/)?.[1];
  if (dm && dm !== cfg.id) return `[[to: ${dm}]] psst ${dm}, private note from ${cfg.name}`;
  return undefined;
}

/** Agents in TTS_MOCK_STRICT (comma-separated) request changes on the first review of each task. */
const reviewedOnce = new Set<string>();
function simulateReview(cfg: AgentConfig, o: TurnOptions): string {
  const task = o.prompt.match(/REVIEW REQUEST \(([^)]+)\): task (\S+)/);
  const key = `${cfg.id}:${task?.[2]}`;
  // Agents in TTS_MOCK_NOVERDICT approve in words only, like a real reviewer that forgets the marker.
  if ((process.env.TTS_MOCK_NOVERDICT ?? '').split(',').includes(cfg.id)) return `Reviewed ${task?.[2]}: no issues found. Ready for acceptance.`;
  const strict = (process.env.TTS_MOCK_STRICT ?? '').split(',').includes(cfg.id);
  if (strict && !reviewedOnce.has(key)) {
    reviewedOnce.add(key);
    // Pin the note to a line when the reviewer has a checkout to look at.
    const pin = /checked out at/.test(o.prompt) ? `[[comment: ${task?.[2]}.txt:1]] Handle the empty-input case here.\n` : '';
    return `Reviewed ${task?.[2]} (${task?.[1]}).\n${pin}[[verdict: changes]]\n1. Handle the empty-input case.`;
  }
  return `Reviewed ${task?.[2]} (${task?.[1]}): looks good.\n[[verdict: approve]]`;
}

/** Merge main, keep both sides of every conflict (drop the markers), commit. */
function simulateArbitration(o: TurnOptions): string {
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=mock', '-c', 'user.email=mock@local', ...a], { cwd: o.cwd }).toString();
  try {
    git('merge', 'main');
  } catch {
    /* conflicts expected */
  }
  const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  for (const f of files) {
    const text = readFileSync(join(o.cwd, f), 'utf8');
    writeFileSync(join(o.cwd, f), text.split('\n').filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\n'));
  }
  git('add', '-A');
  git('commit', '--no-edit', '-q');
  return `Resolved ${files.length} conflicted file(s) by keeping both sides: ${files.join(', ')}.`;
}

/** Fake agent for trying the UI without any CLI installed (`npm run mock`). */
export class MockAdapter implements AgentAdapter {
  readonly supportsResume = true;
  private n = 0;
  private limited = 0;
  constructor(private cfg: AgentConfig) {}

  runTurn(o: TurnOptions): Turn {
    const n = ++this.n;
    // Tests can inspect exactly what an agent was sent: TTS_MOCK_DUMP=<dir> writes <id>.prompt.txt.
    if (process.env.TTS_MOCK_DUMP) writeFileSync(join(process.env.TTS_MOCK_DUMP, `${this.cfg.id}.prompt.txt`), o.prompt);
    const timers: NodeJS.Timeout[] = [];
    let reject!: (e: Error) => void;
    // Simulate running out of usage: TTS_MOCK_LIMIT=claude
    // TTS_MOCK_LIMIT_MSG sets the message; TTS_MOCK_LIMIT_TURNS=N lifts the limit after N failed turns.
    if ((process.env.TTS_MOCK_LIMIT ?? '').split(',').includes(this.cfg.id) && this.limited++ < Number(process.env.TTS_MOCK_LIMIT_TURNS ?? Infinity)) {
      const msg = process.env.TTS_MOCK_LIMIT_MSG ?? 'Claude usage limit reached. Your limit resets at 5pm.';
      return { done: Promise.reject(new Error(msg)), kill: () => {} };
    }
    // Simulate a CLI that always fails (e.g. not logged in): TTS_MOCK_FAIL=grok,codex
    if ((process.env.TTS_MOCK_FAIL ?? '').split(',').includes(this.cfg.id)) {
      o.onEvent({ kind: 'log', text: `Error: not logged in. Run \`${this.cfg.command} login\` first.` });
      return { done: Promise.reject(new Error(`${this.cfg.command} exited with 1: not logged in`)), kill: () => {} };
    }
    // Lets the test harness simulate a lost session: `TTS_MOCK_FAIL_RESUME=1 npm run mock`.
    if (o.sessionId && process.env.TTS_MOCK_FAIL_RESUME && n > 1 && n % 2 === 0) {
      return { done: Promise.reject(new Error(`No conversation found with session ID: ${o.sessionId}`)), kill: () => {} };
    }
    // Simulate a stuck turn: TTS_MOCK_HANG=grok starts a dev server and never finishes.
    // TTS_MOCK_LOOP=codex runs the same command over and over.
    const hang = (process.env.TTS_MOCK_HANG ?? '').split(',').includes(this.cfg.id);
    const loop = (process.env.TTS_MOCK_LOOP ?? '').split(',').includes(this.cfg.id);
    if ((hang || loop) && !/NUDGE:/.test(o.prompt)) {
      const done = new Promise<TurnResult>((_res, rej) => {
        reject = rej;
        timers.push(setTimeout(() => o.onEvent({ kind: 'text', text: `Partial work from ${this.cfg.name}.\n[[verdict: approve]]` }), 200));
        if (hang) {
          timers.push(setTimeout(() => o.onEvent({ kind: 'tool', name: 'shell', detail: 'npm run dev' }), 400));
          // TTS_MOCK_HANG_ENDS=1: the command finishes (Codex-style log line) and the agent keeps writing.
          if (process.env.TTS_MOCK_HANG_ENDS) timers.push(setTimeout(() => o.onEvent({ kind: 'log', text: 'shell finished (exit 0): npm run dev' }), 1400));
          // TTS_MOCK_HANG_CHATTY=1: keep posting "still waiting" while hung, as Codex does.
          if (process.env.TTS_MOCK_HANG_CHATTY)
            for (let i = 1; i <= 30; i++) timers.push(setTimeout(() => o.onEvent({ kind: 'text', text: `The process is still running… (${i})` }), 400 + i * 1000));
        } else {
          for (let i = 0; i < 6; i++) timers.push(setTimeout(() => o.onEvent({ kind: 'tool', name: 'shell', detail: 'npm test' }), 300 + i * 200));
        }
      });
      return {
        done,
        kill: () => {
          timers.forEach(clearTimeout);
          reject(new Error('killed'));
        },
      };
    }
    const done = new Promise<TurnResult>((res, rej) => {
      reject = rej;
      timers.push(setTimeout(() => o.onEvent({ kind: 'tool', name: 'Read', detail: `${o.cwd}/README.md` }), 400));
      timers.push(setTimeout(() => o.onEvent({ kind: 'text', text: 'Thinking it over…' }), 900));
      timers.push(
        setTimeout(() => {
          const lines = o.prompt.trim().split('\n').filter(Boolean);
          // The helper's prompt ends with "User: …"; team turns end with an instruction line.
          const last = [...lines].reverse().find((l) => l.startsWith('User:')) ?? lines.at(-2) ?? '';
          const chat = simulateChat(this.cfg, o, last);
          if (chat) return res({ text: chat, sessionId: `mock-${this.cfg.id}` });
          let work: string | undefined;
          try {
            work = simulateWork(this.cfg, o);
          } catch (e) {
            work = `mock work failed: ${(e as Error).message}`;
          }
          // Line comments sent to this builder: claim them all fixed.
          const ids = /line comments on your branch/.test(o.prompt) ? [...o.prompt.matchAll(/^(c\d+)\. /gm)].map((m) => m[1]) : [];
          if (ids.length) work = `${work ?? 'Addressed the comments.'} [[fixed: ${ids.join(', ')}]]`;
          const { model, effort, autonomy } = o.settings;
          const tag = `${model || 'default'}/${effort || 'default'}/${autonomy}`;
          res({
            text:
              (work ? `(${this.cfg.name} mock #${n}) ${work}` : `(${this.cfg.name} mock #${n}, ${tag}) Saw: "${last.slice(0, 120)}"`) +
              (o.images?.length ? ` [got ${o.images.length} image(s)]` : ''),
            sessionId: `mock-${this.cfg.id}`,
            usage: { input: 1200 + n * 10, output: 150, cached: 800, costUsd: this.cfg.id === 'codex' ? undefined : 0.004 },
          });
        }, 1500 + Math.random() * 1000),
      );
    });
    return {
      done,
      kill: () => {
        timers.forEach(clearTimeout);
        reject(new Error('killed'));
      },
    };
  }
}
