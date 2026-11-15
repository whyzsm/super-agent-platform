import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentReasoningEvent, DagNode, TaskState } from '../protocol';
import type { LoopCommand, LoopCommandKind, SubmittedCommand } from './commandBus';
import type { ResourceKind } from './taskLifecycle';

// ---------------------------------------------------------------------------
// 沙箱：realRuntime.recordStateTransition -> eventLog.appendRuntimeEvent 的
// EVENT_FILE 是模块顶层基于 process.cwd() 算出的绝对路径常量，append 不接受路径参数。
// applyResourceTransition 合法时按要求必须调用它写旁路事件；为让该写入落到临时目录、
// 绝不污染仓库根，必须在任何项目模块（尤其间接依赖 eventLog 的 taskLifecycle）被加载
// 之前先把 cwd 切到临时目录，并且全程只用动态 import（静态 import 会被提升、抢跑）。
// ---------------------------------------------------------------------------
const REPO_ROOT = process.cwd();
const REPO_EVENT_LOG = path.join(REPO_ROOT, '.superagent-events.jsonl');
const repoLogBefore = fs.existsSync(REPO_EVENT_LOG)
  ? fs.readFileSync(REPO_EVENT_LOG, 'utf-8')
  : null;

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
process.chdir(SANDBOX);
const EVENT_LOG_PATH = path.join(SANDBOX, '.superagent-events.jsonl');

function countEventLogLines(): number {
  if (!fs.existsSync(EVENT_LOG_PATH)) return 0;
  return fs.readFileSync(EVENT_LOG_PATH, 'utf-8').split('\n').filter((l) => l.trim()).length;
}

after(() => {
  const repoLogAfter = fs.existsSync(REPO_EVENT_LOG)
    ? fs.readFileSync(REPO_EVENT_LOG, 'utf-8')
    : null;
  assert.equal(
    repoLogAfter,
    repoLogBefore,
    '测试全程不得在仓库根目录写入 .superagent-events.jsonl',
  );
  process.chdir(REPO_ROOT);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 构造工具：按 DagNode 真实字段完整构造（返回类型标注为 DagNode，由 TS 逐字段校验），
// 不靠 `as DagNode` 强转绕过类型检查。
// ---------------------------------------------------------------------------
function makeNode(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: 'task-loop-1',
    reqId: 'req-loop-1',
    title: '本地幂等 loop 底座验证任务',
    role: 'builder',
    provider: 'codex',
    adapterMode: 'headless_json',
    dependsOn: [],
    state: 'RUNNING',
    retryCount: 0,
    maxRetries: 3,
    position: { x: 0, y: 0 },
    events: [],
    terminalLines: [],
    verifierChecks: [],
    lineComments: [],
    ...overrides,
  };
}

function withCmdDir(fn: (logPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdbus-test-'));
  try {
    fn(path.join(dir, 'commands.jsonl'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// commandBus
// ===========================================================================

test('commandBus: 首次提交 accepted，record 含 seq/ts，日志为单行完整 JSON', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus = createCommandBus({ logPath });
    const r = bus.submit({
      commandId: 'c-1', taskId: 'task-A', kind: 'ADVANCE', payload: { note: '启动' },
    });
    assert.equal(r.accepted, true);
    assert.equal(r.duplicate, false);
    assert.ok(r.record);
    assert.equal(r.record.seq, 1);
    assert.equal(Number.isNaN(Date.parse(r.record.ts)), false);
    assert.equal(bus.lastSeq(), 1);

    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1, 'append-only 仅追加一行');
    const parsed = JSON.parse(lines[0]) as SubmittedCommand;
    assert.equal(parsed.commandId, 'c-1');
    assert.equal(parsed.taskId, 'task-A');
    assert.equal(parsed.kind, 'ADVANCE');
    assert.equal(parsed.seq, 1);
    assert.deepEqual(parsed.payload, { note: '启动' });
    assert.deepEqual(bus.list(), [r.record]);
  });
});

test('commandBus: 同 commandId 幂等去重，重复返回 duplicate:true 且不追加、不改变状态', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus = createCommandBus({ logPath });
    const first = bus.submit({ commandId: 'c-dup', taskId: 'task-A', kind: 'QUARANTINE' });
    assert.equal(first.accepted, true);

    const before = fs.readFileSync(logPath, 'utf-8');
    const seqBefore = bus.lastSeq();
    // 同 commandId 但换 kind / taskId / payload，应被幂等忽略。
    const dup = bus.submit({
      commandId: 'c-dup', taskId: 'task-B', kind: 'CANCEL', payload: { changed: true },
    });
    assert.equal(dup.accepted, false);
    assert.equal(dup.duplicate, true);
    assert.match(dup.reason ?? '', /幂等/);
    assert.equal(fs.readFileSync(logPath, 'utf-8'), before, '重复提交不得追加任何行');
    assert.equal(bus.lastSeq(), seqBefore, '重复提交不得改变 seq');
    assert.equal(bus.list().length, 1);
    assert.equal(bus.list()[0].kind, 'QUARANTINE', '重复提交不得改写既有记录');
    assert.equal(bus.list()[0].taskId, 'task-A');
  });
});

