/**
 * Checks each command the page sends over the WebSocket before the server acts on it: the type is
 * known, required fields are there, and every field has the right kind of value and a sane size.
 * A bad command is refused with a plain message to the page that sent it. Hand-written on purpose:
 * the shapes are small and flat, so a schema library would add weight without catching more.
 */

type Field =
  | { kind: 'string'; max: number; optional?: boolean; pattern?: RegExp; oneOf?: readonly string[]; nonEmpty?: boolean }
  | { kind: 'bool'; optional?: boolean }
  | { kind: 'int'; min: number; max: number; optional?: boolean }
  | { kind: 'object'; optional?: boolean }
  | { kind: 'strings'; maxItems: number; maxLength: number; optional?: boolean };

/** Agent ids (and 'user' / 'all' where those are allowed); whether the agent exists is checked later. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const id = (optional = false): Field => ({ kind: 'string', max: 64, pattern: ID, optional });
const str = (max: number, optional = true): Field => ({ kind: 'string', max, optional });
const name = (max = 200): Field => ({ kind: 'string', max, nonEmpty: true });
const oneOf = (values: readonly string[], optional = false): Field => ({ kind: 'string', max: 32, oneOf: values, optional });
const bool = (optional = false): Field => ({ kind: 'bool', optional });
const obj = (): Field => ({ kind: 'object' });
const attachments: Field = { kind: 'strings', maxItems: 20, maxLength: 200, optional: true };

export const MAX_CHAT_TEXT = 200_000;
export const MAX_PLAN_TEXT = 2_000_000;

/** Every command the page can send, and its fields. Fields not listed are ignored. */
const COMMANDS: Record<string, Record<string, Field>> = {
  create_project: { name: name(100) },
  open_project: { name: name(100) },
  load_earlier: { before: name(200) },
  send: { text: str(MAX_CHAT_TEXT), to: id(true), attachments },
  debate: { text: { kind: 'string', max: MAX_CHAT_TEXT, nonEmpty: true }, attachments },
  set_settings: { agentId: id(), settings: obj() },
  set_autopilot: { on: bool() },
  set_roles_enabled: { on: bool() },
  set_role: { agentId: id(), assignment: obj() },
  set_review_mode: { mode: oneOf(['off', 'chain', 'cross']) },
  set_test_command: { command: str(4000) },
  set_desktop_test_command: { command: str(4000) },
  desktop_tests: { action: oneOf(['run', 'skip', 'cancel']), taskId: str(200) },
  apply_preset: { name: name(100) },
  save_preset: { name: name(100) },
  delete_preset: { name: name(100) },
  refresh_branches: {},
  add_comment: {
    agentId: id(),
    file: name(1000),
    line: { kind: 'int', min: 0, max: 10_000_000 },
    side: oneOf(['old', 'new'], true),
    lineText: str(10_000),
    text: { kind: 'string', max: 20_000, nonEmpty: true },
  },
  comment_action: { id: name(200), action: oneOf(['delete', 'resolve', 'reopen']) },
  send_comments: { agentId: id() },
  stall_action: { agentId: id(), action: oneOf(['nudge', 'stop', 'wait']) },
  set_agent_enabled: { agentId: id(), on: bool() },
  clear_out_of_usage: { agentId: id() },
  dismiss_needs_you: { agentId: id(true) },
  resume_action: { action: oneOf(['continue', 'dismiss']) },
  dismiss_limit: {},
  review_action: { taskId: name(200), action: oneOf(['approve', 'send_back', 'restart', 'reassign', 'set_owner']), note: str(20_000) },
  set_gates: { on: bool() },
  resolve_request: { id: name(200), approve: bool(), reason: str(20_000) },
  merge: { agentId: id() },
  sync: { agentId: id() },
  get_diff: { agentId: id() },
  reset_usage: {},
  helper_send: { text: str(MAX_CHAT_TEXT), attachments },
  helper_stop: {},
  helper_edit: { on: bool() },
  helper_operate: { on: bool() },
  helper_reset: {},
  helper_diff: {},
  helper_apply: { force: bool(true) },
  helper_undo: { force: bool(true) },
  helper_discard: {},
  save_plan: { plan: str(MAX_PLAN_TEXT, false) },
  get_agent_config: {},
  save_agent_config: { agents: { kind: 'object' } },
  set_leader: { leader: id() },
  set_phase: { phase: oneOf(['plan', 'build', 'review']) },
  stop: { agentId: id() },
  stop_all: {},
};

export const COMMAND_TYPES = Object.keys(COMMANDS);

/** A command that passed validateCommand: its fields have the kinds COMMANDS lists. */
export type Command = { type: string } & Record<string, any>;

export type Checked = { ok: true; cmd: Command } | { ok: false; error: string };

const fmt = (n: number) => n.toLocaleString('en-US');

function checkField(key: string, f: Field, v: unknown): string | undefined {
  if (v === undefined || v === null) return f.optional ? undefined : `"${key}" is missing`;
  switch (f.kind) {
    case 'string':
      if (typeof v !== 'string') return `"${key}" must be text`;
      if (v.length > f.max) return `"${key}" is too long (over ${fmt(f.max)} characters)`;
      if (f.nonEmpty && !v.trim()) return `"${key}" is empty`;
      if (f.oneOf && !f.oneOf.includes(v)) return `"${key}" must be one of: ${f.oneOf.join(', ')}`;
      if (f.pattern && !f.pattern.test(v)) return `"${key}" isn't a valid id`;
      return undefined;
    case 'bool':
      return typeof v === 'boolean' ? undefined : `"${key}" must be true or false`;
    case 'int':
      return Number.isInteger(v) && (v as number) >= f.min && (v as number) <= f.max ? undefined : `"${key}" must be a whole number from ${f.min} to ${fmt(f.max)}`;
    case 'object':
      return typeof v === 'object' ? undefined : `"${key}" must be an object or a list`;
    case 'strings':
      if (!Array.isArray(v)) return `"${key}" must be a list`;
      if (v.length > f.maxItems) return `"${key}" has too many items (over ${f.maxItems})`;
      return v.every((x) => typeof x === 'string' && x.length <= f.maxLength) ? undefined : `"${key}" must be a list of short names`;
  }
}

/** Parse and check one raw WebSocket message from the page. */
export function validateCommand(raw: string): Checked {
  let cmd: unknown;
  try {
    cmd = JSON.parse(raw);
  } catch {
    // Reported to the page below.
    return { ok: false, error: "The app couldn't read a request from this page. Reload the page and try again." };
  }
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return { ok: false, error: "The app couldn't read a request from this page. Reload the page and try again." };
  const type = (cmd as { type?: unknown }).type;
  const fields = typeof type === 'string' && Object.hasOwn(COMMANDS, type) ? COMMANDS[type] : undefined;
  if (!fields) {
    const shown = typeof type === 'string' ? `"${type.slice(0, 40)}"` : 'with no type';
    return { ok: false, error: `The app doesn't know the request ${shown}. If you just updated the app, reload the page.` };
  }
  for (const [key, f] of Object.entries(fields)) {
    const problem = checkField(key, f, (cmd as Record<string, unknown>)[key]);
    if (problem) return { ok: false, error: `The app refused a "${type}" request: ${problem}.` };
  }
  return { ok: true, cmd: cmd as Command };
}
