# 决策基线日志（Decision Log）

> 依据本目标约定：每完成一个章节自动提交并 push；遇到需拍板的问题按最优理解决策，**决策与理由必须记录于此**。
> 本文档是 handoff §8C「需要你拍板」事项在本目标授权下的代决登记处；条目按日期编号，只增不改（错误决策用新条目 supersede）。

---

## D-2026-11-16-01 push 凭据通道（覆盖 handoff §8C「git push 未授权不做」）

- 背景：目标明确授权每章节 push。仓库 origin 为 HTTPS（`https://github.com/whyzsm/super-agent-platform.git`），非交互环境无 HTTPS 凭据（osxkeychain 不可用、无 gh CLI）；本机存在已通过 GitHub 认证的 SSH key（whyzsm）。
- 决策：不修改 remote 配置，按 `git push git@github.com:whyzsm/super-agent-platform.git main:main` 显式 SSH URL 推送。
- 理由：最小侵入——不动用户 git 配置，效果与改 remote 等同；SSH 通道已验证可用。
- 影响：后续每章节推送沿用此命令。首次推送已验证成功（`f643ca8..8e49eba`）。

## D-2026-11-16-02 S2-9 策略引擎落点与形态

- 背景：策略规则散落三处——`src/engine/stateMachine.ts` 的 `detectDangerousCommand`（4 条危险命令规则）与 `redactSecrets`（6 条脱敏正则）、`src/server/middleware.ts` 的 `ROUTE_ACTIONS`（24 条路由动作表）；另有 `src/workspace/worktreeManager.ts` 的 taskId/baseRef 白名单正则（PRD 所述「路径白名单」）。
- 决策：
  1. 新建 `src/policy/`：`rules.ts`（纯声明式规则数据：危险命令规则、脱敏规则、taskId/baseRef 白名单 pattern）、`engine.ts`（对规则集求值的纯函数）、`routeActions.ts`（路由→动作表 + `actionFor`）、`policy.test.ts`（逐规则正/反例 + 不变量）。
  2. **行为零变更**：规则内容、命中顺序（首条命中即返回）、脱敏的 $1/$2 捕获组保留、`{dangerous, rule, reason}` 判定形状全部原样保留；规则代号（如 `NO_ROOT_DELETE`）是对外契约，出现在拦截事件与 UI 文案，不改名（内部字段统一叫 `code`，出口仍映射为 `rule`）。
  3. 消费方 import 一律改指 `src/policy`，**不留 stateMachine 的 re-export shim**——收敛就要收干净，双导入路径会复活散落问题。
  4. worktreeManager 的 `TASK_ID_RE`/`BASE_REF_RE` 迁至 `policy/rules.ts` 作为唯一来源（白名单即策略）。
- 理由：规则数据与求值逻辑分离后，新增/审查策略只看一处；逐规则单测让「改一条规则漏一个场景」在测试层暴露；PRD 的「工具 grants 交集」无真实 ACP 工具调用方可落地，本轮不做（诚实标注，不伪造）。
- 影响：`stateMachine.ts` 回归纯状态机职责；`middleware.ts` 不再内嵌动作表；测试总数增加。

## D-2026-11-16-04 两个已知保守误报：保持现状，不放松拦截面

- 背景：S2-9 收敛过程中逐规则测试暴露两处**收敛前就存在**的保守误报：
  1. `NO_FORCE_PUSH` 的 `(\-\-force|-f)\b` 会命中 `git push --force-with-lease`（`--force` 后的 `-` 构成词边界）；
  2. `SENSITIVE_PATH_GUARD` 的 `.env\b` 会命中 `.env.example`（`v`→`.` 构成词边界）。
- 决策：本轮保持行为不变（S2-9 是结构收敛，不夹带策略变更）；两处误报已固化为 policy.test.ts 的显式用例。若未来要放行 `--force-with-lease` 或 `.env.example`，作为独立策略变更提交并同步决策日志。
- 理由：二者后果只是多一次人工 Danger Gate 审批（偏安全方向），放松拦截面才是风险方向；且 `.env.example` 访问在真实 CLI 会话中也常伴随读真实 `.env` 的试探。
- 附带怪癖：`[REDACTED_DB_PASS]` 占位符会被 DB 规则在口令位二次匹配，但替换恒等、输出稳定（幂等性用例已固化）。