test('commandBus: 多次提交 seq 严格连续递增 1,2,3', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus = createCommandBus({ logPath });
    const kinds: LoopCommandKind[] = ['ADVANCE', 'RETRY', 'RETRO'];
    kinds.forEach((kind, i) => {
      const r = bus.submit({ commandId: `c-${i + 1}`, taskId: 'task-A', kind });
      assert.equal(r.accepted, true);
      assert.equal(r.record?.seq, i + 1);
    });
    assert.deepEqual(bus.list().map((r) => r.seq), [1, 2, 3]);
    assert.equal(bus.lastSeq(), 3);
  });
});

test('commandBus: seq 每次从日志真实 max 计算，外部追加不冲突', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus = createCommandBus({ logPath });
    bus.submit({ commandId: 'c-1', taskId: 'task-A', kind: 'ADVANCE' });

    // 模拟另一个进程 / 人工在日志尾部外部追加一条高 seq 记录。
    const external: SubmittedCommand = {
      commandId: 'external-1', taskId: 'task-Z', kind: 'CANCEL',
      seq: 100, ts: '2026-01-01T00:00:00.000Z',
    };
    fs.appendFileSync(logPath, `${JSON.stringify(external)}\n`, 'utf-8');

    assert.equal(bus.lastSeq(), 100, 'lastSeq 纯读应反映外部追加');
    const next = bus.submit({ commandId: 'c-2', taskId: 'task-A', kind: 'BLOCK_RESOURCE' });
    assert.equal(next.accepted, true);
    assert.equal(next.record?.seq, 101, '应从 max(100) 续写为 101，不冲突');
    assert.deepEqual(bus.list().map((r) => r.seq), [1, 100, 101]);
  });
});

test('commandBus: 损坏行/空行/缺字段行被跳过，list 按 seq 升序', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const mk = (seq: number, commandId: string): SubmittedCommand => ({
      commandId, taskId: 'task-A', kind: 'ADVANCE', seq,
      ts: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify(mk(3, 'c-3')),
        'not-json-on-purpose',
        '',
        '   ',
        JSON.stringify({ seq: 'not-a-number', commandId: 'x', taskId: 'task-A', kind: 'ADVANCE' }),
        JSON.stringify({ commandId: 'no-seq', taskId: 'task-A', kind: 'ADVANCE', ts: 'x' }),
        JSON.stringify({ ...mk(999, 'bad-kind'), kind: 'NOT_A_KIND' }),
        JSON.stringify(mk(1, 'c-1')),
        JSON.stringify(mk(2, 'c-2')),
      ].join('\n') + '\n',
      'utf-8',
    );
    const bus = createCommandBus({ logPath });
    assert.equal(bus.lastSeq(), 3, 'lastSeq 应跳过损坏行，取合法最大 seq=3');
    assert.deepEqual(bus.list().map((r) => r.seq), [1, 2, 3]);
    assert.deepEqual(bus.list().map((r) => r.commandId), ['c-1', 'c-2', 'c-3']);

    const next = bus.submit({ commandId: 'c-4', taskId: 'task-A', kind: 'ADVANCE' });
    assert.equal(next.record?.seq, 4, '损坏行不干扰后续 seq 分配');
  });
});

