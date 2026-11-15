export type AgentProvider = 'codex' | 'workbuddy' | 'claude-code' | 'opencode';

export type AdapterMode = 'headless_json' | 'acp_bidirectional' | 'pty_tmux';

export type TaskState =
  | 'PENDING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'RETRY_WAIT'
  | 'HUMAN_GATE'
  | 'ESCALATED'
  | 'MERGED'
  | 'CANCELLED';

export type GateType = 'PLAN_GATE' | 'DANGER_GATE' | 'MERGE_GATE';

export type TaskRole = 'planner' | 'builder' | 'reviewer';

export type SopTemplateId = 'feature_flow' | 'bugfix_flow';

export interface NodeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationSec: number;
  budgetTokens: number;
}

export type NormalizedAgentEvent =
  | { type: 'thought'; content: string; ts: number }
  | { type: 'tool_call'; id: string; tool: string; args: unknown; requiresApproval: boolean }
  | { type: 'file_diff'; path: string; patch: string }
  | { type: 'terminal_chunk'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'completed'; exitCode: number; summary: string };

export interface AgentRunnerAdapter {
  provider: AgentProvider | 'custom-acp';
  mode: 'headless-json' | 'acp' | 'pty';
  spawn(params: {
    taskId: string;
    worktreePath: string;
    prompt: string;
    systemRulesPath: string;
    env: Record<string, string>;
  }): Promise<{ sessionId: string; pid: number }>;
  onEvent(cb: (event: NormalizedAgentEvent) => void): void;
  sendInput(sessionId: string, text: string): Promise<void>;
  approveTool(sessionId: string, toolCallId: string, approved: boolean): Promise<void>;
  terminate(sessionId: string): Promise<void>;
}

export interface AgentReasoningEvent {
  id: string;
  ts: string;
  seq: number;
  kind: 'thought' | 'tool_call' | 'file_edit' | 'shell_exec' | 'acp_intercept' | 'verifier_check';
  title: string;
  detail: string;
  status: 'ok' | 'blocked' | 'failed' | 'running';
  redactedHits?: number;
}

export interface VerifierCheck {
  name: 'lint' | 'typecheck' | 'unit_test' | 'cross_review';
  passed: boolean;
  durationMs: number;
  summary: string;
}

export interface LineReviewComment {
  id: string;
  file: string;
  line: number;
  author: string;
  comment: string;
  createdAt: string;
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  gateType: GateType;
  summaryMd: string;
  status: 'WAITING' | 'APPROVED' | 'REJECTED' | 'ABORTED';
  reviewerId?: string;
  comment?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface DagNode {
  id: string;
  reqId: string;
  title: string;
  role: TaskRole;
  provider: AgentProvider;
  adapterMode: AdapterMode;
  dependsOn: string[];
  state: TaskState;
  retryCount: number;
  maxRetries: number;
  assignedMachine?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  localPort?: number;
  diffPatch?: string;
  hadFailureOrCorrection?: boolean;
  lastErrorFeedback?: string;
  position: { x: number; y: number };
  events: AgentReasoningEvent[];
  terminalLines: string[];
  verifierChecks: VerifierCheck[];
  lineComments: LineReviewComment[];
  activeCheckpoint?: TaskCheckpoint;
  usage?: NodeTokenUsage;
}

export interface Requirement {
  id: string;
  teamId: string;
  title: string;
  specMd: string;
  repoUrl: string;
  baseBranch: string;
  sourceChannel: 'web' | 'cli' | 'wecom' | 'feishu';
  sopTemplate?: SopTemplateId;
  status: 'PLANNING' | 'IN_PROGRESS' | 'AWAITING_GATE' | 'COMPLETED' | 'ESCALATED';
  createdBy: string;
  createdAt: string;
}

export interface DaemonRunner {
  machineId: string;
  hostname: string;
  os: string;
  status: 'online' | 'reconnecting' | 'offline';
  providers: AgentProvider[];
  activeTaskIds: string[];
  cpuLoad: number;
  memUsedGb: number;
  memTotalGb: number;
  lastHeartbeatAt: string;
  lastAckSeq: number;
  pendingOfflineEvents: number;
  worktrees: Array<{
    taskId: string;
    branch: string;
    path: string;
    port: number;
    provider: AgentProvider;
    adapterMode: AdapterMode;
  }>;
}

export type MemoryAssetType = 'L1_FACT' | 'L2_SOLUTION' | 'SKILL' | 'LLM_WIKI' | 'CODE_GRAPH';
export type MemoryScope = 'team' | 'project' | 'user' | 'agent';
export type MemoryStatus = 'draft' | 'published' | 'archived';

export interface AssetAclEntry {
  assetId: string;
  subjectType: 'team' | 'project' | 'user' | 'agent';
  subjectId: string;
  permission: 'read' | 'write' | 'admin';
}

export interface MemoryAsset {
  id: string;
  teamId: string;
  projectId?: string;
  ownerId: string;
  assetType: MemoryAssetType;
  scope: MemoryScope;
  status: MemoryStatus;
  title: string;
  contentMd: string;
  sourceTaskId?: string;
  sourceReason?: string;
  duplicateScore?: number;
  version: number;
  createdAt: string;
  acl: AssetAclEntry[];
}

export interface TeamAiAsset {
  path: string;
  category: 'agents_md' | 'rule' | 'skill' | 'hook';
  title: string;
  content: string;
  updatedAt: string;
  syncedToGit: boolean;
}

export type DaemonCommand =
  | {
      type: 'SPAWN_TASK';
      taskId: string;
      repoUrl: string;
      baseBranch: string;
      provider: AgentProvider;
      prompt: string;
      skills: string[];
    }
  | { type: 'INJECT_RETRY'; taskId: string; feedback: string }
  | {
      type: 'GATE_DECISION';
      taskId: string;
      toolCallId?: string;
      approved: boolean;
      comment?: string;
    }
  | { type: 'ABORT_TASK'; taskId: string };

export interface DaemonEnvelope {
  machineId: string;
  seq: number;
  ts: number;
  payload:
    | { type: 'HEARTBEAT'; activeTaskIds: string[]; cpuLoad: number }
    | { type: 'AGENT_EVENT'; taskId: string; event: AgentReasoningEvent }
    | { type: 'TERMINAL_CHUNK'; taskId: string; chunk: string }
    | { type: 'VERIFY_RESULT'; taskId: string; passed: boolean; logs: string; diffPatch: string }
    | { type: 'STATE_ACK'; taskId: string; state: TaskState };
}
