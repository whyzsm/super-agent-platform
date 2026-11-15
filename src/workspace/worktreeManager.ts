import { spawnSync } from 'node:child_process';
import { BASE_REF_PATTERN, TASK_ID_PATTERN } from '../policy/rules';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M14 Workspace Manager：真实 git worktree 建删。
 *
 * 之前 `DagNode.worktreePath` 只是一段字符串，前端显示的隔离目录并不存在，
 * 「物理隔离」是纸面承诺。本模块用 `git worktree` 真正落盘：
 *   - 每个任务一个独立工作树 + 独立分支，改动不回灌主仓工作区；
 *   - 所有 git 调用用 spawn + 参数数组（无 shell），taskId / baseRef 走白名单校验，不存在命令注入面；
 *   - 失败返回结构化 code，不抛异常、不留半成品目录、不静默假装成功。
 *
 * 边界：worktree 共享同一个 .git 对象库，因此「隔离」指工作区与索引隔离，
 * 不指对象库隔离；跨机器并发同分支仍会互相阻塞，须由调度器串行化。
 */

export interface WorktreeHandle {
  taskId: string;
  branch: string;
  /** 绝对路径，真实存在于文件系统 */
  path: string;
  baseRef: string;
  headSha: string;
  createdAt: string;
}

export type WorktreeFailureCode =
  | 'not_a_git_repo'
  | 'invalid_task_id'
  | 'invalid_base_ref'
  | 'path_conflict'
  | 'not_found'
  | 'git_unavailable'
  | 'git_failed';

export interface WorktreeFailure {
  ok: false;
  code: WorktreeFailureCode;
  message: string;
}

export interface WorktreeSuccess<T> {
  ok: true;
  value: T;
}

export type WorktreeResult<T> = WorktreeSuccess<T> | WorktreeFailure;

// taskId / baseRef 白名单（策略规则）统一来自 src/policy/rules.ts（S2-9）。

/** git 调用结果：永不抛，全部以结构返回，便于上层如实上报失败原因。 */
interface GitRun {
  status: number | null;
  stdout: string;
  stderr: string;
  spawnError: string;
}

function runGit(repoRoot: string, args: string[], timeoutMs = 30_000): GitRun {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    // 固定隔离环境：不读用户 git hooks 的外部依赖，也不让 git 打开交互式编辑器。
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error ? result.error.message : '',
  };
}

function failure(code: WorktreeFailureCode, message: string): WorktreeFailure {
  return { ok: false, code, message };
}

/**
 * 归一化路径。macOS 上 /var 是 /private/var 的符号链接，而 `git worktree list`
 * 输出的是 realpath；不归一化会导致「自己刚建的工作树查不到」，进而幂等与删除全部失效。
 */
function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // 路径尚不存在：归一化父目录后拼回末段（只处理末段不存在这一种常见情形）。
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  try {
    return path.join(fs.realpathSync.native(parent), path.basename(abs));
  } catch {
    return abs;
  }
}

/**
 * 把工作树根目录写进 <git-dir>/info/exclude（本地排除，不改用户 .gitignore）。
 * 否则每个 agent 工作树都会让主仓 git status 出现 `?? .worktrees/`，
 * 「物理隔离」反而变成对主仓工作区的持续污染。
 */
function ensureExcluded(repoRoot: string, root: string): void {
  const rel = path.relative(canonicalPath(repoRoot), canonicalPath(root));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  const pattern = `/${rel.split(path.sep).join('/')}/`;

  const gitPath = runGit(repoRoot, ['rev-parse', '--git-path', 'info/exclude'], 10_000);
  if (gitPath.status !== 0) return;
  const excludePath = path.resolve(repoRoot, gitPath.stdout.trim());

  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    if (current.split('\n').some((line) => line.trim() === pattern)) return;
    const needsNewline = current !== '' && !current.endsWith('\n');
    fs.appendFileSync(excludePath, `${needsNewline ? '\n' : ''}${pattern}\n`, 'utf-8');
  } catch {
    // 失败只影响 git status 洁净度，不影响工作树隔离本身；不因此让创建失败。
  }
}

function isGitRepo(repoRoot: string): boolean {
  if (!fs.existsSync(repoRoot)) return false;
  const run = runGit(repoRoot, ['rev-parse', '--is-inside-work-tree'], 10_000);
  return run.status === 0 && run.stdout.trim() === 'true';
}

