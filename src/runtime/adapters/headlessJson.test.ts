import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createHeadlessJsonAdapter, createSessionSeq } from './headlessJson';
import { OfflineSeqQueue, parseCliNdjsonLine } from '../../daemon/ndjsonParser';
import { detectDangerousCommand } from '../../policy/engine';
import type { DaemonEnvelope, NormalizedAgentEvent } from '../../protocol';

// headlessJson.ts 导出 createHeadlessJsonAdapter / HeadlessJsonAdapterOptions /
// createSessionSeq（按会话的 seq 计数器），不 re-export parser/queue。NDJSON 解析、
// 脱敏、危险命令拦截是它 import 的 parseCliNdjsonLine（以及其依赖的 stateMachine
// 规则）真实行为；OfflineSeqQueue 真实存在于 ndjsonParser.ts。以下从各自真实模块
// 导入并断言，不臆造 API。

test('headlessJson: createHeadlessJsonAdapter 暴露约定的 provider/mode 与完整 Adapter 方法', () => {
  const defaultAdapter = createHeadlessJsonAdapter();
  assert.equal(defaultAdapter.provider, 'claude-code');
  assert.equal(defaultAdapter.mode, 'headless-json');

  const codexAdapter = createHeadlessJsonAdapter({ provider: 'codex' });
  assert.equal(codexAdapter.provider, 'codex');
  assert.equal(codexAdapter.mode, 'headless-json');

  const methods = ['spawn', 'onEvent', 'sendInput', 'approveTool', 'terminate'] as const;
  for (const method of methods) {
    assert.equal(typeof codexAdapter[method], 'function');
  }
});

test('headlessJson: approveTool 在无审批通道时降级为 thought 事件（不依赖子进程）', async () => {
  const adapter = createHeadlessJsonAdapter({ provider: 'workbuddy' });
  const events: NormalizedAgentEvent[] = [];
  adapter.onEvent((event) => events.push(event));

  await adapter.approveTool('session-1', 'call-1', true);

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'thought');
  if (event.type === 'thought') {
    assert.ok(event.content.includes('无工具审批通道'));
    assert.ok(event.content.includes('call-1'));
    assert.ok(event.content.includes('approved'));
  }
});

test('headlessJson: 合法 NDJSON 行归一化为 AgentReasoningEvent 且 sk- 密钥被脱敏', () => {
  const line = JSON.stringify({
    type: 'message',
    content: 'hello sk-live1234567890abcdef world',
  });
  const parsed = parseCliNdjsonLine('codex', line, 7, '00:00:07');

  assert.equal(parsed.dangerIntercept, undefined);
  assert.ok(parsed.event);
  const event = parsed.event;
  assert.equal(event.id, 'ev-7');
  assert.equal(event.seq, 7);
  assert.equal(event.ts, '00:00:07');
  assert.equal(event.kind, 'thought');
  assert.equal(event.status, 'ok');
  assert.equal(event.redactedHits, 1);
  assert.equal(event.detail.includes('sk-live'), false);
  assert.ok(event.detail.includes('[REDACTED_API_KEY]'));
  assert.ok(parsed.terminalChunk?.includes('[REDACTED_API_KEY]'));
  assert.equal(parsed.terminalChunk?.includes('sk-live'), false);
});

test('headlessJson: 非法 JSON 行容错降级为 terminalChunk 且其中的密钥同样脱敏', () => {
  const broken = parseCliNdjsonLine('workbuddy', 'plain log sk-abcdefghijklmnop end', 1);
  assert.equal(broken.event, undefined);
  assert.equal(broken.dangerIntercept, undefined);
  const chunk = broken.terminalChunk;
  assert.ok(chunk);
  assert.equal(chunk.includes('sk-abcdefghijklmnop'), false);
  assert.ok(chunk.includes('[REDACTED_API_KEY]'));

  assert.deepEqual(parseCliNdjsonLine('codex', '', 2), {});
  assert.deepEqual(parseCliNdjsonLine('codex', '   ', 3), {});
});

