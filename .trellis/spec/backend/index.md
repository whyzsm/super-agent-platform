# 后端开发规范（SuperAgent 演示原型）

> 面向 `server.ts` 与 `src/` 下服务端逻辑的本地约定。当前是"可交互流程演示原型"，不是生产平台：状态存本地 JSON、无真实 CLI / LLM / git 执行。

---

## 何时适用

改动 `server.ts` 任意端点、或 `src/engine`、`src/daemon`、`src/gateway`、`src/memory`、`src/data/seed.ts` 时，先读本目录规范。

## 当前实现状态（务必先读）

- 演示态：`server.ts` 是约 45KB 的单文件 Express，全部数据来自 `createInitialSeedState()`（`src/data/seed.ts`）。
- `server.ts` 没有任何 `child_process` / `spawn` 真实 CLI，也没有任何 LLM 调用（`@google/genai` 在 `package.json` 依赖里但 `server.ts` 未 import）。
- `verifierChecks` 硬编码 `passed: true`，靠端点手工推进与注入假事件。
- `worktreePath` / `worktreeBranch` 只是字符串字段，没有 `git worktree add`。
- `syncedToGit = true` 但无 git commit / MR；`/api/mcp/recall` 是普通 HTTP POST，不是 MCP server。
- **默认仍是演示态**；`SUPERAGENT_REAL_RUNTIME=1` 时 `advance` 的 `RUNNING → VERIFYING` 分支改用真实 lint 退出码并写 append-only 事件日志，另有两个受控端点。详见 [real-runtime.md](./real-runtime.md)。

## 文件导航

| 文件 | 主题 |
|------|------|
| [directory-structure.md](./directory-structure.md) | 单文件 server + `src/` 领域分层与落点 |
| [state-persistence.md](./state-persistence.md) | `.superagent-state.json` 全量读写与静默失败 |
| [error-handling.md](./error-handling.md) | 统一 `{ error }` 响应与吞掉的异常 |
| [api-and-events.md](./api-and-events.md) | 端点、SSE、NDJSON、IM webhook |
| [quality-guidelines.md](./quality-guidelines.md) | 纯函数、脱敏、lint / 测试现状 |
| [real-runtime.md](./real-runtime.md) | 受控真实运行时：开关、模块、端点、实测结果与 deferred 项 |

## 证据文件

- `server.ts:36` `STATE_FILE`、`:77` `sseClients`、`:149` 起端点注册。
- `src/engine/stateMachine.ts`、`src/daemon/ndjsonParser.ts`、`src/gateway/imWebhook.ts`、`src/memory/recallEngine.ts`。

## 验证命令

两个可靠命令：`npm run lint`（`tsc --noEmit`）与 `npm test`（14 个 `node:test` 用例）。仍**没有 `typecheck` 脚本**，不要假定 `npm run typecheck` 可用。

## 常见错误

把演示态当成生产实现：在 spec 或代码注释里写"会真实执行 CLI / LLM / git"，或把 `docs/superagent-architecture-discussion-v1.md` 的目标架构当成现状。该讨论稿自述"高保真状态机原型，不是可运行平台"，仅供演进参考，不是本规范描述的事实。
