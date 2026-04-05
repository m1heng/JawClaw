# @jawclaw/core

## 0.2.0

### Minor Changes

- [#15](https://github.com/m1heng/JawClaw/pull/15) [`e7cc0c4`](https://github.com/m1heng/JawClaw/commit/e7cc0c46829153199bd52fed2bfc7f24ffe4d929) Thanks [@m1heng](https://github.com/m1heng)! - Add concurrent tool execution, per-result budget, LLM error recovery, and 5-layer compression pipeline

- [#17](https://github.com/m1heng/JawClaw/pull/17) [`2fa592e`](https://github.com/m1heng/JawClaw/commit/2fa592edaaf30549bca5396cb7a22afd7382903b) Thanks [@m1heng](https://github.com/m1heng)! - Cache-friendly compression pipeline: monotonic microcompact watermark, scoped collapse, static/dynamic system prompt split, Anthropic prompt caching with cache_control, and cache break observability

- [#16](https://github.com/m1heng/JawClaw/pull/16) [`a6f2135`](https://github.com/m1heng/JawClaw/commit/a6f21357dd45e35806e1cdf074ac99b9b9214c54) Thanks [@m1heng](https://github.com/m1heng)! - Add edit staleness protection, LLM usage tracking, slash commands, and idle memory consolidation

- [#9](https://github.com/m1heng/JawClaw/pull/9) [`7a54fde`](https://github.com/m1heng/JawClaw/commit/7a54fde40ae63d936bc8b05f2c994ae8c464b3be) Thanks [@m1heng](https://github.com/m1heng)! - Enforce Mouth dispatch discipline and route Hand results through Mouth LLM. Mouth now acknowledges users fast and dispatches deep work to Hand immediately. Hand results are processed by Mouth before being sent to the user, rather than bypassing Mouth entirely.

- [#14](https://github.com/m1heng/JawClaw/pull/14) [`f5480e4`](https://github.com/m1heng/JawClaw/commit/f5480e4e8f4d780a3cd8f19164dfcf840936d14e) Thanks [@m1heng](https://github.com/m1heng)! - Add 3-tier context compression (microcompact, session memory, memory-aware compaction) and LLM-powered memory recall
