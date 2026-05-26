/**
 * Core agent runner — tool-calling loop shared by all specialist agents.
 *
 * v4 enhancements:
 * - Error-recovery loop: when run_test / run_command fails, auto-calls fix_errors + retries (up to 2×)
 * - Structured tool-result parsing: detects test failures, build errors, type errors
 * - Retry ALL non-destructive tool calls on ❌ result (configurable)
 * - File-change tracking: extracts written/modified paths from tool results
 * - autoSaveDecisions: broader patterns, saves more architectural context
 * - onFileChange callback surfaced to orchestrator + TUI
 */

import { callModel, callModelPlain, accumulateUsage, emptyStats, type Message } from '../agent.js';
import { executeTool } from '../tools/index.js';
import { saveMemory } from '../memory/index.js';
import { compressIfNeeded } from '../context/compressor.js';
import type { AgentRole, AgentResult, AgentRunOptions } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// File-change tracking
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'move_file', 'delete_file',
  'create_folder', 'smart_commit', 'rollback_to',
]);

function extractWrittenFile(toolName: string, args: Record<string, unknown>, result: string): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  if (result.startsWith('❌')) return null;
  const p = (args['path'] ?? args['destination'] ?? args['source']) as string | undefined;
  if (p && typeof p === 'string') return p;
  const m = result.match(/(?:Wrote|Edited|Moved|Created|Deleted)\s+([^\s(]+)/);
  return m?.[1] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool result classification
// ─────────────────────────────────────────────────────────────────────────────

interface ToolResult {
  raw: string;
  isError: boolean;
  isTestFailure: boolean;
  isBuildError: boolean;
  isTypeError: boolean;
  isLintError: boolean;
}

function classifyToolResult(toolName: string, result: string): ToolResult {
  const isError = result.startsWith('❌') || result.toLowerCase().includes('error:') || result.toLowerCase().includes('failed');
  const isTestFailure = isError && /\b(test|spec|fail|FAIL|FAILED|assertion|assert|expected|received)\b/.test(result);
  const isBuildError = isError && /\b(build|compile|syntax|unexpected token|cannot find module)\b/i.test(result);
  const isTypeError = isError && /\b(TS\d+|type error|is not assignable|does not exist|property .* missing)\b/i.test(result);
  const isLintError = isError && /\b(eslint|prettier|pylint|flake8|ruff|golangci)\b/i.test(result);

  return { raw: result, isError, isTestFailure, isBuildError, isTypeError, isLintError };
}

// Tools safe to retry (idempotent or side-effectful only on success)
function isRetryable(toolName: string): boolean {
  const NO_RETRY = new Set(['write_file', 'delete_file', 'rollback_to', 'smart_commit', 'ask_user']);
  return !NO_RETRY.has(toolName);
}

// Test/build tools that may benefit from auto-fix
const FIXABLE_TOOLS = new Set(['run_test', 'run_command', 'run_tests', 'fix_linting_errors', 'fix_test_failures']);

async function executeToolWithRetry(
  name: string,
  args: Record<string, unknown>,
  maxAttempts = 3,
): Promise<string> {
  let lastResult = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await executeTool(name, args);
    const classified = classifyToolResult(name, lastResult);
    if (!classified.isError || !isRetryable(name) || attempt === maxAttempts) return lastResult;
    const delay = 500 * Math.pow(2, attempt - 1);
    await new Promise(r => setTimeout(r, delay));
  }
  return lastResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error-recovery injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When a test/build tool fails, automatically inject a fix_errors call into
 * the tool results so the LLM sees the error analysis in the next turn.
 */
async function tryAutoFix(
  toolName: string,
  result: string,
  history: Message[],
  maxAutoFixes: number,
  autoFixCount: { n: number },
): Promise<string | null> {
  if (!FIXABLE_TOOLS.has(toolName)) return null;
  const classified = classifyToolResult(toolName, result);
  if (!classified.isError) return null;
  if (autoFixCount.n >= maxAutoFixes) return null;

  // Only auto-fix clear error patterns — not generic command failures
  if (!classified.isTestFailure && !classified.isBuildError && !classified.isTypeError) return null;

  autoFixCount.n++;

  // Run fix_errors tool with the failed output
  const fixResult = await executeTool('fix_errors', {
    error_output: result.slice(0, 4000),
    context: `Output of tool: ${toolName}`,
  });

  return `\n[AUTO-FIX ANALYSIS for ${toolName} failure]\n${fixResult}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-task helpers
// ─────────────────────────────────────────────────────────────────────────────

async function summarizeChanges(history: Message[], role: AgentRole, filesChanged: string[]): Promise<string> {
  const recentMsgs = history
    .filter(m => m.role !== 'system')
    .slice(-24)
    .map(m => {
      const content = typeof m.content === 'string' ? m.content.slice(0, 400) : '';
      return `[${m.role.toUpperCase()}]: ${content}`;
    })
    .join('\n');

  const fileList = filesChanged.length > 0
    ? `\nFiles modified: ${filesChanged.slice(0, 8).join(', ')}`
    : '';

  try {
    return await callModelPlain(
      `You are a precise technical summarizer. In 2–3 sentences, summarize this ${role} agent session: which files were created/modified, the key decisions made, and the final outcome. Name exact file paths.${fileList}`,
      recentMsgs,
      'deepseek-chat',
    );
  } catch {
    return `${role} agent completed.${fileList}`;
  }
}

const DECISION_PATTERNS = [
  /\bI('ll| will) (use|choose|go with|implement|adopt|switch to)\b/i,
  /\barchitect(ure|ural)?\b.*\bdecision\b/i,
  /\bapproach\b.*\b(is|will be|chosen|selected)\b/i,
  /\bpattern\b.*\b(applied|used|chosen)\b/i,
  /\busing\s+(postgres|mysql|redis|prisma|drizzle|nextjs|express|fastapi|django|rails|go|rust)\b/i,
  /\bdecided\s+to\b/i,
  /\bwill\s+(use|implement|rely on|depend on)\b/i,
];

function looksLikeDecision(text: string): boolean {
  return DECISION_PATTERNS.some(re => re.test(text));
}

async function autoSaveDecisions(history: Message[], role: AgentRole): Promise<void> {
  const assistantMessages = history
    .filter(m => m.role === 'assistant' && typeof m.content === 'string')
    .slice(-8);

  for (const msg of assistantMessages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > 80 && looksLikeDecision(content)) {
      const id = `${role}-decision-${Date.now()}`;
      saveMemory({ id, tag: 'decision', content: content.slice(0, 500) });
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgent(
  role: AgentRole,
  task: string,
  systemPrompt: string,
  options: AgentRunOptions = {},
): Promise<AgentResult> {
  const maxIterations = options.maxIterations ?? 25;
  const maxAutoFixes = options.maxAutoFixes ?? 2;  // max auto fix_errors injections per session
  const autoFixCount = { n: 0 };

  let history: Message[] = [
    { role: 'system', content: systemPrompt + (options.extraContext ?? '') },
    { role: 'user', content: task },
  ];

  let stats = emptyStats();
  let finalOutput = '';
  let finalReasoning: string | undefined;
  const filesChanged: string[] = [];

  options.onProgress?.(role, 'Starting…');

  for (let iter = 0; iter < maxIterations; iter++) {
    history = await compressIfNeeded(history);

    const resp = await callModel(history, options.model);
    stats = accumulateUsage(stats, resp.usage, (options.model ?? 'deepseek-chat') as any);

    const msg = resp.message;
    history.push(msg);

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content) {
      finalOutput = content;
      finalReasoning = resp.reasoning;
    }

    const toolCalls = (msg as any).tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }> | undefined;

    if (!toolCalls?.length) break;

    options.onProgress?.(role, `Running ${toolCalls.length} tool(s)…`);

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); }
      catch { args = { raw: tc.function.arguments }; }

      options.onToolCall?.(role, tc.function.name);
      const result = await executeToolWithRetry(tc.function.name, args);
      options.onToolCall?.(role, tc.function.name, result);

      // Track file changes
      const changedFile = extractWrittenFile(tc.function.name, args, result);
      if (changedFile && !filesChanged.includes(changedFile)) {
        filesChanged.push(changedFile);
        options.onFileChange?.(changedFile);
      }

      // Auto-inject error analysis for test/build failures
      const autoFixAnalysis = await tryAutoFix(tc.function.name, result, history, maxAutoFixes, autoFixCount);
      const toolContent = autoFixAnalysis ? result + autoFixAnalysis : result;

      history.push({ role: 'tool', tool_call_id: tc.id, content: toolContent } as Message);
    }

    options.onProgress?.(role, 'Continuing…');
  }

  // Post-task: summarize and save decisions
  if (options.autoSummarize !== false && finalOutput) {
    const summary = await summarizeChanges(history, role, filesChanged);
    await autoSaveDecisions(history, role);
    finalOutput = finalOutput + (summary ? `\n\n---\n*Summary: ${summary}*` : '');
  }

  return { role, output: finalOutput, reasoning: finalReasoning, usage: stats, filesChanged };
}
