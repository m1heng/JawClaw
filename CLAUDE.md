# JawClaw

## What is JawClaw

JawClaw is a dual-layer agent framework for IM-connected coding agents.
The name encodes the architecture: **Jaw** (Mouth Agent) talks, **Claw** (Hand Agent) works.

## Design Philosophy

### SSOT / DRY / KISS

These three principles govern all design decisions. When in doubt, pick the simpler path.

### File-Based is the Truth

All persistent state — memory, chat sessions, config — lives as files on disk.
No hidden in-memory state. If it matters, it's a file. If it's a file, any agent can read it.

### Pull Over Push

Agents pull context when they need it, rather than having context pushed to them upfront.
This avoids information loss from premature summarization and lets each agent decide
what it needs at the moment it needs it.

### Shared Context, Separate Sessions

All agents share the same file-based context (workspace, memory, config).
The only thing that differs between agents is their chat session history.
This is the core architectural invariant of JawClaw.

### Mouth is Singular, Hand is Plural

One Mouth Agent per chat session (long-lived, conversational).
Many Hand Agents per Mouth (short-lived, task-scoped, concurrent).

## Naming Conventions

| Concept | Name | Metaphor |
|---------|------|----------|
| IM-facing agent | Mouth Agent | Jaw — talks to the user |
| Task-executing agent | Hand Agent | Claw — does the work |
| Chat conversation log | Chat Session (.jsonl) | Append-only dialogue record |
| Shared persistent state | Memory | File-based, workspace-scoped |

## Tech Stack

- **Language**: TypeScript
- **Project structure**: Monorepo (pnpm workspace) — `packages/core`, `packages/channels`, `packages/cli`
- **LLM**: OpenAI-compatible API (works with Claude, GPT, local models, any compatible endpoint)
- **First channel**: Telegram (Bot API)

## Key Rules

- Mouth Agent NEVER executes heavy tasks directly — it dispatches to Hand Agents
- Hand Agent receives a task description + a file path to the source chat session
- Hand Agent can read the chat session file at any time to get more context (pull-based)
- Multiple Hand Agents can run concurrently from the same Mouth Agent
- All agents read/write the same shared memory files
