import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { glob } from 'glob';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { saveMemory, recallMemory, deleteMemory } from '../memory/index.js';
import { createCheckpoint, listCheckpoints, rollbackTo } from '../checkpoints/index.js';
import { semanticSearch, getRelevantContext } from '../rag/index.js';
import { isDangerous } from '../config.js';

// Global confirmation callback — set by the TUI so ask_user can surface a prompt
let _confirmationCallback: ((question: string) => Promise<boolean>) | null = null;
export function setConfirmationCallback(cb: (question: string) => Promise<boolean>): void {
  _confirmationCallback = cb;
}
// For non-interactive contexts, default to safe-deny
async function requestConfirmation(question: string): Promise<boolean> {
  if (_confirmationCallback) return _confirmationCallback(question);
  return false; // deny by default in non-interactive mode
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions (OpenAI function-calling format)
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file. Returns the file content as a string. Use this before writing to understand existing content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file to read.' },
          start_line: { type: 'number', description: 'Optional 1-based line number to start reading from.' },
          end_line: { type: 'number', description: 'Optional 1-based line number to stop reading at (inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file to write.' },
          content: { type: 'string', description: 'The complete file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string in a file. Fails if the old_string is not found or appears multiple times (use replace_all for that). Prefer this over write_file for surgical edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit.' },
          old_string: { type: 'string', description: 'The exact string to find and replace.' },
          new_string: { type: 'string', description: 'The replacement string.' },
          replace_all: { type: 'boolean', description: 'If true, replace all occurrences. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at the given path. Shows names, types, and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list. Defaults to current directory.' },
          recursive: { type: 'boolean', description: 'If true, list recursively. Default false.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a shell command and return stdout + stderr. Use for builds, tests, git, package managers, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to current directory.' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 30000.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Search for a pattern (regex or literal) across all files in the project. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regex pattern or literal string to search for.' },
          path: { type: 'string', description: 'Directory to search in. Defaults to current directory.' },
          file_pattern: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts". Default: all files.' },
          case_sensitive: { type: 'boolean', description: 'Whether the search is case sensitive. Default true.' },
          max_results: { type: 'number', description: 'Maximum number of matches to return. Default 50.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files matching a glob pattern. Useful for locating files by name or extension.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
          path: { type: 'string', description: 'Root directory to search. Defaults to current directory.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Get the current git status including staged, unstaged, and untracked files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository path. Defaults to current directory.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description: 'Create a directory and all parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The directory path to create.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file (not a directory). Use with caution — this is permanent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path.' },
          destination: { type: 'string', description: 'Destination file path.' },
        },
        required: ['source', 'destination'],
      },
    },
  },
  // ── Memory tools ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save an important fact, decision, or file summary to persistent project memory. Use after architecture decisions, major changes, or whenever you learn something important about the project.',
      parameters: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'Unique slug for this memory, e.g. "auth-strategy" or "db-schema-v2".' },
          tag:     { type: 'string', description: 'Category: "architecture", "decision", "file-summary", "fact", "warning", or any custom tag.' },
          content: { type: 'string', description: 'The memory content — be specific and concise.' },
        },
        required: ['id', 'tag', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Retrieve memories for this project. Use to recall architecture decisions, prior work, or important facts before starting a task.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term to filter memories by.' },
          tag:   { type: 'string', description: 'Filter by tag, e.g. "architecture" or "decision".' },
          limit: { type: 'number', description: 'Max number of memories to return. Default 20.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'Delete a memory entry by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The memory id to delete.' },
        },
        required: ['id'],
      },
    },
  },
  // ── Checkpoint tools ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'create_checkpoint',
      description: 'Snapshot the current state of all project files. Call this before making large changes so you can rollback if needed.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Human-readable label for this checkpoint.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Specific relative file paths to snapshot. Defaults to all tracked files.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_checkpoints',
      description: 'List all checkpoints for this project, newest first.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max checkpoints to show. Default 20.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rollback_to',
      description: 'Restore all files from a previously created checkpoint. This overwrites current files.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The checkpoint id to restore (from list_checkpoints).' },
        },
        required: ['id'],
      },
    },
  },
  // ── Semantic search ──────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description: 'Search the codebase semantically using TF-IDF similarity. Finds relevant code by meaning, not just exact text. Faster than search_code for exploratory queries. Use this first when you don\'t know exact symbol names.',
      parameters: {
        type: 'object',
        properties: {
          query:  { type: 'string', description: 'Natural language or code query, e.g. "authentication middleware" or "database connection pool".' },
          limit:  { type: 'number', description: 'Max results to return (default 5, max 10).' },
        },
        required: ['query'],
      },
    },
  },
  // ── Safety tools ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a question when you need explicit confirmation or input before proceeding. Use for: irreversible operations, ambiguous scope, missing information, dangerous commands.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user.' },
          default_answer: { type: 'string', description: 'Optional default if user does not respond.' },
        },
        required: ['question'],
      },
    },
  },
  // ── Testing ───────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_test',
      description: 'Auto-detect and run the project\'s test suite (jest, vitest, pytest, go test, cargo test, etc.). Optionally filter to specific test files or patterns.',
      parameters: {
        type: 'object',
        properties: {
          filter:    { type: 'string', description: 'Optional test name or file pattern filter.' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default 60000).' },
        },
        required: [],
      },
    },
  },
  // ── PR description ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'generate_pr_description',
      description: 'Generate a professional pull request title + body based on current git changes. Analyzes the diff and commit history.',
      parameters: {
        type: 'object',
        properties: {
          base_branch: { type: 'string', description: 'Base branch to compare against (default: main or master).' },
          extra_context: { type: 'string', description: 'Optional extra context to include in the PR description.' },
        },
        required: [],
      },
    },
  },
  // ── Advanced git tools ────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff of current working changes or between refs. Use to understand what has changed before committing.',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'If true, show staged diff. Default false (shows unstaged).' },
          path:   { type: 'string', description: 'Limit diff to this file or directory.' },
          ref:    { type: 'string', description: 'Compare against this ref, e.g. "HEAD~1" or a branch name.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'smart_commit',
      description: 'Stage all changes and create a commit with an AI-generated message. Analyzes the diff to write a clear conventional-commits message.',
      parameters: {
        type: 'object',
        properties: {
          hint: { type: 'string', description: 'Optional hint about what changed, to improve the commit message.' },
          push: { type: 'boolean', description: 'If true, also push after committing. Default false.' },
        },
        required: [],
      },
    },
  },
  // ── fix_errors ────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fix_errors',
      description: 'Given error output (from a build, test, or linter), automatically diagnose and fix the errors. Pass the full error text. Returns a summary of fixes applied.',
      parameters: {
        type: 'object',
        properties: {
          error_output: { type: 'string', description: 'The full error/failure output to fix.' },
          context:      { type: 'string', description: 'Optional: what command produced this error.' },
        },
        required: ['error_output'],
      },
    },
  },
  // ── get_relevant_context ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_relevant_context',
      description: 'Get the most relevant code, memory, and recent git changes for a task. Call this at the START of any non-trivial task to load the context you need before diving in.',
      parameters: {
        type: 'object',
        properties: {
          task:            { type: 'string', description: 'The task or question to find context for.' },
          code_results:    { type: 'number', description: 'Number of code chunks to retrieve (default 8).' },
          include_memory:  { type: 'boolean', description: 'Include project memory entries (default true).' },
          include_git_diff:{ type: 'boolean', description: 'Include recent git diff stat (default true).' },
        },
        required: ['task'],
      },
    },
  },
  // ── fix_linting_errors ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fix_linting_errors',
      description: 'Run the project linter (ESLint, tsc, ruff, golangci-lint) and get a structured plan to fix all lint/type errors. Automatically detects which linter to use.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'Directory to lint (default: current directory).' },
          linter:     { type: 'string', description: 'Force a specific linter: eslint, tsc, ruff, golangci-lint. Auto-detects if omitted.' },
          fix:        { type: 'boolean', description: 'If true, attempt auto-fix before returning report (eslint --fix, ruff --fix). Default false.' },
        },
        required: [],
      },
    },
  },
  // ── fix_test_failures ────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fix_test_failures',
      description: 'Run the test suite, identify failing tests, read the relevant source files, and return a structured fix plan. Use this when you need to diagnose and fix failing tests.',
      parameters: {
        type: 'object',
        properties: {
          filter:     { type: 'string', description: 'Optional test name/file filter to run specific tests.' },
          timeout_ms: { type: 'number', description: 'Test timeout in ms (default 60000).' },
        },
        required: [],
      },
    },
  },
  // ── run_tests (alias) ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Alias for run_test — auto-detects and runs the project test suite.',
      parameters: {
        type: 'object',
        properties: {
          filter:    { type: 'string', description: 'Optional test name or file pattern filter.' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default 60000).' },
        },
        required: [],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage']);

// Accept string | undefined so callers can pass optional path args directly
function resolveP(p: string | undefined): string {
  return path.resolve(p ?? '.');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function numberLines(lines: string[], startAt: number): string {
  return lines.map((l, i) => `${startAt + i}\t${l}`).join('\n');
}

const GLOB_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

function readFile(args: { path: string; start_line?: number; end_line?: number }): string {
  const abs = resolveP(args.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return `❌ File not found: ${abs}`;
  }
  if (stat.isDirectory()) return `❌ Path is a directory, not a file: ${abs}`;
  if (stat.size > 5 * 1024 * 1024) return `❌ File too large (${formatSize(stat.size)}). Use search_code to find specific content.`;

  const content = fs.readFileSync(abs, 'utf-8');
  const lines = content.split('\n');

  const start = Math.max(0, (args.start_line ?? 1) - 1);
  const end   = args.end_line !== undefined ? args.end_line : lines.length;
  const slice = (args.start_line !== undefined || args.end_line !== undefined)
    ? lines.slice(start, end)
    : lines;

  const header = (args.start_line !== undefined || args.end_line !== undefined)
    ? `${abs} (lines ${start + 1}–${Math.min(end, lines.length)}):\n`
    : `${abs}:\n`;

  return header + numberLines(slice, start + 1);
}

function writeFile(args: { path: string; content: string }): string {
  const abs = resolveP(args.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, 'utf-8');
  const stat = fs.statSync(abs);
  const lines = args.content.split('\n').length;
  return `✅ Wrote ${abs} (${lines} lines, ${formatSize(stat.size)})`;
}

function editFile(args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): string {
  const abs = resolveP(args.path);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf-8');
  } catch {
    return `❌ File not found: ${abs}`;
  }

  if (!content.includes(args.old_string)) {
    return `❌ String not found in ${abs}. Double-check the exact text including whitespace and indentation.`;
  }

  if (!args.replace_all) {
    const count = content.split(args.old_string).length - 1;
    if (count > 1) {
      return `❌ Found ${count} occurrences of the string in ${abs}. Use replace_all: true or provide more context to make it unique.`;
    }
  }

  const newContent = args.replace_all
    ? content.replaceAll(args.old_string, args.new_string)
    : content.replace(args.old_string, args.new_string);

  fs.writeFileSync(abs, newContent, 'utf-8');
  return `✅ Edited ${abs}`;
}

const SORT_DIRS_FIRST = (a: fs.Dirent, b: fs.Dirent): number => {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
};

function listDir(args: { path?: string; recursive?: boolean }): string {
  const dir = resolveP(args.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return `❌ Directory not found: ${dir}`;
  }
  if (!stat.isDirectory()) return `❌ Not a directory: ${dir}`;

  if (args.recursive) {
    const items: string[] = [];
    const walk = (d: string, prefix: string) => {
      const entries = fs.readdirSync(d, { withFileTypes: true }).sort(SORT_DIRS_FIRST);
      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name)) continue;
        items.push(`${prefix}${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`);
        if (e.isDirectory()) walk(path.join(d, e.name), prefix + '  ');
      }
    };
    walk(dir, '');
    return items.join('\n') || '(empty)';
  }

  const lines = fs.readdirSync(dir, { withFileTypes: true })
    .sort(SORT_DIRS_FIRST)
    .map(e => {
      if (e.isDirectory()) return `📁 ${e.name}/`;
      try {
        return `📄 ${e.name} (${formatSize(fs.statSync(path.join(dir, e.name)).size)})`;
      } catch {
        return `📄 ${e.name}`;
      }
    });

  return `${dir}:\n${lines.join('\n')}`;
}