test('headlessJson: 危险命令按 stateMachine 真实规则拦截 (NO_ROOT_DELETE / NO_DESTRUCTIVE_SQL / SENSITIVE_PATH_GUARD)', () => {
  // 先核对真实规则，不猜正则
  assert.equal(detectDangerousCommand('rm -rf /').dangerous, true);
  assert.equal(detectDangerousCommand('rm -rf /').rule, 'NO_ROOT_DELETE');
  assert.equal(detectDangerousCommand('DROP TABLE task_nodes;').rule, 'NO_DESTRUCTIVE_SQL');
  assert.equal(detectDangerousCommand('cat .env.production').rule, 'SENSITIVE_PATH_GUARD');
  assert.equal(detectDangerousCommand('npm run test').dangerous, false);

  const rootDelete = parseCliNdjsonLine(
    'codex',
    JSON.stringify({ type: 'shell_exec', command: 'rm -rf /' }),
    9,
  );
  const intercept = rootDelete.dangerIntercept;
  assert.ok(intercept);
  assert.equal(intercept.rule, 'NO_ROOT_DELETE');
  assert.equal(intercept.command, 'rm -rf /');
  assert.equal(rootDelete.event?.kind, 'acp_intercept');
  assert.equal(rootDelete.event?.status, 'blocked');
  assert.ok(rootDelete.terminalChunk?.includes('BLOCKED'));

  // command 字段触发拦截：即使 type 不是 shell 也进入 Danger Gate
  const sql = parseCliNdjsonLine(
    'workbuddy',
    JSON.stringify({ type: 'message', command: 'DROP TABLE users;' }),
    10,
  );
  assert.equal(sql.dangerIntercept?.rule, 'NO_DESTRUCTIVE_SQL');
  assert.equal(sql.event?.status, 'blocked');
});

test('headlessJson: NDJSON 输出中的 ghp_ / Bearer 凭据被脱敏并统计命中数', () => {
  const line = JSON.stringify({
    type: 'message',
    content: 'token ghp_abcdefghijklmnopqrst and Bearer abcdefghijklmnop1234',
  });
  const parsed = parseCliNdjsonLine('codex', line, 3);

  assert.ok(parsed.event);
  const event = parsed.event;
  assert.equal(event.redactedHits, 2);
  assert.equal(event.detail.includes('ghp_abcdefghijklmnopqrst'), false);
  assert.equal(event.detail.includes('abcdefghijklmnop1234'), false);
  assert.ok(event.detail.includes('[REDACTED_GH_TOKEN]'));
  assert.ok(event.detail.includes('[REDACTED_BEARER_TOKEN]'));
});

test('headlessJson: adapter spawn 真实 CLI NDJSON → 归一化事件、脱敏、file_edit 映射为 thought', async () => {
  const lines = [
    { type: 'message', content: 'hello sk-live1234567890abcdef' },
    { type: 'file_edit', content: 'edited a.ts' },
  ];
  const script = `for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + String.fromCharCode(10));`;
  const adapter = createHeadlessJsonAdapter({
    provider: 'codex',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
  });

  const stdoutChunks: string[] = [];
  const thoughts: string[] = [];
  let completed: number | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  adapter.onEvent((event) => {
    if (event.type === 'terminal_chunk' && event.stream === 'stdout') {
      stdoutChunks.push(event.data);
    } else if (event.type === 'thought') {
      thoughts.push(event.content);
    } else if (event.type === 'completed') {
      completed = event.exitCode;
      resolveDone();
    }
  });

  await adapter.spawn({
    taskId: 'task-e2e-1',
    worktreePath: os.tmpdir(),
    prompt: 'hello',
    systemRulesPath: '',
    env: {},
  });
  await done;

  assert.equal(completed, 0);
  assert.ok(stdoutChunks.some((data) => data.includes('[REDACTED_API_KEY]')));
  assert.equal(
    stdoutChunks.some((data) => data.includes('sk-live')),
    false,
    '密钥不得泄漏到 stdout 事件',
  );
  assert.ok(thoughts.includes('edited a.ts'), 'file_edit 行应映射为 thought 事件');
});

