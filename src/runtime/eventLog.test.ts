import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from './eventLog';

/**
 * 事件日志工厂测试（S1-1 遗留缺口修复后）。
 * 收敛前 EVENT_FILE 是模块级 cwd 常量，测试要靠 chdir + 动态 import 绕开；
 * 现在实例路径由构造注入，直接建临时目录实例断言，全程不碰仓库根。
 */
const REPO_ROOT = process.cwd();
const REPO_LOG = path.join(REPO_ROOT, '.superagent-events.jsonl');

function snapshotRepoLog(): string | null {
  return fs.existsSync(REPO_LOG) ? fs.readFileSync(REPO_LOG, 'utf-8') : null;
}

function withEventLog(fn: (log: ReturnType<typeof createEventLog>, dir: string, logPath: string) => void): void {
  const before = snapshotRepoLog();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlog-test-'));
  const logPath = path.join(dir, '.superagent-events.jsonl');
  try {
    fn(createEventLog({ path: logPath }), dir, logPath);
    assert.equal(snapshotRepoLog(), before, '测试全程不得改写仓库根 .superagent-events.jsonl');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('eventLog: 文件不存在时 lastSeq=0 / replay 空，且纯读不落盘', () => {
  withEventLog((log, _dir, logPath) => {
    assert.equal(log.lastSeq(), 0);
    assert.deepEqual(log.replay(), []);
    assert.deepEqual(log.replay('missing-trace'), []);
    assert.equal(fs.existsSync(logPath), false, '读取操作不得创建文件');
  });
});

test('eventLog: append 分配严格递增 seq 并返回落盘事件', () => {
  withEventLog((log, _dir, logPath) => {
    const e1 = log.append({ traceId: 't-1', type: 'SPAWN', taskId: 'task-1', detail: 'd' });
    const e2 = log.append({ traceId: 't-1', type: 'AGENT_EVENT', taskId: 'task-1' });
    const e3 = log.append({ traceId: 't-2', type: 'VERIFY_RESULT', taskId: 'task-2' });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 3);
    assert.equal(Number.isNaN(Date.parse(e1.ts)), false);
    assert.equal(log.lastSeq(), 3);

    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3);
    for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['detail', 'seq', 'taskId', 'traceId', 'ts', 'type'].filter((k) => k !== 'detail' || line.includes('detail')));
  });
});

test('eventLog: replay 全量与按 traceId 过滤', () => {
  withEventLog((log) => {
    log.append({ traceId: 't-1', type: 'SPAWN' });
    log.append({ traceId: 't-1', type: 'AGENT_EVENT' });
    log.append({ traceId: 't-2', type: 'VERIFY_RESULT' });
    assert.equal(log.replay().length, 3);
    const t1 = log.replay('t-1');
    assert.equal(t1.length, 2);
    assert.ok(t1.every((e) => e.traceId === 't-1'));
  });
});

test('eventLog: 外部追加后 seq 实时感知（seq 从文件真实 max 重算）', () => {
  withEventLog((log, _dir, logPath) => {
    log.append({ traceId: 't-1', type: 'SPAWN' });
    // 模拟另一进程直接追加一条 seq=99 的合法行
    fs.appendFileSync(logPath, `${JSON.stringify({ seq: 99, ts: new Date().toISOString(), traceId: 't-ext', type: 'EXTERNAL' })}\n`);
    assert.equal(log.lastSeq(), 99);
    const next = log.append({ traceId: 't-1', type: 'AGENT_EVENT' });
    assert.equal(next.seq, 100, '外部追加后新事件 seq 必须接续真实 max');
    assert.equal(log.replay('t-ext').length, 1);
  });
});

test('eventLog: 损坏行被跳过且不阻断（append/replay/lastSeq 均容忍）', () => {
  withEventLog((log, _dir, logPath) => {
    log.append({ traceId: 't-1', type: 'SPAWN' });
    fs.appendFileSync(logPath, 'this is { corrupted\n\n');
    log.append({ traceId: 't-2', type: 'VERIFY_RESULT' });
    assert.equal(log.lastSeq(), 2, '损坏行不参与 max seq');
    const events = log.replay();
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => typeof e.seq === 'number'));
  });
});

test('eventLog: filePath 只读属性暴露实例绑定路径', () => {
  withEventLog((log, _dir, logPath) => {
    assert.equal(log.filePath, logPath);
  });
});
