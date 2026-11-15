# 策略规则集（S2-9）

> 全平台唯一的声明式策略数据与求值入口：危险命令拦截、出站脱敏、worktree 白名单、路由动作登记。收敛前散落在 `stateMachine.ts` / `server/middleware.ts` / `worktreeManager.ts` 三处。

---

## 何时适用

新增 / 修改危险命令规则、脱敏正则、worktree taskId/baseRef 白名单、路由动作登记（`ROUTE_ACTIONS`）时。

## 模块与职责

| 文件 | 职责 | 关键符号 |
| --- | --- | --- |
| `src/policy/rules.ts` | 纯声明式规则数据（改规则只看这里） | `DANGER_COMMAND_RULES`（4 条）、`REDACTION_RULES`（6 条）、`TASK_ID_PATTERN`、`BASE_REF_PATTERN`、`ROUTE_ACTIONS`（24 条） |
| `src/policy/engine.ts` | 对规则集求值的纯函数 | `detectDangerousCommand`、`redactSecrets`（含 $1/$2 捕获组保留） |
| `src/policy/routeActions.ts` | 路由动作求值 | `actionFor`（exempt/read 兜底/写 fail-closed null） |
| `src/policy/policy.test.ts` | 逐规则正反例 + 不变量（28 用例） | 规则代号唯一、首条命中即返回、脱敏幂等 |

## 规则约定

- `code`（如 `NO_ROOT_DELETE`）是对外契约：出现在拦截事件、UI 文案、审计，**不得随意改名**。
- 危险命令按数组顺序求值，**首条命中即返回**；调整顺序 = 调整拦截优先级。
- 改任何规则必须同步 `policy.test.ts` 对应用例。
- 已知保守误报（有意保留，见 `docs/decision-log.md` D-2026-11-16-04）：`--force-with-lease` 命中 `NO_FORCE_PUSH`；`.env.example` 命中 `SENSITIVE_PATH_GUARD`。

## 消费方（import 一律指向 src/policy，不留旧路径 re-export）

- `src/daemon/ndjsonParser.ts`、`src/runtime/adapters/headlessJson.ts`、`src/runtime/verifier.ts`、`src/identity/audit.ts`、`src/server/tasks.ts`
- `src/server/middleware.ts` 用 `actionFor`；`src/workspace/worktreeManager.ts` 用 `TASK_ID_PATTERN` / `BASE_REF_PATTERN`。

## 常见错误

- 在 `stateMachine.ts` 里重新内联安全正则——状态机不承载策略，策略只进 `src/policy/`。
- 新增写端点忘了在 `ROUTE_ACTIONS` 登记，联调被 403 挡下还以为是 bug（fail-closed 是设计行为）。
- 把 `ROUTE_ACTIONS` 的正则元字符（`.`）当通配符写：`/api/bootstrap` 里的 `.\b` 保证不误配。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（223 个用例全绿，其中 policy 28 个）。
