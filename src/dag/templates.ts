import type { AgentProvider, DagNode, Requirement, SopTemplateId, SopTemplateRef } from '../protocol';

/**
 * SOP/DAG 模板注册表（S3-2 前半）。
 *
 * 收敛前 `feature_flow` / `bugfix_flow` 两套拓扑硬编码在路由 handler 里
 * （原 server.ts，S1-1 后在 src/server/requirements.ts），新增模板 = 复制粘贴
 * 250 行字面量。现在模板是显式注册项：
 *
 * - 每个模板 = 元数据（id/标题/说明）+ 纯函数 build(ctx) => DagNode[]；
 * - 节点字面量**逐字保留**自原路由（行为零变更），仅把闭包变量换成本入参；
 * - 模板内事件 seq 由调用方经 nextSeq 分配（保持严格递增）；
 * - normalizeSopTemplateId 保留历史兜底：非 'bugfix_flow' 一律按 'feature_flow'。
 *
 * 后半（未做，诚实标注）：模板版本化与子 SOP 组合复用。
 */

export interface DagTemplateContext {
  reqId: string;
  /** 已构造完成的需求实体（模板读取 title / baseBranch 渲染文案） */
  requirement: Pick<Requirement, 'title' | 'baseBranch'>;
  provider: AgentProvider;
  nowIso: string;
  timeStr: string;
  /** 分配事件 seq；每次调用必须返回新的递增值 */
  nextSeq: () => number;
}

export interface DagTemplate {
  id: SopTemplateId;
  /** 模板版本：拓扑有实质变更时递增；实例化节点会携带 templateId@templateVersion 戳 */
  version: number;
  title: string;
  description: string;
  build: (ctx: DagTemplateContext) => DagNode[];
}

/** 给实例化节点打模板戳（S3-2 版本化）。 */
function stampTemplate(nodes: DagNode[], id: string, version: number): DagNode[] {
  return nodes.map((n) => ({ ...n, templateId: id, templateVersion: version }));
}

/** 历史兜底语义：只有显式 'bugfix_flow' 才走缺陷流，其余一律 feature_flow。 */
export function normalizeSopTemplateId(input: unknown): SopTemplateId {
  return input === 'bugfix_flow' ? 'bugfix_flow' : 'feature_flow';
}

function buildBugfixFlow(ctx: DagTemplateContext): DagNode[] {
  const { reqId, requirement: newReq, provider, nowIso, timeStr, nextSeq } = ctx;
  const planId = `task-${reqId}-plan`;
  const revId = `task-${reqId}-rev`;
  return [
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
          seq: nextSeq(),
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
  ];
}

function buildFeatureFlow(ctx: DagTemplateContext): DagNode[] {
  const { reqId, requirement: newReq, provider, nowIso, timeStr, nextSeq } = ctx;
  const planId = `task-${reqId}-plan`;
  const revId = `task-${reqId}-rev`;
  return [
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
          seq: nextSeq(),
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
}

/** SOP/DAG 模板注册表：新增模板在此登记（并补 templates.test.ts 用例）。 */
export const DAG_TEMPLATES: Record<SopTemplateId, DagTemplate> = {
  bugfix_flow: {
    id: 'bugfix_flow',
    version: 1,
    title: 'Bug 修复流',
    description: '复现定位 -> 隔离 Worktree 修复 + 回归单测 -> 异构交叉 Review（3 节点链）',
    build: (ctx) => stampTemplate(buildBugfixFlow(ctx), 'bugfix_flow', 1),
  },
  feature_flow: {
    id: 'feature_flow',
    version: 1,
    title: '标准 Feature 开发流',
    description: '拆解规划 -> 双 Builder 并行 -> 异构交叉安全审查（4 节点 DAG）',
    build: (ctx) => stampTemplate(buildFeatureFlow(ctx), 'feature_flow', 1),
  },
};

/**
 * 解析模板引用（S3-2 后半）：内置 id 直取；`sop-*` 且在已固化清单中命中则用固化模板；
 * 其余（含缺省/垃圾值）回落 feature_flow —— 保持历史兜底语义。
 */
export function resolveTemplateRef(
  input: unknown,
  custom: ReadonlyArray<{ id: string }>,
): SopTemplateRef {
  if (typeof input === 'string' && input !== '') {
    if (input === 'feature_flow' || input === 'bugfix_flow') return input;
    if (input.startsWith('sop-') && custom.some((e) => e.id === input)) {
      return input as SopTemplateRef;
    }
  }
  return 'feature_flow';
}

/**
 * 经注册表构建内置模板 DAG；非内置引用（sop-* 传错、垃圾值）一律兜底 feature_flow。
 * 固化子 SOP 模板不走这里 —— 用 dag/compile.ts 的 deserializeTemplate(...).build。
 */
export function buildTasksForTemplate(templateId: SopTemplateRef, ctx: DagTemplateContext): DagNode[] {
  const builtinId: SopTemplateId = templateId === 'bugfix_flow' ? 'bugfix_flow' : 'feature_flow';
  return DAG_TEMPLATES[builtinId].build(ctx);
}
