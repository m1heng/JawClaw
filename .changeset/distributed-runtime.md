---
"@jawclaw/core": minor
"jawclaw": minor
"@jawclaw/channels": minor
---

feat: distributed runtime architecture — HandRuntime, TaskStore, pluggable executors

Introduce a distributed-ready runtime layer that decouples Mouth from Hand execution:

- **HandRuntime interface**: Mouth dispatches via submit/cancel/list/onComplete — no knowledge of how tasks execute
- **TaskStore + Outbox pattern**: persistent task state with at-least-once delivery guarantee and crash recovery
- **BuiltinExecutor**: wraps existing HandAgent with per-turn checkpointing
- **CLIExecutor**: run Claude Code, Codex, or Aider as the Hand agent via Shell.exec()
- **LocalRuntime**: single-process runtime with stale-task recovery and checkpoint-based resume
- **TaskQueue interface**: placeholder for future distributed queue (Redis/SQS)