test('commandBus: 非法命令（缺字段/非法 kind/非对象）被拒且写明 reason，绝不抛异常', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus = createCommandBus({ logPath });
    const invalids: unknown[] = [
      { taskId: 'task-A', kind: 'ADVANCE' },                       // 缺 commandId
      { commandId: 'c-x', kind: 'ADVANCE' },                      // 缺 taskId
      { commandId: '', taskId: 'task-A', kind: 'ADVANCE' },        // 空 commandId
      { commandId: 'c-y', taskId: '   ', kind: 'ADVANCE' },        // 空白 taskId
      { commandId: 'c-z', taskId: 'task-A', kind: 'NOT_A_KIND' },  // 非法 kind
      { commandId: 'c-p', taskId: 'task-A', kind: 'ADVANCE', payload: 'not-object' }, // payload 非对象
      null,                                                        // 非对象
      'a string',                                                  // 非对象
    ];
    for (const bad of invalids) {
      let r: { accepted: boolean; duplicate: boolean; reason?: string } | undefined;
      assert.doesNotThrow(() => {
        r = bus.submit(bad as LoopCommand);
      });
      assert.equal(r!.accepted, false);
      assert.equal(r!.duplicate, false);
      assert.ok((r!.reason ?? '').length > 0, '必须写明 reason');
    }
    assert.equal(fs.existsSync(logPath), false, '非法命令不得创建/追加日志');
    assert.equal(bus.lastSeq(), 0);
    assert.deepEqual(bus.list(), []);
  });
});

test('commandBus: list 按 taskId 过滤，且纯读不创建日志文件', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus = createCommandBus({ logPath });
    assert.deepEqual(bus.list(), [], '文件不存在时 list 返回空');
    assert.equal(fs.existsSync(logPath), false, '纯读不得创建文件');

    bus.submit({ commandId: 'c-1', taskId: 'task-A', kind: 'ADVANCE' });
    bus.submit({ commandId: 'c-2', taskId: 'task-B', kind: 'RETRY' });
    bus.submit({ commandId: 'c-3', taskId: 'task-A', kind: 'RETRO' });

    assert.deepEqual(bus.list('task-A').map((r) => r.commandId), ['c-1', 'c-3']);
    assert.deepEqual(bus.list('task-B').map((r) => r.commandId), ['c-2']);
    assert.deepEqual(bus.list('task-MISSING'), []);

    const snapshot = fs.readFileSync(logPath, 'utf-8');
    bus.list();
    bus.list('task-A');
    bus.lastSeq();
    assert.equal(fs.readFileSync(logPath, 'utf-8'), snapshot, 'list/lastSeq 不得写入');
  });
});

test('commandBus: 重新打开同一日志（模拟重启）seq 从真实 max 续写且去重仍生效', async () => {
  const { createCommandBus } = await import('./commandBus');
  withCmdDir((logPath) => {
    const bus1 = createCommandBus({ logPath });
    bus1.submit({ commandId: 'c-1', taskId: 'task-A', kind: 'ADVANCE' });
    bus1.submit({ commandId: 'c-2', taskId: 'task-A', kind: 'RETRY' });

    const bus2 = createCommandBus({ logPath });
    assert.equal(bus2.lastSeq(), 2);
    const dup = bus2.submit({ commandId: 'c-1', taskId: 'task-A', kind: 'ADVANCE' });
    assert.equal(dup.duplicate, true, '重启后仍能识别历史 commandId');
    const fresh = bus2.submit({ commandId: 'c-3', taskId: 'task-A', kind: 'CANCEL' });
    assert.equal(fresh.record?.seq, 3);
    assert.deepEqual(bus2.list().map((r) => r.seq), [1, 2, 3]);
  });
});

