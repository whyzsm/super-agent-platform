import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStateStore } from './fileStateStore';
import { createInitialSeedState } from '../data/seed';

type Store = ReturnType<typeof createFileStateStore>;

/** 每个用例独立临时目录，结束强制清理，绝不写仓库根目录。 */
function withTempStore(
  fn: (ctx: {
    dir: string;
    statePath: string;
    logPath: string;
    store: Store;
  }) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestatestore-test-'));
  try {
    const statePath = path.join(dir, 'state.json');
    const logPath = path.join(dir, 'commands.jsonl');
    fn({ dir, statePath, logPath, store: createFileStateStore({ statePath, logPath }) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const validLine = (
  seq: number,
  commandId = `cmd-${seq}`,
  kind = 'kind',
): string =>
  JSON.stringify({
    commandId,
    appliedSeq: seq,
    ts: '2026-01-01T00:00:00Z',
    kind,
    payload: { seq },
  });

test('load(): 状态文件不存在返回 null，且纯读不创建任何文件', () => {
  withTempStore(({ statePath, logPath, store }) => {
    assert.equal(store.load(), null);
    assert.equal(fs.existsSync(statePath), false, 'load 不应创建状态文件');
    assert.equal(fs.existsSync(logPath), false, 'load 不应创建日志文件');
  });
});

test('save(): 原子写——同目录 .tmp-<随机> 临时文件经 rename 覆盖，无残留且目标完整', () => {
  withTempStore(({ dir, statePath, store }) => {
    const state = createInitialSeedState();

    // 观察 renameSync 入参，验证"同目录临时文件 -> 覆盖目标"的原子写机制。
    const mutableFs = fs as unknown as {
      renameSync: (from: string, to: string) => void;
    };
    const originalRename = mutableFs.renameSync;
    const calls: Array<{ from: string; to: string }> = [];
    mutableFs.renameSync = (from, to) => {
      calls.push({ from, to });
      originalRename(from, to);
    };
    try {
      store.save(state);
    } finally {
      mutableFs.renameSync = originalRename;
    }

    assert.equal(calls.length, 1, 'save 应恰好执行一次 rename 覆盖');
    assert.equal(calls[0].to, statePath);
    assert.ok(
      calls[0].from.startsWith(`${statePath}.tmp-`),
      `临时文件应形如 ${statePath}.tmp-<随机>，实际为 ${calls[0].from}`,
    );
    assert.ok(
      calls[0].from.length > `${statePath}.tmp-`.length,
      '临时文件名应带随机后缀，避免并发冲突',
    );
    assert.equal(
      path.dirname(calls[0].from),
      path.dirname(statePath),
      '临时文件须与目标同目录，rename 才是同一文件系统内的原子替换',
    );
    assert.equal(fs.existsSync(calls[0].from), false, '临时文件应已被清理');

    // 目标文件完整、可解析，绝不半写。
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf-8')), state);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes('.tmp-')),
      [],
      'save 后不应残留任何 .tmp- 临时文件',
    );
  });
});

test('save→load 往返字段完整（真实 seed 的 5 个数组逐一一致）', () => {
  withTempStore(({ store }) => {
    const state = createInitialSeedState();
    store.save(state);
    const loaded = store.load();
    assert.ok(loaded, 'load 应返回快照');
    assert.deepEqual(loaded.requirements, state.requirements);
    assert.deepEqual(loaded.tasks, state.tasks);
    assert.deepEqual(loaded.daemons, state.daemons);
    assert.deepEqual(loaded.memories, state.memories);
    assert.deepEqual(loaded.teamAiAssets, state.teamAiAssets);
    assert.equal(loaded.requirements.length, 3);
    assert.equal(loaded.tasks.length, 8);
    assert.equal(loaded.daemons.length, 3);
    assert.equal(loaded.memories.length, 5);
    assert.equal(loaded.teamAiAssets.length, 4);
  });
});

test('两次 save 后 load 是最后一次写入的快照', () => {
  withTempStore(({ statePath, store }) => {
    const first = createInitialSeedState();
    const second = createInitialSeedState();
    second.requirements = [
      {
        id: 'req-new',
        teamId: 'team-x',
        title: '新需求',
        specMd: '',
        repoUrl: '',
        baseBranch: 'main',
        sourceChannel: 'cli',
        status: 'PLANNING',
        createdBy: 'tester',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    store.save(first);
    store.save(second);

    assert.deepEqual(store.load(), second, 'load 必须是最后一次 save 的内容');
    assert.notDeepEqual(store.load(), first, '不得残留第一次 save 的内容');
    // 目标文件恰好是 second 的完整序列化，没有拼接/半写。
    assert.equal(
      fs.readFileSync(statePath, 'utf-8'),
      JSON.stringify(second, null, 2),
    );
  });
});

test('load(): 合法 JSON 且含 requirements/tasks 两个数组即作为 PlatformState 返回', () => {
  withTempStore(({ statePath, store }) => {
    const minimal = {
      requirements: [{ id: 'r1' }],
      tasks: [{ id: 't1' }],
      extraField: 'keep-me',
    };
    fs.writeFileSync(statePath, JSON.stringify(minimal), 'utf-8');
    const loaded = store.load();
    assert.deepEqual(loaded, minimal, '应原样返回解析结果，含额外字段');
    assert.ok(Array.isArray(loaded?.requirements));
    assert.ok(Array.isArray(loaded?.tasks));
  });
});

test('load(): 损坏 JSON 抛带明确 message 的 Error，绝不静默回退', () => {
  withTempStore(({ statePath, store }) => {
    fs.writeFileSync(statePath, '{"requirements": [ {"id": "half"', 'utf-8');
    assert.throws(
      () => store.load(),
      (err: unknown) => {
        assert.ok(err instanceof Error, '应抛出 Error 实例');
        assert.match(err.message, /损坏|JSON/, 'message 应明确说明 JSON 损坏');
        assert.match(err.message, /state\.json/, 'message 应带上出问题的文件路径');
        return true;
      },
    );
    // 不得退化成 null 或 seed：load 的结果只能是抛错或完整快照。
    assert.equal(fs.existsSync(statePath), true, 'load 不得删除或改写损坏文件');
  });
});

test('load(): 合法 JSON 但缺 requirements/tasks 数组时抛结构无效 Error', () => {
  withTempStore(({ statePath, store }) => {
    fs.writeFileSync(statePath, JSON.stringify({ requirements: [], foo: 1 }), 'utf-8');
    assert.throws(
      () => store.load(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /结构无效|requirements|tasks/);
        return true;
      },
    );
  });
});

test('appendCommand(): 多行 append-only，seq 严格递增，每行是完整可解析 JSON', () => {
  withTempStore(({ logPath, store }) => {
    const r1 = store.appendCommand('c1', 'create', { x: 1 });
    assert.deepEqual(r1, { accepted: true, duplicate: false });
    store.appendCommand('c2', 'update', { x: 2 });
    store.appendCommand('c3', 'delete', { x: 3 });

    const replay = store.replayCommands();
    assert.deepEqual(replay.map((r) => r.commandId), ['c1', 'c2', 'c3']);
    assert.deepEqual(replay.map((r) => r.appliedSeq), [1, 2, 3], 'seq 严格递增');
    assert.deepEqual(replay.map((r) => r.kind), ['create', 'update', 'delete']);
    assert.deepEqual(replay[0].payload, { x: 1 });
    for (const r of replay) {
      assert.equal(Number.isNaN(Date.parse(r.ts)), false, 'ts 应为合法 ISO 时间');
    }

    // 命令日志每行一条完整 JSON，均可独立解析。
    const lines = fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      assert.equal(typeof obj.commandId, 'string');
      assert.equal(typeof obj.appliedSeq, 'number');
      assert.equal(typeof obj.kind, 'string');
      assert.equal(typeof obj.ts, 'string');
      assert.ok('payload' in obj);
    }
  });
});

test('appendCommand(): commandId 去重——重复提交返回 duplicate 且不重复追加', () => {
  withTempStore(({ logPath, store }) => {
    assert.deepEqual(store.appendCommand('dup', 'k', { a: 1 }), {
      accepted: true,
      duplicate: false,
    });
    const before = fs.readFileSync(logPath, 'utf-8');

    const dup = store.appendCommand('dup', 'k', { a: 2 });
    assert.equal(dup.accepted, false);
    assert.equal(dup.duplicate, true);
    assert.equal(typeof dup.reason, 'string', '应给出明确 reason');

    assert.equal(fs.readFileSync(logPath, 'utf-8'), before, '重复提交不得追加任何字节');
    assert.equal(store.lastAppliedSeq(), 1);
    assert.equal(store.replayCommands().length, 1);
  });
});

test('appendCommand(): 每次从日志真实 max 计算 seq，外部追加后不重复', () => {
  withTempStore(({ logPath, store }) => {
    store.appendCommand('c1', 'k', {}); // seq 1

    // 模拟外部进程/另一实例向同一日志追加了更高 seq 的合法记录。
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        commandId: 'external',
        appliedSeq: 50,
        ts: '2026-01-01T00:00:00Z',
        kind: 'external',
        payload: null,
      })}\n`,
      'utf-8',
    );

    const res = store.appendCommand('c2', 'k', {});
    assert.equal(res.accepted, true);
    assert.equal(store.lastAppliedSeq(), 51, '必须从真实 max(50) 续写，不缓存旧 seq');
    assert.deepEqual(
      store.replayCommands().map((r) => r.appliedSeq),
      [1, 50, 51],
      'seq 集合无重复且与外部记录不冲突',
    );
  });
});

test('replayCommands(): 按 appliedSeq 升序、跳过损坏/缺字段行、纯读不改写日志', () => {
  withTempStore(({ logPath, store }) => {
    fs.writeFileSync(
      logPath,
      [
        validLine(3, 'c3'),
        'THIS-IS-CORRUPT-{',
        validLine(1, 'c1'),
        JSON.stringify({ commandId: 'no-kind', appliedSeq: 9, ts: 'x', payload: {} }),
        '   ',
        validLine(2, 'c2'),
        JSON.stringify({ appliedSeq: 8, ts: 'x', kind: 'k', payload: {} }),
        '',
      ].join('\n') + '\n',
      'utf-8',
    );

    const before = fs.readFileSync(logPath, 'utf-8');
    const replay = store.replayCommands();
    assert.deepEqual(replay.map((r) => r.appliedSeq), [1, 2, 3], '按 seq 升序');
    assert.deepEqual(replay.map((r) => r.commandId), ['c1', 'c2', 'c3']);
    assert.equal(
      replay.every((r) => r.commandId !== 'no-kind'),
      true,
      '缺 kind 的行应被跳过',
    );

    // 纯读：多次重放不追加、不修复、不改写。
    store.replayCommands();
    store.replayCommands();
    assert.equal(fs.readFileSync(logPath, 'utf-8'), before, '重放不得改写日志任何字节');
  });
});

test('lastAppliedSeq(): 日志不存在返回 0；末尾损坏行仍能返回最后一条合法记录的 seq', () => {
  withTempStore(({ logPath, store }) => {
    assert.equal(store.lastAppliedSeq(), 0, '日志不存在应返回 0');

    fs.writeFileSync(
      logPath,
      `${validLine(1)}\n${validLine(2)}\n{"commandId":"c3","appliedSeq":3,"kind":`,
      'utf-8',
    );
    assert.equal(store.lastAppliedSeq(), 2, '应忽略末尾不完整行，返回最后合法 seq');
  });
});

test('崩溃恢复: 残留 tmp + 日志尾部不完整 JSON 时，快照可读、命令可重放、新 seq 不冲突', () => {
  withTempStore(({ statePath, logPath, store }) => {
    const snapshot = createInitialSeedState();
    store.save(snapshot);
    store.appendCommand('cmd-1', 'create', { x: 1 });
    store.appendCommand('cmd-2', 'update', { x: 2 });

    // 模拟崩溃：残留一个未清理的临时文件，且日志末尾写了一行不完整 JSON（无换行）。
    fs.writeFileSync(`${statePath}.tmp-deadbeef`, '{"half":', 'utf-8');
    fs.appendFileSync(
      logPath,
      '{"commandId":"cmd-3","appliedSeq":3,"ts":"x","kind":"half","payload":',
      'utf-8',
    );

    // 恢复：上一次完整快照仍可读，且不受残留 tmp 影响。
    assert.deepEqual(store.load(), snapshot);

    const replayed = store.replayCommands();
    assert.deepEqual(replayed.map((r) => r.commandId), ['cmd-1', 'cmd-2']);
    assert.equal(store.lastAppliedSeq(), 2);

    const res = store.appendCommand('cmd-4', 'recover', {});
    assert.equal(res.accepted, true);

    const after = store.replayCommands();
    assert.deepEqual(after.map((r) => r.commandId), ['cmd-1', 'cmd-2', 'cmd-4']);
    assert.deepEqual(after.map((r) => r.appliedSeq), [1, 2, 3], '新 seq 不与合法记录冲突');
    assert.equal(new Set(after.map((r) => r.appliedSeq)).size, 3);

    // 新命令独占一行（未与残行粘连），可独立解析。
    const lines = fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    assert.equal(last.commandId, 'cmd-4');
    assert.equal(last.appliedSeq, 3);
  });
});
