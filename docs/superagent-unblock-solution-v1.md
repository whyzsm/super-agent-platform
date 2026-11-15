# SuperAgent 研发工具管理平台 · 消解四类阻塞方案 v1

> 状态：正式方案 / 仅设计与验收口径，不含实现代码
> 日期：2026-11-15
> **阅读顺序**：§2–§8 是设计态方案，§4 的「本地默认实现」列在本轮已全部落地；**最终事实以 §9 实施结果为准**。
> 依据：`docs/superagent-architecture-discussion-v1.md`（架构稿 §5 模块 M1–M21、§11 路线 P0–P4、§12 开放问题 Q1–Q13）、`docs/superagent-implementation-plan-v1.md`（计划 §5 WBS S0–S5、§5.6 模块覆盖矩阵、§6 决策登记）、`docs/s0-decision-brief.md`（上一轮拍板材料）、`src/protocol/index.ts` 与 `src/runtime/` 下已核实存在的真实模块
> 目标回溯：团队化协作、团队记忆云端化并共同成长、N 个 agent 分工、需求到研发完成的自动 loop；多 agent 执行，目标模式「完成所有的任务」
> 边界声明：本文件为本次唯一新建文件；不改任何既有 docs/spec/PRD/源码，不执行 git commit/add/push，无网络请求、无模型 CLI 调用

---

## 1. 结论先行

**破局逻辑一句话**：把「必须等外部服务 / 决策 / 授权才能开工」改写成「业务代码只依赖三个稳定端口（Ports & Adapters）+ 可撤销默认决策」，本地用默认实现跑通端到端闭环；Postgres / Temporal / OIDC 缺席不再是功能缺失，只是部署形态不同，Q1/Q4/Q5/Q11 未拍板也不再是不做的理由。

本轮交付分两层，避免把「方案」与「已落盘代码」混为一谈：

| 层 | 本轮交付 | 说明 |
| --- | --- | --- |
| 文档层（本文件） | 破局逻辑、三端口契约、ADR 默认决策登记（§3）、本地完整闭环（§5）、验收口径（§6）、外部动作清单（§7） | 只新建本文件，不改任何既有文件 |
| 实施层（并行） | 本地可跑的完整闭环、真实缺陷修复 | 按 §4 端口落点落到 S1 系列既有 WBS；以 §6 断言挂钩，不声称任何尚未跑出的数字 |

已核实存在、供闭环复用的真实能力（**非本轮新建**）：`src/protocol/index.ts`（11 态 `TaskState`、`AgentRunnerAdapter`、`DaemonCommand` / `DaemonEnvelope`、`MemoryStatus` draft/published/archived）、`src/engine/stateMachine.ts`（`VALID_TRANSITIONS` 11 态、`getReadyDagNodes`、`transitionTaskVerification`、`resolveGateDecision`、`detectDangerousCommand`、`redactSecrets`、`extractSkillDraft`）、`src/runtime/verifier.ts`（`npm run lint` + `npm test` 真实退出码判定）、`src/runtime/eventLog.ts`（append-only 旁路证据、seq/traceId 重放）、`src/runtime/realRuntime.ts`（`SUPERAGENT_REAL_RUNTIME` 开关编排）、`src/runtime/adapters/headlessJson.ts`（可注入 CLI）。真实缺陷修复指计划 §1.3 已登记的 D1–D5 债务，本方案不重复记功，只把它们与端口落点一并纳入 §6 断言。

**仍待用户执行的外部动作只有 3 项**（§7 给命令与副作用，均不自动执行）：① `git push`；② Q11 git 历史重写（force push + 轮换密钥）；③ 真实模型 CLI 探测（额度消耗）。本地闭环不依赖其中任何一项。

---

## 2. 四类阻塞逐项消解表

> 表中「既有」= 本仓库已核实存在的真实文件（非本轮新建）；「本文件」= 本方案对应章节；「约定落点」= 按计划既有 WBS 编号落地、不声称已落盘。

