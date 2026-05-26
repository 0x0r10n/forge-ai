import type { Message, UsageStats } from '../agent.js';

export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'solo';

export interface AgentResult {
  role: AgentRole;
  output: string;
  reasoning?: string;
  usage: UsageStats;
  /** Files written/modified during this agent run */
  filesChanged: string[];
}

export interface AgentRunOptions {
  model?: string;
  maxIterations?: number;
  /** Max automatic fix_errors injections per agent session (default: 2) */
  maxAutoFixes?: number;
  systemPrompt?: string;
  extraContext?: string;
  autoSummarize?: boolean;
  /** Callback fired after each message exchange so the TUI can show progress. */
  onProgress?: (role: AgentRole, status: string) => void;
  /** Callback fired when a tool is being called. */
  onToolCall?: (role: AgentRole, toolName: string, result?: string) => void;
  /** Callback fired when a file is written or modified. */
  onFileChange?: (file: string) => void;
}
