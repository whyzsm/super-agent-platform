# 真实运行时（受控开关）

> P0 垂直切片新增，**现为默认行为**：未设置任何开关时走真实 verifier + 旁路事件日志；`SUPERAGENT_DEMO_MODE=1` 或 `SUPERAGENT_REAL_RUNTIME=0` 才回退原有演示态（4 项硬编码全绿）。`SUPERAGENT_REAL_RUNTIME=1` 仍为真，保持旧配置兼容。

## 何时适用

改动 `src/runtime/` 下任一模块、`src/server/tasks.ts` 的 `RUNNING → VERIFYING` 分支、或 `/api/tasks/:id/real-spawn` `/api/runtime/events` 两个端点时先读本文。

## 模块与职责

| 文件 | 职责 | 关键符号 |
| --- | --- | --- |
| `src/runtime/eventLog.ts` | append-only NDJSON 轨迹，旁路证据不参与状态决策 | `appendRuntimeEvent`、`replayRuntimeEvents(traceId)`、`lastEventSeq`、`EVENT_FILE` |
| `src/runtime/verifier.ts` | 唯一真实确定性门禁：`spawnSync('npm', ...)` 真实执行 `npm run lint` 与 `npm test` 两项，按各自退出码产出 `VerifierCheck[]`；`typecheck` / `cross_review` 无真实执行手段故不产出 | `runRealVerifier(cwd, timeoutMs)`、`runLintVerifier(cwd, timeoutMs)`（兼容旧入口，仅 lint 一项） |
| `src/runtime/realRuntime.ts` | 开关判定与编排，结果交回 `transitionTaskVerification()` | `isRealRuntimeEnabled`、`runRealVerification`、`recordStateTransition` |
| `src/runtime/adapters/headlessJson.ts` | 实现 `AgentRunnerAdapter`，真实 spawn 并把 stdout NDJSON 交 `parseCliNdjsonLine()` 脱敏 / 危险拦截 | `createHeadlessJsonAdapter(options)` |
| `src/server/tasks.ts` / `src/server/runtime.ts` | `RUNNING → VERIFYING` 受控路径与受控端点 | `POST /api/tasks/:id/advance`（tasks.ts）、`POST /api/tasks/:id/real-spawn`、`GET /api/runtime/events`（runtime.ts） |

## 开关与端口约定

- 默认启用真实 verifier（`lint` + `unit_test` 两项真实退出码）与事件日志；`SUPERAGENT_DEMO_MODE=1` 时 `verifierChecks` 才回到原 4 项硬编码全绿。
- `SUPERAGENT_CLI_COMMAND`：**必须显式设置**才能调用 `real-spawn`，否则返回 `400`，避免默认发起模型调用。
- `SUPERAGENT_CLI_ARGS`：按空白切分的命令参数，支持 `{prompt}` 占位符；默认值是 `claude -p --output-format stream-json {prompt}`。自检命令不能含空格。
- 真实路径只产出真实执行的两项 `lint` / `unit_test` 结果：`lint` 来自 `npm run lint`（实为 `tsc --noEmit`），`unit_test` 来自 `npm test`。`typecheck` 无独立 npm 脚本（tsc 已由 lint 覆盖，不重复记账）、`cross_review` 无真实异构模型执行手段，二者**不产出任何** `VerifierCheck`，既不伪造 `passed:true` 也不假造 `passed:false`。
- `src/runtime/verifier.ts` 的 `runRealVerifier` 对每项独立计时并记录真实退出码；spawn 失败 / 超时 / 非零退出均记 `passed:false` 且整体 `passed:false`，错误写入 `logs` 不抛异常；日志经 `redactSecrets()` 脱敏并截断 4000 字符，多项合并按均分预算截断防超长。
- 事件写入 `.superagent-events.jsonl`（运行时产物，不进版本控制）；`traceId` 形如 `verify-<taskId>-<ts>` / `spawn-<taskId>-<ts>`。

## 实测验收（2026-11-15）

