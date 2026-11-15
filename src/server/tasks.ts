import type { Express } from 'express';
import {
  extractSkillDraft,
  recordUsageAndCheckBudget,
  resolveGateDecision,
  transitionTaskVerification,
} from '../engine/stateMachine';
import { detectDangerousCommand, redactSecrets } from '../policy/engine';
import { parseCliNdjsonLine } from '../daemon/ndjsonParser';
import { computeMaxDuplicateScore } from '../memory/recallEngine';
import type { DagNode, VerifierCheck } from '../protocol';
import { evaluateGateRelease } from '../policy/gateTiers';
import {
  isRealRuntimeEnabled,
  recordStateTransition,
  runRealVerification,
} from '../runtime/realRuntime';
import type { ResourceKind } from '../loop/taskLifecycle';
import type { LoopCommandKind } from '../loop/commandBus';
import { applyResourceTransition, deriveRetrospective } from '../loop/taskLifecycle';
import type { ServerContext } from './context';

/**
 * Q8 门禁三挡：advance 落入 HUMAN_GATE 后按策略评估是否确定性放行。
 * 仅 auto_approve_when_green 且全绿、非保护分支、非 DANGER_GATE 时生效；
 * 代批挡（delegate_to_reviewer）当前诚实降级为人工（见 policy/gateTiers.ts）。
 */
function maybeAutoReleaseGate(ctx: ServerContext, task: DagNode): void {
  const checkpoint = task.activeCheckpoint;
  if (!checkpoint) return;
  const verdict = evaluateGateRelease(ctx.gateTierConfig, {
    gateType: checkpoint.gateType,
    verifierChecks: task.verifierChecks,
    worktreeBranch: task.worktreeBranch,
  });
  if (verdict.outcome !== 'auto_approve') return;

  const { state, seq, saveState, broadcastEnvelope, recomputeRequirementStatus, auditLog } = ctx;
  const reviewerId = `gate-policy:${verdict.tier}`;
  const { nextNode, shouldExtractSkill } = resolveGateDecision(task, checkpoint, {
    approved: true,
    reviewerId,
    comment: verdict.reason,
  });
  Object.assign(task, nextNode);
  if (checkpoint.gateType === 'PLAN_GATE') task.state = 'MERGED';
  if (shouldExtractSkill) {
    const skill = extractSkillDraft(task, 'team-platform-core', reviewerId);
    if (skill) {
      skill.duplicateScore = computeMaxDuplicateScore(skill.contentMd, state.current.memories);
      state.current.memories.unshift(skill);
    }
  }
  task.events.push({
    id: `ev-${Date.now()}`,
    ts: new Date().toTimeString().slice(0, 8),
    seq: ++seq.current,
    kind: 'verifier_check',
    title: `门禁策略自动放行（${verdict.tier}）`,
    detail: verdict.reason,
    status: 'ok',
  });
  task.terminalLines.push(`[gate-policy] AUTO-RELEASE (${verdict.tier}): ${verdict.reason}`);
  if (task.state === 'MERGED') {
    ctx.unlockReadyNodesForRequirement(task.reqId);
  }
  broadcastEnvelope({
    machineId: task.assignedMachine || 'mac-studio-sh-01',
    seq: ++seq.current,
    ts: Date.now(),
    payload: { type: 'STATE_ACK', taskId: task.id, state: task.state },
  });
  recomputeRequirementStatus(task.reqId);
  auditLog.record({
    userId: 'gate-policy',
    teamId: 'team-platform-core',
    action: 'task:gate',
    target: `auto-release ${task.id}`,
    outcome: 'allowed',
    detail: verdict.reason,
  });
  saveState(state.current);
}

