import type {
  AgentReasoningEvent,
  DagNode,
  TaskState,
} from '../protocol';
import { canTransition, extractSkillDraft } from '../engine/stateMachine';
import { recordStateTransition } from '../runtime/realRuntime';
import type { EventLog } from '../runtime/eventLog';

export type ResourceKind =
  | 'BLOCK_RESOURCE'
  | 'RELEASE_RESOURCE'
  | 'QUARANTINE'
  | 'RELEASE_QUARANTINE'
  | 'WAIT_APPROVAL'
  | 'APPROVE'
  | 'CANCEL';

/**
 * kind -> 目标状态。迁移合法性一律交给 canTransition() 唯一裁决，
 * 不在此复制 / 硬编码 VALID_TRANSITIONS 迁移表。
 */
const KIND_TO_STATE: Record<ResourceKind, TaskState> = {
  BLOCK_RESOURCE: 'BLOCKED_BY_RESOURCE',
  RELEASE_RESOURCE: 'RUNNING',
  QUARANTINE: 'QUARANTINED',
  RELEASE_QUARANTINE: 'RETRY_WAIT',
  WAIT_APPROVAL: 'WAITING_APPROVAL',
  APPROVE: 'MERGED',
  CANCEL: 'CANCELLED',
};

const KIND_LABEL: Record<ResourceKind, string> = {
  BLOCK_RESOURCE: '资源阻塞挂起',
  RELEASE_RESOURCE: '释放资源并恢复运行',
  QUARANTINE: '隔离处置',
  RELEASE_QUARANTINE: '解除隔离并等待重试',
  WAIT_APPROVAL: '等待人工审批',
  APPROVE: '审批通过并合入',
  CANCEL: '取消任务',
};

const REVIEW_REASON =
  'Q5 红线：处方必须人审 MR，禁止自动改写已发布 SOP。此处仅返回 MemoryAsset(status=draft) 的草案文本，不写任何文件、不修改 TeamAiAsset。';

/**
 * 新增 3 态（BLOCKED_BY_RESOURCE / QUARANTINED / WAITING_APPROVAL）及其回退态的
 * 真实生产者。合法时返回浅拷贝的新 node 并留下中文 events / terminalLines 与旁路事件；
 * 非法时原样返回入参且不产生任何副作用。
 */
export function applyResourceTransition(
  node: DagNode,
  kind: ResourceKind,
  eventLog?: EventLog,
): { node: DagNode; ok: boolean; from: TaskState; to: TaskState; reason: string } {
  const from = node.state;

  // 运行时可能从命令总线传入越界字符串；未知 kind 原样返回，不产生副作用。
  if (!Object.prototype.hasOwnProperty.call(KIND_TO_STATE, kind)) {
    return {
      node,
      ok: false,
      from,
      to: from,
      reason: `未知 ResourceKind：${String(kind)}，节点保持原样`,
    };
  }

  const to = KIND_TO_STATE[kind];

  // 唯一裁决：绝不硬编码迁移表，一律问状态机。
  if (!canTransition(from, to)) {
    return {
      node, // 原样返回同一个引用
      ok: false,
      from,
      to,
      reason: `${from}->${to} 不是合法迁移（canTransition 裁决拒绝）；未写 events / terminalLines / 旁路事件，节点原样返回`,
    };
  }

  const nowIso = new Date().toISOString();
  let maxEventSeq = 0;
  for (const ev of node.events) {
    if (typeof ev.seq === 'number' && ev.seq > maxEventSeq) maxEventSeq = ev.seq;
  }

  const event: AgentReasoningEvent = {
    id: `loop-${node.id}-${kind}-${nowIso}`,
    ts: nowIso,
    seq: maxEventSeq + 1,
    kind: 'verifier_check',
    title: `资源态迁移：${KIND_LABEL[kind]}`,
    detail: `命令 ${kind} 触发状态由 ${from} 迁移至 ${to}；canTransition(${from}, ${to}) 已放行，已写入旁路 STATE_TRANSITION 事件。`,
    status: 'ok',
  };
  const terminalLine = `[loop] ${KIND_LABEL[kind]}：${from} -> ${to}（canTransition 已放行，command=${kind}）`;

  // 浅拷贝出新 node；数组字段换成新数组，确保完全不修改入参。
  const newNode: DagNode = {
    ...node,
    state: to,
    events: [...node.events, event],
    terminalLines: [...node.terminalLines, terminalLine],
  };

  // 旁路 append-only 事件，仅作证据，不参与状态决策。
  recordStateTransition(newNode, from, to, undefined, eventLog);

  return {
    node: newNode,
    ok: true,
    from,
    to,
    reason: `canTransition(${from}, ${to}) 通过：命令 ${kind} 已将状态迁移至 ${to}，并追加 events / terminalLines 与旁路 STATE_TRANSITION 事件`,
  };
}

/**
 * 复盘提炼：复用既有 extractSkillDraft 从失败任务产出 Skill 草案文本。
 * requiresHumanReview 恒为 true —— SOP 自动改写必须「处方 MR + 人审 + 护栏」，
 * 绝不自动改写已发布 SOP：此处只返回草案文本，不落盘、不修改 TeamAiAsset。
 */
export function deriveRetrospective(node: DagNode): {
  draft: string | null;
  requiresHumanReview: true;
  reason: string;
} {
  // teamId / ownerId 仅进入 MemoryAsset 元数据；本函数只取 contentMd 草案文本。
  const asset = extractSkillDraft(node, node.reqId || 'loop-retro-team', 'loop-retro-bot');
  return {
    draft: asset ? asset.contentMd : null,
    requiresHumanReview: true,
    reason: REVIEW_REASON,
  };
}
