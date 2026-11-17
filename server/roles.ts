import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadJsonFile, mayWrite } from './safe-json.js';

/**
 * Optional roles for agents (off by default). When on, each agent's turn says what its job is,
 * and the review chain uses them: builder → first reviewer → final reviewer → tests.
 * Saved setups ("presets") let you swap the whole team around in one click, e.g. when an agent
 * runs out of usage. They're stored per user (not per project) so they work in every project.
 */

export type Role = 'none' | 'builder' | 'first_reviewer' | 'final_reviewer' | 'tester' | 'arbiter' | 'custom';
export const ROLES: Role[] = ['none', 'builder', 'first_reviewer', 'final_reviewer', 'tester', 'arbiter', 'custom'];

/** How finished tasks get checked. 'chain' follows the roles; 'cross' = any other agent reviews once. */
export type ReviewMode = 'off' | 'chain' | 'cross';
export const REVIEW_MODES: ReviewMode[] = ['off', 'chain', 'cross'];

export interface RoleAssignment {
  role: Role;
  /** The duty text for role 'custom'. */
  custom?: string;
}

export interface RolesState {
  enabled: boolean;
  assignments: Record<string, RoleAssignment>;
}

export interface Preset {
  name: string;
  roles: Record<string, RoleAssignment>;
  leader?: string;
  review?: ReviewMode;
  /** Optional model per agent, e.g. { codex: 'gpt-6-astra' }. Agents not listed keep their model. */
  models?: Record<string, string>;
}

export const ROLE_LABELS: Record<Role, string> = {
  none: 'No role',
  builder: 'Builder',
  first_reviewer: 'First reviewer',
  final_reviewer: 'Final reviewer',
  tester: 'Tester',
  arbiter: 'Arbiter',
  custom: 'Custom',
};

/** One line each agent sees every turn, so a role change takes effect on its very next turn. */
export const ROLE_DUTIES: Record<Exclude<Role, 'none' | 'custom'>, string> = {
  builder: 'You build: implement the tasks you own, run the tests, commit, then mark them done. Reviewers will check your work.',
  first_reviewer:
    "You are the first reviewer: when asked to review a teammate's finished task, check it thoroughly for bugs, missing pieces and mismatches with the plan. Don't edit their code.",
  final_reviewer:
    "You are the final reviewer: the last, strictest check before a task is accepted. Look for what the builder and first reviewer missed. Don't edit their code.",
  tester: "You test: write and run tests for teammates' work and report failures precisely, with steps to reproduce.",
  arbiter: 'You are the arbiter: when two teammates’ branches conflict, you resolve it impartially, keeping what each side intended.',
};

export function dutyOf(a: RoleAssignment | undefined): string {
  if (!a || a.role === 'none') return '';
  if (a.role === 'custom') return a.custom?.trim() ?? '';
  return ROLE_DUTIES[a.role];
}

// ── Saved setups ───────────────────────────────────────────────────────

const PRESETS_FILE = join(homedir(), '.thinktank', 'role-presets.json');

/** First-run example matching a common setup; edit or delete it in the app. */
const SEED: Preset[] = [
  {
    name: 'Starter team',
    leader: 'claude',
    review: 'chain',
    roles: { claude: { role: 'builder' }, grok: { role: 'first_reviewer' }, codex: { role: 'final_reviewer' } },
    models: { claude: 'claude-opus-5-5', codex: 'gpt-6-astra' },
  },
];

/** Saved setups; the built-in ones when there's no file. A damaged file is moved aside (onProblem tells the user). */
export function loadPresets(onProblem: (text: string) => void = () => {}): Preset[] {
  const { value, problem } = loadJsonFile<Preset[] | undefined>(PRESETS_FILE, undefined, {
    label: 'Your saved setups file (.thinktank/role-presets.json in your home folder)',
    what: 'the built-in setups are shown instead',
    valid: Array.isArray,
  });
  if (problem) onProblem(problem);
  return value ? value.filter((p) => p && typeof p.name === 'string' && p.roles) : SEED;
}

export function savePresets(presets: Preset[]): void {
  if (!mayWrite(PRESETS_FILE)) throw new Error("Your saved setups file couldn't be read or kept aside, so it isn't saved over. Fix or delete .thinktank/role-presets.json in your home folder, then restart the app.");
  mkdirSync(join(homedir(), '.thinktank'), { recursive: true });
  writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
}

/** Validate a role assignment coming from the browser. */
export function cleanAssignment(a: any): RoleAssignment {
  const role: Role = ROLES.includes(a?.role) ? a.role : 'none';
  return role === 'custom' ? { role, custom: String(a?.custom ?? '').slice(0, 500) } : { role };
}
