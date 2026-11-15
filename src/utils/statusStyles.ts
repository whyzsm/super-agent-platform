import type {
  AgentProvider,
  GateType,
  SopTemplateId,
  SopTemplateRef,
  TaskRole,
  TaskState,
} from '../protocol';

/**
 * 「需要人工/调度器介入」的状态全集（前端镜像）。
 * 与后端 MCP list_blocked_tasks 的 NEEDS_ATTENTION 集合保持一致：
 * HUMAN_GATE / WAITING_APPROVAL / RETRY_WAIT / BLOCKED_BY_RESOURCE / QUARANTINED。
 * 队列「需介入」计数、焦点任务选择都用这一份，避免各处自拼条件漏掉新态。
 */
export const NEEDS_ATTENTION_STATES: readonly TaskState[] = [
  'HUMAN_GATE',
  'WAITING_APPROVAL',
  'RETRY_WAIT',
  'BLOCKED_BY_RESOURCE',
  'QUARANTINED',
];

export function needsAttention(state: TaskState): boolean {
  return NEEDS_ATTENTION_STATES.includes(state);
}

export const TASK_STATE_META: Record<
  TaskState,
  { label: string; textClass: string; borderClass: string; bgClass: string }
> = {
  PENDING: {
    label: '待调度',
    textClass: 'text-slate-600',
    borderClass: 'border-slate-300',
    bgClass: 'bg-slate-100',
  },
  RUNNING: {
    label: '执行中',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-300',
    bgClass: 'bg-blue-50',
  },
  VERIFYING: {
    label: '门禁校验中',
    textClass: 'text-indigo-700',
    borderClass: 'border-indigo-300',
    bgClass: 'bg-indigo-50',
  },
  RETRY_WAIT: {
    label: '打回重试',
    textClass: 'text-amber-700',
    borderClass: 'border-amber-300',
    bgClass: 'bg-amber-50',
  },
  HUMAN_GATE: {
    label: '人工门禁',
    textClass: 'text-amber-800',
    borderClass: 'border-amber-400',
    bgClass: 'bg-amber-50',
  },
  ESCALATED: {
    label: '熔断挂起',
    textClass: 'text-red-700',
    borderClass: 'border-red-400',
    bgClass: 'bg-red-50',
  },
  MERGED: {
    label: '已合入',
    textClass: 'text-emerald-700',
    borderClass: 'border-emerald-300',
    bgClass: 'bg-emerald-50',
  },
  CANCELLED: {
    label: '已终止',
    textClass: 'text-slate-500',
    borderClass: 'border-slate-200',
    bgClass: 'bg-slate-50',
  },
  BLOCKED_BY_RESOURCE: {
    label: '等待资源',
    textClass: 'text-slate-600',
    borderClass: 'border-slate-300',
    bgClass: 'bg-slate-100',
  },
  QUARANTINED: {
    label: '隔离待查',
    textClass: 'text-red-700',
    borderClass: 'border-red-400',
    bgClass: 'bg-red-50',
  },
  WAITING_APPROVAL: {
    label: '等待审批',
    textClass: 'text-amber-800',
    borderClass: 'border-amber-400',
    bgClass: 'bg-amber-50',
  },
};

export const GATE_TYPE_LABELS: Record<GateType, string> = {
  PLAN_GATE: 'Plan Gate · 方案拆解确认',
  DANGER_GATE: 'Danger Gate · 高危操作拦截',
  MERGE_GATE: 'Merge Gate · 合入主干审批',
};

export const PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: 'Codex CLI',
  workbuddy: 'WorkBuddy',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
};

export const ROLE_LABELS: Record<TaskRole, string> = {
  planner: 'Planner',
  builder: 'Builder',
  reviewer: 'Reviewer',
};

export const SOP_TEMPLATE_LABELS: Record<SopTemplateId, string> = {
  feature_flow: '标准 Feature 开发流',
  bugfix_flow: 'Bug 修复流',
};

/** 模板标签：内置走 Record；固化子 SOP（sop-*）回退显示原始 id，不因加宽类型丢穷举。 */
export function sopTemplateLabel(ref: SopTemplateRef | undefined): string {
  if (!ref) return SOP_TEMPLATE_LABELS.feature_flow;
  return SOP_TEMPLATE_LABELS[ref as SopTemplateId] ?? ref;
}
