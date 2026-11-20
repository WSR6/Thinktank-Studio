export type AgentId = string;
export type Phase = 'plan' | 'build' | 'review';
export type AgentStatus = 'idle' | 'working' | 'error';
/** How much an agent may do without asking. Mapped to each CLI's own permission flags. */
export type Autonomy = 'read' | 'edits' | 'auto' | 'full';
export type AdapterKind = 'claude' | 'codex' | 'grok' | 'hermes' | 'generic' | 'mock';

export interface AgentSettings {
  /** Empty = the CLI's own default. */
  model: string;
  effort: string;
  autonomy: Autonomy;
  /** Hermes only: the profile to run as (`hermes -p <name>`). Empty = Hermes's own sticky profile. */
  profile?: string;
}

export interface ChatMessage {
  id: string;
  ts: number;
  from: 'user' | 'system' | AgentId;
  /** 'all' = shared room, otherwise a private DM to one agent. */
  to: 'all' | AgentId;
  text: string;
  /** Attached file names (images or text) in the project's team/attachments folder. */
  attachments?: string[];
  /** A question between agents ([[ask]]) or its answer: already handled, so it doesn't set who a later turn replies to. */
  ask?: boolean;
}

/** Normalized live activity from any CLI, shown in the agent's panel. */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  /** A tool call finished (or failed). `text` is the activity-log line; lets the stall watchdog stop timing it. */
  | { kind: 'tool_end'; name: string; ok: boolean; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'status'; status: AgentStatus }
  /** The CLI started (or resumed) this conversation id; saved right away so a cut-off first turn can be resumed. */
  | { kind: 'session'; id: string }
  /** The CLI's plan usage windows (5-hour, weekly), as it last reported them. */
  | { kind: 'limits'; windows: LimitWindow[] };

/** One plan usage window: how much is used and when it resets. */
export interface LimitWindow {
  /** '5h', 'week', or the window length in minutes when it's something else. */
  name: string;
  /** 0–100. */
  usedPct: number;
  /** Epoch ms. */
  resetsAt: number;
}

export interface AgentConfig {
  id: AgentId;
  name: string;
  adapter: AdapterKind;
  command: string;
  /** Extra CLI args appended every turn. Generic adapter supports a {prompt} placeholder. */
  args?: string[];
  /** Generic adapter only: how the prompt is delivered. Default 'stdin' unless args contain {prompt}. */
  promptVia?: 'stdin' | 'arg';
  /** Defaults for the per-agent pickers; changeable in the UI per project. */
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  /** Hermes only: default profile (one of `hermes profile list`); each profile has its own default model. */
  profile?: string;
  /** Commands pre-approved at the "edits" level (default: git, npm, node, python, cargo, go, make…). */
  allowCommands?: string[];
  color?: string;
  /**
   * Codex only: a model server's address, e.g. http://192.168.1.50:1234/v1 (LM Studio, Ollama, llama.cpp
   * or any server with the OpenAI Responses API). Codex then runs `model` from that server instead of OpenAI.
   */
  server?: string;
  /** Minutes without output before the app says this agent may be stuck. Default 6, or 30 with a model server. */
  stuckMinutes?: number;
}

export interface TurnOptions {
  prompt: string;
  cwd: string;
  /** Extra dirs the agent may write to: the shared team dir and the repo's .git (worktree commits). */
  extraDirs: string[];
  /** Images attached to the new messages in this turn (absolute paths). */
  images?: string[];
  /** Dirs the agent may read but not change (the App helper looking at a project). */
  readDirs?: string[];
  settings: AgentSettings;
  sessionId?: string;
  onEvent: (e: AgentEvent) => void;
}

/** Token usage for one turn. Providers count input differently (cached included or not), so treat as approximate. */
export interface TurnUsage {
  input: number;
  output: number;
  cached: number;
  /** Only when the CLI reports it (Claude, Grok). Codex reports tokens only. */
  costUsd?: number;
}

export interface TurnResult {
  text: string;
  sessionId?: string;
  usage?: TurnUsage;
}

export interface Turn {
  done: Promise<TurnResult>;
  kill(): void;
  /** The CLI's process, so one left running by a crash can be ended before its turn is resumed. */
  pid?: number;
}

export interface AgentAdapter {
  /** True if the CLI keeps its own conversation (we only send new messages each turn). */
  readonly supportsResume: boolean;
  runTurn(opts: TurnOptions): Turn;
}