## D-2026-11-16-05 S3-2 前半：SOP/DAG 模板注册表

- 背景：`feature_flow`（4 节点）/ `bugfix_flow`（3 节点）两套 DAG 拓扑硬编码在需求创建路由里（约 250 行字面量），新增模板 = 复制粘贴。
- 决策：抽 `src/dag/templates.ts` 注册表——模板 = 元数据 + 纯函数 `build(ctx) => DagNode[]`；节点字面量**逐字保留**（行为零变更），闭包变量（reqId/newReq/provider/nowIso/timeStr/++seq）换成本入参 `DagTemplateContext`；`normalizeSopTemplateId` 保留历史兜底（非 `'bugfix_flow'` 一律 feature_flow）。路由只留校验与装配。
- 理由：S1-1 时已明确此项独立于拆分；现在注册表 + 9 个结构/拓扑/兜底用例让「新增模板」变成登记 + 测试，而不是再复制一段字面量。
- 边界（后半未做，诚实标注）：模板版本化与子 SOP 组合复用未实现；`deriveRetrospective`/solidify-sop 与注册表的双向衔接属 S3-2 后半。

## D-2026-11-16-06 Q8 门禁三挡放行落地为配置

- 背景：v1 所有人工门禁都是「每次确认」，注意力成本高（handoff §8A 中优先级「中」）。Q8 完整方案是「三挡权限 + 审查模型代批」，其中代批模型有硬约束（无工具、无凭证、与其他成员发言隔离），当前没有真实审查模型可接。
- 决策：
  1. 新增 `src/policy/gateTiers.ts`：`always_confirm`（默认，历史行为）/ `auto_approve_when_green`（确定性规则放行，不涉模型）/ `delegate_to_reviewer`（目标挡；当前**诚实降级**为人工，评估结果写明「代批模型未接入」，不伪造代批结论）。
  2. `auto_approve_when_green` 的放行条件全部确定性可审计：仅 MERGE_GATE（可配置放宽）、verifier 全绿且非空（无真实执行项不放行）、目标分支不在保护名单（默认 main）；**DANGER_GATE 永不自动放行**（红线，测试锁定）。
  3. 配置源：`SUPERAGENT_GATE_TIER` 环境变量（`.env.example` 已登记），非法值 fail-safe 到最严挡并告警；测试可经 `createServerContext({ gateTier })` 注入。
  4. 自动放行复用 gate 审批同一代码路径（`resolveGateDecision` + PLAN 特例 + 下游解锁 + 技能萃取），reviewerId 记为 `gate-policy:<tier>`，事件 / terminalLines / 不可变审计三处留痕。
- 理由：三挡中只有确定性放行挡可真实落地；「配置了代批但悄悄当全绿放行」是最危险的伪造形态，宁可降级并在审计里说明。
- 影响：`advance` 落入 HUMAN_GATE 后多一次策略评估（默认挡立即返回，零行为变化）；S3-5 的「三挡放行」要素就此闭环，任务标记完成。

## D-2026-11-16-07 S2-5 propose_memory 的写入侧权限模型

- 背景：MCP 已有 3 个只读工具；handoff §10.3 建议加 `propose_memory` 验证写入侧权限。难点：`POST /api/mcp` 在 ROUTE_ACTIONS 登记为 `read`（协议入口按只读放行，viewer 也能握手），写动作如何在工具层收紧？
- 决策：
  1. 新增 Action `memory:propose`（developer / reviewer / admin 并列分支可用，viewer 与匿名不可）；rbac.ts 权威矩阵与 identity 穷举测试同步。
  2. 权限校验放在**工具层**（`src/mcp/server.ts` callTool）：McpContext 新增每请求 `principal`（`res.locals.principal` 注入，缺省匿名 viewer）；拒绝以 `isError` 工具结果表达（语义是「工具拒绝执行」，不是协议错误 -32603），放行才走 `proposeMemory` 落地。
  3. Q5 红线不破：`propose_memory` **只产出 status=draft**，duplicateScore 入库时计算；发布仍唯一走 `POST /api/memories/:id/approve`（memory:approve 人审）；draft 绝不进召回（召回过滤已有，测试再锁一遍）。
  4. 写侧动作补审计：落地实现里单独记 `memory:propose / applied` 审计行——MCP 入口按只读登记的审计不足以覆盖真实写入。
  5. 顺手修了校验器真实缺口：`validateAgainstSchema` 此前不支持 `enum`/`maxLength`（schema 里声明了却不生效），已补并加用例。
