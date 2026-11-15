# 后端开发规范（SuperAgent 本地闭环）

> 面向 `server.ts` 与 `src/` 下服务端逻辑的本地约定。当前是**单机可运行的完整闭环**：真实确定性验证、原子状态快照、append-only 事件/命令日志、本地身份与 RBAC、不可变审计。真实模型 CLI 通过可注入 adapter 接入，生产外部服务（Postgres / OIDC / Temporal）通过可替换端口接入，见 [platform-ports.md](./platform-ports.md)。

---

## 何时适用

改动 `server.ts` 任意端点、或 `src/engine`、`src/daemon`、`src/gateway`、`src/memory`、`src/data/seed.ts` 时，先读本目录规范。

## 当前实现状态（务必先读）

- `server.ts` 仍是单文件 Express，但已接入 `src/store/`（原子状态快照 + 命令日志）、`src/identity/`（身份 / RBAC / 审计）、`src/loop/`（幂等命令总线 + 3 态生产者）。
- **默认走真实运行时**：`advance` 的 `RUNNING → VERIFYING` 分支由 `runRealVerifier()` 真实执行 `npm run lint` + `npm test`；回退演示态用 `SUPERAGENT_DEMO_MODE=1` 或 `SUPERAGENT_REAL_RUNTIME=0`。详见 [real-runtime.md](./real-runtime.md)。
- 真实 CLI 通过 `createHeadlessJsonAdapter()` spawn，但 `real-spawn` 强制要求显式 `SUPERAGENT_CLI_COMMAND`，不会默认发起模型调用；未实测登录态与额度。
- `worktreePath` / `worktreeBranch` 仍是字符串字段，没有 `git worktree add`。
- `syncedToGit` **恒为 false**（无 git commit / MR，本地写盘不等于同步）；`/api/mcp/recall` 是普通 HTTP POST，不是 MCP server。

## 文件导航

| 文件 | 主题 |
|------|------|
| [directory-structure.md](./directory-structure.md) | 单文件 server + `src/` 领域分层与落点 |
| [state-persistence.md](./state-persistence.md) | 原子快照、命令日志与损坏快照隔离 |
| [error-handling.md](./error-handling.md) | 统一 `{ error }` 响应与吞掉的异常 |
| [api-and-events.md](./api-and-events.md) | 端点、SSE、NDJSON、IM webhook |
| [quality-guidelines.md](./quality-guidelines.md) | 纯函数、脱敏、lint / 测试现状 |
| [real-runtime.md](./real-runtime.md) | 真实运行时：开关、模块、端点、实测结果与 deferred 项 |
| [platform-ports.md](./platform-ports.md) | 三端口（StateStore / IdentityProvider / CommandBus）、RBAC、审计与新端点 |

## 证据文件

- `server.ts:36` `STATE_FILE`、`:77` `sseClients`、`:149` 起端点注册。
- `src/engine/stateMachine.ts`、`src/daemon/ndjsonParser.ts`、`src/gateway/imWebhook.ts`、`src/memory/recallEngine.ts`。

## 验证命令

两个可靠命令：`npm run lint`（`tsc --noEmit`）与 `npm test`（14 个 `node:test` 用例）。仍**没有 `typecheck` 脚本**，不要假定 `npm run typecheck` 可用。

## 常见错误

把演示态当成生产实现：在 spec 或代码注释里写"会真实执行 CLI / LLM / git"，或把 `docs/superagent-architecture-discussion-v1.md` 的目标架构当成现状。该讨论稿自述"高保真状态机原型，不是可运行平台"，仅供演进参考，不是本规范描述的事实。
