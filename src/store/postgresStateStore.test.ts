import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createInitialSeedState, type PlatformState } from '../data/seed';
import { createPostgresStateStore } from './postgresStateStore';

/**
 * PostgresStateStore 契约测试（S1-2）。
 *
 * 运行条件：默认经 docker exec 连本机 superagent-pg 容器（postgres:16-alpine，
 * 见 docs/decision-log.md D-13 与 .env.example 的 SUPERAGENT_PG_CMD）。
 * 不可达时整套 skip——不伪造通过，也不拖累无 PG 环境的 npm test。
 */
const PG_CMD = ['docker', 'exec', '-i', 'superagent-pg', 'psql', '-U', 'superagent', '-d', 'superagent'];

const probe = spawnSync(PG_CMD[0], [...PG_CMD.slice(1), '-t', '-A', '-c', 'SELECT 1'], {
  encoding: 'utf-8',
  timeout: 5_000,
});
const pgAvailable = probe.status === 0 && probe.stdout.trim() === '1';
const skipReason = pgAvailable ? false : '本机无可用 PostgreSQL（superagent-pg 容器未运行）';

function freshStore(prefix: string) {
  const store = createPostgresStateStore({ command: PG_CMD, tablePrefix: prefix });
  store.init();
  const [, ...rest] = PG_CMD;
  // 清表，保证用例独立
  spawnSync(PG_CMD[0], [...rest, '-q', '-c', `DELETE FROM ${prefix}_state; DELETE FROM ${prefix}_commands;`], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  return store;
}

describe('PostgresStateStore 契约', { skip: skipReason }, () => {
  test('空库 load 返回 null；建表幂等（init 可重复调用）', () => {
    const s = freshStore('sat1');
    s.init();
    assert.equal(s.load(), null);
  });

  test('save/load 往返保真（含 sopTemplates 可选字段）', () => {
    const s = freshStore('sat2');
    const state: PlatformState = createInitialSeedState();
    state.sopTemplates = [{ id: 'sop-x', title: 't', description: 'd', version: 1, sourceReqId: 'r', steps: [] }];
    s.save(state);
    const loaded = s.load();
    assert.ok(loaded);
    assert.equal(loaded.requirements.length, state.requirements.length);
    assert.equal(loaded.tasks.length, state.tasks.length);
    assert.equal(loaded.sopTemplates?.[0]?.id, 'sop-x');
    // 再 save 一版，读到的是新快照（upsert 生效）
    state.requirements = [];
    s.save(state);
    assert.equal(s.load()?.requirements.length, 0);
  });

  test('结构无效快照（合法 JSON 但缺 requirements/tasks）load 抛错，不静默回退', () => {
    const s = freshStore('sat3');
    const [, ...rest] = PG_CMD;
    spawnSync(PG_CMD[0], [...rest, '-q', '-c', `INSERT INTO sat3_state (id, snapshot) VALUES (1, '{"foo":1}'::jsonb)`], { encoding: 'utf-8' });
    assert.throws(() => s.load(), /结构无效|requirements/);
  });

  test('appendCommand：首提 accepted、重复 duplicate 且不二次写入、seq 递增', () => {
    const s = freshStore('sat4');
    const a = s.appendCommand('cmd-1', 'POST /x', { n: 1 });
    assert.deepEqual([a.accepted, a.duplicate], [true, false]);
    const b = s.appendCommand('cmd-1', 'POST /x', { n: 1 });
    assert.deepEqual([b.accepted, b.duplicate], [false, true]);
    assert.ok(b.reason?.includes('已存在'));
    s.appendCommand('cmd-2', 'POST /y', undefined);
    const records = s.replayCommands();
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.appliedSeq), [1, 2]);
    assert.equal(s.lastAppliedSeq(), 2);
    assert.equal(records[0].commandId, 'cmd-1');
    assert.equal((records[0].payload as { n: number }).n, 1);
  });

  test('命令内容含引号/美元符/dollar-quote 样式也不逃逸（注入面封死）', () => {
    const s = freshStore('sat5');
    const evil = `cmd'); DROP TABLE sat5_commands; -- $sa$ $x$`;
    const r = s.appendCommand(evil, 'k ${injection}', { s: "\'\"}" });
    assert.equal(r.accepted, true);
    assert.equal(s.replayCommands().length, 1);
    assert.equal(s.replayCommands()[0].commandId, evil);
  });

  test('tablePrefix 隔离：两套前缀互不可见', () => {
    const a = freshStore('sat6a');
    const b = freshStore('sat6b');
    a.appendCommand('only-a', 'k', null);
    assert.equal(a.replayCommands().length, 1);
    assert.equal(b.replayCommands().length, 0);
  });

  test('psql 前缀不可达时显式抛错（不静默成功）', () => {
    const bad = createPostgresStateStore({ command: ['definitely-not-a-bin', 'psql'], tablePrefix: 'sat7' });
    assert.throws(() => bad.load(), /SQL 执行失败/);
  });
});
