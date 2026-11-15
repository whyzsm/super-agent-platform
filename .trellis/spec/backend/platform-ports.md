# Ports & Adapters：本地闭环的三个可替换端口

> 面向 `server.ts` 的接入层约定。目标：Postgres / OIDC / Temporal 缺席时，平台仍能在单机跑通完整流程；生产只换 adapter，不改业务。

---

## 何时适用

改动 `server.ts` 的中间件、状态读写、身份校验，或 `src/store/`、`src/identity/`、`src/loop/` 任一模块时先读本文件。

## 三个端口与落点

| 端口 | 本地默认实现 | 生产 adapter | 关键符号 |
| --- | --- | --- | --- |
| `StateStore` | `src/store/fileStateStore.ts`；**Postgres 已落地**（`src/store/postgresStateStore.ts`，`SUPERAGENT_PG_CMD` 启用，S1-2/D-13） | node-postgres 异步实现（需契约异步化） | `createFileStateStore({statePath,logPath})`、`createPostgresStateStore({command,tablePrefix})`、`save/load/appendCommand/replayCommands` |
| `IdentityProvider` | `src/identity/localProvider.ts`；**OIDC 已落地**（`src/identity/oidcProvider.ts`，`SUPERAGENT_OIDC_ISSUER` 启用，S2-1/D-16，本地 Keycloak 验证） | 任意 RS256 OIDC IdP（Keycloak/Logto/Auth0） | `createLocalIdentityProvider()`、`createOidcIdentityProvider({issuer})`（含 `warmup()` 预热 JWKS）、`resolve(headers)` |
| `CommandBus` | `src/loop/commandBus.ts` | Temporal（S3-1） | `createCommandBus({logPath})`、`submit/list/lastSeq` |

`src/store/types.ts` 的 `StateStore` 是**唯一状态契约**；`PlatformState` 的真实定义在 `src/data/seed.ts:9`（不在 `src/protocol/index.ts`），不要重复定义。

## 本地实现的行为约定（每条都有测试）

- **原子快照**：`fileStateStore.save()` 写同目录 `.tmp-<uuid>` 再 `renameSync`；`load()` 遇损坏 JSON **抛错**，不静默回退 seed。证据：`src/store/fileStateStore.test.ts` 的崩溃恢复用例。
- **损坏快照隔离**：`src/server/context.ts` 的 `loadOrInitState()` 捕获解析异常后先 `renameSync` 成 `.superagent-state.json.corrupt-<ts>` 留证，再 `console.error` 告知剩余命令数，最后才用 seed 初始化。禁止删掉损坏文件。
- **幂等命令**：中间件只在 `req.body.commandId` 存在时调 `store.appendCommand()`；重复返回 409，重放不二次写状态。日志是 `.superagent-commands.jsonl`。
- **身份解析**：`x-superagent-user/team/project/agent/roles` 五个头；非 loopback 且无身份头 → 匿名 viewer，写操作一律 403。loopback 且无身份头时注入 dev 管理员（`SUPERAGENT_DEV_USER/TEAM/ROLES` 可覆盖），这是**仅限本地**的开箱可用适配，生产接 OIDC 后必须关闭。
- **RBAC**：`src/identity/rbac.ts` 的 `isAllowed()` / `assertAllowed()`；权限矩阵写在文件头注释。`canAccessAsset()` 复用 `src/memory/recallEngine.ts` 的 `findMatchedAcl()`，不重写四级 ACL。
- **不可变审计**：`src/identity/audit.ts` 的 `createAuditLog()`，append-only JSONL，写操作**先记 allowed/denied 再执行**；`GET /api/runtime/audit` 只读。
- **3 态生产者**：`src/loop/taskLifecycle.ts` 的 `applyResourceTransition()` 以 `canTransition()` 为唯一裁决，非法迁移零副作用；`src/server/tasks.ts` 的 `POST /api/tasks/:id/resource-transition` 先经 `commandBus.submit()` 幂等再改状态。
- **Q5 红线**：`deriveRetrospective()` 的 `requiresHumanReview` 恒为 `true`；`POST /api/tasks/:id/retrospective` 只返回草案文本，**不写任何文件、不改 `TeamAiAsset`**。

## 运行时开关

`src/runtime/realRuntime.ts` 的 `isRealRuntimeEnabled()` **默认返回 true**（真实 `npm run lint` + `npm test`）。`SUPERAGENT_DEMO_MODE=1` 或 `SUPERAGENT_REAL_RUNTIME=0` 才回退 4 项硬编码全绿的演示态；`SUPERAGENT_REAL_RUNTIME=1` 保持向后兼容。

## 新增端点

| 端点 | 作用 |
| --- | --- |
| `POST /api/tasks/:id/resource-transition` | 3 态生产者，body `{kind, commandId?}`，非法 kind / 非法迁移 400、重复命令 409 |
| `POST /api/tasks/:id/retrospective` | 返回人审草案，恒 `requiresHumanReview: true` |
| `GET /api/runtime/audit` | 审计行（`?teamId=` 过滤） |
| `GET /api/runtime/commands` | 已提交命令与 `lastSeq` |

## 常见错误

- 在业务端点里直接 `fs.writeFileSync(STATE_FILE, ...)` 绕开 `store.save()`，会破坏原子性。
- 给 `/api/webhooks/*` 加 RBAC：IM 回调用 HMAC 验签 + 300s 防重放，中间件已显式豁免，不要改成要求身份头。
- 把 `syncedToGit` 置 true：`src/protocol/index.ts` 的 JSDoc 已写明恒 false，只有真正 commit + MR 才可改。
- 以为 `eventLog.ts` / `audit.ts` / `commandBus.ts` 支持多进程并发写：三者都靠"每次重读真实 max seq"，**单进程单写者**是前提，多 worker 需文件锁或换生产 adapter。

## 验证

`npm run lint`、`npm test`（197 用例）；端到端断言见 `scripts/e2e-smoke.mjs`（54 项）与 `docs/superagent-unblock-solution-v1.md` §6 / §9。注意 `.teamai/hooks/pre-merge-gate.sh` 写的是 pnpm 命令，本仓库不可用。
