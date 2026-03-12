# Primitives

Core building blocks of JawClaw. Each primitive is a first-class concept
that the system is built upon.

---

## Mouth Agent

The conversational interface layer. One per chat session.

```
Mouth Agent
├── identity: unique ID bound to a chat session
├── channel: which IM this Mouth serves (Telegram, Discord, Slack, ...)
├── session_file: path to its .jsonl chat history
├── active_hands: list of currently running Hand Agent IDs
└── memory_root: path to shared file-based memory
```

**Properties:**
- Long-lived — persists as long as the chat session exists
- Stateful — maintains the full IM conversation in its session file
- Lightweight — uses a fast model, does not execute heavy tasks
- Singular — exactly one Mouth per chat session

**Capabilities:**
- Receive messages from IM channel
- Send replies, reactions, typing indicators to IM channel
- Dispatch tasks to Hand Agents
- Track Hand Agent lifecycle (spawn, monitor, collect results)
- Read/write shared memory

---

## Hand Agent

The task execution worker. One per dispatched task.

```
Hand Agent
├── identity: unique ID for this task instance
├── task: structured task description from Mouth
├── source_chat: file path to the dispatching Mouth's session (.jsonl)
├── session_file: path to its own execution log (.jsonl)
└── memory_root: path to shared file-based memory (same as Mouth's)
```

**Properties:**
- Short-lived — created on dispatch, destroyed on completion
- Task-scoped — does exactly one thing
- Heavyweight — uses a strong model for deep reasoning
- Plural — many can run concurrently from one Mouth

**Capabilities:**
- Execute coding tasks (read/write files, run commands, use tools)
- Read/write shared memory
- Read the source Mouth's chat session (pull-based, on-demand)
- Return structured results to the dispatching Mouth

---

## Chat Session

An append-only `.jsonl` file that records the conversation history of a single agent.

```
Chat Session (.jsonl)
├── location: /sessions/{agent_type}_{agent_id}.jsonl
├── format: one JSON object per line
├── mode: append-only
└── owner: the agent whose conversation this records
```

**Each line contains:**
```jsonl
{"ts": "...", "role": "user|assistant|system|tool", "content": "...", "meta": {...}}
```

**Key design decisions:**
- Append-only — never modified, only appended to
- File-based — any agent with the path can read it
- Per-agent — Mouth and Hand each have their own session file
- Cross-readable — Hand can read Mouth's session via `source_chat` path

---

## Memory

Shared file-based persistent state. Workspace-scoped, accessible by all agents.

```
Memory
├── root: /memory/
├── scope: workspace-level (shared across all Mouth and Hand agents)
├── format: individual files (markdown, json, yaml, etc.)
└── access: read/write by any agent
```

**Categories:**
- **Project context** — what the project is, what's being worked on
- **User preferences** — how to interact, coding style, etc.
- **Learned facts** — accumulated knowledge from past tasks
- **Task artifacts** — outputs and results from Hand Agent executions

**Rules:**
- If it matters, it's a file
- If it's a file, any agent can read it
- Changes are immediately visible to all agents
- Concurrent writes to the same file need conflict resolution

---

## Task Dispatch

The message from Mouth to Hand that initiates work.

```
Task Dispatch
├── task_id: unique identifier
├── description: what needs to be done (natural language + structured)
├── source_chat: file path to Mouth's session .jsonl
├── priority: optional
├── constraints: optional (timeout, resource limits, etc.)
└── context_hints: optional (relevant memory files, key messages)
```

**`context_hints` is optional, not required.** The Hand Agent can always
pull from `source_chat` and shared memory on its own. Hints are an
optimization, not a dependency.

---

## Task Result

The structured response from Hand back to Mouth.

```
Task Result
├── task_id: matching the dispatch
├── status: completed | failed | cancelled
├── summary: human-readable summary for IM display
├── artifacts: list of files created/modified
├── memory_updates: list of memory files written
└── error: error details if failed
```

Mouth uses the `summary` to formulate an IM-friendly reply.
`artifacts` and `memory_updates` let Mouth inform the user what changed.

---

## Message Queue

Runtime-level incoming message queue. Every agent (Mouth and Hand) has one.

```
Message Queue
├── owner: the agent this queue belongs to
├── mode: FIFO
├── check: agent checks queue during react loop iterations
└── writers: any agent that holds a reference to this queue
```

**Behavior:**
- Agent checks its queue at each iteration of the react loop
- Messages are consumed in order (FIFO)
- Mouth's queue receives user messages from IM channel
- Hand's queue can receive mid-task messages from Mouth

**This is the only non-file-based primitive.** It exists at the runtime layer
because it requires in-process delivery semantics that file polling cannot
guarantee with adequate latency.

**Use cases:**
- User sends new IM message → enqueued to Mouth
- Mouth wants to update/cancel a running Hand → enqueued to Hand
- Hand finishes task → completion notification enqueued to Mouth

---

## Channel

The IM platform binding. Maps an external chat to a Mouth Agent.

```
Channel
├── type: telegram | discord | slack | wechat | ...
├── chat_id: platform-specific chat identifier
├── mouth_id: the Mouth Agent bound to this chat
└── config: channel-specific settings (bot token, permissions, etc.)
```

**One chat → one Mouth Agent.** The channel is the glue between
the external IM world and JawClaw's internal agent system.
