import type { Express } from 'express';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
} from '../workspace/worktreeManager';
import type { ServerContext } from './context';

/**
 * M14 Workspace Manager 路由：真实 git worktree 建/删与列表。
 * 建/删都在真实文件系统落盘；失败如实返回 code，不假装成功。
 */
export function registerWorkspaceRoutes(app: Express, ctx: ServerContext): void {
  const { state, saveState, repoRoot, worktreeRoot } = ctx;

  app.get('/api/workspaces', (_req, res) => {
    const listed = listWorktrees(repoRoot, worktreeRoot);
    if (!listed.ok) {
      res.status(listed.code === 'not_a_git_repo' ? 409 : 500).json({
        error: listed.message,
        code: listed.code,
        root: worktreeRoot,
      });
      return;
    }
    res.json({ root: worktreeRoot, worktrees: listed.value });
  });

  app.post('/api/tasks/:id/worktree', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }
    const requirement = state.current.requirements.find((r) => r.id === task.reqId);
    const rawBaseRef = (req.body as { baseRef?: unknown })?.baseRef;
    const baseRef =
      typeof rawBaseRef === 'string' && rawBaseRef.trim()
        ? rawBaseRef.trim()
        : requirement?.baseBranch || 'main';

    const created = createWorktree({
      repoRoot,
      root: worktreeRoot,
      taskId: task.id,
      baseRef,
      branch: task.worktreeBranch || `agent/${task.id}`,
    });
    if (!created.ok) {
      const status = created.code === 'not_a_git_repo' || created.code === 'git_unavailable' ? 409 : 400;
      res.status(status).json({ error: created.message, code: created.code });
      return;
    }

    // 把占位字符串换成真实绝对路径，前端与后续 real-spawn 都用这一份事实。
    task.worktreePath = created.value.path;
    task.terminalLines.push(
      `[workspace] git worktree ready: ${created.value.path} (branch=${created.value.branch} base=${created.value.baseRef})`,
    );
    saveState(state.current);
    res.status(201).json({ worktree: created.value, task });
  });

  app.delete('/api/tasks/:id/worktree', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }
    const body = (req.body ?? {}) as { deleteBranch?: unknown };
    const deleteBranch = req.query.deleteBranch === 'true' || body.deleteBranch === true;

    const removed = removeWorktree({
      repoRoot,
      root: worktreeRoot,
      taskId: task.id,
      deleteBranch,
    });
    if (!removed.ok) {
      const status = removed.code === 'not_found' ? 404 : removed.code === 'not_a_git_repo' ? 409 : 500;
      res.status(status).json({ error: removed.message, code: removed.code });
      return;
    }
    task.terminalLines.push(`[workspace] git worktree removed: ${removed.value.path}`);
    // 路径已不存在，保留旧值会让 UI 指向已删除目录；清空后前端回退显示分支名。
    task.worktreePath = undefined;
    saveState(state.current);
    res.json({ removed: removed.value, task });
  });
}