| 阻塞 | 原来的不做理由 | 消解方式 | 本轮落地的代码或文档 | 剩余的外部动作 |
| --- | --- | --- | --- | --- |
| ① 决策未拍板 | 计划 §6 把 Q1/Q4/Q5/Q11 定为硬门禁，「未拍板则 S1/S3 阻塞」；`docs/s0-decision-brief.md` §2 把 4 个决策列为卡点 | 改为**默认（可撤销）决策**：取架构稿 §12 已有倾向作默认实现写入 §3 ADR，业务代码依赖接口而非选项；用户改配置或换 adapter 即撤销。Q5 是安全红线，默认即终态，不可协商 | 本文件 §3；既有 `src/engine/stateMachine.ts`、`src/runtime/realRuntime.ts`、`src/protocol/index.ts` | 无（换另一选项按 §3「撤销方式」改 adapter／指定文件，属后续配置，非阻塞） |
| ② 外部基础设施缺失 | `docs/s0-decision-brief.md` §5 核实本机缺 psql/postgres/temporal/oidc-proxy，S1-2 / S1-4 / S3-1 因而「无法开工」 | **Ports & Adapters 三端口**（§4）：StateStore 本地默认 = 原子快照 + `eventLog.ts` append-only 日志；IdentityProvider 本地默认 = dev header 身份；CommandBus 本地默认 = `realRuntime.ts` + `stateMachine.ts` 幂等命令总线/状态机。生产换 Postgres / OIDC / Temporal adapter，业务代码只依赖接口，换实现不动流程 | 本文件 §4；既有 `src/runtime/eventLog.ts`、`src/runtime/realRuntime.ts`、`src/engine/stateMachine.ts`、`src/protocol/index.ts`（`AgentRunnerAdapter` 是既有「接口先行」范例）；生产 adapter 对应 S1-2 / S2-1 / S3-1 | 无（仅在部署生产形态时才需要这些服务，非本地闭环前置） |
| ③ push / 额度未授权 | `docs/s0-decision-brief.md` §4：D7 未 push、D6 真实 CLI 未实测，S1-7 端到端「无法闭环」 | 把两项从「功能前置」降为「外部动作」：本地闭环不依赖远端。`headlessJson.ts` 已支持 `SUPERAGENT_CLI_COMMAND` / `SUPERAGENT_CLI_ARGS` 注入任意 NDJSON 命令，用本地 NDJSON 源做链路自检；`verifier.ts` 按真实退出码判定、未执行项不伪造；push 只影响远端可见性 | 既有 `src/runtime/adapters/headlessJson.ts`、`src/runtime/verifier.ts`；本文件 §7 把两项列为外部动作并给命令／副作用 | `git push`（§7-1）、真实模型 CLI 探测（§7-3） |
| ④ Trellis 阶段门禁 | 计划 §8 / §12：planning → start → check → finish/archive，计划 §5 的 S0–S5 WBS 挂在阶段门禁后，流程状态未到 `start` 就不实施 | 阶段门禁是过程管理、不是功能前置：把「完成所有的任务」落到 §5 闭环 + §6 可执行断言，门禁随验收通过而满足；保留每阶段验收，但不再用它解释「不做」 | 本文件 §5 / §6；真实脚本 `npm run lint`（`tsc --noEmit`）、`npm test`（`node --import tsx --test "src/**/*.test.ts"`）来自 `package.json` | 无 |

---

## 3. ADR 默认决策表

> 全部为「默认（可撤销）」，**不等于用户已拍板**；最终登记仍由对应负责人按计划 §6 回写。Q5 为不可协商红线，不属可撤销项。