| 场景 | 结果 |
| --- | --- |
| 开关关闭 | `verifierChecks` 4 项全绿，任务进入 `HUMAN_GATE`，与基线一致 |
| 开关开启 / lint + unit_test 通过 | 2 项 `lint` + `unit_test`，`summary` 各含 `npm run lint` / `npm test` 与 `退出码 0`，进入 `HUMAN_GATE` |
| 开关开启 / 注入真实 TS 错误 | `passed: false`、退出码 1，任务进入 `RETRY_WAIT`，`lastErrorFeedback` 含真实 `error TS2322` 堆栈 |
| CLI 链路自检 | `real-spawn` 返回 201；按 `traceId` 重放得到 4 条事件（SPAWN + 3×AGENT_EVENT），`seq` 连续无重复 |
| 清理后 | `npm run lint` 退出码 0；`git diff --stat` 仅 `server.ts`，另新增 `src/runtime/` 4 文件 |

## OTel 追踪（S3-6 第一步，D-14）

- `src/runtime/tracing.ts`：真实 OTel SDK span + NDJSON 文件导出（`.superagent-traces.jsonl`），`SUPERAGENT_TRACING=1` 启用（默认关零行为差异）。
- span 产生点：`superagent.verify`（realRuntime.runRealVerification，真实退出码结果）与 `superagent.state_transition`；接 Langfuse/OTLP 时只换 `createNdjsonSpanExporter` 为 OTLP exporter。
- 边界：未注册 context manager，自动父子传播不可用（嵌套需显式 setSpan 传 context）；GenAI 语义属性（gen_ai.*）待接 Langfuse 时对齐。

## 已知债务 / deferred

- **真实模型 CLI 集成未验证**：`codex exec` 与 `claude -p --output-format stream-json` 的登录态、返回码、事件行结构未实测；验收用本地 `node -e` NDJSON 源做链路自检，不以模拟结果顶替真实调用。详见任务 `research/cli-probe.md`。
- 依赖缺陷已修复：`esbuild` 升到 `^0.28.0`、`npm install` 无需 `--legacy-peer-deps`；新增 `npm test`（37 用例）。原 `bun.lock` 实为 npm lock v2，已归位为 `package-lock.json`（v3）；项目 `.gitignore` 用 `!package-lock.json` 覆盖了全局忽略规则。
- 已修：状态改原子快照（临时文件 + rename）、`saveState()` 写失败 stderr 告警、默认 IM 密钥改 env 注入 + 503、`syncedToGit` 恒 false、`eventLog` seq 实时重算。仍为演示态：`worktreePath` 只是字符串、真实模型 CLI 登录态未实测。
- ~~`eventLog.ts` 的 `EVENT_FILE` 是基于 `process.cwd()` 的模块常量~~ **已修复**（S1-1 遗留缺口，2026-11-16）：`createEventLog({ path })` 工厂注入，`ServerContext.eventLog` 绑定 dataDir 下的 `.superagent-events.jsonl`（生产默认仍是 cwd，行为不变）；模块级默认单例 + 旧命名导出保留给无请求上下文的调用方（realRuntime / taskLifecycle），`loop.test.ts` 的 chdir 沙箱继续守卫这条兼容路径。多进程并发写仍需文件锁或换生产 adapter，单进程单写者前提不变。
- 未建 worktree：`real-spawn` 的 cwd 固定为仓库根，不是 `worktreePath` 字符串指向的目录。

## 常见错误

- 把 `SUPERAGENT_DEMO_MODE` 当成"关闭所有真实能力"的总开关——它只回退 `advance` 验证分支与受控端点，不影响已接入的原子持久化、RBAC、审计。
- 在真实路径里补齐 4 项检查以满足 UI 显示——`typecheck` / `cross_review` 无真实执行手段，硬编码等于伪造未执行的门禁。
- 把事件日志当状态源重放并再次 `saveState()`；它是旁路证据，重放只读。
- 直接调用 `real-spawn` 而未设 `SUPERAGENT_CLI_COMMAND`，期望它自动跑默认模型 CLI（会被 400 拒绝）。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`）。S1-6 起真实门禁由只跑 lint 一项扩为 lint + unit_test 两项，验证仍以这两条命令实跑、退出码 0 为准；`npm test` 较基线 18 个 `node:test` 用例有所增加（新增 `src/runtime/verifier.test.ts` 覆盖真实执行、非零退出、日志脱敏与兼容入口），全绿。