export async function runCommand(args: { command: string; cwd?: string; timeout_ms?: number }): Promise<string> {
  // Safety check for dangerous patterns
  if (isDangerous(args.command)) {
    const allowed = await requestConfirmation(
      `⚠️  Dangerous command detected:\n  ${args.command}\n\nAllow execution?`
    );
    if (!allowed) return `🚫 Command blocked by safety check: ${args.command}`;
  }
  try {
    const output = execSync(args.command, {
      cwd: args.cwd ? resolveP(args.cwd) : process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: args.timeout_ms ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return output.trim() || '✅ Command executed successfully (no output)';
  } catch (err: any) {
    const stdout = err.stdout?.toString() ?? '';
    const stderr = err.stderr?.toString() ?? '';
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    return `❌ Command failed (exit ${err.status ?? '?'}):\n${combined || err.message}`;
  }
}

async function searchCode(args: {
  pattern: string;
  path?: string;
  file_pattern?: string;
  case_sensitive?: boolean;
  max_results?: number;
}): Promise<string> {
  const root = resolveP(args.path);
  const maxResults = args.max_results ?? 50;
  const globPattern = args.file_pattern
    ? path.join(root, '**', args.file_pattern)
    : path.join(root, '**', '*');

  const files = await glob(globPattern, {
    ignore: [...GLOB_IGNORE, '**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot,mp4,mp3,pdf,zip,tar,gz}'],
    nodir: true,
    dot: false,
  });

  const regex = new RegExp(args.pattern, (args.case_sensitive ?? true) ? '' : 'i');
  const results: string[] = [];

  for (const file of files) {
    if (results.length >= maxResults) break;
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? '')) {
          results.push(`${path.relative(root, file)}:${i + 1}: ${(lines[i] ?? '').trim()}`);
          if (results.length >= maxResults) break;
        }
      }
    } catch { /* skip binary/unreadable */ }
  }

  if (results.length === 0) return `No matches for "${args.pattern}"`;
  const header = results.length >= maxResults ? `(showing first ${maxResults} matches)\n` : '';
  return `${header}${results.join('\n')}`;
}

