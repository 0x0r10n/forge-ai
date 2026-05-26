import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Box, Text, Newline, useApp, useInput } from 'ink';
import fs from 'fs';
import path from 'path';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import {
  callModel,
  initAgent,
  emptyStats,
  accumulateUsage,
  SYSTEM_PROMPT,
  type Message,
  type UsageStats,
} from '../agent.js';
import { executeTool, setConfirmationCallback } from '../tools/index.js';
import { type Config, type ModelId, ModelEnum, REASONER_MODELS, CONFIG_DIR } from '../config.js';
import { runMultiAgent, analyzeTask } from '../agents/orchestrator.js';
import type { AgentRole } from '../agents/types.js';
import { recallMemory } from '../memory/index.js';
import { listCheckpoints, createCheckpoint } from '../checkpoints/index.js';
import {
  reindex, buildRagContext, startWatcher, stopWatcher, semanticSearch, getIndexStats,
  type IndexStats,
} from '../rag/index.js';
import { compressIfNeeded } from '../context/compressor.js';
import { getUsageReport, appendUsageRecord } from '../context/usageHistory.js';
import { saveSession, type SessionSnapshot } from '../context/session.js';
import { APP_VERSION } from '../version.js';
import { runQualityGate } from '../quality/gates.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type DisplayMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning?: string; agent?: AgentRole; collapsed?: boolean }
  | { kind: 'tool_call'; name: string; args: string; result?: string; collapsed?: boolean }
  | { kind: 'agent_phase'; role: string; status: string; phase: number; total: number; estimatedSecs?: number }
  | { kind: 'error'; text: string }
  | { kind: 'divider'; label: string }
  | { kind: 'summary'; stats: UsageStats; duration: number; filesChanged?: string[]; fixIterations?: number; approved?: boolean }
  | { kind: 'cost_projection'; low: number; high: number; complexity: string; difficulty: number; estimatedFiles: number }
  | { kind: 'benchmark'; lines: string[] }
  | { kind: 'quality_gate'; passed: boolean; lines: string[] }
  | { kind: 'confirmation'; question: string; id: string };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
