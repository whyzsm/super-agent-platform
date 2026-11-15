import express, { type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { createInitialSeedState, type PlatformState } from './src/data/seed';
import {
  detectDangerousCommand,
  extractSkillDraft,
  getReadyDagNodes,
  recordUsageAndCheckBudget,
  redactSecrets,
  resolveGateDecision,
  transitionTaskVerification,
} from './src/engine/stateMachine';
import { parseCliNdjsonLine } from './src/daemon/ndjsonParser';
import {
  buildImApprovalCard,
  signImWebhookPayload,
  verifyImWebhookPayload,
} from './src/gateway/imWebhook';
import {
  computeMaxDuplicateScore,
  recallMemoryAssets,
} from './src/memory/recallEngine';
import { appendRuntimeEvent, lastEventSeq, replayRuntimeEvents } from './src/runtime/eventLog';
import { createHeadlessJsonAdapter } from './src/runtime/adapters/headlessJson';
import {
  isRealRuntimeEnabled,
  recordStateTransition,
  runRealVerification,
} from './src/runtime/realRuntime';
import type {
  AgentProvider,
  AgentReasoningEvent,
  DaemonEnvelope,
  DagNode,
  MemoryAsset,
  Requirement,
  SopTemplateId,
  TeamAiAsset,
  VerifierCheck,
} from './src/protocol';

const PORT = 3000;
const STATE_FILE = path.resolve(process.cwd(), '.superagent-state.json');
const IM_WEBHOOK_SECRET = process.env.IM_WEBHOOK_SECRET;
if (!IM_WEBHOOK_SECRET) {
  console.warn(
    '[SuperAgent] IM_WEBHOOK_SECRET is not configured; IM webhook endpoints will return 503.',
  );
}

function syncTeamAiFileToDisk(relPath: string, content: string): void {
  if (!relPath.startsWith('.teamai/')) return;
  try {
    const absPath = path.resolve(process.cwd(), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  } catch {
    // Ignore disk write failure in read-only environments
  }
}

function loadOrInitState(): PlatformState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as PlatformState;
      if (parsed && Array.isArray(parsed.requirements) && Array.isArray(parsed.tasks)) {
        return parsed;
      }
    }
  } catch {
    // Fall back to fresh seed state
  }
  const initial = createInitialSeedState();
  saveState(initial);
  return initial;
}