async function findFiles(args: { pattern: string; path?: string }): Promise<string> {
  const root = resolveP(args.path);
  const fullPattern = path.isAbsolute(args.pattern) ? args.pattern : path.join(root, args.pattern);
  const files = await glob(fullPattern, { ignore: GLOB_IGNORE, dot: false });
  if (files.length === 0) return `No files matching "${args.pattern}"`;
  return files.map(f => path.relative(root, f)).sort().join('\n');
}

async function gitStatus(args: { path?: string }): Promise<string> {
  const cwd = resolveP(args.path);
  const isRepo = await runCommand({ command: 'git rev-parse --is-inside-work-tree', cwd, timeout_ms: 5000 });
  if (isRepo.startsWith('❌')) {
    return `ℹ️  Not a git repository: ${cwd}`;
  }
  return runCommand({ command: 'git status --short --branch && echo "---" && git log --oneline -5', cwd });
}

function createFolder(args: { path: string }): string {
  const abs = resolveP(args.path);
  fs.mkdirSync(abs, { recursive: true });
  return `✅ Created directory: ${abs}`;
}

function deleteFile(args: { path: string }): string {
  const abs = resolveP(args.path);
  try {
    fs.unlinkSync(abs);
    return `✅ Deleted: ${abs}`;
  } catch (err: any) {
    if (err.code === 'ENOENT') return `❌ File not found: ${abs}`;
    if (err.code === 'EISDIR') return `❌ Path is a directory. Use run_command with 'rm -rf' if you're sure.`;
    return `❌ Delete failed: ${err.message}`;
  }
}