/** 任务域路由：advance / simulate / gate / ndjson / input / comments / resource-transition / retrospective。 */
export function registerTaskRoutes(app: Express, ctx: ServerContext): void {
  const { state, seq, saveState, broadcastEnvelope, recomputeRequirementStatus, commandBus, repoRoot, eventLog, tracing } = ctx;
  const tracer = tracing?.tracer;

  app.post('/api/tasks/:id/advance', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const timeStr = new Date().toTimeString().slice(0, 8);
    const machine = task.assignedMachine || 'mac-studio-sh-01';

    if (task.state === 'PENDING' || task.state === 'RETRY_WAIT') {
      const usageStep = recordUsageAndCheckBudget(task, 5400, 1800, 22);
      Object.assign(task, usageStep.nextNode);
      if (usageStep.budgetExceeded) {
        task.events.push({
          id: `ev-${Date.now()}`,
          ts: timeStr,
          seq: ++seq.current,
          kind: 'verifier_check',
          title: 'Token 预算熔断：已挂起任务并等待人工调整预算',
          detail: task.activeCheckpoint?.summaryMd || '超出预设 budget_limit',
          status: 'failed',
        });
        task.terminalLines.push('[budget-guard] TOKEN BUDGET EXCEEDED -> ESCALATED');
        broadcastEnvelope({
          machineId: machine,
          seq: seq.current,
          ts: Date.now(),
          payload: { type: 'STATE_ACK', taskId: task.id, state: 'ESCALATED' },
        });
      } else {
        task.state = 'RUNNING';
        const ev = {
          id: `ev-${Date.now()}`,
          ts: timeStr,
          seq: ++seq.current,
          kind: 'file_edit' as const,
          title: `执行 ${task.provider} 修复与增量编码 (${task.worktreeBranch})`,
          detail: task.lastErrorFeedback
            ? `已注入错误反馈并重新生成补丁：${task.lastErrorFeedback}`
            : '正在隔离 Worktree 中编写变更与单元测试。',
          status: 'running' as const,
        };
        task.events.push(ev);
        task.terminalLines.push(`[${task.provider}] resuming execution in ${task.worktreeBranch} ...`);
        broadcastEnvelope({
          machineId: machine,
          seq: seq.current,
          ts: Date.now(),
          payload: { type: 'STATE_ACK', taskId: task.id, state: 'RUNNING' },
        });
      }
    } else if (task.state === 'RUNNING') {
      const usageStep = recordUsageAndCheckBudget(task, 6800, 2200, 28);
      Object.assign(task, usageStep.nextNode);
      if (usageStep.budgetExceeded) {
        task.events.push({
          id: `ev-${Date.now()}`,
          ts: timeStr,
          seq: ++seq.current,
          kind: 'verifier_check',
          title: 'Token 预算熔断：已挂起任务并等待人工调整预算',
          detail: task.activeCheckpoint?.summaryMd || '超出预设 budget_limit',
          status: 'failed',
        });
        task.terminalLines.push('[budget-guard] TOKEN BUDGET EXCEEDED -> ESCALATED');
        broadcastEnvelope({
          machineId: machine,
          seq: seq.current,
          ts: Date.now(),
          payload: { type: 'STATE_ACK', taskId: task.id, state: 'ESCALATED' },
        });
      } else {
        task.state = 'VERIFYING';
        let checks: VerifierCheck[] = [
          { name: 'lint', passed: true, durationMs: 360, summary: '0 warnings' },
          { name: 'typecheck', passed: true, durationMs: 740, summary: 'tsc --noEmit passed' },
          { name: 'unit_test', passed: true, durationMs: 145, summary: 'all assertions passed' },
          { name: 'cross_review', passed: true, durationMs: 1620, summary: '异构模型交叉审查通过' },
        ];
        let verifyPassed = true;
        let verifyLogs = 'lint / typecheck / unit_test / cross_review 全部通过。';

        if (isRealRuntimeEnabled()) {
          const real = runRealVerification(task, repoRoot, eventLog, tracer);
          checks = real.checks;
          verifyPassed = real.passed;
          verifyLogs = real.logs.trim() || '确定性门禁未产生输出';
          recordStateTransition(task, 'RUNNING', 'VERIFYING', real.traceId, eventLog, tracer);
          task.terminalLines.push(
            `[real-verifier] ${verifyPassed ? 'PASS' : 'FAIL'} (${real.traceId})`,
          );
        }

        task.verifierChecks = checks;
        const { nextNode } = transitionTaskVerification(
          task,
          verifyPassed,
          verifyLogs,
          task.role === 'planner' ? 'PLAN_GATE' : 'MERGE_GATE',
        );
        Object.assign(task, nextNode);
        task.events.push({
          id: `ev-${Date.now()}`,
          ts: timeStr,
          seq: ++seq.current,
          kind: 'verifier_check',
          title: verifyPassed
            ? '确定性门禁全绿，已进入人工审批门禁'
            : '真实确定性门禁未通过，已回灌日志并打回重试',
          detail: verifyPassed
            ? isRealRuntimeEnabled()
              ? 'npm run lint + npm test 真实退出码均为 0'
              : 'lint + typecheck + unit_test + 异构 Reviewer 交叉审查通过'
            : verifyLogs.slice(0, 500),
          status: verifyPassed ? 'ok' : 'failed',
        });
        task.terminalLines.push(
          verifyPassed
            ? '[verifier] all checks green -> entering HUMAN_GATE'
            : `[verifier] FAILED -> ${task.state}`,
        );
        broadcastEnvelope({
          machineId: machine,
          seq: seq.current,
          ts: Date.now(),
          payload: { type: 'STATE_ACK', taskId: task.id, state: task.state },
        });
      }
    } else if (task.state === 'VERIFYING') {
      const { nextNode } = transitionTaskVerification(
        task,
        true,
        '确定性门禁全绿，等待 Merge Gate 放行。',
        'MERGE_GATE',
      );
      Object.assign(task, nextNode);
    }

    if (task.state === 'HUMAN_GATE' && task.activeCheckpoint) {
      maybeAutoReleaseGate(ctx, task);
    }

    recomputeRequirementStatus(task.reqId);
    saveState(state.current);
    res.json({ task, requirement: state.current.requirements.find((r) => r.id === task.reqId) });
  });

  app.post('/api/tasks/:id/simulate-failure', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const errorLog =
      (req.body as { errorLog?: string })?.errorLog ||
      'TypeError: Cannot validate signature on empty payload (unit_test failed at line 42)';
    const { redacted, hitCount } = redactSecrets(errorLog);

    task.verifierChecks = [
      { name: 'lint', passed: true, durationMs: 320, summary: 'eslint clean' },
      { name: 'typecheck', passed: true, durationMs: 680, summary: 'tsc passed' },
      { name: 'unit_test', passed: false, durationMs: 88, summary: redacted },
    ];

    const { nextNode } = transitionTaskVerification(task, false, redacted);
    Object.assign(task, nextNode);

    const timeStr = new Date().toTimeString().slice(0, 8);
    task.events.push({
      id: `ev-${Date.now()}`,
      ts: timeStr,
      seq: ++seq.current,
      kind: 'verifier_check',
      title:
        task.state === 'ESCALATED'
          ? `重试次数达到上限 (${task.retryCount}/${task.maxRetries})，触发熔断挂起`
          : `确定性校验失败，进入 RETRY_WAIT (${task.retryCount}/${task.maxRetries})`,
      detail: redacted,
      status: 'failed',
      redactedHits: hitCount,
    });
    task.terminalLines.push(`[verifier] FAIL: ${redacted}`);
    task.terminalLines.push(`[loop] state -> ${task.state} (${task.retryCount}/${task.maxRetries})`);

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: seq.current,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: task.id, state: task.state },
    });

    recomputeRequirementStatus(task.reqId);
    saveState(state.current);
    res.json({ task });
  });

  app.post('/api/tasks/:id/simulate-danger', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const cmd = (req.body as { command?: string })?.command || 'git push --force origin main';
    const danger = detectDangerousCommand(cmd);
    const timeStr = new Date().toTimeString().slice(0, 8);

    task.state = 'HUMAN_GATE';
    task.activeCheckpoint = {
      id: `ckpt-danger-${Date.now()}`,
      taskId: task.id,
      gateType: 'DANGER_GATE',
      summaryMd: `${danger.reason || '检测到高危操作指令'}\n\n拦截命令：\`${cmd}\``,
      status: 'WAITING',
      createdAt: new Date().toISOString(),
    };

    task.events.push({
      id: `ev-${Date.now()}`,
      ts: timeStr,
      seq: ++seq.current,
      kind: 'acp_intercept',
      title: `ACP 双向拦截：${danger.rule || 'DANGER_COMMAND'}`,
      detail: `已挂起工具调用 "${cmd}"，等待 Danger Gate 审批`,
      status: 'blocked',
    });
    task.terminalLines.push(`[acp-guard] INTERCEPTED: ${cmd} -> DANGER_GATE`);

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: seq.current,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: task.id, state: 'HUMAN_GATE' },
    });

    recomputeRequirementStatus(task.reqId);
    saveState(state.current);
    res.json({ task });
  });

  app.post('/api/tasks/:id/gate', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const { approved, abort, comment, reviewerId } = req.body as {
      approved: boolean;
      abort?: boolean;
      comment?: string;
      reviewerId?: string;
    };

    const checkpoint = task.activeCheckpoint ?? {
      id: `ckpt-${task.id}`,
      taskId: task.id,
      gateType: 'MERGE_GATE' as const,
      summaryMd: '人工门禁检查点',
      status: 'WAITING' as const,
      createdAt: new Date().toISOString(),
    };

    const { nextNode, shouldExtractSkill } = resolveGateDecision(task, checkpoint, {
      approved: Boolean(approved),
      abort: Boolean(abort),
      comment,
      reviewerId: reviewerId || 'lin.wei',
    });

    Object.assign(task, nextNode);

    const timeStr = new Date().toTimeString().slice(0, 8);
    task.events.push({
      id: `ev-${Date.now()}`,
      ts: timeStr,
      seq: ++seq.current,
      kind: 'verifier_check',
      title: abort
        ? '操作员已终止任务'
        : approved
          ? `Gate 批准放行 -> ${task.state}`
          : `附带意见打回修改 -> ${task.state}`,
      detail: comment || (approved ? '批准放行' : '打回重试'),
      status: abort || !approved ? 'failed' : 'ok',
    });
    task.terminalLines.push(
      `[gate] decision=${abort ? 'ABORT' : approved ? 'APPROVE' : 'REJECT'} next_state=${task.state}`,
    );

    let extractedSkill = null;
    if (shouldExtractSkill) {
      extractedSkill = extractSkillDraft(task, 'team-platform-core', reviewerId || 'lin.wei');
      if (extractedSkill) {
        extractedSkill.duplicateScore = computeMaxDuplicateScore(
          extractedSkill.contentMd,
          state.current.memories,
        );
        state.current.memories.unshift(extractedSkill);
      }
    }

    // Special case: if a PLAN_GATE node was approved, treat planning node as MERGED so downstream builders unlock immediately!
    if (approved && !abort && checkpoint.gateType === 'PLAN_GATE') {
      task.state = 'MERGED';
    }

    if (task.state === 'MERGED') {
      ctx.unlockReadyNodesForRequirement(task.reqId);
    }

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: ++seq.current,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: task.id, state: task.state },
    });

    recomputeRequirementStatus(task.reqId);
    saveState(state.current);

    res.json({
      task,
      extractedSkill,
      tasks: state.current.tasks,
      requirements: state.current.requirements,
      memories: state.current.memories,
    });
  });

  app.post('/api/tasks/:id/ndjson', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const { line } = req.body as { line?: string };
    if (!line || !line.trim()) {
      res.status(400).json({ error: 'NDJSON 行内容不能为空' });
      return;
    }

    let budgetTriggered = false;
    try {
      const rawObj = JSON.parse(line) as {
        type?: string;
        inputTokens?: number;
        outputTokens?: number;
      };
      if (rawObj.type === 'usage') {
        const usageRes = recordUsageAndCheckBudget(
          task,
          Number(rawObj.inputTokens ?? 0),
          Number(rawObj.outputTokens ?? 0),
          8,
        );
        Object.assign(task, usageRes.nextNode);
        budgetTriggered = usageRes.budgetExceeded;
        if (budgetTriggered) {
          task.terminalLines.push('[budget-guard] TOKEN BUDGET EXCEEDED -> ESCALATED');
          recomputeRequirementStatus(task.reqId);
          broadcastEnvelope({
            machineId: task.assignedMachine || 'mac-studio-sh-01',
            seq: ++seq.current,
            ts: Date.now(),
            payload: { type: 'STATE_ACK', taskId: task.id, state: 'ESCALATED' },
          });
        }
      }
    } catch {
      // Non-JSON line handled below by parseCliNdjsonLine
    }

    const parsed = parseCliNdjsonLine(task.provider, line, ++seq.current);
    if (parsed.event) {
      task.events.push(parsed.event);
      broadcastEnvelope({
        machineId: task.assignedMachine || 'mac-studio-sh-01',
        seq: seq.current,
        ts: Date.now(),
        payload: { type: 'AGENT_EVENT', taskId: task.id, event: parsed.event },
      });
    }
    if (parsed.terminalChunk) {
      task.terminalLines.push(parsed.terminalChunk);
      broadcastEnvelope({
        machineId: task.assignedMachine || 'mac-studio-sh-01',
        seq: ++seq.current,
        ts: Date.now(),
        payload: { type: 'TERMINAL_CHUNK', taskId: task.id, chunk: parsed.terminalChunk },
      });
    }
    if (parsed.dangerIntercept) {
      task.state = 'HUMAN_GATE';
      task.activeCheckpoint = {
        id: `ckpt-acp-${Date.now()}`,
        taskId: task.id,
        gateType: 'DANGER_GATE',
        summaryMd: `${parsed.dangerIntercept.reason}\n\n拦截命令：\`${parsed.dangerIntercept.command}\``,
        status: 'WAITING',
        createdAt: new Date().toISOString(),
      };
      recomputeRequirementStatus(task.reqId);
    }

    saveState(state.current);
    res.json({ task, parsed, budgetTriggered });
  });

  app.post('/api/tasks/:id/input', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const { text } = req.body as { text?: string };
    if (!text || !text.trim()) {
      res.status(400).json({ error: '终端输入指令不能为空' });
      return;
    }

    const { redacted, hitCount } = redactSecrets(text.trim());
    const line = `> [sendInput] ${redacted}`;
    task.terminalLines.push(line);

    const ev = {
      id: `ev-${Date.now()}`,
      ts: new Date().toTimeString().slice(0, 8),
      seq: ++seq.current,
      kind: 'shell_exec' as const,
      title: `向 ${task.provider} (${task.adapterMode}) 注入交互输入`,
      detail: redacted,
      status: 'ok' as const,
      redactedHits: hitCount,
    };
    task.events.push(ev);

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: seq.current,
      ts: Date.now(),
      payload: { type: 'TERMINAL_CHUNK', taskId: task.id, chunk: line },
    });

    saveState(state.current);
    res.json({ task });
  });

  app.post('/api/tasks/:id/comments', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }
    const { file, line, comment, author } = req.body as {
      file?: string;
      line?: number;
      comment?: string;
      author?: string;
    };
    if (!comment || !comment.trim()) {
      res.status(400).json({ error: '行级批注内容不能为空' });
      return;
    }
    const entry = {
      id: `lc-${Date.now()}`,
      file: file || 'diff',
      line: Number(line || 1),
      author: author || 'lin.wei',
      comment: comment.trim(),
      createdAt: new Date().toISOString(),
    };
    task.lineComments.push(entry);
    saveState(state.current);
    res.status(201).json({ lineComment: entry, task });
  });

  // 新增 3 态（BLOCKED_BY_RESOURCE / QUARANTINED / WAITING_APPROVAL）的真实生产者。
  app.post('/api/tasks/:id/resource-transition', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    const body = (req.body ?? {}) as { kind?: unknown; commandId?: unknown };
    const allowedKinds: ResourceKind[] = [
      'BLOCK_RESOURCE', 'RELEASE_RESOURCE', 'QUARANTINE', 'RELEASE_QUARANTINE',
      'WAIT_APPROVAL', 'APPROVE', 'CANCEL',
    ];
    if (typeof body.kind !== 'string' || !allowedKinds.includes(body.kind as ResourceKind)) {
      res.status(400).json({
        error: `非法 kind，允许: ${allowedKinds.join(' / ')}`,
        from: task.state,
        to: null,
      });
      return;
    }
    const commandId =
      typeof body.commandId === 'string' && body.commandId.trim()
        ? body.commandId
        : `resource-${task.id}-${Date.now()}`;
    const submitted = commandBus.submit({
      commandId,
      taskId: task.id,
      kind: body.kind as LoopCommandKind,
    });
    if (!submitted.accepted) {
      res.status(submitted.duplicate ? 409 : 400).json({
        error: submitted.reason ?? '命令被拒绝',
        duplicate: submitted.duplicate,
      });
      return;
    }
    const outcome = applyResourceTransition(task, body.kind as ResourceKind, eventLog);
    if (!outcome.ok) {
      // 命令已入 append-only 日志，这是审计事实，不回滚日志。
      // 回带 from/to：客户端需知道被状态机拒绝的是哪条迁移，否则只能猜。
      res.status(400).json({
        error: outcome.reason,
        from: outcome.from,
        to: outcome.to,
        task: outcome.node,
      });
      return;
    }
    const idx = state.current.tasks.findIndex((t) => t.id === task.id);
    state.current.tasks[idx] = outcome.node;
    // 资源迁移同样会改变需求聚合状态（如 WAITING_APPROVAL -> AWAITING_GATE）；
    // 此前漏调导致需求状态陈旧（HTTP 测试抓出）。
    recomputeRequirementStatus(outcome.node.reqId);
    saveState(state.current);
    res.json({
      task: outcome.node,
      from: outcome.from,
      to: outcome.to,
      ok: true,
      requirement: state.current.requirements.find((r) => r.id === outcome.node.reqId),
    });
  });

  // Q5 红线：只产出草案，绝不自动改写已发布 SOP，也不写任何文件。
  app.post('/api/tasks/:id/retrospective', (req, res) => {
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    res.json({
      ...deriveRetrospective(task),
      taskId: task.id,
      note: '仅产出 Skill 草案；必须经人审 MR 才能改写已发布 SOP。本端点不写任何文件。',
    });
  });
}