| 编号 | 默认选择（默认·可撤销） | 依据（架构稿章节） | 实现落点（真实文件路径） | 撤销方式（换另一选项改哪个文件） | 风险 |
| --- | --- | --- | --- | --- | --- |
| Q1 | 按 Q1-A 的 durable 抽象定义 `CommandBus` 接口；本地默认实现取架构稿允许的 B 过渡（幂等命令总线 + 状态机驱动），生产 adapter 兑现 A（Temporal） | §12 Q1（倾向 A，允许 B 过渡但须按 durable 抽象写）、§10 编排引擎行、计划 §6 Q1（S1-2 抽象定型 / S3-1 最终定型） | `src/runtime/realRuntime.ts`、`src/engine/stateMachine.ts`、`src/runtime/eventLog.ts`、`src/protocol/index.ts` | 换 §4 `CommandBus` 的 adapter 绑定即切到 Temporal，不动 `stateMachine.ts` 与流程；若整体换非 durable 抽象才需改 `src/protocol/index.ts` 契约 | 本地总线不提供跨机 durable history，长时人工等待须生产 adapter 才完整（崩溃续跑由 §6 断言覆盖） |
| Q4 | 凭证只留本机 + 短期注入 + 任务结束擦除 + 出网白名单（B + 短期注入） | §12 Q4（倾向 B）、§9 凭证行、计划 §6 Q4（S1-4 硬门禁）、`docs/s0-decision-brief.md` §2 | `src/runtime/adapters/headlessJson.ts`（`spawn` 的 `env` 注入点）、`src/protocol/index.ts`（`AgentRunnerAdapter.spawn` 的 `env` 参数）、`src/engine/stateMachine.ts`（`detectDangerousCommand` / `redactSecrets`） | 换成「控制面托管凭证」（Q4-A）需改 §4 IdentityProvider／凭据绑定与 `headlessJson.ts` 的 env 构造 | 本地 dev 身份下「短期注入」无 KMS 支撑，生产须换 M15（S1-4）adapter；模型侧应达到只见占位符 |
| Q5 | **不可协商红线**：处方只提 MR + 人审 + 护栏 + 灰度 + 一键回滚；禁止删门禁 / 放宽预算 / 自签名，**禁止自动改写已发布 SOP** | §12 Q5（必须 B）、§7.3 F3 护栏、计划 §6 Q5（红线不可协商，S4-3）、§10 风险登记 | `src/engine/stateMachine.ts`（`extractSkillDraft` 只产出 `draft` 状态；`resolveGateDecision` 的 `MERGE_GATE` 人审）、`src/protocol/index.ts`（`MemoryStatus` draft/published/archived 隔离、`TaskCheckpoint`） | **不可通过配置撤销**；放开自动生效须改上述两文件并重走安全评审，本方案不提供该选项 | 无自动生效路径即无失控面；处方链路 S4-1/2/3 按计划归 S4，本地闭环只到「草案 + 人审门禁」 |
| Q11 | 默认只做「当前版本已清理」：移出版本控制 + `.gitignore` + state 脱敏 + 默认 IM secret 改 env 注入；**git 历史重写属破坏性外部动作，仅给命令不执行**（§7-2） | §12 Q11、计划 §1.3 D3 / §5.0 S0-3、`docs/s0-decision-brief.md` §3 | `.superagent-state.json`（已脱敏）、`src/engine/stateMachine.ts`（`redactSecrets` 6 类）、`src/gateway/imWebhook.ts`（HMAC + 300s 防重放、密钥外置） | 升级为「连同历史一起清理」见 §7-2，需 force push + 轮换密钥，本方案只给命令与后果 | 历史中的内部 hostname / 模拟密钥串仍可被检出，合规残留；以 §6 脱敏扫描断言判定当前版本 |
| Q9 | P0 先单仓 + 写集声明 / 合并顺序编排 / 冲突回灌，跨仓放 S5-4 | §12 Q9、计划 §6 Q9（S1-3 先确认单仓） | `src/protocol/index.ts`（`DagNode.worktreePath` / `worktreeBranch`）、`src/engine/stateMachine.ts`（`getReadyDagNodes` 依赖解锁） | 提前承诺多仓并行需改 S1-3 / S5-4 的写集冲突编排 | 单仓边界下本地闭环不覆盖跨仓写集冲突 |
| Q12 | 补 3 态（`BLOCKED_BY_RESOURCE` / `QUARANTINED` / `WAITING_APPROVAL`），保持 `canTransition` 纯函数可测 | §12 Q12、计划 §6 Q12 / §1.3 D5（S0-4） | `src/protocol/index.ts`（`TaskState` 已含 11 态）、`src/engine/stateMachine.ts`（`VALID_TRANSITIONS` 11 态）、`src/utils/statusStyles.ts` | 回退 3 态需同步改上述三文件与 `src/engine/stateMachine.test.ts` | 新状态的生产者逻辑按计划 §1.3 D5 仍待 S1/S3 接入，本地闭环只用其中已有流转 |

---

## 4. 三个端口与替换点表

