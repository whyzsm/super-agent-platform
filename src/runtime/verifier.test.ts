import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRealVerifier, runLintVerifier } from './verifier';

// 每个用例都在独立临时目录里写一个最小 package.json，脚本用 `node -e` 真实退出。
// 绝不通过修改本仓库源码制造失败探针（避免与并行改文件的其他 agent 冲突）。
function withTmpRepo(
  scripts: { lint?: string; test?: string },
  fn: (tmp: string) => void,
): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-verifier-'));
  try {
    const pkg = {
      name: 'verifier-fixture',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts,
    };
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify(pkg, null, 2),
      'utf-8',
    );
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('runRealVerifier 真实执行 lint 与 unit_test 两项，names 恰为 [lint, unit_test] 且全绿', () => {
  withTmpRepo(
    {
      lint: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
    (tmp) => {
      const result = runRealVerifier(tmp, 30_000);
      assert.deepEqual(result.checks.map((c) => c.name), ['lint', 'unit_test']);
      assert.equal(result.passed, true);
      for (const c of result.checks) {
        assert.equal(c.passed, true);
        assert.equal(typeof c.durationMs, 'number');
        assert.ok(c.durationMs >= 0);
        assert.match(c.summary, /退出码 0/);
      }
      const lint = result.checks.find((c) => c.name === 'lint')!;
      const unit = result.checks.find((c) => c.name === 'unit_test')!;
      assert.match(lint.summary, /npm run lint/);
      assert.match(unit.summary, /npm test/);
      assert.ok(
        !result.checks.some((c) => c.name === 'typecheck' || c.name === 'cross_review'),
        '未执行的 typecheck / cross_review 不应产出',
      );
    },
  );
});

test('任一脚本非零退出时该项 passed:false 且总 passed:false，summary 含真实退出码', () => {
  withTmpRepo(
    {
      lint: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(3)"',
    },
    (tmp) => {
      const result = runRealVerifier(tmp, 30_000);
      assert.equal(result.passed, false);
      assert.deepEqual(result.checks.map((c) => c.name), ['lint', 'unit_test']);
      const lint = result.checks.find((c) => c.name === 'lint')!;
      const unit = result.checks.find((c) => c.name === 'unit_test')!;
      assert.equal(lint.passed, true);
      assert.equal(unit.passed, false);
      assert.match(unit.summary, /npm test/);
      assert.match(unit.summary, /退出码 \d+/);
      assert.ok(!unit.summary.includes('退出码 0'), '失败项不应报告退出码 0');
      // 失败日志必须以真实命令输出开头，说明文字不能淹没回灌给 agent 的错误。
      assert.ok(result.logs.startsWith('[lint]'), '失败日志应以真实 lint 输出开头');
      assert.ok(
        !result.logs.includes('仅产出真实执行的检查项'),
        '失败日志不应包含成功态的说明文字',
      );
    },
  );
});

test('日志对 sk- 密钥脱敏，不泄露原始密钥', () => {
  // redactSecrets 实际规则（src/policy/rules.ts）：
  //   /\bsk-[A-Za-z0-9_-]{12,}\b/g  ->  '[REDACTED_API_KEY]'
  // 构造符合 {12,} 且两侧为单词边界的独立 token。
  const secret = 'sk-a1b2c3d4e5f6g7h8i9j0';
  withTmpRepo(
    {
      lint: `node -e "console.log('${secret}')"`,
      test: 'node -e "process.exit(0)"',
    },
    (tmp) => {
      const result = runRealVerifier(tmp, 30_000);
      assert.equal(result.passed, true);
      assert.ok(!result.logs.includes(secret), 'logs 不应包含原始密钥');
      assert.ok(result.logs.includes('[REDACTED_API_KEY]'), '应命中 sk- 脱敏规则');
    },
  );
});

test('runLintVerifier 兼容入口仍可调用且保持仅 lint 一项语义', () => {
  withTmpRepo(
    {
      lint: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
    (tmp) => {
      const result = runLintVerifier(tmp, 30_000);
      assert.deepEqual(result.checks.map((c) => c.name), ['lint']);
      assert.equal(result.passed, true);
    },
  );
});