// ===========================================================================
// applyResourceTransition
// ===========================================================================

test('applyResourceTransition: 7 个 kind 的合法迁移均经 canTransition 放行并映射到正确目标态', async () => {
  const { applyResourceTransition } = await import('./taskLifecycle');
  const cases: Array<{ from: TaskState; kind: ResourceKind; to: TaskState }> = [
    { from: 'RUNNING', kind: 'BLOCK_RESOURCE', to: 'BLOCKED_BY_RESOURCE' },
    { from: 'BLOCKED_BY_RESOURCE', kind: 'RELEASE_RESOURCE', to: 'RUNNING' },
    { from: 'RUNNING', kind: 'QUARANTINE', to: 'QUARANTINED' },
    { from: 'QUARANTINED', kind: 'RELEASE_QUARANTINE', to: 'RETRY_WAIT' },
    { from: 'RUNNING', kind: 'WAIT_APPROVAL', to: 'WAITING_APPROVAL' },
    { from: 'WAITING_APPROVAL', kind: 'APPROVE', to: 'MERGED' },
    { from: 'RUNNING', kind: 'CANCEL', to: 'CANCELLED' },
  ];
  for (const c of cases) {
    const node = makeNode({ state: c.from });
    const snapshot = structuredClone(node);
    const r = applyResourceTransition(node, c.kind);

    assert.equal(r.ok, true, `${c.kind} 应为合法迁移`);
    assert.equal(r.from, c.from);
    assert.equal(r.to, c.to);
    assert.equal(r.node.state, c.to);
    assert.notEqual(r.node, node, '必须返回新 node 对象（浅拷贝）');
    assert.equal(r.node.events.length, node.events.length + 1);
    assert.equal(r.node.terminalLines.length, node.terminalLines.length + 1);

    // events 字段结构须符合 AgentReasoningEvent 真实定义
    const ev = r.node.events[r.node.events.length - 1];
    assert.equal(typeof ev.id, 'string');
    assert.equal(typeof ev.ts, 'string');
    assert.equal(typeof ev.seq, 'number');
    assert.ok(
      ['thought', 'tool_call', 'file_edit', 'shell_exec', 'acp_intercept', 'verifier_check'].includes(ev.kind),
    );
    assert.ok(ev.title.length > 0);
    assert.ok(ev.detail.length > 0);
    assert.ok(['ok', 'blocked', 'failed', 'running'].includes(ev.status));
    assert.match(r.node.terminalLines[r.node.terminalLines.length - 1], /[\u4e00-\u9fa5]/);

    // 入参完全不变（深比较）
    assert.deepStrictEqual(node, snapshot, '不得修改入参');
    assert.match(r.reason, /canTransition/);
  }
});

test('applyResourceTransition: 合法迁移写入旁路 STATE_TRANSITION 事件（recordStateTransition 被调用）', async () => {
  const { applyResourceTransition } = await import('./taskLifecycle');
  const before = countEventLogLines();
  const r = applyResourceTransition(makeNode({ state: 'RUNNING' }), 'BLOCK_RESOURCE');
  assert.equal(r.ok, true);
  assert.equal(countEventLogLines(), before + 1, '合法迁移应追加一条旁路事件（落在临时目录）');

  const lines = fs.readFileSync(EVENT_LOG_PATH, 'utf-8').split('\n').filter((l) => l.trim());
  const last = JSON.parse(lines[lines.length - 1]) as {
    type: string; detail: string; taskId: string;
  };
  assert.equal(last.type, 'STATE_TRANSITION');
  assert.equal(last.detail, 'RUNNING->BLOCKED_BY_RESOURCE');
  assert.equal(last.taskId, 'task-loop-1');
});

