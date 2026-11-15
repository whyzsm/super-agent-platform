import type { Express } from 'express';
import type {
  AgentProvider,
  DagNode,
  MemoryAsset,
  Requirement,
  SopTemplateId,
  TeamAiAsset,
} from '../protocol';
import type { ServerContext } from './context';

/**
 * 需求域路由：创建需求（内联 feature_flow / bugfix_flow DAG 模板）与固化 SOP。
 *
 * 注意：SOP/DAG 模板目前仍内联在此 handler 中（与拆分前一致）；
 * 抽成注册表是 S3-2 前半的独立事项，不与 S1-1 拆分混做。
 */
export function registerRequirementRoutes(app: Express, ctx: ServerContext): void {
  const { state, seq, saveState, syncTeamAiFileToDisk } = ctx;

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
                  seq: ++seq.current,
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
                  seq: ++seq.current,
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

    state.current.requirements.unshift(newReq);
    state.current.tasks.push(...newTasks);
    saveState(state.current);

    res.status(201).json({ requirement: newReq, tasks: newTasks });
  });

  app.post('/api/requirements/:id/solidify-sop', (req, res) => {
    const reqItem = state.current.requirements.find((r) => r.id === req.params.id);
    if (!reqItem) {
      res.status(404).json({ error: '目标需求不存在' });
      return;
    }

    const reqNodes = state.current.tasks.filter((t) => t.reqId === reqItem.id);
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

    const existingMem = state.current.memories.find((m) => m.id === `mem-${sopSlug}`);
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
      state.current.memories.unshift(asset);
    }

    const existingTeamAi = state.current.teamAiAssets.find((a) => a.path === gitPath);
    let teamAiAsset: TeamAiAsset;
    if (existingTeamAi) {
      existingTeamAi.content = contentMd;
      existingTeamAi.updatedAt = nowIso;
      existingTeamAi.syncedToGit = false;
      teamAiAsset = existingTeamAi;
    } else {
      teamAiAsset = {
        path: gitPath,
        category: 'skill',
        title: `SOP: ${reqItem.title}`,
        content: contentMd,
        updatedAt: nowIso,
        syncedToGit: false,
      };
      state.current.teamAiAssets.push(teamAiAsset);
    }

    syncTeamAiFileToDisk(gitPath, contentMd);
    saveState(state.current);
    res.json({
      asset,
      teamAiAsset,
      memories: state.current.memories,
      teamAiAssets: state.current.teamAiAssets,
    });
  });
}
