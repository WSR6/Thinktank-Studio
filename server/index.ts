import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAttachmentName, MAX_ATTACHMENT_BYTES, mimeOf, saveAttachment } from './attachments.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { ADAPTERS, loadAgentConfigs, loadHelperConfig, saveAgentConfigs, validateAgentConfigs } from './config.js';
import { AppHelper } from './helper.js';
import { hermesProfiles } from './agents/models.js';
import { Orchestrator } from './orchestrator.js';
import { captureConsole } from './logbuffer.js';
import { projectView, refreshIdle, runAction } from './operator.js';
import { listProjects, projectsRoot } from './project.js';
import { MAX_PLAN_TEXT, validateCommand } from './commands.js';
import { errText, logOnce } from './report.js';
import type { Phase } from './types.js';

const PORT = Number(process.env.PORT ?? 4317);
// Localhost only: this server runs CLIs that can edit files and execute commands.
const HOST = process.env.HOST ?? '127.0.0.1';
const mock = process.argv.includes('--mock');

captureConsole(); // so the App helper can read recent server output
const configProblems: string[] = [];
const orch = new Orchestrator(loadAgentConfigs((t) => configProblems.push(t)), mock);
for (const t of configProblems) orch.warn(t);
// TTS_REAL_HELPER=1 runs the real helper CLI next to mock agents (to test the helper on its own).
const helper = new AppHelper(loadHelperConfig(), mock && process.env.TTS_REAL_HELPER !== '1', {
  recentIssues: () => orch.recentIssues(),
  project: () => orch.project,
  activitySince: (cursors) => orch.activitySince(cursors),
  agentsBusy: () => orch.busy(),
  stopAgents: () => orch.stopAll(),
  view: () => projectView(orch),
  act: (action) => runAction(orch, action),
});
// Operator mode watches the project: anything new that waits on the user gets a look.
orch.on('state', () => helper.poke());
// Desktop tests waiting and Run my project on: watch for this computer going idle, then let the helper run them.
setInterval(() => {
  if (!helper.operating || !orch.desktopTestsWaiting().length) return;
  refreshIdle().then((fresh) => fresh && helper.poke(), (e) => logOnce('idle check', e));
}, 60_000).unref();
const app = express();
app.use(express.static(fileURLToPath(new URL('../web', import.meta.url))));
app.get('/api/projects', async (_req, res) => res.json(await listProjects()));

/** Only this app's own page may call the API (same rule as the WebSocket). */
function sameOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (scripts) can't be driven by a web page
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port) === PORT;
  } catch {
    return false; // not a URL: not our page
  }
}

const attachmentDir = (scope: string) => (scope === 'helper' ? helper.attachmentsDir : scope === 'project' ? orch.attachmentsDir() : undefined);

// Upload an image for a chat. The custom header can't be sent cross-site without a CORS preflight,
// which this server never grants, so other web pages can't upload here.
app.post('/api/attachments/:scope', express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }), (req, res) => {
  if (!sameOrigin(req.headers.origin) || req.headers['x-tts'] !== '1') return void res.status(403).json({ error: 'Forbidden' });
  const dir = attachmentDir(req.params.scope);
  if (!dir) return void res.status(400).json({ error: 'Open or create a project first.' });
  try {
    // The original file name decides the type for text files (e.g. .pine); it arrives URL-encoded.
    const original = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
    res.json({ name: saveAttachment(dir, req.body as Buffer, original) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/attachments/:scope/:name', (req, res) => {
  const dir = attachmentDir(req.params.scope);
  const name = req.params.name;
  if (!dir || !isAttachmentName(name) || !existsSync(join(dir, name))) return void res.status(404).end();
  res.set({ 'Content-Type': mimeOf(name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.sendFile(join(dir, name));
});

// Oversized uploads and other body errors come back as readable JSON.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err?.status ?? 500).json({ error: err?.type === 'entity.too.large' ? 'Image is larger than 10 MB.' : 'Upload failed.' });
});

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Big enough for the largest command (a saved plan; JSON escapes a control character as 6 bytes); ws's default is 100 MB.
  maxPayload: MAX_PLAN_TEXT * 6 + 64 * 1024,
  // Only this app's own page may connect: blocks other sites, and other local dev servers on other ports.
  verifyClient: ({ origin }: { origin?: string }) => sameOrigin(origin),
});

const broadcast = (msg: unknown) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(data);
};

orch.on('message', (message) => broadcast({ type: 'message', message }));
helper.on('message', (message) => broadcast({ type: 'helper_message', message }));
helper.on('event', (event) => broadcast({ type: 'helper_event', event }));
helper.on('state', async () => broadcast({ type: 'helper_state', helper: await helper.snapshot() }));
helper.on('restarting', () => broadcast({ type: 'restarting' }));
orch.on('agent_event', (e) => broadcast({ type: 'agent_event', ...e }));
orch.on('state', () => broadcast({ type: 'state', state: orch.state() }));
orch.on('messages', () => {
  broadcast({ type: 'messages', ...orch.chatPage() });
  broadcast({ type: 'agent_history', history: orch.activityHistory() });
});
orch.on('team', async () => broadcast({ type: 'team', ...(await orch.teamFiles()) }));
orch.on('branches', async () => {
  try {
    broadcast({ type: 'branches', branches: await orch.branches() });
  } catch (e) {
    console.error('branch status failed:', (e as Error).message);
  }
});

