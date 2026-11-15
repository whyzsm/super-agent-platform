import { create } from 'zustand';
import type {
  AgentProvider,
  DaemonRunner,
  DagNode,
  MemoryAsset,
  Requirement,
  SopTemplateId,
  TeamAiAsset,
} from '../protocol';
import { needsAttention } from '../utils/statusStyles';

export type ActiveTab = 'workbench' | 'memory' | 'teamai' | 'daemons';

interface WorkspaceStore {
  activeTab: ActiveTab;
  requirements: Requirement[];
  tasks: DagNode[];
  daemons: DaemonRunner[];
  memories: MemoryAsset[];
  teamAiAssets: TeamAiAsset[];
  selectedReqId: string | null;
  selectedTaskId: string | null;
  loading: boolean;
  mutating: boolean;
  error: string | null;
  notice: string | null;

  setActiveTab: (tab: ActiveTab) => void;
  selectRequirement: (reqId: string) => void;
  selectTask: (taskId: string) => void;
  clearNotice: () => void;

  fetchBootstrap: () => Promise<void>;
  createRequirement: (input: {
    title: string;
    specMd: string;
    repoUrl: string;
    baseBranch: string;
    sourceChannel: 'web' | 'cli' | 'wecom' | 'feishu';
    primaryProvider: AgentProvider;
    sopTemplate: SopTemplateId;
  }) => Promise<boolean>;
  advanceTask: (taskId: string) => Promise<void>;
  provisionWorktree: (taskId: string) => Promise<void>;
  releaseWorktree: (taskId: string) => Promise<void>;
  simulateFailure: (taskId: string, errorLog?: string) => Promise<void>;
  simulateDanger: (taskId: string, command?: string) => Promise<void>;
  submitGateDecision: (
    taskId: string,
    payload: { approved: boolean; abort?: boolean; comment?: string },
  ) => Promise<void>;
  addLineComment: (
    taskId: string,
    payload: { file: string; line: number; comment: string },
  ) => Promise<void>;
  approveMemory: (id: string) => Promise<void>;
  rejectMemory: (id: string) => Promise<void>;
  saveTeamAiAsset: (assetPath: string, content: string) => Promise<void>;
  replayDaemonQueue: (machineId: string) => Promise<void>;
  sendNdjsonLine: (taskId: string, line: string) => Promise<void>;
  sendTaskInput: (taskId: string, text: string) => Promise<void>;
  solidifyRequirementSop: (reqId: string) => Promise<void>;
  triggerImSignedCallback: (taskId: string, approved: boolean) => Promise<void>;
  resetDemoState: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  activeTab: 'workbench',
  requirements: [],
  tasks: [],
  daemons: [],
  memories: [],
  teamAiAssets: [],
  selectedReqId: null,
  selectedTaskId: null,
  loading: true,
  mutating: false,
  error: null,
  notice: null,

  setActiveTab: (activeTab) => set({ activeTab }),
  clearNotice: () => set({ notice: null, error: null }),

  selectRequirement: (reqId) => {
    const tasks = get().tasks.filter((t) => t.reqId === reqId);
    const gateTask = tasks.find((t) => needsAttention(t.state));
    const firstTask = gateTask ?? tasks[0] ?? null;
    set({
      selectedReqId: reqId,
      selectedTaskId: firstTask ? firstTask.id : null,
    });
  },

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  fetchBootstrap: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/bootstrap');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reqs: Requirement[] = data.requirements ?? [];
      const tasks: DagNode[] = data.tasks ?? [];
      const currentReqId = get().selectedReqId;
      const validReq = reqs.find((r) => r.id === currentReqId) ?? reqs[0] ?? null;
      const reqTasks = validReq ? tasks.filter((t) => t.reqId === validReq.id) : [];
      const currentTaskId = get().selectedTaskId;
      const validTask =
        reqTasks.find((t) => t.id === currentTaskId) ??
        reqTasks.find((t) => needsAttention(t.state)) ??
        reqTasks[0] ??
        null;

