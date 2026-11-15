# M14 Workspace Manager：真实 git worktree

> 实现：`src/workspace/worktreeManager.ts`（含 `worktreeManager.test.ts` 12 用例）
> 端点：`GET /api/workspaces`、`POST/DELETE /api/tasks/:id/worktree`
> 适用：任何声称「隔离工作区」「物理隔离」「worktree 拓扑」的代码、文档或 UI 文案

---

## 为什么不只是字符串

之前 `DagNode.worktreePath` 是一段形如 `~/.superagent/worktrees/app-service/task-2041-plan` 的字符串，
从未真正创建过目录——「物理隔离」只是纸面承诺，UI 上显示的路径点进去并不存在。
现在改为真实 `git worktree add` 落盘，创建后把 `worktreePath` 替换为**真实绝对路径**。

## 四个不可退让的约束

| 约束 | 做法 | 违反后果 |
|------|------|----------|
| 无命令注入面 | `spawnSync('git', [args])` 传参数数组、绝不拼 shell；`taskId` 走 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，`baseRef` 走 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$` 且禁 `-` 开头 / 禁 `..` | `taskId='../evil'` 可逃逸工作树根目录 |
| 路径不逃逸 | `resolveWorktreePath()` 归一化后必须 `startsWith(root + sep)` | 同上 |
| 路径归一化 | 所有比较走 `canonicalPath()`（`realpathSync.native`） | macOS 上 `/var` 是 `/private/var` 的软链，`git worktree list` 输出 realpath，不归一化会导致**自己刚建的工作树查不到**，幂等与删除全部失效（已实际踩到） |
| 不留半成品 | `git worktree add` 失败时，仅在目标目录为空时 `rmdir`；非空（用户文件）绝不删 | 误删用户内容 |

## 幂等与失败语义

- 同 `taskId` 重复创建：命中 `listWorktrees()` 已登记项直接返回既有句柄，**不重复 add、不报错**。
- 目标路径被非工作树内容占用：返回 `path_conflict`，**不覆盖**。
- `baseRef` 不存在：返回 `git_failed` 并清理空目录，列表里不留幽灵项。
- 删除未登记 `taskId`：返回 `not_found`，不做破坏性兜底。
- 删除默认**保留分支**（审计证据）；`deleteBranch=true` 才 `git branch -D`。

返回类型是判别式联合 `WorktreeResult<T> = {ok:true,value} | {ok:false,code,message}`，
永不抛异常打挂服务。

## 必须写进 git exclude

`createWorktree()` 会调用 `ensureExcluded()`，把 `/​.worktrees/` 写进 `<git-dir>/info/exclude`。

原因：不排除时每个 agent 工作树都会让主仓 `git status` 出现 `?? .worktrees/`，
「隔离」反而变成对主仓工作区的持续污染（测试 `worktree: 工作区物理隔离` 断言主仓 status 为空）。
用 `info/exclude` 而不是改 `.gitignore`：这是本地行为，不应替用户改可提交文件。

## 端点契约

| 方法 / 路径 | 成功 | 失败 |
|-------------|------|------|
| `GET /api/workspaces` | `200 {root, worktrees[]}` | 非 git 仓库 `409` |
| `POST /api/tasks/:id/worktree` | `201 {worktree, task}`（`task.worktreePath` 已替换） | 未登记动作/非法参数 `400`，非 git 仓库 `409` |
| `DELETE /api/tasks/:id/worktree?deleteBranch=true` | `200 {removed, task}` | 未登记 `404` |

删除成功时会把 `task.worktreePath` 置为 `undefined`——保留旧值会让 UI 指向已删除目录。

## 常见错误

- **以为隔离等于对象库隔离**：worktree 共享同一个 `.git` 对象库，隔离的是工作区与索引；
  跨机器并发同分支仍互相阻塞，必须由调度器串行化。
- **在小屏下找不到检验舱**：`DagCanvas` 需 `max-h-[65vh] lg:max-h-none`，否则窄屏下
  画布占满剩余高度把 `NodeInspectorPane` 挤出可视区（已修，勿回退）。

## 证据

- `src/workspace/worktreeManager.ts`：`canonicalPath`、`ensureExcluded`、`createWorktree`、`removeWorktree`
- `src/workspace/worktreeManager.test.ts`：12 用例，全部在 `os.tmpdir()` 里真实 `git init` 后断言真实文件系统
- `src/server/workspace.ts`：`worktreeRoot`（来自 `ServerContext`）、`POST/DELETE /api/tasks/:id/worktree`、`GET /api/workspaces`；另有 `src/server/http.test.ts` 在临时 git 仓内断言真实建删
- `scripts/e2e-smoke.mjs` §12：9 项真实 HTTP 断言（含重复删除 404、非法 baseRef 400）