test('applyResourceTransition: 非法迁移（MERGED 终态不可 CANCEL）返回 ok:false、原 node 深比较完全不变', async () => {
  const { applyResourceTransition } = await import('./taskLifecycle');
  const existingEvent: AgentReasoningEvent = {
    id: 'ev-0', ts: '2026-01-01T00:00:00.000Z', seq: 7,
    kind: 'thought', title: '已有事件', detail: '已有细节', status: 'ok',
  };
  const node = makeNode({
    state: 'MERGED', events: [existingEvent], terminalLines: ['已有终端日志'],
  });
  const snapshot = structuredClone(node);
  const r = applyResourceTransition(node, 'CANCEL');

  assert.equal(r.ok, false);
  assert.equal(r.from, 'MERGED');
  assert.equal(r.to, 'CANCELLED');
  assert.equal(r.node, node, '非法时应原样返回同一个 node 引用');
  assert.match(r.reason, /不是合法迁移/);
  assert.deepStrictEqual(node, snapshot, '入参深比较完全不变');
});

test('applyResourceTransition: 多组非法迁移一律拒绝，且不产生任何副作用（含旁路事件）', async () => {
  const { applyResourceTransition } = await import('./taskLifecycle');
  const illegal: Array<{ from: TaskState; kind: ResourceKind; to: TaskState }> = [
    { from: 'PENDING', kind: 'QUARANTINE', to: 'QUARANTINED' },         // PENDING 不直接隔离
    { from: 'MERGED', kind: 'BLOCK_RESOURCE', to: 'BLOCKED_BY_RESOURCE' }, // 终态不可再入
    { from: 'CANCELLED', kind: 'RELEASE_RESOURCE', to: 'RUNNING' },       // 终态不可恢复
    { from: 'QUARANTINED', kind: 'APPROVE', to: 'MERGED' },               // 隔离态不可直接合入
  ];
  const before = countEventLogLines();
  for (const c of illegal) {
    const node = makeNode({ state: c.from });
    const snapshot = structuredClone(node);
    const r = applyResourceTransition(node, c.kind);
    assert.equal(r.ok, false, `${c.from} + ${c.kind} 应被拒绝`);
    assert.equal(r.to, c.to);
    assert.match(r.reason, /不是合法迁移/);
    assert.equal(r.node, node);
    assert.deepStrictEqual(node, snapshot, '非法时节点完全不变');
    assert.equal(node.events.length, 0, '不得 push events');
    assert.equal(node.terminalLines.length, 0, '不得写 terminalLines');
  }
  assert.equal(countEventLogLines(), before, '非法迁移不得调用 recordStateTransition 写旁路事件');
});

test('applyResourceTransition: 迁移合法性完全以 canTransition 为唯一裁决', async () => {
  const { applyResourceTransition } = await import('./taskLifecycle');
  const { canTransition } = await import('../engine/stateMachine');
  const mixed: Array<{ from: TaskState; kind: ResourceKind; to: TaskState }> = [
    { from: 'RUNNING', kind: 'BLOCK_RESOURCE', to: 'BLOCKED_BY_RESOURCE' },
    { from: 'MERGED', kind: 'CANCEL', to: 'CANCELLED' },
    { from: 'QUARANTINED', kind: 'RELEASE_QUARANTINE', to: 'RETRY_WAIT' },
    { from: 'PENDING', kind: 'QUARANTINE', to: 'QUARANTINED' },
    { from: 'WAITING_APPROVAL', kind: 'APPROVE', to: 'MERGED' },
  ];
  for (const c of mixed) {
    const expected = canTransition(c.from, c.to);
    const r = applyResourceTransition(makeNode({ state: c.from }), c.kind);
    assert.equal(r.ok, expected, `${c.from}->${c.to} 的 ok 应与 canTransition 一致`);
    assert.equal(r.to, c.to);
  }
});

