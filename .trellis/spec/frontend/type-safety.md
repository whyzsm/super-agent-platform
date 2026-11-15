# 类型安全

> 类型来自 `src/protocol/index.ts` 单一契约；`tsconfig.json` 未开 `strict`，且没有运行时校验库，类型一致性靠约定而非编译器强约束。

---

## 何时适用

定义新类型、给 `PlatformState` / `DaemonEnvelope` 加字段、或从 `/api/*` 响应取数据时。

## 本地模式

- 共享类型只在 `src/protocol/index.ts`：`AgentProvider`（4 值）、`AdapterMode`（3 值）、`TaskState`（11 态：原 8 态 + S0-4 的 BLOCKED_BY_RESOURCE / QUARANTINED / WAITING_APPROVAL）、`GateType`（3 类）、`TaskRole`（3 类）、`SopTemplateId`（2 值）、`DagNode`、`Requirement`、`DaemonRunner`、`MemoryAsset`（`assetType` 5 种 / `scope` 4 级 / `status` `draft|published|archived`）、`AssetAclEntry`、`TeamAiAsset`、`DaemonCommand`、`DaemonEnvelope`、`AgentRunnerAdapter`、`NormalizedAgentEvent`、`AgentReasoningEvent`、`VerifierCheck`、`TaskCheckpoint`。
- 前端用 `import type { ... } from '../protocol'`（如 `src/utils/statusStyles.ts:1`、`src/components/TeamAiProtocolView.tsx:3`）。
- 展示映射用 `Record<Union, Meta>` 让穷举性可检查：`TASK_STATE_META`、`GATE_TYPE_LABELS`、`PROVIDER_LABELS`、`ROLE_LABELS`、`SOP_TEMPLATE_LABELS`（`src/utils/statusStyles.ts`）——新增枚举值时编译期会因缺 key 报错。
- 判别联合用于事件 / 命令：`NormalizedAgentEvent`、`DaemonCommand` 以 `type` 分支，消费处按 `type` 收窄。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/protocol/index.ts:1–214` | 全部共享类型定义 |
| `src/utils/statusStyles.ts:3 / :57` | `Record<TaskState, Meta>` / `Record<GateType, string>` |
| `src/stores/useWorkspaceStore.ts:140` | `body.error` 无类型守护 |
| `tsconfig.json` | `noEmit` / `moduleResolution: bundler` / `jsx: react-jsx`，无 `strict` |

## 当前实现状态（诚实标注）

- `tsconfig.json` **没有 `strict: true`**，隐含 `strictNullChecks` 关闭；`npm run lint`（`tsc --noEmit`）通过不等于类型严谨。
- **没有运行时校验库**（无 zod / yup / io-ts）；`server.ts` 用 `req.body as { ... }` 断言、`loadOrInitState()` 用 `JSON.parse(raw) as PlatformState`，store 里直接读 `body.error`。
- 唯一已知的类型重复反模式：`src/components/TeamAiProtocolView.tsx:11` 的 `PROTOCOL_SPEC` 展示字符串里复制了 `SopTemplateId`、`TaskState`、`NodeTokenUsage`、`NormalizedAgentEvent`、`AgentRunnerAdapter`、`DaemonCommand` 的文本（且 `AgentRunnerAdapter.mode` 用的是内联字面量而非 `AdapterMode` 别名，存在漂移）。详见 [guides/shared-contracts.md](../guides/shared-contracts.md)。

## 常见错误

- 在组件或 store 里重新 `export type / interface` 一个已存在于 `src/protocol/index.ts` 的类型 → 两份定义各自漂移。
- 给 `TASK_STATE_META` 加新 `TaskState` 时漏加 key，或把标签写成散落在组件里的字面量。
- 依赖 `strict` 帮你抓到 `null` / `undefined`；当前配置不会。
- 以为有 schema 校验；`body as Xxx` 是断言，不是验证。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，14 个 `node:test` 用例全绿）。