/** 校验 taskId 只允许安全字符，且解析后的绝对路径必须落在 root 之内（双保险）。 */
function resolveWorktreePath(
  root: string,
  taskId: string,
): WorktreeResult<string> {
  if (!TASK_ID_PATTERN.test(taskId) || taskId.includes('..')) {
    return failure(
      'invalid_task_id',
      `taskId 非法：${JSON.stringify(taskId)}；只允许字母数字与 . _ -，且不得含 ..`,
    );
  }
  const absRoot = canonicalPath(root);
  const absPath = path.resolve(absRoot, taskId);
  if (!absPath.startsWith(absRoot + path.sep)) {
    return failure('invalid_task_id', `taskId 解析后逃逸工作树根目录：${absPath}`);
  }
  return { ok: true, value: absPath };
}

function validateBaseRef(baseRef: string): WorktreeResult<string> {
  if (!BASE_REF_PATTERN.test(baseRef) || baseRef.includes('..') || baseRef.startsWith('-')) {
    return failure(
      'invalid_base_ref',
      `baseRef 非法：${JSON.stringify(baseRef)}；不得以 - 开头、不得含 ..，只允许字母数字与 . _ / -`,
    );
  }
  return { ok: true, value: baseRef };
}

/** 解析 `git worktree list --porcelain`，只返回落在 root 下的工作树。 */
export function listWorktrees(repoRoot: string, root: string): WorktreeResult<WorktreeHandle[]> {
  if (!isGitRepo(repoRoot)) {
    return failure('not_a_git_repo', `${repoRoot} 不是 git 仓库（git rev-parse 未确认）`);
  }
  const run = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (run.spawnError) return failure('git_unavailable', `无法执行 git：${run.spawnError}`);
  if (run.status !== 0) {
    return failure('git_failed', `git worktree list 失败（exit=${String(run.status)}）：${run.stderr.trim()}`);
  }

  const absRoot = canonicalPath(root);
  const handles: WorktreeHandle[] = [];
  for (const block of run.stdout.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    let wtPath = '';
    let headSha = '';
    let branch = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) headSha = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      }
    }
    if (!wtPath) continue;
    const absWt = canonicalPath(wtPath);
    if (absWt !== absRoot && !absWt.startsWith(absRoot + path.sep)) continue;
    const taskId = path.basename(absWt);
    handles.push({
      taskId,
      branch: branch || '(detached)',
      path: absWt,
      baseRef: branch || '(detached)',
      headSha,
      createdAt: '',
    });
  }
  return { ok: true, value: handles };
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  /** 工作树根目录（所有任务的父目录），默认 <repoRoot>/.worktrees */
  root?: string;
  taskId: string;
  /** 分支基线，默认 HEAD 当前分支 */
  baseRef?: string;
  /** 目标分支名，默认 agent/<taskId> */
  branch?: string;
}

/**
 * 创建真实工作树。幂等：同 taskId 已存在且路径合法时直接返回既有句柄，不重复 add。
 */