function moveFile(args: { source: string; destination: string }): string {
  const src  = resolveP(args.source);
  const dest = resolveP(args.destination);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return `✅ Moved ${src} → ${dest}`;
  } catch (err: any) {
    if (err.code === 'ENOENT') return `❌ Source not found: ${src}`;
    return `❌ Move failed: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Advanced git implementations
// ─────────────────────────────────────────────────────────────────────────────

async function gitDiff(args: { staged?: boolean; path?: string; ref?: string }): Promise<string> {
  const parts = ['git', 'diff'];
  if (args.staged) parts.push('--staged');
  if (args.ref)    parts.push(args.ref);
  if (args.path)   parts.push('--', resolveP(args.path));
  return runCommand({ command: parts.join(' '), timeout_ms: 10_000 });
}

async function smartCommit(args: { hint?: string; push?: boolean }): Promise<string> {
  const cwd = process.cwd();

  const staged = await runCommand({ command: 'git diff --staged --stat', cwd });
  if (staged.startsWith('❌') || staged.trim() === '✅ Command executed successfully (no output)') {
    const stageResult = await runCommand({ command: 'git add -A', cwd });
    if (stageResult.startsWith('❌')) return stageResult;
  }

  const [stagedStat, stagedDiff] = await Promise.all([
    runCommand({ command: 'git diff --staged --stat', cwd }),
    runCommand({ command: 'git diff --staged --unified=2', cwd }),
  ]);

  const msg = generateCommitMessage(stagedStat, stagedDiff, args.hint);
  const commitResult = await runCommand({ command: `git commit -m ${JSON.stringify(msg)}`, cwd });
  if (commitResult.startsWith('❌')) return commitResult;

  if (args.push) {
    const pushResult = await runCommand({ command: 'git push', cwd });
    return `${commitResult}\n\n${pushResult}`;
  }
  return commitResult;
}

function generateCommitMessage(stat: string, diff: string, hint?: string): string {
  // Determine the dominant change type from the diff
  const adds    = (diff.match(/^\+[^+]/gm) ?? []).length;
  const removes = (diff.match(/^-[^-]/gm) ?? []).length;
  const files   = (stat.match(/\|\s+\d+/g) ?? []).length;

  // Parse changed file paths for context
  const changedFiles = (stat.match(/^\s+(\S+)\s+\|/gm) ?? [])
    .map(l => path.basename(l.trim().split(/\s+/)[0] ?? ''))
    .filter(Boolean)
    .slice(0, 3);

  // Infer conventional-commits type
  let type = 'chore';
  const diffLower = diff.toLowerCase();
  if (diffLower.includes('test') || diffLower.includes('spec')) type = 'test';
  else if (diffLower.includes('fix') || removes > adds * 2)     type = 'fix';
  else if (adds > removes * 2)                                   type = 'feat';
  else if (diffLower.includes('refactor'))                       type = 'refactor';
  else if (diffLower.includes('docs') || diffLower.includes('readme')) type = 'docs';
  else if (diffLower.includes('style') || diffLower.includes('format')) type = 'style';

  const scope  = changedFiles.length === 1 ? changedFiles[0]!.replace(/\.[^.]+$/, '') : undefined;
  const prefix = scope ? `${type}(${scope})` : type;

  const summary = hint
    ? hint.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim()
    : `update ${changedFiles.join(', ')} (${files} file${files !== 1 ? 's' : ''}, +${adds}/-${removes} lines)`;

  return `${prefix}: ${summary}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// New tool implementations
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// fix_errors implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse error output to extract file paths + line numbers, then read those
 * files and return a structured action plan.  The actual fixing is done by the
 * agent using its own reasoning — this tool handles the mechanical parse step.
 */
async function toolFixErrors(args: { error_output: string; context?: string }): Promise<string> {
  const err = args.error_output;

  // Extract file:line references from common error formats
  const fileLinePattern = /([^\s:'"]+\.[a-zA-Z]{1,6}):(\d+)(?::(\d+))?/g;
  const fileRefs = new Map<string, Set<number>>();
  let m: RegExpExecArray | null;
  while ((m = fileLinePattern.exec(err)) !== null) {
    const [, file, lineStr] = m;
    if (!file || !lineStr) continue;
    const lineNum = parseInt(lineStr, 10);
    if (!fileRefs.has(file)) fileRefs.set(file, new Set());
    fileRefs.get(file)!.add(lineNum);
  }

  if (fileRefs.size === 0) {
    return [
      `## Error Analysis`,
      `No file:line references found in the error output.`,
      ``,
      `## Error Text`,
      err.slice(0, 2000),
      ``,
      `## Suggested Action`,
      `Review the error manually and use read_file + edit_file to fix.`,
    ].join('\n');
  }

  const sections: string[] = [
    `## Error Analysis`,
    `Found references to ${fileRefs.size} file(s). Reading relevant lines...\n`,
  ];

  for (const [filePath, lines] of fileRefs) {
    const abs = path.resolve(filePath);
    try {
      if (!fs.existsSync(abs)) { sections.push(`### ${filePath}\n❌ File not found`); continue; }
      const content = fs.readFileSync(abs, 'utf-8').split('\n');
      const errorLines = [...lines].sort((a, b) => a - b);

      const snippets = errorLines.map(lineNum => {
        const start = Math.max(0, lineNum - 4);
        const end   = Math.min(content.length, lineNum + 3);
        const numbered = content.slice(start, end).map((l, i) => {
          const n = start + i + 1;
          const marker = n === lineNum ? '→' : ' ';
          return `${marker} ${n}\t${l}`;
        }).join('\n');
        return `Lines ${start + 1}–${end}:\n${numbered}`;
      }).join('\n\n');

      sections.push(`### ${filePath}\n${snippets}`);
    } catch {
      sections.push(`### ${filePath}\n❌ Could not read file`);
    }
  }

  sections.push(
    `\n## Error Text (truncated)`,
    err.slice(0, 3000),
    ``,
    `## Action`,
    `Use edit_file to fix each error location shown above, then run_test to verify.`,
  );

  return sections.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// get_relevant_context implementation
// ─────────────────────────────────────────────────────────────────────────────

function toolGetRelevantContext(args: {
  task: string;
  code_results?: number;
  include_memory?: boolean;
  include_git_diff?: boolean;
}): string {
  return getRelevantContext(args.task, {
    codeResults:    args.code_results    ?? 8,
    includeMemory:  args.include_memory  ?? true,
    includeGitDiff: args.include_git_diff ?? true,
  }) || 'No relevant context found. Consider running /reindex to build the semantic search index.';
}

function toolSemanticSearch(args: { query: string; limit?: number }): string {
  const results = semanticSearch(args.query, Math.min(args.limit ?? 5, 10));
  if (results.length === 0) {
    return 'No results found. The index may be empty — run /reindex or use search_code instead.';
  }
  return results.map(r =>
    `${r.chunk.file}:${r.chunk.startLine}–${r.chunk.endLine} (score ${r.score.toFixed(3)})\n${r.chunk.text.split('\n').slice(0, 8).join('\n')}`
  ).join('\n\n---\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// fix_linting_errors implementation
// ─────────────────────────────────────────────────────────────────────────────

const LINTER_DETECTORS: Array<{
  name: string;
  file?: string;
  pkgKey?: string;
  command: (cwd: string, fix: boolean) => string;
}> = [
  {
    name: 'tsc',
    pkgKey: 'typescript',
    command: (cwd, _) => 'npx tsc --noEmit 2>&1',
  },
  {
    name: 'eslint',
    file: '.eslintrc.js',
    command: (cwd, fix) => `npx eslint . --ext .ts,.tsx,.js,.jsx${fix ? ' --fix' : ''} --max-warnings=0 2>&1`,
  },
  {
    name: 'eslint',
    file: '.eslintrc.json',
    command: (cwd, fix) => `npx eslint . --ext .ts,.tsx,.js,.jsx${fix ? ' --fix' : ''} --max-warnings=0 2>&1`,
  },
  {
    name: 'eslint',
    file: 'eslint.config.js',
    command: (cwd, fix) => `npx eslint .${fix ? ' --fix' : ''} --max-warnings=0 2>&1`,
  },
  {
    name: 'ruff',
    file: 'ruff.toml',
    command: (cwd, fix) => `ruff check .${fix ? ' --fix' : ''} 2>&1`,
  },
  {
    name: 'ruff',
    file: 'pyproject.toml',
    command: (cwd, fix) => `ruff check .${fix ? ' --fix' : ''} 2>&1`,
  },
  {
    name: 'golangci-lint',
    file: 'go.mod',
    command: (cwd, _) => 'golangci-lint run ./... 2>&1',
  },
];

async function toolFixLintingErrors(args: {
  path?: string;
  linter?: string;
  fix?: boolean;
}): Promise<string> {
  const cwd = args.path ? path.resolve(args.path) : process.cwd();
  const fix = args.fix ?? false;

  // Detect linter
  let detectedCommand: string | null = null;
  let detectedName: string = 'unknown';

  if (args.linter) {
    const forced = LINTER_DETECTORS.find(d => d.name === args.linter);
    if (forced) {
      detectedCommand = forced.command(cwd, fix);
      detectedName = forced.name;
    }
  }

  if (!detectedCommand) {
    // Check package.json lint script first
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg?.scripts?.lint) {
        detectedCommand = pkg.scripts.lint;
        detectedName = 'package.json lint script';
      }
    } catch { /* no package.json */ }
  }

  if (!detectedCommand) {
    for (const det of LINTER_DETECTORS) {
      const found = det.file
        ? fs.existsSync(path.join(cwd, det.file))
        : false;
      if (found) {
        detectedCommand = det.command(cwd, fix);
        detectedName = det.name;
        break;
      }
    }
  }

  if (!detectedCommand) {
    return '❌ Could not detect a linter. Tried: ESLint, tsc, ruff, golangci-lint. Run lint manually with run_command.';
  }

  const output = await runCommand({ command: detectedCommand, cwd, timeout_ms: 60_000 });

  if (!output.startsWith('❌') && !output.toLowerCase().includes('error') && !output.toLowerCase().includes('warning')) {
    return `✅ ${detectedName} passed — no lint errors found.\n${output}`;
  }

  // Parse errors for structured output
  const lines = output.split('\n').filter(Boolean);
  const errorLines = lines.filter(l =>
    /error|warning|TS\d{4}|\[error\]/i.test(l)
  ).slice(0, 50);

  return [
    `## Lint Report — ${detectedName}`,
    ``,
    `**Errors/Warnings found (${errorLines.length})**:`,
    errorLines.map(l => `  ${l}`).join('\n'),
    ``,
    `## Full Output`,
    output.slice(0, 3000),
    ``,
    `## Fix Plan`,
    `Use edit_file to fix each error. Common patterns:`,
    `- TypeScript type errors: add explicit types, fix imports, correct type mismatches`,
    `- ESLint: fix unused vars, add missing deps, correct style`,
    `- After fixing, re-run fix_linting_errors to verify`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// fix_test_failures implementation
// ─────────────────────────────────────────────────────────────────────────────

async function toolFixTestFailures(args: { filter?: string; timeout_ms?: number }): Promise<string> {
  // First run the tests
  const testResult = await runTest({ filter: args.filter, timeout_ms: args.timeout_ms });

  // Check if tests passed
  const lowerResult = testResult.toLowerCase();
  const passed = !testResult.startsWith('❌') &&
    !lowerResult.includes('fail') &&
    !lowerResult.includes(' error') &&
    !lowerResult.includes('failed');

  if (passed) {
    return `✅ All tests passed!\n\n${testResult.slice(0, 500)}`;
  }

  // Parse failing tests — extract file:line refs and test names
  const sections: string[] = [
    `## Test Failure Analysis`,
    ``,
    `**Test Output:**`,
    `\`\`\``,
    testResult.slice(0, 3000),
    `\`\`\``,
    ``,
  ];

  // Extract file references from the test output
  const fileLinePattern = /([^\s:'"]+\.[a-zA-Z]{1,6}):(\d+)(?::(\d+))?/g;
  const fileRefs = new Map<string, Set<number>>();
  let m: RegExpExecArray | null;
  while ((m = fileLinePattern.exec(testResult)) !== null) {
    const [, file, lineStr] = m;
    if (!file || !lineStr) continue;
    if (file.includes('node_modules') || file.includes('.git')) continue;
    const lineNum = parseInt(lineStr, 10);
    if (!fileRefs.has(file)) fileRefs.set(file, new Set());
    fileRefs.get(file)!.add(lineNum);
  }

  // Extract failing test names
  const failPatterns = [
    /✕\s+(.+)$/gm,                    // Jest/Vitest failed
    /FAIL.*\n(?:.*\n)*?.*✕\s+(.+)/gm, // Jest suite fail
    /FAILED\s+(.+)\s+-/gm,            // pytest FAILED
    /--- FAIL:\s+(\S+)/gm,            // Go test FAIL
    /not ok.*-\s+(.+)$/gm,            // TAP format
  ];

  const failingTests: string[] = [];
  for (const pattern of failPatterns) {
    pattern.lastIndex = 0;
    while ((m = pattern.exec(testResult)) !== null) {
      if (m[1]) failingTests.push(m[1].trim().slice(0, 100));
    }
  }

  if (failingTests.length > 0) {
    sections.push(`**Failing Tests (${failingTests.length}):**`);
    failingTests.slice(0, 10).forEach(t => sections.push(`  ✕ ${t}`));
    sections.push('');
  }

  // Read context around each failing file:line
  if (fileRefs.size > 0) {
    sections.push(`**Relevant Code at Failure Points:**`);
    sections.push('');
    for (const [filePath, lines] of fileRefs) {
      const abs = path.resolve(filePath);
      try {
        if (!fs.existsSync(abs)) continue;
        const content = fs.readFileSync(abs, 'utf-8').split('\n');
        const sortedLines = [...lines].sort((a, b) => a - b).slice(0, 3);
        sections.push(`### ${filePath}`);
        for (const lineNum of sortedLines) {
          const start = Math.max(0, lineNum - 5);
          const end   = Math.min(content.length, lineNum + 4);
          const numbered = content.slice(start, end).map((l, i) => {
            const n = start + i + 1;
            const marker = n === lineNum ? '→' : ' ';
            return `${marker} ${n}\t${l}`;
          }).join('\n');
          sections.push(`\`\`\`\n${numbered}\n\`\`\``);
        }
      } catch { /* skip unreadable */ }
    }
  }

  sections.push(
    ``,
    `## Fix Recommendations`,
    `1. Read the failing test file to understand what it expects`,
    `2. Read the source file being tested`,
    `3. Use edit_file to fix the implementation (not the test, unless the test is wrong)`,
    `4. Re-run fix_test_failures after fixing to verify`,
    failingTests.length === 0 ? '5. Check for module/import errors — these often block all tests from running' : '',
  );

  return sections.filter(Boolean).join('\n');
}

// ask_user is handled specially: the confirmation callback is invoked.
async function toolAskUser(args: { question: string; default_answer?: string }): Promise<string> {
  const answer = await requestConfirmation(args.question);
  if (answer) return 'User confirmed: yes';
  return `User responded: no${args.default_answer ? ` (default: ${args.default_answer})` : ''}`;
}

// Test runner — detects framework from package.json / config files
const TEST_DETECTORS: Array<{ file: string; command: string }> = [
  { file: 'vitest.config.ts',   command: 'bun run test --run' },
  { file: 'vitest.config.js',   command: 'npx vitest run' },
  { file: 'jest.config.ts',     command: 'npx jest' },
  { file: 'jest.config.js',     command: 'npx jest' },
  { file: 'pytest.ini',         command: 'python -m pytest' },
  { file: 'pyproject.toml',     command: 'python -m pytest' },
  { file: 'Cargo.toml',         command: 'cargo test' },
  { file: 'go.mod',             command: 'go test ./...' },
  { file: 'mix.exs',            command: 'mix test' },
  { file: 'Gemfile',            command: 'bundle exec rspec' },
];

async function runTest(args: { filter?: string; timeout_ms?: number }): Promise<string> {
  const cwd = process.cwd();

  // Detect from package.json scripts first
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    if (pkg?.scripts?.test) {
      const cmd = args.filter ? `${pkg.scripts.test} ${args.filter}` : pkg.scripts.test;
      return runCommand({ command: cmd.replace(/^bun /, 'bun '), cwd, timeout_ms: args.timeout_ms ?? 60_000 });
    }
  } catch { /* no package.json */ }

  // Detect from config files
  for (const { file, command } of TEST_DETECTORS) {
    if (fs.existsSync(path.join(cwd, file))) {
      const cmd = args.filter ? `${command} ${args.filter}` : command;
      return runCommand({ command: cmd, cwd, timeout_ms: args.timeout_ms ?? 60_000 });
    }
  }

  return '❌ Could not detect test framework. Run tests manually with run_command.';
}

async function generatePrDescription(args: { base_branch?: string; extra_context?: string }): Promise<string> {
  const cwd = process.cwd();
  const base = args.base_branch ?? 'main';

  const [diffStat, commits, diffBody] = await Promise.all([
    runCommand({ command: `git diff ${base}...HEAD --stat`, cwd }),
    runCommand({ command: `git log ${base}...HEAD --oneline`, cwd }),
    runCommand({ command: `git diff ${base}...HEAD --unified=3`, cwd }),
  ]);

  if (diffStat.startsWith('❌')) {
    // Fallback to comparing with HEAD~1
    const [fallbackStat, fallbackCommits] = await Promise.all([
      runCommand({ command: 'git diff HEAD~1 --stat', cwd }),
      runCommand({ command: 'git log HEAD~1..HEAD --oneline', cwd }),
    ]);
    return formatPrDescription(fallbackStat, fallbackCommits, '', args.extra_context);
  }

  return formatPrDescription(diffStat, commits, diffBody, args.extra_context);
}

function formatPrDescription(stat: string, commits: string, diff: string, extra?: string): string {
  const adds    = (diff.match(/^\+[^+]/gm) ?? []).length;
  const removes = (diff.match(/^-[^-]/gm) ?? []).length;
  const fileList = stat.split('\n').filter(l => l.includes('|')).map(l => `- ${l.trim()}`).join('\n');
  const commitList = commits.split('\n').filter(Boolean).map(l => `- ${l}`).join('\n');

  return [
    `## Summary`,
    extra ? `${extra}\n` : '',
    `## Changes`,
    fileList || '(no files changed)',
    ``,
    `**Stats:** +${adds} additions, -${removes} deletions`,
    ``,
    `## Commits`,
    commitList || '(no commits)',
    ``,
    `## Testing`,
    `- [ ] Tests pass locally`,
    `- [ ] Added/updated tests for new behavior`,
    ``,
    `---`,
    `*Generated by Forge*`,
  ].filter(l => l !== '').join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      // Core file tools
      case 'read_file':     return readFile(args as Parameters<typeof readFile>[0]);
      case 'write_file':    return writeFile(args as Parameters<typeof writeFile>[0]);
      case 'edit_file':     return editFile(args as Parameters<typeof editFile>[0]);
      case 'list_dir':      return listDir(args as Parameters<typeof listDir>[0]);
      case 'run_command':   return await runCommand(args as Parameters<typeof runCommand>[0]);
      case 'search_code':   return await searchCode(args as Parameters<typeof searchCode>[0]);
      case 'find_files':    return await findFiles(args as Parameters<typeof findFiles>[0]);
      case 'git_status':    return await gitStatus(args as Parameters<typeof gitStatus>[0]);
      case 'create_folder': return createFolder(args as Parameters<typeof createFolder>[0]);
      case 'delete_file':   return deleteFile(args as Parameters<typeof deleteFile>[0]);
      case 'move_file':     return moveFile(args as Parameters<typeof moveFile>[0]);
      // Memory
      case 'save_memory':   return saveMemory(args as Parameters<typeof saveMemory>[0]);
      case 'recall_memory': return recallMemory(args as Parameters<typeof recallMemory>[0]);
      case 'delete_memory': return deleteMemory((args as { id: string }).id);
      // Checkpoints
      case 'create_checkpoint': return createCheckpoint(args as Parameters<typeof createCheckpoint>[0]);
      case 'list_checkpoints':  return listCheckpoints(args as Parameters<typeof listCheckpoints>[0]);
      case 'rollback_to':       return rollbackTo(args as Parameters<typeof rollbackTo>[0]);
      // Advanced git
      case 'git_diff':             return await gitDiff(args as Parameters<typeof gitDiff>[0]);
      case 'smart_commit':         return await smartCommit(args as Parameters<typeof smartCommit>[0]);
      // New tools
      case 'semantic_search':      return toolSemanticSearch(args as Parameters<typeof toolSemanticSearch>[0]);
      case 'ask_user':             return await toolAskUser(args as Parameters<typeof toolAskUser>[0]);
      case 'run_test':             return await runTest(args as Parameters<typeof runTest>[0]);
      case 'generate_pr_description': return await generatePrDescription(args as Parameters<typeof generatePrDescription>[0]);
      case 'fix_errors':           return await toolFixErrors(args as Parameters<typeof toolFixErrors>[0]);
      case 'get_relevant_context': return toolGetRelevantContext(args as Parameters<typeof toolGetRelevantContext>[0]);
      case 'fix_linting_errors':   return await toolFixLintingErrors(args as Parameters<typeof toolFixLintingErrors>[0]);
      case 'fix_test_failures':    return await toolFixTestFailures(args as Parameters<typeof toolFixTestFailures>[0]);
      case 'run_tests':            return await runTest(args as Parameters<typeof runTest>[0]);  // alias
      default:                     return `❌ Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `❌ Tool "${name}" error: ${err.message}`;
  }
}

export type ToolName = typeof TOOL_DEFINITIONS[number]['function']['name'];