- 理由：协议入口保持只读登记，可让任何 MCP 客户端完成握手与只读查询；写权限按工具粒度收紧到 RBAC 矩阵，权限模型仍只有一份（rbac.ts）。拒绝不升级为协议错误，客户端能看到可读的权限提示。
- 影响：MCP 工具 3→4；冒烟 54→57 项；单测 247→254。

## D-2026-11-16-07 S2-5 propose_memory 的写入侧权限模型

- 背景：MCP 已有 3 个只读工具；handoff §10.3 建议加 `propose_memory` 验证写入侧权限。难点：`POST /api/mcp` 在 ROUTE_ACTIONS 登记为 `read`（协议入口按只读放行，viewer 也能握手），写动作如何在工具层收紧？
- 决策：
  1. 新增 Action `memory:propose`（developer / reviewer / admin 可用，viewer 与匿名不可）；rbac.ts 权威矩阵与 identity 穷举测试同步。
  2. 权限校验放在**工具层**（`src/mcp/server.ts` callTool）：McpContext 每请求注入 `principal`（`res.locals.principal`，缺省匿名 viewer）；拒绝以 `isError` 工具结果表达（工具拒绝执行，非协议错误），放行才走 `proposeMemory` 落地。
  3. Q5 红线不破：`propose_memory` **只产出 status=draft**，duplicateScore 入库时计算；发布仍唯一走 `POST /api/memories/:id/approve`（memory:approve 人审）；draft 绝不进召回。
  4. 写侧动作补审计：落地实现里单独记 `memory:propose / applied` 审计行——MCP 入口按只读登记的审计不足以覆盖真实写入。
  5. 顺手修了校验器真实缺口：`validateAgainstSchema` 此前不支持 `enum`/`maxLength`（schema 声明了却不生效），已补并加用例。
- 理由：协议入口保持只读登记，任何 MCP 客户端都能握手与只读查询；写权限按工具粒度收紧到唯一权限矩阵（rbac.ts）。拒绝不升级为协议错误，客户端能看到可读的权限提示。
- 影响：MCP 工具 3→4；冒烟 54→57 项；单测 247→254。

## D-2026-11-16-08 前端「需介入」集合与后端对齐

- 背景：handoff §8A 低优先级项「前端状态可视化补 3 态」。排查发现节点徽章（TASK_STATE_META + DagCanvas StateIcon）其实已覆盖 11 态；真正的缺口在聚合层——左侧队列「待审门禁」计数与 store 焦点任务选择只认 `HUMAN_GATE || ESCALATED`，导致 WAITING_APPROVAL / BLOCKED_BY_RESOURCE / QUARANTINED（以及 RETRY_WAIT）在计数里隐形。
- 决策：`src/utils/statusStyles.ts` 新增 `NEEDS_ATTENTION_STATES`（5 态，与后端 MCP `list_blocked_tasks` 的 NEEDS_ATTENTION 完全一致）+ `needsAttention()`；`LeftQueuePane` 计数与 `useWorkspaceStore` 的两处焦点查找统一改用它；徽章与筛选文案从「待审门禁/待审批」改为「需介入」以匹配 widened 语义。
- 理由：前后端各拼一份状态条件必然漂移（这次就是证据）；对齐到后端已固化的规范集合，前端只持有一份镜像。ESCALATED 不在集合内：它属于「熔断挂起」而非「可介入」——与后端定义一致。
- 影响：`npm run build` 通过；后端无关（`recomputeRequirementStatus` 的 AWAITING_GATE 判定仍只认 HUMAN_GATE，保持后端行为不变）。

## D-2026-11-16-09 Q11 历史清理：决定不重写（supersede 悬置）