| 接口名 | 本地默认实现文件（落点） | 生产 adapter 候选 | 替换时业务代码是否要改 | 验收口径（应达到） |
| --- | --- | --- | --- | --- |
| `StateStore` | `src/store/fileStateStore.ts`：原子快照（tmp + rename）+ `.superagent-commands.jsonl` append-only 命令日志；`src/runtime/eventLog.ts` 为旁路轨迹——**本轮已落地** | Postgres（计划 S1-2「Postgres + append-only event log」，沿用 `eventLog.ts` 格式） | **否** | 崩溃重启后状态与事件一致；幂等重放不二次写状态（§6） |
| `IdentityProvider` | `src/identity/localProvider.ts`（dev header）+ `rbac.ts` 权限矩阵 + `audit.ts` 不可变审计；`src/gateway/imWebhook.ts` 的 HMAC-SHA256 + 300s 防重放保持——**本轮已落地** | OIDC/SSO（计划 S2-1；架构稿 §10「身份」行） | **否** | 跨 team/project 越权被拒；缺身份／伪造签名／超 300s 请求被拒（§6） |
| `Orchestrator / CommandBus` | `src/loop/commandBus.ts` 幂等命令总线 + `src/loop/taskLifecycle.ts`（`canTransition` 裁决的 3 态生产者 + Q5 人审处方）+ `src/engine/stateMachine.ts` 纯函数 + `src/runtime/realRuntime.ts`——**本轮已落地** | Temporal（计划 S3-1、架构稿 §10 编排引擎 Q1-A） | **否** | 幂等重放不二次写状态；`HUMAN_GATE` / `WAITING_APPROVAL` 长时等待不丢状态；崩溃后从最后 checkpoint 续跑（§6） |

> - `src/protocol/index.ts` 的 `AgentRunnerAdapter` 是本仓库既有「接口先行、实现可替换」的范例（`src/runtime/adapters/headlessJson.ts` 已实现之）；本方案把同一模式推广到上述三端口。
> - 三个端口名为本方案新引入的接口名（现有文档与源码未出现，已核实）；「既有」指真实文件，「约定落点」按计划既有 WBS 落地、不声称已落盘。生产 adapter 落点对应 S1-1（拆分 `server.ts`）、S1-2（Postgres + event log）、S1-4（凭据网关）、S2-1（SSO/OIDC）、S3-1（durable Orchestrator）。
> - 结论：**Postgres / Temporal / OIDC 缺席不再是功能缺失，只是部署形态不同**；业务代码只依赖接口，换实现不动流程。

---

## 5. 本地完整闭环（需求 → 复盘处方）

> 「现有」= 已核实存在的真实模块；「规划」= 按计划既有 WBS 归位、本方案只纳入验收挂钩、不声称已实现。

| 步 | 阶段 | 负责模块（现有／规划） | 真实落点 | 如何验证 |
| --- | --- | --- | --- | --- |
| 1 | 需求进入 | M2/M3（规划：S3-9） | `src/protocol/index.ts` 的 `Requirement`（id / teamId / title / specMd / repoUrl / baseBranch / sourceChannel / status / createdBy）；现状 `/api/requirements` 只收标题 + specMd（计划 §5.6 M3） | 字段完整、`sourceChannel` 合法；需求是活文档引用 |
| 2 | 规格 | M3（规划：S3-9） | `Requirement.specMd` 作规格工件最小载体；`SopTemplateId` = `feature_flow` / `bugfix_flow`（`src/protocol/index.ts`）；Spec Kit 式 `constitution→spec→plan→tasks` 按 S3-9 补齐 | specMd 非空、sopTemplate 合法 |
| 3 | DAG 分工 | M5/M7（规划：S3-2 / S3-4） | `src/engine/stateMachine.ts` 的 `getReadyDagNodes()`（依赖全部 MERGED 才解锁，真实代码）；`DagNode` 的 `dependsOn` / `role` / `provider` / `adapterMode`（`src/protocol/index.ts`） | 未满足依赖的节点不被解锁；planner/builder/reviewer 分工明确 |
| 4 | 真实 CLI 执行（可注入） | M12（现有） | `src/runtime/adapters/headlessJson.ts` 的 `createHeadlessJsonAdapter`（实现 `AgentRunnerAdapter`）；`SUPERAGENT_CLI_COMMAND` / `SUPERAGENT_CLI_ARGS` 注入任意 NDJSON 命令；stdout 每行经 `parseCliNdjsonLine()` 脱敏与危险拦截；**真实运行时默认启用**，`SUPERAGENT_DEMO_MODE=1` 回退演示态 | 注入本地 NDJSON 源跑通链路；危险命令被 `detectDangerousCommand` 4 条规则拦截；`real-spawn` 返回 201、事件 seq 连续 |
| 5 | 真实确定性验证 | M8（现有：S1-6） | `src/runtime/verifier.ts` 的 `runRealVerifier`（只跑 `npm run lint` + `npm test`，按 `exit=0` 判定；typecheck / cross_review 不产出 `VerifierCheck`、不伪造）；`src/runtime/realRuntime.ts` 的 `runRealVerification` 交回 `transitionTaskVerification` 并 append `VERIFY_RESULT` | 任一非零退出 → `passed:false` + 真实日志回灌 `lastErrorFeedback` → `RETRY_WAIT` |
| 6 | 人工门禁 | M4/M9（现有纯函数基础） | `src/engine/stateMachine.ts` 的 `transitionTaskVerification`（通过 → `HUMAN_GATE` + `TaskCheckpoint WAITING`）、`resolveGateDecision`（`MERGE_GATE` 人审才 `MERGED`）；`GateType` PLAN/DANGER/MERGE；`src/gateway/imWebhook.ts` HMAC + 300s 防重放 | 无 `reviewerId` 的批准被拒；未签收不得进入 MERGED（门禁误放行率应达到 0） |
| 7 | 合并 | M6/M14（规划：S3-1 / S1-3） | `resolveGateDecision` 的 `MERGE_GATE` 批准分支进入 `MERGED`；`getReadyDagNodes` 解锁下游；`src/runtime/eventLog.ts` 经 `recordStateTransition` 记录 `STATE_TRANSITION` | `VALID_TRANSITIONS.MERGED` 为空数组（终态）；状态迁移事件 seq 连续、可按 traceId 重放 |
| 8 | 复盘处方 | M10（规划：S4-1/2/3） | `src/engine/stateMachine.ts` 的 `extractSkillDraft`（仅 `hadFailureOrCorrection || retryCount>0` 时产出 `status` 为 `draft` 的 `MemoryAsset`）；Q5 红线：草案只进人审 MR | 产出物 `status` 恒为 `draft`；`MemoryStatus` 三级隔离；无自动 published 路径 |

