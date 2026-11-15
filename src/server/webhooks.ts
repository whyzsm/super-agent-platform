import type { Express } from 'express';
import {
  buildImApprovalCard,
  signImWebhookPayload,
  verifyImWebhookPayload,
} from '../gateway/imWebhook';
import { extractSkillDraft, resolveGateDecision } from '../engine/stateMachine';
import { computeMaxDuplicateScore } from '../memory/recallEngine';
import type { ServerContext } from './context';

/** IM 网关路由：审批卡片渲染 + HMAC-SHA256 验签回调（豁免 RBAC，独立鉴权）。 */
export function registerWebhookRoutes(app: Express, ctx: ServerContext): void {
  const { state, imWebhookSecret, saveState, recomputeRequirementStatus } = ctx;

  app.get('/api/webhooks/im/card/:taskId', (req, res) => {
    if (!imWebhookSecret) {
      res.status(503).json({ error: 'IM_WEBHOOK_SECRET is not configured' });
      return;
    }
    const task = state.current.tasks.find((t) => t.id === req.params.taskId);
    const requirement = task
      ? state.current.requirements.find((r) => r.id === task.reqId)
      : undefined;
    if (!task || !requirement) {
      res.status(404).json({ error: '任务或关联需求不存在' });
      return;
    }

    const approved = req.query.approved !== 'false';
    const abort = req.query.abort === 'true';
    const samplePayloadObj = {
      channel: requirement.sourceChannel === 'feishu' ? 'feishu' : 'wecom',
      taskId: task.id,
      approved,
      abort,
      comment: approved ? 'IM 卡片审批放行' : 'IM 卡片打回修改',
      reviewerId: 'lin.wei',
      timestamp: Date.now(),
      nonce: Math.random().toString(36).slice(2, 10),
    };
    const rawBody = JSON.stringify(samplePayloadObj);
    const signature = signImWebhookPayload(rawBody, imWebhookSecret);

    res.json({
      card: buildImApprovalCard(requirement, task),
      signedCallback: { rawBody, signature },
    });
  });

  app.post('/api/webhooks/im', (req, res) => {
    if (!imWebhookSecret) {
      res.status(503).json({ error: 'IM_WEBHOOK_SECRET is not configured' });
      return;
    }
    const { rawBody, signature } = req.body as {
      rawBody?: string;
      signature?: string;
    };

    const bodyStr =
      typeof rawBody === 'string' ? rawBody : JSON.stringify(req.body ?? {});
    const sigStr =
      signature ||
      String(req.headers['x-superagent-signature'] ?? '');

    const verified = verifyImWebhookPayload(bodyStr, sigStr, imWebhookSecret);
    if (!verified.valid || !verified.payload) {
      res.status(401).json({ error: verified.error || 'IM Webhook 验签失败' });
      return;
    }

    const cb = verified.payload;
    const task = state.current.tasks.find((t) => t.id === cb.taskId);
    if (!task) {
      res.status(404).json({ error: '回调目标任务不存在' });
      return;
    }

    const checkpoint = task.activeCheckpoint ?? {
      id: `ckpt-im-${task.id}`,
      taskId: task.id,
      gateType: 'MERGE_GATE' as const,
      summaryMd: 'IM 审批门禁',
      status: 'WAITING' as const,
      createdAt: new Date().toISOString(),
    };

    const { nextNode, shouldExtractSkill } = resolveGateDecision(task, checkpoint, {
      approved: cb.approved,
      abort: cb.abort,
      comment: `[${cb.channel}] ${cb.comment || ''}`.trim(),
      reviewerId: cb.reviewerId,
    });

    Object.assign(task, nextNode);
    if (cb.approved && !cb.abort && checkpoint.gateType === 'PLAN_GATE') {
      task.state = 'MERGED';
    }
    if (task.state === 'MERGED') {
      ctx.unlockReadyNodesForRequirement(task.reqId);
    }

    let extractedSkill = null;
    if (shouldExtractSkill) {
      extractedSkill = extractSkillDraft(task, 'team-platform-core', cb.reviewerId);
      if (extractedSkill) {
        extractedSkill.duplicateScore = computeMaxDuplicateScore(
          extractedSkill.contentMd,
          state.current.memories,
        );
        state.current.memories.unshift(extractedSkill);
      }
    }

    task.terminalLines.push(
      `[im-gateway:${cb.channel}] verified HMAC + 300s replay guard -> ${task.state}`,
    );

    recomputeRequirementStatus(task.reqId);
    saveState(state.current);

    res.json({
      verified: true,
      channel: cb.channel,
      task,
      extractedSkill,
    });
  });
}
