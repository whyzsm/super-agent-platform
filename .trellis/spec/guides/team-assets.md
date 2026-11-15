# 团队资产（`.teamai/`）与现状边界

> `.teamai/` 是可版本化的团队规范资产，但其中的门禁脚本描述的是**目标流程**，与本仓库当前可运行命令不一致。本文件同时说明讨论稿与代码现状的区别。

---

## 何时适用

改 `.teamai/` 下任一资产、理解 MERGE_GATE 前置条件、或需要分辨"文档里的目标"与"代码里的现状"时。

## 四类资产（真实文件）

| 资产 | 路径 | 内容要点 |
|------|------|----------|
| 协作规范 | `.teamai/AGENTS.md` | worktree 隔离红线 `~/.superagent/worktrees/<repo>/<taskId>`、禁止提交未脱敏密钥 / PII、门禁前置 |
| 沙箱规则 | `.teamai/rules/sandbox-guard.md` | 4 类高危命令 BLOCK 并触发 `DANGER_GATE`：`rm -rf /`、`DROP TABLE/DATABASE`、`git push --force`、越界访问 `.env*` / `~/.ssh/` / `/etc/` |
| 技能 SOP | `.teamai/skills/sop-req-2043.md`、`.teamai/skills/webhook-replay-guard.md` | YAML frontmatter + 中文正文 SOP |
| 门禁钩子 | `.teamai/hooks/pre-merge-gate.sh` | `pnpm lint && pnpm typecheck && pnpm test --run` |

## frontmatter 约定

- 两个 skill 文件头部是 `---` 包裹的 YAML：`name` / `triggers`（数组）/ `scope` / `version`，正文为中文 SOP。
- 解析由 `src/engine/stateMachine.ts` 的 `parseSkillFrontmatter()`（`:298`）与 `extractSkillDraft()`（`:347`）负责；`POST /api/requirements/:id/solidify-sop`（`server.ts:919`）与 `POST /api/memories/:id/approve`（`:1202`）会把内容经 `syncTeamAiFileToDisk()`（`:38`）写成本地 `.teamai/skills/*.md`。
- 写盘后 `syncedToGit` 保持 `false`（**没有任何 git commit / MR**），见 [backend/state-persistence.md](../backend/state-persistence.md)。

## 门禁脚本与工程实际不一致（重点）

- `.teamai/hooks/pre-merge-gate.sh` 写 `pnpm lint && pnpm typecheck && pnpm test --run`，`.teamai/AGENTS.md` 也要求 `pnpm lint` / `pnpm typecheck` / `pnpm test` 三步全绿。
- 实际 `package.json` 脚本：`dev` / `start`（`tsx server.ts`）、`build`（`vite build`）、`preview` / `clean`、`lint`（`tsc --noEmit`）、`test`（`node --import tsx --test`）；**仍没有 `typecheck` 脚本**。锁文件为 `package-lock.json`，不是 pnpm 的 `pnpm-lock.yaml`。
- 因此该脚本在本仓库**仍不可直接运行**（`pnpm typecheck` / `pnpm test --run` 均不成立）。可用验证命令是 `npm run lint` 与 `npm test`（14 个用例全绿）。详见 [backend/quality-guidelines.md](../backend/quality-guidelines.md)。
- 同理，`AGENTS.md` 的 worktree 隔离、`.teamai/rules/sandbox-guard.md` 的 BLOCK 规则，在代码里对应的是 `detectDangerousCommand()`（`stateMachine.ts:241`）的字符串检测与 `worktreePath` 字符串字段，而非真实 `git worktree add` / 进程拦截。

## 讨论稿与现状的区别

- `docs/superagent-architecture-discussion-v1.md` 是**目标架构讨论稿**（"真实执行 + 云端记忆 + durable workflow"），自述基线为"高保真状态机原型，不是可运行平台"，含评审用结论与演进设计，不含实现代码。
- 本 `.trellis/spec/` 描述的是**代码现状与本地约定**：演示态原型（`verifierChecks` 硬编码全绿、无 CLI / LLM / git 执行、状态存本地 JSON）。不要把讨论稿的蓝图写成 spec 事实。

## 证据文件

- `.teamai/AGENTS.md`、`.teamai/rules/sandbox-guard.md`、`.teamai/skills/*.md`、`.teamai/hooks/pre-merge-gate.sh`、`package.json`、`package-lock.json`、`docs/superagent-architecture-discussion-v1.md`。

## 常见错误

- 把 `pnpm lint && pnpm typecheck && pnpm test` 当本仓库的验证命令照抄执行。
- 以"文件写盘成功"推断已推送远端；`syncedToGit` 恒 false，只有真正 `git commit` + MR 后才可置 true。
- 把讨论稿里的云端记忆 / durable workflow 写成当前已实现的能力。

## 验证

`npm run lint`（`tsc --noEmit`）。