> 整条闭环不依赖远端 push、不依赖真实模型额度（第 4 步用可注入 CLI + 本地 NDJSON 源自检）；每步结论可下钻到原始退出码 / 事件 seq（架构稿 §6 真相链）。

---

## 6. 质量口径

「功能可用 / 逻辑自洽 / 无 bug」= 下列可执行断言全部**应达到**通过，且不得伪造未执行项。本方案未运行任何命令、不引用未跑出的用例数。

| 命令 / 检查 | 断言（应达到） | 质量属性 |
| --- | --- | --- |
| `npm run lint`（`tsc --noEmit`） | 退出码 0、无类型错误 | 逻辑自洽 |
| `npm test`（`node --import tsx --test "src/**/*.test.ts"`） | 全绿，用例数随本轮新增用例同步增长且无跳过、无伪造通过 | 逻辑自洽 / 无 bug |
| 默认真实态／演示态回退对比 | 默认 `RUNNING→VERIFYING` 用 `lint` + `unit_test` 真实退出码、失败回灌真实 `error TS2322`；`SUPERAGENT_DEMO_MODE=1` 才回到 4 项硬编码全绿 | 功能可用 |
| 崩溃恢复 | 进程重启后 `replayRuntimeEvents(traceId)` 按 seq 还原事件、`lastEventSeq()` 连续 | 逻辑自洽 |
| 越权被拒 | dev header 缺身份或越 team/project 读写被拒；`imWebhook.ts` 验签失败或超 300s 被拒 | 功能可用 |
| 幂等重放不二次写状态 | `eventLog.ts` 重放只作旁路证据、`recordStateTransition` 不二次迁移；同一 `idempotency_key`（架构稿 §9：`run_id + node_id + attempt`）重复投递不产生第二条状态变更 | 无 bug |
| 脱敏扫描 | `redactSecrets`（6 类）对日志／轨迹／Diff 扫描；命中数 >0 时明文密钥 / hostname / 邮箱不出现在工作树 state 与事件日志 | 功能可用 / Q11 当前版本 |
| `.trellis/spec/` 0 断链 | index 与文件集 1:1、无占位与待补标记、链接可达（计划 §8 规范同步） | 逻辑自洽 |
| 未执行项不伪造 | `verifier.ts` 只产出真实执行的 `lint` / `unit_test`，typecheck / cross_review 不产出 `VerifierCheck`、不伪造 passed | 无 bug |

---

## 7. 仍待用户执行的外部动作（给确切命令与副作用）

> 以下 3 项**明确不自动执行**；本方案无网络请求、无 push、无 force push、无真实模型 CLI 调用。

