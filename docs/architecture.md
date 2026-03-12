# Architecture

## Overview

JawClaw is a dual-layer agent system designed for IM-connected coding agents.
The two layers solve fundamentally different problems:

- **Mouth Agent (Jaw)**: Fast IM interaction — acknowledge, react, dispatch
- **Hand Agent (Claw)**: Deep task execution — code, tools, long-running work

```
┌──────────────────────────────────────────────────┐
│              Shared File-Based Context            │
│        (workspace / memory / config / tools)      │
└─────────┬──────────────────┬─────────────────────┘
          │                  │
 ┌────────┴────────┐  ┌─────┴──────────────┐
 │  Mouth Agent    │  │   Hand Agent (x N)  │
 │                 │  │                     │
 │  Own Session    │  │   Own Session       │
 │  (.jsonl)       │  │   (.jsonl)          │
 │                 │  │                     │
 │  Fast / Light   │  │   Strong / Heavy    │
 │  1 per chat     │  │   1 per task        │
 └────────┬────────┘  └──────────┬──────────┘
          │                      │
     IM Channel             File System
   (Telegram, etc.)       (git, shell, tools)
```

## Dual-Layer Design

### Why Two Layers?

A single agent serving IM has a tension:
- IM users expect **fast feedback** (seconds)
- Coding tasks require **deep work** (minutes)

Trying to do both in one agent loop means either the user waits too long for
a response, or the agent is interrupted mid-thought to send a status update.

The dual-layer split resolves this by separating the concerns entirely.

### Mouth Agent

- **Lifecycle**: Long-lived, 1:1 bound to a chat session (DM, group, channel)
- **Responsibilities**:
  - Receive and understand user messages
  - Give fast acknowledgement and reactions in IM
  - Parse intent and dispatch tasks to Hand Agents
  - Relay Hand Agent results back to IM in a human-friendly format
  - Track active Hand Agents and their status
- **Model**: Fast / lightweight (optimized for latency, not depth)
- **Session**: Owns the full IM conversation history

### Hand Agent

- **Lifecycle**: Short-lived, 1:1 bound to a dispatched task, destroyed on completion
- **Responsibilities**:
  - Execute the dispatched task (coding, file manipulation, tool calls, etc.)
  - Read shared memory for project context
  - Optionally read the source chat session for additional context (pull-based)
  - Write results back to shared memory or output files
- **Model**: Strong / capable (optimized for reasoning depth)
- **Session**: Owns only its own task execution history
- **Concurrency**: Multiple Hand Agents can run in parallel from one Mouth Agent

## Context Architecture

### The Two Types of Context

JawClaw separates context into two distinct categories:

| Type | Scope | Sharing |
|------|-------|---------|
| **File Context** (workspace, memory, config) | Workspace-level | Shared across ALL agents |
| **Chat Session** (conversation history) | Per-agent | Each agent has its own |

This separation is the core architectural invariant.

### File-Based Memory (Shared)

All persistent knowledge lives as files on disk:
- Workspace files (source code, configs, etc.)
- Memory files (learned facts, user preferences, project context)
- Configuration (agent settings, channel bindings)

Any agent — Mouth or Hand — can read and write these files.
Changes made by one Hand Agent are immediately visible to all others.

### Chat Sessions (Separate)

Each agent maintains its own `.jsonl` chat session file:
- **Mouth Agent session**: Full IM conversation history with the user
- **Hand Agent session**: Task execution log (tool calls, reasoning, results)

### Cross-Session Context Access

When Mouth dispatches a task to Hand, it passes:

```
{
  "task": "Refactor the auth module to use JWT",
  "source_chat": "/sessions/mouth_abc123.jsonl"
}
```

The Hand Agent can then **pull** context from the Mouth's chat session
on-demand — when it encounters ambiguity or needs more background.
This is a deliberate pull-based design:

- No information loss from premature summarization
- Hand Agent decides what context it needs, not Mouth
- The `.jsonl` file is append-only, so Hand can re-read to catch up on
  new messages the user sent while the task was running

## Dispatch Flow

```
User sends message in IM
        │
        ▼
   Mouth Agent
   ├── 1. Parse intent
   ├── 2. Quick acknowledge in IM ("Got it, working on it...")
   ├── 3. Dispatch task to Hand Agent
   │       ├── task description
   │       └── source_chat file path
   ├── 4. (Optional) Dispatch more Hand Agents for parallel tasks
   └── 5. Wait for Hand Agent results
              │
              ▼
        Hand Agent(s)
        ├── Execute task using tools
        ├── Read source chat if needed (pull-based)
        ├── Write results to shared memory / files
        └── Return structured result to Mouth
              │
              ▼
   Mouth Agent
   └── Format and relay results to IM
```

## Concurrency Model

```
Chat Session A (DM)
  └── Mouth Agent A
        ├── Hand Agent A1 (running)
        ├── Hand Agent A2 (running)
        └── Hand Agent A3 (completed)

Chat Session B (Group)
  └── Mouth Agent B
        └── Hand Agent B1 (running)
```

- Each chat session gets exactly one Mouth Agent
- Each Mouth Agent can spawn multiple Hand Agents concurrently
- Hand Agents from different Mouth Agents share file-based memory
  (workspace-scoped, not Mouth-scoped)
- Concurrent file writes need conflict resolution (append-only logs,
  or file-level locking for structured files)

## Design Decisions

### Progress Reporting: Completion Notification + FS Polling

Hand Agent 只在任务结束时主动通知 Mouth。过程中 Mouth 可以基于 fs
主动读取 Hand 的 session 文件来了解进度（pull-based，与整体哲学一致）。

### Mid-Task Intervention: Message Queue

Agent runtime 层有 incoming message queue。Agent 在 react loop 中
check queue，因此：
- 用户新消息通过 Mouth → queue → Hand 传递
- Mouth 可以在任务执行中途给 Hand 发消息（修改指令、取消等）
- 这是一个 runtime 级别的 primitive，不是 file-based 的

### Memory Scope: Global

所有 memory 全局共享，不做 per-Mouth 隔离。
所有 agent 读写同一份 memory。

### Failure Handling: Fail Fast

Hand Agent 失败时直接返回错误给 Mouth，不自动重试。
Mouth 将错误信息转达给 IM 用户。
