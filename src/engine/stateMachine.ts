import type {
  DagNode,
  GateType,
  MemoryAsset,
  TaskCheckpoint,
  TaskState,
} from '../protocol';

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ['RUNNING', 'CANCELLED', 'BLOCKED_BY_RESOURCE'],
  RUNNING: [
    'VERIFYING',
    'HUMAN_GATE',
    'RETRY_WAIT',
    'ESCALATED',
    'CANCELLED',
    'BLOCKED_BY_RESOURCE',
    'QUARANTINED',
    'WAITING_APPROVAL',
  ],
  VERIFYING: ['HUMAN_GATE', 'RETRY_WAIT', 'ESCALATED', 'CANCELLED', 'QUARANTINED'],
  RETRY_WAIT: ['RUNNING', 'ESCALATED', 'CANCELLED', 'BLOCKED_BY_RESOURCE', 'QUARANTINED'],
  HUMAN_GATE: ['MERGED', 'RUNNING', 'RETRY_WAIT', 'ESCALATED', 'CANCELLED', 'WAITING_APPROVAL', 'QUARANTINED'],
  ESCALATED: ['RETRY_WAIT', 'RUNNING', 'CANCELLED', 'QUARANTINED', 'WAITING_APPROVAL'],
  MERGED: [],
  CANCELLED: [],
  BLOCKED_BY_RESOURCE: ['RUNNING', 'CANCELLED'],
  QUARANTINED: ['RETRY_WAIT', 'CANCELLED'],
  WAITING_APPROVAL: ['RUNNING', 'MERGED', 'CANCELLED'],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getReadyDagNodes(nodes: DagNode[]): DagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter((node) => {
    if (node.state !== 'PENDING') return false;
    return node.dependsOn.every((depId) => byId.get(depId)?.state === 'MERGED');
  });
}

export function transitionTaskVerification(
  node: DagNode,
  verifyPassed: boolean,
  logs: string,
  gateType: GateType = 'MERGE_GATE',
  nowIso: string = new Date().toISOString(),
): { nextNode: DagNode; checkpoint?: TaskCheckpoint } {
  if (verifyPassed) {
    const checkpoint: TaskCheckpoint = {
      id: `ckpt-${node.id}-${Date.now()}`,
      taskId: node.id,
      gateType,
      summaryMd: `确定性门禁已通过（实际执行项以 verifierChecks 为准）。\n\n${logs}`,
      status: 'WAITING',
      createdAt: nowIso,
    };
    return {
      nextNode: {
        ...node,
        state: 'HUMAN_GATE',
        activeCheckpoint: checkpoint,
      },
      checkpoint,
    };
  }

  const nextRetryCount = node.retryCount + 1;
  const escalated = nextRetryCount >= node.maxRetries;

  return {
    nextNode: {
      ...node,
      state: escalated ? 'ESCALATED' : 'RETRY_WAIT',
      retryCount: nextRetryCount,
      hadFailureOrCorrection: true,
      lastErrorFeedback: logs,
      activeCheckpoint: escalated
        ? {
            id: `ckpt-esc-${node.id}-${Date.now()}`,
            taskId: node.id,
            gateType: 'DANGER_GATE',
            summaryMd: `自动重试已达上限 (${nextRetryCount}/${node.maxRetries})，触发熔断挂起，请人工介入或调整方案。\n\n最后错误：\n${logs}`,
            status: 'WAITING',
            createdAt: nowIso,
          }
        : undefined,
    },
  };
}

export function recordUsageAndCheckBudget(
  node: DagNode,
  deltaInputTokens: number,
  deltaOutputTokens: number,
  deltaDurationSec: number,
  nowIso: string = new Date().toISOString(),
): { nextNode: DagNode; budgetExceeded: boolean } {
  const prev = node.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationSec: 0,
    budgetTokens: 60_000,
  };
  const inputTokens = prev.inputTokens + deltaInputTokens;
  const outputTokens = prev.outputTokens + deltaOutputTokens;
  const totalTokens = inputTokens + outputTokens;
  const costUsd = Number(
    (prev.costUsd + deltaInputTokens * 0.000003 + deltaOutputTokens * 0.000015).toFixed(4),
  );
  const durationSec = prev.durationSec + deltaDurationSec;
  const budgetExceeded = totalTokens >= prev.budgetTokens;

  return {
    budgetExceeded,
    nextNode: {
      ...node,
      usage: {
        ...prev,
        inputTokens,
        outputTokens,
        costUsd,
        durationSec,
      },
      state: budgetExceeded ? 'ESCALATED' : node.state,
      activeCheckpoint: budgetExceeded
        ? {
            id: `ckpt-budget-${node.id}-${Date.now()}`,
            taskId: node.id,
            gateType: 'DANGER_GATE',
            summaryMd: `Token 预算熔断 (${totalTokens.toLocaleString()} / ${prev.budgetTokens.toLocaleString()} tokens)，已自动挂起等待人工调整预算或接管。`,
            status: 'WAITING',
            createdAt: nowIso,
          }
        : node.activeCheckpoint,
    },
  };
}

