import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssetAclEntry, MemoryAsset } from '../protocol';
import { createAuditLog } from './audit';
import { createLocalIdentityProvider } from './localProvider';
import { ALL_ACTIONS, assertAllowed, canAccessAsset, isAllowed } from './rbac';
import { ForbiddenError } from './types';
import type { Action, AuditEntry, Principal } from './types';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    teamId: 'team-A',
    roles: ['viewer'],
    authenticated: true,
    ...overrides,
  };
}

function asset(overrides: Partial<MemoryAsset> = {}): MemoryAsset {
  return {
    id: 'mem-1',
    teamId: 'team-A',
    ownerId: 'user-1',
    assetType: 'L1_FACT',
    scope: 'team',
    status: 'published',
    title: '共享事实',
    contentMd: '事实内容',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    acl: [],
    ...overrides,
  };
}

function acl(
  subjectType: AssetAclEntry['subjectType'],
  subjectId: string,
): AssetAclEntry {
  return { assetId: 'mem-1', subjectType, subjectId, permission: 'read' };
}

// 所有文件 IO 都落在 os.tmpdir() 的独立临时目录，绝不写仓库根目录。
function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function baseEntry(
  overrides: Partial<Omit<AuditEntry, 'seq' | 'ts'>> = {},
): Omit<AuditEntry, 'seq' | 'ts'> {
  return {
    userId: 'user-1',
    teamId: 'team-A',
    action: 'read',
    target: 'mem-1',
    outcome: 'allowed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// localProvider
// ---------------------------------------------------------------------------

test('localProvider: 完整 string headers 解析为已认证 Principal', () => {
  const p = createLocalIdentityProvider().resolve({
    'x-superagent-user': 'lin.wei',
    'x-superagent-team': 'team-platform-core',
    'x-superagent-project': 'proj-reconcile',
    'x-superagent-agent': 'codex',
    'x-superagent-roles': 'developer, reviewer',
  });
  assert.equal(p.userId, 'lin.wei');
  assert.equal(p.teamId, 'team-platform-core');
  assert.equal(p.projectId, 'proj-reconcile');
  assert.equal(p.agentId, 'codex');
  assert.deepEqual(p.roles, ['developer', 'reviewer']);
  assert.equal(p.authenticated, true);
});

test('localProvider: string[] 取第一项、roles 逗号分隔/trim、非法角色被过滤', () => {
  const p = createLocalIdentityProvider().resolve({
    'x-superagent-user': ['first-user', 'second-user'],
    'x-superagent-team': ['team-A', 'team-B'],
    'x-superagent-project': ['proj-A'],
    'x-superagent-agent': ['agent-A'],
    'x-superagent-roles': ' admin , developer , not-a-role ,viewer ',
  });
  assert.equal(p.userId, 'first-user');
  assert.equal(p.teamId, 'team-A');
  assert.equal(p.projectId, 'proj-A');
  assert.equal(p.agentId, 'agent-A');
  assert.deepEqual(p.roles, ['admin', 'developer', 'viewer']);
  assert.equal(p.authenticated, true);
});

test('localProvider: 全部 headers 缺失 → 匿名 viewer / authenticated:false / teamId:anonymous', () => {
  const p = createLocalIdentityProvider().resolve({});
  assert.equal(p.userId, 'anonymous');
  assert.equal(p.teamId, 'anonymous');
  assert.deepEqual(p.roles, ['viewer']);
  assert.equal(p.authenticated, false);
  assert.equal(p.projectId, undefined);
  assert.equal(p.agentId, undefined);
});

test('localProvider: 身份头为 undefined / 空字符串 / 空白同样视为匿名', () => {
  const p = createLocalIdentityProvider().resolve({
    'x-superagent-user': undefined,
    'x-superagent-team': '',
    'x-superagent-roles': '   ',
  });
  assert.equal(p.authenticated, false);
  assert.equal(p.teamId, 'anonymous');
  assert.deepEqual(p.roles, ['viewer']);
});

// ---------------------------------------------------------------------------
// RBAC 权限矩阵
// ---------------------------------------------------------------------------

test('rbac: viewer 权限矩阵逐项（仅 read / runtime:events）', () => {
  const p = principal({ roles: ['viewer'] });
  const allowed: Action[] = ['read', 'runtime:events'];
  for (const action of ALL_ACTIONS) {
    assert.equal(isAllowed(p, action), allowed.includes(action), `viewer / ${action}`);
  }
});

test('rbac: developer 权限矩阵逐项（viewer + 三项写 + 记忆提案）', () => {
  const p = principal({ roles: ['developer'] });
  const allowed: Action[] = [
    'read',
    'runtime:events',
    'requirement:create',
    'task:advance',
    'runtime:spawn',
    'memory:propose',
  ];
  for (const action of ALL_ACTIONS) {
    assert.equal(isAllowed(p, action), allowed.includes(action), `developer / ${action}`);
  }
});

test('rbac: reviewer 权限矩阵逐项（viewer + gate/approve/teamai/propose，不含 developer 写权限）', () => {
  const p = principal({ roles: ['reviewer'] });
  const allowed: Action[] = [
    'read',
    'runtime:events',
    'task:gate',
    'memory:approve',
    'teamai:write',
    'memory:propose',
  ];
  for (const action of ALL_ACTIONS) {
    assert.equal(isAllowed(p, action), allowed.includes(action), `reviewer / ${action}`);
  }
  assert.equal(isAllowed(p, 'requirement:create'), false);
  assert.equal(isAllowed(p, 'task:advance'), false);
  assert.equal(isAllowed(p, 'runtime:spawn'), false);
});

test('rbac: admin 权限矩阵（全部 Action 放行）', () => {
  const p = principal({ roles: ['admin'] });
  for (const action of ALL_ACTIONS) {
    assert.equal(isAllowed(p, action), true, `admin / ${action}`);
  }
});

test('rbac: admin:reset 是 admin 独占，developer / reviewer 均不得重置平台', () => {
  for (const role of ['developer', 'reviewer', 'viewer'] as const) {
    assert.equal(
      isAllowed(principal({ roles: [role] }), 'admin:reset'),
      false,
      `${role} 不得执行 admin:reset`,
    );
  }
  // 多角色叠加也不能拼出 admin:reset（它不是角色并集的产物）。
  assert.equal(
    isAllowed(principal({ roles: ['developer', 'reviewer', 'viewer'] }), 'admin:reset'),
    false,
  );
  assert.equal(isAllowed(principal({ roles: ['admin'] }), 'admin:reset'), true);
});

test('rbac: 动作全集与角色矩阵覆盖一致（新增 Action 必须被至少一个角色放行）', () => {
  for (const action of ALL_ACTIONS) {
    const holders = (['viewer', 'developer', 'reviewer', 'admin'] as const).filter((role) =>
      isAllowed(principal({ roles: [role] }), action),
    );
    assert.ok(
      holders.length > 0,
      `Action ${action} 没有任何角色可执行，矩阵与全集已漂移`,
    );
  }
});

test('rbac: 多角色取并集，任一角色命中即放行', () => {
  const dev = principal({ roles: ['developer', 'viewer'] });
  assert.equal(isAllowed(dev, 'task:gate'), false);
  const devReviewer = principal({ roles: ['developer', 'reviewer'] });
  assert.equal(isAllowed(devReviewer, 'runtime:spawn'), true);
  assert.equal(isAllowed(devReviewer, 'task:gate'), true);
});

test('rbac: 匿名 authenticated:false 无论 roles 最多只能 read', () => {
  const anon = principal({
    roles: ['admin', 'developer', 'reviewer'],
    authenticated: false,
  });
  assert.equal(isAllowed(anon, 'read'), true);
  for (const action of ALL_ACTIONS) {
    if (action === 'read') continue;
    assert.equal(isAllowed(anon, action), false, `匿名不得执行 ${action}`);
  }
});

test('rbac: localProvider 解析出的匿名主体写操作被拒并抛 ForbiddenError', () => {
  const p = createLocalIdentityProvider().resolve({});
  assert.equal(isAllowed(p, 'read'), true);
  assert.equal(isAllowed(p, 'teamai:write'), false);
  assert.throws(() => assertAllowed(p, 'teamai:write'), ForbiddenError);
});

test('rbac: assertAllowed 通过不抛，拒绝抛 ForbiddenError 且 message 含 action 与 principal', () => {
  const p = principal({ userId: 'chen.hao', roles: ['viewer'] });
  assert.doesNotThrow(() => assertAllowed(p, 'read'));

  try {
    assertAllowed(p, 'memory:approve');
    assert.fail('viewer 执行 memory:approve 应抛 ForbiddenError');
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    assert.ok(err.message.includes('memory:approve'), 'message 必须含 action');
    assert.ok(err.message.includes('chen.hao'), 'message 必须含 principal 标识');
    assert.equal(err.action, 'memory:approve');
    assert.equal(err.principal.userId, 'chen.hao');
  }
});

// ---------------------------------------------------------------------------
// 四级 ACL + 跨 team 越权
// ---------------------------------------------------------------------------

test('rbac: canAccessAsset 四级 ACL（team/project/user/agent）命中且同 team 放行', () => {
  const cases: Array<{
    subjectType: AssetAclEntry['subjectType'];
    id: string;
    p: Principal;
  }> = [
    { subjectType: 'team', id: 'team-A', p: principal() },
    { subjectType: 'project', id: 'proj-A', p: principal({ projectId: 'proj-A' }) },
    { subjectType: 'user', id: 'user-1', p: principal({ userId: 'user-1' }) },
    { subjectType: 'agent', id: 'codex', p: principal({ agentId: 'codex' }) },
  ];
  for (const c of cases) {
    const a = asset({ acl: [acl(c.subjectType, c.id)] });
    assert.equal(canAccessAsset(c.p, a), true, `${c.subjectType} ACL 应命中`);
  }
});

test('rbac: canAccessAsset ACL 不匹配返回 false（admin 也不例外）', () => {
  const viewer = principal();
  const admin = principal({ roles: ['admin'] });
  const a = asset({ acl: [acl('user', 'someone-else')] });
  assert.equal(canAccessAsset(viewer, a), false);
  assert.equal(canAccessAsset(admin, a), false);
  assert.equal(canAccessAsset(viewer, asset({ acl: [] })), false);
});

test('rbac: 跨 team 资产即使 ACL 命中、非 admin 也被拒', () => {
  const p = principal({ teamId: 'team-A', roles: ['developer'] });
  // 资产属于 team-B，但用 user ACL 命中调用者，制造「ACL 通过但跨 team」场景。
  const a = asset({ teamId: 'team-B', acl: [acl('user', 'user-1')] });
  assert.equal(canAccessAsset(p, a), false);
});

test('rbac: admin 是跨 team 规则的例外（条件为「且不是 admin」），ACL 命中即放行', () => {
  const admin = principal({ teamId: 'team-A', roles: ['admin'] });
  const a = asset({ teamId: 'team-B', acl: [acl('user', 'user-1')] });
  assert.equal(canAccessAsset(admin, a), true);
});

// ---------------------------------------------------------------------------
// 不可变审计
// ---------------------------------------------------------------------------

test('audit: seq 连续、ts 合法、每行完整 JSON；外部追加高 seq 不冲突', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'audit.jsonl');
    const log = createAuditLog({ path: logPath });
    const e1 = log.record(baseEntry());
    const e2 = log.record(baseEntry({ action: 'teamai:write', outcome: 'applied' }));
    assert.deepEqual([e1.seq, e2.seq], [1, 2]);
    assert.equal(new Set([e1.seq, e2.seq]).size, 2);
    assert.equal(Number.isNaN(Date.parse(e1.ts)), false);

    const lines = fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as AuditEntry;
      assert.equal(typeof parsed.seq, 'number');
      assert.equal(typeof parsed.ts, 'string');
      assert.equal(typeof parsed.action, 'string');
    }

    // 外部直接追加一条高 seq 的合法行，模拟其他写者。
    const external: AuditEntry = {
      seq: 99,
      ts: '2026-02-02T00:00:00.000Z',
      userId: 'outsider',
      teamId: 'team-A',
      action: 'read',
      target: 'mem-1',
      outcome: 'allowed',
    };
    fs.appendFileSync(logPath, JSON.stringify(external) + '\n', 'utf-8');

    const e3 = log.record(baseEntry({ action: 'memory:approve' }));
    assert.equal(e3.seq, 100, 'seq 必须从文件真实 max(99) 续写，而非缓存值');
    assert.deepEqual(log.list().map((e) => e.seq), [1, 2, 99, 100]);
  });
});

