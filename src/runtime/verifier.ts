import { spawnSync } from 'node:child_process';
import { redactSecrets } from '../engine/stateMachine';
import type { VerifierCheck } from '../protocol';

/**
 * 确定性门禁：只跑仓库真实存在的 `npm run lint`（tsc --noEmit）。
 * 只产出 lint 一项真实结果；typecheck / unit_test / cross_review 不伪造为通过。
 */

export interface RealVerifierResult {
  checks: VerifierCheck[];
  passed: boolean;
  logs: string;
}

const MAX_LOG_CHARS = 4000;

export function runLintVerifier(
  cwd: string,
  timeoutMs: number = 120_000,
): RealVerifierResult {
  const startedAt = Date.now();
  const result = spawnSync('npm', ['run', 'lint'], {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env },
  });
  const durationMs = Date.now() - startedAt;

  const raw = [
    result.stdout ?? '',
    result.stderr ?? '',
    result.error ? `spawn error: ${result.error.message}` : '',
  ].join('\n');
  const { redacted } = redactSecrets(raw);
  const logs = redacted.slice(0, MAX_LOG_CHARS);

  const passed = result.error === undefined && result.status === 0;
  const checks: VerifierCheck[] = [
    {
      name: 'lint',
      passed,
      durationMs,
      summary: passed
        ? 'npm run lint 退出码 0'
        : `npm run lint 退出码 ${String(result.status)}`,
    },
  ];

  return { checks, passed, logs };
}
