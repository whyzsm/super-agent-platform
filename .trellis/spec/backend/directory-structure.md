# 后端目录结构

> 后端没有 `server/` 目录或分层框架：`server.ts` 单文件承载全部 Express 端点，可复用纯逻辑拆到 `src/` 下按领域分文件。

---

## 何时适用

新增端点、状态计算、事件解析或安全校验时，决定代码落在 `server.ts` 还是 `src/<domain>/`。

## 目录布局（真实）

```
.
├── server.ts                    # 单文件：Express app + ~20 端点 + SSE + 状态读写
├── src/
│   ├── data/seed.ts             # PlatformState / createInitialSeedState()
│   ├── protocol/index.ts        # 前后端唯一共享契约（见 guides/shared-contracts.md）
│   ├── engine/stateMachine.ts   # 纯函数：状态机 / DAG / 预算 / 门禁 / 脱敏 / SOP 解析
│   ├── daemon/ndjsonParser.ts   # CLI NDJSON 解析 + OfflineSeqQueue
│   ├── gateway/imWebhook.ts     # HMAC 验签 + 审批卡片
│   ├── memory/recallEngine.ts   # trigram 召回 + ACL
│   └── utils/statusStyles.ts    # 展示映射（前端消费）
├── .teamai/                     # 团队资产：AGENTS.md / rules / skills / hooks
├── .superagent-state.json       # 运行时状态（已提交进仓库）
└── package-lock.json / tsconfig.json / package.json
```

## 本地模式

- **端点与编排**只在 `server.ts`：`loadOrInitState()`、`saveState()`、`broadcastEnvelope()`、`recomputeRequirementStatus()`、`unlockReadyNodesForRequirement()` 都在此文件。
- **无副作用纯逻辑**抽到 `src/<domain>/*.ts`，用命名导出，例如 `getReadyDagNodes()`、`parseCliNdjsonLine()`、`verifyImWebhookPayload()`、`recallMemoryAssets()`。
- 跨前后端类型只从 `src/protocol/index.ts` 引入；`tsconfig.json` 配了 `paths` 的 `@/*`，但现有代码普遍用相对路径（如 `../protocol`）。
- 测试与被测模块同目录并列，`*.test.ts` 紧贴 `*.ts`。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `server.ts:36 / :50 / :67 / :77` | `STATE_FILE` / `loadOrInitState` / `saveState` / `sseClients` |
| `src/engine/stateMachine.ts:20 / :24` | `canTransition` / `getReadyDagNodes` |
| `src/daemon/ndjsonParser.ts:18 / :104` | `parseCliNdjsonLine` / `OfflineSeqQueue` |
| `src/gateway/imWebhook.ts:20` | `verifyImWebhookPayload` |
| `src/memory/recallEngine.ts:70` | `recallMemoryAssets` |

## 当前实现状态（演示态）

无 service / repository / controller 分层，无数据库、无 migrations。锁文件已由错误命名的 `bun.lock` 归位为 `package-lock.json`（被全局 gitignore 忽略，提交前需处理），`package.json` 的 `name` 仍是模板值 `react-example`。新增模块请沿用"单文件编排 + 纯函数领域模块"的既有形态，不要引入模板式分层。

## 常见错误

- 把同一段校验 / 状态计算复制到多个 handler；应抽纯函数到 `src/` 复用。
- 在 `src/` 模块里直接读写 `STATE_FILE` 或 `sseClients`——它们是 `server.ts` 的模块级私有状态。
- 以为存在 ORM / 数据库层；持久化真相见 [state-persistence.md](./state-persistence.md)。