| 动作 | 确切命令 | 副作用 | 授权与边界 |
| --- | --- | --- | --- |
| ① `git push`（外部动作） | 先 `git rev-list --left-right --count origin/main...HEAD` 查本地领先提交数（右列为本地领先，数量随实施推进变化，以命令输出为准），再 `git push origin main`（快进） | 远端 `origin/main` 从 `8eae911` 前进，协作者可见并基于新基线工作 | 仅推现有本地提交；不含 force push、不含重写历史、不含调整分支保护；本地闭环不依赖该项；不与 ② 合并授权 |
| ② Q11 git 历史重写（破坏性） | `git filter-repo --path .superagent-state.json --invert-paths` 类命令（需自备 git-filter-repo，本方案不假设本机已安装），随后 `git push --force` / `--force-with-lease` | ① 历史重写不可逆，旧 commit 引用失效；② 影响所有协作者，需重新 clone／变基，基于旧历史的本地分支失配；③ `origin/main` 若有分支保护，force push 可能被拒或需临时调整；④ **必须轮换可能已泄露的密钥**（`IM_WEBHOOK_SECRET` 及历史中模拟密钥串，含引用它们的配置与 IM 回调验签配置）；⑤ `src/engine/stateMachine.ts` 的 `NO_FORCE_PUSH` 规则会把 `git push --force` 判为高危拦截 | **只给命令与后果，不自动执行**；按 `docs/s0-decision-brief.md` §3 与 ① 是两件事、单独授权；当前版本已清理，历史 blob 仍在 `8eae911` 起的历史里 |
| ③ 真实模型 CLI 探测（额度消耗） | 按计划 §5.0 S0-5 一次只读任务（`codex exec` 或 `claude -p --output-format stream-json`），记录真实 NDJSON 事件行与返回码 | 产生额度消耗、需确认账号登录态；不接入生产链路、不触发写操作 | **不执行**；拒绝时按 `docs/s0-decision-brief.md` §4 记 D6 为 deferred，链路自检继续用本地 NDJSON 源，不得把未实测结果记为通过 |

---

## 8. 边界

- **不替用户做最终产品／安全拍板**：§3 全部为「默认（可撤销）」，Q5 为不可协商红线（安全下限，非产品选项）；最终登记由对应负责人按计划 §6 回写。
- **不自动执行破坏性或外部动作**：§7 三项仅给命令与副作用，`git push` / force push / 真实模型 CLI 均不执行。
- **不虚构已部署服务**：本机经 `docs/s0-decision-brief.md` §5 核实缺 psql/postgres/temporal/oidc-proxy；生产 adapter 仅为候选，不声称 Postgres / Temporal / OIDC 已部署。
- **不含日历工期与人力预算**（沿用计划 §11「以依赖顺序 + 验收口径驱动」）。
- **本文件为唯一新建文件**：不改任何既有 docs / spec / PRD / 源码，不执行 git commit / add / push，无网络请求、无模型 CLI 调用。
- **不含实现代码**：仅给真实文件路径、接口名与命令；不含占位符与待补标记。


---

## 9. 实施结果（本轮落地，覆盖前文规划口径）

### 9.1 代码交付

| 模块 | 真实路径 | 解决的问题 |
| --- | --- | --- |
| 原子状态存储 | `src/store/{types,fileStateStore,fileStateStore.test}.ts` | 崩溃写一半损坏快照、`saveState()` 静默吞失败、损坏文件被静默覆写 |
| 身份 / RBAC / 审计 | `src/identity/{types,localProvider,rbac,audit,identity.test}.ts` | 无 OIDC 时的团队化协作底座；跨 team 越权、审计不可变 |
| 幂等命令总线 / 3 态生产者 | `src/loop/{commandBus,taskLifecycle,loop.test}.ts` | 无 Temporal 时的 durable loop 底座；新增 3 态只有类型没有生产者 |
| 运行时缺陷加固 | `src/runtime/eventLog.ts`、`src/runtime/adapters/headlessJson.ts`、`src/daemon/ndjsonParser.ts` 及对应测试 | seq 陈旧冲突、追加非原子、单 listener 覆盖、跨 spawn seq 不重置、非法 JSON 绕过 Danger Gate、stderr 不脱敏 |
| 服务端接入 | `server.ts` | 三端口中间件、`commandId` 幂等、`resource-transition` / `retrospective` / `runtime/audit` / `runtime/commands` 四个新端点 |
| 自洽修正 | `src/protocol/index.ts`、`src/data/seed.ts`、`src/runtime/realRuntime.ts` | `syncedToGit` 假状态改为恒 false；默认从演示态造假改为真实态优先 |

### 9.2 实测验收（全部实跑，非预期值）

