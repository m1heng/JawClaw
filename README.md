# JawClaw

Dual-layer agent framework for IM-connected coding agents.

**Jaw** (Mouth Agent) talks. **Claw** (Hand Agent) works.

## Why JawClaw

### One Agent, One Mind

Most bot frameworks create a separate instance per channel — one for Telegram, another for Discord, another for Slack. Each lives in its own silo with its own context and memory. The result is a fragmented agent that forgets what you told it on one platform when you switch to another.

We think this is wrong. A real person doesn't become someone else when they switch from texting to email. They carry one continuous stream of consciousness across every conversation.

JawClaw enforces a **single session model**: one Mouth Agent, one unified conversation history (`mouth.jsonl`), regardless of how many channels are connected. Messages from Telegram, Discord, or any future channel all feed into the same session. The agent sees every message in one timeline, builds context across channels, and behaves like one coherent person — not a collection of disconnected bots.

### Two Layers, Not One

An agent that lives in IM faces an inherent tension:

- **Users expect fast replies** — seconds, not minutes. "Got it", "Working on it", "Here's what I found."
- **Coding tasks need deep work** — reading files, running commands, iterating on solutions. This takes minutes.

A single-loop agent can't do both well. Either the user stares at a typing indicator for 5 minutes, or the agent interrupts its own reasoning to send a status update and loses its train of thought.

JawClaw resolves this by splitting the agent into two layers:

| | Mouth (Jaw) | Hand (Claw) |
|---|---|---|
| Job | Talk to the user | Do the actual work |
| Speed | Fast, lightweight model | Strong, capable model |
| Lifecycle | Long-lived, always on | Short-lived, one per task |
| Can write files | No | Yes |
| Count | 1 per bot | Many, concurrent |

The **Mouth Agent** handles all IM interaction — it acknowledges messages instantly, parses intent, and dispatches tasks. The **Hand Agent** does the heavy lifting — coding, file manipulation, command execution — without worrying about chat latency. Multiple Hand Agents can run in parallel.

This is the same pattern humans use: you respond to a message quickly ("let me look into that"), then go do the deep work, then come back with the result.

## Quick Start

```bash
npm install -g jawclaw
jawclaw
```

Or from source:

```bash
git clone https://github.com/m1heng/JawClaw.git
cd JawClaw
pnpm install
pnpm dev
```

First run walks you through setup:

```
🐾 JawClaw — first time setup

? LLM Provider → OpenAI / Anthropic Claude / Google Gemini / OpenAI-compatible
? API Key → sk-...
? Telegram Bot Token → 123456:ABC...

✅ Setup complete — starting bot...
🐾 JawClaw running — 1 channel(s) active
```

Go talk to your bot on Telegram.

## Architecture

```
User (Telegram) ──msg──→ Mouth Agent ──dispatch──→ Hand Agent(s)
                          │                          │
                     fast, chat               strong, code
                     reads only               reads + writes + exec
                     single session           one per task
                          │                          │
                          └──── shared memory ────────┘
```

- **Mouth Agent** — one per bot, handles all channels, dispatches tasks
- **Hand Agent** — one per task, executes coding work, short-lived
- **Single session** — all channels feed into one conversation
- **Explicit reply** — Mouth uses `message` tool to reply (text output = internal reasoning)

## CLI Commands

```bash
jawclaw                  # Start (onboard if first run)
jawclaw status           # Show config and status
jawclaw provider add     # Add or update LLM provider
jawclaw channel add      # Add a channel
jawclaw channel remove   # Remove a channel
```

## LLM Providers

| Provider | Models |
|----------|--------|
| OpenAI | gpt-5.4-mini / gpt-5.4 |
| Anthropic Claude | claude-sonnet-4-6 / claude-opus-4-6 |
| Google Gemini | gemini-2.5-flash / gemini-2.5-pro |
| OpenAI-compatible | Any endpoint (vLLM, Ollama, LiteLLM, etc.) |

## File Structure

```
.jawclaw/
├── config.json          # Provider + channel config
├── SOUL.md              # Agent personality (edit to customize)
├── INSTRUCTIONS.md      # Agent rules (edit to customize)
├── memory/
│   ├── MEMORY.md        # Memory index
│   ├── contacts/        # Per-person knowledge
│   └── summaries/       # Auto-generated session summaries
└── sessions/
    ├── mouth.jsonl       # Single conversation session
    └── hand_*.jsonl      # Task execution logs
```

## Design Principles

- **Single session** — one agent, one conversation, across all channels
- **Dual-layer** — Mouth talks fast, Hand works deep, never mixed
- **File-based all the way** — all state is files on disk, no hidden in-memory state
- **Pull over push** — agents pull context when they need it, not when you think they need it
- **SSOT / DRY / KISS** — one source of truth, no duplication, simple over clever

## License

[MIT](LICENSE)
