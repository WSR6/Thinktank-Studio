import type { AgentAdapter, AgentConfig } from '../types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GenericAdapter } from './generic.js';
import { GrokAdapter } from './grok.js';
import { HermesAdapter } from './hermes-acp.js';
import { MockAdapter } from './mock.js';

export function createAdapter(cfg: AgentConfig, mock: boolean): AgentAdapter {
  if (mock) return new MockAdapter(cfg);
  switch (cfg.adapter) {
    case 'claude': return new ClaudeAdapter(cfg);
    case 'codex': return new CodexAdapter(cfg);
    case 'grok': return new GrokAdapter(cfg);
    case 'hermes': return new HermesAdapter(cfg);
    case 'generic': return new GenericAdapter(cfg);
    case 'mock': return new MockAdapter(cfg);
  }
}