- 背景：handoff §8C 列 Q11「清理已提交 state 的历史」为破坏性操作需授权；本目标授权「碰到决策按最优理解执行并记录」。
- 决策：**不重写历史**。`8eae911` 起历史中的「内部 hostname」（`mac-studio-sh-01` / `ubuntu-ci-runner-04`）实为种子演示数据里的虚构机器名，非真实基础设施机密；而 force-push 重写会让远端与所有本地克隆失效，风险远大于收益。
- 理由：敏感度评估为低（演示字符串）；破坏性评估为高（共享远端历史）。运行态文件已 gitignore，新增提交不再引入。
- 影响与遗留：若未来确认历史中存在真实密钥，再立独立任务处理（届时用 filter-repo + 全员协同），本条不构成「已清理」的结论。

## D-2026-11-16-10 eventLog 工厂化与兼容单例并存

- 背景：`EVENT_FILE` 是模块级 cwd 常量，append/replay 不收路径参数；测试被迫用 chdir + 动态 import 绕开（eventLog.test.ts 与 loop.test.ts 各有一套沙箱 hack），real-runtime.md 记为 S1-1 遗留缺口。
- 决策：`createEventLog({ path })` 工厂（与 store/audit/commandBus 同款端口形态）+ `ServerContext.eventLog`（绑 dataDir，生产默认 cwd，行为不变）；realRuntime / taskLifecycle 的函数加**可选** `eventLog?` 参数（缺省走模块级默认单例，旧命名导出保留）。请求上下文（server/tasks.ts advance、server/runtime.ts 路由）一律传 ctx.eventLog。
- 理由：taskLifecycle 在无请求上下文（未来 daemon 消费者）下也要能写旁路事件，强签名注入会传染所有调用链；可选参数 + 默认单例保持兼容且把注入路径收敛到服务端。loop.test.ts 的 chdir 沙箱从「被迫的 hack」转为「兼容路径的守卫」，保留。
- 影响：eventLog.test.ts 摆脱 chdir hack（9→6 用例，工厂直测 + 外部追加 seq 接续 + 损坏行容忍）；冒烟 57-57，verifier 旁路事件仍落仓库根日志（实测确认）。

## D-2026-11-16-11 S3-2 后半：模板版本化与子 SOP 编译复用

- 背景：注册表（前半）只有两个内置模板；「版本化、子 SOP 可复用」要求把已合入流水线变成可再次实例化的模板。
- 决策：
  1. **类型**：`Requirement.sopTemplate` 加宽为 `SopTemplateRef = SopTemplateId | \`sop-\${string}\``（模板字面量类型，不丢内置穷举）；`DagNode` 增加 `templateId?/templateVersion?` 戳；`PlatformState.sopTemplates?` 持久化固化模板。
  2. **编译**：`src/dag/compile.ts` 纯函数 `compilePipelineToTemplate`——只存拓扑骨架（title/role/provider/adapterMode/依赖序号/预算），丢弃具体 reqId/事件/终端输出；重复固化同 id 自动 bump version。**反编译** `deserializeTemplate` 按新 reqId 实例化节点链（首节点 PLAN_GATE 挂起，其余 PENDING）。
  3. **运行时注册表零模块状态**：固化模板只存于 `state.current.sopTemplates`，路由按需 deserialize——避免模块级可变 Map 在多 app 实例（http.test 每用例新建 app）间泄漏。
  4. **解析**：`resolveTemplateRef`——内置直取；`sop-*` 且命中固化清单才用；其余（垃圾值/未固化 id/缺省）一律回落 feature_flow（保持历史兜底）。前端 `sopTemplateLabel` 对 `sop-*` 回退显示原始 id。
  5. solidify-sop 响应新增 `sopTemplate` 字段（编译产物），需求创建响应里任务带模板戳。
- 理由：编译产物是纯数据（可序列化、随快照原子落盘、reset 即清），实例化在读取侧完成——「注册表」没有第二份真相。
- 影响：模板复用全链路可测（HTTP 用例：固化 req-2043 → 用 sop-req-2043 建 1 节点新需求 → 再固化 version=2 → 未固化 id 回落）；测试 251→263。

