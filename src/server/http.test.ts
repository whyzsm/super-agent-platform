import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from './app';
import { createServerContext, type ServerContext, type ServerContextOptions } from './context';
import { signImWebhookPayload } from '../gateway/imWebhook';

/**
 * 路由层 HTTP 测试（S1-1 前置要求）。
 *
 * 每个用例拿到一个完全隔离的实例：
 * - 状态/命令/审计/loop 日志落在临时目录（createServerContext 注入 dataDir）；
 * - git 仓库是临时目录里 git init 出来的迷你仓（workspace 路由可真建真删 worktree）；
 * - HTTP 走真实 listen(0) + fetch，RBAC loopback 注入 admin 与线上行为一致。
 *
 * 本文件进程默认 SUPERAGENT_DEMO_MODE=1：advance 不真跑 lint/test verifier，
 * 只测路由与状态机编排；真实 verifier 由 scripts/e2e-smoke.mjs 覆盖。
 */
process.env.SUPERAGENT_DEMO_MODE = '1';

/**
 * 环境隔离：本套件对身份/密钥相关环境变量零依赖。
 *
 * 真实踩坑：dev server 进程经 dotenv 加载 .env 后，其 verifier 再跑 `npm test`
 * 时进程环境里已有 IM_WEBHOOK_SECRET ——「未配置密钥返回 503」用例会被
 * createServerContext 的 env 兜底破坏，出现「单测裸跑绿、verifier 里跑挂」的
 * 环境相关失败。因此进入本文件即清除这些变量，结束时恢复。
 */
const HERMETIC_ENV_KEYS = [
  'IM_WEBHOOK_SECRET',
  'SUPERAGENT_DEV_USER',
  'SUPERAGENT_DEV_TEAM',
  'SUPERAGENT_DEV_ROLES',
  'SUPERAGENT_CLI_COMMAND',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of HERMETIC_ENV_KEYS) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
after(() => {
  for (const key of HERMETIC_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface TestApp {
  ctx: ServerContext;
  url: string;
  dir: string;
  close(): Promise<void>;
}

async function startTestApp(overrides: Partial<ServerContextOptions> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-http-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  const git = (args: string[]) =>
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@superagent.invalid', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    });
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  assert.equal(git(['rev-parse', '--is-inside-work-tree']).status, 0, 'fixture git repo must init');

  const ctx = createServerContext({
    dataDir: dir,
    repoRoot: dir,
    worktreeRoot: path.join(dir, '.worktrees'),
    imWebhookSecret: 'test-im-secret',
    ...overrides,
  });
  const app = createApp(ctx);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  assert(addr && typeof addr === 'object', 'listen(0) must return address');
  return {
    ctx,
    dir,
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}

async function json<T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

function post<T = unknown>(url: string, body?: unknown, headers?: Record<string, string>) {
  return json<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}), headers });
}

