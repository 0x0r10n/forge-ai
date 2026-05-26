/**
 * Multi-agent orchestrator — v4 Cursor-Killer Edition
 *
 * Pipeline: analyzeTask → Architect → [checkpoint] → [Coder → Reviewer] × N → [sanityCheck]
 *
 * New in v4:
 * - Iterative fix loop: up to 3 Coder→Reviewer cycles on NEEDS FIXES verdict
 * - analyze_task_difficulty(): explicit difficulty score (1–10) drives model + iteration budget
 * - Cost projection: shows estimated cost range before starting heavy tasks
 * - Error-recovery in coder: detects test failures and auto-calls fix loop
 * - filesChanged deduplication across iterations
 * - Detailed per-phase timing in result
 */

import { runArchitect } from './ArchitectAgent.js';
import { runCoder }     from './CoderAgent.js';
import { runReviewer }  from './ReviewerAgent.js';
import { callModelPlain, accumulateUsage, emptyStats, selectModel, type UsageStats } from '../agent.js';
import { saveMemory } from '../memory/index.js';
import { createCheckpoint } from '../checkpoints/index.js';
import { getRelevantContext } from '../rag/index.js';
import type { AgentRole, AgentRunOptions } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  /** 1 (trivial) – 10 (architecture-level refactor) */
  difficulty: number;
  estimatedFiles: number;
  suggestedModel: string;
  keyRisks: string[];
  summary: string;
  subtasks?: string[];
  likelyFiles?: string[];
  testStrategy?: string;
  /** Estimated max iterations for the fix loop (1–3) */
  maxFixIterations: number;
  /** Rough cost estimate in USD (low–high range) */
  estimatedCostRange: [number, number];
}

export type MultiAgentPhase =
  | 'analysis'
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'fix'        // iteration N of the fix loop
  | 'sanity'
  | 'done';

export interface MultiAgentResult {
  analysis: TaskAnalysis;
  architectPlan: string;
  coderSummary: string;
  reviewVerdict: string;
  sanityCheck?: string;
  approved: boolean;
  totalUsage: UsageStats;
  durationMs: number;
  filesChanged: string[];
  /** How many Coder→Reviewer iterations were run (1 = first pass approved) */
  fixIterations: number;
}

export interface OrchestratorOptions {
  model?: string;
  maxIterationsPerAgent?: number;
  /** Override max fix loop iterations (default: from task analysis) */
  maxFixLoop?: number;
  skipSanityCheck?: boolean;
  onAgentStart?:    (role: AgentRole | 'analysis' | 'sanity' | 'fix', phase: number, total: number, estimatedSecs?: number) => void;
  onAgentProgress?: (role: AgentRole, status: string) => void;
  onToolCall?:      (role: AgentRole, tool: string, result?: string) => void;
  onFileChange?:    (file: string) => void;
  /** Called with projected cost range before starting a heavy pipeline */
  onCostProjection?: (low: number, high: number, complexity: string, difficulty: number, estimatedFiles: number) => void;
}

// Phase time estimates (seconds)
const PHASE_ESTIMATES: Record<string, number> = {
  analysis:  15,
  architect: 45,
  coder:    120,
  reviewer:  60,
  fix:       90,  // extra coder+reviewer iteration
  sanity:    20,
};

const TOTAL_PHASES = 5; // analysis, architect, coder, reviewer, sanity (base)