| 断言 | 结果 |
| --- | --- |
| `npm run lint` / `npm test` / `pre-merge-gate.sh` | 退出码 0 / **99 用例全绿** / 退出码 0 |
| 默认态 `advance` | `HUMAN_GATE`，`verifierChecks` 恰为 `lint + unit_test` 两项真实结果 |
| `SUPERAGENT_DEMO_MODE=1` | `HUMAN_GATE`，回到 4 项硬编码全绿（响应形状不变） |
| 注入真实 TS 错误 | `lint:false / unit_test:true` → `RETRY_WAIT`，`lastErrorFeedback` 开头即 `error TS2322` |
| RBAC 越权 | viewer 创建需求 → **403** + `Forbidden: ... 无权执行 requirement:create`；审计留 `denied` 行 |
| 幂等命令 | 同一 `commandId` 第二次 → **409**，`/api/runtime/commands` 仅 1 条 |
| 3 态链 | `HUMAN_GATE→WAITING_APPROVAL→MERGED`、`PENDING→BLOCKED_BY_RESOURCE→RUNNING`、`HUMAN_GATE→QUARANTINED` 均 200；`MERGED→BLOCKED_BY_RESOURCE` → 400 且零副作用 |
| 复盘红线 | 失败任务产出草案，`requiresHumanReview:true`，端点不写任何文件；成功任务无草案 |
| CLI 链路 | `real-spawn` → **201**，事件 3 条 seq 连续；仍用本地 NDJSON 源，未发起模型调用 |
| 崩溃恢复 | 损坏 state 被隔离为 `.corrupt-<ts>`、服务正常启动、重启后 state 为合法 JSON |
| IM 守卫 | 无 secret → 503；配置 secret → 200 + card + signedCallback |
| 文档一致性 | spec 0 断链、无 placeholder；`syncedToGit` 全库不再声称 true |

### 9.3 仍待用户执行的外部动作（不自动执行）

| 动作 | 确切命令 / 前置 | 副作用 |
| --- | --- | --- |
| `git push` | `git push origin main`；先用 `git rev-list --left-right --count origin/main...HEAD` 看领先数 | 外部动作，改变远端 |
| Q11 历史重写 | 需 `git filter-repo` 类工具 + force push + 可能泄露密钥轮换 | **不可逆**，影响所有协作者与远端分支保护 |
| 真实模型 CLI | 确认账号后设置 `SUPERAGENT_CLI_COMMAND=codex` / `claude` 并跑一次只读任务 | 额度消耗、登录态 |

### 9.4 明确边界

- 默认决策（Q1 取 B 过渡、Q4 凭证留本机、Q5 红线、Q11 只清当前版本）**可撤销**：换 §4 的 adapter 绑定或改配置即可，不等于替用户做最终拍板。
- 三个本地实现均以**单进程单写者**为前提；多 worker 并发写同一日志需文件锁或换生产 adapter，已写入 `.trellis/spec/backend/platform-ports.md` 的「常见错误」。
- 第 9.5 节落地后，`worktreePath` 与 MCP 两项已不再是 deferred：前者由 `git worktree` 真实落盘，后者是标准 JSON-RPC 2.0 端点。
- **仍保持 deferred 的只有**：真实模型登录态与 stream-json 事件结构（未实测，需额度与账号，见 §7-3）、Postgres / Temporal / OIDC 生产 adapter（本机无服务）。

### 9.5 第二轮增量（运行态驱动，逐项实测）

> 执行方式：先 `npm run dev` 把服务跑起来，再用真实 HTTP 冒烟（`node scripts/e2e-smoke.mjs`）驱动，
> 缺陷全部来自运行态观察而非纸面推演。

