<div align="center">

# Forge AI

## Forge better code. Faster.

**Open-source multi-agent coding agent for the terminal. Built for speed, cost-efficiency, and operator control with DeepSeek models.**

[![npm version](https://img.shields.io/npm/v/@0x0r10n/forge-ai?color=cyan&label=@0x0r10n/forge-ai)](https://www.npmjs.com/package/@0x0r10n/forge-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)

</div>

---

## What Forge AI Is

Forge AI is a terminal-first coding agent with a built-in multi-agent workflow:

- **Architect** plans the change.
- **Coder** implements and runs checks.
- **Reviewer** validates for quality and correctness.

It also includes local semantic code search (TF-IDF), persistent project memory, checkpoint/rollback, and quality gates for safer iteration.

---

## Capability Snapshot

| Capability | Forge AI | Cursor Composer 2.5 | Claude Code |
|---|:---:|:---:|:---:|
| Multi-agent pipeline (Architect → Coder → Reviewer) | ✅ | ⚠️ Varies by workflow | ❌ |
| Local semantic search (TF-IDF RAG) | ✅ | ✅ | ❌ |
| Project memory (local) | ✅ | ⚠️ Limited | ✅ |
| Checkpoint and rollback | ✅ | ❌ | ❌ |
| Terminal-native workflow | ✅ | ⚠️ Hybrid | ✅ |
| Open-source core | ✅ | ❌ | ❌ |
| Model routing controls | ✅ | ⚠️ Limited | ⚠️ Limited |

Notes:
- Table reflects current Forge AI features in this repository.
- Competitor columns are a practical high-level snapshot and may evolve over time.

---

## Install

```bash
npm install -g @0x0r10n/forge-ai
# or
bun add -g @0x0r10n/forge-ai
```

---

## Quickstart

```bash
# one-time setup
forge setup

# interactive mode
forge

# start with a task
forge "add JWT authentication to my Express app"
```

Verify setup:

```bash
forge doctor
```

---

## CLI Commands

| Command | Description |
|---|---|
| `forge setup` | Configure API key and defaults |
| `forge config` | View/update configuration |
| `forge models` | Show available model options |
| `forge doctor` | Run environment and dependency checks |
| `forge update` | Update global install |

---

## Slash Commands

| Command | Description |
|---|---|
| `/multi <task>` | Run Architect → Coder → Reviewer pipeline |
| `/oneshot <task>` | Run pipeline and exit with CI-friendly status |
| `/think <question>` | Force deeper reasoning model |
| `/checkpoint [label]` | Snapshot project files |
| `/commit [hint]` | Generate smart conventional commit |
| `/memory [query]` | Recall saved project memory |
| `/reindex` | Rebuild semantic index |
| `/report [days]` | Usage report |
| `/status` | Session status |
| `/ship` | Run production quality gate |
| `/cost` | Quick token usage display |
| `/clear` | Clear session history |
| `/help` | Show command list |

---

## Quality Gate

Forge AI includes a built-in ship gate (`/ship`) that checks local release readiness:

- git cleanliness (when in a git repo)
- typecheck (if script exists)
- lint (if script exists)
- tests (if script exists)
- build (if script exists)

This is designed to reduce “looks good but fails in CI” outcomes.

---

## Configuration

Config location:

```text
~/.forge/config.json
```

Example:

```json
{
  "apiKey": "sk-...",
  "defaultModel": "deepseek-chat",
  "autoRouteModels": true,
  "autoIndexOnStartup": true,
  "requireConfirmationForDangerous": true,
  "maxIterations": 30
}
```

---

## Current Scope and Limits

What is production-usable now:

- terminal workflow and slash command surface
- multi-agent orchestration
- local TF-IDF semantic search
- memory/checkpoint storage under `~/.forge`
- packaging as `@0x0r10n/forge-ai` with `forge` binary

Known limits:

- no MCP integration yet
- no native web retrieval tool by default
- benchmark/comparison claims are not a formal public benchmark suite

---

## Development

```bash
git clone git@github.com:0x0r10n/forge-ai.git
cd forge-ai
bun install
bun run typecheck
bun run build
bun dev
```

---

## License

[MIT](LICENSE) © Forge AI Contributors
