/**
 * Persistent token/cost usage history.
 * Appends one record per session to ~/.forge/usage.jsonl
 * and provides daily/weekly aggregations.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR, type ModelId } from '../config.js';
import type { UsageStats } from '../agent.js';

const USAGE_PATH = path.join(CONFIG_DIR, 'usage.jsonl');

export interface UsageRecord {
  ts: string;        // ISO date
  model: ModelId;
  project: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationSecs: number;
  taskDescription?: string;
}

export function appendUsageRecord(record: UsageRecord): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(USAGE_PATH, JSON.stringify(record) + '\n');
  } catch { /* non-critical */ }
}

function loadRecords(): UsageRecord[] {
  try {
    return fs.readFileSync(USAGE_PATH, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as UsageRecord);
  } catch {
    return [];
  }
}

function msAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export function getUsageReport(days = 7): string {
  const records = loadRecords();
  const cutoff = msAgo(days);
  const recent = records.filter(r => new Date(r.ts).getTime() >= cutoff);

  if (recent.length === 0) return `No usage in the last ${days} days.`;

  const totalCost = recent.reduce((s, r) => s + r.costUsd, 0);
  const totalIn   = recent.reduce((s, r) => s + r.inputTokens, 0);
  const totalOut  = recent.reduce((s, r) => s + r.outputTokens, 0);

  // By day
  const byDay: Record<string, { cost: number; sessions: number }> = {};
  for (const r of recent) {
    const day = r.ts.slice(0, 10);
    byDay[day] ??= { cost: 0, sessions: 0 };
    byDay[day]!.cost += r.costUsd;
    byDay[day]!.sessions += 1;
  }

  const dayLines = Object.entries(byDay)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, d]) => `  ${day}  $${d.cost.toFixed(4)}  (${d.sessions} session${d.sessions !== 1 ? 's' : ''})`)
    .join('\n');

  return [
    `Usage report — last ${days} days`,
    `─────────────────────────────────`,
    `Total cost   : $${totalCost.toFixed(4)}`,
    `Total tokens : ↑${(totalIn / 1000).toFixed(1)}k ↓${(totalOut / 1000).toFixed(1)}k`,
    `Sessions     : ${recent.length}`,
    ``,
    `By day:`,
    dayLines,
  ].join('\n');
}
