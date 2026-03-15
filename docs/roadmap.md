# JawClaw Roadmap

## P0 — 不做就不能用于真实场景

- [x] **Context compaction（上下文压缩）**
  - react-loop 调用 LLM 前估算 token，超预算则从旧消息裁剪
  - 压缩只影响发给 LLM 的 messages，session 文件保持完整（SSOT）
  - tool-call 组原子性保留，始终保留最新 unit

- [x] **启动时注入 MEMORY.md 到 system prompt**
  - Mouth 每次 runOnce 读 MEMORY.md 拼入 system prompt（保持最新）
  - Hand 不注入全文，仅在 prompt 中提示 memory 目录路径
  - 文件不存在则跳过，超 4000 chars 截断

- [x] **会话空闲时自动生成摘要存盘**
  - drainLoop 空闲时检测新增消息量，超 20 条则 dispatch 摘要 Hand
  - 写入 `memory/sessions/YYYY-MM-DD-chat-{id}-{ts}.md`，更新 MEMORY.md
  - checkpoint 持久化到磁盘，重启不重复摘要

## P1 — 显著提升体验

- [ ] **File-based identity（文件定义 agent 身份）**
  - 当前 system prompt 硬编码在代码里，用户无法定制 agent 行为
  - 支持 workspace 下的 `SOUL.md`（人设）、`AGENTS.md`（指令）、`USER.md`（用户信息）
  - 启动时读取，拼入 system prompt，缺失则用默认值

- [ ] **Hand 可观测性与可控性**
  - Mouth dispatch 后对 Hand 是黑盒，无法查状态、无法中止
  - Hand 暴露运行状态（running/completed/failed + 当前 turn 数）
  - Mouth 可查询 activeHands 状态
  - 连接 abortSignal（react-loop 已有参数，但未接入）

- [ ] **消息分片（chunking）**
  - 长回复超过 channel 限制时被截断
  - per-channel 的 textChunkLimit 配置 + 分片发送逻辑

- [ ] **`memory_query` 增强**
  - 当前只有 regex，记忆文件多了找不到
  - 支持按 frontmatter `type`/`tags` 过滤，支持限定子目录搜索

- [ ] **新增 `memory_list` 工具**
  - 列出所有记忆文件 + frontmatter 摘要
  - 让 agent 知道有哪些记忆可查，减少盲目搜索

## P2 — 锦上添花，按需添加

- [ ] **向量语义搜索**
  - 当记忆文件 > 100 时 regex 不够用
  - 可选方案：嵌入 sqlite-vec，或调用外部 embedding API
  - 保持文件为 SSOT，索引为缓存

- [ ] **Pre-compaction 静默 memory flush**
  - Context 快满时，静默触发一轮让 agent 主动存记忆，再做 compaction
  - 依赖 P0 的 compaction 和记忆写入先完成

- [ ] **消息投递重试队列**
  - 网络不稳时消息丢失
  - file-based delivery queue + exponential backoff

- [ ] **媒体支持（图片/文件/语音）**
  - Inbound：接收并转成 agent 可处理的格式
  - Outbound：发送图片、文件附件
  - Vision/TTS 作为独立工具按需集成

- [ ] **Browser 自动化工具**
  - Headless Chrome 控制（导航、填表、截图）
  - 作为 EXTERNAL 组的新工具加入 Hand

- [ ] **Agent 间通信**
  - Hand↔Hand 或 Mouth↔Mouth 跨会话消息传递
  - 复杂多 agent 编排场景才需要

- [ ] **首次启动引导（BOOTSTRAP.md）**
  - 首次运行时执行引导流程，完成后删除文件
  - file-based identity 做完后自然延伸

## DRY 修复（随手可做）

- [ ] **抽取共享 `runCommand` 函数**
  - `read-tools.ts` 和 `hand-agent.ts` 各有一份几乎相同的 shell exec 逻辑
  - 抽到 `packages/core/src/shell.ts`

- [ ] **抽取共享 `errMsg` 函数**
  - `read-tools.ts` 和 `hand-agent.ts` 重复
  - 放到 `packages/core/src/utils.ts` 或随 `shell.ts` 一起

- [ ] **write_file / edit_file 路径安全校验**
  - Hand 可写任意路径，缺少 path traversal guard
  - 对齐 read_file 已有的安全检查