wss.on('connection', (ws: WebSocket) => {
  // A broken or oversized frame closes only this connection (the page reconnects); unhandled, it would end the server.
  ws.on('error', (e) => console.warn(`page connection closed: ${errText(e)}`));
  const send = (m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  // Listen first, then send the initial snapshot: commands sent right after connecting aren't lost
  // while the slower parts (helper git status, branch status) are still loading.
  void (async () => {
    send({ type: 'state', state: orch.state() });
    send({ type: 'messages', ...orch.chatPage() });
    send({ type: 'agent_history', history: orch.activityHistory() });
    for (const error of orch.waitingWarnings()) send({ type: 'error', error });
    send({ type: 'helper_state', helper: await helper.snapshot() });
    send({ type: 'projects', projects: await listProjects() });
    send({ type: 'agent_config', agents: orch.agentConfigs(), adapters: ADAPTERS.filter((a) => a !== 'mock' || mock), hermesProfiles: hermesProfiles().names });
    if (orch.project) {
      send({ type: 'team', ...(await orch.teamFiles()) });
      send({
        type: 'branches',
        branches: await orch.branches().catch((e) => {
          console.error('branch status failed:', errText(e)); // the Branches tab stays empty until the next refresh
          return [];
        }),
      });
    }
  })().catch((e) => console.error('initial sync failed:', e.message));

  ws.on('message', async (raw) => {
    const checked = validateCommand(String(raw));
    if (!checked.ok) {
      console.warn(`refused a command from the page: ${checked.error}`);
      return send({ type: 'error', error: checked.error });
    }
    const cmd = checked.cmd;
    try {
      switch (cmd.type) {
        case 'create_project':
        case 'open_project':
          await orch.open(String(cmd.name), cmd.type === 'create_project');
          rememberProject(String(cmd.name));
          broadcast({ type: 'projects', projects: await listProjects() });
          break;
        case 'send':
          // Don't block the socket on a long agent turn.
          orch.userSend(String(cmd.text ?? ''), cmd.to ?? 'all', cmd.attachments).catch((e) => send({ type: 'error', error: e.message }));
          break;
        case 'debate':
          orch.debate(String(cmd.text), cmd.attachments).catch((e) => send({ type: 'error', error: e.message }));
          break;
        case 'set_settings':
          orch.setSettings(String(cmd.agentId), cmd.settings ?? {});
          break;
        case 'set_autopilot':
          orch.setAutopilot(Boolean(cmd.on));
          break;
        // ── Roles, saved setups, reviews ──
        case 'set_roles_enabled':
          orch.setRolesEnabled(Boolean(cmd.on));
          break;
        case 'set_role':
          orch.setRole(String(cmd.agentId), cmd.assignment);
          break;
        case 'set_review_mode':
          orch.setReviewMode(cmd.mode);
          break;
        case 'set_test_command':
          orch.setTestCommand(String(cmd.command ?? ''));
          break;
        case 'set_desktop_test_command':
          orch.setDesktopTestCommand(String(cmd.command ?? ''));
          break;
        case 'desktop_tests':
          if (cmd.action !== 'cancel' && !cmd.taskId) throw new Error('Which task? The request to run or skip desktop tests named none.');
          if (cmd.action === 'run') orch.runDesktopTests(String(cmd.taskId), 'user');
          else if (cmd.action === 'skip') orch.skipDesktopTests(String(cmd.taskId));
          else if (cmd.action === 'cancel') orch.cancelDesktopTests();
          break;
        case 'apply_preset':
          orch.applyPreset(String(cmd.name));
          break;
        case 'save_preset':
          orch.savePreset(String(cmd.name));
          break;
        case 'delete_preset':
          orch.deletePreset(String(cmd.name));
          break;
        case 'load_earlier':
          send({ type: 'earlier_messages', before: String(cmd.before), ...(await orch.earlierMessages(String(cmd.before))) });
          break;
        case 'refresh_branches':
          orch.emit('branches');
          break;
        case 'add_comment':
          orch.addComment(String(cmd.agentId), String(cmd.file ?? ''), Number(cmd.line), cmd.side === 'old' ? 'old' : 'new', String(cmd.lineText ?? ''), String(cmd.text ?? ''));
          break;
        case 'comment_action':
          orch.commentAction(String(cmd.id), cmd.action);
          break;
        case 'send_comments':
          orch.sendComments(String(cmd.agentId));
          break;
        case 'stall_action':
          orch.stallAction(String(cmd.agentId), cmd.action === 'nudge' ? 'nudge' : cmd.action === 'stop' ? 'stop' : 'wait');
          break;
        case 'set_agent_enabled':
          orch.setAgentEnabled(String(cmd.agentId), Boolean(cmd.on));
          break;
        case 'clear_out_of_usage':
          orch.clearOutOfUsage(String(cmd.agentId));
          break;
        case 'dismiss_needs_you':
          orch.dismissNeedsYou(cmd.agentId ? String(cmd.agentId) : undefined);
          break;
        case 'resume_action':
          await orch.resumeAction(cmd.action === 'continue' ? 'continue' : 'dismiss');
          break;
        case 'dismiss_limit':
          orch.dismissLimit();
          break;
        case 'review_action':
          await orch.reviewAction(String(cmd.taskId), cmd.action, String(cmd.note ?? ''));
          break;
        case 'set_gates':
          orch.setGates(Boolean(cmd.on));
          break;
        case 'resolve_request':
          await orch.resolveRequest(String(cmd.id), Boolean(cmd.approve), String(cmd.reason ?? ''));
          break;
        case 'merge':
          await orch.merge(String(cmd.agentId));
          break;
        case 'sync':
          await orch.sync(String(cmd.agentId));
          break;
        case 'get_diff':
          send({ type: 'diff', diff: await orch.diff(String(cmd.agentId)) });
          break;
        case 'reset_usage':
          orch.resetUsage();
          break;
        // ── App helper ──
        case 'helper_send':
          helper.send(String(cmd.text ?? ''), cmd.attachments).catch((e) => send({ type: 'helper_error', error: e.message }));
          break;
        case 'helper_stop':
          helper.stop();
          break;
        case 'helper_edit':
          helper.setEditMode(Boolean(cmd.on));
          break;
        case 'helper_operate':
          helper.setOperate(Boolean(cmd.on));
          break;
        case 'helper_reset':
          helper.reset();
          break;
        case 'helper_diff':
          send({ type: 'helper_diff', diff: await helper.diff() });
          break;
        case 'helper_apply':
        case 'helper_undo':
          try {
            await (cmd.type === 'helper_apply' ? helper.apply(Boolean(cmd.force)) : helper.undo(Boolean(cmd.force)));
          } catch (e: any) {
            // 'busy' = agents are mid-turn; the UI asks before forcing a restart.
            send({ type: 'helper_error', error: e.message, busy: e.code === 'busy', retry: cmd.type });
          }
          break;
        case 'helper_discard':
          await helper.discard();
          break;
        case 'save_plan':
          await orch.savePlan(String(cmd.plan));
          break;
        case 'get_agent_config':
          send({ type: 'agent_config', agents: orch.agentConfigs(), adapters: ADAPTERS.filter((a) => a !== 'mock' || mock), hermesProfiles: hermesProfiles().names });
          break;
        case 'save_agent_config': {
          const agents = validateAgentConfigs(cmd.agents);
          const notes = await orch.setAgentConfigs(agents, () => saveAgentConfigs(agents));
          send({ type: 'agent_config_saved', notes });
          broadcast({ type: 'agent_config', agents: orch.agentConfigs(), adapters: ADAPTERS.filter((a) => a !== 'mock' || mock) });
          break;
        }
        case 'set_leader':
          orch.setLeader(String(cmd.leader));
          break;
        case 'set_phase':
          orch.setPhase(cmd.phase as Phase);
          break;
        case 'stop':
          orch.stop(String(cmd.agentId));
          break;
        case 'stop_all':
          orch.stopAll();
          break;
      }
    } catch (e) {
      console.warn(`command ${cmd?.type} failed: ${(e as Error).message}`);
      send({ type: 'error', error: (e as Error).message });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Thinktank Studio → http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}${mock ? '  (mock agents)' : ''}`);
  console.log(`Projects dir: ${projectsRoot()}`);
  void reopenLastProject();
});

/** The project open when the app last ran, so a restart (update, crash, reboot) lands back in it. */
const LAST_PROJECT = join(homedir(), '.thinktank', 'last-project.json');

/** Last project per projects folder, so a mock or test run in another folder doesn't replace the real one. */
function lastProjects(): Record<string, string> {
  try {
    const saved = JSON.parse(readFileSync(LAST_PROJECT, 'utf8'));
    if (typeof saved?.root === 'string' && typeof saved?.name === 'string') return { [saved.root]: saved.name }; // first version's format
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (e) {
    // None saved yet is normal; anything else only means no project reopens by itself.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Couldn't read ${LAST_PROJECT}: ${errText(e)}`);
    return {};
  }
}

function rememberProject(name: string): void {
  try {
    mkdirSync(dirname(LAST_PROJECT), { recursive: true });
    writeFileSync(LAST_PROJECT, JSON.stringify({ ...lastProjects(), [projectsRoot()]: name }, null, 2));
  } catch (e) {
    console.warn(`Couldn't remember the open project in ${LAST_PROJECT}: ${errText(e)}`); // only a convenience
  }
}

async function reopenLastProject(): Promise<void> {
  try {
    const name = lastProjects()[projectsRoot()];
    if (typeof name !== 'string' || orch.project || !(await listProjects()).includes(name)) return;
    await orch.open(name, false);
    broadcast({ type: 'projects', projects: await listProjects() });
    console.log(`Reopened project "${name}"`);
  } catch (e) {
    orch.warn(`The project you had open last couldn't be reopened: ${errText(e)}. Open it from the project list to try again.`);
  }
}
