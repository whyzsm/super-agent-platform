# 共享契约：`src/protocol/index.ts`

> 前后端唯一的类型契约都放 `src/protocol/index.ts`。本文件说明契约边界、项目里真实存在的类型重复反模式，以及枚举 → 标签映射的约定。

---

## 何时适用

新增 / 修改 `TaskState`、`GateType`、`DaemonEnvelope`、`NormalizedAgentEvent` 等跨层类型，给联合类型加值，或新增事件 `kind` / 命令 `type` 时。

## 本地模式

- 唯一来源：`src/protocol/index.ts`（约 214 行）。前后端都从它 `import type`（前端如 `src/utils/statusStyles.ts:1` 的 `../protocol`，后端 `server.ts:5` 起的 `./src/protocol`）。
- 关键联合 / 接口：`AgentProvider`(4)、`AdapterMode`(3)、`TaskState`(11，原 8 态 + S0-4 新增 BLOCKED_BY_RESOURCE / QUARANTINED / WAITING_APPROVAL)、`GateType`(3)、`TaskRole`(3)、`SopTemplateId`(2)、`DagNode`、`Requirement`、`DaemonRunner`、`MemoryAsset`（`assetType` 5 种 / `scope` 4 级 / `status` `draft|published|archived`）、`AssetAclEntry`、`TeamAiAsset`、`DaemonCommand`、`DaemonEnvelope`、`AgentRunnerAdapter`、`NormalizedAgentEvent`、`AgentReasoningEvent`、`VerifierCheck`、`TaskCheckpoint`。
- 事件 / 命令用判别联合（`type` 字段）收窄，消费方按 `type` 分支，不用 `any`。
- 展示映射用 `Record<Union, Meta>` 穷举：`src/utils/statusStyles.ts` 的 `TASK_STATE_META`、`GATE_TYPE_LABELS`、`PROVIDER_LABELS`、`ROLE_LABELS`、`SOP_TEMPLATE_LABELS`；新增枚举值会让 `npm run lint` 因缺 key 报错。详解见 [frontend/presentation-maps.md](../frontend/presentation-maps.md)。

## 类型重复反模式（真实）

- `src/components/TeamAiProtocolView.tsx:11` 的 `PROTOCOL_SPEC` 是一段**展示用模板字符串**（UI 的 `protocol` tab 会渲染它），里面把 `SopTemplateId`、`TaskState`、`NodeTokenUsage`、`NormalizedAgentEvent`、`AgentRunnerAdapter`、`DaemonCommand` 的 `export type/interface` 文本复制了一遍。
- 准确定位：这些是**字符串内容，不是编译期重复声明**，不会被 `tsc` 检查；但它是契约文本的副本，改 `src/protocol/index.ts` 时不会自动同步。
- 已可观察到漂移：`PROTOCOL_SPEC` 里 `AgentRunnerAdapter.mode` 写的是内联字面量 `'headless-json' | 'acp' | 'pty'`，而契约另有 `AdapterMode = 'headless_json' | 'acp_bidirectional' | 'pty_tmux'`（`:3`）；两套 mode 命名并存。同文件 `:57` 的 `PGVECTOR_DDL` 也只是展示字符串，不是真实建表。
- 结论：共享类型只能放 `src/protocol/index.ts`；任何需要展示契约文本的地方应视为"可能过期的副本"，改动契约时一并核对。

## 枚举 / 标签映射约定

- 文案与配色集中到 `src/utils/statusStyles.ts`，值为 Tailwind class 字符串；组件按状态取 `textClass` / `borderClass` / `bgClass`（`DagCanvas.tsx:43`、`:60`）。
- 已知未复用点：`src/stores/useWorkspaceStore.ts:152` 的 `notice` 直接写死「标准 Feature 开发流 / Bug 修复流」，与 `SOP_TEMPLATE_LABELS` 重复。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/protocol/index.ts:1–214` | 全部共享类型 |
| `src/components/TeamAiProtocolView.tsx:11 / :57` | `PROTOCOL_SPEC` / `PGVECTOR_DDL` 展示字符串 |
| `src/utils/statusStyles.ts:3–80` | 5 个 `Record` 映射 |
| `src/engine/stateMachine.test.ts:13` | 测试 `import type ... from '../protocol'` |

## 常见错误

- 在组件 / store 里再 `export type` 一个前端要用的类型 → 与契约两份定义各自漂移。
- 加 `TaskState` 值却漏改 `TASK_STATE_META`；或改了契约忘了核对 `PROTOCOL_SPEC` 展示副本。
- 把 `PROTOCOL_SPEC` / `PGVECTOR_DDL` 当作真实可执行的类型定义或数据库 schema。
- 用 `@/*` 别名引入协议类型；现有代码统一用相对路径 `../protocol`。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，14 个 `node:test` 用例全绿）。