describe('HTTP 路由层（隔离实例 + 真实 HTTP）', () => {
  describe('系统路由', () => {
    it('GET /api/health 返回 ok 与需求计数', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await json<{ ok: boolean; requirements: number }>(app.url + '/api/health');
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.requirements, 3);
      } finally {
        await app.close();
      }
    });

    it('GET /api/bootstrap 返回种子全量状态', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await json<{
          requirements: unknown[];
          tasks: unknown[];
          memories: unknown[];
          teamAiAssets: unknown[];
          daemons: unknown[];
        }>(app.url + '/api/bootstrap');
        assert.equal(status, 200);
        assert.equal(body.requirements.length, 3);
        assert.equal(body.tasks.length, 8);
        assert.equal(body.memories.length, 5);
        assert.equal(body.teamAiAssets.length, 4);
        assert.equal(body.daemons.length, 3);
      } finally {
        await app.close();
      }
    });

    it('GET /api/stream 首帧为 data: 心跳', async () => {
      const app = await startTestApp();
      const controller = new AbortController();
      try {
        const res = await fetch(app.url + '/api/stream', {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        });
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        assert.match(text, /^data: /);
        const frame = JSON.parse(text.replace(/^data: /, '').trim()) as {
          payload: { type: string; activeTaskIds: string[] };
        };
        assert.equal(frame.payload.type, 'HEARTBEAT');
        assert.ok(Array.isArray(frame.payload.activeTaskIds));
      } finally {
        controller.abort();
        await app.close();
      }
    });

    it('POST /api/reset 重建种子态并保持可见', async () => {
      const app = await startTestApp();
      try {
        await post(app.url + '/api/tasks/task-2041-plan/comments', { comment: '先弄脏状态' });
        const { status, body } = await post<import('../data/seed').PlatformState>(app.url + '/api/reset');
        assert.equal(status, 200);
        assert.equal(body.requirements.length, 3);
        const after = await json<{ tasks: { id: string; lineComments: unknown[] }[] }>(app.url + '/api/bootstrap');
        const plan = after.body.tasks.find((t) => t.id === 'task-2041-plan');
        assert.equal(plan?.lineComments.length, 0, 'reset 后注释应清空');
      } finally {
        await app.close();
      }
    });
  });

  describe('Q8 门禁三挡（gateTier 配置）', () => {
    it('默认 always_confirm：advance 全绿仍进 HUMAN_GATE（历史行为不变）', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ task: { state: string } }>(
          app.url + '/api/tasks/task-2042-b1/advance',
        );
        assert.equal(status, 200);
        assert.equal(body.task.state, 'HUMAN_GATE');
      } finally {
        await app.close();
      }
    });

    it('auto_approve_when_green：全绿 MERGE_GATE 直接 MERGED 且留痕可审计', async () => {
      const app = await startTestApp({ gateTier: 'auto_approve_when_green' });
      try {
        const { status, body } = await post<{
          task: { state: string; events: { title: string }[]; terminalLines: string[] };
          requirement: { status: string } | undefined;
        }>(app.url + '/api/tasks/task-2042-b1/advance');
        assert.equal(status, 200);
        assert.equal(body.task.state, 'MERGED', '全绿 MERGE_GATE 应自动放行合入');
        assert.ok(
          body.task.events.some((e) => e.title.includes('自动放行')),
          '必须留下自动放行事件',
        );
        assert.ok(body.task.terminalLines.some((l) => l.includes('[gate-policy] AUTO-RELEASE')));
        assert.equal(body.requirement?.status, 'IN_PROGRESS', 'b2 仍在 RETRY_WAIT，需求未完结');
        const audit = await json<{ entries: { target: string; detail?: string }[] }>(
          app.url + '/api/runtime/audit',
        );
        assert.ok(
          audit.body.entries.some((e) => e.target.includes('auto-release task-2042-b1')),
          '审计必须记录自动放行',
        );
      } finally {
        await app.close();
      }
    });

    it('auto_approve_when_green：DANGER_GATE 永不自动放行', async () => {
      const app = await startTestApp({ gateTier: 'auto_approve_when_green' });
      try {
        const { status, body } = await post<{ task: { state: string; activeCheckpoint: { gateType: string } } }>(
          app.url + '/api/tasks/task-2041-b1/simulate-danger',
          { command: 'git push --force origin main' },
        );
        assert.equal(status, 200);
        assert.equal(body.task.state, 'HUMAN_GATE', '危险门禁必须等人工');
        assert.equal(body.task.activeCheckpoint.gateType, 'DANGER_GATE');
      } finally {
        await app.close();
      }
    });

    it('delegate_to_reviewer：代批未接入，诚实降级为人工确认', async () => {
      const app = await startTestApp({ gateTier: 'delegate_to_reviewer' });
      try {
        const { status, body } = await post<{ task: { state: string } }>(
          app.url + '/api/tasks/task-2042-b1/advance',
        );
        assert.equal(status, 200);
        assert.equal(body.task.state, 'HUMAN_GATE', '无真实代批模型时不得伪造放行');
      } finally {
        await app.close();
      }
    });
  });

  describe('需求路由', () => {
    it('POST /api/requirements feature_flow 生成 4 节点 DAG', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          requirement: { status: string; sopTemplate: string };
          tasks: { state: string; activeCheckpoint: { gateType: string } | undefined }[];
        }>(app.url + '/api/requirements', { title: '新支付通道', specMd: '### 验收\n1. 幂等' });
        assert.equal(status, 201);
        assert.equal(body.requirement.status, 'AWAITING_GATE');
        assert.equal(body.requirement.sopTemplate, 'feature_flow');
        assert.equal(body.tasks.length, 4);
        assert.equal(body.tasks[0].state, 'HUMAN_GATE');
        assert.equal(body.tasks[0].activeCheckpoint?.gateType, 'PLAN_GATE');
      } finally {
        await app.close();
      }
    });

    it('POST /api/requirements bugfix_flow 生成 3 节点 DAG', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ tasks: unknown[] }>(app.url + '/api/requirements', {
          title: '修复对账重复入账',
          specMd: 'spec',
          sopTemplate: 'bugfix_flow',
        });
        assert.equal(status, 201);
        assert.equal(body.tasks.length, 3);
      } finally {
        await app.close();
      }
    });

    it('POST /api/requirements 缺标题返回 400', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ error: string }>(app.url + '/api/requirements', { specMd: 'x' });
        assert.equal(status, 400);
        assert.ok(body.error.includes('不能为空'));
      } finally {
        await app.close();
      }
    });

    it('POST solidify-sop：全合入需求固化并落盘 .teamai/skills', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          asset: { id: string; status: string };
          teamAiAsset: { path: string };
        }>(app.url + '/api/requirements/req-2043/solidify-sop');
        assert.equal(status, 200);
        assert.equal(body.asset.id, 'mem-sop-req-2043');
        assert.equal(body.asset.status, 'published');
        assert.equal(body.teamAiAsset.path, '.teamai/skills/sop-req-2043.md');
        assert.ok(
          fs.existsSync(path.join(app.dir, '.teamai/skills/sop-req-2043.md')),
          'SOP 文件应写入临时 repoRoot',
        );
      } finally {
        await app.close();
      }
    });

    it('POST solidify-sop：未全部合入返回 400', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/requirements/req-2042/solidify-sop');
        assert.equal(status, 400);
      } finally {
        await app.close();
      }
    });

    it('POST solidify-sop：未知需求返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/requirements/req-nope/solidify-sop');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });
  });

  describe('任务路由', () => {
    it('advance：RETRY_WAIT -> RUNNING', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ task: { id: string; state: string } }>(
          app.url + '/api/tasks/task-2042-b2/advance',
        );
        assert.equal(status, 200);
        assert.equal(body.task.id, 'task-2042-b2');
        assert.equal(body.task.state, 'RUNNING');
      } finally {
        await app.close();
      }
    });

    it('advance：RUNNING -> VERIFYING -> HUMAN_GATE（演示态门禁全绿）', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          task: { state: string; verifierChecks: { name: string; passed: boolean }[] };
        }>(app.url + '/api/tasks/task-2042-b1/advance');
        assert.equal(status, 200);
        assert.equal(body.task.state, 'HUMAN_GATE');
        const names = body.task.verifierChecks.map((c) => c.name);
        assert.deepEqual(names, ['lint', 'typecheck', 'unit_test', 'cross_review']);
        assert.ok(body.task.verifierChecks.every((c) => c.passed));
      } finally {
        await app.close();
      }
    });

    it('advance：未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-nope/advance');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('simulate-failure：进入 RETRY_WAIT 且日志脱敏', async () => {
      const app = await startTestApp();
      try {
        const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUV';
        const { status, body } = await post<{
          task: { state: string; retryCount: number; verifierChecks: { name: string; summary: string }[] };
        }>(app.url + '/api/tasks/task-2042-b1/simulate-failure', {
          errorLog: `unit_test failed: token ${secret} leaked`,
        });
        assert.equal(status, 200);
        assert.equal(body.task.state, 'RETRY_WAIT');
        assert.equal(body.task.retryCount, 1);
        const unit = body.task.verifierChecks.find((c) => c.name === 'unit_test');
        assert.ok(unit!.summary.includes('[REDACTED_API_KEY]'), 'API key 必须被脱敏');
        assert.ok(!unit!.summary.includes(secret), '原始密钥不得出现在响应中');
      } finally {
        await app.close();
      }
    });

    it('simulate-failure：未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-nope/simulate-failure');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('simulate-danger：挂起为 DANGER_GATE', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          task: { state: string; activeCheckpoint: { gateType: string } };
        }>(app.url + '/api/tasks/task-2042-b1/simulate-danger', { command: 'git push --force origin main' });
        assert.equal(status, 200);
        assert.equal(body.task.state, 'HUMAN_GATE');
        assert.equal(body.task.activeCheckpoint.gateType, 'DANGER_GATE');
      } finally {
        await app.close();
      }
    });

    it('gate 批准 MERGE_GATE -> MERGED 并解锁下游', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          task: { id: string; state: string };
          requirements: { id: string; status: string }[];
        }>(app.url + '/api/tasks/task-2041-b1/gate', { approved: true, reviewerId: 'lin.wei' });
        assert.equal(status, 200);
        assert.equal(body.task.state, 'MERGED');
        const req = body.requirements.find((r) => r.id === 'req-2041');
        assert.equal(req?.status, 'AWAITING_GATE', 'b2 仍在门禁，需求应保持 AWAITING_GATE');
      } finally {
        await app.close();
      }
    });

    it('gate 附带意见打回 -> RETRY_WAIT 且 retryCount 递增', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ task: { state: string; retryCount: number } }>(
          app.url + '/api/tasks/task-2041-b2/gate',
          { approved: false, comment: '边界场景未覆盖' },
        );
        assert.equal(status, 200);
        assert.equal(body.task.state, 'RETRY_WAIT');
        assert.equal(body.task.retryCount, 1);
      } finally {
        await app.close();
      }
    });

    it('gate：未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-nope/gate', { approved: true });
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('ndjson：JSON 事件行入库并广播', async () => {
      const app = await startTestApp();
      try {
        const line = JSON.stringify({ type: 'thought', text: '正在分析对账幂等键' });
        const { status, body } = await post<{
          task: { events: unknown[] };
          parsed: { event?: { kind: string } };
          budgetTriggered: boolean;
        }>(app.url + '/api/tasks/task-2041-b1/ndjson', { line });
        assert.equal(status, 200);
        assert.ok(body.parsed.event, 'JSON thought 行应解析出事件');
        assert.equal(body.budgetTriggered, false);
        assert.ok(body.task.events.length > 0);
      } finally {
        await app.close();
      }
    });

    it('ndjson：纯文本高危命令触发 ACP 拦截并挂起', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          task: { state: string; activeCheckpoint: { gateType: string } };
          parsed: { dangerIntercept?: { command: string } };
        }>(app.url + '/api/tasks/task-2042-b1/ndjson', { line: 'rm -rf /' });
        assert.equal(status, 200);
        assert.ok(body.parsed.dangerIntercept, '高危命令必须产生拦截');
        assert.equal(body.task.state, 'HUMAN_GATE');
        assert.equal(body.task.activeCheckpoint.gateType, 'DANGER_GATE');
      } finally {
        await app.close();
      }
    });

    it('ndjson：空行返回 400，未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const empty = await post(app.url + '/api/tasks/task-2041-b1/ndjson', { line: '   ' });
        assert.equal(empty.status, 400);
        const missing = await post(app.url + '/api/tasks/task-nope/ndjson', { line: 'x' });
        assert.equal(missing.status, 404);
      } finally {
        await app.close();
      }
    });

    it('input：注入终端指令且 Bearer 令牌脱敏', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ task: { terminalLines: string[] } }>(
          app.url + '/api/tasks/task-2041-b1/input',
          { text: 'curl -H "Authorization: Bearer abcdefghijklmnopqrst" https://api' },
        );
        assert.equal(status, 200);
        const last = body.task.terminalLines.at(-1) ?? '';
        assert.ok(last.includes('[REDACTED_BEARER_TOKEN]'), 'Bearer 令牌必须脱敏');
        assert.ok(!last.includes('abcdefghijklmnopqrst'));
      } finally {
        await app.close();
      }
    });

    it('input：空指令返回 400', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-2041-b1/input', { text: ' ' });
        assert.equal(status, 400);
      } finally {
        await app.close();
      }
    });

    it('comments：行级批注落库', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          lineComment: { comment: string; author: string };
          task: { lineComments: unknown[] };
        }>(app.url + '/api/tasks/task-2041-b1/comments', { comment: '建议补充幂等键断言', line: 42 });
        assert.equal(status, 201);
        assert.equal(body.lineComment.comment, '建议补充幂等键断言');
        assert.equal(body.task.lineComments.length, 2, '种子已有 1 条，新增后应为 2');
      } finally {
        await app.close();
      }
    });

    it('comments：空批注返回 400', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-2041-b1/comments', { comment: '' });
        assert.equal(status, 400);
      } finally {
        await app.close();
      }
    });

    it('resource-transition：RUNNING -> BLOCKED_BY_RESOURCE', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          ok: boolean;
          from: string;
          to: string;
          task: { state: string };
        }>(app.url + '/api/tasks/task-2042-b1/resource-transition', {
          kind: 'BLOCK_RESOURCE',
          commandId: 'cmd-block-1',
        });
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.from, 'RUNNING');
        assert.equal(body.to, 'BLOCKED_BY_RESOURCE');
        assert.equal(body.task.state, 'BLOCKED_BY_RESOURCE');
      } finally {
        await app.close();
      }
    });

    it('resource-transition：非法 kind 400 且回带 from/to', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ error: string; from: string; to: null }>(
          app.url + '/api/tasks/task-2042-b1/resource-transition',
          { kind: 'EXPLODE' },
        );
        assert.equal(status, 400);
        assert.equal(body.from, 'RUNNING');
        assert.equal(body.to, null);
      } finally {
        await app.close();
      }
    });

    it('resource-transition：状态机拒绝的迁移返回 400（PENDING 不能 APPROVE）', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ from: string; to: string }>(
          app.url + '/api/tasks/task-2041-review/resource-transition',
          { kind: 'APPROVE' },
        );
        assert.equal(status, 400);
        assert.equal(body.from, 'PENDING');
      } finally {
        await app.close();
      }
    });

    it('resource-transition：未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-nope/resource-transition', {
          kind: 'CANCEL',
        });
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('retrospective：只产出草案且 taskId 回显', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ taskId: string; note: string }>(
          app.url + '/api/tasks/task-2041-plan/retrospective',
        );
        assert.equal(status, 200);
        assert.equal(body.taskId, 'task-2041-plan');
        assert.ok(body.note.includes('人审'), 'Q5 红线说明必须在响应中');
      } finally {
        await app.close();
      }
    });

    it('retrospective：未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-nope/retrospective');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });
  });

  describe('MCP 与记忆路由', () => {
    it('POST /api/mcp initialize 协商协议版本', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          jsonrpc: string;
          result: { protocolVersion: string; serverInfo: { name: string } };
        }>(app.url + '/api/mcp', {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        });
        assert.equal(status, 200);
        assert.equal(body.jsonrpc, '2.0');
        assert.equal(body.result.protocolVersion, '2025-06-18');
        assert.equal(body.result.serverInfo.name, 'superagent-memory');
      } finally {
        await app.close();
      }
    });

    it('POST /api/mcp 纯通知返回 202', async () => {
      const app = await startTestApp();
      try {
        const res = await fetch(app.url + '/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        assert.equal(res.status, 202);
        assert.equal(await res.text(), '');
      } finally {
        await app.close();
      }
    });

    it('GET /api/mcp 无服务端推送返回 405', async () => {
      const app = await startTestApp();
      try {
        const res = await fetch(app.url + '/api/mcp');
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'POST');
      } finally {
        await app.close();
      }
    });

    it('POST /api/mcp 非法 JSON 返回 JSON-RPC -32700', async () => {
      const app = await startTestApp();
      try {
        const res = await fetch(app.url + '/api/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json{',
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: { code: number } };
        assert.equal(body.error.code, -32700);
      } finally {
        await app.close();
      }
    });

    it('MCP propose_memory：viewer 被拒、developer 创建 draft 且不进召回', async () => {
      const app = await startTestApp();
      try {
        const callTool = async (args: unknown, roles: string) =>
          post<{ result?: { isError?: boolean; structuredContent?: { proposed?: { id: string; status: string } } } }>(
            app.url + '/api/mcp',
            { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'propose_memory', arguments: args } },
            { 'x-superagent-roles': roles },
          );
        // viewer：工具级拒绝（isError），不是协议错误
        const denied = await callTool(
          { title: '草案', contentMd: '内容', assetType: 'SKILL' },
          'viewer',
        );
        assert.equal(denied.status, 200);
        assert.equal(denied.body.result?.isError, true, 'viewer 不得写入');
        // developer：创建 draft
        const okRes = await callTool(
          { title: '对账幂等新方案草案', contentMd: '唯一索引方案补充', assetType: 'SKILL' },
          'developer',
        );
        assert.equal(okRes.status, 200);
        const proposed = okRes.body.result?.structuredContent?.proposed;
        assert.equal(proposed?.status, 'draft');
        // 草案入库但不进召回；发布仍需 memory:approve
        const boot = await json<{ memories: { id: string; status: string }[] }>(app.url + '/api/bootstrap');
        assert.ok(boot.body.memories.some((m) => m.id === proposed!.id && m.status === 'draft'));
        const recall = await post<{ results: { asset: { id: string } }[]; excludedDraftsCount: number }>(
          app.url + '/api/mcp/recall',
          { query: '对账 幂等', caller: { teamId: 'team-platform-core', projectId: 'proj-reconcile' } },
        );
        assert.ok(!recall.body.results.some((r) => r.asset.id === proposed!.id), 'draft 绝不出站');
        assert.equal(recall.body.excludedDraftsCount, 2);
      } finally {
        await app.close();
      }
    });

    it('POST /api/mcp/recall 中文查询真实召回且 draft 不出站', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          results: { asset: { id: string; status: string }; score: number }[];
          excludedDraftsCount: number;
        }>(app.url + '/api/mcp/recall', {
          query: '对账单 幂等',
          // mem-l2-1 是 project 级 ACL（proj-reconcile）：不带 projectId 必须召不回，
          // 带上才可命中——这条用例同时锁住四级 ACL 过滤。
          caller: { teamId: 'team-platform-core', projectId: 'proj-reconcile' },
        });
        assert.equal(status, 200);
        assert.equal(body.excludedDraftsCount, 1);
        assert.ok(body.results.length >= 1, '中文查询应召回到已发布记忆');
        assert.ok(body.results.some((r) => r.asset.id === 'mem-l2-1'), '应命中对账幂等方案');
        assert.ok(body.results.every((r) => r.asset.status === 'published'), 'draft 绝不出站');
      } finally {
        await app.close();
      }
    });

    it('POST /api/mcp/recall 空查询返回 400', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/mcp/recall', { query: '  ' });
        assert.equal(status, 400);
      } finally {
        await app.close();
      }
    });

    it('memories approve：draft -> published 并写 .teamai 文件', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          asset: { id: string; status: string; version: number };
          teamAiAssets: { path: string }[];
        }>(app.url + '/api/memories/mem-skill-draft-1/approve');
        assert.equal(status, 200);
        assert.equal(body.asset.status, 'published');
        assert.equal(body.asset.version, 2);
        assert.ok(
          body.teamAiAssets.some((a) => a.path === '.teamai/skills/mem-skill-draft-1.md'),
          '审批后应登记 TeamAI 资产',
        );
        assert.ok(fs.existsSync(path.join(app.dir, '.teamai/skills/mem-skill-draft-1.md')));
      } finally {
        await app.close();
      }
    });

    it('memories reject：归档', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ asset: { status: string } }>(
          app.url + '/api/memories/mem-wiki-1/reject',
        );
        assert.equal(status, 200);
        assert.equal(body.asset.status, 'archived');
      } finally {
        await app.close();
      }
    });

    it('memories approve：未知资产返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/memories/mem-nope/approve');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('PUT /api/teamai 更新资产内容并写盘', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await json<{ asset: { content: string } }>(app.url + '/api/teamai', {
          method: 'PUT',
          body: JSON.stringify({ assetPath: '.teamai/AGENTS.md', content: '# 团队规范 v2' }),
          headers: { 'content-type': 'application/json' },
        });
        assert.equal(status, 200);
        assert.equal(body.asset.content, '# 团队规范 v2');
        assert.equal(fs.readFileSync(path.join(app.dir, '.teamai/AGENTS.md'), 'utf-8'), '# 团队规范 v2');
      } finally {
        await app.close();
      }
    });

    it('PUT /api/teamai 未登记路径返回 400', async () => {
      const app = await startTestApp();
      try {
        const { status } = await json(app.url + '/api/teamai', {
          method: 'PUT',
          body: JSON.stringify({ assetPath: '.teamai/nope.md', content: 'x' }),
          headers: { 'content-type': 'application/json' },
        });
        assert.equal(status, 400);
      } finally {
        await app.close();
      }
    });
  });

  describe('IM webhook 路由', () => {
    it('GET card：返回审批卡片与签名回调体', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await json<{
          card: unknown;
          signedCallback: { rawBody: string; signature: string };
        }>(app.url + '/api/webhooks/im/card/task-2041-b1');
        assert.equal(status, 200);
        assert.ok(body.card);
        assert.match(body.signedCallback.signature, /^[0-9a-f]{64}$/);
      } finally {
        await app.close();
      }
    });

    it('GET card：未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await json(app.url + '/api/webhooks/im/card/task-nope');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('POST /api/webhooks/im：合法签名放行 MERGE_GATE', async () => {
      const app = await startTestApp();
      try {
        const card = await json<{ signedCallback: { rawBody: string; signature: string } }>(
          app.url + '/api/webhooks/im/card/task-2041-b1',
        );
        const { status, body } = await post<{ verified: boolean; task: { state: string } }>(
          app.url + '/api/webhooks/im',
          {
            rawBody: card.body.signedCallback.rawBody,
            signature: card.body.signedCallback.signature,
          },
        );
        assert.equal(status, 200);
        assert.equal(body.verified, true);
        assert.equal(body.task.state, 'MERGED');
      } finally {
        await app.close();
      }
    });

    it('POST /api/webhooks/im：伪造签名返回 401', async () => {
      const app = await startTestApp();
      try {
        const card = await json<{ signedCallback: { rawBody: string } }>(
          app.url + '/api/webhooks/im/card/task-2041-b1',
        );
        const { status } = await post(app.url + '/api/webhooks/im', {
          rawBody: card.body.signedCallback.rawBody,
          signature: '0'.repeat(64),
        });
        assert.equal(status, 401);
      } finally {
        await app.close();
      }
    });

    it('POST /api/webhooks/im：签名合法但任务不存在返回 404', async () => {
      const app = await startTestApp();
      try {
        const rawBody = JSON.stringify({
          channel: 'wecom',
          taskId: 'task-nope',
          approved: true,
          comment: 'x',
          reviewerId: 'lin.wei',
          timestamp: Date.now(),
          nonce: Math.random().toString(36).slice(2, 10),
        });
        const { status } = await post(app.url + '/api/webhooks/im', {
          rawBody,
          signature: signImWebhookPayload(rawBody, 'test-im-secret'),
        });
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('未配置 IM_WEBHOOK_SECRET 时 IM 端点返回 503', async () => {
      const app = await startTestApp({ imWebhookSecret: undefined });
      try {
        const card = await json<{ error: string }>(app.url + '/api/webhooks/im/card/task-2041-b1');
        assert.equal(card.status, 503);
        const cb = await post(app.url + '/api/webhooks/im', { rawBody: '{}' });
        assert.equal(cb.status, 503);
      } finally {
        await app.close();
      }
    });
  });

  describe('运行时路由', () => {
    it('daemons replay：重连节点回到 online', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{
          daemon: { machineId: string; status: string; pendingOfflineEvents: number };
          replayed: number;
        }>(app.url + '/api/daemons/thinkpad-dev-chen/replay');
        assert.equal(status, 200);
        assert.equal(body.daemon.machineId, 'thinkpad-dev-chen');
        assert.equal(body.daemon.status, 'online');
        assert.equal(body.daemon.pendingOfflineEvents, 0);
        assert.ok(body.replayed > 0);
      } finally {
        await app.close();
      }
    });

    it('daemons replay：未知节点返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/daemons/nope/replay');
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });

    it('runtime/audit：请求后审计可查', async () => {
      const app = await startTestApp();
      try {
        await json(app.url + '/api/health');
        const { status, body } = await json<{
          entries: { seq: number; userId: string; outcome: string }[];
        }>(app.url + '/api/runtime/audit');
        assert.equal(status, 200);
        assert.ok(body.entries.length >= 1, '至少应记录本次 health 读');
        assert.ok(body.entries.every((e) => typeof e.seq === 'number'));
      } finally {
        await app.close();
      }
    });

    it('runtime/commands：命令日志可查', async () => {
      const app = await startTestApp();
      try {
        await post(app.url + '/api/tasks/task-2042-b2/advance', { commandId: 'log-cmd-1' });
        const { status, body } = await json<{ commands: { commandId: string }[]; lastSeq: number }>(
          app.url + '/api/runtime/commands',
        );
        assert.equal(status, 200);
        assert.ok(body.commands.some((c) => c.commandId === 'log-cmd-1'));
        assert.ok(body.lastSeq >= 1);
      } finally {
        await app.close();
      }
    });

    it('real-spawn / runtime/events：演示态 404，真实态缺 CLI 配置 400', async () => {
      const app = await startTestApp();
      try {
        assert.equal((await post(app.url + '/api/tasks/task-2042-b1/real-spawn')).status, 404);
        assert.equal((await json(app.url + '/api/runtime/events')).status, 404);

        const prev = process.env.SUPERAGENT_DEMO_MODE;
        process.env.SUPERAGENT_DEMO_MODE = '0';
        try {
          // 未配置 SUPERAGENT_CLI_COMMAND：必须拒绝而非默认发起模型调用。
          const spawn = await post<{ error: string }>(app.url + '/api/tasks/task-2042-b1/real-spawn');
          assert.equal(spawn.status, 400);
          assert.ok(spawn.body.error.includes('SUPERAGENT_CLI_COMMAND'));

          const events = await json<{ events: unknown[]; lastSeq: number }>(app.url + '/api/runtime/events');
          assert.equal(events.status, 200);
          assert.ok(Array.isArray(events.body.events));
          assert.equal(typeof events.body.lastSeq, 'number');
        } finally {
          process.env.SUPERAGENT_DEMO_MODE = prev ?? '1';
        }
      } finally {
        await app.close();
      }
    });
  });

  describe('workspace 路由（临时 git 仓库）', () => {
    it('GET /api/workspaces 列出工作树根', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await json<{ root: string; worktrees: unknown[] }>(
          app.url + '/api/workspaces',
        );
        assert.equal(status, 200);
        assert.equal(body.root, path.join(app.dir, '.worktrees'));
        assert.deepEqual(body.worktrees, []);
      } finally {
        await app.close();
      }
    });

    it('POST worktree 真实落盘并可幂等重建，DELETE 连带删分支', async () => {
      const app = await startTestApp();
      try {
        const create = await post<{ worktree: { path: string; branch: string }; task: { worktreePath?: string } }>(
          app.url + '/api/tasks/task-2042-b1/worktree',
          { baseRef: 'main' },
        );
        assert.equal(create.status, 201);
        const wtPath = create.body.worktree.path;
        // macOS /var -> /private/var 软链：worktree 管理器输出 realpath，断言前先归一化。
        const canonicalRoot = fs.realpathSync.native(path.join(app.dir, '.worktrees'));
        assert.ok(wtPath.startsWith(canonicalRoot), '必须落在受控根目录内');
        assert.ok(fs.existsSync(wtPath), '工作树必须真实存在');
        assert.equal(create.body.task.worktreePath, wtPath, '任务 worktreePath 换成真实路径');

        const again = await post<{ worktree: { path: string } }>(
          app.url + '/api/tasks/task-2042-b1/worktree',
          { baseRef: 'main' },
        );
        assert.equal(again.status, 201);
        assert.equal(again.body.worktree.path, wtPath, '重复创建幂等返回同一路径');

        const list = await json<{ worktrees: { taskId: string }[] }>(app.url + '/api/workspaces');
        assert.ok(list.body.worktrees.some((w) => w.taskId === 'task-2042-b1'));

        const del = await fetch(app.url + '/api/tasks/task-2042-b1/worktree?deleteBranch=true', {
          method: 'DELETE',
        });
        assert.equal(del.status, 200);
        assert.ok(!fs.existsSync(wtPath), '删除后目录必须不存在');

        const againDel = await fetch(app.url + '/api/tasks/task-2042-b1/worktree?deleteBranch=true', {
          method: 'DELETE',
        });
        assert.equal(againDel.status, 404, '重复删除必须 404 而非静默成功');
      } finally {
        await app.close();
      }
    });

    it('POST worktree 非法 baseRef 返回 400（参数注入被挡）', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ code: string }>(
          app.url + '/api/tasks/task-2042-b1/worktree',
          { baseRef: '../evil' },
        );
        assert.equal(status, 400);
        assert.equal(body.code, 'invalid_base_ref');
      } finally {
        await app.close();
      }
    });

    it('POST worktree 未知任务返回 404', async () => {
      const app = await startTestApp();
      try {
        const { status } = await post(app.url + '/api/tasks/task-nope/worktree', { baseRef: 'main' });
        assert.equal(status, 404);
      } finally {
        await app.close();
      }
    });
  });

  describe('RBAC 与幂等', () => {
    it('viewer 角色写操作返回 403', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ error: string }>(
          app.url + '/api/requirements',
          { title: 'x', specMd: 'y' },
          { 'x-superagent-roles': 'viewer' },
        );
        assert.equal(status, 403);
        assert.ok(body.error.includes('无权执行'));
      } finally {
        await app.close();
      }
    });

    it('未登记的写路由 fail-closed 403', async () => {
      const app = await startTestApp();
      try {
        const { status, body } = await post<{ error: string }>(app.url + '/api/unregistered-write');
        assert.equal(status, 403);
        assert.ok(body.error.includes('未登记动作'));
      } finally {
        await app.close();
      }
    });

    it('重复 commandId 直接 409，不二次写状态', async () => {
      const app = await startTestApp();
      try {
        const first = await post<{ task: { state: string } }>(
          app.url + '/api/tasks/task-2042-b2/advance',
          { commandId: 'dup-advance-1' },
        );
        assert.equal(first.status, 200);
        const second = await post<{ error: string }>(
          app.url + '/api/tasks/task-2042-b2/advance',
          { commandId: 'dup-advance-1' },
        );
        assert.equal(second.status, 409);
        assert.ok(second.body.error.includes('重复命令'));
      } finally {
        await app.close();
      }
    });
  });
});
