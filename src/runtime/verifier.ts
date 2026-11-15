import { spawnSync } from 'node:child_process';
import { redactSecrets } from '../engine/stateMachine';
import type { VerifierCheck } from '../protocol';

/**
 * 真实确定性门禁：只执行仓库中真实存在、可独立运行的命令。
 *
 * 当前真实可执行两项：
 *   - lint      -> `npm run lint`（实为 tsc --noEmit）
 *   - unit_test -> `npm test`（node --import tsx --test）
 *
 * typecheck / cross_review 不产出任何 VerifierCheck：
 *   - typecheck：仓库没有独立的 `npm run typecheck` 脚本，tsc 已由 lint 覆盖；
 *     不为凑满 4 项而把同一命令重复记为 typecheck，也不伪造 passed。
 *   - cross_review：没有真实可执行的异构模型交叉审查手段（演示态的硬编码全绿并非真实执行）。
 * 设计红线：未执行的检查项绝不伪造为通过，也不假造失败，一律不产出。
 *
 * 每项独立计时、记录真实退出码；spawn 失败 / 超时 / 非零退出均记 passed:false，
 * 且整体 passed:false；错误写入 logs，绝不抛异常把服务打挂。
 */

export interface RealVerifierResult {
  checks: VerifierCheck[];
  passed: boolean;
  logs: string;
}

const MAX_LOG_CHARS = 4000;

interface CheckDef {
  name: VerifierCheck['name'];
  args: string[];
  command: string;
}

// 仅登记真实存在、可独立运行的命令；typecheck / cross_review 不在此列（见文件头说明）。
const REAL_CHECK_DEFS: CheckDef[] = [
  { name: 'lint', args: ['run', 'lint'], command: 'npm run lint' },
  { name: 'unit_test', args: ['test'], command: 'npm test' },
];

// 旧入口 runLintVerifier 的历史语义：只跑 lint 一项，保留以免外部引用断裂。
const LINT_ONLY_DEFS: CheckDef[] = [REAL_CHECK_DEFS[0]];

// 写进 logs：明确说明 typecheck / cross_review 为何不产出，避免被误读为「漏跑」。
const UNAVAILABLE_NOTE =
  '[verifier] 仅产出真实执行的检查项（lint / unit_test）。' +
  'typecheck 无独立 npm 脚本（tsc --noEmit 已由 lint 覆盖，不重复记账），' +
  'cross_review 无真实异构模型执行手段：二者当前不产出 VerifierCheck，' +
  '未执行的检查项一律不伪造为通过或假造失败。';

interface SingleRun {
  check: VerifierCheck;
  log: string;
}

function runSingleCheck(cwd: string, def: CheckDef, timeoutMs: number): SingleRun {
  const startedAt = Date.now();
  let status: number | null = null;
  let signal: string | null = null;
  let errorMsg = '';
  let stdout = '';
  let stderr = '';

  try {
    const result = spawnSync('npm', def.args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: { ...process.env },
    });
    status = result.status;
    signal = result.signal;
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
    if (result.error) errorMsg = result.error.message;
  } catch (err) {
    // spawnSync 在极端情况下仍可能抛（如无效参数）；兜底记录而非外抛，避免打挂服务。
    errorMsg = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - startedAt;

  const passed = errorMsg === '' && status === 0;

  const rawLog = [
    `[${def.name}] $ ${def.command}`,
    stdout,
    stderr,
    errorMsg ? `spawn error: ${errorMsg}` : '',
    `exit=${String(status)}${signal ? ` signal=${signal}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
  const { redacted: log } = redactSecrets(rawLog);

  // summary 也可能携带 error.message（含密钥），同样脱敏；如实写明实际命令与退出码。
  const summaryRaw = passed
    ? `${def.command} 退出码 0`
    : `${def.command} 退出码 ${String(status)}${errorMsg ? ` (${errorMsg})` : ''}`;
  const { redacted: summary } = redactSecrets(summaryRaw);

  return { check: { name: def.name, passed, durationMs, summary }, log };
}

function runCommandChecks(
  cwd: string,
  defs: CheckDef[],
  timeoutMs: number,
): RealVerifierResult {
  const runs = defs.map((def) => runSingleCheck(cwd, def, timeoutMs));
  const checks = runs.map((r) => r.check);
  const passed = checks.every((c) => c.passed);

  // 多项日志合并：每项先按均分预算截断，保证各项都留有信息，再整体兜底截断，避免超长。
  const perCheckBudget = Math.floor(MAX_LOG_CHARS / Math.max(defs.length, 1));
  const commandLogs = runs.map((r) => r.log.slice(0, perCheckBudget)).join('\n');
  // 失败时 logs 会被回灌进 lastErrorFeedback 与 verifier_check.detail 的 slice(0,500)，
  // 说明文字若置于开头会淹没真实编译错误；因此只在成功时追加到末尾。
  const logs = (passed ? `${commandLogs}\n${UNAVAILABLE_NOTE}` : commandLogs).slice(
    0,
    MAX_LOG_CHARS,
  );

  return { checks, passed, logs };
}

export function runRealVerifier(
  cwd: string,
  timeoutMs: number = 120_000,
): RealVerifierResult {
  return runCommandChecks(cwd, REAL_CHECK_DEFS, timeoutMs);
}

/** 兼容旧入口：保留导出与「只跑 lint 一项」的历史语义，避免外部引用断裂。 */
export function runLintVerifier(
  cwd: string,
  timeoutMs: number = 120_000,
): RealVerifierResult {
  return runCommandChecks(cwd, LINT_ONLY_DEFS, timeoutMs);
}