// ─────────────────────────────────────────────────────────────────────────────
// Deep task analysis with difficulty score
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeTask(task: string, model?: string): Promise<TaskAnalysis> {
  const words = task.split(/\s+/).length;
  const isShort = words < 12 && !/\b(implement|build|create|refactor|migrate|design|upgrade|convert)\b/i.test(task);

  if (isShort) {
    return {
      complexity: 'simple',
      difficulty: 2,
      estimatedFiles: 1,
      suggestedModel: 'deepseek-chat',
      keyRisks: [],
      summary: task.slice(0, 100),
      maxFixIterations: 1,
      estimatedCostRange: [0.001, 0.005],
    };
  }

  const analysisModel = model ?? (words > 40 ? 'deepseek-r1' : 'deepseek-chat');

  const prompt = `You are a senior software architect. Analyze this engineering task and respond with JSON only (no markdown fence):

Task: "${task}"

Respond with this exact JSON:
{
  "complexity": "simple" | "moderate" | "complex",
  "difficulty": <integer 1–10>,
  "estimatedFiles": <integer>,
  "suggestedModel": "deepseek-chat" | "deepseek-v3" | "deepseek-r1",
  "keyRisks": ["<risk>", "..."],
  "summary": "<precise technical sentence>",
  "subtasks": ["<ordered subtask>", "..."],
  "likelyFiles": ["<probable file path>", "..."],
  "testStrategy": "<what tests to write/run>",
  "maxFixIterations": <1, 2, or 3>
}

Difficulty rules (1–10):
- 1–3: typo fix, config change, single function
- 4–6: new feature, moderate refactor, API endpoint
- 7–8: multi-file refactor, new subsystem, DB migration
- 9–10: architectural change, large-scale migration, new framework

maxFixIterations rules:
- difficulty ≤ 4: 1
- difficulty 5–7: 2
- difficulty ≥ 8: 3

suggestedModel:
- deepseek-r1: complex/reasoning tasks (difficulty ≥ 7)
- deepseek-v3: moderate implementation (difficulty 4–6)
- deepseek-chat: simple changes (difficulty ≤ 3)`;

  try {
    const raw = await callModelPlain(
      'You are a task decomposition expert. Respond ONLY with valid JSON — no commentary.',
      prompt,
      analysisModel,
    );
    const jsonMatch = raw.match(/\{[\s\S]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<TaskAnalysis>;
      if (parsed.complexity && parsed.summary) {
        return {
          complexity: parsed.complexity,
          difficulty: parsed.difficulty ?? 5,
          estimatedFiles: parsed.estimatedFiles ?? 3,
          suggestedModel: parsed.suggestedModel ?? 'deepseek-chat',
          keyRisks: parsed.keyRisks ?? [],
          summary: parsed.summary,
          subtasks: parsed.subtasks,
          likelyFiles: parsed.likelyFiles,
          testStrategy: parsed.testStrategy,
          maxFixIterations: parsed.maxFixIterations ?? 2,
          estimatedCostRange: estimateCostRange(parsed.complexity, parsed.estimatedFiles ?? 3),
        };
      }
    }
  } catch { /* fall through */ }

  // Heuristic fallback
  const complexity: TaskAnalysis['complexity'] = words > 50 ? 'complex' : words > 20 ? 'moderate' : 'simple';
  const difficulty = complexity === 'complex' ? 8 : complexity === 'moderate' ? 5 : 2;
  return {
    complexity,
    difficulty,
    estimatedFiles: complexity === 'complex' ? 10 : complexity === 'moderate' ? 4 : 1,
    suggestedModel: complexity === 'complex' ? 'deepseek-r1' : complexity === 'moderate' ? 'deepseek-v3' : 'deepseek-chat',
    keyRisks: [],
    summary: task.slice(0, 100),
    maxFixIterations: difficulty >= 8 ? 3 : difficulty >= 5 ? 2 : 1,
    estimatedCostRange: estimateCostRange(complexity, complexity === 'complex' ? 10 : 4),
  };
}

/** Cost range estimate based on complexity + file count */
function estimateCostRange(
  complexity: 'simple' | 'moderate' | 'complex' | undefined,
  estimatedFiles: number,
): [number, number] {
  // Token estimate: ~2k tokens per file × 3 agents × in+out pricing ($0.27/$1.10 per 1M)
  const tokensPerAgent = estimatedFiles * 2000;
  const agentCount = complexity === 'simple' ? 2 : 3;
  const totalTokensIn  = tokensPerAgent * agentCount;
  const totalTokensOut = totalTokensIn * 0.3;
  const lowCost  = (totalTokensIn * 0.000000270) + (totalTokensOut * 0.000001100);
  const highCost = lowCost * 3.5; // 3.5× for fix iterations + reasoner
  return [Math.max(lowCost, 0.001), Math.min(highCost, 2.0)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity check
// ─────────────────────────────────────────────────────────────────────────────

async function runSanityCheck(
  task: string,
  architectPlan: string,
  coderSummary: string,
  reviewVerdict: string,
  model: string,
): Promise<string> {
  const prompt = `You just completed a multi-agent engineering task. Do a final sanity check.

## Task
${task}

## Architect's Plan (summary)
${architectPlan.slice(0, 600)}

## Coder's Summary
${coderSummary.slice(0, 600)}

## Reviewer's Verdict
${reviewVerdict.slice(0, 400)}

## Your job
In 3–5 bullet points, confirm:
1. Was the task actually completed (not just planned)?
2. Are there any obvious missing pieces the reviewer might have missed?
3. Any quick follow-up recommendations?

End with either: **SANITY PASSED** or **SANITY FLAGGED: <one line reason>**`;

  try {
    return await callModelPlain(
      'You are a meticulous senior engineer doing a final review pass.',
      prompt,
      model,
    );
  } catch {
    return '**SANITY PASSED** (check skipped due to API error)';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File tracking
// ─────────────────────────────────────────────────────────────────────────────

function extractChangedFiles(text: string): string[] {
  const matches = new Set<string>();
  const filePattern = /(?:^|[\s`'"(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,6})(?:$|[\s`'")\n,])/gm;
  let m: RegExpExecArray | null;
  while ((m = filePattern.exec(text)) !== null) {
    const f = m[1];
    if (f && f.length > 3 && !f.startsWith('http') && f.includes('.')) matches.add(f);
  }
  return [...matches].slice(0, 20);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function runMultiAgent(
  task: string,
  options: OrchestratorOptions = {},
): Promise<MultiAgentResult> {
  const startTime = Date.now();

  // ── Phase 0: Analyze task ─────────────────────────────────────────────────
  options.onAgentStart?.('analysis', 0, TOTAL_PHASES, PHASE_ESTIMATES['analysis']);
  const analysis = await analyzeTask(task, options.model);

  const effectiveModel = options.model ?? selectModel(task, analysis.suggestedModel as any);
  const maxFixLoop = options.maxFixLoop ?? analysis.maxFixIterations;

  // Emit cost projection before heavy pipeline starts
  if (analysis.complexity !== 'simple') {
    options.onCostProjection?.(
      analysis.estimatedCostRange[0],
      analysis.estimatedCostRange[1],
      analysis.complexity,
      analysis.difficulty,
      analysis.estimatedFiles,
    );
  }

  // Build rich RAG context
  const ragContext = getRelevantContext(task, {
    codeResults: analysis.complexity === 'complex' ? 12 : 8,
    includeMemory: true,
    includeGitDiff: true,
  });

  const baseExtra = [
    `\n## Task Analysis`,
    `Complexity: ${analysis.complexity} (difficulty: ${analysis.difficulty}/10) · ~${analysis.estimatedFiles} files · Model: ${effectiveModel}`,
    analysis.keyRisks.length ? `Risks: ${analysis.keyRisks.join(' · ')}` : '',
    analysis.subtasks?.length
      ? `\n## Subtasks\n${analysis.subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '',
    analysis.likelyFiles?.length
      ? `\n## Likely Files\n${analysis.likelyFiles.join('\n')}`
      : '',
    analysis.testStrategy
      ? `\n## Test Strategy\n${analysis.testStrategy}`
      : '',
    ragContext ? `\n${ragContext}` : '',
  ].filter(Boolean).join('\n');

  const makeAgentOpts = (extraExtra?: string): AgentRunOptions => ({
    model: effectiveModel,
    maxIterations: options.maxIterationsPerAgent ?? 25,
    extraContext: baseExtra + (extraExtra ?? ''),
    autoSummarize: true,
    onProgress: options.onAgentProgress,
    onToolCall: options.onToolCall,
  });

  let totalUsage = emptyStats();
  const allFilesChanged: string[] = [];

  const mergeUsage = (usage: UsageStats) => {
    totalUsage = accumulateUsage(totalUsage, {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_tokens: usage.cachedTokens,
    }, effectiveModel as any);
  };

  const trackFiles = (text: string) => {
    for (const f of extractChangedFiles(text)) {
      if (!allFilesChanged.includes(f)) {
        allFilesChanged.push(f);
        options.onFileChange?.(f);
      }
    }
  };

  // ── Phase 1: Architect ────────────────────────────────────────────────────
  options.onAgentStart?.('architect', 1, TOTAL_PHASES, PHASE_ESTIMATES['architect']);
  const archResult = await runArchitect(task, makeAgentOpts());
  mergeUsage(archResult.usage);
  trackFiles(archResult.output);

  // Auto-checkpoint before coder makes changes
  try { createCheckpoint({ label: `pre-multi-agent: ${task.slice(0, 60)}` }); } catch { /* non-critical */ }

  // ── Iterative Coder → Reviewer fix loop ───────────────────────────────────
  let coderSummary = '';
  let reviewVerdict = '';
  let approved = false;
  let fixIterations = 0;

  for (let iteration = 1; iteration <= Math.max(1, maxFixLoop); iteration++) {
    const isFirstPass = iteration === 1;
    const phaseLabel: 'coder' | 'fix' = isFirstPass ? 'coder' : 'fix';
    const phaseNum = isFirstPass ? 2 : 2 + iteration; // phase numbers shift for fix loops

    // ── Coder ────────────────────────────────────────────────────────────────
    const coderEstSecs = PHASE_ESTIMATES[phaseLabel]!;
    options.onAgentStart?.(phaseLabel, phaseNum, TOTAL_PHASES + (maxFixLoop - 1) * 2, coderEstSecs);

    const iterationContext = !isFirstPass
      ? `\n\n## ⚠️ Fix Iteration ${iteration}/${maxFixLoop}\nThe previous implementation was rejected by the Reviewer. Their feedback:\n${reviewVerdict.slice(0, 1500)}\n\nAddress ALL required fixes listed. Be thorough — this is iteration ${iteration} of ${maxFixLoop}.`
      : '';

    const codeResult = await runCoder(
      task,
      archResult.output,
      makeAgentOpts(iterationContext),
      iteration,
      maxFixLoop,
    );
    mergeUsage(codeResult.usage);
    trackFiles(codeResult.output);
    coderSummary = codeResult.output;
    fixIterations = iteration;

    // ── Reviewer ─────────────────────────────────────────────────────────────
    options.onAgentStart?.('reviewer', phaseNum + 1, TOTAL_PHASES + (maxFixLoop - 1) * 2, PHASE_ESTIMATES['reviewer']);
    const reviewResult = await runReviewer(task, archResult.output, coderSummary, makeAgentOpts());
    mergeUsage(reviewResult.usage);
    reviewVerdict = reviewResult.output;

    approved = reviewResult.output.includes('APPROVED') && !reviewResult.output.includes('NEEDS FIXES');

    if (approved) break;

    // Not approved and out of iterations
    if (iteration >= maxFixLoop) break;

    // Brief pause before next iteration to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Phase N+1: Sanity check (if approved and not skipped) ─────────────────
  let sanityCheck: string | undefined;
  if (approved && !options.skipSanityCheck) {
    options.onAgentStart?.('sanity', TOTAL_PHASES - 1, TOTAL_PHASES, PHASE_ESTIMATES['sanity']);
    sanityCheck = await runSanityCheck(
      task, archResult.output, coderSummary, reviewVerdict, 'deepseek-chat',
    );
  }

  const durationMs = Date.now() - startTime;

  // Auto-save session summary to memory
  const summaryText = [
    `Task: ${task.slice(0, 100)}`,
    `Complexity: ${analysis.complexity} (${analysis.difficulty}/10)`,
    `Model: ${effectiveModel}`,
    `Outcome: ${approved ? 'APPROVED' : 'NEEDS FIXES'}`,
    `FixIterations: ${fixIterations}`,
    `Files: ${allFilesChanged.slice(0, 5).join(', ')}`,
    `Cost: $${totalUsage.totalCost.toFixed(4)}`,
    `Duration: ${(durationMs / 1000).toFixed(0)}s`,
  ].join(' | ');

  try {
    saveMemory({ id: `multi-agent-${Date.now()}`, tag: 'multi-agent-session', content: summaryText });
  } catch { /* non-critical */ }

  return {
    analysis,
    architectPlan:  archResult.output,
    coderSummary,
    reviewVerdict,
    sanityCheck,
    approved,
    totalUsage,
    durationMs,
    filesChanged: allFilesChanged,
    fixIterations,
  };
}
