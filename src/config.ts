import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const CONFIG_DIR = path.join(os.homedir(), '.forge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const ModelEnum = z.enum([
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v3',
  'deepseek-r1',
]);

export type ModelId = z.infer<typeof ModelEnum>;

export const ConfigSchema = z.object({
  apiKey: z.string().min(10, 'API key too short'),
  defaultModel: ModelEnum.default('deepseek-chat'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(8192),
  theme: z.enum(['dark', 'light']).default('dark'),
  showTokens: z.boolean().default(true),
  autoApproveTools: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(30),
  // Safety
  requireConfirmationForDangerous: z.boolean().default(true),
  // Model routing
  autoRouteModels: z.boolean().default(true),
  // RAG
  autoIndexOnStartup: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

export const MODEL_LABELS: Record<ModelId, string> = {
  'deepseek-chat':     'DeepSeek Chat (fast, cheap)',
  'deepseek-reasoner': 'DeepSeek Reasoner (o1-style, CoT)',
  'deepseek-v3':       'DeepSeek V3 (balanced)',
  'deepseek-r1':       'DeepSeek R1 (reasoning, powerful)',
};

const CHAT_PRICING     = { input: 0.27, output: 1.10, cachedInput: 0.07 } as const;
const REASONER_PRICING = { input: 0.55, output: 2.19, cachedInput: 0.14 } as const;

export const MODEL_PRICING: Record<ModelId, { input: number; output: number; cachedInput: number }> = {
  'deepseek-chat':     CHAT_PRICING,
  'deepseek-v3':       CHAT_PRICING,
  'deepseek-reasoner': REASONER_PRICING,
  'deepseek-r1':       REASONER_PRICING,
};

export const REASONER_MODELS = new Set<ModelId>(['deepseek-reasoner', 'deepseek-r1']);

// Commands that require explicit user confirmation before executing
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\btruncate\b/,
  /\bformat\b/,
  /\b> \/dev\//,
  /\bkill\s+-9\b/,
  /\bcurl.+\|\s*(?:bash|sh)\b/,
  /\bwget.+\|\s*(?:bash|sh)\b/,
  /\bnpm publish\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b.*\b-f\b/,
  /\bgit push.*--force\b/,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(command));
}

export function computeCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): number {
  const p = MODEL_PRICING[model];
  return (
    ((inputTokens - cachedTokens) / 1_000_000) * p.input +
    (cachedTokens / 1_000_000) * p.cachedInput +
    (outputTokens / 1_000_000) * p.output
  );
}

/**
 * Route to the right model based on task complexity.
 * Simple queries → cheap chat. Complex / reasoning → pro.
 */
export function routeModel(task: string, defaultModel: ModelId): ModelId {
  const lower = task.toLowerCase();
  const tokens = task.split(/\s+/).length;

  // Always use reasoner for explicit thinking/design tasks
  if (/\b(design|architect|refactor|analyze|why|explain|reason|think|proof|algorithm)\b/.test(lower)) {
    return 'deepseek-r1';
  }
  // Short simple tasks → fast chat
  if (tokens < 15 && !/\b(implement|create|build|write|fix)\b/.test(lower)) {
    return 'deepseek-chat';
  }
  // Large implementation tasks → v3 balanced
  if (tokens > 30 || /\b(implement|refactor|migrate|upgrade)\b/.test(lower)) {
    return 'deepseek-v3';
  }
  return defaultModel;
}

export function loadConfig(): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new Error('No config found. Run: forge setup');
    throw new Error(`Config unreadable: ${err.message}`);
  }
  return ConfigSchema.parse(raw);
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function patchConfig(patch: Partial<Config>): void {
  saveConfig({ ...loadConfig(), ...patch });
}
