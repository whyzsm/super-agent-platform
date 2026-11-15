# 后端质量规范

> 后端是"单文件编排 + 纯函数领域模块"：质量基线靠 TypeScript 编译、纯函数与脱敏规则，而非分层框架或运行时校验。

---

## 何时适用

提交后端改动前自检，尤其是新增 `src/<domain>` 纯函数、改状态机规则、或调整令牌预算 / 危险命令检测。

## 本地模式（required patterns）

- 业务逻辑写成**无副作用纯函数**并命名导出，便于 `node:test` 直接断言：`src/engine/stateMachine.ts` 的 `canTransition`、`getReadyDagNodes`（上游全部 `MERGED` 才解锁）、`transitionTaskVerification`、`recordUsageAndCheckBudget`（token 预算熔断）、`resolveGateDecision`、`detectDangerousCommand`（4 条规则：`rm -rf /`、`DROP TABLE/DATABASE`、`git push --force`、敏感路径）、`redactSecrets`（6 类正则：`sk-`、`ghp_`、`AKIA`、`Bearer`、DB 连接串、邮箱）、`parseSkillFrontmatter`、`extractSkillDraft`。
- 安全逻辑集中在 `src/gateway/imWebhook.ts`（HMAC + `timingSafeEqual` + 300s 窗口）与 `src/memory/recallEngine.ts`（`recallMemoryAssets` 只召回 `status === 'published'`，`findMatchedAcl` 四级 ACL，trigram Jaccard + 0.35 关键词加权）。
- 测试文件与被测模块同目录并列，用 `import test from 'node:test'` + `import assert from 'node:assert/strict'`，并用 `makeNode()` 之类的工厂造数据（见 `src/engine/stateMachine.test.ts:15`）。

## 证据文件（4 个真实测试）

- `src/engine/stateMachine.test.ts`、`src/daemon/ndjsonParser.test.ts`、`src/gateway/imWebhook.test.ts`、`src/memory/recallEngine.test.ts`。

## 验证命令（只写真实存在的）

- `npm run lint` → 实际是 `tsc --noEmit`（`package.json` 无 `typecheck` 脚本）。
- `test` 脚本已补齐：`node --import tsx --test "src/**/*.test.ts"`，4 个测试文件共 14 个用例全绿；`typecheck` 脚本仍不存在，`pnpm test` 也不可用。
- `.teamai/hooks/pre-merge-gate.sh` 写的是 `pnpm lint && pnpm typecheck && pnpm test --run`，`.teamai/AGENTS.md` 也要求这三步——**与工程实际不一致**，详见 [guides/team-assets.md](../guides/team-assets.md)。

## 当前实现状态（诚实标注）

- `tsconfig.json` 未开 `strict: true`（有 `noEmit`、`moduleResolution: bundler`、`jsx: react-jsx`、`paths @/*`）；类型检查偏宽松。
- `verifierChecks` 在**默认演示态**仍硬编码 `passed: true`；`SUPERAGENT_REAL_RUNTIME=1` 时由 `runRealVerifier()` 真实执行 `npm run lint` + `npm test`，只产出 `lint` / `unit_test` 两项，`typecheck` / `cross_review` 无真实执行手段故不产出（不伪造通过）。详见 [real-runtime.md](./real-runtime.md)。
- `saveState()` 写失败已改为 `console.error` 显式告警（`server.ts:81`）；`IM_WEBHOOK_SECRET` 已改为 env 注入、缺失返回 503（`server.ts:46`）；`tsconfig` 仍未开 `strict`。
- `syncedToGit` 为 `true` 但无 git 操作；`worktreePath` / `worktreeBranch` 只是字符串字段。
- `.superagent-state.json` 工作树已脱敏并停止跟踪，但 **`8eae911` 起的 git 历史仍含内部 hostname**（Q11 未清理历史）。

## 代码审查清单

- 新逻辑是否抽成 `src/` 下可 `node:test` 断言的纯函数？
- 新增端点改完状态后是否 `saveState(state)` + `broadcastEnvelope(...)`？
- 跨层类型是否只从 `src/protocol/index.ts` 引入（见 [guides/shared-contracts.md](../guides/shared-contracts.md)）？
- 日志 / NDJSON 是否经过 `redactSecrets()` 再外发？

## 常见错误 / 禁止模式

- 把校验规则内联进 `server.ts` handler 而不抽到 `src/` 纯函数——会失去可测试性并四处重复。
- 在纯函数里读写 `STATE_FILE` / `sseClients` / `Date.now()` 之外的外部状态。
- 照抄 `.teamai` 门禁脚本里的 `pnpm ...` 命令作为本仓库验证方式（脚本不可用）。
- 以"门禁已通过"为由跳过 `npm run lint`；演示态的 `passed: true` 不代表编译通过。