export function resolveGateDecision(
  node: DagNode,
  checkpoint: TaskCheckpoint,
  decision: {
    approved: boolean;
    abort?: boolean;
    comment?: string;
    reviewerId: string;
    nowIso?: string;
  },
): {
  nextNode: DagNode;
  nextCheckpoint: TaskCheckpoint;
  shouldExtractSkill: boolean;
} {
  const resolvedAt = decision.nowIso ?? new Date().toISOString();

  if (decision.abort) {
    const nextCheckpoint: TaskCheckpoint = {
      ...checkpoint,
      status: 'ABORTED',
      reviewerId: decision.reviewerId,
      comment: decision.comment || '操作员已终止任务',
      resolvedAt,
    };
    return {
      nextNode: {
        ...node,
        state: 'CANCELLED',
        activeCheckpoint: nextCheckpoint,
      },
      nextCheckpoint,
      shouldExtractSkill: false,
    };
  }

  if (decision.approved) {
    const targetState: TaskState =
      checkpoint.gateType === 'MERGE_GATE' ? 'MERGED' : 'RUNNING';
    const nextCheckpoint: TaskCheckpoint = {
      ...checkpoint,
      status: 'APPROVED',
      reviewerId: decision.reviewerId,
      comment: decision.comment || '批准放行',
      resolvedAt,
    };
    const shouldExtractSkill =
      targetState === 'MERGED' &&
      Boolean(node.hadFailureOrCorrection || node.retryCount > 0);

    return {
      nextNode: {
        ...node,
        state: targetState,
        activeCheckpoint: nextCheckpoint,
      },
      nextCheckpoint,
      shouldExtractSkill,
    };
  }

  // Rejected with feedback -> back to RETRY_WAIT (or ESCALATED if max retries reached)
  const nextRetryCount = node.retryCount + 1;
  const escalated = nextRetryCount >= node.maxRetries;
  const feedback = decision.comment?.trim() || '人工审查未通过，请按要求修改实现。';
  const nextCheckpoint: TaskCheckpoint = {
    ...checkpoint,
    status: 'REJECTED',
    reviewerId: decision.reviewerId,
    comment: feedback,
    resolvedAt,
  };

  return {
    nextNode: {
      ...node,
      state: escalated ? 'ESCALATED' : 'RETRY_WAIT',
      retryCount: nextRetryCount,
      hadFailureOrCorrection: true,
      lastErrorFeedback: feedback,
      activeCheckpoint: nextCheckpoint,
    },
    nextCheckpoint,
    shouldExtractSkill: false,
  };
}

// 危险命令检测与脱敏已收敛到 src/policy/（S2-9）：
// 规则数据见 src/policy/rules.ts，求值见 src/policy/engine.ts。
// 本文件回归纯状态机职责，不再承载安全策略。

export function parseSkillFrontmatter(markdown: string): {
  valid: boolean;
  name?: string;
  triggers?: string[];
  scope?: string;
  body: string;
  errors: string[];
} {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      valid: false,
      body: trimmed,
      errors: ['缺少 YAML Frontmatter (--- ... ---) 区块'],
    };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const errors: string[] = [];

  const nameMatch = yamlBlock.match(/^name:\s*(.+)$/m);
  const triggersMatch = yamlBlock.match(/^triggers:\s*\[(.+)\]$/m);
  const scopeMatch = yamlBlock.match(/^scope:\s*(.+)$/m);

  const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : undefined;
  const scope = scopeMatch ? scopeMatch[1].trim().replace(/^["']|["']$/g, '') : 'team';
  const triggers = triggersMatch
    ? triggersMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : [];

  if (!name) errors.push('Frontmatter 缺少必填字段 name');
  if (triggers.length === 0) errors.push('Frontmatter 缺少 triggers 触发条件列表');
  if (body.length < 20) errors.push('Skill 正文 SOP 内容过短');

  return {
    valid: errors.length === 0,
    name,
    triggers,
    scope,
    body,
    errors,
  };
}

export function extractSkillDraft(
  node: DagNode,
  teamId: string,
  ownerId: string,
  nowIso: string = new Date().toISOString(),
): MemoryAsset | null {
  if (!node.hadFailureOrCorrection && node.retryCount === 0) {
    return null;
  }

  const slug = node.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  const errorLesson =
    node.lastErrorFeedback ||
    '在首次构建/验证中触发阻断并在后续修复中通过全套确定性门禁检查。';

  const contentMd = `---
name: "sop-${slug || node.id}"
triggers: ["${node.role}", "${node.provider}", "worktree-verify"]
scope: "team"
version: 1
---

# 经验沉淀：${node.title}

## 触发根因（Failure / Review Correction）
${errorLesson}

## 标准化修复规范（SOP）
1. 在执行变更前于隔离 worktree (\`${node.worktreeBranch || 'agent/task'}\`) 预运行确定性校验脚本（lint / typecheck / unit_test）。
2. 若涉及高危命令或跨域边界修改，优先触发 ACP 审批拦截并生成可读 Diff 快照。
3. 修复后需确认所有前置校验全绿再提交至 \`MERGE_GATE\`。
`;

  return {
    id: `skill-draft-${node.id}-${Date.now()}`,
    teamId,
    ownerId,
    assetType: 'SKILL',
    scope: 'team',
    status: 'draft',
    title: `SOP 草案：${node.title}`,
    contentMd,
    sourceTaskId: node.id,
    sourceReason: `任务经历 ${node.retryCount} 次打回修复后通过验证，自动提炼防污染草案`,
    duplicateScore: 0.14,
    version: 1,
    createdAt: nowIso,
    acl: [
      {
        assetId: `skill-draft-${node.id}-${Date.now()}`,
        subjectType: 'team',
        subjectId: teamId,
        permission: 'read',
      },
    ],
  };
}