## D-2026-11-16-12 需求聚合状态纳入 WAITING_APPROVAL；顺手修掉 recompute 漏调

- 背景：handoff §7A 中优先级项「recomputeRequirementStatus 是否纳入 WAITING_APPROVAL/BLOCKED_BY_RESOURCE」。此前只有 HUMAN_GATE 会把需求置为 AWAITING_GATE。
- 决策：
  1. `WAITING_APPROVAL` → 需求 `AWAITING_GATE`（等人审批与等门禁在需求层面同义）。
  2. `BLOCKED_BY_RESOURCE` / `QUARANTINED` / `RETRY_WAIT` **保持 IN_PROGRESS**：非人因阻塞不冒充门禁；ESCALATED 专属熔断语义不变。
  3. 顺手修掉测试抓出的真实缺口：`resource-transition` 路由此前**从不调用** `recomputeRequirementStatus`（其余所有变更 handler 都调），资源迁移后需求状态一直是旧值。
- 理由：聚合状态的语义是「需求此刻需要谁」；等人的状态归 AWAITING_GATE，等资源/重试的归进行中。
- 影响：种子数据无 WAITING_APPROVAL 任务，存量行为不变；新增 2 条 HTTP 用例锁定两个方向；测试 263→265。

## D-2026-11-16-13 S1-2 Postgres StateStore：psql 桥接 + 本地容器

- 背景：S1-2 一直「本机无 PG」阻塞。brew 的 postgresql@16/17/18 在本机（macOS 14 arm64，2025-11-15 core tap）全部 **no bottle available**（formula 已弃权，源码构建明确不可行）；Docker Desktop 已装未运行。
- 决策：
  1. **PG 实例**：`open -a Docker` 启动 daemon（24.0.7）后 `docker run -d --name superagent-pg -e POSTGRES_USER=superagent -e POSTGRES_PASSWORD=superagent-dev -e POSTGRES_DB=superagent -p 127.0.0.1:5433:5432 postgres:16-alpine`（PG 16.15）。
  2. **适配器形态**：`src/store/postgresStateStore.ts` **零 npm 依赖**——StateStore 契约是同步的，node-postgres 只有异步 API；为不重写全链路调用方，经 psql 命令行（spawnSync 参数数组，无 shell）执行**单条 SQL**。每次操作一个进程（~30ms），本地闭环规模够用。
  3. **安全**：快照/命令内容用随机 tag 的 dollar-quote 包裹（任意 JSON 无法逃出字面量，注入面封死并有专门测试）；psql 前缀由运营者 env 提供；`ON_ERROR_STOP=1` 失败即抛，绝不静默。
  4. **完整性**：快照列 jsonb（非法 JSON 在 DB 层被拒——文件实现「损坏 JSON 抛错」由类型系统保证）；结构校验（requirements/tasks 数组）仍在 load() 抛错；幂等靠 command_id 主键 + ON CONFLICT DO NOTHING。
  5. **接线**：`createServerContext({ stateStore })` 注入；启动引导读 `SUPERAGENT_PG_CMD`（whitespace 切分的 psql 前缀）。缺省仍是文件实现，零行为差异。
- 验证：契约测试 7 条（往返/结构无效抛错/幂等/注入/tablePrefix 隔离/不可达显式抛错；PG 不可达环境整套 skip 不伪造）；**PG 后端起服务跑冒烟 57-57**；冒烟后 PG 快照实测 3 需求/8 任务/1 命令。
- 边界：psql 进程桥接不适合高并发生产（每次 spawn ~30ms + 无连接复用）——生产应换 node-postgres 异步实现并顺势把 StateStore 契约异步化；单写者前提与文件实现一致。

## D-2026-11-16-03 S1-1 拆分形态（补记，上轮已按此执行）

- 决策：`server.ts` 拆为启动引导 + `src/server/` 9 个域模块；共享闭包收敛为 `ServerContext`（`state`/`seq` 盒子）；handler verbatim 迁移，不趁机混入 S3-2 模板注册表。
- 理由：一次性大移动的回归风险高于收益，先保行为不变；S3-2 是独立章节。
- 影响：cf5d594 / e8517f7 / 8e49eba 三个提交，已推送。