export function createWorktree(opts: CreateWorktreeOptions): WorktreeResult<WorktreeHandle> {
  const { repoRoot, taskId } = opts;
  const root = opts.root ?? path.join(repoRoot, '.worktrees');

  if (!isGitRepo(repoRoot)) {
    return failure('not_a_git_repo', `${repoRoot} 不是 git 仓库（git rev-parse 未确认）`);
  }

  const pathResult = resolveWorktreePath(root, taskId);
  if (!pathResult.ok) return pathResult;
  const targetPath = pathResult.value;

  let baseRef = opts.baseRef?.trim() || '';
  if (!baseRef) {
    const head = runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 10_000);
    baseRef = head.status === 0 ? head.stdout.trim() : 'HEAD';
  }
  const refResult = validateBaseRef(baseRef);
  if (!refResult.ok) return refResult;
  baseRef = refResult.value;

  const branch = opts.branch ?? `agent/${taskId}`;

  // 幂等：已登记的同 taskId 工作树直接返回。
  const listed = listWorktrees(repoRoot, root);
  if (!listed.ok) return listed;
  const existing = listed.value.find((h) => h.taskId === taskId);
  if (existing) {
    return { ok: true, value: { ...existing, baseRef } };
  }

  // 目标路径被非工作树内容占用：拒绝而不是覆盖用户文件。
  if (fs.existsSync(targetPath)) {
    const entries = fs.readdirSync(targetPath);
    if (entries.length > 0) {
      return failure(
        'path_conflict',
        `目标路径已存在且非空，但不是已登记的 git worktree：${targetPath}`,
      );
    }
    fs.rmdirSync(targetPath);
  }

  fs.mkdirSync(root, { recursive: true });
  ensureExcluded(repoRoot, root);

  const branchExists =
    runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 10_000).status === 0;

  const addArgs = branchExists
    ? ['worktree', 'add', targetPath, branch]
    : ['worktree', 'add', '-b', branch, targetPath, baseRef];
  const add = runGit(repoRoot, addArgs);

  if (add.spawnError) {
    return failure('git_unavailable', `无法执行 git：${add.spawnError}`);
  }
  if (add.status !== 0) {
    // 失败清理：git 有时已建目录；只在目录为空时移除，绝不删用户内容。
    try {
      if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length === 0) {
        fs.rmdirSync(targetPath);
      }
    } catch {
      // 清理失败不影响错误上报：真实原因以 git stderr 为准。
    }
    return failure(
      'git_failed',
      `git worktree add 失败（exit=${String(add.status)}）：${(add.stderr || add.stdout).trim().slice(0, 600)}`,
    );
  }

  // 真实校验：目录存在、工作区 git 链接存在，否则视为失败（不假装成功）。
  const dotGit = path.join(targetPath, '.git');
  if (!fs.existsSync(targetPath) || !fs.existsSync(dotGit)) {
    return failure('git_failed', `git 报告成功但工作树未落盘：${targetPath}`);
  }
  const head = runGit(targetPath, ['rev-parse', 'HEAD'], 10_000);

  return {
    ok: true,
    value: {
      taskId,
      branch,
      path: targetPath,
      baseRef,
      headSha: head.status === 0 ? head.stdout.trim() : '',
      createdAt: new Date().toISOString(),
    },
  };
}

export interface RemoveWorktreeOptions {
  repoRoot: string;
  root?: string;
  taskId: string;
  /** 默认 false：保留分支作为审计证据，只删工作树 */
  deleteBranch?: boolean;
}

/** 删除真实工作树。未登记的 taskId 返回 not_found，不做破坏性兜底删除。 */
export function removeWorktree(
  opts: RemoveWorktreeOptions,
): WorktreeResult<{ removed: boolean; path: string; branch?: string; branchDeleted: boolean }> {
  const { repoRoot, taskId } = opts;
  const root = opts.root ?? path.join(repoRoot, '.worktrees');

  if (!isGitRepo(repoRoot)) {
    return failure('not_a_git_repo', `${repoRoot} 不是 git 仓库（git rev-parse 未确认）`);
  }
  const pathResult = resolveWorktreePath(root, taskId);
  if (!pathResult.ok) return pathResult;
  const targetPath = pathResult.value;

  const listed = listWorktrees(repoRoot, root);
  if (!listed.ok) return listed;
  const existing = listed.value.find((h) => h.taskId === taskId);
  if (!existing) {
    return failure('not_found', `未登记的 worktree：${taskId}（路径 ${targetPath}）`);
  }

  const rm = runGit(repoRoot, ['worktree', 'remove', '--force', existing.path]);
  if (rm.spawnError) return failure('git_unavailable', `无法执行 git：${rm.spawnError}`);
  if (rm.status !== 0) {
    return failure(
      'git_failed',
      `git worktree remove 失败（exit=${String(rm.status)}）：${(rm.stderr || rm.stdout).trim().slice(0, 600)}`,
    );
  }
  runGit(repoRoot, ['worktree', 'prune']);

  let branchDeleted = false;
  if (opts.deleteBranch && existing.branch && existing.branch !== '(detached)') {
    const del = runGit(repoRoot, ['branch', '-D', existing.branch]);
    branchDeleted = del.status === 0;
  }

  return {
    ok: true,
    value: {
      removed: true,
      path: existing.path,
      branch: existing.branch,
      branchDeleted,
    },
  };
}
