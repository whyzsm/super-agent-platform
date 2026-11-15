import { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertTriangle,
  BookmarkCheck,
  CheckCircle2,
  Clock,
  FileText,
  GitBranch,
  Play,
  RotateCcw,
  ShieldAlert,
  Terminal,
  XCircle,
} from 'lucide-react';
import type { DagNode, Requirement, TaskState } from '../protocol';
import {
  PROVIDER_LABELS,
  ROLE_LABELS,
  SOP_TEMPLATE_LABELS,
  TASK_STATE_META,
} from '../utils/statusStyles';

interface TaskNodeData extends Record<string, unknown> {
  task: DagNode;
  selected: boolean;
}

function StateIcon({ state }: { state: TaskState }) {
  switch (state) {
    case 'MERGED':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />;
    case 'HUMAN_GATE':
      return <ShieldAlert className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />;
    case 'ESCALATED':
      return <AlertTriangle className="w-3.5 h-3.5 text-red-700" aria-hidden="true" />;
    case 'RETRY_WAIT':
      return <RotateCcw className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />;
    case 'CANCELLED':
      return <XCircle className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />;
    case 'RUNNING':
    case 'VERIFYING':
      return <Terminal className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />;
    case 'BLOCKED_BY_RESOURCE':
      return <Clock className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />;
    case 'QUARANTINED':
      return <ShieldAlert className="w-3.5 h-3.5 text-red-700" aria-hidden="true" />;
    case 'WAITING_APPROVAL':
      return <BookmarkCheck className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />;
    default:
      return <Clock className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />;
  }
}

function TaskDagNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const { task, selected } = data;
  const meta = TASK_STATE_META[task.state];

  return (
    <div
      className={`w-[244px] bg-white rounded-lg border transition-colors p-3 text-left ${
        selected
          ? 'border-blue-600 ring-2 ring-blue-600/15'
          : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-400 !border-white"
      />
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold rounded border ${meta.bgClass} ${meta.textClass} ${meta.borderClass}`}
        >
          <StateIcon state={task.state} />
          {meta.label}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-slate-500">
          重试 {task.retryCount}/{task.maxRetries}
        </span>
      </div>

      <p className="text-[13px] font-semibold text-slate-900 leading-snug line-clamp-2">
        {task.title}
      </p>

      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 truncate">
        <span className="font-medium text-slate-700">{ROLE_LABELS[task.role]}</span>
        <span aria-hidden="true">·</span>
        <span>{PROVIDER_LABELS[task.provider]}</span>
      </div>

      {task.worktreeBranch && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] font-mono text-slate-500 truncate">
          <GitBranch className="w-3 h-3 shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate">{task.worktreeBranch}</span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-slate-400 !border-white"
      />
    </div>
  );
}

const nodeTypes = {
  taskNode: TaskDagNode,
};

interface DagCanvasProps {
  requirement: Requirement | null;
  tasks: DagNode[];
  selectedTaskId: string | null;
  mutating: boolean;
  onSelectTask: (taskId: string) => void;
  onAdvanceTask: (taskId: string) => void;
  onSolidifySop: (reqId: string) => void;
  onResetDemo: () => void;
}

export function DagCanvas({
  requirement,
  tasks,
  selectedTaskId,
  mutating,
  onSelectTask,
  onAdvanceTask,
  onSolidifySop,
  onResetDemo,
}: DagCanvasProps) {
  const [showSpec, setShowSpec] = useState(false);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const nodes: Node<TaskNodeData>[] = useMemo(
    () =>
      tasks.map((task) => ({
        id: task.id,
        type: 'taskNode',
        position: task.position,
        data: {
          task,
          selected: task.id === selectedTaskId,
        },
      })),
    [tasks, selectedTaskId],
  );

  const edges: Edge[] = useMemo(() => {
    const list: Edge[] = [];
    for (const task of tasks) {
      for (const depId of task.dependsOn) {
        const dep = tasks.find((t) => t.id === depId);
        const isMerged = dep?.state === 'MERGED';
        list.push({
          id: `${depId}->${task.id}`,
          source: depId,
          target: task.id,
          animated: task.state === 'RUNNING' || task.state === 'VERIFYING',
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isMerged ? '#16a34a' : '#94a3b8',
          },
          style: {
            stroke: isMerged ? '#16a34a' : '#94a3b8',
            strokeWidth: 1.75,
          },
        });
      }
    }
    return list;
  }, [tasks]);

  if (!requirement) {
    return (
      <main className="flex-1 bg-slate-50 flex items-center justify-center p-8">
        <div className="text-center max-w-sm space-y-2">
          <h1 className="text-base font-semibold text-slate-900">请选择或新建研发需求</h1>
          <p className="text-xs text-slate-500">
            从左侧需求队列选择已有流水线，或点击右上角「+ 新建需求」自动拆解并行 Worktree DAG。
          </p>
        </div>
      </main>
    );
  }

  const canAdvanceSelected =
    selectedTask &&
    (selectedTask.state === 'PENDING' ||
      selectedTask.state === 'RUNNING' ||
      selectedTask.state === 'RETRY_WAIT' ||
      selectedTask.state === 'VERIFYING');

  return (
    <main className="flex-1 min-w-0 min-h-[400px] lg:min-h-0 shrink-0 lg:shrink bg-slate-50 flex flex-col">
      <div className="bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500 truncate">
            <span className="shrink-0">{requirement.id.toUpperCase()}</span>
            <span aria-hidden="true">/</span>
            <span className="truncate">{requirement.repoUrl}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">基线 {requirement.baseBranch}</span>
            <span aria-hidden="true">·</span>
            <span className="font-sans text-slate-600 shrink-0">
              {SOP_TEMPLATE_LABELS[requirement.sopTemplate ?? 'feature_flow']}
            </span>
          </div>
          <h1 className="text-sm font-semibold text-slate-900 truncate mt-0.5">
            {requirement.title}
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowSpec((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            {showSpec ? '收起规格' : '需求规格'}
          </button>

          {requirement.status === 'COMPLETED' && (
            <button
              type="button"
              disabled={mutating}
              onClick={() => onSolidifySop(requirement.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <BookmarkCheck className="w-3.5 h-3.5" aria-hidden="true" />
              固化为团队 SOP
            </button>
          )}

          {canAdvanceSelected && selectedTask && (
            <button
              type="button"
              disabled={mutating}
              onClick={() => onAdvanceTask(selectedTask.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              推进节点
            </button>
          )}

          <button
            type="button"
            disabled={mutating}
            onClick={onResetDemo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            重置基线
          </button>
        </div>
      </div>

      {showSpec && (
        <div className="bg-white border-b border-slate-200 px-5 py-3 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto">
          {requirement.specMd}
        </div>
      )}

      <div className="flex-1 min-h-[340px] relative" data-testid="dag-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_event, node) => onSelectTask(node.id)}
          fitView
          fitViewOptions={{ padding: 0.14 }}
          minZoom={0.55}
          maxZoom={1.35}
        >
          <Background color="#cbd5e1" gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            maskColor="rgba(241, 245, 249, 0.72)"
            bgColor="#ffffff"
            nodeStrokeWidth={2}
            nodeColor={(n) => {
              const st = (n.data as TaskNodeData | undefined)?.task?.state;
              if (st === 'MERGED') return '#16a34a';
              if (st === 'HUMAN_GATE') return '#d97706';
              if (st === 'ESCALATED') return '#dc2626';
              if (st === 'RUNNING' || st === 'VERIFYING') return '#2563eb';
              return '#64748b';
            }}
          />
        </ReactFlow>
      </div>
    </main>
  );
}
