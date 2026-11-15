import { appendRuntimeEvent } from './eventLog';
import { runLintVerifier } from './verifier';
import type { DagNode, VerifierCheck } from '../protocol';

/**
 * 真实运行时的开关与编排。真实结果交回现有状态机 transitionTaskVerification()，
 * 不新建第二套状态流转；事件日志只作旁路证据。
 */

export function isRealRuntimeEnabled(): boolean {
  return process.env.SUPERAGENT_REAL_RUNTIME === '1';
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
): RealVerificationOutcome {
  const traceId = `verify-${task.id}-${Date.now()}`;
  const result = runLintVerifier(repoRoot);
  appendRuntimeEvent({
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
): void {
  appendRuntimeEvent({
    traceId: traceId ?? `run-${task.id}`,
    type: 'STATE_TRANSITION',
    taskId: task.id,
    detail: `${from}->${to}`,
  });
}