test('headlessJson: adapter spawn 遇到高危命令 → 下发 [blocked] thought 并终止会话', async () => {
  const lines = [{ type: 'shell_exec', command: 'rm -rf /' }];
  const script = `for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + String.fromCharCode(10));`;
  const adapter = createHeadlessJsonAdapter({
    provider: 'codex',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
  });

  const thoughts: string[] = [];
  const stdoutChunks: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  adapter.onEvent((event) => {
    if (event.type === 'thought') {
      thoughts.push(event.content);
    } else if (event.type === 'terminal_chunk' && event.stream === 'stdout') {
      stdoutChunks.push(event.data);
    } else if (event.type === 'completed') {
      resolveDone();
    }
  });

  await adapter.spawn({
    taskId: 'task-e2e-2',
    worktreePath: os.tmpdir(),
    prompt: 'cleanup',
    systemRulesPath: '',
    env: {},
  });
  await done;

  assert.ok(thoughts.some((content) => content.startsWith('[blocked]')));
  assert.ok(thoughts.some((content) => content.includes('rm -rf /')));
  assert.equal(
    stdoutChunks.some((data) => data.includes('rm -rf /')),
    false,
    '被拦截的命令不得作为 terminal_chunk 下发',
  );
});

test('headlessJson: OfflineSeqQueue 去重 seq / ackUpTo 单调 / replayFrom 严格大于', () => {
  const envelope = (seq: number): DaemonEnvelope => ({
    machineId: 'm1',
    seq,
    ts: seq,
    payload: { type: 'HEARTBEAT', activeTaskIds: [], cpuLoad: 0 },
  });

  const queue = new OfflineSeqQueue(5);
  queue.enqueue(envelope(6));
  queue.enqueue(envelope(6)); // 重复 seq 只入队一次
  queue.enqueue(envelope(4)); // <= lastAckSeq 直接丢弃
  queue.enqueue(envelope(8));
  queue.enqueue(envelope(7)); // 乱序入队后按 seq 排序

  assert.equal(queue.pendingCount(), 3);
  assert.deepEqual(queue.replayFrom(0).map((item) => item.seq), [6, 7, 8]);
  assert.deepEqual(
    queue.replayFrom(6).map((item) => item.seq),
    [7, 8],
    'replayFrom 严格大于远端 lastAckSeq',
  );

  queue.ackUpTo(3); // 不允许回退 lastAckSeq
  assert.equal(queue.pendingCount(), 3);
  assert.deepEqual(queue.replayFrom(5).map((item) => item.seq), [6, 7, 8]);

  queue.ackUpTo(7);
  assert.equal(queue.pendingCount(), 1);
  assert.deepEqual(queue.replayFrom(7).map((item) => item.seq), [8]);

  queue.enqueue(envelope(7)); // <= lastAckSeq=7 再次丢弃
  assert.equal(queue.pendingCount(), 1);

  queue.ackUpTo(8);
  assert.equal(queue.pendingCount(), 0);
  assert.deepEqual(queue.replayFrom(0), []);
});

test('headlessJson: onEvent 支持多 listener，先注册的不被覆盖且单个抛错被隔离', async () => {
  const adapter = createHeadlessJsonAdapter();
  const seen: string[] = [];
  adapter.onEvent((event) => seen.push(`first:${event.type}`));
  adapter.onEvent(() => {
    throw new Error('listener boom');
  });
  adapter.onEvent((event) => seen.push(`third:${event.type}`));

  await adapter.approveTool('session-1', 'call-1', true);

  assert.deepEqual(
    seen,
    ['first:thought', 'third:thought'],
    '三个 listener 都应被调用；中间的抛错不阻断其余，且后注册不覆盖先注册',
  );
});

