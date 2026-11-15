import type { AgentProvider, AdapterMode, DagNode, Requirement, TaskRole } from '../protocol';

/**
 * DAG 编译（S3-2 后半）：把一条**已全部合入**的真实流水线编译成可复用的子 SOP 模板。
 *
 * 产物 SerializedSopTemplate 只存拓扑骨架（title/role/provider/adapterMode/依赖序号/预算），
 * 不携带具体 reqId / 事件 / 终端输出；使用方（POST /api/requirements 传 sopTemplate=sop-xxx）
 * 经 deserializeTemplate 还原成 DagTemplate，按新 reqId 重新实例化节点链。
 *
 * 版本化：同 id 重复固化（再次跑完同源流水线再 solidify）会 bump version；
 * 产物持久化在 PlatformState.sopTemplates，随快照原子落盘。
 */

export interface SopTemplateStep {
  title: string;
  role: TaskRole;
  provider: AgentProvider;
  adapterMode: AdapterMode;
  /** 步骤依赖：以步骤下标表达（编译时把 taskId 映射为序号，实例化时再映射回新 id） */
  dependsOn: number[];
  budgetTokens: number;
  /** 是否首节点（Plan Gate 形态：HUMAN_GATE + PLAN_GATE 检查点） */
  isPlan?: boolean;
}

export interface SerializedSopTemplate {
  id: string;
  title: string;
  description: string;
  version: number;
  /** 来源流水线（审计与追溯用） */
  sourceReqId: string;
  steps: SopTemplateStep[];
}

/** 把已完成的流水线节点编译为模板骨架。纯函数：不改入参、不碰状态。 */
export function compilePipelineToTemplate(
  nodes: DagNode[],
  sourceReq: Pick<Requirement, 'id' | 'title'>,
  existing?: SerializedSopTemplate,
): SerializedSopTemplate {
  if (nodes.length === 0) {
    throw new Error('compilePipelineToTemplate: 空流水线不可编译为模板');
  }
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const steps: SopTemplateStep[] = nodes.map((n, i) => ({
    title: n.title,
    role: n.role,
    provider: n.provider,
    adapterMode: n.adapterMode,
    dependsOn: n.dependsOn
      .map((dep) => indexOf.get(dep))
      .filter((v): v is number => v !== undefined),
    budgetTokens: n.usage?.budgetTokens ?? 40000,
    isPlan: i === 0,
  }));
  return {
    id: `sop-${sourceReq.id}`,
    title: `固化 SOP：${sourceReq.title}`,
    description: `由流水线 ${sourceReq.id} 编译的 ${steps.length} 步子 SOP 模板`,
    version: existing ? existing.version + 1 : 1,
    sourceReqId: sourceReq.id,
    steps,
  };
}

/** 编译/反编译共用：按新 reqId 实例化节点链。 */
function buildFromSteps(entry: SerializedSopTemplate): (ctx: {
  reqId: string;
  nowIso: string;
  timeStr: string;
  nextSeq: () => number;
}) => DagNode[] {
  return (ctx) => {
    const { reqId, nowIso, timeStr, nextSeq } = ctx;
    const ids = entry.steps.map((_, i) => (i === 0 ? `task-${reqId}-plan` : `task-${reqId}-s${i + 1}`));
    return entry.steps.map((step, i) => {
      const id = ids[i];
      const machine = i % 2 === 0 ? 'mac-studio-sh-01' : 'ubuntu-ci-runner-04';
      const base: DagNode = {
        id,
        reqId,
        title: step.title,
        role: step.role,
        provider: step.provider,
        adapterMode: step.adapterMode,
        dependsOn: step.dependsOn.map((d) => ids[d]),
        state: step.isPlan ? 'HUMAN_GATE' : 'PENDING',
        retryCount: 0,
        maxRetries: 3,
        assignedMachine: machine,
        worktreeBranch: `agent/${id}`,
        worktreePath: `~/.superagent/worktrees/app-service/${id}`,
        localPort: 4401 + i,
        position: { x: 40 + i * 310, y: 140 },
        events: [],
        terminalLines: step.isPlan
          ? [
              `[planner] applying solidified SOP ${entry.id}@v${entry.version} (${entry.steps.length} steps)`,
              '[gate] awaiting PLAN_GATE approval...',
            ]
          : [`[scheduler] waiting for upstream of step ${i + 1}`],
        verifierChecks: [],
        lineComments: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationSec: 0,
          budgetTokens: step.budgetTokens,
        },
        diffPatch: `// 由固化 SOP ${entry.id}@v${entry.version} 实例化`,
        templateId: entry.id,
        templateVersion: entry.version,
      };
      if (step.isPlan) {
        base.events.push({
          id: `ev-${Date.now()}-1`,
          ts: timeStr,
          seq: nextSeq(),
          kind: 'thought',
          title: `按固化 SOP ${entry.id} 复用 ${entry.steps.length} 步拓扑`,
          detail: `来源流水线 ${entry.sourceReqId}；等待 Plan Gate 放行后按序拉起。`,
          status: 'ok',
        });
        base.activeCheckpoint = {
          id: `ckpt-${id}`,
          taskId: id,
          gateType: 'PLAN_GATE',
          summaryMd: `按固化 SOP「${entry.title}」(v${entry.version}) 重建 ${entry.steps.length} 节点拓扑，请确认是否放行。`,
          status: 'WAITING',
          createdAt: nowIso,
        };
      }
      return base;
    });
  };
}

export interface DeserializedTemplate {
  id: string;
  title: string;
  description: string;
  version: number;
  build: ReturnType<typeof buildFromSteps>;
}

/** 反编译：序列化模板 -> 可执行模板（build 接收 reqId/时间/seq 分配器）。 */
export function deserializeTemplate(entry: SerializedSopTemplate): DeserializedTemplate {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    version: entry.version,
    build: buildFromSteps(entry),
  };
}