test('applyResourceTransition: 为新增 3 态提供真实生产者（进入与退出闭环）', async () => {
  const { applyResourceTransition } = await import('./taskLifecycle');

  // RUNNING -> BLOCKED_BY_RESOURCE -> RUNNING
  const b = applyResourceTransition(makeNode({ state: 'RUNNING' }), 'BLOCK_RESOURCE');
  assert.equal(b.ok, true);
  assert.equal(b.to, 'BLOCKED_BY_RESOURCE');
  const br = applyResourceTransition(b.node, 'RELEASE_RESOURCE');
  assert.equal(br.ok, true);
  assert.equal(br.to, 'RUNNING');

  // RUNNING -> QUARANTINED -> RETRY_WAIT
  const q = applyResourceTransition(makeNode({ state: 'RUNNING' }), 'QUARANTINE');
  assert.equal(q.ok, true);
  assert.equal(q.to, 'QUARANTINED');
  const qr = applyResourceTransition(q.node, 'RELEASE_QUARANTINE');
  assert.equal(qr.ok, true);
  assert.equal(qr.to, 'RETRY_WAIT');

  // RUNNING -> WAITING_APPROVAL -> MERGED
  const w = applyResourceTransition(makeNode({ state: 'RUNNING' }), 'WAIT_APPROVAL');
  assert.equal(w.ok, true);
  assert.equal(w.to, 'WAITING_APPROVAL');
  const wa = applyResourceTransition(w.node, 'APPROVE');
  assert.equal(wa.ok, true);
  assert.equal(wa.to, 'MERGED');
});

// ===========================================================================
// deriveRetrospective
// ===========================================================================

test('deriveRetrospective: 失败任务提炼出 Skill 草案文本，requiresHumanReview 恒 true', async () => {
  const { deriveRetrospective } = await import('./taskLifecycle');
  const node = makeNode({
    state: 'MERGED', retryCount: 2, hadFailureOrCorrection: true,
    lastErrorFeedback: '首次单测因缺少时间戳校验失败，已补充防重放窗口后全绿。',
    title: 'IM Webhook 防重放校验',
  });
  const r = deriveRetrospective(node);
  assert.equal(r.requiresHumanReview, true);
  assert.ok(r.draft, '失败任务应产生草案文本');
  assert.equal(typeof r.draft, 'string');
  assert.match(r.draft, /^---/);
  assert.match(r.draft, /name:/);
  assert.match(r.draft, /标准化修复规范/);
  assert.match(r.reason, /Q5 红线/);
  assert.match(r.reason, /人审 MR/);
  assert.match(r.reason, /禁止自动改写已发布 SOP/);
});

test('deriveRetrospective: 无失败/无重试任务返回 draft:null，但 requiresHumanReview 仍恒为 true', async () => {
  const { deriveRetrospective } = await import('./taskLifecycle');
  const r = deriveRetrospective(makeNode({
    state: 'RUNNING', retryCount: 0, hadFailureOrCorrection: false,
  }));
  assert.equal(r.draft, null);
  assert.equal(r.requiresHumanReview, true);
  assert.match(r.reason, /Q5 红线/);
});

test('deriveRetrospective: 纯计算，不产生任何文件 IO、不写仓库根、不改 TeamAiAsset', async () => {
  const { deriveRetrospective } = await import('./taskLifecycle');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-test-'));
  try {
    const beforeEntries = fs.readdirSync(dir).sort();
    const beforeEventLines = countEventLogLines();
    const repoBefore = fs.existsSync(REPO_EVENT_LOG)
      ? fs.readFileSync(REPO_EVENT_LOG, 'utf-8')
      : null;

    const r = deriveRetrospective(makeNode({
      state: 'ESCALATED', retryCount: 3, hadFailureOrCorrection: true,
      lastErrorFeedback: '熔断：自动重试已达上限',
    }));

    assert.equal(r.requiresHumanReview, true);
    assert.equal(typeof r.draft, 'string', '草案只能是文本');
    assert.equal(
      fs.readdirSync(dir).sort().join(','),
      beforeEntries.join(','),
      '不得在目录内创建任何文件',
    );
    assert.equal(countEventLogLines(), beforeEventLines, '不得写旁路事件');
    assert.equal(
      fs.existsSync(REPO_EVENT_LOG) ? fs.readFileSync(REPO_EVENT_LOG, 'utf-8') : null,
      repoBefore,
      '不得写仓库根目录',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
