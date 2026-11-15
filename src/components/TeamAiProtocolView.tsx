import { useEffect, useState } from 'react';
import { Check, Copy, Database, FileCode2, GitCommitHorizontal, Save } from 'lucide-react';
import type { TeamAiAsset } from '../protocol';

interface TeamAiProtocolViewProps {
  assets: TeamAiAsset[];
  mutating: boolean;
  onSaveAsset: (assetPath: string, content: string) => void;
}

const PROTOCOL_SPEC = `export type AgentProvider = 'codex' | 'workbuddy' | 'claude-code' | 'opencode';

export type SopTemplateId = 'feature_flow' | 'bugfix_flow';

export type TaskState =
  | 'PENDING' | 'RUNNING' | 'VERIFYING' | 'RETRY_WAIT'
  | 'HUMAN_GATE' | 'ESCALATED' | 'MERGED' | 'CANCELLED';

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

export type DaemonCommand =
  | { type: 'SPAWN_TASK'; taskId: string; repoUrl: string; baseBranch: string; provider: AgentProvider; prompt: string; skills: string[] }
  | { type: 'INJECT_RETRY'; taskId: string; feedback: string }
  | { type: 'GATE_DECISION'; taskId: string; toolCallId?: string; approved: boolean; comment?: string }
  | { type: 'ABORT_TASK'; taskId: string };`;

const PGVECTOR_DDL = `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  title TEXT NOT NULL,
  spec_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNING',
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE task_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  req_id UUID REFERENCES requirements(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  depends_on UUID[] DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'PENDING',
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  assigned_machine TEXT,
  worktree_branch TEXT,
  diff_patch TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE task_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES task_nodes(id) ON DELETE CASCADE,
  gate_type TEXT NOT NULL,
  summary_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING',
  reviewer_id UUID,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE memory_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  project_id UUID,
  owner_id UUID NOT NULL,
  asset_type TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'team',
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding vector(1536),
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE asset_acl (
  asset_id UUID REFERENCES memory_assets(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  PRIMARY KEY (asset_id, subject_type, subject_id)
);

CREATE INDEX idx_memory_vec ON memory_assets USING hnsw (embedding vector_cosine_ops);`;

export function TeamAiProtocolView({
  assets,
  mutating,
  onSaveAsset,
}: TeamAiProtocolViewProps) {
  const [mode, setMode] = useState<'teamai' | 'protocol' | 'ddl'>('teamai');
  const [selectedPath, setSelectedPath] = useState<string>(assets[0]?.path ?? '');
  const [draftContent, setDraftContent] = useState<string>(assets[0]?.content ?? '');
  const [copied, setCopied] = useState(false);

  const selectedAsset = assets.find((a) => a.path === selectedPath) ?? assets[0] ?? null;

  useEffect(() => {
    if (selectedAsset) {
      setDraftContent(selectedAsset.content);
    }
  }, [selectedAsset?.path, selectedAsset?.content]);

  function handleCopy(text: string) {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row bg-slate-50">
      <aside className="w-full lg:w-[320px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col min-h-0">
        <div className="p-4 border-b border-slate-200 space-y-3">
          <h1 className="text-sm font-semibold text-slate-900">
            .teamai/ Git 规范与核心契约
          </h1>
          <div
            role="tablist"
            aria-label="规范与协议类别"
            className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-md"
          >
            {(
              [
                { id: 'teamai', label: '.teamai/' },
                { id: 'protocol', label: 'Protocol' },
                { id: 'ddl', label: 'PG DDL' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={mode === t.id}
                onClick={() => setMode(t.id)}
                className={`py-1 text-xs font-medium rounded transition-colors ${
                  mode === t.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {mode === 'teamai' ? (
            assets.map((asset) => {
              const active = selectedAsset?.path === asset.path;
              return (
                <button
                  key={asset.path}
                  type="button"
                  onClick={() => {
                    setSelectedPath(asset.path);
                    setDraftContent(asset.content);
                  }}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    active ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <p className="font-mono text-[11px] font-semibold text-slate-900 break-all">
                    {asset.path}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 truncate">{asset.title}</p>
                </button>
              );
            })
          ) : (
            <div className="p-4 text-xs text-slate-600 leading-relaxed space-y-2">
              <p className="font-semibold text-slate-900">
                {mode === 'protocol'
                  ? 'packages/protocol/src/index.ts'
                  : 'PostgreSQL 16 + pgvector 核心表结构'}
              </p>
              <p>
                {mode === 'protocol'
                  ? '前后端与 Local Runner Daemon 共享的强类型协议契约，涵盖 DagNode、DaemonCommand 与 DaemonEnvelope。'
                  : '包含 requirements、task_nodes、task_checkpoints、memory_assets 与四级 ACL 权限表及 HNSW 向量索引。'}
              </p>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto p-6">
        {mode === 'teamai' && selectedAsset ? (
          <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs font-semibold text-slate-900">
                  {selectedAsset.path}
                </p>
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                  <GitCommitHorizontal className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                  随仓库 Git 同步 · 最近更新 {selectedAsset.updatedAt.slice(0, 19).replace('T', ' ')}
                </p>
              </div>
              <button
                type="button"
                disabled={mutating || draftContent === selectedAsset.content}
                onClick={() => onSaveAsset(selectedAsset.path, draftContent)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40"
              >
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
                保存并同步规范
              </button>
            </div>
            <div className="p-4">
              <label htmlFor="teamai-editor" className="sr-only">
                编辑 {selectedAsset.path} 内容
              </label>
              <textarea
                id="teamai-editor"
                rows={18}
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                className="w-full p-4 bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed rounded-md border border-slate-800 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold font-mono text-slate-900 flex items-center gap-1.5">
                {mode === 'protocol' ? (
                  <FileCode2 className="w-4 h-4 text-blue-600" aria-hidden="true" />
                ) : (
                  <Database className="w-4 h-4 text-blue-600" aria-hidden="true" />
                )}
                {mode === 'protocol'
                  ? 'packages/protocol/src/index.ts'
                  : 'infra/sql/001_init_pgvector.sql'}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(mode === 'protocol' ? PROTOCOL_SPEC : PGVECTOR_DDL)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    复制代码
                  </>
                )}
              </button>
            </div>
            <pre className="p-5 bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed overflow-x-auto">
              {mode === 'protocol' ? PROTOCOL_SPEC : PGVECTOR_DDL}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}
