# API 与事件

> 本文件由模板 `logging-guidelines.md` 重命名而来：项目没有日志库 / 日志级别规范，只有端点、SSE 广播与 NDJSON 事件流，故改为描述 API 与事件契约。

---

## 何时适用

新增 `src/server/` 端点、改动 SSE 广播、NDJSON 解析、IM webhook 或 `DaemonEnvelope` 结构时。

## 本地模式

- 约 31 个端点按域注册在 `src/server/{app,tasks,requirements,memory,webhooks,runtime,workspace}.ts`（装配入口 `app.ts` 的 `createApp(ctx)`），分组：
  - 读取：`GET /api/health` / `/api/bootstrap` / `/api/stream`。
  - 需求与任务推进：`POST /api/requirements`、`/api/tasks/:id/advance|simulate-failure|simulate-danger|gate|ndjson|input|comments`、`POST /api/requirements/:id/solidify-sop`。
  - 集成：`GET /api/webhooks/im/card/:taskId`、`POST /api/webhooks/im`、`POST /api/mcp/recall`。
  - 资产与运维：`POST /api/memories/:id/approve|reject`、`PUT /api/teamai`、`POST /api/daemons/:machineId/replay`、`POST /api/reset`。
  - 真实运行时（**默认启用**，`SUPERAGENT_DEMO_MODE=1` 回退演示态）：`POST /api/tasks/:id/real-spawn`、`GET /api/runtime/events?traceId=...`；`advance` 的验证分支用 `npm run lint` + `npm test` 真实退出码。
  - 本轮新增：`POST /api/tasks/:id/resource-transition`（3 态生产者）、`POST /api/tasks/:id/retrospective`（只产出人审草案）、`GET /api/runtime/audit`、`GET /api/runtime/commands`。详见 [platform-ports.md](./platform-ports.md)。
- SSE：`sseClients: Set<Response>` 与 `broadcastEnvelope()` 在 `src/server/context.ts`；`GET /api/stream` 在 `src/server/app.ts`，写 `data: <JSON>\n\n`，心跳 `setInterval` 约 8 秒在 `server.ts` 启动引导；客户端写失败即从 `Set` 删除。
- 事件归一化：`parseCliNdjsonLine()`（`src/daemon/ndjsonParser.ts:18`）先 `redactSecrets()` 脱敏再按 shell / command 规则拦截；`OfflineSeqQueue`（`:104`）提供 `enqueue`（按 seq 去重排序）、`ackUpTo`、`replayFrom`、`pendingCount`。
- IM 回调：`signImWebhookPayload` / `verifyImWebhookPayload`（`src/gateway/imWebhook.ts:16 / :20`）用 HMAC-SHA256 + `timingSafeEqual` + 300 秒重放窗口，`buildImApprovalCard()`（`:53`）产出 wecom `template_card` / feishu `interactive`；`IM_WEBHOOK_SECRET` 只由 `process.env.IM_WEBHOOK_SECRET` 注入（`createServerContext` 读取）、无默认回退，缺失时 `GET /api/webhooks/im/card/:taskId` 与 `POST /api/webhooks/im` 返回 `503 { error: 'IM_WEBHOOK_SECRET is not configured' }`，并在服务启动日志一次性告警。
- 共享事件 / 命令类型 `DaemonEnvelope`、`DaemonCommand`、`NormalizedAgentEvent` 只从 `src/protocol/index.ts` 引入。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/server/app.ts` / `src/server/context.ts` | `GET /api/stream` / `broadcastEnvelope`（心跳定时器在 `server.ts`） |
| `src/daemon/ndjsonParser.ts:18 / :104` | `parseCliNdjsonLine` / `OfflineSeqQueue` |
| `src/gateway/imWebhook.ts:20 / :53` | 验签 / `buildImApprovalCard` |
| `src/engine/stateMachine.ts:258` | `redactSecrets`（6 类正则） |
| `src/stores/useAgentStreamStore.ts:18` | 前端 `EventSource('/api/stream')` 消费 |

## 当前实现状态（演示态）

- 事件全部来自手工端点或注入：`/advance` 自行构造 `verifierChecks`（`passed: true`），`/simulate-failure`、`/simulate-danger` 注入假失败 / 假高危命令；没有真实 CLI spawn，也没有 LLM 调用。
- `/api/mcp` 是**标准 MCP JSON-RPC 2.0 端点**（`src/mcp/server.ts`：`initialize` / `tools/list` / `tools/call` / `ping`），stdio 桥见 `scripts/mcp-stdio.mjs`；`/api/mcp/recall` 仅作旧 HTTP 调用方兼容，不得再被描述为 MCP server。详见 [mcp-server.md](./mcp-server.md)。
- `/api/tasks/:id/worktree`（`POST`/`DELETE`）与 `/api/workspaces` 是**真实 `git worktree` 建删**，`worktreePath` 会被替换成落盘的绝对路径。详见 [workspace-worktree.md](./workspace-worktree.md)。
- `/api/daemons/:machineId/replay` 仍只是把 `lastAckSeq` 加上一个模拟条数。
- 没有日志库、没有日志级别、没有结构化日志字段；仅少量 `console.log` 调度打印。

## 常见错误

- 新增端点后忘了 `ctx.saveState(ctx.state.current)` + `ctx.broadcastEnvelope(...)`，导致前端 SSE 不刷新。
- 直接把 NDJSON 原始行广播出去；应先 `parseCliNdjsonLine` 脱敏与拦截。
- 把 `/api/mcp/recall` 当成真实 MCP 通道、或把 SSE 当成持久事件溯源；它是进程内即时广播，重启即丢。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，197 个 `node:test` 用例全绿）。
