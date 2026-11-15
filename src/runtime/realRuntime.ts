import { appendRuntimeEvent, type EventLog } from './eventLog';
import { runRealVerifier } from './verifier';
import type { DagNode, VerifierCheck } from '../protocol';

/**
 * 真实运行时的开关与编排。真实结果交回现有状态机 transitionTaskVerification()，
 * 不新建第二套状态流转；事件日志只作旁路证据。
 */

/**
 * 默认走真实运行时（真实 verifier + 旁路事件日志），不再默认造假。
 * 回退演示态：SUPERAGENT_DEMO_MODE=1 或 SUPERAGENT_REAL_RUNTIME=0。
 * SUPERAGENT_REAL_RUNTIME=1 仍为真，保持旧配置向后兼容。
 */
export function isRealRuntimeEnabled(): boolean {
  if (process.env.SUPERAGENT_DEMO_MODE === '1') return false;
  if (process.env.SUPERAGENT_REAL_RUNTIME === '0') return false;
  return true;
}

export interface RealVerificationOutcome {
  checks: VerifierCheck[];
  passed: boolean;
  logs: string;
  traceId: string;
}

export function runRealVerification(
  task: DagNode,
  repoRoot: string = process.cwd(),
  eventLog?: EventLog,
): RealVerificationOutcome {
  const traceId = `verify-${task.id}-${Date.now()}`;
  const result = runRealVerifier(repoRoot);
  const log = eventLog ?? { append: appendRuntimeEvent };
  log.append({
    traceId,
    type: 'VERIFY_RESULT',
    taskId: task.id,
    detail: `passed=${String(result.passed)} checks=${result.checks.length}`,
  });
  return { ...result, traceId };
}

export function recordStateTransition(
  task: DagNode,
  from: string,
  to: string,
  traceId?: string,
  eventLog?: EventLog,
): void {
  (eventLog ?? { append: appendRuntimeEvent }).append({
    traceId: traceId ?? `run-${task.id}`,
    type: 'STATE_TRANSITION',
    taskId: task.id,
    detail: `${from}->${to}`,
  });
}
