/**
 * Session persistence — saves and restores conversation history.
 *
 * Enables:
 *   forge continue  — resume the last session in the current project
 *   forge last      — print a summary of the last session
 *
 * Storage: ~/.forge/sessions/<project-hash>.json
 * One session file per project (keeps only the last session to avoid unbounded growth).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG_DIR } from '../config.js';
import type { Message } from '../agent.js';

const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

export interface SessionSnapshot {
  project:     string;   // cwd
  savedAt:     string;   // ISO timestamp
  messages:    Message[];
  summary?:    string;   // LLM-generated summary for `forge last`
  taskCount:   number;   // how many user turns
  totalCostUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

function projectKey(project: string): string {
  return crypto.createHash('sha1').update(project).digest('hex').slice(0, 12);
}

function sessionPath(project: string): string {
  return path.join(SESSIONS_DIR, `${projectKey(project)}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function saveSession(snapshot: SessionSnapshot): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessionPath(snapshot.project), JSON.stringify(snapshot, null, 2));
  } catch { /* non-critical */ }
}

export function loadSession(project?: string): SessionSnapshot | null {
  const proj = project ?? process.cwd();
  try {
    return JSON.parse(fs.readFileSync(sessionPath(proj), 'utf-8')) as SessionSnapshot;
  } catch {
    return null;
  }
}

export function hasSession(project?: string): boolean {
  const proj = project ?? process.cwd();
  return fs.existsSync(sessionPath(proj));
}

export function deleteSession(project?: string): void {
  const proj = project ?? process.cwd();
  try { fs.unlinkSync(sessionPath(proj)); } catch { /* ignore */ }
}

export function formatLastSession(session: SessionSnapshot): string {
  const ago = formatAgo(new Date(session.savedAt));
  const lines = [
    `⚡ Last Session — ${path.basename(session.project)}`,
    `   Saved:    ${session.savedAt.replace('T', ' ').slice(0, 19)} (${ago})`,
    `   Tasks:    ${session.taskCount} turns`,
    `   Cost:     $${session.totalCostUsd.toFixed(4)}`,
    `   Messages: ${session.messages.length}`,
  ];
  if (session.summary) {
    lines.push(``, `Summary:`, ...session.summary.split('\n').map(l => `  ${l}`));
  }
  lines.push(``, `Run \`forge continue\` to resume.`);
  return lines.join('\n');
}

function formatAgo(date: Date): string {
  const secs = (Date.now() - date.getTime()) / 1000;
  if (secs < 60)   return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