      set({
        requirements: reqs,
        tasks,
        daemons: data.daemons ?? [],
        memories: data.memories ?? [],
        teamAiAssets: data.teamAiAssets ?? [],
        selectedReqId: validReq ? validReq.id : null,
        selectedTaskId: validTask ? validTask.id : null,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '加载控制面数据失败',
      });
    }
  },

  createRequirement: async (input) => {
    set({ mutating: true, error: null });
    try {
      const res = await fetch('/api/requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const newReq: Requirement = data.requirement;
      const newTasks: DagNode[] = data.tasks;
      set((s) => ({
        requirements: [newReq, ...s.requirements],
        tasks: [...s.tasks, ...newTasks],
        selectedReqId: newReq.id,
        selectedTaskId: newTasks[0]?.id ?? null,
        activeTab: 'workbench',
        mutating: false,
        notice: `已按「${newReq.sopTemplate === 'bugfix_flow' ? 'Bug 修复流' : '标准 Feature 开发流'}」创建需求「${newReq.title}」，Planner 已生成 ${newTasks.length} 节点 DAG 并挂起于 Plan Gate。`,
      }));
      return true;
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '创建需求失败',
      });
      return false;
    }
  },

  advanceTask: async (taskId) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/advance`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: '已推进节点执行与确定性门禁校验。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '推进节点失败',
      });
    }
  },

  provisionWorktree: async (taskId) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/worktree`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        worktree?: { path?: string; branch?: string };
        error?: string;
      };
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({
        mutating: false,
        notice: `隔离工作树就绪：${data.worktree?.path ?? taskId}`,
      });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '创建工作树失败',
      });
    }
  },

  releaseWorktree: async (taskId) => {
    // 目录是真实存在的，删除前必须二次确认，避免误点丢掉未提交的 agent 产出。
    if (!window.confirm(`确认删除 ${taskId} 的真实工作树目录？该操作会移除磁盘文件（分支默认保留）。`)) {
      return;
    }
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/worktree`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: '工作树已删除（分支保留作审计证据）。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '删除工作树失败',
      });
    }
  },

  simulateFailure: async (taskId, errorLog) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/simulate-failure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errorLog }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: '已注入确定性校验失败堆栈并触发重试/熔断状态流转。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '模拟失败失败',
      });
    }
  },

  simulateDanger: async (taskId, command) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/simulate-danger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: 'ACP 双向拦截器已捕获高危指令并推送 Danger Gate 审批卡片。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '触发高危拦截失败',
      });
    }
  },

  submitGateDecision: async (taskId, payload) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await get().fetchBootstrap();
      const notice = data.extractedSkill
        ? `门禁已放行并合入。检测到修复恢复轨迹，已自动提炼 Skill Draft「${data.extractedSkill.title}」。`
        : payload.abort
          ? '已终止该任务节点并释放 Worktree 沙箱。'
          : payload.approved
            ? '门禁已批准放行，已自动检测并唤醒下游就绪节点。'
            : '已附带审查意见打回至 RETRY_WAIT 队列。';
      set({ mutating: false, notice });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '门禁审批提交失败',
      });
    }
  },

  addLineComment: async (taskId, payload) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: `已在第 ${payload.line} 行添加代码批注。` });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '添加批注失败',
      });
    }
  },

  sendNdjsonLine: async (taskId, line) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/ndjson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      await get().fetchBootstrap();
      set({
        mutating: false,
        notice: data.budgetTriggered
          ? 'Token 用量触发 budget_limit 熔断，任务已自动挂起至 ESCALATED。'
          : data.parsed?.dangerIntercept
            ? `NDJSON ACP 拦截器命中 ${data.parsed.dangerIntercept.rule}，已挂起至 Danger Gate。`
            : '已解析 Headless CLI NDJSON 事件并完成密钥脱敏入流。',
      });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : 'NDJSON 注入失败',
      });
    }
  },

  sendTaskInput: async (taskId, text) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/tasks/${taskId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await get().fetchBootstrap();
      set({
        mutating: false,
        notice: '已通过 AgentRunnerAdapter.sendInput 向会话注入交互指令。',
      });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '终端交互注入失败',
      });
    }
  },

  solidifyRequirementSop: async (reqId) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/requirements/${reqId}/solidify-sop`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      await get().fetchBootstrap();
      set({
        mutating: false,
        notice: `已固化为团队 SOP 并同步写入 ${data.teamAiAsset?.path || '.teamai/skills/'}。`,
      });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '固化 SOP 失败',
      });
    }
  },

  triggerImSignedCallback: async (taskId, approved) => {
    set({ mutating: true });
    try {
      const cardRes = await fetch(`/api/webhooks/im/card/${taskId}?approved=${approved}`);
      if (!cardRes.ok) throw new Error(`HTTP ${cardRes.status}`);
      const { signedCallback } = await cardRes.json();

      const cbRes = await fetch('/api/webhooks/im', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedCallback),
      });
      if (!cbRes.ok) {
        const errBody = await cbRes.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${cbRes.status}`);
      }
      const result = await cbRes.json();
      await get().fetchBootstrap();
      set({
        mutating: false,
        notice: `IM 网关 (${result.channel}) HMAC-SHA256 验签通过 -> 节点状态 ${result.task.state}。`,
      });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : 'IM Webhook 回调失败',
      });
    }
  },

  approveMemory: async (id) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/memories/${id}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: 'Skill Draft 已审核发布并同步写入 .teamai/skills/ 目录。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '审核发布失败',
      });
    }
  },

  rejectMemory: async (id) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/memories/${id}/reject`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: '已归档该 Skill 草案，防止低质量记忆污染团队池。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '归档失败',
      });
    }
  },

  saveTeamAiAsset: async (assetPath, content) => {
    set({ mutating: true });
    try {
      const res = await fetch('/api/teamai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetPath, content }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: `已保存并同步 ${assetPath} 至团队 Git 规范基线。` });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '保存规范失败',
      });
    }
  },

  replayDaemonQueue: async (machineId) => {
    set({ mutating: true });
    try {
      const res = await fetch(`/api/daemons/${machineId}/replay`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await get().fetchBootstrap();
      set({
        mutating: false,
        notice: `Daemon ${machineId} 重连完成，已按 lastAckSeq 补发 ${data.replayed} 条离线缓存事件。`,
      });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '补发重连失败',
      });
    }
  },

  resetDemoState: async () => {
    set({ mutating: true });
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchBootstrap();
      set({ mutating: false, notice: '已重置控制面数据至初始研发基线。' });
    } catch (err) {
      set({
        mutating: false,
        error: err instanceof Error ? err.message : '重置失败',
      });
    }
  },
}));
