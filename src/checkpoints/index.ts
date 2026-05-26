import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CONFIG_DIR } from '../config.js';

const CHECKPOINTS_DIR = path.join(CONFIG_DIR, 'checkpoints');
const INDEX_PATH = path.join(CHECKPOINTS_DIR, 'index.json');

export interface Checkpoint {
  id: string;
  label: string;
  project: string;
  createdAt: string;
  files: Record<string, string>;  // relative-path → content
  gitRef?: string;                 // git stash ref if repo
}

type CheckpointIndex = Record<string, Omit<Checkpoint, 'files'>>;  // index without full content

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

function ensureDir() {
  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
}

function loadIndex(): CheckpointIndex {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')) as CheckpointIndex;
  } catch {
    return {};
  }
}

function saveIndex(index: CheckpointIndex): void {
  ensureDir();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function checkpointPath(id: string): string {
  return path.join(CHECKPOINTS_DIR, `${id}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function createCheckpoint(args: { label?: string; paths?: string[] }): string {
  ensureDir();

  const id = `cp_${Date.now()}`;
  const label = args.label ?? `Checkpoint ${new Date().toLocaleTimeString()}`;
  const project = process.cwd();
  const now = new Date().toISOString();

  // Collect files to snapshot
  const targetPaths = args.paths ?? discoverTrackedFiles(project);
  const files: Record<string, string> = {};

  for (const rel of targetPaths) {
    const abs = path.resolve(project, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        files[rel] = fs.readFileSync(abs, 'utf-8');
      }
    } catch { /* skip unreadable */ }
  }

  // Try to record git stash ref for extra safety
  let gitRef: string | undefined;
  try {
    execSync('git stash', { cwd: project, stdio: 'pipe' });
    gitRef = execSync('git stash list --format="%H" -1', { cwd: project, encoding: 'utf-8', stdio: 'pipe' }).trim();
    // Immediately pop it back — we just want the ref for reference
    execSync('git stash pop', { cwd: project, stdio: 'pipe' });
  } catch { /* not a git repo or nothing to stash */ }

  const cp: Checkpoint = { id, label, project, createdAt: now, files, gitRef };
  fs.writeFileSync(checkpointPath(id), JSON.stringify(cp, null, 2));

  const index = loadIndex();
  index[id] = { id, label, project, createdAt: now, gitRef };
  saveIndex(index);

  return `✅ Checkpoint created: ${id} — "${label}" (${Object.keys(files).length} files snapshotted)`;
}

export function listCheckpoints(args: { limit?: number } = {}): string {
  const index = loadIndex();
  const project = process.cwd();
  const entries = Object.values(index)
    .filter(c => c.project === project)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, args.limit ?? 20);

  if (entries.length === 0) return 'No checkpoints for this project.';

  return entries
    .map(c => `${c.id}  ${c.createdAt.slice(0, 19).replace('T', ' ')}  "${c.label}"`)
    .join('\n');
}

export function rollbackTo(args: { id: string }): string {
  const cpFile = checkpointPath(args.id);
  if (!fs.existsSync(cpFile)) return `❌ Checkpoint not found: ${args.id}`;

  let cp: Checkpoint;
  try {
    cp = JSON.parse(fs.readFileSync(cpFile, 'utf-8')) as Checkpoint;
  } catch (err: any) {
    return `❌ Checkpoint unreadable: ${err.message}`;
  }

  const project = process.cwd();
  if (cp.project !== project) {
    return `❌ Checkpoint belongs to a different project: ${cp.project}`;
  }

  let restored = 0;
  for (const [rel, content] of Object.entries(cp.files)) {
    const abs = path.resolve(project, rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      restored++;
    } catch { /* skip */ }
  }

  return `✅ Rolled back to "${cp.label}" (${args.id}): ${restored} files restored`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_SNAPSHOT_FILES = 200;

function discoverTrackedFiles(project: string): string[] {
  // Prefer git-tracked files (fast, respects .gitignore)
  try {
    const out = execSync('git ls-files', { cwd: project, encoding: 'utf-8', stdio: 'pipe' });
    return out.trim().split('\n').filter(Boolean).slice(0, MAX_SNAPSHOT_FILES);
  } catch {
    // Fall back to walking the directory
    return walkDir(project, project).slice(0, MAX_SNAPSHOT_FILES);
  }
}

function walkDir(root: string, dir: string): string[] {
  const result: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SNAPSHOT_IGNORE.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...walkDir(root, abs));
      else result.push(path.relative(root, abs));
    }
  } catch { /* skip */ }
  return result;
}
