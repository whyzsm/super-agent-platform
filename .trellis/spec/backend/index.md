# 后端开发规范（SuperAgent 本地闭环）

> 面向 `server.ts` 与 `src/` 下服务端逻辑的本地约定。当前是**单机可运行的完整闭环**：真实确定性验证、原子状态快照、append-only 事件/命令日志、本地身份与 RBAC、不可变审计。真实模型 CLI 通过可注入 adapter 接入，生产外部服务（Postgres / OIDC / Temporal）通过可替换端口接入，见 [platform-ports.md](./platform-ports.md)。

---

## 何时适用

改动 `src/server/` 任意路由、`server.ts` 启动引导、`src/policy/` 策略规则、或 `src/engine`、`src/daemon`、`src/gateway`、`src/memory`、`src/data/seed.ts` 时，先读本目录规范。

## 当前实现状态（务必先读）

- `server.ts` 已拆为**启动引导 + 路由域模块**（S1-1 完成）：`src/server/{app,middleware,context,tasks,requirements,memory,webhooks,runtime,workspace}.ts` 承载全部端点，共享可变状态收敛进 `ServerContext`（`state`/`seq` 盒子）；`server.ts` 只留 dotenv 首行、装配、vite/static 与 listen。端口实例（store / identity / loop）在 `createServerContext()` 注入。
- **默认走真实运行时**：`advance` 的 `RUNNING → VERIFYING` 分支由 `runRealVerifier()` 真实执行 `npm run lint` + `npm test`；回退演示态用 `SUPERAGENT_DEMO_MODE=1` 或 `SUPERAGENT_REAL_RUNTIME=0`。详见 [real-runtime.md](./real-runtime.md)。
- 真实 CLI 通过 `createHeadlessJsonAdapter()` spawn，但 `real-spawn` 强制要求显式 `SUPERAGENT_CLI_COMMAND`，不会默认发起模型调用；未实测登录态与额度。
- `worktreePath` 由 `git worktree add` **真实落盘**（`src/workspace/worktreeManager.ts`，端点 `POST/DELETE /api/tasks/:id/worktree`），创建后替换为绝对路径；种子数据里的 `~/.superagent/...` 只是未创建前的占位。详见 [workspace-worktree.md](./workspace-worktree.md)。
- `syncedToGit` **恒为 false**（无 git commit / MR，本地写盘不等于同步）。`/api/mcp` 是**标准 MCP JSON-RPC 2.0 端点**（`src/mcp/server.ts`），`/api/mcp/recall` 仅作旧 HTTP 调用方兼容。详见 [mcp-server.md](./mcp-server.md)。
- RBAC 采用**显式路由动作表 + 写操作 fail-closed**：写方法未在 `ROUTE_ACTIONS`（`src/policy/rules.ts`）登记即 403，不再默认落到 `task:advance`。

## 文件导航

| 文件 | 主题 |
|------|------|
| [directory-structure.md](./directory-structure.md) | `src/server/` 路由层拆分 + `src/` 领域分层与落点 |
| [state-persistence.md](./state-persistence.md) | 原子快照、命令日志与损坏快照隔离 |
| [error-handling.md](./error-handling.md) | 统一 `{ error }` 响应与吞掉的异常 |
| [api-and-events.md](./api-and-events.md) | 端点、SSE、NDJSON、IM webhook |
| [quality-guidelines.md](./quality-guidelines.md) | 纯函数、脱敏、lint / 测试现状 |
| [real-runtime.md](./real-runtime.md) | 真实运行时：开关、模块、端点、实测结果与 deferred 项 |
| [platform-ports.md](./platform-ports.md) | 三端口（StateStore / IdentityProvider / CommandBus）、RBAC、审计与新端点 |
| [workspace-worktree.md](./workspace-worktree.md) | M14 真实 git worktree：路径校验、幂等、排除规则、端点与失败语义 |
| [mcp-server.md](./mcp-server.md) | MCP JSON-RPC 2.0：方法集、错误码、参数校验、stdio 桥与兼容入口 |
| [policy-rules.md](./policy-rules.md) | 策略规则集（S2-9）：危险命令 / 脱敏 / worktree 白名单 / 路由动作表 |

## 证据文件

- `src/server/context.ts` `createServerContext`、`src/server/middleware.ts` `createRbacMiddleware`（动作表在 `src/policy/rules.ts`）、`src/server/app.ts` `createApp`；启动引导见 `server.ts` `startServer`。
- `src/engine/stateMachine.ts`、`src/daemon/ndjsonParser.ts`、`src/gateway/imWebhook.ts`、`src/memory/recallEngine.ts`。

## 验证命令

三个可靠命令：
- `npm run lint`（`tsc --noEmit`）
- `npm test`（197 个 `node:test` 用例：136 个领域单测 + 61 个 `src/server/http.test.ts` 路由层断言）
- `node scripts/e2e-smoke.mjs`（对已启动服务跑 54 项真实 HTTP 断言）

仍**没有 `typecheck` 脚本**，不要假定 `npm run typecheck` 可用。

## 常见错误

把演示态当成生产实现：在 spec 或代码注释里写"会真实执行 CLI / LLM / git"，或把 `docs/superagent-architecture-discussion-v1.md` 的目标架构当成现状。该讨论稿自述"高保真状态机原型，不是可运行平台"，仅供演进参考，不是本规范描述的事实。
