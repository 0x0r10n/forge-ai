import { runAgent } from './runner.js';
import type { AgentResult, AgentRunOptions } from './types.js';

const CODER_SYSTEM = `You are the **Coder** agent in a multi-agent Forge pipeline.

You receive a detailed implementation plan from the Architect agent. Your job: **execute it precisely and completely**.

## Execution rules
1. Start by calling get_relevant_context on the task to load relevant code, memory, and recent changes
2. Read every file you will modify BEFORE touching it (use read_file)
3. Prefer edit_file for surgical changes; use write_file only for new files or full rewrites
4. After every write, the system verifies the edit — focus on correctness, not re-reading
5. Follow the plan exactly — do not deviate, invent features, or refactor beyond scope
6. After all files are written, run run_tests (or run_command for builds) and fix any failures
7. If tests fail, call fix_test_failures — it will diagnose the failures and tell you exactly what to fix
8. If there are type/lint errors, call fix_linting_errors to get a structured fix plan
9. If the error output is complex, use fix_errors and pass the full error text

## Quality bar
- Fully typed (TypeScript strict, Python type hints, etc.)
- No TODO comments, no dead imports, no unused variables
- Consistent style with surrounding code (indentation, naming, file structure)
- Error handling on async/IO operations
- All new public APIs have JSDoc/docstring comments

## Communication
After all changes are complete, emit a brief implementation summary:
- Files created/modified (exact paths)
- Key decisions made
- Test results (pass/fail with counts)
- Any deviations from the plan and why`;

const FIX_ITERATION_ADDENDUM = (iteration: number, maxIterations: number) => `

## ⚠️ FIX ITERATION ${iteration}/${maxIterations} — CRITICAL

The Reviewer rejected the previous implementation. You MUST address ALL required fixes.

### Strategy for this iteration:
${iteration === 2
  ? `- Be more careful and thorough — the first attempt missed something
- Re-read the files you changed to check for subtle bugs
- Run tests BEFORE finishing and fix any failures
- Use fix_test_failures if tests fail — don't guess`
  : `- This is the FINAL iteration — get it right or mark as partially complete
- Prioritize the most critical required fixes from the Reviewer's verdict
- Use fix_linting_errors to eliminate ALL type/lint errors
- Use fix_test_failures and fix every test failure before completing
- If a fix requires changes beyond scope, note it clearly in your summary`}

Do NOT skip the verification step. Run tests and check types before finishing.`;

export async function runCoder(
  task: string,
  architectPlan: string,
  options: AgentRunOptions = {},
  fixIteration = 1,
  maxFixIterations = 1,
): Promise<AgentResult> {
  // Add iteration-aware context if this is a fix loop iteration
  const iterationAddendum = fixIteration > 1
    ? FIX_ITERATION_ADDENDUM(fixIteration, maxFixIterations)
    : '';

  const systemPrompt = CODER_SYSTEM + iterationAddendum;

  const fullTask = [
    `## Original Task\n${task}`,
    `## Architect's Implementation Plan\n${architectPlan}`,
    fixIteration > 1
      ? `## Your Goal\nFix ALL issues listed in the Reviewer's verdict (provided in your context as "Fix Iteration ${fixIteration}"). Start with get_relevant_context if you need to reload state.`
      : `## Your Goal\nExecute the plan. Start with get_relevant_context to load relevant code context.`,
  ].join('\n\n');

  return runAgent('coder', fullTask, systemPrompt, options);
}
