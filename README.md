<div align="center">

# Forge AI

## Forge better code. Faster.

**The open-source multi-agent coding agent that beats Cursor and Claude Code on price and control.**

[![npm version](https://img.shields.io/npm/v/forge-ai?color=cyan&label=forge-ai)](https://www.npmjs.com/package/forge-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)

</div>

---

## Why Forge AI

| Capability | Forge AI | Cursor Composer 2.5 | Claude Code |
|---|:---:|:---:|:---:|
| Multi-agent pipeline (Architect → Coder → Reviewer) | ✅ | ⚠️ Partial | ❌ |
| Local semantic search (TF-IDF RAG) | ✅ | ✅ | ❌ |
| Persistent project memory | ✅ | ❌ | ✅ |
| Checkpoint and rollback | ✅ | ❌ | ❌ |
| Smart git commit flow | ✅ | ⚠️ Basic | ✅ |
| Self-hostable OSS core | ✅ | ❌ | ❌ |
| Token-centric usage telemetry | ✅ | ⚠️ Limited | ⚠️ Limited |
| Control over model routing | ✅ | ⚠️ Limited | ❌ |

Forge AI is built for engineers who want agency, deterministic workflows, and lower operating cost without sacrificing capability.

---

## Install

```bash
npm install -g forge-ai
# or
bun add -g forge-ai
```

---

## Quickstart

```bash
# one-time setup
forge setup

# launch interactive mode
forge

# launch with an initial task
forge "add JWT authentication to my Express app"
```

### Verify setup

```bash
forge doctor
```

---

## Core Commands

| Command | Description |
|---|---|
| `forge setup` | Configure API key and defaults |
| `forge config` | Show/update configuration |
| `forge models` | List available models and pricing |
| `forge doctor` | Validate local setup and dependencies |
| `forge update` | Update global install |

---

## Slash Commands

| Command | Description |
|---|---|
| `/multi <task>` | Full Architect → Coder → Reviewer pipeline |
| `/oneshot <task>` | CI-friendly pipeline run and exit code |
| `/think <question>` | Force deep reasoning mode |
| `/checkpoint [label]` | Snapshot files for rollback |
| `/commit [hint]` | Smart conventional commit |
| `/memory [query]` | Recall project memory |
| `/reindex` | Rebuild semantic index |
| `/report [days]` | Usage report |
| `/status` | Session status |
| `/ship` | Run production quality gate |
| `/cost` | Quick token usage display |
| `/clear` | Clear session history |
| `/help` | Show command palette |

---

## Multi-Agent Flow

```text
/multi <task>
  ├─ Analysis (complexity, risks, model routing)
  ├─ Architect (implementation plan)
  ├─ Coder (edits + test/lint execution)
  ├─ Reviewer (validation and verdict)
  └─ Sanity pass + summary
```

---

## Configuration

Config path:

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

## Development

```bash
git clone https://github.com/forge-ai/forge
cd forge
bun install
bun run typecheck
bun run build
bun dev
```

---

## License

[MIT](LICENSE) © Forge AI Contributors