test('headlessJson: 两个 spawn 的 seq 各自从 1 开始（按 sessionId 独立计数）', () => {
  // 先核对 parseCliNdjsonLine 把 seq 真实编码进事件
  assert.equal(parseCliNdjsonLine('codex', '{}', 1).event?.id, 'ev-1');
  assert.equal(parseCliNdjsonLine('codex', '{}', 1).event?.seq, 1);
  assert.equal(parseCliNdjsonLine('codex', '{}', 2).event?.id, 'ev-2');

  // adapter 每个 spawn 使用的按会话计数器：两个独立 spawn 各自从 1 开始
  const spawnA = createSessionSeq();
  const spawnB = createSessionSeq();
  assert.equal(spawnA('task-A'), 1);
  assert.equal(spawnA('task-A'), 2);
  assert.equal(spawnB('task-B'), 1, '第二个 spawn 起点同样为 1，不共享实例级全局 seq');
  assert.equal(spawnB('task-B'), 2);
  assert.equal(spawnA('task-A'), 3);
});

test('headlessJson: 同一 adapter 两次 spawn 各自独立运行、互不串扰', async () => {
  const lines = [{ type: 'message', content: 'ping' }];
  const script = `for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + String.fromCharCode(10));`;
  const adapter = createHeadlessJsonAdapter({
    provider: 'codex',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
  });

  let stdoutChunks = 0;
  let completed = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  adapter.onEvent((event) => {
    if (event.type === 'terminal_chunk' && event.stream === 'stdout') {
      stdoutChunks += 1;
    } else if (event.type === 'completed') {
      completed += 1;
      if (completed === 2) resolveDone();
    }
  });

  await adapter.spawn({
    taskId: 'task-multi-1',
    worktreePath: os.tmpdir(),
    prompt: '',
    systemRulesPath: '',
    env: {},
  });
  await adapter.spawn({
    taskId: 'task-multi-2',
    worktreePath: os.tmpdir(),
    prompt: '',
    systemRulesPath: '',
    env: {},
  });
  await done;

  assert.equal(completed, 2, '两个会话都应各自收到 completed');
  assert.equal(stdoutChunks, 2, '两个会话各自的 NDJSON 行都下发，互不丢失');
});

test('headlessJson: stderr 原始输出先经 redactSecrets 脱敏再 emit', async () => {
  const script = `process.stderr.write('fatal sk-live1234567890abcdef boom' + String.fromCharCode(10));`;
  const adapter = createHeadlessJsonAdapter({
    provider: 'workbuddy',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
  });

  const stderrChunks: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  adapter.onEvent((event) => {
    if (event.type === 'terminal_chunk' && event.stream === 'stderr') {
      stderrChunks.push(event.data);
      resolveDone();
    }
  });

  await adapter.spawn({
    taskId: 'task-stderr-1',
    worktreePath: os.tmpdir(),
    prompt: '',
    systemRulesPath: '',
    env: {},
  });
  await done;

  assert.ok(stderrChunks.length >= 1, 'stderr 应产生 terminal_chunk 事件');
  assert.ok(stderrChunks.some((data) => data.includes('[REDACTED_API_KEY]')));
  assert.equal(
    stderrChunks.some((data) => data.includes('sk-live')),
    false,
    'stderr 密钥不得原样下发',
  );
});

test('headlessJson: adapter spawn 收到非法 JSON 纯文本高危命令 → 同样 [blocked] 拦截', async () => {
  const script = `process.stdout.write('rm -rf /' + String.fromCharCode(10));`;
  const adapter = createHeadlessJsonAdapter({
    provider: 'workbuddy',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
  });

  const thoughts: string[] = [];
  const stdoutChunks: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  adapter.onEvent((event) => {
    if (event.type === 'thought') {
      thoughts.push(event.content);
    } else if (event.type === 'terminal_chunk' && event.stream === 'stdout') {
      stdoutChunks.push(event.data);
    } else if (event.type === 'completed') {
      resolveDone();
    }
  });

  await adapter.spawn({
    taskId: 'task-plain-danger',
    worktreePath: os.tmpdir(),
    prompt: '',
    systemRulesPath: '',
    env: {},
  });
  await done;

  assert.ok(thoughts.some((content) => content.startsWith('[blocked]')), '纯文本高危命令必须被拦截');
  assert.ok(thoughts.some((content) => content.includes('rm -rf /')));
  assert.equal(
    stdoutChunks.some((data) => data.includes('rm -rf /')),
    false,
    '被拦截的命令不得作为 stdout terminal_chunk 下发',
  );
});
