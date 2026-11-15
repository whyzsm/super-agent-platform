import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DagNode, Requirement } from '../protocol';
import { GATE_TYPE_LABELS } from '../utils/statusStyles';

export interface ImGateCallbackPayload {
  channel: 'wecom' | 'feishu';
  taskId: string;
  approved: boolean;
  abort?: boolean;
  comment?: string;
  reviewerId: string;
  timestamp: number;
  nonce: string;
}

export function signImWebhookPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyImWebhookPayload(
  rawBody: string,
  signature: string,
  secret: string,
  nowMs: number = Date.now(),
  replayWindowMs: number = 300_000,
): { valid: boolean; payload?: ImGateCallbackPayload; error?: string } {
  let parsed: ImGateCallbackPayload;
  try {
    parsed = JSON.parse(rawBody) as ImGateCallbackPayload;
  } catch {
    return { valid: false, error: '无效的 JSON 回调载荷' };
  }

  if (!parsed.taskId || typeof parsed.timestamp !== 'number' || !parsed.nonce) {
    return { valid: false, error: '回调载荷缺少 taskId / timestamp / nonce 必填字段' };
  }

  if (Math.abs(nowMs - parsed.timestamp) > replayWindowMs) {
    return { valid: false, error: 'ReplayWindowError: 回调时间戳超出 300s 防重放窗口' };
  }

  const expectedHex = signImWebhookPayload(rawBody, secret);
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedHex, 'utf8');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'SignatureError: HMAC-SHA256 验签失败' };
  }

  return { valid: true, payload: parsed };
}

export function buildImApprovalCard(
  requirement: Requirement,
  task: DagNode,
): Record<string, unknown> {
  const gateLabel = task.activeCheckpoint
    ? GATE_TYPE_LABELS[task.activeCheckpoint.gateType]
    : 'Human Gate';

  return {
    msgtype: requirement.sourceChannel === 'feishu' ? 'interactive' : 'template_card',
    channel: requirement.sourceChannel,
    header: {
      title: `[SuperAgent] ${gateLabel}`,
      reqId: requirement.id,
      taskId: task.id,
    },
    body: {
      requirement: requirement.title,
      node: task.title,
      provider: task.provider,
      worktreeBranch: task.worktreeBranch,
      summary: task.activeCheckpoint?.summaryMd ?? '',
    },
    actions: [
      { action: 'approve', label: '批准放行', style: 'primary' },
      { action: 'reject', label: '附带意见打回', style: 'default' },
      { action: 'abort', label: '终止任务', style: 'danger' },
    ],
  };
}