test('audit: detail 及所有字符串字段写盘前经 redactSecrets 脱敏', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'audit.jsonl');
    const log = createAuditLog({ path: logPath });
    const secret = 'sk-abcdefghijklmnop123456';
    const email = 'ops@corp.example.com';
    const e = log.record(
      baseEntry({
        userId: email,
        target: `deploy target ${secret}`,
        detail: `used key ${secret} and mail ${email}`,
        action: 'teamai:write',
        outcome: 'applied',
      }),
    );

    const detail = e.detail ?? '';
    assert.ok(!detail.includes(secret), '返回 detail 不得含原始密钥');
    assert.ok(detail.includes('[REDACTED_API_KEY]'));
    assert.ok(!detail.includes(email));
    assert.ok(!e.userId.includes(email), 'userId 也应脱敏');
    assert.ok(!e.target.includes(secret), 'target 也应脱敏');
    // 枚举值字段对 redactSecrets 应为恒等变换，保持不变。
    assert.equal(e.action, 'teamai:write');
    assert.equal(e.outcome, 'applied');

    const onDisk = fs.readFileSync(logPath, 'utf-8');
    assert.ok(!onDisk.includes(secret), '磁盘上不得出现原始密钥');
    assert.ok(onDisk.includes('[REDACTED_API_KEY]'));
    assert.ok(!onDisk.includes(email));
  });
});

