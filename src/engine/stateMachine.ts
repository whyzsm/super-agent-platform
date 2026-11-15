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
      summaryMd: `确定性门禁（Lint / Typecheck / 单测）与交叉审查已全部通过。\n\n${logs}`,
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

const DANGER_PATTERNS: Array<{ regex: RegExp; rule: string; reason: string }> = [
  {
    regex: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$|\*)/i,
    rule: 'NO_ROOT_DELETE',
    reason: '检测到高危根目录删除命令 (rm -rf /)，触发 Danger Gate 拦截。',
  },
  {
    regex: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    rule: 'NO_DESTRUCTIVE_SQL',
    reason: '检测到不可逆数据库结构删除语句 (DROP TABLE/DATABASE)，触发 Danger Gate 拦截。',
  },
  {
    regex: /\bgit\s+push\s+(--force|-f)\b/i,
    rule: 'NO_FORCE_PUSH',
    reason: '检测到强推历史提交命令 (git push --force)，触发 Danger Gate 拦截。',
  },
  {
    regex: /(^|\s)(\/etc\/|\.env(\.local|\.production)?\b|~\/\.ssh\/)/i,
    rule: 'SENSITIVE_PATH_GUARD',
    reason: '检测到越权访问沙箱白名单之外的敏感文件 (.env / ~/.ssh / /etc)，触发 Danger Gate 拦截。',
  },
];

export function detectDangerousCommand(command: string): {
  dangerous: boolean;
  rule?: string;
  reason?: string;
} {
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.regex.test(command)) {
      return {
        dangerous: true,
        rule: pattern.rule,
        reason: pattern.reason,
      };
    }
  }
  return { dangerous: false };
}

export function redactSecrets(rawLog: string): {
  redacted: string;
  hitCount: number;
} {
  let hitCount = 0;
  let result = rawLog;

  const patterns: Array<{ regex: RegExp; replacement: string }> = [
    { regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: '[REDACTED_API_KEY]' },
    { regex: /\bghp_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED_GH_TOKEN]' },
    { regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
    {
      regex: /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi,
      replacement: '$1[REDACTED_BEARER_TOKEN]',
    },
    {
      regex: /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi,
      replacement: '$1[REDACTED_DB_PASS]$2',
    },
    {
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      replacement: '[REDACTED_EMAIL]',
    },
  ];

  for (const { regex, replacement } of patterns) {
    result = result.replace(regex, (...args) => {
      hitCount += 1;
      // Preserve capture groups when replacement references $1/$2
      let out = replacement;
      if (args.length > 3) {
        out = out.replace(/\$1/g, String(args[1] ?? '')).replace(/\$2/g, String(args[2] ?? ''));
      }
      return out;
    });
  }

  return { redacted: result, hitCount };
}

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