function formatTokenUsage(input: number, output: number): string {
  return `↑${formatTokens(input)} ↓${formatTokens(output)}`;
}
function formatDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(0)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${(secs % 60).toFixed(0)}s`;
  return `${(secs / 3600).toFixed(1)}h`;
}
function formatChunks(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  read_file: '📖', write_file: '✍️ ', edit_file: '✂️ ', list_dir: '📂',
  run_command: '⚡', search_code: '🔍', find_files: '🗂️ ', git_status: '🌿',
  create_folder: '📁', delete_file: '🗑️ ', move_file: '↔️ ',
  save_memory: '🧠', recall_memory: '💭', delete_memory: '🗑️ ',
  create_checkpoint: '📌', list_checkpoints: '📋', rollback_to: '⏪',
  git_diff: '🔀', smart_commit: '🚀', semantic_search: '🧬',
  ask_user: '❓', run_test: '🧪', run_tests: '🧪', generate_pr_description: '📝',
  fix_errors: '🔧', fix_linting_errors: '🔧', fix_test_failures: '🔧',
  get_relevant_context: '🔎',
};

const AGENT_COLORS: Record<string, string> = {
  architect: 'yellowBright', coder: 'cyanBright',
  reviewer: 'greenBright', solo: 'cyanBright',
  analysis: 'magentaBright', sanity: 'blueBright', fix: 'redBright',
};
const AGENT_ICONS: Record<string, string> = {
  architect: '🏗️ ', coder: '⌨️ ', reviewer: '🔍', solo: '◆',
  analysis: '🔬', sanity: '✅', fix: '🔧',
};

const ALL_MODELS = ModelEnum.options as readonly ModelId[];

const SLASH_COMMANDS = [
  { cmd: '/multi <task>',       desc: 'Architect→Coder→Reviewer pipeline (up to 3× fix loop)' },
  { cmd: '/oneshot <task>',     desc: 'Batch mode: run pipeline, print structured report, exit' },
  { cmd: '/benchmark',          desc: 'Run internal test suite and show capability score' },
  { cmd: '/think <question>',   desc: 'Force deep reasoning with DeepSeek-R1' },
  { cmd: '/checkpoint [label]', desc: 'Snapshot current project files for rollback' },
  { cmd: '/commit [hint]',      desc: 'Stage + smart commit with AI message' },
  { cmd: '/memory [query]',     desc: 'Recall project memory' },
  { cmd: '/model [name]',       desc: 'Switch model for this session' },
  { cmd: '/reindex',            desc: 'Rebuild semantic search index' },
  { cmd: '/report [days]',      desc: 'Show usage report' },
  { cmd: '/status',             desc: 'Show session stats' },
  { cmd: '/ship',               desc: 'Run production quality gate before release' },
  { cmd: '/cost',               desc: 'Quick token usage display' },
  { cmd: '/clear',              desc: 'Clear conversation history' },
  { cmd: '/help',               desc: 'Show this command list' },
];

const VERSION = APP_VERSION;

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({ phase, total, label }: { phase: number; total: number; label: string }) {
  const pct = Math.round((phase / total) * 100);
  const filled = Math.round((phase / total) * 20);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  return (
    <Box gap={1}>
      <Text color="cyan">{bar}</Text>
      <Text color="gray">{pct}% {label}</Text>
    </Box>
  );
}

/** Animated RAG indexing bar — shown while reindex is running */
function IndexingBar({ progress, total }: { progress: number; total: number }) {
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const filled = Math.round((pct / 100) * 24);
  const bar = '▓'.repeat(filled) + '░'.repeat(24 - filled);
  return (
    <Box gap={1}>
      <Text color="magentaBright"><Spinner type="dots" /></Text>
      <Text color="magenta">{bar}</Text>
      <Text color="gray">{pct}% · {progress}/{total} files</Text>
    </Box>
  );
}

function Header({
  model, stats, thinking, activeAgent, sessionStart, indexStats, indexing,
}: {
  model: ModelId;
  stats: UsageStats;
  thinking: boolean;
  activeAgent: AgentRole | 'analysis' | null;
  sessionStart: number;
  indexStats: IndexStats;
  indexing: boolean;
}) {
  const elapsed = formatDuration((Date.now() - sessionStart) / 1000);
  const hasIndex = indexStats.chunkCount > 0;
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text color="cyanBright" bold>⚡ Forge</Text>
        <Text color="gray" dimColor>v{VERSION}</Text>
        <Text color="gray">│</Text>
        <Text color="blueBright">{model}</Text>
        {activeAgent && activeAgent !== 'solo' && (
          <>
            <Text color="gray">│</Text>
            <Text color={AGENT_COLORS[activeAgent] as any} bold>
              {AGENT_ICONS[activeAgent]} {activeAgent}
            </Text>
          </>
        )}
        <Text color="gray">│</Text>
        {indexing
          ? <Text color="magentaBright"><Spinner type="dots" />{' '}indexing…</Text>
          : hasIndex
            ? <Text color="gray" dimColor>🧬 {indexStats.fileCount} files · {formatChunks(indexStats.chunkCount)} chunks</Text>
            : <Text color="gray" dimColor>🧬 no index</Text>
        }
      </Box>
      <Box gap={2}>
        <Text color="gray">{elapsed}</Text>
        <Text color="green">{formatTokenUsage(stats.inputTokens, stats.outputTokens)}</Text>
        {thinking && <Text color="yellow"><Spinner type="dots" />{' '}working</Text>}
      </Box>
    </Box>
  );
}

function WelcomeBanner({ indexStats }: { indexStats: IndexStats }) {
  const hasIndex = indexStats.chunkCount > 0;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyanBright" paddingX={2} paddingY={0} marginBottom={1}>
      <Text color="cyanBright" bold>⚡ Welcome to Forge AI v{VERSION}</Text>
      <Text color="gray" dimColor>Forge better code. Faster.</Text>
      <Newline />
      <Text color="white">  <Text color="cyanBright">/multi</Text> {'<task>   '}  Run Architect→Coder→Reviewer pipeline</Text>
      <Text color="white">  <Text color="cyanBright">/think</Text> {'<q>      '}  Force deep reasoning (R1 model)</Text>
      <Text color="white">  <Text color="cyanBright">/benchmark</Text>         Run capability self-test &amp; score</Text>
      <Text color="white">  <Text color="cyanBright">/help</Text>              Show all commands</Text>
      <Newline />
      {hasIndex
        ? <Text color="gray" dimColor>🧬 RAG ready: {indexStats.fileCount} files · {formatChunks(indexStats.chunkCount)} chunks · {indexStats.symbolCount} symbols</Text>
        : <Text color="yellow" dimColor>⚠️  No RAG index — run /reindex to enable semantic code search</Text>
      }
    </Box>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="greenBright" bold>▶ You</Text>
      <Box paddingLeft={2}><Text color="white">{text}</Text></Box>
    </Box>
  );
}

function AssistantMessage({ text, reasoning, agent = 'solo', collapsed }: {
  text: string; reasoning?: string; agent?: AgentRole; collapsed?: boolean;
}) {
  const color = (AGENT_COLORS[agent] ?? 'cyanBright') as any;
  const icon  = AGENT_ICONS[agent] ?? '◆';
  const label = agent === 'solo' ? 'Forge' : agent.charAt(0).toUpperCase() + agent.slice(1);
  if (collapsed) {
    return (
      <Box marginBottom={1} gap={1}>
        <Text color={color}>{icon}</Text>
        <Text color="gray" dimColor>[{label} — {truncate(text, 60)}]</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>{icon} {label}</Text>
      {reasoning && (
        <Box paddingLeft={2}><Text color="gray" dimColor>💭 {truncate(reasoning, 300)}</Text></Box>
      )}
      <Box paddingLeft={2}><Text color="white" wrap="wrap">{text}</Text></Box>
    </Box>
  );
}

function ToolMessage({ name, args, result, collapsed }: {
  name: string; args: string; result?: string; collapsed?: boolean;
}) {
  let argsDisplay = '';
  try {
    const parsed = JSON.parse(args);
    const firstVal = Object.values(parsed)[0];
    argsDisplay = typeof firstVal === 'string' ? truncate(firstVal, 50) : '';
  } catch { argsDisplay = truncate(args, 50); }

  const isError = result?.startsWith('❌');
  if (collapsed && result !== undefined) {
    return (
      <Box marginBottom={1} paddingLeft={1} gap={1}>
        <Text color={isError ? 'red' : 'gray'} dimColor>
          {TOOL_ICONS[name] ?? '🔧'} {name} {argsDisplay && `(${argsDisplay})`} → {truncate(result.split('\n')[0] ?? '', 50)}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <Box gap={1}>
        <Text color="magentaBright">{TOOL_ICONS[name] ?? '🔧'} {name}</Text>
        {argsDisplay && <Text color="gray">({argsDisplay})</Text>}
        {result === undefined && <Text color="yellow"><Spinner type="dots" /></Text>}
      </Box>
      {result !== undefined && (
        <Box paddingLeft={2}>
          <Text color={isError ? 'red' : 'gray'}>{truncate(result.split('\n')[0] ?? '', 80)}</Text>
        </Box>
      )}
    </Box>
  );
}

function AgentPhaseMessage({ role, status, phase, total, estimatedSecs }: {
  role: string; status: string; phase: number; total: number; estimatedSecs?: number;
}) {
  const color = (AGENT_COLORS[role] ?? 'cyan') as any;
  const icon  = AGENT_ICONS[role] ?? '◆';
  const estLabel = estimatedSecs ? `~${estimatedSecs}s` : '';
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <Box gap={1}>
        <Text color={color} bold>{icon} {role.toUpperCase()}</Text>
        <Text color="gray">— {status}</Text>
        {estimatedSecs && <Text color="gray" dimColor>({estLabel})</Text>}
      </Box>
      <ProgressBar phase={phase} total={total} label={`phase ${phase}/${total}`} />
    </Box>
  );
}

function FilesChangedBadge({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <Box gap={1} marginBottom={1} paddingLeft={1}>
      <Text color="cyanBright" dimColor>📝 {files.length} file{files.length !== 1 ? 's' : ''} changed:</Text>
      <Text color="gray" dimColor>
        {files.slice(0, 4).map(f => path.basename(f)).join(', ')}
        {files.length > 4 ? ` +${files.length - 4} more` : ''}
      </Text>
    </Box>
  );
}

/** Effort projection — shown before heavy /multi pipelines */
function CostProjection({ low, high, complexity, difficulty, estimatedFiles }: {
  low: number; high: number; complexity: string; difficulty: number; estimatedFiles: number;
}) {
  // Colour-code by severity
  const color = high > 0.5 ? 'red' : high > 0.10 ? 'yellow' : 'greenBright';
  const bar = '█'.repeat(Math.min(10, Math.ceil(difficulty)));
  const empty = '░'.repeat(10 - Math.min(10, Math.ceil(difficulty)));
  return (
    <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" marginBottom={1}>
      <Box gap={2}>
        <Text color={color} bold>📈 Effort Projection</Text>
        <Text color="gray">{complexity} task · difficulty {difficulty}/10 · ~{estimatedFiles} files</Text>
      </Box>
      <Box gap={1} marginTop={0}>
        <Text color={color}>{bar}</Text><Text color="gray" dimColor>{empty}</Text>
        <Text color="white">  band {low.toFixed(3)} – {high.toFixed(3)}</Text>
        <Text color="gray" dimColor>(relative estimate)</Text>
      </Box>
    </Box>
  );
}

/** Rendered output for /benchmark results */
function BenchmarkResult({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyanBright" paddingX={1} marginBottom={1}>
      {lines.map((l, i) => {
        if (l.startsWith('##')) return <Text key={i} color="cyanBright" bold>{l.replace(/^#+\s*/, '')}</Text>;
        if (l.startsWith('✅')) return <Text key={i} color="greenBright">{l}</Text>;
        if (l.startsWith('❌')) return <Text key={i} color="red">{l}</Text>;
        if (l.startsWith('⚠️')) return <Text key={i} color="yellow">{l}</Text>;
        if (l.startsWith('Score:')) return <Text key={i} color="cyanBright" bold>{l}</Text>;
        if (l === '') return <Text key={i}> </Text>;
        return <Text key={i} color="gray">{l}</Text>;
      })}
    </Box>
  );
}

function QualityGateResultView({ passed, lines }: { passed: boolean; lines: string[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={passed ? 'greenBright' : 'redBright'} paddingX={1} marginBottom={1}>
      <Text color={passed ? 'greenBright' : 'redBright'} bold>{passed ? '🚢 Ready to Ship' : '🧱 Quality Gate Failed'}</Text>
      {lines.map((l, i) => <Text key={i} color="gray">{l}</Text>)}
    </Box>
  );
}

/** Formatted /multi pipeline summary */
function SessionSummary({ stats, duration, filesChanged, fixIterations, approved }: {
  stats: UsageStats; duration: number; filesChanged?: string[]; fixIterations?: number; approved?: boolean;
}) {
  const borderColor = approved === false ? 'yellow' : approved ? 'greenBright' : 'gray';
  const verdictText = approved === undefined ? '' : approved ? '✅ APPROVED' : '⚠️  NEEDS FIXES';
  const fixLabel = fixIterations && fixIterations > 1 ? ` · ${fixIterations} fix iteration${fixIterations > 1 ? 's' : ''}` : '';
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column" marginBottom={1}>
      <Box gap={2}>
        <Text color="white" bold>📊 Pipeline Report</Text>
        {verdictText ? <Text color={approved ? 'greenBright' : 'yellow'} bold>{verdictText}</Text> : null}
      </Box>
      <Text color="gray">
        Tokens: {formatTokenUsage(stats.inputTokens, stats.outputTokens)}  ·  {stats.iterations} calls  ·  {formatDuration(duration)}{fixLabel}
      </Text>
      {filesChanged && filesChanged.length > 0 && (
        <Text color="gray" dimColor>
          Files: {filesChanged.slice(0, 6).join(', ')}{filesChanged.length > 6 ? ` +${filesChanged.length - 6} more` : ''}
        </Text>
      )}
    </Box>
  );
}

function ConfirmationPrompt({ question, onAnswer }: { question: string; onAnswer: (yes: boolean) => void }) {
  useInput((input, key) => {
    if (input.toLowerCase() === 'y') onAnswer(true);
    if (input.toLowerCase() === 'n' || key.escape) onAnswer(false);
  });
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow" bold>⚠️  Confirmation Required</Text>
      <Text color="white">{question}</Text>
      <Text color="gray" dimColor>Press Y to confirm, N to cancel</Text>
    </Box>
  );
}

function ErrorMessage({ text }: { text: string }) {
  return (
    <Box marginBottom={1} paddingLeft={1}>
      <Text color="red">✖ {text}</Text>
    </Box>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <Box marginY={1}>
      <Text color="gray" dimColor>── {label} {'─'.repeat(Math.max(0, 38 - label.length))}</Text>
    </Box>
  );
}

function CommandPalette() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text color="white" bold>Command Palette</Text>
      {SLASH_COMMANDS.map(({ cmd, desc }) => (
        <Box key={cmd} gap={1}>
          <Text color="cyanBright">{cmd.padEnd(30)}</Text>
          <Text color="gray" dimColor>{desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

function HelpBar() {
  return (
    <Box gap={2} paddingX={1}>
      <Text color="gray" dimColor>/help commands</Text>
      <Text color="gray" dimColor>/multi pipeline</Text>
      <Text color="gray" dimColor>/think reasoning</Text>
      <Text color="gray" dimColor>/benchmark score</Text>
      <Text color="gray" dimColor>ctrl+c exit</Text>
    </Box>
  );
}

// Render lookup
const MESSAGE_RENDERERS: {
  [K in DisplayMessage['kind']]: (msg: Extract<DisplayMessage, { kind: K }>, key: number, onConfirm?: (id: string, yes: boolean) => void) => React.ReactElement | null
} = {
  user:             (msg, key) => <UserMessage key={key} text={msg.text} />,
  assistant:        (msg, key) => <AssistantMessage key={key} text={msg.text} reasoning={msg.reasoning} agent={msg.agent} collapsed={msg.collapsed} />,
  tool_call:        (msg, key) => <ToolMessage key={key} name={msg.name} args={msg.args} result={msg.result} collapsed={msg.collapsed} />,
  agent_phase:      (msg, key) => <AgentPhaseMessage key={key} role={msg.role} status={msg.status} phase={msg.phase} total={msg.total} estimatedSecs={msg.estimatedSecs} />,
  error:            (msg, key) => <ErrorMessage key={key} text={msg.text} />,
  divider:          (msg, key) => <Divider key={key} label={msg.label} />,
  summary:          (msg, key) => <SessionSummary key={key} stats={msg.stats} duration={msg.duration} filesChanged={msg.filesChanged} fixIterations={msg.fixIterations} approved={msg.approved} />,
  cost_projection:  (msg, key) => <CostProjection key={key} low={msg.low} high={msg.high} complexity={msg.complexity} difficulty={msg.difficulty} estimatedFiles={msg.estimatedFiles} />,
  benchmark:        (msg, key) => <BenchmarkResult key={key} lines={msg.lines} />,
  quality_gate:     (msg, key) => <QualityGateResultView key={key} passed={msg.passed} lines={msg.lines} />,
  confirmation:     (msg, key, onConfirm) => onConfirm
    ? <ConfirmationPrompt key={key} question={msg.question} onAnswer={yes => onConfirm(msg.id, yes)} />
    : null,
};

// ─────────────────────────────────────────────────────────────────────────────
// /benchmark implementation — pure local tests, no API calls
// ─────────────────────────────────────────────────────────────────────────────

interface BenchCase {
  name: string;
  run: () => Promise<{ pass: boolean; note: string }>;
}

async function runBenchmark(): Promise<string[]> {
  const { tokenize, expandQuery, extractSymbols, semanticSearch: search } = await import('../rag/index.js');

  const cases: BenchCase[] = [
    {
      name: 'Tokenizer: camelCase split',
      run: async () => {
        const tokens = tokenize('runBenchmark myFunctionName');
        const pass = tokens.includes('run') && tokens.includes('benchmark') && tokens.includes('function');
        return { pass, note: `tokens: [${tokens.join(', ')}]` };
      },
    },
    {
      name: 'Tokenizer: stops removed',
      run: async () => {
        const tokens = tokenize('the function returns null undefined');
        const pass = !tokens.includes('the') && !tokens.includes('null') && !tokens.includes('undefined');
        return { pass, note: `tokens: [${tokens.join(', ')}]` };
      },
    },
    {
      name: 'Query expansion: auth synonyms',
      run: async () => {
        const expanded = expandQuery('auth user login');
        const pass = expanded.includes('authentication') && expanded.includes('token') && expanded.includes('signin');
        return { pass, note: `${expanded.length} terms after expansion` };
      },
    },
    {
      name: 'Symbol extraction: TS functions',
      run: async () => {
        const src = 'export async function runMultiAgent(task: string) {}\nclass Orchestrator {}';
        const syms = extractSymbols(src);
        const pass = syms.includes('runmultiagent') || syms.includes('run') || syms.includes('orchestrator');
        return { pass, note: `symbols: [${syms.slice(0, 5).join(', ')}]` };
      },
    },
    {
      name: 'Symbol extraction: Python defs',
      run: async () => {
        const src = 'def calculate_embedding(text: str) -> list:\n    pass\nclass VectorDB:';
        const syms = extractSymbols(src);
        const pass = syms.some(s => s.includes('calculate') || s.includes('embedding')) && syms.some(s => s.includes('vectordb') || s.includes('vector'));
        return { pass, note: `symbols: [${syms.slice(0, 5).join(', ')}]` };
      },
    },
    {
      name: 'Semantic search: returns results or graceful empty',
      run: async () => {
        const results = search('authentication middleware', 5);
        const pass = Array.isArray(results); // always passes — just checks API
        return { pass, note: results.length > 0 ? `${results.length} results` : 'no index (expected on first run)' };
      },
    },
    {
      name: 'Config: directory exists',
      run: async () => {
        const { CONFIG_DIR } = await import('../config.js');
        const pass = fs.existsSync(CONFIG_DIR);
        return { pass, note: CONFIG_DIR };
      },
    },
    {
      name: 'Tools: read_file on existing file',
      run: async () => {
        const { executeTool } = await import('../tools/index.js');
        const result = await executeTool('read_file', { path: process.cwd() + '/package.json' });
        const pass = !result.startsWith('❌') && result.includes('forge');
        return { pass, note: pass ? 'package.json readable' : result.slice(0, 60) };
      },
    },
    {
      name: 'Tools: list_dir works',
      run: async () => {
        const { executeTool } = await import('../tools/index.js');
        const result = await executeTool('list_dir', { path: process.cwd() });
        const pass = !result.startsWith('❌');
        return { pass, note: pass ? `${result.split('\n').length} entries` : result.slice(0, 60) };
      },
    },
    {
      name: 'Memory: save + recall round-trip',
      run: async () => {
        const { saveMemory, recallMemory, deleteMemory } = await import('../memory/index.js');
        const id = `bench-${Date.now()}`;
        saveMemory({ id, tag: 'test', content: 'benchmark-canary-value' });
        const recalled = recallMemory({ query: 'benchmark-canary-value' });
        deleteMemory(id);
        const pass = recalled.includes('benchmark-canary-value');
        return { pass, note: pass ? 'save→recall→delete OK' : 'recall failed' };
      },
    },
  ];

  const results: Array<{ name: string; pass: boolean; note: string; ms: number }> = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const { pass, note } = await c.run();
      results.push({ name: c.name, pass, note, ms: Date.now() - t0 });
    } catch (err: any) {
      results.push({ name: c.name, pass: false, note: err.message ?? String(err), ms: Date.now() - t0 });
    }
  }

  const passed = results.filter(r => r.pass).length;
  const total  = results.length;
  const score  = Math.round((passed / total) * 100);

  const scoreBar = (() => {
    const filled = Math.round(score / 10);
    const color = score >= 90 ? '🟢' : score >= 70 ? '🟡' : '🔴';
    return `${color} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${score}%`;
  })();

  const lines: string[] = [
    `## Forge Benchmark — ${new Date().toLocaleTimeString()}`,
    ``,
    ...results.map(r =>
      `${r.pass ? '✅' : '❌'} ${r.name.padEnd(48)} ${r.ms}ms` +
      (r.note ? `\n   ${r.note}` : '')
    ),
    ``,
    `Score: ${scoreBar}   (${passed}/${total} passed)`,
    ``,
    score >= 90
      ? '✅ All systems nominal — Forge is operating at full capability.'
      : score >= 70
        ? '⚠️  Some checks failed — run /reindex if RAG tests failed.'
        : '❌ Multiple failures — check config with: forge doctor',
  ];

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Interactive component
// ─────────────────────────────────────────────────────────────────────────────

