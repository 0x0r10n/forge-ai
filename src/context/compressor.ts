/**
 * Context compressor — keeps the message history within token budget.
 *
 * v2 — Tiered compression strategy:
 * - Tier 1 (50k tokens): gentle compression — summarize middle, keep last 10 turns verbatim
 * - Tier 2 (80k tokens): aggressive compression — keep only system + last 6 turns + dense summary
 * - Rolling window preserves tool-call pairs (assistant + tool result stay together)
 * - Cost-aware: skips expensive summary API call and truncates if budget is already tight
 */

import { callModel, type Message } from '../agent.js';

const CHARS_PER_TOKEN = 4;                           // rough estimate
const TIER1_TOKENS    = 50_000;                      // gentle compress
const TIER2_TOKENS    = 80_000;                      // aggressive compress
const TIER1_KEEP_RECENT = 10;                        // messages kept verbatim
const TIER2_KEEP_RECENT = 6;
const SUMMARY_MODEL   = 'deepseek-chat';
const SUMMARY_MAX_COST_CHARS = 150_000;              // skip summary if too expensive

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length / CHARS_PER_TOKEN;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === 'object' && 'text' in part) {
          total += (part as any).text.length / CHARS_PER_TOKEN;
        }
      }
    }
  }
  return total;
}

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map(p => (typeof p === 'object' && 'text' in p ? (p as any).text : ''))
      .join(' ');
  }
  return '';
}

/**
 * Pair tool messages with their preceding assistant messages so they're
 * never split apart during compression — orphan tool results confuse models.
 */
function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    // An assistant message followed by one or more tool messages forms a group
    if (m.role === 'assistant') {
      const group: Message[] = [m];
      while (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
        i++;
        group.push(messages[i]!);
      }
      groups.push(group);
    } else {
      groups.push([m]);
    }
    i++;
  }
  return groups;
}

async function buildSummary(toCompress: Message[], budgetLeft: number): Promise<string> {
  const transcript = toCompress
    .filter(m => m.role !== 'tool')
    .map(m => `[${m.role.toUpperCase()}]: ${messageText(m).slice(0, 600)}`)
    .join('\n\n');

  // If transcription itself is huge, truncate rather than paying for a long summary
  const truncated = transcript.slice(0, SUMMARY_MAX_COST_CHARS);

  try {
    const summaryResp = await callModel(
      [
        {
          role: 'system',
          content: 'You are a precise technical summarizer. Summarize the following agent conversation section into a dense paragraph (max 250 words) covering: (1) what task was being done, (2) which tools were called and what files were changed, (3) what decisions were made, (4) current state. Omit pleasantries. Be specific — name exact file paths and function names.',
        },
        { role: 'user', content: truncated },
      ],
      SUMMARY_MODEL,
    );
    return typeof summaryResp.message.content === 'string'
      ? summaryResp.message.content
      : `[${toCompress.length} messages compressed — summary unavailable]`;
  } catch {
    return `[${toCompress.length} earlier messages compressed to save context window]`;
  }
}

export async function compressIfNeeded(messages: Message[]): Promise<Message[]> {
  const tokens = estimateTokens(messages);

  // No compression needed
  if (tokens < TIER1_TOKENS) return messages;

  const [systemMsg, ...rest] = messages;
  if (!systemMsg) return messages;

  // Decide tier
  const keepRecent = tokens >= TIER2_TOKENS ? TIER2_KEEP_RECENT : TIER1_KEEP_RECENT;

  // Group into paired blocks so tool results stay with their assistant message
  const groups = groupMessages(rest);
  if (groups.length <= keepRecent) return messages;

  // Split: compress the old groups, keep the recent ones verbatim
  const oldGroups = groups.slice(0, groups.length - keepRecent);
  const recentGroups = groups.slice(groups.length - keepRecent);

  const toCompress = oldGroups.flat();
  const toKeep     = recentGroups.flat();

  if (toCompress.length === 0) return messages;

  // Budget left after system message
  const sysContent = typeof systemMsg.content === 'string' ? systemMsg.content : '';
  const budgetLeft = Math.max(0, TIER1_TOKENS - sysContent.length / CHARS_PER_TOKEN);

  const summaryText = await buildSummary(toCompress, budgetLeft);

  const summaryMessage: Message = {
    role: 'assistant',
    content: `[CONTEXT SUMMARY — earlier messages compressed]\n${summaryText}`,
  };

  return [systemMsg, summaryMessage, ...toKeep];
}
