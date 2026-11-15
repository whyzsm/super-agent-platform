# SuperAgent 团队研发协作规范 (AGENTS.md)

## 1. 沙箱与隔离红线
- 所有代码修改必须在 `~/.superagent/worktrees/<repo>/<taskId>` 隔离分支执行，严禁直接操作主干分支。
- 严禁输出或提交任何未脱敏的 API Key、数据库密码或 PII 个人敏感信息。

## 2. 确定性门禁前置
- 提交 `MERGE_GATE` 前，Local Daemon 必须依次执行：
  1. `pnpm lint`
  2. `pnpm typecheck`
  3. `pnpm test`
- 上述三项全绿后，方可唤醒异构模型 Reviewer Agent 进行交叉审查。