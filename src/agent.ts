import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { type Config, type ModelId, computeCost, REASONER_MODELS, routeModel } from './config.js';
import { TOOL_DEFINITIONS } from './tools/index.js';

export type Message = ChatCompletionMessageParam;

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalCost: number;
  iterations: number;
}

export interface ModelResponse {
  message: Message;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
  };
  reasoning?: string;
}

let _agent: { client: OpenAI; config: Config } | null = null;

function getAgent(): { client: OpenAI; config: Config } {
  if (!_agent) throw new Error('Agent not initialized. Call initAgent() first.');
  return _agent;
}

export function initAgent(config: Config): void {
  _agent = {
    config,
    client: new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://api.deepseek.com/v1',
      timeout: 120_000,
      maxRetries: 0, // we handle retries ourselves for better control
    }),
  };
}

export const SYSTEM_PROMPT = `You are Forge AI — an elite, autonomous software engineering agent with deep expertise across all languages, frameworks, and system design patterns.

## Core Philosophy
- Think before acting: analyze the task, identify what information you need, then execute efficiently
- Prefer editing existing files over creating new ones when appropriate
- Always read files before writing them to understand context
- When in doubt about scope, do less and ask — but when the task is clear, act decisively
- Leave code BETTER than you found it: fix obvious issues you notice along the way

## Tool Usage
- Use read_file to examine files before modifying them; use semantic_search to find relevant code fast
- Use list_dir to explore project structure first
- Use search_code (grep) to find definitions, usages, and patterns across the codebase
- Use run_command for: tests, builds, linting, git operations, package installs
- Use write_file only when you have the complete, correct content to write; prefer edit_file for surgical changes
- Chain tools efficiently — don't wait unnecessarily between related operations
- Use recall_memory at the start of a task to retrieve relevant prior context
- Use save_memory after architecture decisions, major changes, or learning something important about the project
- Use create_checkpoint before any large refactor or destructive change so work can be rolled back
- Use git_diff to understand pending changes before committing
- Use smart_commit to create a well-formatted conventional-commits message automatically
- Use run_test to execute the project's test suite after making changes
- Use ask_user when a decision requires human input and cannot be safely inferred

## Code Quality Standards
- Write idiomatic, clean, well-typed code following the project's existing conventions
- Add meaningful comments for non-obvious logic
- Handle errors gracefully with proper types
- Follow SOLID principles and avoid premature optimization
- Prefer composition over inheritance

## Communication
- Be concise in explanations but thorough in implementation
- Show your reasoning for non-obvious decisions
- If a task is ambiguous, state your interpretation and proceed
- Report what you actually did, not what you planned to do
- Cite file paths when referring to specific code

## Safety
- Never delete files without explicit instruction
- Never commit or push without explicit instruction
- Use ask_user for destructive or irreversible operations before proceeding
- For dangerous shell commands (rm -rf, sudo, etc.) always use ask_user first

You have access to the full filesystem and shell. Use your power wisely.`;

// ─────────────────────────────────────────────────────────────────────────────
// Retry with exponential backoff
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.statusCode;
      const isRetryable = RETRYABLE_CODES.has(status) || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT';
      if (!isRetryable || i === attempts - 1) throw err;
      const delay = baseDelayMs * Math.pow(2, i) + Math.random() * 200;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model call
// ─────────────────────────────────────────────────────────────────────────────

export async function callModel(
  messages: Message[],
  modelOverride?: string,
  toolsOverride?: ChatCompletionTool[],
): Promise<ModelResponse> {
  const { client, config: cfg } = getAgent();
  const model = (modelOverride ?? cfg.defaultModel) as ModelId;
  const tools = toolsOverride ?? (TOOL_DEFINITIONS as ChatCompletionTool[]);

  const createParams: Parameters<typeof client.chat.completions.create>[0] = {
    model,
    messages,
    max_tokens: cfg.maxTokens,
    tools,
    tool_choice: 'auto',
    stream: false,
    ...(REASONER_MODELS.has(model) ? {} : { temperature: cfg.temperature }),
  };

  const response = await withRetry(() =>
    client.chat.completions.create(createParams) as Promise<OpenAI.Chat.Completions.ChatCompletion>
  );

  const choice = response.choices[0];
  if (!choice) throw new Error('No choices returned from model');
  const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0 };

  return {
    message: choice.message as Message,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cached_tokens: (usage as any).prompt_cache_hit_tokens ?? 0,
    },
    reasoning: (choice.message as any).reasoning_content ?? undefined,
  };
}

/** One-shot call with no tools — for summaries, analysis, PR descriptions, etc. */
export async function callModelPlain(
  systemPrompt: string,
  userPrompt: string,
  modelOverride?: string,
): Promise<string> {
  const { config: cfg } = getAgent();
  const model = modelOverride ?? 'deepseek-chat'; // always use fast model for utility calls
  const resp = await callModel(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model,
    [],  // no tools
  );
  return typeof resp.message.content === 'string' ? resp.message.content : '';
}

/** Route to best model for the task if autoRoute is enabled. */
export function selectModel(task: string, forceModel?: string): ModelId {
  const { config: cfg } = getAgent();
  if (forceModel) return forceModel as ModelId;
  if (cfg.autoRouteModels) return routeModel(task, cfg.defaultModel);
  return cfg.defaultModel;
}

export function accumulateUsage(
  stats: UsageStats,
  usage: ModelResponse['usage'],
  model: ModelId,
): UsageStats {
  return {
    inputTokens:  stats.inputTokens  + usage.input_tokens,
    outputTokens: stats.outputTokens + usage.output_tokens,
    cachedTokens: stats.cachedTokens + usage.cached_tokens,
    totalCost:    stats.totalCost    + computeCost(model, usage.input_tokens, usage.output_tokens, usage.cached_tokens),
    iterations:   stats.iterations   + 1,
  };
}

export function emptyStats(): UsageStats {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, iterations: 0 };
}
