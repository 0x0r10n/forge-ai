import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../config.js';

const MEMORY_PATH = path.join(CONFIG_DIR, 'memory.json');

export interface MemoryEntry {
  id: string;
  tag: string;         // e.g. "architecture", "decision", "file-summary", "fact"
  content: string;
  project: string;     // cwd at save time, so memories are project-scoped
  createdAt: string;
  updatedAt: string;
}

type MemoryStore = Record<string, MemoryEntry>;  // keyed by id

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

function loadStore(): MemoryStore {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8')) as MemoryStore;
  } catch {
    return {};
  }
}

function saveStore(store: MemoryStore): void {
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API (used by tool implementations and agents)
// ─────────────────────────────────────────────────────────────────────────────

export function saveMemory(args: { id: string; tag: string; content: string }): string {
  const store = loadStore();
  const now = new Date().toISOString();
  const project = process.cwd();
  const existing = store[args.id];

  store[args.id] = {
    id: args.id,
    tag: args.tag,
    content: args.content,
    project,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  saveStore(store);
  return `✅ Memory saved: [${args.tag}] ${args.id}`;
}

export function recallMemory(args: { query?: string; tag?: string; limit?: number }): string {
  const store = loadStore();
  const project = process.cwd();
  let entries = Object.values(store).filter(e => e.project === project);

  if (args.tag) entries = entries.filter(e => e.tag === args.tag);

  if (args.query) {
    const q = args.query.toLowerCase();
    entries = entries.filter(e =>
      e.id.toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q) ||
      e.tag.toLowerCase().includes(q)
    );
  }

  // Most recently updated first
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const limit = args.limit ?? 20;
  const shown = entries.slice(0, limit);

  if (shown.length === 0) return 'No memories found for this project.';

  return shown
    .map(e => `[${e.tag}] ${e.id}\n  ${e.content}\n  (${e.updatedAt.slice(0, 10)})`)
    .join('\n\n');
}

export function deleteMemory(id: string): string {
  const store = loadStore();
  if (!store[id]) return `❌ Memory not found: ${id}`;
  delete store[id];
  saveStore(store);
  return `✅ Deleted memory: ${id}`;
}

export function listMemoryTags(): string[] {
  const store = loadStore();
  const project = process.cwd();
  return [...new Set(Object.values(store).filter(e => e.project === project).map(e => e.tag))];
}

/** Returns a compact context block the agent can prepend to its system prompt. */
export function getMemoryContext(): string {
  const store = loadStore();
  const project = process.cwd();
  const entries = Object.values(store)
    .filter(e => e.project === project)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30);

  if (entries.length === 0) return '';

  const lines = entries.map(e => `  [${e.tag}] ${e.id}: ${e.content}`).join('\n');
  return `\n## Project Memory (${entries.length} entries)\n${lines}\n`;
}
