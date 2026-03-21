# JawClaw

## What is JawClaw

JawClaw is a dual-layer agent framework for IM-connected coding agents.
The name encodes the architecture: **Jaw** (Mouth Agent) talks, **Claw** (Hand Agent) works.

## Design Philosophy

### SSOT / DRY / KISS

These three principles govern all design decisions. When in doubt, pick the simpler path.

### File-Based All the Way

All persistent state — memory, chat sessions, config — lives as files on disk.
No hidden in-memory state. If it matters, it's a file. If it's a file, any agent can read it.
No special-purpose tools when generic file tools suffice — memory is just files,
source chat is just a file, everything is accessed through the same file primitives.

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

## Tool Groups

Tools are organized into groups to keep Mouth and Hand aligned:

| Group | Tools | Mouth | Hand |
|-------|-------|:-----:|:----:|
| **READ** (shared) | read_file, grep, glob, memory_query | ✅ | ✅ |
| **DISPATCH** | dispatch_task | ✅ | ❌ |
| **WRITE** | write_file, edit_file | ❌ | ✅ |
| **EXECUTE** | run_command | ❌ | ✅ |
| **EXTERNAL** | web_search, message, cron | ❌ | ✅ |

- `memory_query` is in READ because it's a semantic search interface (future VDB-backed), distinct from grep (regex)
- No `memory_write/read/list` — file tools cover those (file-based all the way)
- No `read_source_chat` — Hand uses `read_file` on the path from task description

## Key Rules

- Mouth Agent NEVER executes heavy tasks directly — it dispatches to Hand Agents
- Hand Agent receives a task description + the source chat file path
- Hand Agent can read the chat session file at any time to get more context (pull-based)
- Multiple Hand Agents can run concurrently from the same Mouth Agent
- All agents read/write the same shared memory files via standard file tools

## Changesets (Versioning & Release)

This project uses [Changesets](https://github.com/changesets/changesets) for versioning.
All three packages (`@jawclaw/core`, `@jawclaw/channels`, `jawclaw`) share a fixed version.

**When creating a PR that changes package behavior:**
1. Run `pnpm changeset`
2. Select the affected package(s)
3. Choose bump type: `patch` (bug fix), `minor` (new feature), `major` (breaking)
4. Write a short summary of the change
5. Commit the generated `.changeset/*.md` file with your PR

**Skip changeset for:** `chore:`, `ci:`, `docs:`, `test:` prefixed PRs (CI check allows these).

**Release flow:** Merge to main → Changesets Action creates a "Version Packages" PR → merge that PR → auto-publish to npm.
