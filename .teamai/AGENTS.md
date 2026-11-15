# SuperAgent 团队研发协作规范 (AGENTS.md)

## 1. 沙箱与隔离红线
- 所有代码修改必须在 `.worktrees/<taskId>`（真实 `git worktree`，绝对路径以 `/api/workspaces` 返回为准）隔离分支执行，严禁直接操作主干分支。
- 严禁输出或提交任何未脱敏的 API Key、数据库密码或 PII 个人敏感信息。

## 2. 确定性门禁前置
- 提交 `MERGE_GATE` 前，Local Daemon 必须依次执行：
  1. `npm run lint`
  2. `npm test`
- 上述两项全绿后，方可唤醒异构模型 Reviewer Agent 进行交叉审查。
- 说明：本仓库为 npm 工程，不存在 `typecheck` 独立脚本（`tsc --noEmit` 已由 `npm run lint` 覆盖）；
  禁止在门禁脚本里登记未定义的命令，否则 hook 会必然失败。