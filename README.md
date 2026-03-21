# JawClaw

Dual-layer agent framework for IM-connected coding agents.

**Jaw** (Mouth Agent) talks. **Claw** (Hand Agent) works.

## Quick Start

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

- **SSOT / DRY / KISS** — simple over clever
- **File-based all the way** — all state is files on disk
- **Pull over push** — agents pull context when needed
- **Shell abstraction** — swap LocalShell for DockerShell/RemoteShell
- **LLM abstraction** — swap providers without changing agent code

## License

MIT
