import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eventLog.ts 的 EVENT_FILE 是模块顶层基于 process.cwd() 计算的常量，
// append/replay 都不接受路径参数。为了让日志落到临时目录、绝不污染仓库根，
// 每个用例：chdir 到独立临时目录 -> 用带 query 的动态 import 重新加载模块
// （重置模块级 cachedLastSeq 与 EVENT_FILE）-> 断言 -> 恢复 cwd 并清理目录。
const REPO_ROOT = process.cwd();
const REPO_LOG = path.join(REPO_ROOT, '.superagent-events.jsonl');
let caseId = 0;

type EventLogModule = typeof import('./eventLog');

function freshEventLog(): Promise<EventLogModule> {
  const spec = `${new URL('./eventLog.ts', import.meta.url).href}?case=${++caseId}`;
  return import(spec) as Promise<EventLogModule>;
}

async function withFreshEventLog(
  fn: (ctx: {
    mod: EventLogModule;
    dir: string;
    logPath: string;
  }) => void | Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlog-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const mod = await freshEventLog();
    await fn({ mod, dir, logPath: path.join(dir, '.superagent-events.jsonl') });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('eventLog: 文件不存在时 lastEventSeq=0 / replay 返回空，且纯读不落盘、不改写仓库根日志', async () => {
  const repoLogBefore = fs.existsSync(REPO_LOG)
    ? fs.readFileSync(REPO_LOG, 'utf-8')
    : null;

  await withFreshEventLog(async ({ mod, logPath }) => {
    assert.equal(mod.lastEventSeq(), 0);
    assert.deepEqual(mod.replayRuntimeEvents(), []);
    assert.deepEqual(mod.replayRuntimeEvents('missing-trace'), []);
    assert.equal(fs.existsSync(logPath), false, '文件不存在时不应被读取操作创建');
  });

  const repoLogAfter = fs.existsSync(REPO_LOG)
    ? fs.readFileSync(REPO_LOG, 'utf-8')
    : null;
  assert.equal(
    repoLogAfter,
    repoLogBefore,
    '测试不得在仓库根目录写入 .superagent-events.jsonl',
  );
});

test('eventLog: 追加多条后 seq 连续无重复、append 不覆盖且事件结构完整', async () => {
  await withFreshEventLog(async ({ mod, logPath }) => {
    const e1 = mod.appendRuntimeEvent({ traceId: 'trace-A', type: 'started', detail: 'boot' });
    const e2 = mod.appendRuntimeEvent({ traceId: 'trace-A', type: 'progress', taskId: 'task-1' });
    const e3 = mod.appendRuntimeEvent({ traceId: 'trace-B', type: 'done', detail: 'finish' });

    assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
    assert.equal(new Set([e1.seq, e2.seq, e3.seq]).size, 3);
    assert.equal(mod.lastEventSeq(), 3);
    assert.equal(e1.traceId, 'trace-A');
    assert.equal(e1.type, 'started');
    assert.equal(e1.detail, 'boot');
    assert.equal(e2.taskId, 'task-1');
    assert.equal(e3.traceId, 'trace-B');
    assert.equal(Number.isNaN(Date.parse(e1.ts)), false, 'ts 应为合法 ISO 时间字符串');

    const lines = fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());
    assert.equal(lines.length, 3, '追加不覆盖：三条记录都应保留');
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as { seq: number }).seq),
      [1, 2, 3],
    );
  });
});

test('eventLog: 重新打开日志后序列号从文件恢复、读取顺序不变且续写连续', async () => {
  await withFreshEventLog(async ({ mod, dir, logPath }) => {
    mod.appendRuntimeEvent({ traceId: 't', type: 'a' });
    mod.appendRuntimeEvent({ traceId: 't', type: 'b' });

    // 模拟进程重启：同一临时目录下再次加载模块，cachedLastSeq 重新从文件恢复
    process.chdir(dir);
    const reopened = await freshEventLog();
    assert.equal(reopened.lastEventSeq(), 2);
    const replayed = reopened.replayRuntimeEvents();
    assert.deepEqual(replayed.map((event) => event.seq), [1, 2]);
    assert.deepEqual(replayed.map((event) => event.type), ['a', 'b']);

    const e3 = reopened.appendRuntimeEvent({ traceId: 't', type: 'c' });
    assert.equal(e3.seq, 3, '重新打开后从 max(seq)=2 续写，不覆盖旧行');
    assert.deepEqual(
      reopened.replayRuntimeEvents().map((event) => event.seq),
      [1, 2, 3],
    );
    assert.equal(
      fs
        .readFileSync(logPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim()).length,
      3,
    );
  });
});

test('eventLog: replay 按 seq 排序并跳过损坏行/空行', async () => {
  await withFreshEventLog(async ({ mod, logPath }) => {
    const makeLine = (seq: number, type: string) =>
      JSON.stringify({ seq, ts: '2026-01-01T00:00:00Z', traceId: 't', type });
    fs.writeFileSync(
      logPath,
      [
        makeLine(3, 'third'),
        'not-json-on-purpose',
        '',
        makeLine(1, 'first'),
        '   ',
        makeLine(2, 'second'),
      ].join('\n') + '\n',
      'utf-8',
    );

    // replay 是纯读，不依赖 append 的 cachedLastSeq
    const events = mod.replayRuntimeEvents();
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(events.map((event) => event.type), ['first', 'second', 'third']);
  });
});

test('eventLog: replay/lastEventSeq 为纯读操作，多次重放不向日志二次写入', async () => {
  await withFreshEventLog(async ({ mod, logPath }) => {
    mod.appendRuntimeEvent({ traceId: 't', type: 'a' });
    mod.appendRuntimeEvent({ traceId: 't', type: 'b' });
    const before = fs.readFileSync(logPath, 'utf-8');

    mod.replayRuntimeEvents();
    mod.replayRuntimeEvents('t');
    mod.replayRuntimeEvents('other');
    mod.lastEventSeq();

    const after = fs.readFileSync(logPath, 'utf-8');
    assert.equal(after, before, '重放不得追加任何行');
    assert.equal(after.split('\n').filter((line) => line.trim()).length, 2);
  });
});

test('eventLog: 空日志文件读取返回空数组', async () => {
  await withFreshEventLog(async ({ mod, logPath }) => {
    fs.writeFileSync(logPath, '', 'utf-8');
    assert.deepEqual(mod.replayRuntimeEvents(), []);
    assert.deepEqual(mod.replayRuntimeEvents('t'), []);
  });
});