export function Interactive({ config, initialTask, showWelcome, resumeSession }: {
  config: Config;
  initialTask?: string;
  showWelcome?: boolean;
  resumeSession?: SessionSnapshot;
}) {
  const { exit } = useApp();

  const [input, setInput]               = useState('');
  const [thinking, setThinking]         = useState(false);
  const [display, setDisplay]           = useState<DisplayMessage[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelId>(config.defaultModel);
  const [statusLine, setStatusLine]     = useState('Ready — type a task, question, or /help');
  const [activeAgent, setActiveAgent]   = useState<AgentRole | 'analysis' | null>(null);
  const [showPalette, setShowPalette]   = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; resolve: (v: boolean) => void } | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [filesChanged, setFilesChanged] = useState<string[]>([]);
  const [indexStats, setIndexStats]     = useState<IndexStats>(() => getIndexStats());
  const [indexingProgress, setIndexingProgress] = useState<{ n: number; total: number } | null>(null);

  // Restore session or start fresh
  const initialMessages: Message[] = resumeSession
    ? resumeSession.messages
    : [{ role: 'system', content: SYSTEM_PROMPT }];

  const historyRef   = useRef<Message[]>(initialMessages);
  const statsRef     = useRef<UsageStats>(emptyStats());
  const modelRef     = useRef<ModelId>(config.defaultModel);
  const thinkingRef  = useRef(false);
  const sessionStart = useRef(Date.now());
  const taskStart    = useRef(Date.now());
  const initialTaskFired = useRef(false);
  const taskCountRef = useRef(resumeSession?.taskCount ?? 0);

  const addFileChanged = useCallback((file: string) => {
    setFilesChanged(prev => prev.includes(file) ? prev : [...prev, file]);
  }, []);

  // Wire ask_user confirmations to the TUI
  useEffect(() => {
    setConfirmationCallback((question: string) => new Promise<boolean>(resolve => {
      const id = `confirm-${Date.now()}`;
      setDisplay(d => [...d, { kind: 'confirmation', question, id }]);
      setPendingConfirm({ id, resolve });
    }));
    return () => setConfirmationCallback(() => Promise.resolve(false));
  }, []);

  // Start RAG file watcher; refresh stats when index updates
  useEffect(() => {
    startWatcher(process.cwd());
    // Refresh header stats every 5s in case background reindex completes
    const timer = setInterval(() => setIndexStats(getIndexStats()), 5000);
    return () => { stopWatcher(); clearInterval(timer); };
  }, []);

  // Auto-save session
  const persistSession = useCallback(() => {
    const snapshot: SessionSnapshot = {
      project:      process.cwd(),
      savedAt:      new Date().toISOString(),
      messages:     historyRef.current,
      taskCount:    taskCountRef.current,
      totalCostUsd: statsRef.current.totalCost,
    };
    saveSession(snapshot);
  }, []);

  const handleConfirm = useCallback((id: string, yes: boolean) => {
    setPendingConfirm(prev => {
      if (prev?.id === id) { prev.resolve(yes); return null; }
      return prev;
    });
    setDisplay(d => d.filter(m => !(m.kind === 'confirmation' && m.id === id)));
    setDisplay(d => [...d, { kind: 'assistant', text: yes ? '✅ Confirmed.' : '🚫 Cancelled.' }]);
  }, []);

  const switchModel = useCallback((m: ModelId) => { setCurrentModel(m); modelRef.current = m; }, []);
  const push = useCallback((msg: DisplayMessage) => setDisplay(d => [...d, msg]), []);

  // ── Core tool-calling loop ─────────────────────────────────────────────────
  const runToolLoop = useCallback(async (
    history: Message[],
    agentRole: AgentRole = 'solo',
    modelOverride?: string,
  ): Promise<string> => {
    const model = modelOverride ?? modelRef.current;
    const maxIter = config.maxIterations;
    let finalOutput = '';

    for (let iter = 0; iter < maxIter; iter++) {
      const compressed = await compressIfNeeded(history);
      history.length = 0;
      history.push(...compressed);

      const resp = await callModel(history, model);
      statsRef.current = accumulateUsage(statsRef.current, resp.usage, model as ModelId);
      setDisplay(d => d); // nudge re-render for header cost

      const msg = resp.message;
      history.push(msg);

      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) {
        finalOutput = content;
        push({ kind: 'assistant', text: content, reasoning: resp.reasoning, agent: agentRole });
      }

      const toolCalls = (msg as any).tool_calls as Array<{
        id: string; function: { name: string; arguments: string };
      }> | undefined;

      if (!toolCalls?.length) break;

      setStatusLine(`${agentRole !== 'solo' ? `[${agentRole}] ` : ''}Running ${toolCalls.length} tool(s)…`);

      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); }
        catch { args = { raw: tc.function.arguments }; }

        push({ kind: 'tool_call', name: tc.function.name, args: tc.function.arguments });
        const result = await executeTool(tc.function.name, args);

        setDisplay(d => {
          const copy = [...d];
          for (let i = copy.length - 1; i >= 0; i--) {
            const entry = copy[i];
            if (entry?.kind === 'tool_call' && entry.name === tc.function.name && entry.result === undefined) {
              copy[i] = { ...entry, result };
              break;
            }
          }
          return copy;
        });

        history.push({ role: 'tool', tool_call_id: tc.id, content: result } as Message);
      }
    }
    return finalOutput;
  }, [config.maxIterations, push]);

  // ── Slash commands ─────────────────────────────────────────────────────────
  const handleSlashCommand = useCallback(async (cmd: string): Promise<boolean> => {
    const parts = cmd.trim().split(/\s+/);
    const name  = parts[0]?.toLowerCase() ?? '';
    const rest  = parts.slice(1).join(' ');

    switch (name) {
      case '/help':
        setShowPalette(p => !p);
        return true;

      case '/clear':
        setDisplay([]);
        setShowPalette(false);
        historyRef.current = [{ role: 'system', content: SYSTEM_PROMPT }];
        statsRef.current = emptyStats();
        setStatusLine('History cleared.');
        return true;

      case '/model':
        if (rest && (ALL_MODELS as readonly string[]).includes(rest)) {
          switchModel(rest as ModelId);
          setStatusLine(`Model → ${rest}`);
        } else if (rest) {
          setStatusLine(`Unknown model. Available: ${ALL_MODELS.join(', ')}`);
        } else {
          setStatusLine(`Current: ${modelRef.current}. Options: ${ALL_MODELS.join(', ')}`);
        }
        return true;

      case '/think': {
        if (!rest) { setStatusLine('Usage: /think <question>'); return true; }
        const reasonerModel: ModelId = REASONER_MODELS.has(modelRef.current) ? modelRef.current : 'deepseek-r1';
        push({ kind: 'divider', label: `Think · ${new Date().toLocaleTimeString()}` });
        push({ kind: 'user', text: rest });
        historyRef.current.push({ role: 'user', content: rest });
        thinkingRef.current = true;
        setThinking(true);
        setActiveAgent('solo');
        setStatusLine(`Reasoning with ${reasonerModel}…`);
        taskStart.current = Date.now();
        try {
          await runToolLoop(historyRef.current, 'solo', reasonerModel);
          setStatusLine(`Done — ${formatTokenUsage(statsRef.current.inputTokens, statsRef.current.outputTokens)} this session`);
        } catch (err: any) {
          push({ kind: 'error', text: err.message });
        } finally {
          thinkingRef.current = false;
          setThinking(false);
          setActiveAgent(null);
        }
        return true;
      }

      case '/multi': {
        if (!rest) { setStatusLine('Usage: /multi <task>'); return true; }
        push({ kind: 'divider', label: `Multi-agent · ${new Date().toLocaleTimeString()}` });
        push({ kind: 'user', text: `[multi] ${rest}` });
        thinkingRef.current = true;
        setThinking(true);
        taskStart.current = Date.now();
        taskCountRef.current += 1;

        try {
          const result = await runMultiAgent(rest, {
            model: modelRef.current,
            onAgentStart: (role, phase, total, estimatedSecs) => {
              setActiveAgent(
                role === 'analysis' ? 'analysis' :
                role === 'sanity'   ? null :
                role === 'fix'      ? 'coder' :
                role as AgentRole,
              );
              push({ kind: 'agent_phase', role, status: 'Starting…', phase, total, estimatedSecs });
              setStatusLine(`[${role}] Running…`);
            },
            onAgentProgress: (_role, status) => setStatusLine(status),
            onToolCall: (_role, tool) => { push({ kind: 'tool_call', name: tool, args: '{}' }); },
            onFileChange: (file) => addFileChanged(file),
            onCostProjection: (low, high, complexity, difficulty, estimatedFiles) => {
              push({ kind: 'cost_projection', low, high, complexity, difficulty, estimatedFiles });
            },
          });

          const analysisLines = [
            `**🔬 Task Analysis**`,
            `Complexity: ${result.analysis.complexity} (${result.analysis.difficulty}/10) · Model: ${result.analysis.suggestedModel}`,
            result.analysis.summary,
            result.analysis.keyRisks.length ? `Risks: ${result.analysis.keyRisks.join(', ')}` : '',
            result.analysis.subtasks?.length
              ? `\nSubtasks:\n${result.analysis.subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
              : '',
          ].filter(Boolean).join('\n');

          push({ kind: 'assistant', text: analysisLines, agent: 'analysis' as any });
          push({ kind: 'assistant', text: `**🏗️ Architect's Plan**\n${result.architectPlan}`, agent: 'architect' });
          push({ kind: 'assistant', text: `**⌨️ Coder's Summary**\n${result.coderSummary}`, agent: 'coder' });
          push({ kind: 'assistant', text: `**🔍 Review Verdict**\n${result.reviewVerdict}`, agent: 'reviewer' });
          if (result.sanityCheck) {
            push({ kind: 'assistant', text: `**✅ Sanity Check**\n${result.sanityCheck}`, agent: 'reviewer' });
          }
          push({
            kind: 'summary',
            stats: result.totalUsage,
            duration: result.durationMs / 1000,
            filesChanged: result.filesChanged,
            fixIterations: result.fixIterations,
            approved: result.approved,
          });

          statsRef.current = {
            inputTokens:  statsRef.current.inputTokens  + result.totalUsage.inputTokens,
            outputTokens: statsRef.current.outputTokens + result.totalUsage.outputTokens,
            cachedTokens: statsRef.current.cachedTokens + result.totalUsage.cachedTokens,
            totalCost:    statsRef.current.totalCost    + result.totalUsage.totalCost,
            iterations:   statsRef.current.iterations   + result.totalUsage.iterations,
          };
          persistSession();
          setStatusLine(result.approved
            ? `✅ APPROVED in ${result.fixIterations} iteration(s) — ${formatTokenUsage(result.totalUsage.inputTokens, result.totalUsage.outputTokens)}`
            : `⚠️  NEEDS FIXES — ${formatTokenUsage(result.totalUsage.inputTokens, result.totalUsage.outputTokens)}`);
        } catch (err: any) {
          push({ kind: 'error', text: `Multi-agent failed: ${err.message}` });
        } finally {
          thinkingRef.current = false;
          setThinking(false);
          setActiveAgent(null);
        }
        return true;
      }

      // ── /oneshot ─────────────────────────────────────────────────────────────
      case '/oneshot': {
        if (!rest) { setStatusLine('Usage: /oneshot <task>'); return true; }
        push({ kind: 'divider', label: `Oneshot · ${new Date().toLocaleTimeString()}` });
        push({ kind: 'user', text: `[oneshot] ${rest}` });
        thinkingRef.current = true;
        setThinking(true);
        taskStart.current = Date.now();

        try {
          const result = await runMultiAgent(rest, {
            model: modelRef.current,
            onAgentStart: (role, phase, total, estimatedSecs) => {
              push({ kind: 'agent_phase', role, status: 'Starting…', phase, total, estimatedSecs });
              setStatusLine(`[${role}] Running…`);
            },
            onFileChange: (file) => addFileChanged(file),
            onCostProjection: (low, high, complexity) => {
              push({ kind: 'cost_projection', low, high, complexity, difficulty: 5, estimatedFiles: 3 });
            },
          });
          const gate = runQualityGate(process.cwd());
          const gatePassed = gate.passed;
          const overallApproved = result.approved && gatePassed;

          // ── Structured CI-friendly stdout report ──────────────────────────
          const sep = '═'.repeat(60);
          const thin = '─'.repeat(60);
          const verdict = overallApproved ? '✅ APPROVED' : '❌ NEEDS FIXES';
          const report = [
            '',
            sep,
            `  Forge Oneshot Report`,
            `  ${new Date().toISOString()}`,
            sep,
            ``,
            `  Task       : ${rest}`,
            `  Verdict    : ${verdict}`,
            `  Complexity : ${result.analysis.complexity} (difficulty ${result.analysis.difficulty}/10)`,
            `  Iterations : ${result.fixIterations} (max allowed: ${result.analysis.maxFixIterations})`,
            `  Duration   : ${formatDuration(result.durationMs / 1000)}`,
            `  Tokens     : ↑${result.totalUsage.inputTokens.toLocaleString()} in  ↓${result.totalUsage.outputTokens.toLocaleString()} out`,
            result.filesChanged.length
              ? `  Files      : ${result.filesChanged.join(', ')}`
              : `  Files      : (none tracked by name — check git diff)`,
            ``,
            thin,
            `  Coder Summary`,
            thin,
            result.coderSummary.trim().split('\n').map(l => `  ${l}`).join('\n'),
            ``,
            thin,
            `  Reviewer Verdict`,
            thin,
            result.reviewVerdict.trim().split('\n').map(l => `  ${l}`).join('\n'),
            result.sanityCheck
              ? [``, thin, `  Sanity Check`, thin,
                 result.sanityCheck.trim().split('\n').map(l => `  ${l}`).join('\n')].join('\n')
              : '',
            '',
            thin,
            '  Quality Gate',
            thin,
            ...gate.checks.map(c => `  ${c.pass ? '✅' : '❌'} ${c.name}${c.command ? ` (${c.command})` : ''}`),
            ``,
            sep,
            `  Exit code: ${overallApproved ? 0 : 1}`,
            sep,
            '',
          ].filter(l => l !== undefined).join('\n');

          process.stdout.write(report);

          push({
            kind: 'summary',
            stats: result.totalUsage,
            duration: result.durationMs / 1000,
            filesChanged: result.filesChanged,
            fixIterations: result.fixIterations,
            approved: overallApproved,
          });
          push({
            kind: 'quality_gate',
            passed: gatePassed,
            lines: gate.checks.map(c => `${c.pass ? '✅' : '❌'} ${c.name}${c.command ? ` (${c.command})` : ''}`),
          });

          // Exit with code reflecting approval status
          setTimeout(() => exit(), 300);
          process.exitCode = overallApproved ? 0 : 1;
        } catch (err: any) {
          const errMsg = err.message ?? String(err);
          process.stderr.write(`\nForge oneshot error: ${errMsg}\n`);
          push({ kind: 'error', text: `Oneshot failed: ${errMsg}` });
          setTimeout(() => exit(), 300);
          process.exitCode = 2;
        } finally {
          thinkingRef.current = false;
          setThinking(false);
          setActiveAgent(null);
        }
        return true;
      }

      // ── /benchmark ───────────────────────────────────────────────────────────
      case '/benchmark': {
        push({ kind: 'divider', label: `Benchmark · ${new Date().toLocaleTimeString()}` });
        thinkingRef.current = true;
        setThinking(true);
        setStatusLine('Running internal capability benchmark…');
        try {
          const lines = await runBenchmark();
          push({ kind: 'benchmark', lines });
          // Refresh index stats after benchmark (it queries the index)
          setIndexStats(getIndexStats());
          const scoreLine = lines.find(l => l.startsWith('Score:')) ?? '';
          setStatusLine(`Benchmark complete. ${scoreLine}`);
        } catch (err: any) {
          push({ kind: 'error', text: `Benchmark error: ${err.message}` });
        } finally {
          thinkingRef.current = false;
          setThinking(false);
        }
        return true;
      }

      case '/checkpoint': {
        try {
          const r = createCheckpoint({ label: rest || undefined });
          push({ kind: 'assistant', text: r });
          setStatusLine('Checkpoint created.');
        } catch (err: any) {
          push({ kind: 'error', text: err.message });
        }
        return true;
      }

      case '/commit': {
        thinkingRef.current = true;
        setThinking(true);
        setStatusLine('Creating smart commit…');
        try {
          const r = await executeTool('smart_commit', { hint: rest || undefined });
          push({ kind: 'assistant', text: r });
          setStatusLine('Committed.');
        } catch (err: any) {
          push({ kind: 'error', text: err.message });
        } finally {
          thinkingRef.current = false;
          setThinking(false);
        }
        return true;
      }

      case '/memory': {
        const memories = recallMemory({ query: rest || undefined });
        push({ kind: 'assistant', text: `**🧠 Project Memory**\n${memories}` });
        return true;
      }

      case '/reindex': {
        thinkingRef.current = true;
        setThinking(true);
        setIndexingProgress({ n: 0, total: 0 });
        setStatusLine('Building semantic search index…');
        try {
          const r = await reindex((n, total) => {
            setIndexingProgress({ n, total });
            setStatusLine(`Indexing ${n}/${total} files…`);
          });
          setIndexingProgress(null);
          setIndexStats(getIndexStats());
          push({ kind: 'assistant', text: `🧬 ${r}` });
          setStatusLine('Index ready.');
        } catch (err: any) {
          setIndexingProgress(null);
          push({ kind: 'error', text: `Index failed: ${err.message}` });
        } finally {
          thinkingRef.current = false;
          setThinking(false);
        }
        return true;
      }

      case '/report': {
        const days = parseInt(rest || '7', 10);
        push({ kind: 'assistant', text: getUsageReport(isNaN(days) ? 7 : days) });
        return true;
      }

      case '/status': {
        const s = statsRef.current;
        const elapsed = formatDuration((Date.now() - sessionStart.current) / 1000);
        const idx = getIndexStats();
        push({ kind: 'assistant', text: [
          `**Session Status**`,
          `Model:   ${modelRef.current}`,
          `Elapsed: ${elapsed}`,
          `Tokens:  ${formatTokenUsage(s.inputTokens, s.outputTokens)}`,
          `Calls:   ${s.iterations}`,
          `History: ${historyRef.current.length} messages`,
          `RAG:     ${idx.fileCount} files · ${formatChunks(idx.chunkCount)} chunks · ${idx.symbolCount} symbols`,
        ].join('\n') });
        return true;
      }

      case '/ship': {
        push({ kind: 'divider', label: `Ship Gate · ${new Date().toLocaleTimeString()}` });
        setStatusLine('Running production quality gate…');
        thinkingRef.current = true;
        setThinking(true);
        try {
          const gate = runQualityGate(process.cwd());
          const lines = gate.checks.map(c => `${c.pass ? '✅' : '❌'} ${c.name}${c.command ? ` (${c.command})` : ''}`);
          push({ kind: 'quality_gate', passed: gate.passed, lines });
          setStatusLine(gate.passed ? '✅ Quality gate passed' : '❌ Quality gate failed');
        } catch (err: any) {
          push({ kind: 'error', text: `Quality gate failed to run: ${err.message ?? String(err)}` });
          setStatusLine('❌ Quality gate execution error');
        } finally {
          thinkingRef.current = false;
          setThinking(false);
        }
        return true;
      }

      case '/cost':
        setStatusLine(`${formatTokenUsage(statsRef.current.inputTokens, statsRef.current.outputTokens)} · ${statsRef.current.iterations} calls`);
        return true;

      default: {
        const known = SLASH_COMMANDS.map(c => c.cmd.split(/\s/)[0]!);
        const typed = name;
        const fuzzy = known.find(k => k.startsWith(typed) || typed.startsWith(k.slice(0, -1)));
        if (fuzzy) {
          setStatusLine(`Unknown command "${name}" — did you mean ${fuzzy}?`);
          return handleSlashCommand(fuzzy + (rest ? ' ' + rest : ''));
        }
        setStatusLine(`Unknown command: ${name}. Type /help.`);
        return true;
      }
    }
  }, [switchModel, push, runToolLoop, persistSession, addFileChanged, exit]);

  // ── Main submit ────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || thinkingRef.current || pendingConfirm) return;
    setInput('');
    setShowPalette(false);

    if (text.startsWith('/')) { await handleSlashCommand(text); return; }

    setDisplay(d => [...d,
      { kind: 'divider', label: new Date().toLocaleTimeString() },
      { kind: 'user', text },
    ]);
    historyRef.current.push({ role: 'user', content: text });
    taskCountRef.current += 1;

    thinkingRef.current = true;
    setThinking(true);
    setActiveAgent('solo');
    taskStart.current = Date.now();
    setStatusLine('Calling model…');

    const ragCtx = buildRagContext(text, 4);
    if (ragCtx && historyRef.current[0]) {
      const base = typeof historyRef.current[0].content === 'string' ? historyRef.current[0].content : '';
      if (!base.includes('Relevant Code')) {
        historyRef.current[0] = { role: 'system', content: base + ragCtx };
      }
    }

    try {
      await runToolLoop(historyRef.current, 'solo');

      const duration = (Date.now() - taskStart.current) / 1000;
      if (statsRef.current.iterations > 0 && (statsRef.current.iterations % 5 === 0 || filesChanged.length > 0)) {
        push({ kind: 'summary', stats: { ...statsRef.current }, duration, filesChanged: [...filesChanged] });
      }

      appendUsageRecord({
        ts: new Date().toISOString(),
        model: modelRef.current,
        project: process.cwd(),
        inputTokens: statsRef.current.inputTokens,
        outputTokens: statsRef.current.outputTokens,
        costUsd: statsRef.current.totalCost,
        durationSecs: duration,
        taskDescription: text.slice(0, 80),
      });

      persistSession();
      setStatusLine(`Done · ${formatTokenUsage(statsRef.current.inputTokens, statsRef.current.outputTokens)} this session`);
    } catch (err: any) {
      push({ kind: 'error', text: err.message ?? String(err) });
      setStatusLine('Error occurred.');
    } finally {
      thinkingRef.current = false;
      setThinking(false);
      setActiveAgent(null);
    }
  }, [input, handleSlashCommand, runToolLoop, push, pendingConfirm, persistSession, filesChanged]);

  // Fire initial task from CLI argument
  useEffect(() => {
    if (!initialTask || initialTaskFired.current) return;
    initialTaskFired.current = true;
    setWelcomeDismissed(true);
    const timer = setTimeout(() => {
      const runTask = async () => {
        setDisplay(d => [...d,
          { kind: 'divider', label: new Date().toLocaleTimeString() },
          { kind: 'user', text: initialTask },
        ]);
        historyRef.current.push({ role: 'user', content: initialTask });
        thinkingRef.current = true;
        setThinking(true);
        setActiveAgent('solo');
        taskStart.current = Date.now();
        setStatusLine('Calling model…');

        const ragCtx = buildRagContext(initialTask, 3);
        if (ragCtx && historyRef.current[0]) {
          const base = typeof historyRef.current[0].content === 'string' ? historyRef.current[0].content : '';
          if (!base.includes('Relevant Code')) {
            historyRef.current[0] = { role: 'system', content: base + ragCtx };
          }
        }
        try {
          await runToolLoop(historyRef.current, 'solo');
          setStatusLine(`Done · ${formatTokenUsage(statsRef.current.inputTokens, statsRef.current.outputTokens)} this session`);
        } catch (err: any) {
          setDisplay(d => [...d, { kind: 'error', text: err.message ?? String(err) }]);
          setStatusLine('Error occurred.');
        } finally {
          thinkingRef.current = false;
          setThinking(false);
          setActiveAgent(null);
        }
      };
      runTask();
    }, 150);
    return () => clearTimeout(timer);
  }, [initialTask, runToolLoop]);

  const stats = statsRef.current;
  const showBanner = showWelcome && !welcomeDismissed && display.length === 0 && !thinking;
  const isIndexing = indexingProgress !== null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        model={currentModel}
        stats={stats}
        thinking={thinking}
        activeAgent={activeAgent}
        sessionStart={sessionStart.current}
        indexStats={indexStats}
        indexing={isIndexing}
      />
      <Newline />

      {showBanner && <WelcomeBanner indexStats={indexStats} />}

      {/* Indexing progress bar — shown while /reindex is running */}
      {isIndexing && indexingProgress && (
        <Box paddingLeft={1} marginBottom={1}>
          <IndexingBar progress={indexingProgress.n} total={indexingProgress.total || 1} />
        </Box>
      )}

      {showPalette && <CommandPalette />}

      {display.map((msg, i) =>
        (MESSAGE_RENDERERS[msg.kind] as (m: DisplayMessage, k: number, cb?: (id: string, y: boolean) => void) => React.ReactElement | null)(
          msg, i, msg.kind === 'confirmation' ? handleConfirm : undefined
        )
      )}

      {/* Live files-changed badge while agent is working */}
      {thinking && filesChanged.length > 0 && <FilesChangedBadge files={filesChanged} />}

      {/* Input box */}
      {!pendingConfirm && (
        <Box borderStyle="round" borderColor={thinking ? 'yellow' : 'green'} paddingX={1} marginTop={1}>
          <Text color={thinking ? 'yellow' : 'greenBright'}>{thinking ? '⏳' : '›'}{' '}</Text>
          <TextInput
            value={input}
            onChange={(v) => {
              setInput(v);
              if (v.length > 0) setWelcomeDismissed(true);
              if (v === '/') setShowPalette(true);
              else if (!v.startsWith('/')) setShowPalette(false);
            }}
            onSubmit={handleSubmit}
            placeholder={thinking ? 'Working…' : 'Task, question, or / for commands'}
            focus={!thinking && !pendingConfirm}
          />
        </Box>
      )}

      <Box paddingX={1}>
        <Text color="gray" dimColor>{statusLine}</Text>
      </Box>
      <HelpBar />
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function startInteractive(
  config: Config,
  initialTask?: string,
  resumeSession?: SessionSnapshot,
): Promise<void> {
  initAgent(config);

  // Welcome banner: show once per calendar day
  let showWelcome = false;
  const welcomePath = path.join(CONFIG_DIR, '.last_welcome');
  const today = new Date().toDateString();
  try {
    showWelcome = fs.readFileSync(welcomePath, 'utf-8').trim() !== today;
  } catch {
    showWelcome = true;
  }
  try { fs.writeFileSync(welcomePath, today); } catch { /* ignore */ }

  // Background RAG index on startup (non-blocking)
  if (config.autoIndexOnStartup) {
    reindex().catch(() => { /* silent fail */ });
  }

  const { waitUntilExit } = render(
    React.createElement(Interactive, { config, initialTask, showWelcome, resumeSession }),
    { exitOnCtrlC: true },
  );
  await waitUntilExit();
}
