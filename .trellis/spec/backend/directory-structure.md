# 后端目录结构

> 后端已按「启动引导 + 路由域模块 + 纯函数领域层」组织（S1-1 拆分完成）：`server.ts` 只做装配启动，全部端点在 `src/server/` 下按域拆分，可复用纯逻辑在 `src/<domain>/` 按领域分文件。

---

## 何时适用

新增端点、状态计算、事件解析或安全校验时，决定代码落在 `src/server/` 路由层还是 `src/<domain>/` 纯逻辑层。

## 目录布局（真实）

```
.
├── server.ts                    # 启动引导：dotenv 首行、createServerContext、createApp、
│                                #   vite(开发)/static(生产)、app.listen、8s 心跳定时器
├── src/
│   ├── server/                  # 路由层（S1-1 拆分，全部端点在此）
│   │   ├── context.ts           # ServerContext：state/seq 盒子 + 四端口实例 +
│   │   │                        #   saveState/broadcast/recompute/unlock/reset/syncTeamAi
│   │   ├── middleware.ts        # ROUTE_ACTIONS + RBAC/审计/commandId 幂等（fail-closed）
│   │   ├── app.ts               # createApp(ctx)：装配、health/bootstrap/stream/reset、
│   │   │                        #   JSON-RPC -32700 错误边界
│   │   ├── tasks.ts             # advance/simulate×2/gate/ndjson/input/comments/
│   │   │                        #   resource-transition/retrospective
│   │   ├── requirements.ts      # POST /api/requirements（内联 DAG 模板）/ solidify-sop
│   │   ├── memory.ts            # /api/mcp(POST/GET) / mcp/recall / memories 审批 / teamai PUT
│   │   ├── webhooks.ts          # IM 审批卡片 + HMAC 验签回调
│   │   ├── runtime.ts           # real-spawn / runtime 事件·审计·命令 / daemons replay
│   │   ├── workspace.ts         # GET /api/workspaces + POST/DELETE 任务 worktree
│   │   └── http.test.ts         # 路由层 HTTP 测试（61 用例）
│   ├── data/seed.ts             # PlatformState / createInitialSeedState()
│   ├── protocol/index.ts        # 前后端唯一共享契约（见 guides/shared-contracts.md）
│   ├── engine/stateMachine.ts   # 纯函数：状态机 / DAG / 预算 / 门禁 / 脱敏 / SOP 解析
│   ├── daemon/ndjsonParser.ts   # CLI NDJSON 解析 + OfflineSeqQueue
│   ├── gateway/imWebhook.ts     # HMAC 验签 + 审批卡片
│   ├── memory/recallEngine.ts   # trigram 召回 + 四级 ACL
│   └── utils/statusStyles.ts    # 展示映射（前端消费）
├── .teamai/                     # 团队资产：AGENTS.md / rules / skills / hooks
└── package-lock.json / tsconfig.json / package.json
```

运行态数据文件（`.superagent-state.json`、`.superagent-*.jsonl`、`.worktrees/`）全部 gitignore，见 [state-persistence.md](./state-persistence.md)。

## 落点规则

- **端点 handler** 只写 `src/server/<域>.ts` 的 `register<X>Routes(app, ctx)`；不要往 `server.ts` 回堆路由。
- **新写路由必须同步登记** `src/server/middleware.ts` 的 `ROUTE_ACTIONS`，否则写方法 fail-closed 403（设计行为，不是 bug）。
- **跨 handler 共享的可变状态只经 `ServerContext`**：`state` / `seq` 是盒子（`{ current }`）。`POST /api/reset` 会整体替换 `state.current`，任何读取方（含 `memory.ts` 的 mcpContext 惰性闭包）必须实时读 `.current`，**禁止解构缓存 PlatformState 本身**。
- **HTTP 测试**补进 `src/server/http.test.ts`：每个用例经 `startTestApp()` 自建隔离实例（临时 dataDir + 临时 git 仓 + `listen(0)`），不复用全局状态。
- **无副作用纯逻辑**抽到 `src/<domain>/*.ts`，命名导出；跨前后端类型只从 `src/protocol/index.ts` 引入。
- 测试与被测模块同目录并列，`*.test.ts` 紧贴 `*.ts`。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/server/context.ts` | `createServerContext` / `ServerContext.state.current` / `resetState` |
| `src/server/middleware.ts` | `ROUTE_ACTIONS` / `actionFor` / `createRbacMiddleware` |
| `src/server/app.ts` | `createApp` / `GET /api/stream` / JSON-RPC `-32700` 错误边界 |
| `server.ts` | `startServer`（vite/static 装配 + `app.listen` + 心跳定时器） |

## 常见错误

- 把同一段校验 / 状态计算复制到多个 handler；应抽纯函数到 `src/` 复用。
- 在路由模块里解构缓存 `ctx.state.current`——reset 后指向旧对象，必须经 `ctx.state.current` 实时取。
- 在 `src/server/` 之外直接读写状态文件或 `sseClients`；它们只属于 `ServerContext`。
- **环境相关的测试失败**：dev server 经 dotenv 加载 `.env` 后，其 verifier 会再跑 `npm test`；HTTP 测试若依赖「IM_WEBHOOK_SECRET 未配置」这类环境形状，必须在文件头清除并恢复相关变量（`http.test.ts` 的 `HERMETIC_ENV_KEYS` 已做，新增用例勿绕开）。
- 以为存在 ORM / 数据库层；持久化真相见 [state-persistence.md](./state-persistence.md)。
