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

## D-2026-11-16-03 S1-1 拆分形态（补记，上轮已按此执行）

- 决策：`server.ts` 拆为启动引导 + `src/server/` 9 个域模块；共享闭包收敛为 `ServerContext`（`state`/`seq` 盒子）；handler verbatim 迁移，不趁机混入 S3-2 模板注册表。
- 理由：一次性大移动的回归风险高于收益，先保行为不变；S3-2 是独立章节。
- 影响：cf5d594 / e8517f7 / 8e49eba 三个提交，已推送。
