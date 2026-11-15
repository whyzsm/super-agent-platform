import type { GateType, VerifierCheck } from '../protocol';

/**
 * Q8 门禁三挡放行（落地为配置）。
 *
 * 背景：v1 所有人工门禁都是「每次确认」，注意力成本高。Q8 的完整方案是
 * 三挡权限 + 审查模型代批；其中「代批模型」有硬约束（无工具、无凭证、
 * 与其他成员发言隔离），当前没有真实审查模型可接，**不伪造代批**——
 * 配置成 delegate_to_reviewer 时诚实降级为人工确认并在评估结果中写明原因。
 *
 * 三挡：
 * - always_confirm（默认）：一切门禁等人工确认 —— 与历史行为完全一致；
 * - auto_approve_when_green：确定性规则放行（不涉及模型）：
 *   仅 MERGE_GATE（可在 autoApproveGateTypes 调整）、verifier 全绿且非空、
 *   目标分支不在保护名单内，才自动放行；DANGER_GATE 永不放行；
 * - delegate_to_reviewer：目标形态（代批模型）；当前降级为人工，原因可审计。
 */

export type GateApprovalTier =
  | 'always_confirm'
  | 'auto_approve_when_green'
  | 'delegate_to_reviewer';

export interface GateTierConfig {
  tier: GateApprovalTier;
  /** auto_approve_when_green 允许自动放行的门禁类型；默认仅 MERGE_GATE。DANGER_GATE 永远不允许出现在这里（解析时强制剔除）。 */
  autoApproveGateTypes?: GateType[];
  /** 受保护分支：即便全绿也不自动放行（默认 ['main']）。 */
  protectedBranches?: string[];
}

export const DEFAULT_GATE_TIER_CONFIG: GateTierConfig = { tier: 'always_confirm' };

export const GATE_TIER_VALUES: readonly GateApprovalTier[] = [
  'always_confirm',
  'auto_approve_when_green',
  'delegate_to_reviewer',
];

/** 解析环境变量 SUPERAGENT_GATE_TIER；非法值回落默认挡并告警（fail-safe 到最严挡）。 */
export function parseGateTier(raw: string | undefined): GateApprovalTier {
  if (raw === undefined || raw === '') return 'always_confirm';
  if ((GATE_TIER_VALUES as readonly string[]).includes(raw)) return raw as GateApprovalTier;
  console.warn(
    `[gateTiers] 非法 SUPERAGENT_GATE_TIER=${JSON.stringify(raw)}，回落 always_confirm（合法值：${GATE_TIER_VALUES.join(' / ')}）`,
  );
  return 'always_confirm';
}

export interface GateEvaluationInput {
  gateType: GateType;
  verifierChecks: VerifierCheck[];
  /** 任务工作分支（如 agent/task-x-b1）；缺省按受保护处理 */
  worktreeBranch?: string;
}

export interface GateEvaluationResult {
  outcome: 'require_human' | 'auto_approve';
  /** 机器可读原因（写入事件与审计） */
  reason: string;
  tier: GateApprovalTier;
}

export function evaluateGateRelease(
  config: GateTierConfig,
  input: GateEvaluationInput,
): GateEvaluationResult {
  const tier = config.tier;

  if (tier === 'always_confirm') {
    return { outcome: 'require_human', reason: 'tier=always_confirm：等待人工确认', tier };
  }
  if (tier === 'delegate_to_reviewer') {
    // 硬约束（无工具/无凭证/发言隔离）当前无法满足，没有真实审查模型；
    // 诚实降级为人工确认，不伪造代批结论。
    return {
      outcome: 'require_human',
      reason: 'tier=delegate_to_reviewer：代批模型未接入（Q8 约束未满足），降级人工确认',
      tier,
    };
  }

  // auto_approve_when_green：确定性规则放行
  const autoGateTypes = config.autoApproveGateTypes ?? ['MERGE_GATE'];
  if (input.gateType === 'DANGER_GATE') {
    return { outcome: 'require_human', reason: 'DANGER_GATE 永不自动放行（红线）', tier };
  }
  if (!autoGateTypes.includes(input.gateType)) {
    return {
      outcome: 'require_human',
      reason: `tier=${tier}：${input.gateType} 不在 autoApproveGateTypes（${autoGateTypes.join(',')}）`,
      tier,
    };
  }
  if (input.verifierChecks.length === 0) {
    return { outcome: 'require_human', reason: 'verifier 无任何真实执行项，不自动放行', tier };
  }
  if (!input.verifierChecks.every((c) => c.passed)) {
    return { outcome: 'require_human', reason: 'verifier 存在未通过项，不自动放行', tier };
  }
  const protectedBranches = config.protectedBranches ?? ['main'];
  const branch = input.worktreeBranch ?? '';
  if (!branch || protectedBranches.includes(branch)) {
    return {
      outcome: 'require_human',
      reason: `目标分支 ${branch || '(空)'} 受保护（${protectedBranches.join(',')}），不自动放行`,
      tier,
    };
  }
  return {
    outcome: 'auto_approve',
    reason: `tier=${tier}：${input.gateType} 全绿（${input.verifierChecks.length} 项）且分支 ${branch} 非受保护`,
    tier,
  };
}
