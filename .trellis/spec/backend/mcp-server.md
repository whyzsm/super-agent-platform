# MCP Server：JSON-RPC 2.0 协议端点

> 实现：`src/mcp/server.ts`（含 `mcp.test.ts` 27 用例）
> 端点：`POST /api/mcp`（标准）、`POST /api/mcp/recall`（兼容旧 HTTP 调用方）
> 传输桥：`scripts/mcp-stdio.mjs`
> 适用：任何声称「MCP」「模型上下文协议」「工具调用」的代码、文档或 UI 文案

---

## 为什么不再叫 MCP

`/api/mcp/recall` 曾经只是一个普通 HTTP POST：`{query, caller, limit}` 进、`{results}` 出。
任何标准 MCP 客户端（Claude Desktop / Codex / Cursor）都无法用它完成握手——
没有 `initialize`、没有 `tools/list`、没有 JSON-RPC 信封，自述「MCP 工具」是名不副实的。

现在 `/api/mcp` 是**真协议端**：JSON-RPC 2.0 信封 + 标准错误码 + 能力协商。
旧路径保留但只作为兼容入口，不得再被描述为 MCP server。

## 支持的方法集

| 方法 | 行为 |
|------|------|
| `initialize` | 返回 `protocolVersion`（`2025-06-18`）、`capabilities.tools`、`serverInfo`、`instructions`；客户端请求版本不被支持时回服务端支持版本 |
| `notifications/initialized` | 通知，**不回包**（HTTP 层 202）；未声明的通知也静默忽略 |
| `ping` | 返回 `{}` |
| `tools/list` | 返回 4 个工具及 `inputSchema`（JSON Schema） |
| `tools/call` | 参数校验后执行工具，结果放 `content[0].text`（JSON 字符串）+ `structuredContent` |

## 工具与红线

| 工具 | 参数 | 行为 |
|------|------|------|
| `recall_memory` | `query`(必填) / `limit` / `teamId` / `projectId` / `userId` / `agentId` | 四级 ACL 召回；**实现侧只返回 published，模块再兜底过滤一次**，draft 永不外泄 |
| `get_task` | `taskId`(必填) | 返回真实状态、重试次数、验证结果摘要、worktreePath |
| `propose_memory`（S2-5 写侧） | `title` / `contentMd` / `assetType`（必填）+ `scope` / `sourceReason` / caller 字段 | **工具层权限校验**：主体需 `memory:propose`（developer/reviewer/admin；McpContext 每请求注入 `principal`，缺省匿名 viewer 一律拒绝）。成功只产出 `status=draft`（查重分入库时算好），拒绝是 `isError` 工具结果而非协议错误；落地实现补记 `memory:propose / applied` 审计行 |
| `list_blocked_tasks` | `limit` | 只返回需介入的 5 态：`HUMAN_GATE` / `WAITING_APPROVAL` / `RETRY_WAIT` / `BLOCKED_BY_RESOURCE` / `QUARANTINED` |

Q5 红线在协议层同样生效：唯一的写工具 `propose_memory` **只产出 draft**，发布仍唯一走 `POST /api/memories/:id/approve`（memory:approve 人审）；`recall_memory` 永远拿不到草案。`POST /api/mcp` 路由本身仍登记为 `read`（协议入口允许握手与只读），写权限在工具层收紧。

## 错误码必须严格

| 场景 | code |
|------|------|
| 报文不是合法 JSON | `-32700` |
| 缺 `jsonrpc`/`method`、`jsonrpc≠"2.0"`、`id` 类型非法 | `-32600` |
| 方法不存在 | `-32601` |
| 未知工具、参数缺失/类型错/越界/多余字段 | `-32602` |
| 桥接或内部异常 | `-32603` |

**工具级失败不是协议错误**：`get_task` 查不到任务返回 `isError:true` 的 content，
而不是 `-32602`。区分这两者是接入方能否正确重试的前提。

成功响应**省略** `isError`（规范默认 false），只在失败时置位。

## express.json 会吞掉 -32700

`express.json()` 解析失败会抛 `SyntaxError` 并返回 **HTML 错误页**，对 MCP 客户端是协议违规。
所以 `server.ts` 在所有路由之后注册了错误中间件：`req.path.startsWith('/api/mcp')` 且属 body 解析错误时，
统一回 `400 {jsonrpc,id:null,error:{code:-32700}}`；其他路径仍走默认处理。
冒烟用例 `MCP: 非法 JSON 返回 -32700` 就是守这条。

## RBAC 与签名

- `POST /api/mcp` 在 `ROUTE_ACTIONS`（`src/policy/rules.ts`）里登记为 `read`——这是只读端点，viewer 也可调用。
- 写方法未登记动作会被 fail-closed 403，新增端点必须同步登记（见 `platform-ports.md`）。
- IM callback 走独立 HMAC 路径，豁免 RBAC。

## stdio 桥的两个硬约束

`scripts/mcp-stdio.mjs` 把 stdin 逐行转发到本地 `/api/mcp`：

1. **stdout 只输出协议报文**，日志一律 stderr——否则污染 MCP 帧。
2. **请求串行化**（内部队列 + 单 drain），保证响应顺序与请求一致；stdio 是单通道，并发会乱序。

服务端 202（纯通知）时桥不输出任何内容，符合规范。

## 常见错误

- 把 `/api/mcp/recall` 当 MCP 端点接入：握手会直接失败。标准接入用 `/api/mcp` + `scripts/mcp-stdio.mjs`。
- 在工具里返回 draft 记忆：即使召回实现出错，`callTool` 也会再过滤一次，不要移除这道兜底。
- 给 `tools/call` 传未声明参数：`additionalProperties:false` 会拒（-32602），这是有意为之。

## 证据

- `src/mcp/server.ts`：`handleMcpMessage`、`validateAgainstSchema`、`callTool`、`MCP_PROTOCOL_VERSION`
- `src/mcp/mcp.test.ts`：21 用例（握手、协商、批量、通知、全部错误码、draft 不外泄）
- `src/server/memory.ts`：`mcpContext`、`POST /api/mcp`、`GET /api/mcp` 405；JSON-RPC 错误中间件在 `src/server/app.ts`
- `scripts/e2e-smoke.mjs` §13：8 项真实 HTTP 断言
