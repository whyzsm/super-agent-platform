import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_REF_PATTERN,
  DANGER_COMMAND_RULES,
  REDACTION_RULES,
  ROUTE_ACTIONS,
  TASK_ID_PATTERN,
} from './rules';
import { detectDangerousCommand, redactSecrets } from './engine';
import { actionFor } from './routeActions';
import { ALL_ACTIONS } from '../identity/rbac';
import type { Action } from '../identity/types';

/**
 * 策略规则集测试（S2-9）：逐规则正反例 + 不变量。
 * 改 rules.ts 的任何一条规则，这里的对应用例必须同步更新。
 */

describe('危险命令规则：逐条正反例', () => {
  const cases: Array<{ code: string; hit: string[]; miss: string[] }> = [
    {
      code: 'NO_ROOT_DELETE',
      hit: ['rm -rf /', 'rm -fr /', 'rm -rf / ', 'rm -rf /*', 'RUN RM -Rf /'],
      miss: ['rm -rf ./build', 'rm -rf /tmp/x', 'npm run clean'],
    },
    {
      code: 'NO_DESTRUCTIVE_SQL',
      hit: ['DROP TABLE task_nodes;', 'drop database prod;', 'Drop Schema public'],
      miss: ['TRUNCATE TABLE t;', 'SELECT * FROM t;'],
    },
    {
      code: 'NO_FORCE_PUSH',
      hit: ['git push --force origin main', 'git push -f origin', 'GIT PUSH --FORCE'],
      miss: ['git push origin main', 'git push --tags origin'],
    },
    {
      code: 'SENSITIVE_PATH_GUARD',
      hit: ['cat .env', 'cat .env.production', 'cat /etc/passwd', 'cp ~/.ssh/id_rsa /tmp/'],
      miss: ['cat src/config.ts', 'ls ~/Documents'],
    },
  ];

  for (const { code, hit, miss } of cases) {
    test(`${code}：命中样例返回该规则与拦截原因`, () => {
      for (const cmd of hit) {
        const v = detectDangerousCommand(cmd);
        assert.equal(v.dangerous, true, `应命中: ${cmd}`);
        assert.equal(v.rule, code);
        assert.ok(v.reason && v.reason.length > 0, '必须携带面向用户的拦截原因');
      }
    });
    test(`${code}：非命中样例不判定危险`, () => {
      for (const cmd of miss) {
        assert.equal(detectDangerousCommand(cmd).dangerous, false, `不应命中: ${cmd}`);
      }
    });
  }

  test('已知保守拦截（与收敛前行为一致，见 docs/decision-log.md D-2026-11-16-04）', () => {
    // --force 前缀会命中 --force-with-lease；.env 会命中 .env.example。
    // 二者都是偏保守的误报：宁可多一次人工 Danger Gate，不放松拦截面。
    assert.equal(detectDangerousCommand('git push --force-with-lease origin main').rule, 'NO_FORCE_PUSH');
    assert.equal(detectDangerousCommand('cat .env.example').rule, 'SENSITIVE_PATH_GUARD');
  });

  test('首条命中即返回：多规则同时命中时按数组顺序取第一条', () => {
    // 同时命中 NO_ROOT_DELETE（第 1 条）与 NO_FORCE_PUSH（第 3 条）
    const v = detectDangerousCommand('git push --force origin main && rm -rf /');
    assert.equal(v.rule, DANGER_COMMAND_RULES[0].code);
  });

  test('规则代号唯一（代号是对外契约）', () => {
    const codes = DANGER_COMMAND_RULES.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('脱敏规则：逐条正反例与不变量', () => {
  const cases: Array<{ code: string; raw: string; redacted: string }> = [
    { code: 'OPENAI_API_KEY', raw: 'key=sk-ABCDEFGHIJKLMNOPQRSTUV ok', redacted: 'key=[REDACTED_API_KEY] ok' },
    { code: 'GITHUB_TOKEN', raw: 'token ghp_ABCDEFGHIJKLMNOPQR', redacted: 'token [REDACTED_GH_TOKEN]' },
    { code: 'AWS_ACCESS_KEY', raw: 'aws AKIAIOSFODNN7EXAMPLE', redacted: 'aws [REDACTED_AWS_KEY]' },
    { code: 'BEARER_TOKEN', raw: 'Authorization: Bearer abcdefghijklmnopqrst', redacted: 'Authorization: Bearer [REDACTED_BEARER_TOKEN]' },
    {
      code: 'DB_CONNECTION_PASSWORD',
      raw: 'postgres://app:secret123@db.internal:5432/prod',
      redacted: 'postgres://app:[REDACTED_DB_PASS]@db.internal:5432/prod',
    },
    { code: 'EMAIL', raw: 'contact lin.wei@example.com now', redacted: 'contact [REDACTED_EMAIL] now' },
  ];

  for (const { code, raw, redacted } of cases) {
    test(`${code}：命中并替换为占位符`, () => {
      const out = redactSecrets(raw);
      assert.equal(out.redacted, redacted);
      assert.ok(out.hitCount >= 1);
    });
  }

  test('非命中纯文本原样返回且 hitCount=0', () => {
    const raw = 'unit_test passed: 197 tests in 4.5s';
    const out = redactSecrets(raw);
    assert.equal(out.redacted, raw);
    assert.equal(out.hitCount, 0);
  });

  test('多条密钥同现时逐条计数', () => {
    const raw = 'sk-ABCDEFGHIJKLMNOPQRSTUV and AKIAIOSFODNN7EXAMPLE and a@b.io';
    const out = redactSecrets(raw);
    assert.equal(out.hitCount, 3);
    assert.ok(!out.redacted.includes('sk-'));
    assert.ok(!out.redacted.includes('AKIA'));
    assert.ok(!out.redacted.includes('a@b.io'));
  });

  test('幂等：脱敏输出再脱敏结果不变', () => {
    const raw = 'postgres://app:secret@db/x token=sk-ABCDEFGHIJKLMNOPQRSTUV Bearer abcdefghijklmnopqrst';
    const once = redactSecrets(raw);
    const twice = redactSecrets(once.redacted);
    assert.equal(twice.redacted, once.redacted);
    // 已知怪癖（与收敛前一致）：DB 口令位的占位符 [REDACTED_DB_PASS] 会被自身规则
    // 二次匹配，但替换结果恒等，输出稳定；其余占位符均不二次命中。
    assert.equal(twice.hitCount, 1);
  });

  test('短于阈值的假阳性样本不被误杀', () => {
    assert.equal(redactSecrets('sk-short').hitCount, 0);
    assert.equal(redactSecrets('Bearer short').hitCount, 0);
  });

  test('规则代号唯一', () => {
    const codes = REDACTION_RULES.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('worktree 白名单 pattern（迁自 worktreeManager）', () => {
  test('TASK_ID_PATTERN 接受安全字符且拒绝逃逸', () => {
    assert.ok(TASK_ID_PATTERN.test('task-2041-b1'));
    assert.ok(TASK_ID_PATTERN.test('a.b_c-123'));
    assert.ok(!TASK_ID_PATTERN.test('../evil'));
    assert.ok(!TASK_ID_PATTERN.test('-leading-dash'));
    assert.ok(!TASK_ID_PATTERN.test(''));
  });

  test('BASE_REF_PATTERN 接受分支/Tag 形态且拒绝注入', () => {
    assert.ok(BASE_REF_PATTERN.test('main'));
    assert.ok(BASE_REF_PATTERN.test('release/v2.4'));
    assert.ok(BASE_REF_PATTERN.test('refs/tags/v1.0.0'));
    assert.ok(!BASE_REF_PATTERN.test('../evil'));
    assert.ok(!BASE_REF_PATTERN.test('-Injected'));
    assert.ok(!BASE_REF_PATTERN.test('a b'));
  });
});

describe('路由动作登记表', () => {
  test('每条登记的 Action 都是合法枚举且方法合法', () => {
    const valid = new Set<string>(ALL_ACTIONS);
    for (const [method, , action] of ROUTE_ACTIONS) {
      assert.ok(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method), `非法方法: ${method}`);
      assert.ok(valid.has(action), `未登记的 Action: ${action}`);
    }
  });

  test('正则元字符按字面匹配：含 . 的路径不会误配任意字符', () => {
    // /api/bootstrap 的正则若把 . 当通配，/api/bootstrapX 也会被放行
    assert.equal(actionFor('GET', '/api/bootstrapX'), 'read'); // GET 兜底 read，不看表
    // 写路径必须有表项才放行：
    assert.equal(actionFor('POST', '/api/requirementsX'), null, '未登记写路由必须 fail-closed');
  });

  test('actionFor：IM 回调豁免、GET 兜底 read、未登记写方法 null', () => {
    assert.equal(actionFor('POST', '/api/webhooks/im'), 'exempt');
    assert.equal(actionFor('GET', '/api/anything-unknown'), 'read');
    assert.equal(actionFor('POST', '/api/anything-unknown'), null);
    assert.equal(actionFor('DELETE', '/api/anything-unknown'), null);
  });

  test('actionFor：代表性路由命中登记动作', () => {
    assert.equal(actionFor('POST', '/api/reset'), 'admin:reset');
    assert.equal(actionFor('POST', '/api/tasks/t-1/advance'), 'task:advance');
    assert.equal(actionFor('POST', '/api/tasks/t-1/gate'), 'task:gate');
    assert.equal(actionFor('DELETE', '/api/tasks/t-1/worktree'), 'runtime:spawn');
    assert.equal(actionFor('POST', '/api/mcp'), 'read');
    assert.equal(actionFor('GET', '/api/runtime/events'), 'runtime:events');
    const a: Action | 'exempt' | null = actionFor('POST', '/api/memories/m-1/approve');
    assert.equal(a, 'memory:approve');
  });
});
