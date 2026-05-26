#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, saveConfig, ConfigSchema, ModelEnum, MODEL_LABELS, CONFIG_DIR, type ModelId } from './config.js';
import { startInteractive } from './ui/interactive.js';
import { loadSession, hasSession, formatLastSession } from './context/session.js';
import { APP_VERSION } from './version.js';

const VERSION = APP_VERSION;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`  ✅  ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ⚠️   ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ❌  ${msg}`);
}

function withConfig<T>(fn: (cfg: ReturnType<typeof loadConfig>) => T): T {
  try {
    return fn(loadConfig());
  } catch (err: any) {
    // Friendly error with actionable hint
    if (err.message?.includes('No config found')) {
      die(`Not configured yet.\n\n  Run: forge setup\n`);
    }
    if (err.message?.includes('Config unreadable')) {
      die(`${err.message}\n\n  Fix: forge setup\n`);
    }
    die(err.message ?? String(err));
  }
}

function isFirstRun(): boolean {
  return !fs.existsSync(path.join(CONFIG_DIR, 'config.json'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Program
// ─────────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('forge')
  .description('Forge better code. Faster.')
  .version(VERSION, '-v, --version', 'Print version number')
  .addHelpText('after', `
Examples:
  $ forge setup                  Configure API key and preferences
  $ forge                        Start interactive coding session
  $ forge "fix the auth bug"     Start with an initial task
  $ forge -m deepseek-r1         Start with the reasoning model
  $ forge doctor                 Check your setup
  $ forge models                 List available models

Slash commands (inside the TUI):
  /multi <task>     Run Architect→Coder→Reviewer pipeline
  /think <question> Force deep reasoning (DeepSeek-R1)
  /checkpoint       Snapshot current files
  /commit           Smart git commit
  /memory           Recall project memory
  /reindex          Rebuild semantic search index
  /help             Show all commands

Docs: https://github.com/forge-ai/forge
`);

// ── setup ─────────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('Configure API key, default model, and preferences')
  .option('--reset', 'Overwrite existing config')
  .action(async (opts: { reset?: boolean }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> =>
      new Promise(resolve => rl.question(q, resolve));

    console.log('\n  ⚡ Forge v' + VERSION + ' Setup\n');
    console.log('  Get your DeepSeek API key at: https://platform.deepseek.com/api_keys\n');

    let existingKey = '';
    try { existingKey = loadConfig().apiKey; } catch { /* first run */ }

    if (existingKey && !opts.reset) {
      console.log(`  Current key: ${existingKey.slice(0, 8)}… (run with --reset to overwrite)\n`);
    }

    const keyHint = existingKey ? ` [keep current: Enter]` : '';
    const rawKey  = (await ask(`  DeepSeek API key${keyHint}: `)).trim();
    const apiKey  = rawKey || existingKey;
    if (!apiKey) { rl.close(); die('API key is required. Get one at https://platform.deepseek.com/api_keys'); }

    const models = ModelEnum.options as readonly ModelId[];
    console.log('\n  Available models:');
    models.forEach((m, i) => console.log(`    ${i + 1}. ${m.padEnd(24)} ${MODEL_LABELS[m]}`));
    const modelChoice = (await ask('\n  Default model (1-4) [1 — deepseek-chat]: ')).trim();
    const modelIdx    = Math.max(0, parseInt(modelChoice || '1', 10) - 1);
    const defaultModel = models[Math.min(modelIdx, models.length - 1)] ?? models[0]!;

    const autoApproveRaw = (await ask('\n  Auto-approve tool calls without confirmation? (y/N) [N]: ')).trim().toLowerCase();
    const autoIndexRaw   = (await ask('  Auto-index codebase for semantic search on startup? (Y/n) [Y]: ')).trim().toLowerCase();
    const autoRouteRaw   = (await ask('  Auto-route to best model based on task complexity? (Y/n) [Y]: ')).trim().toLowerCase();
    rl.close();

    const config = ConfigSchema.parse({
      apiKey,
      defaultModel,
      autoApproveTools:              autoApproveRaw === 'y',
      autoIndexOnStartup:            autoIndexRaw !== 'n',
      autoRouteModels:               autoRouteRaw !== 'n',
      requireConfirmationForDangerous: true,
    });

    saveConfig(config);

    console.log('\n  ✅ Forge configured!\n');
    console.log(`     Model  : ${config.defaultModel}`);
    console.log(`     Config : ~/.forge/config.json`);
    console.log(`\n  Run \`forge\` to start coding.\n`);
    process.exit(0);
  });

// ── config ────────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('View or update configuration')
  .option('--set-model <model>', 'Set the default model')
  .option('--show', 'Print current config (default)')
  .action((opts: { setModel?: string; show?: boolean }) => {
    withConfig(config => {
      if (opts.setModel) {
        const parsed = ModelEnum.safeParse(opts.setModel);
        if (!parsed.success) die(`Invalid model "${opts.setModel}".\n  Options: ${ModelEnum.options.join(', ')}\n  Run: forge models`);
        saveConfig({ ...config, defaultModel: parsed.data });
        console.log(`\n  ✅ Default model → ${parsed.data}\n`);
        return;
      }
      console.log('\n  ⚡ Forge Config\n');
      const display = { ...config, apiKey: config.apiKey.slice(0, 8) + '…' };
      console.log(JSON.stringify(display, null, 2));
      console.log();
    });
  });

// ── models ────────────────────────────────────────────────────────────────────

program
  .command('models')
  .description('List available DeepSeek models and pricing')
  .action(() => {
    console.log('\n  Available models:\n');
    (ModelEnum.options as readonly ModelId[]).forEach(m => {
      console.log(`    • ${m.padEnd(24)} ${MODEL_LABELS[m]}`);
    });
    console.log('\n  Pricing (per 1M tokens):');
    console.log('    deepseek-chat / v3    $0.27 in / $1.10 out  (cached: $0.07)');
    console.log('    deepseek-reasoner/r1  $0.55 in / $2.19 out  (cached: $0.14)');
    console.log('\n  With --auto-route enabled, Forge picks the best model for each task automatically.\n');
  });

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Check your setup: API key, git, permissions, index')
  .action(async () => {
    console.log('\n  ⚡ Forge Doctor\n');

    // 1. Config file
    const configPath = path.join(CONFIG_DIR, 'config.json');
    if (fs.existsSync(configPath)) {
      ok(`Config found at ${configPath}`);
    } else {
      fail('No config file found');
      warn('Run: forge setup');
    }

    // 2. API key reachable
    let config: ReturnType<typeof loadConfig> | null = null;
    try {
      config = loadConfig();
      ok(`API key loaded (${config.apiKey.slice(0, 8)}…)`);
    } catch (err: any) {
      fail(`Config error: ${err.message}`);
    }

    // 3. Network reachability to DeepSeek
    if (config) {
      try {
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey: config.apiKey, baseURL: 'https://api.deepseek.com/v1', timeout: 8000 });
        await client.models.list();
        ok('DeepSeek API reachable');
      } catch (err: any) {
        if (err.status === 401) {
          fail('API key rejected (401 Unauthorized)');
          warn('Check your key at https://platform.deepseek.com/api_keys');
        } else {
          fail(`DeepSeek API unreachable: ${err.message}`);
          warn('Check your internet connection');
        }
      }
    }

    // 4. Git
    try {
      const { execSync } = await import('child_process');
      const ver = execSync('git --version', { encoding: 'utf-8' }).trim();
      ok(`Git available (${ver})`);

      const inRepo = fs.existsSync(path.join(process.cwd(), '.git'));
      if (inRepo) {
        ok('Current directory is a git repository');
      } else {
        warn('Not in a git repository — checkpoint & git tools will be limited');
        warn('Run: git init');
      }
    } catch {
      fail('Git not found');
      warn('Install git: https://git-scm.com/downloads');
    }

    // 5. Bun runtime
    try {
      const { execSync } = await import('child_process');
      const ver = execSync('bun --version', { encoding: 'utf-8' }).trim();
      ok(`Bun runtime available (v${ver})`);
    } catch {
      warn('Bun not found — install for best performance: https://bun.sh');
    }

    // 6. ~/.forge directory
    const ragDir = path.join(CONFIG_DIR, 'rag');
    const memPath = path.join(CONFIG_DIR, 'memory.json');
    const cpDir   = path.join(CONFIG_DIR, 'checkpoints');

    ok(`Config directory: ${CONFIG_DIR}`);

    if (fs.existsSync(ragDir) && fs.readdirSync(ragDir).length > 0) {
      ok('RAG index exists (semantic search ready)');
    } else {
      warn('No RAG index yet — run: /reindex inside Forge, or start a session');
    }

    if (fs.existsSync(memPath)) {
      const entries = JSON.parse(fs.readFileSync(memPath, 'utf-8') || '{}');
      const count = Object.values(entries).flat().length;
      ok(`Memory store exists (${count} entries)`);
    } else {
      warn('No memory store yet — will be created on first use');
    }

    if (fs.existsSync(cpDir)) {
      ok('Checkpoints directory exists');
    } else {
      warn('No checkpoints yet — use /checkpoint inside Forge');
    }

    console.log('\n  ✅ Doctor complete.\n');
  });

// ── update ────────────────────────────────────────────────────────────────────

program
  .command('update')
  .description('Update Forge to the latest version')
  .action(async () => {
    console.log('\n  ⚡ Checking for updates…\n');

    try {
      const { execSync } = await import('child_process');

      // Check latest version from npm registry
      let latest = '';
      try {
        latest = execSync('npm view forge-ai version', { encoding: 'utf-8' }).trim();
      } catch {
        fail('Could not check npm registry — check your internet connection');
        process.exit(1);
      }

      if (latest === VERSION) {
        ok(`Already on the latest version (v${VERSION})`);
        console.log();
        process.exit(0);
      }

      console.log(`  Current: v${VERSION}`);
      console.log(`  Latest:  v${latest}\n`);

      // Detect package manager
      const hasBun  = (() => { try { execSync('bun --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
      const hasPnpm = (() => { try { execSync('pnpm --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

      const cmd = hasBun
        ? 'bun add -g forge-ai'
        : hasPnpm
          ? 'pnpm add -g forge-ai'
          : 'npm install -g forge-ai';

      console.log(`  Running: ${cmd}\n`);
      execSync(cmd, { stdio: 'inherit' });
      console.log(`\n  ✅ Updated to v${latest}\n`);
    } catch (err: any) {
      fail(`Update failed: ${err.message}`);
      console.log('\n  Manual update:');
      console.log('    npm install -g forge-ai');
      console.log('    bun add -g forge-ai\n');
      process.exit(1);
    }
  });

// ── continue ──────────────────────────────────────────────────────────────────

program
  .command('continue')
  .description('Resume the last conversation for this project')
  .option('-m, --model <model>', 'Model to use for this session')
  .action(async (opts: { model?: string }) => {
    const config = withConfig(c => c);

    if (opts.model) {
      const parsed = ModelEnum.safeParse(opts.model);
      if (!parsed.success) die(`Invalid model: "${opts.model}"`);
      config.defaultModel = parsed.data;
    }

    if (!hasSession()) {
      console.log('\n  No saved session found for this project.\n');
      console.log('  Run \`forge\` to start a new session.\n');
      process.exit(0);
    }

    const session = loadSession()!;
    console.log(`\n  ↩️  Resuming session from ${session.savedAt.replace('T', ' ').slice(0, 16)} (${session.messages.length} messages)\n`);
    await startInteractive(config, undefined, session);
  });

// ── last ──────────────────────────────────────────────────────────────────────

program
  .command('last')
  .description('Show a summary of the last session for this project')
  .action(() => {
    // No config needed — just reads session file
    const session = loadSession();
    if (!session) {
      console.log('\n  No saved session for this project.\n');
      process.exit(0);
    }
    console.log('\n' + formatLastSession(session).split('\n').map(l => `  ${l}`).join('\n') + '\n');
  });

// ── default: interactive ──────────────────────────────────────────────────────

program
  .option('-m, --model <model>', 'Model to use for this session (overrides config)')
  .option('--no-color', 'Disable colored output')
  .argument('[task]', 'Optional initial task to start with')
  .action(async (task: string | undefined, opts: { model?: string }) => {
    // First-run welcome
    if (isFirstRun()) {
      console.log('\n  👋 Welcome to Forge v' + VERSION + '!\n');
      console.log('  It looks like this is your first time. Let\'s get set up.\n');
      console.log('  You\'ll need a DeepSeek API key (free at https://platform.deepseek.com/api_keys)\n');
      console.log('  Run: forge setup\n');
      process.exit(0);
    }

    const config = withConfig(c => c);

    if (opts.model) {
      const parsed = ModelEnum.safeParse(opts.model);
      if (!parsed.success) {
        die(`Invalid model: "${opts.model}"\n\n  Available: ${ModelEnum.options.join(', ')}\n  See all: forge models`);
      }
      config.defaultModel = parsed.data;
    }

    await startInteractive(config, task);
  });

program.parse();
