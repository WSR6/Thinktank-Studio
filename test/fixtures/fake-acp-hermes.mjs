// A fake `hermes acp` for tests: speaks just enough ACP. Every message it receives is appended to
// the file named by FAKE_ACP_LOG (one JSON line each), so tests can check what the app sent.
// Prompts: "EDIT <path>" asks permission to write <path>; "SLOW" waits for session/cancel.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.FAKE_ACP_LOG;
if (!process.argv.includes('acp')) process.exit(3); // `hermes chat` isn't faked
const known = new Set((process.env.FAKE_ACP_SESSIONS ?? '').split(',').filter(Boolean));
let n = 0;
let nextReq = 1000;
const waiting = new Map();
let cancel;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) => new Promise((res) => {
  const id = nextReq++;
  waiting.set(id, res);
  send({ id, method, params });
});

async function prompt(id, p) {
  const sid = p.sessionId;
  const text = p.prompt.find((b) => b.type === 'text')?.text ?? '';
  if (text.startsWith('/reasoning')) {
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reasoning effort set' } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (text.startsWith('SLOW')) {
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on it' } });
    await new Promise((r) => (cancel = r));
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  const m = /EDIT (\S+)/.exec(text);
  if (m) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: `write_file: ${m[1]}`, kind: 'edit', status: 'pending', locations: [{ path: m[1] }] });
    const answer = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 't1', kind: 'edit', title: `write_file: ${m[1]}`, locations: [{ path: m[1] }] },
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
    });
    const ok = answer?.outcome?.optionId === 'allow_once';
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: ok ? 'completed' : 'failed' });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ok ? 'wrote it' : 'was refused' } });
  } else {
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'there' } });
  }
  send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, totalTokens: 147 } } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, ...msg }) + '\n');
  if (!msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } });
    case 'session/new': {
      const sessionId = `s${++n}`;
      known.add(sessionId);
      return send({ id, result: { sessionId } });
    }
    case 'session/resume':
      return known.has(params.sessionId) ? send({ id, result: {} }) : send({ id, error: { code: -32002, message: 'Session not found' } });
    case 'session/set_config_option':
      return send({ id, result: { configOptions: [] } });
    case 'session/set_model':
      return send({ id, result: {} });
    case 'session/prompt':
      return void prompt(id, params);
    case 'session/cancel':
      return cancel?.();
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