test('audit: list 跳过损坏行、按 seq 升序、纯读不改写', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'audit.jsonl');
    const mk = (seq: number, action: Action, teamId = 'team-A') =>
      JSON.stringify({
        seq,
        ts: '2026-01-01T00:00:00.000Z',
        userId: 'u',
        teamId,
        action,
        target: 't',
        outcome: 'allowed',
      });
    // 故意乱序 + 损坏行（非法 JSON / 无 numeric seq / 空行 / 空白行）。
    fs.writeFileSync(
      logPath,
      [
        mk(3, 'read', 'team-A'),
        'this-is-not-json',
        mk(1, 'teamai:write', 'team-B'),
        '',
        '   ',
        JSON.stringify({ seq: 'not-a-number', broken: true }),
        mk(2, 'memory:approve', 'team-A'),
      ].join('\n') + '\n',
      'utf-8',
    );
    const before = fs.readFileSync(logPath, 'utf-8');

    const log = createAuditLog({ path: logPath });
    assert.deepEqual(log.list().map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(log.list().map((e) => e.action), [
      'teamai:write',
      'memory:approve',
      'read',
    ]);
    assert.deepEqual(log.list({ teamId: 'team-A' }).map((e) => e.seq), [2, 3]);
    assert.deepEqual(log.list({ action: 'read' }).map((e) => e.seq), [3]);

    assert.equal(fs.readFileSync(logPath, 'utf-8'), before, 'list 为纯读，不得改写文件');
  });
});

