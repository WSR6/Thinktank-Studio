import type { AdapterKind, Autonomy } from '../types.js';

/**
 * How autonomy levels map to each CLI's flags, and fallback model / effort choices for when the
 * CLI's own model list can't be read (see models.ts). The picker accepts any id; '' = default.
 * Sources: `claude --help`; codex-rs models.json + exec CLI; Grok Build headless & permissions docs.
 */
export interface CatalogEntry {
  models: string[];
  efforts: string[];
  /** Models that accept fewer efforts than `efforts`. */
  modelEfforts?: Record<string, string[]>;
  autonomy: Record<Autonomy, string[]>;
}

/**
 * Commands the "edits" level may run without asking. Headless CLIs silently deny anything else,
 * so without these an agent can't run tests in BUILD. Override per agent with `allowCommands`.
 */
export const DEFAULT_ALLOW_COMMANDS = [
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pytest', 'pip', 'cargo', 'go', 'make',
  // PowerShell, which agents use on Windows for everyday file and output work (nothing that deletes).
  'Get-Content', 'Get-ChildItem', 'Get-Location', 'Select-String', 'Test-Path', 'Resolve-Path', 'Join-Path', 'Split-Path',
  'Write-Host', 'Write-Output', 'Out-String', 'Out-File', 'Set-Content', 'Add-Content', 'New-Item', 'Copy-Item', 'Move-Item',
  'Select-Object', 'Sort-Object', 'Where-Object', 'ForEach-Object', 'Measure-Object', 'Format-Table', 'Format-List',
  'ConvertFrom-Json', 'ConvertTo-Json',
];

/**
 * A project's own venv interpreter (tts.yaml setup makes `.venv`), allowed wherever `python` is. Bash forms only:
 * Claude's PowerShell tool won't pre-approve a program called by path (`.venv\Scripts\python`) under any rule.
 */
const VENV_PYTHONS = ['.venv/Scripts/python', '.venv/Scripts/python.exe', './.venv/Scripts/python', '.venv/bin/python', './.venv/bin/python'];

export const CATALOG: Partial<Record<AdapterKind, CatalogEntry>> = {
  claude: {
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    autonomy: {
      read: ['--permission-mode', 'plan'],
      edits: ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      full: ['--permission-mode', 'bypassPermissions'],
    },
  },
  codex: {
    models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    autonomy: {
      read: ['--sandbox', 'read-only'],
      edits: ['--sandbox', 'workspace-write'],
      auto: ['--approve-for-me'],
      full: ['--dangerously-bypass-approvals-and-sandbox'],
    },
  },
  grok: {
    models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    modelEfforts: { 'grok-4.5': ['low', 'medium', 'high'] },
    autonomy: {
      read: ['--permission-mode', 'plan'],
      edits: ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
      full: ['--yolo'],
    },
  },
  // Hermes has no permission modes: what it may do is set by its toolsets (-t). It has no truly read-only
  // file tool, so "read" leaves out the shell and code runner but can't stop file writes. Every level
  // leaves out desktop control, the browser, scheduled jobs, sub-agents and messaging.
  hermes: {
    models: [],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    autonomy: {
      // vision always on: Hermes freezes the toolset list per session, so adding it only for image turns would break resumes.
      read: ['-t', 'file,web,session_search,todo,skills,vision'],
      edits: ['-t', 'file,terminal,code_execution,web,session_search,todo,skills,memory,vision'],
      auto: ['-t', 'file,terminal,code_execution,web,session_search,todo,skills,memory,vision'],
      full: ['--yolo'],
    },
  },
};

/** Permission flags for a level; at "edits", also pre-approve the dev commands. */
export function autonomyArgs(kind: AdapterKind, level: Autonomy, allow: string[] = DEFAULT_ALLOW_COMMANDS): string[] {
  const base = CATALOG[kind]?.autonomy[level] ?? [];
  if (level !== 'edits' || !allow.length) return base;
  // `=` form: --allowedTools is variadic and would otherwise swallow the flags after it.
  // On Windows Claude runs commands through its PowerShell tool too, which Bash(...) rules don't cover.
  if (kind === 'claude') {
    const cmds = allow.includes('python') ? [...allow, ...VENV_PYTHONS] : allow;
    return [...base, `--allowedTools=${cmds.flatMap((c) => [`Bash(${c} *)`, `PowerShell(${c} *)`]).join(',')}`];
  }
  if (kind === 'grok') return [...base, ...allow.flatMap((c) => ['--allow', `Bash(${c}*)`])];
  return base; // codex: workspace-write already runs commands inside its sandbox
}
