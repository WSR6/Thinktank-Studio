import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COMMAND_TYPES, MAX_CHAT_TEXT, validateCommand } from '../server/commands.js';

const ok = (cmd: unknown) => {
  const r = validateCommand(JSON.stringify(cmd));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
};
const refused = (raw: unknown, match: RegExp) => {
  const r = validateCommand(typeof raw === 'string' ? raw : JSON.stringify(raw));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, match);
};

test('validateCommand accepts what the page sends', () => {
  ok({ type: 'send', text: 'hello', to: 'all', attachments: ['a1b2.png'] });
  ok({ type: 'send', text: 'hi', to: 'claude' });
  ok({ type: 'set_settings', agentId: 'codex', settings: { model: 'x' } });
  ok({ type: 'set_role', agentId: 'grok', assignment: { role: 'builder', custom: '' } });
  ok({ type: 'add_comment', agentId: 'claude', file: 'src/a.ts', line: 12, side: 'new', lineText: 'x', text: 'why?' });
  ok({ type: 'resolve_request', id: 'r1', approve: false, reason: null });
  ok({ type: 'desktop_tests', action: 'cancel' });
  ok({ type: 'dismiss_needs_you' });
  ok({ type: 'helper_apply', force: true });
  ok({ type: 'save_agent_config', agents: [] });
  ok({ type: 'set_leader', leader: 'user' });
  ok({ type: 'stop_all', extra: 'ignored' });
});

test('validateCommand refuses bad JSON, unknown types and wrong shapes, with plain messages', () => {
  refused('{not json', /couldn't read a request/);
  refused('[1,2]', /couldn't read a request/);
  refused('null', /couldn't read a request/);
  refused({ type: 'rm_rf' }, /doesn't know the request "rm_rf"/);
  refused({ type: 'toString' }, /doesn't know the request/);
  refused({ text: 'no type' }, /with no type/);
  refused({ type: 'open_project' }, /"name" is missing/);
  refused({ type: 'open_project', name: '   ' }, /"name" is empty/);
  refused({ type: 'open_project', name: 42 }, /"name" must be text/);
  refused({ type: 'send', text: 'x'.repeat(MAX_CHAT_TEXT + 1) }, /"text" is too long \(over 200,000 characters\)/);
  refused({ type: 'send', text: 'x', to: '../etc' }, /"to" isn't a valid id/);
  refused({ type: 'set_autopilot', on: 'yes' }, /"on" must be true or false/);
  refused({ type: 'set_phase', phase: 'ship' }, /"phase" must be one of: plan, build, review/);
  refused({ type: 'add_comment', agentId: 'a', file: 'f', line: 1.5, text: 't' }, /"line" must be a whole number/);
  refused({ type: 'add_comment', agentId: 'a', file: 'f', line: null, text: 't' }, /"line" is missing/);
  refused({ type: 'send', text: 'x', attachments: 'a.png' }, /"attachments" must be a list/);
  refused({ type: 'send', text: 'x', attachments: [{}] }, /list of short names/);
  refused({ type: 'set_settings', agentId: 'a', settings: 'model=x' }, /"settings" must be an object/);
  refused({ type: 'review_action', taskId: 't1', action: 'nuke' }, /"action" must be one of/);
});

test('every command type the validator knows is handled by the server', () => {
  const src = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  for (const type of COMMAND_TYPES) assert.ok(src.includes(`case '${type}':`), `server/index.ts has no case for "${type}"`);
});

test('every command the page sends is one the validator knows', () => {
  const page = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const sent = new Set([...page.matchAll(/send\(\{ type: '([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(sent.size > 30);
  for (const type of sent) assert.ok(COMMAND_TYPES.includes(type), `the page sends "${type}", which the server would refuse`);
});