| # | 缺陷 / 缺口 | 真实根因 | 修复落点 | 验收证据 |
| --- | --- | --- | --- | --- |
| 1 | `.env` 完全不生效 | `dotenv` 装了依赖但 `server.ts` 从未 import，`IM_WEBHOOK_SECRET` 只能靠命令行注入 | `server.ts` 首行 `import 'dotenv/config'`（ESM 提升保证先于模块顶层 `process.env` 读取） | 写 `.env` 后不传命令行变量，IM 卡片端点由 503 → **200**；启动不再打印未配置警告 |
| 2 | RBAC 语义错位 | `actionFor` 对未登记路由**默认返回 `task:advance`**，导致 `/api/mcp/recall`（只读）要求写权限、`/api/memories/:id/reject` 落错权限域、`/api/reset` 任意 developer 可调 | 改为显式 `ROUTE_ACTIONS` 表；写方法未登记 → **fail-closed 403** + 审计 `denied`；新增 `admin:reset`（admin 独占） | 冒烟 6 项：viewer 可调 recall/retrospective、developer 调 reset **403**、reviewer 可 reject |
| 3 | 「物理隔离」只是字符串 | `worktreePath` 从未真正建目录，UI 可点进去不存在的路径 | 新增 `src/workspace/worktreeManager.ts`：`git worktree add/remove`、`spawnSync` 无 shell、路径与 ref 白名单、幂等、失败清空目录、`info/exclude` 自动排除 | 12 个单测（真实 `git init`）+ 9 项 HTTP 断言；实测 `task-2041-review` 落盘 `.worktrees/task-2041-review`，主仓 `git status` 无非预期条目 |
| 4 | MCP 名不副实 | `/api/mcp/recall` 只是普通 HTTP POST，无握手/无 tool 契约 | 新增 `src/mcp/server.ts`（`initialize` / `tools/list` / `tools/call` / `ping` / 批量 / 通知）+ `scripts/mcp-stdio.mjs` 串行桥 | 21 个单测 + 8 项 HTTP 断言 + stdio 实跑（3 行请求 → 3 行响应，通知无回包） |
| 5 | 中文记忆召不回 | 召回用 Jaccard trigram 相似度，查询短、语料长时分母被语料主导，「对账单 幂等」明明在标题里却 score≈0.008 < 阈值 0.02 | 新增 `computeQueryCoverage()`（查询侧覆盖率）用于召回；`0.6 全文 + 0.4 标题` 加权；Jaccard 保留给去重（对称比较） | 「对账单 幂等」**0 → 1 条**（score 0.25），「Webhook 签名」score 1，无关查询仍 0，draft 仍不返回 |
| 6 | `reset` 覆写人工维护的团队资产 | seed 里 TeamAI 资产写的是 **pnpm** 命令（`pnpm lint` / `pnpm typecheck` / `pnpm test --run`），而本仓库是 npm 且无 `typecheck` 脚本；`syncTeamAiFileToDisk` 无条件覆写 | seed 改 npm 真实命令；`syncTeamAiFileToDisk(overwrite=false)`：`reset` 只补建缺失文件、不覆写仓库资产 | 改前 `git diff .teamai/` 出现 pnpm 命令（hook 必失败）；改后 `reset` 前后 md5 一致 |
| 7 | 状态机拒绝时客户端只能猜 | `resource-transition` 400 只回 `{error, task}`，缺 `from`/`to` | 400 响应补 `from` / `to`（kind 非法时 `to:null`） | 冒烟断言 `HUMAN_GATE->BLOCKED_BY_RESOURCE` 被拒且响应带 `from/to` |
| 8 | 小屏下检验舱不可达 | `DagCanvas` 为 `flex-1` 撑满剩余高度，把 `NodeInspectorPane` 挤出可视区且容器滚不到 | `DagCanvas` 加 `max-h-[65vh] lg:max-h-none`（仅窄屏生效） | UI 工作树按钮已接线并打入产物（类型检查 + 构建通过） |
| 9 | 验收不可复现 | 前轮验收是一次性 curl，无法回归 | 新增 `scripts/e2e-smoke.mjs`（54 项真实 HTTP 断言，含 reset 复位） | `node scripts/e2e-smoke.mjs` → **54/54 通过** |
| 10 | Vite 8 配置告警 | `vite.config.ts` 用 `__dirname`，native config loader 不支持 | 改 `import.meta.dirname` | 构建告警消失 |

**本轮实测汇总**：`npm run lint` 退出码 0；`npm test` **136 用例全绿**；`npm run build` 通过（493.78 kB / gzip 149.77 kB）；`node scripts/e2e-smoke.mjs` **54/54**；服务在 `http://localhost:3000` 实测渲染正常。

**新增规范**：`.trellis/spec/backend/workspace-worktree.md`、`.trellis/spec/backend/mcp-server.md`；`backend/index.md` 的实现状态与验证命令已同步（不再声称 worktree 是字符串、MCP 是普通 POST、测试 14 例）。

**仍未做的**（明确记账，不算完成）：S1-1 拆分 1845 行 `server.ts`（纯结构调整，无用户可见收益，风险集中在无直接单测覆盖的路由层，本轮不做）；Postgres / OIDC / Temporal 生产 adapter；真实模型 CLI 实测；`git push` 与 Q11 历史重写属外部动作，仍需授权。
