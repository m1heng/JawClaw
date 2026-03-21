# JawClaw

## What is JawClaw

Dual-layer agent framework for IM-connected coding agents.
**Jaw** (Mouth Agent) talks, **Claw** (Hand Agent) works.

## Design Principles

- **SSOT / DRY / KISS** — simple over clever, no duplication, one source of truth
- **File-based all the way** — all state is files on disk, no hidden in-memory state
- **Pull over push** — agents pull context when they need it
- **Shell abstraction** — all I/O goes through `Shell` interface (swap LocalShell for Docker/remote)
- **LLM abstraction** — all LLM calls go through `LLMClient` interface (swap OpenAI for Claude/Gemini)

## Architecture

### Single Session Model

One global Mouth Agent with one unified session (`mouth.jsonl`).
All channels (Telegram, future Discord, etc.) feed into this single session.
Mouth uses the `message` tool to explicitly reply — its text output is internal reasoning, NOT sent to any channel.

### Dual-Layer Agents

| | Mouth (Jaw) | Hand (Claw) |
|---|---|---|
| Count | 1 global | N per task |
| Lifecycle | Long-lived | Short-lived |
| Model | Fast (e.g. gpt-5.4-mini) | Strong (e.g. gpt-5.4) |
| Can read | Files, memory, session | Files, memory, source chat |
| Can write | Nothing | Files, commands, messages |
| Session | `mouth.jsonl` | `hand_{taskId}.jsonl` |

### Tool Groups

| Group | Tools | Mouth | Hand |
|-------|-------|:-----:|:----:|
| **READ** | read_file, grep, glob, memory_query | yes | yes |
| **DISPATCH** | dispatch_task, list_tasks, cancel_task | yes | no |
| **MESSAGE** | message | yes | yes |
| **WRITE** | write_file, edit_file | no | yes |
| **EXECUTE** | run_command | no | yes |
| **EXTERNAL** | web_search, cron | no | yes |

## Monorepo Structure

```
packages/
  core/        — Agent engine, providers, tools, types
  channels/    — IM channel adapters (Telegram)
  cli/         — CLI entry point, config, onboarding
```

### Key Files (core/)

| File | Responsibility |
|------|---------------|
| `types.ts` | All shared types (ChatMessage, ToolCall, AgentConfig, HandServices) |
| `llm.ts` | LLMClient, LLMMessage, LLMResponse — neutral types, no provider code |
| `providers/shell.ts` | Shell interface (exec, readFile, writeFile, appendFile, mkdir, listFiles) |
| `providers/local-shell.ts` | Node.js Shell implementation — sole file importing node:fs and child_process |
| `providers/openai.ts` | OpenAI LLM provider — sole file importing openai SDK |
| `providers/anthropic.ts` | Anthropic Claude LLM provider |
| `providers/gemini.ts` | Google Gemini LLM provider |
| `react-loop.ts` | ReAct loop — shared by Mouth and Hand, drives LLM + tool execution cycles |
| `mouth-agent.ts` | Mouth Agent — single session, message queue, dispatch, auto-summary |
| `hand-agent.ts` | Hand Agent — task execution, wires read-tools + hand-tools |
| `tools.ts` | Tool JSON Schema definitions (what the LLM sees) |
| `read-tools.ts` | READ tool implementations (read_file, grep, glob, memory_query) |
| `hand-tools.ts` | WRITE + EXECUTE + EXTERNAL tool implementations |
| `chat-session.ts` | Append-only JSONL session persistence |
| `context.ts` | Token estimation, history compaction, bootstrap file injection |
| `message-queue.ts` | In-memory FIFO queue for incoming messages |
| `cron.ts` | Timer-based task scheduler |
| `tool-executor.ts` | Generic tool dispatch (name → handler) |

### Key Files (cli/)

| File | Responsibility |
|------|---------------|
| `index.ts` | CLI entry point, argv routing |
| `config.ts` | Config type + load/save from `.jawclaw/config.json` |
| `onboard.ts` | First-run interactive setup (provider + channel) |
| `start.ts` | Boot: create providers, channels, Mouth, wire everything |
| `commands/status.ts` | Show current config |
| `commands/provider.ts` | Add/remove LLM provider |
| `commands/channel.ts` | Add/remove channel |

## Provider Abstraction

All platform-specific code is isolated in `providers/`. Core agent files have zero imports from `openai`, `node:child_process`, or `node:fs/promises`.

### Adding a new LLM provider

1. Create `providers/my-provider.ts` implementing `LLMClient`
2. Handle neutral `LLMMessage` ↔ provider-native format translation internally
3. Export factory: `createMyProviderClient(apiKey, baseUrl?): LLMClient`
4. Add to `index.ts` exports
5. Add to `cli/start.ts` `createLLM()` switch
6. Add to `cli/onboard.ts` and `commands/provider.ts` select options

### Adding a new channel

1. Create `channels/src/my-channel.ts` implementing `Channel` interface
2. Export from `channels/src/index.ts`
3. Add to `cli/start.ts` channel creation loop
4. Add to `cli/commands/channel.ts` select options

## .jawclaw/ Directory

```
.jawclaw/
├── config.json          — Provider + channel config (managed by CLI)
├── SOUL.md              — Agent personality (hand-edited)
├── INSTRUCTIONS.md      — Agent rules (hand-edited)
├── memory/
│   ├── MEMORY.md        — Memory index
│   ├── contacts/        — Per-person knowledge (agent-managed, name-slug.md)
│   └── summaries/       — Auto-generated session summaries
└── sessions/
    ├── mouth.jsonl       — The single Mouth session
    └── hand_*.jsonl      — Task execution logs
```

## Development

```bash
pnpm install             # install deps
pnpm dev                 # run in dev mode (tsx)
pnpm build               # compile TypeScript
pnpm test                # run vitest
pnpm test:watch          # watch mode
```

## PR & Release Workflow

See `.claude/skills/pr-release.md` for the full PR conventions and changeset requirements.

Quick summary: feature/fix PRs must include a changeset file (`pnpm changeset`).