function saveState(state: PlatformState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error(
      `[saveState] failed to write ${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

let state: PlatformState = loadOrInitState();
let globalSeq = 1000;
const sseClients = new Set<Response>();

function broadcastEnvelope(envelope: DaemonEnvelope): void {
  const payload = `data: ${JSON.stringify(envelope)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function recomputeRequirementStatus(reqId: string): void {
  const req = state.requirements.find((r) => r.id === reqId);
  if (!req) return;
  const reqTasks = state.tasks.filter((t) => t.reqId === reqId);
  if (reqTasks.length === 0) {
    req.status = 'PLANNING';
    return;
  }
  if (reqTasks.some((t) => t.state === 'ESCALATED')) {
    req.status = 'ESCALATED';
  } else if (reqTasks.some((t) => t.state === 'HUMAN_GATE')) {
    req.status = 'AWAITING_GATE';
  } else if (reqTasks.every((t) => t.state === 'MERGED' || t.state === 'CANCELLED')) {
    req.status = 'COMPLETED';
  } else {
    req.status = 'IN_PROGRESS';
  }
}

function unlockReadyNodesForRequirement(reqId: string): void {
  const reqNodes = state.tasks.filter((t) => t.reqId === reqId);
  const ready = getReadyDagNodes(reqNodes);
  for (const node of ready) {
    const target = state.tasks.find((t) => t.id === node.id);
    if (!target) continue;
    target.state = 'RUNNING';
    const timeStr = new Date().toTimeString().slice(0, 8);
    const ev = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: timeStr,
      seq: ++globalSeq,
      kind: 'thought' as const,
      title: `上游依赖已全部合入，Daemon 自动拉起隔离 Worktree (${target.worktreeBranch})`,
      detail: `在 ${target.assignedMachine || 'mac-studio-sh-01'} 上执行 ${target.provider} (${target.adapterMode})`,
      status: 'running' as const,
    };
    target.events.push(ev);
    target.terminalLines.push(
      `[scheduler] upstream dependencies MERGED -> spawning ${target.id} on ${target.worktreeBranch}`,
    );
    broadcastEnvelope({
      machineId: target.assignedMachine || 'mac-studio-sh-01',
      seq: globalSeq,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: target.id, state: 'RUNNING' },
    });
    broadcastEnvelope({
      machineId: target.assignedMachine || 'mac-studio-sh-01',
      seq: ++globalSeq,
      ts: Date.now(),
      payload: { type: 'AGENT_EVENT', taskId: target.id, event: ev },
    });
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, seq: globalSeq, requirements: state.requirements.length });
  });

  app.get('/api/bootstrap', (_req, res) => {
    res.json(state);
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    const hb: DaemonEnvelope = {
      machineId: 'mac-studio-sh-01',
      seq: ++globalSeq,
      ts: Date.now(),
      payload: {
        type: 'HEARTBEAT',
        activeTaskIds: state.tasks
          .filter((t) => t.state === 'RUNNING' || t.state === 'VERIFYING')
          .map((t) => t.id),
        cpuLoad: 39.2,
      },
    };
    res.write(`data: ${JSON.stringify(hb)}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.post('/api/requirements', (req, res) => {
    const {
      title,
      specMd,
      repoUrl,
      baseBranch,
      sourceChannel,
      primaryProvider,
      sopTemplate,
    } = req.body as {
      title?: string;
      specMd?: string;
      repoUrl?: string;
      baseBranch?: string;
      sourceChannel?: 'web' | 'cli' | 'wecom' | 'feishu';
      primaryProvider?: AgentProvider;
      sopTemplate?: SopTemplateId;
    };

    if (!title || !title.trim() || !specMd || !specMd.trim()) {
      res.status(400).json({ error: '需求标题与需求规格说明书不能为空' });
      return;
    }

    const reqId = `req-${Date.now().toString().slice(-4)}`;
    const nowIso = new Date().toISOString();
    const provider: AgentProvider = primaryProvider || 'codex';
    const template: SopTemplateId = sopTemplate === 'bugfix_flow' ? 'bugfix_flow' : 'feature_flow';

    const newReq: Requirement = {
      id: reqId,
      teamId: 'team-platform-core',
      title: title.trim(),
      specMd: specMd.trim(),
      repoUrl: (repoUrl || 'git@example.invalid:superagent/app-service.git').trim(),
      baseBranch: (baseBranch || 'main').trim(),
      sourceChannel: sourceChannel || 'web',
      sopTemplate: template,
      status: 'AWAITING_GATE',
      createdBy: 'lin.wei',
      createdAt: nowIso,
    };

    const planId = `task-${reqId}-plan`;
    const revId = `task-${reqId}-rev`;
    const timeStr = new Date().toTimeString().slice(0, 8);

    const newTasks: DagNode[] =
      template === 'bugfix_flow'
        ? [
            {
              id: planId,
              reqId,
              title: '缺陷复现定位与最小修复方案',
              role: 'planner',
              provider: 'claude-code',
              adapterMode: 'headless_json',
              dependsOn: [],
              state: 'HUMAN_GATE',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'mac-studio-sh-01',
              worktreeBranch: `agent/${planId}`,
              worktreePath: `~/.superagent/worktrees/app-service/${planId}`,
              localPort: 4401,
              position: { x: 40, y: 140 },
              events: [
                {
                  id: `ev-${Date.now()}-1`,
                  ts: timeStr,
                  seq: ++globalSeq,
                  kind: 'thought',
                  title: '按 Bug 修复流定位故障堆栈与最小受影响模块',
                  detail: '生成单节点快速修复 Worktree + 回归测试交叉审查拓扑，等待 Plan Gate 放行。',
                  status: 'ok',
                },
              ],
              terminalLines: [
                `[claude-code -p --output-format stream-json] reproducing "${newReq.title}"`,
                `[planner] generated 3-node bugfix_flow DAG off ${newReq.baseBranch}`,
                '[gate] awaiting PLAN_GATE approval...',
              ],
              verifierChecks: [
                { name: 'lint', passed: true, durationMs: 190, summary: 'repro trace verified' },
              ],
              lineComments: [],
              usage: {
                inputTokens: 2400,
                outputTokens: 780,
                costUsd: 0.0189,
                durationSec: 11,
                budgetTokens: 40000,
              },
              activeCheckpoint: {
                id: `ckpt-${planId}`,
                taskId: planId,
                gateType: 'PLAN_GATE',
                summaryMd: `Planner Agent 已按「Bug 修复流」生成「${newReq.title}」3 节点拓扑：\n- Fix Builder (${provider}): 缺陷修复 + 复现单测\n- Reviewer (claude-code): 回归与交叉 Review\n请确认是否放行拉起隔离 Worktree。`,
                status: 'WAITING',
                createdAt: nowIso,
              },
              diffPatch: `--- a/.teamai/plans/${reqId}.md\n+++ b/.teamai/plans/${reqId}.md\n@@ -0,0 +1,4 @@\n+# Bugfix Flow: ${newReq.title}\n+- Step 1 (planner): Repro & minimal fix scope\n+- Step 2 (${provider}): Patch + regression unit test\n+- Step 3 (claude-code): Cross-model regression review`,
            },
            {
              id: `task-${reqId}-fix`,
              reqId,
              title: '隔离 Worktree 缺陷修复与回归单测',
              role: 'builder',
              provider,
              adapterMode: provider === 'workbuddy' ? 'acp_bidirectional' : 'headless_json',
              dependsOn: [planId],
              state: 'PENDING',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'ubuntu-ci-runner-04',
              worktreeBranch: `agent/task-${reqId}-fix`,
              worktreePath: `~/.superagent/worktrees/app-service/task-${reqId}-fix`,
              localPort: 4402,
              position: { x: 350, y: 140 },
              events: [],
              terminalLines: [`[scheduler] waiting for Plan Gate (${planId})`],
              verifierChecks: [],
              lineComments: [],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                durationSec: 0,
                budgetTokens: 60000,
              },
              diffPatch: `--- a/src/fix/patch.ts\n+++ b/src/fix/patch.ts\n@@ -1,3 +1,6 @@\n+export function applyBugfixGuard(payload: unknown) {\n+  if (!payload) throw new Error('InvalidPayloadError');\n+  return payload;\n+}`,
            },
            {
              id: revId,
              reqId,
              title: '回归测试与异构交叉 Review',
              role: 'reviewer',
              provider: 'claude-code',
              adapterMode: 'headless_json',
              dependsOn: [`task-${reqId}-fix`],
              state: 'PENDING',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'mac-studio-sh-01',
              worktreeBranch: `agent/${revId}`,
              worktreePath: `~/.superagent/worktrees/app-service/${revId}`,
              localPort: 4403,
              position: { x: 660, y: 140 },
              events: [],
              terminalLines: [`[scheduler] waiting for bugfix builder (task-${reqId}-fix)`],
              verifierChecks: [],
              lineComments: [],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                durationSec: 0,
                budgetTokens: 50000,
              },
              diffPatch: `// 修复节点合入后自动拉起回归测试与交叉 Review`,
            },
          ]
        : [
            {
              id: planId,
              reqId,
              title: '需求拆解与并行 Worktree 拓扑规划',
              role: 'planner',
              provider: 'claude-code',
              adapterMode: 'headless_json',
              dependsOn: [],
              state: 'HUMAN_GATE',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'mac-studio-sh-01',
              worktreeBranch: `agent/${planId}`,
              worktreePath: `~/.superagent/worktrees/app-service/${planId}`,
              localPort: 4401,
              position: { x: 40, y: 140 },
              events: [
                {
                  id: `ev-${Date.now()}-1`,
                  ts: timeStr,
                  seq: ++globalSeq,
                  kind: 'thought',
                  title: '完成规格解析，生成 2 路并行 Builder Worktree 方案',
                  detail: '无共享写文件路径冲突，建议立即进入 Plan Gate 确认拆解拓扑。',
                  status: 'ok',
                },
              ],
              terminalLines: [
                `[claude-code -p --output-format stream-json] analyzing "${newReq.title}"`,
                `[planner] created 2 parallel builder branches off ${newReq.baseBranch}`,
                '[gate] awaiting PLAN_GATE approval...',
              ],
              verifierChecks: [
                { name: 'lint', passed: true, durationMs: 210, summary: 'plan schema valid' },
              ],
              lineComments: [],
              usage: {
                inputTokens: 3200,
                outputTokens: 960,
                costUsd: 0.024,
                durationSec: 14,
                budgetTokens: 40000,
              },
              activeCheckpoint: {
                id: `ckpt-${planId}`,
                taskId: planId,
                gateType: 'PLAN_GATE',
                summaryMd: `Planner Agent 已按「标准 Feature 开发流」完成「${newReq.title}」任务拆解：\n- Builder 1 (${provider}): 核心业务模块实现\n- Builder 2 (workbuddy): 单元测试与边界校验\n请确认是否放行拉起并行 Worktree。`,
                status: 'WAITING',
                createdAt: nowIso,
              },
              diffPatch: `--- a/.teamai/plans/${reqId}.md\n+++ b/.teamai/plans/${reqId}.md\n@@ -0,0 +1,5 @@\n+# ${newReq.title}\n+- Base Branch: ${newReq.baseBranch}\n+- Builder 1 (${provider}): Core implementation\n+- Builder 2 (workbuddy): Tests & edge-case guards\n+- Reviewer (claude-code): Cross-model security audit`,
            },
            {
              id: `task-${reqId}-b1`,
              reqId,
              title: '核心业务接口与状态流转实现',
              role: 'builder',
              provider,
              adapterMode: 'headless_json',
              dependsOn: [planId],
              state: 'PENDING',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'mac-studio-sh-01',
              worktreeBranch: `agent/task-${reqId}-b1`,
              worktreePath: `~/.superagent/worktrees/app-service/task-${reqId}-b1`,
              localPort: 4402,
              position: { x: 350, y: 50 },
              events: [],
              terminalLines: [`[scheduler] waiting for Plan Gate (${planId})`],
              verifierChecks: [],
              lineComments: [],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                durationSec: 0,
                budgetTokens: 80000,
              },
              diffPatch: `--- a/src/service/handler.ts\n+++ b/src/service/handler.ts\n@@ -1,3 +1,8 @@\n+export async function executeRequirementTask(input: unknown) {\n+  // Pending Plan Gate approval\n+  return { ok: true, input };\n+}`,
            },
            {
              id: `task-${reqId}-b2`,
              reqId,
              title: '集成单测与沙箱边界回归套件',
              role: 'builder',
              provider: 'workbuddy',
              adapterMode: 'acp_bidirectional',
              dependsOn: [planId],
              state: 'PENDING',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'ubuntu-ci-runner-04',
              worktreeBranch: `agent/task-${reqId}-b2`,
              worktreePath: `~/.superagent/worktrees/app-service/task-${reqId}-b2`,
              localPort: 4403,
              position: { x: 350, y: 230 },
              events: [],
              terminalLines: [`[scheduler] waiting for Plan Gate (${planId})`],
              verifierChecks: [],
              lineComments: [],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                durationSec: 0,
                budgetTokens: 60000,
              },
              diffPatch: `--- a/src/service/handler.test.ts\n+++ b/src/service/handler.test.ts\n@@ -0,0 +1,6 @@\n+import { describe, it, expect } from 'vitest';\n+describe('requirement guard', () => {\n+  it('validates schema', () => expect(true).toBe(true));\n+});`,
            },
            {
              id: revId,
              reqId,
              title: '异构模型交叉安全与规范审查',
              role: 'reviewer',
              provider: 'claude-code',
              adapterMode: 'headless_json',
              dependsOn: [`task-${reqId}-b1`, `task-${reqId}-b2`],
              state: 'PENDING',
              retryCount: 0,
              maxRetries: 3,
              assignedMachine: 'mac-studio-sh-01',
              worktreeBranch: `agent/${revId}`,
              worktreePath: `~/.superagent/worktrees/app-service/${revId}`,
              localPort: 4404,
              position: { x: 660, y: 140 },
              events: [],
              terminalLines: [`[scheduler] waiting for builders [task-${reqId}-b1, task-${reqId}-b2]`],
              verifierChecks: [],
              lineComments: [],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                durationSec: 0,
                budgetTokens: 50000,
              },
              diffPatch: `// 等待并行 Builder 完成后执行交叉审查`,
            },
          ];

    state.requirements.unshift(newReq);
    state.tasks.push(...newTasks);
    saveState(state);

    res.status(201).json({ requirement: newReq, tasks: newTasks });
  });

  app.post('/api/tasks/:id/advance', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
          seq: ++globalSeq,
          kind: 'verifier_check',
          title: 'Token 预算熔断：已挂起任务并等待人工调整预算',
          detail: task.activeCheckpoint?.summaryMd || '超出预设 budget_limit',
          status: 'failed',
        });
        task.terminalLines.push('[budget-guard] TOKEN BUDGET EXCEEDED -> ESCALATED');
        broadcastEnvelope({
          machineId: machine,
          seq: globalSeq,
          ts: Date.now(),
          payload: { type: 'STATE_ACK', taskId: task.id, state: 'ESCALATED' },
        });
      } else {
        task.state = 'RUNNING';
        const ev = {
          id: `ev-${Date.now()}`,
          ts: timeStr,
          seq: ++globalSeq,
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
          seq: globalSeq,
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
          seq: ++globalSeq,
          kind: 'verifier_check',
          title: 'Token 预算熔断：已挂起任务并等待人工调整预算',
          detail: task.activeCheckpoint?.summaryMd || '超出预设 budget_limit',
          status: 'failed',
        });
        task.terminalLines.push('[budget-guard] TOKEN BUDGET EXCEEDED -> ESCALATED');
        broadcastEnvelope({
          machineId: machine,
          seq: globalSeq,
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
          const real = runRealVerification(task);
          checks = real.checks;
          verifyPassed = real.passed;
          verifyLogs = real.logs.trim() || '确定性门禁未产生输出';
          recordStateTransition(task, 'RUNNING', 'VERIFYING', real.traceId);
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
          seq: ++globalSeq,
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
          seq: globalSeq,
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

    recomputeRequirementStatus(task.reqId);
    saveState(state);
    res.json({ task, requirement: state.requirements.find((r) => r.id === task.reqId) });
  });

  // 真实运行时受控端点：默认关闭，且必须显式配置 CLI 命令，避免误触发模型调用。
  app.post('/api/tasks/:id/real-spawn', (req, res) => {
    if (!isRealRuntimeEnabled()) {
      res.status(404).json({ error: '真实运行时未启用' });
      return;
    }
    if (!process.env.SUPERAGENT_CLI_COMMAND) {
      res.status(400).json({
        error: '未配置 SUPERAGENT_CLI_COMMAND，拒绝默认发起模型调用',
      });
      return;
    }
    const task = state.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const adapter = createHeadlessJsonAdapter({ provider: task.provider });
    const traceId = `spawn-${task.id}-${Date.now()}`;
    let received = 0;
    appendRuntimeEvent({
      traceId,
      type: 'SPAWN',
      taskId: task.id,
      detail: `command=${process.env.SUPERAGENT_CLI_COMMAND}`,
    });

    adapter.onEvent((event) => {
      received += 1;
      appendRuntimeEvent({
        traceId,
        type: 'AGENT_EVENT',
        taskId: task.id,
        detail: JSON.stringify(event).slice(0, 500),
      });
      const normalized: AgentReasoningEvent = {
        id: `ev-real-${Date.now()}-${received}`,
        ts: new Date().toTimeString().slice(0, 8),
        seq: ++globalSeq,
        kind: 'thought',
        title: `[real-cli] ${event.type}`,
        detail: JSON.stringify(event).slice(0, 400),
        status:
          event.type === 'completed'
            ? event.exitCode === 0
              ? 'ok'
              : 'failed'
            : 'running',
      };
      task.events.push(normalized);
      task.terminalLines.push(`[real-cli] ${normalized.detail}`);
      broadcastEnvelope({
        machineId: task.assignedMachine || 'mac-studio-sh-01',
        seq: globalSeq,
        ts: Date.now(),
        payload: { type: 'AGENT_EVENT', taskId: task.id, event: normalized },
      });
    });

    const prompt =
      (req.body as { prompt?: string })?.prompt?.trim() ||
      `只读说明当前任务：${task.title}`;

    void adapter
      .spawn({
        taskId: task.id,
        // 垂直切片不建 worktree，统一在仓库根执行受控命令。
        worktreePath: process.cwd(),
        prompt,
        systemRulesPath: '.teamai/AGENTS.md',
        env: {},
      })
      .then(({ sessionId, pid }) => {
        saveState(state);
        res.status(201).json({ sessionId, pid, traceId, received });
      })
      .catch((err: unknown) => {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'CLI 启动失败',
        });
      });
  });

  app.get('/api/runtime/events', (req, res) => {
    if (!isRealRuntimeEnabled()) {
      res.status(404).json({ error: '真实运行时未启用' });
      return;
    }
    const traceId =
      typeof req.query.traceId === 'string' ? req.query.traceId : undefined;
    res.json({
      events: replayRuntimeEvents(traceId),
      lastSeq: lastEventSeq(),
    });
  });

  app.post('/api/tasks/:id/simulate-failure', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
      seq: ++globalSeq,
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
      seq: globalSeq,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: task.id, state: task.state },
    });

    recomputeRequirementStatus(task.reqId);
    saveState(state);
    res.json({ task });
  });

  app.post('/api/tasks/:id/simulate-danger', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
      seq: ++globalSeq,
      kind: 'acp_intercept',
      title: `ACP 双向拦截：${danger.rule || 'DANGER_COMMAND'}`,
      detail: `已挂起工具调用 "${cmd}"，等待 Danger Gate 审批`,
      status: 'blocked',
    });
    task.terminalLines.push(`[acp-guard] INTERCEPTED: ${cmd} -> DANGER_GATE`);

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: globalSeq,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: task.id, state: 'HUMAN_GATE' },
    });

    recomputeRequirementStatus(task.reqId);
    saveState(state);
    res.json({ task });
  });

  app.post('/api/tasks/:id/gate', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
      seq: ++globalSeq,
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
          state.memories,
        );
        state.memories.unshift(extractedSkill);
      }
    }

    // Special case: if a PLAN_GATE node was approved, treat planning node as MERGED so downstream builders unlock immediately!
    if (approved && !abort && checkpoint.gateType === 'PLAN_GATE') {
      task.state = 'MERGED';
    }

    if (task.state === 'MERGED') {
      unlockReadyNodesForRequirement(task.reqId);
    }

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: ++globalSeq,
      ts: Date.now(),
      payload: { type: 'STATE_ACK', taskId: task.id, state: task.state },
    });

    recomputeRequirementStatus(task.reqId);
    saveState(state);

    res.json({
      task,
      extractedSkill,
      tasks: state.tasks,
      requirements: state.requirements,
      memories: state.memories,
    });
  });

  app.post('/api/tasks/:id/ndjson', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
            seq: ++globalSeq,
            ts: Date.now(),
            payload: { type: 'STATE_ACK', taskId: task.id, state: 'ESCALATED' },
          });
        }
      }
    } catch {
      // Non-JSON line handled below by parseCliNdjsonLine
    }

    const parsed = parseCliNdjsonLine(task.provider, line, ++globalSeq);
    if (parsed.event) {
      task.events.push(parsed.event);
      broadcastEnvelope({
        machineId: task.assignedMachine || 'mac-studio-sh-01',
        seq: globalSeq,
        ts: Date.now(),
        payload: { type: 'AGENT_EVENT', taskId: task.id, event: parsed.event },
      });
    }
    if (parsed.terminalChunk) {
      task.terminalLines.push(parsed.terminalChunk);
      broadcastEnvelope({
        machineId: task.assignedMachine || 'mac-studio-sh-01',
        seq: ++globalSeq,
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

    saveState(state);
    res.json({ task, parsed, budgetTriggered });
  });

  app.post('/api/tasks/:id/input', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
      seq: ++globalSeq,
      kind: 'shell_exec' as const,
      title: `向 ${task.provider} (${task.adapterMode}) 注入交互输入`,
      detail: redacted,
      status: 'ok' as const,
      redactedHits: hitCount,
    };
    task.events.push(ev);

    broadcastEnvelope({
      machineId: task.assignedMachine || 'mac-studio-sh-01',
      seq: globalSeq,
      ts: Date.now(),
      payload: { type: 'TERMINAL_CHUNK', taskId: task.id, chunk: line },
    });

    saveState(state);
    res.json({ task });
  });

  app.post('/api/requirements/:id/solidify-sop', (req, res) => {
    const reqItem = state.requirements.find((r) => r.id === req.params.id);
    if (!reqItem) {
      res.status(404).json({ error: '目标需求不存在' });
      return;
    }

    const reqNodes = state.tasks.filter((t) => t.reqId === reqItem.id);
    const allFinished =
      reqNodes.length > 0 &&
      reqNodes.every((t) => t.state === 'MERGED' || t.state === 'CANCELLED');
    if (!allFinished) {
      res.status(400).json({ error: '仅已全部合入完成的研发流水线可固化为团队 SOP' });
      return;
    }

    const nowIso = new Date().toISOString();
    const sopSlug = `sop-${reqItem.id}`;
    const gitPath = `.teamai/skills/${sopSlug}.md`;
    const stepLines = reqNodes
      .map(
        (n, idx) =>
          `${idx + 1}. **${n.title}** (\`${n.role}\` / \`${n.provider}\` / \`${n.adapterMode}\`) — 验证项：${
            n.verifierChecks.map((c) => c.name).join(', ') || 'gate-approved'
          }`,
      )
      .join('\n');

    const contentMd = `---
name: "${sopSlug}"
triggers: ["${reqItem.sopTemplate || 'feature_flow'}", "${reqItem.baseBranch}", "solidified-sop"]
scope: "team"
version: 1
---

# 固化 SOP：${reqItem.title}

## 来源流水线
- 需求编号：\`${reqItem.id.toUpperCase()}\`
- 模板类型：\`${reqItem.sopTemplate || 'feature_flow'}\`
- 目标仓库：\`${reqItem.repoUrl}\`

## 标准化 DAG 执行步骤
${stepLines}

## 复用规范
- 所有写入操作必须在隔离 \`git worktree\` 中完成并通过确定性门禁（lint / typecheck / unit_test / cross_review）。
`;

    const existingMem = state.memories.find((m) => m.id === `mem-${sopSlug}`);
    let asset: MemoryAsset;
    if (existingMem) {
      existingMem.contentMd = contentMd;
      existingMem.version += 1;
      existingMem.status = 'published';
      asset = existingMem;
    } else {
      asset = {
        id: `mem-${sopSlug}`,
        teamId: reqItem.teamId,
        ownerId: reqItem.createdBy,
        assetType: 'SKILL',
        scope: 'team',
        status: 'published',
        title: `SOP 模板：${reqItem.title}`,
        contentMd,
        sourceReason: `由已完成流水线 ${reqItem.id.toUpperCase()} 一键固化并同步至 ${gitPath}`,
        duplicateScore: 0.04,
        version: 1,
        createdAt: nowIso,
        acl: [
          {
            assetId: `mem-${sopSlug}`,
            subjectType: 'team',
            subjectId: reqItem.teamId,
            permission: 'read',
          },
        ],
      };
      state.memories.unshift(asset);
    }

    const existingTeamAi = state.teamAiAssets.find((a) => a.path === gitPath);
    let teamAiAsset: TeamAiAsset;
    if (existingTeamAi) {
      existingTeamAi.content = contentMd;
      existingTeamAi.updatedAt = nowIso;
      existingTeamAi.syncedToGit = true;
      teamAiAsset = existingTeamAi;
    } else {
      teamAiAsset = {
        path: gitPath,
        category: 'skill',
        title: `SOP: ${reqItem.title}`,
        content: contentMd,
        updatedAt: nowIso,
        syncedToGit: true,
      };
      state.teamAiAssets.push(teamAiAsset);
    }

    syncTeamAiFileToDisk(gitPath, contentMd);
    saveState(state);
    res.json({
      asset,
      teamAiAsset,
      memories: state.memories,
      teamAiAssets: state.teamAiAssets,
    });
  });

  app.post('/api/tasks/:id/comments', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
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
    saveState(state);
    res.status(201).json({ lineComment: entry, task });
  });

  app.get('/api/webhooks/im/card/:taskId', (req, res) => {
    if (!IM_WEBHOOK_SECRET) {
      res.status(503).json({ error: 'IM_WEBHOOK_SECRET is not configured' });
      return;
    }
    const task = state.tasks.find((t) => t.id === req.params.taskId);
    const requirement = task
      ? state.requirements.find((r) => r.id === task.reqId)
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
    const signature = signImWebhookPayload(rawBody, IM_WEBHOOK_SECRET);

    res.json({
      card: buildImApprovalCard(requirement, task),
      signedCallback: { rawBody, signature },
    });
  });

  app.post('/api/webhooks/im', (req, res) => {
    if (!IM_WEBHOOK_SECRET) {
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

    const verified = verifyImWebhookPayload(bodyStr, sigStr, IM_WEBHOOK_SECRET);
    if (!verified.valid || !verified.payload) {
      res.status(401).json({ error: verified.error || 'IM Webhook 验签失败' });
      return;
    }

    const cb = verified.payload;
    const task = state.tasks.find((t) => t.id === cb.taskId);
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
      unlockReadyNodesForRequirement(task.reqId);
    }

    let extractedSkill = null;
    if (shouldExtractSkill) {
      extractedSkill = extractSkillDraft(task, 'team-platform-core', cb.reviewerId);
      if (extractedSkill) {
        extractedSkill.duplicateScore = computeMaxDuplicateScore(
          extractedSkill.contentMd,
          state.memories,
        );
        state.memories.unshift(extractedSkill);
      }
    }

    task.terminalLines.push(
      `[im-gateway:${cb.channel}] verified HMAC + 300s replay guard -> ${task.state}`,
    );

    recomputeRequirementStatus(task.reqId);
    saveState(state);

    res.json({
      verified: true,
      channel: cb.channel,
      task,
      extractedSkill,
    });
  });

  app.post('/api/mcp/recall', (req, res) => {
    const { query, caller, limit } = req.body as {
      query?: string;
      caller?: {
        teamId?: string;
        projectId?: string;
        userId?: string;
        agentId?: string;
      };
      limit?: number;
    };

    const q = (query || '').trim();
    if (!q) {
      res.status(400).json({ error: 'MCP 召回查询词不能为空' });
      return;
    }

    const ctx = {
      teamId: caller?.teamId || 'team-platform-core',
      projectId: caller?.projectId,
      userId: caller?.userId,
      agentId: caller?.agentId,
    };

    const results = recallMemoryAssets(state.memories, q, ctx, limit ?? 6);
    const excludedDraftsCount = state.memories.filter((m) => m.status === 'draft').length;

    res.json({
      tool: 'superagent_memory_recall',
      caller: ctx,
      results,
      excludedDraftsCount,
    });
  });

  app.post('/api/memories/:id/approve', (req, res) => {
    const asset = state.memories.find((m) => m.id === req.params.id);
    if (!asset) {
      res.status(404).json({ error: '记忆资产不存在' });
      return;
    }
    asset.status = 'published';
    asset.version += 1;

    const slug = asset.id.replace(/[^a-z0-9-]/gi, '-');
    const gitPath = `.teamai/skills/${slug}.md`;
    const existing = state.teamAiAssets.find((a) => a.path === gitPath);
    if (existing) {
      existing.content = asset.contentMd;
      existing.updatedAt = new Date().toISOString();
      existing.syncedToGit = true;
    } else {
      state.teamAiAssets.push({
        path: gitPath,
        category: 'skill',
        title: asset.title,
        content: asset.contentMd,
        updatedAt: new Date().toISOString(),
        syncedToGit: true,
      });
    }

    syncTeamAiFileToDisk(gitPath, asset.contentMd);
    saveState(state);
    res.json({ asset, teamAiAssets: state.teamAiAssets });
  });

  app.post('/api/memories/:id/reject', (req, res) => {
    const asset = state.memories.find((m) => m.id === req.params.id);
    if (!asset) {
      res.status(404).json({ error: '记忆资产不存在' });
      return;
    }
    asset.status = 'archived';
    saveState(state);
    res.json({ asset });
  });

  app.put('/api/teamai', (req, res) => {
    const { assetPath, content } = req.body as { assetPath?: string; content?: string };
    const found = state.teamAiAssets.find((a) => a.path === assetPath);
    if (!found || typeof content !== 'string') {
      res.status(400).json({ error: '未找到对应的 .teamai 规范文件' });
      return;
    }
    found.content = content;
    found.updatedAt = new Date().toISOString();
    found.syncedToGit = true;
    syncTeamAiFileToDisk(found.path, found.content);
    saveState(state);
    res.json({ asset: found });
  });

  app.post('/api/daemons/:machineId/replay', (req, res) => {
    const daemon = state.daemons.find((d) => d.machineId === req.params.machineId);
    if (!daemon) {
      res.status(404).json({ error: 'Daemon 节点不存在' });
      return;
    }
    const replayed = daemon.pendingOfflineEvents > 0 ? daemon.pendingOfflineEvents : 3;
    daemon.status = 'online';
    daemon.lastAckSeq += replayed;
    daemon.pendingOfflineEvents = 0;
    daemon.lastHeartbeatAt = new Date().toISOString();

    broadcastEnvelope({
      machineId: daemon.machineId,
      seq: daemon.lastAckSeq,
      ts: Date.now(),
      payload: {
        type: 'HEARTBEAT',
        activeTaskIds: daemon.activeTaskIds,
        cpuLoad: daemon.cpuLoad,
      },
    });

    saveState(state);
    res.json({ daemon, replayed });
  });

  app.post('/api/reset', (_req, res) => {
    state = createInitialSeedState();
    for (const asset of state.teamAiAssets) {
      syncTeamAiFileToDisk(asset.path, asset.content);
    }
    saveState(state);
    res.json(state);
  });

  // Periodic realistic heartbeat broadcast
  const timer = setInterval(() => {
    if (sseClients.size === 0) return;
    const activeIds = state.tasks
      .filter((t) => t.state === 'RUNNING' || t.state === 'VERIFYING')
      .map((t) => t.id);
    broadcastEnvelope({
      machineId: 'mac-studio-sh-01',
      seq: ++globalSeq,
      ts: Date.now(),
      payload: {
        type: 'HEARTBEAT',
        activeTaskIds: activeIds,
        cpuLoad: Number((35 + Math.random() * 12).toFixed(1)),
      },
    });
  }, 8000);
  timer.unref?.();

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SuperAgent control plane listening on http://localhost:${PORT}`);
  });
}

startServer();