test('audit: append-only —— record 不改旧行、list 过滤正确', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'audit.jsonl');
    const log = createAuditLog({ path: logPath });
    log.record(baseEntry());
    log.record(
      baseEntry({ action: 'teamai:write', outcome: 'applied', teamId: 'team-B' }),
    );
    const snapshot = fs.readFileSync(logPath, 'utf-8');

    log.record(baseEntry({ action: 'memory:approve', outcome: 'denied' }));

    const after = fs.readFileSync(logPath, 'utf-8');
    assert.ok(after.startsWith(snapshot), '旧行必须原样保留，新行只能追加在末尾');
    assert.equal(
      after.split('\n').filter((l) => l.trim()).length,
      3,
      '三条记录都应保留',
    );

    assert.deepEqual(log.list().map((e) => e.seq), [1, 2, 3]);
    assert.equal(log.list({ teamId: 'team-B' }).length, 1);
    assert.equal(log.list({ action: 'memory:approve' }).length, 1);
    assert.equal(log.list({ teamId: 'team-B', action: 'read' }).length, 0);
  });
});

test('audit: 文件不存在时 list 返回 [] 且纯读不创建文件', () => {
  withTempDir((dir) => {
    const logPath = path.join(dir, 'missing.jsonl');
    const log = createAuditLog({ path: logPath });
    assert.deepEqual(log.list(), []);
    assert.deepEqual(log.list({ teamId: 'team-A' }), []);
    assert.equal(fs.existsSync(logPath), false, 'list 不得创建文件');

    const e = log.record(baseEntry());
    assert.equal(e.seq, 1);
    assert.equal(fs.existsSync(logPath), true);
  });
});
