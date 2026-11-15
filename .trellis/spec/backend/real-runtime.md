# 真实运行时（受控开关）

> P0 垂直切片新增。`SUPERAGENT_REAL_RUNTIME=1` 才启用；未设置时 `server.ts` 仍是原有演示态，**字节级行为不变**。

## 何时适用

改动 `src/runtime/` 下任一模块、`server.ts` 的 `RUNNING → VERIFYING` 分支、或 `/api/tasks/:id/real-spawn` `/api/runtime/events` 两个端点时先读本文。

## 模块与职责

| 文件 | 职责 | 关键符号 |
| --- | --- | --- |
| `src/runtime/eventLog.ts` | append-only NDJSON 轨迹，旁路证据不参与状态决策 | `appendRuntimeEvent`、`replayRuntimeEvents(traceId)`、`lastEventSeq`、`EVENT_FILE` |
| `src/runtime/verifier.ts` | 唯一真实确定性门禁：`spawnSync('npm', ['run','lint'])`，按退出码产出 `VerifierCheck[]` | `runLintVerifier(cwd, timeoutMs)` |
| `src/runtime/realRuntime.ts` | 开关判定与编排，结果交回 `transitionTaskVerification()` | `isRealRuntimeEnabled`、`runRealVerification`、`recordStateTransition` |
| `src/runtime/adapters/headlessJson.ts` | 实现 `AgentRunnerAdapter`，真实 spawn 并把 stdout NDJSON 交 `parseCliNdjsonLine()` 脱敏 / 危险拦截 | `createHeadlessJsonAdapter(options)` |
| `server.ts` | 仅 `RUNNING → VERIFYING` 分支加受控路径 + 2 个受控端点 | `POST /api/tasks/:id/advance`、`POST /api/tasks/:id/real-spawn`、`GET /api/runtime/events` |

## 开关与端口约定

- `SUPERAGENT_REAL_RUNTIME=1`：启用真实 verifier 与事件日志；关闭时 `verifierChecks` 仍是原 4 项硬编码全绿。
- `SUPERAGENT_CLI_COMMAND`：**必须显式设置**才能调用 `real-spawn`，否则返回 `400`，避免默认发起模型调用。
- `SUPERAGENT_CLI_ARGS`：按空白切分的命令参数，支持 `{prompt}` 占位符；默认值是 `claude -p --output-format stream-json {prompt}`。自检命令不能含空格。
- 真实路径只产出 `lint` 一项检查结果；`typecheck` / `unit_test` / `cross_review` **不伪造为通过**。
- 事件写入 `.superagent-events.jsonl`（运行时产物，不进版本控制）；`traceId` 形如 `verify-<taskId>-<ts>` / `spawn-<taskId>-<ts>`。

## 实测验收（2026-11-15）

| 场景 | 结果 |
| --- | --- |
| 开关关闭 | `verifierChecks` 4 项全绿，任务进入 `HUMAN_GATE`，与基线一致 |
| 开关开启 / lint 通过 | 仅 1 项 `lint`，`summary = npm run lint 退出码 0`，进入 `HUMAN_GATE` |
| 开关开启 / 注入真实 TS 错误 | `passed: false`、退出码 1，任务进入 `RETRY_WAIT`，`lastErrorFeedback` 含真实 `error TS2322` 堆栈 |
| CLI 链路自检 | `real-spawn` 返回 201；按 `traceId` 重放得到 4 条事件（SPAWN + 3×AGENT_EVENT），`seq` 连续无重复 |
| 清理后 | `npm run lint` 退出码 0；`git diff --stat` 仅 `server.ts`，另新增 `src/runtime/` 4 文件 |

## 已知债务 / deferred

- **真实模型 CLI 集成未验证**：`codex exec` 与 `claude -p --output-format stream-json` 的登录态、返回码、事件行结构未实测；验收用本地 `node -e` NDJSON 源做链路自检，不以模拟结果顶替真实调用。详见任务 `research/cli-probe.md`。
- 依赖缺陷修复（后续收尾）：`esbuild` 升到 `^0.28.0`，`npm install` 已无需 `--legacy-peer-deps`；新增 `npm test` 脚本。原 `bun.lock` 实为 npm lock v2，已归位为 `package-lock.json`（npm 升级为 lockfileVersion 3）。**注意** `package-lock.json` 被全局 `~/.gitignore_global` 忽略，需在提交前决定 `git add -f` 或加 `!package-lock.json` 例外。
- 仍为演示态：`.superagent-state.json` 全量覆盖写、`saveState()` 静默吞失败、`syncedToGit` 无 git 操作、默认 IM 密钥硬编码。
- 未建 worktree：`real-spawn` 的 cwd 固定为仓库根，不是 `worktreePath` 字符串指向的目录。

## 常见错误

- 把 `SUPERAGENT_REAL_RUNTIME` 当成全局替换演示态的开关——它只改 `advance` 的一个分支与两个新增端点。
- 在真实路径里补齐 4 项检查以满足 UI 显示——那等于伪造未执行的门禁。
- 把事件日志当状态源重放并再次 `saveState()`；它是旁路证据，重放只读。
- 直接调用 `real-spawn` 而未设 `SUPERAGENT_CLI_COMMAND`，期望它自动跑默认模型 CLI（会被 400 拒绝）。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，14 个 `node:test` 用例全绿）。
