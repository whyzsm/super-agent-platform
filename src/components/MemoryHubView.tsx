import { useMemo, useState } from 'react';
import { Archive, Check, Lock, Search, ShieldCheck } from 'lucide-react';
import { parseSkillFrontmatter } from '../engine/stateMachine';
import type { MemoryAsset, MemoryScope, MemoryStatus } from '../protocol';

interface MemoryHubViewProps {
  memories: MemoryAsset[];
  mutating: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

const ASSET_TYPE_LABELS: Record<MemoryAsset['assetType'], string> = {
  SKILL: 'Skill 技能资产',
  L1_FACT: 'L1 原子事实',
  L2_SOLUTION: 'L2 场景方案',
  LLM_WIKI: 'LLM-Wiki',
  CODE_GRAPH: 'CodeGraph 图谱',
};

const STATUS_LABELS: Record<MemoryStatus, { text: string; cls: string }> = {
  draft: {
    text: '待审核草案',
    cls: 'text-amber-800 bg-amber-50 border-amber-300',
  },
  published: {
    text: '已发布生效',
    cls: 'text-emerald-700 bg-emerald-50 border-emerald-300',
  },
  archived: {
    text: '已归档拦截',
    cls: 'text-slate-600 bg-slate-100 border-slate-300',
  },
};

export function MemoryHubView({
  memories,
  mutating,
  onApprove,
  onReject,
}: MemoryHubViewProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | MemoryStatus>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | MemoryScope>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(memories[0]?.id ?? null);
  const [mainMode, setMainMode] = useState<'detail' | 'mcp'>('detail');
  const [recallQuery, setRecallQuery] = useState('Webhook');
  const [callerUser, setCallerUser] = useState('codex-agent');
  const [callerAgent, setCallerAgent] = useState('codex');
  const [callerProject, setCallerProject] = useState('');
  const [recallBusy, setRecallBusy] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [recallResponse, setRecallResponse] = useState<{
    results: Array<{ asset: MemoryAsset; score: number; matchedAcl: string }>;
    excludedDraftsCount: number;
  } | null>(null);

  async function runMcpRecall(e?: React.FormEvent) {
    e?.preventDefault();
    if (!recallQuery.trim()) return;
    setRecallBusy(true);
    setRecallError(null);
    try {
      const res = await fetch('/api/mcp/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: recallQuery.trim(),
          caller: {
            teamId: 'team-platform-core',
            projectId: callerProject || undefined,
            userId: callerUser || undefined,
            agentId: callerAgent || undefined,
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRecallResponse({
        results: data.results ?? [],
        excludedDraftsCount: data.excludedDraftsCount ?? 0,
      });
    } catch (err) {
      setRecallError(err instanceof Error ? err.message : 'MCP 召回请求失败');
    } finally {
      setRecallBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories.filter((m) => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (scopeFilter !== 'all' && m.scope !== scopeFilter) return false;
      if (
        q &&
        !m.title.toLowerCase().includes(q) &&
        !m.contentMd.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [memories, statusFilter, scopeFilter, query]);

  const selected = useMemo(
    () => filtered.find((m) => m.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const frontmatterCheck = useMemo(() => {
    if (!selected || selected.assetType !== 'SKILL') return null;
    return parseSkillFrontmatter(selected.contentMd);
  }, [selected]);

  const draftCount = useMemo(
    () => memories.filter((m) => m.status === 'draft').length,
    [memories],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row bg-slate-50">
      {/* Left Filter + Asset List */}
      <aside className="w-full lg:w-[380px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col min-h-0">
        <div className="p-4 border-b border-slate-200 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-sm font-semibold text-slate-900">
              云端记忆与 Skill 审核中心
            </h1>
            <span className="text-xs font-medium text-amber-700 font-mono tabular-nums">
              待审草案 {draftCount}
            </span>
          </div>

          <div className="relative">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <label htmlFor="memory-search" className="sr-only">
              检索记忆与 Skill 内容
            </label>
            <input
              id="memory-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索标题、触发词或 SOP 正文..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600 focus:bg-white"
            />
          </div>

          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label="资产状态筛选"
              className="flex-1 grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-md"
            >
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'draft', label: '待审草案' },
                  { id: 'published', label: '已发布' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={statusFilter === tab.id}
                  onClick={() => setStatusFilter(tab.id)}
                  className={`py-1 text-xs font-medium rounded transition-colors ${
                    statusFilter === tab.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <label htmlFor="scope-filter" className="sr-only">
              ACL 作用域筛选
            </label>
            <select
              id="scope-filter"
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value as 'all' | MemoryScope)}
              className="text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white text-slate-700"
            >
              <option value="all">全部作用域</option>
              <option value="team">Team</option>
              <option value="project">Project</option>
              <option value="user">User</option>
              <option value="agent">Agent</option>
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              当前条件下无匹配记忆资产。
            </div>
          ) : (
            filtered.map((item) => {
              const active = selected?.id === item.id;
              const st = STATUS_LABELS[item.status];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    active ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] font-medium text-slate-500">
                      {ASSET_TYPE_LABELS[item.assetType]} · {item.scope}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${st.cls}`}
                    >
                      {st.text}
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-slate-900 line-clamp-2">
                    {item.title}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
                    v{item.version} · owner {item.ownerId}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Right Detail + ACL + Promotion Actions + MCP Recall Playground */}
      <main className="flex-1 min-w-0 overflow-y-auto p-6 space-y-5">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div
            role="tablist"
            aria-label="记忆中心操作视图"
            className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-md"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mainMode === 'detail'}
              onClick={() => setMainMode('detail')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mainMode === 'detail'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              资产详情与审核
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainMode === 'mcp'}
              onClick={() => setMainMode('mcp')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mainMode === 'mcp'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              MCP 召回调试
            </button>
          </div>
        </div>

        {mainMode === 'mcp' ? (
          <div className="max-w-4xl mx-auto space-y-4">
            <form
              onSubmit={runMcpRecall}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
            >
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  MCP Tool 记忆召回与四级 ACL 权限验证
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  自动排除 status=draft 草案，仅召回满足 Caller ACL 权限的已发布资产。
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <label htmlFor="mcp-query" className="block text-[11px] font-medium text-slate-600 mb-1">
                    检索查询词
                  </label>
                  <input
                    id="mcp-query"
                    type="text"
                    value={recallQuery}
                    onChange={(e) => setRecallQuery(e.target.value)}
                    placeholder="例如：Webhook / Redis / 对账"
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <div>
                  <label htmlFor="mcp-user" className="block text-[11px] font-medium text-slate-600 mb-1">
                    User 主体
                  </label>
                  <select
                    id="mcp-user"
                    value={callerUser}
                    onChange={(e) => setCallerUser(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-md bg-white text-slate-900"
                  >
                    <option value="codex-agent">codex-agent</option>
                    <option value="lin.wei">lin.wei</option>
                    <option value="zhou.min">zhou.min</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="mcp-project" className="block text-[11px] font-medium text-slate-600 mb-1">
                    Project 主体
                  </label>
                  <select
                    id="mcp-project"
                    value={callerProject}
                    onChange={(e) => setCallerProject(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-md bg-white text-slate-900"
                  >
                    <option value="">无项目绑定</option>
                    <option value="proj-reconcile">proj-reconcile</option>
                    <option value="proj-memory-hub">proj-memory-hub</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span>Agent 身份：</span>
                  <select
                    aria-label="Agent 身份"
                    value={callerAgent}
                    onChange={(e) => setCallerAgent(e.target.value)}
                    className="px-2 py-1 text-xs border border-slate-200 rounded bg-white text-slate-900"
                  >
                    <option value="codex">codex</option>
                    <option value="claude-code">claude-code</option>
                    <option value="workbuddy">workbuddy</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={recallBusy}
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50"
                >
                  执行 MCP 召回
                </button>
              </div>
            </form>

            {recallError && (
              <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
                {recallError}
              </div>
            )}

            {recallResponse && (
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-900">
                    召回结果 ({recallResponse.results.length} 条)
                  </span>
                  <span className="text-slate-500 font-mono tabular-nums">
                    已自动隔离 draft 草案 {recallResponse.excludedDraftsCount} 条
                  </span>
                </div>
                {recallResponse.results.length === 0 ? (
                  <p className="p-6 text-center text-xs text-slate-500">
                    当前 Caller ACL 权限与查询词下无命中已发布记忆。
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {recallResponse.results.map((hit) => (
                      <div key={hit.asset.id} className="p-4 space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-slate-900">{hit.asset.title}</span>
                          <span className="font-mono tabular-nums text-emerald-700 font-medium">
                            score {hit.score.toFixed(2)}
                          </span>
                        </div>
                        <p className="text-[11px] font-mono text-slate-500">
                          命中 ACL：{hit.matchedAcl} · {ASSET_TYPE_LABELS[hit.asset.assetType]}
                        </p>
                        <p className="text-xs text-slate-600 line-clamp-2">{hit.asset.contentMd}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : !selected ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">
            请从左侧选择一条记忆或 Skill 草案进行审查。
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-5">
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
                    <span>{ASSET_TYPE_LABELS[selected.assetType]}</span>
                    <span aria-hidden="true">·</span>
                    <span>scope={selected.scope}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">v{selected.version}</span>
                    {typeof selected.duplicateScore === 'number' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          向量查重相似度 {(selected.duplicateScore * 100).toFixed(0)}%
                        </span>
                      </>
                    )}
                  </div>
                  <h2 className="text-base font-semibold text-slate-900">{selected.title}</h2>
                </div>

                {selected.status === 'draft' && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={mutating}
                      onClick={() => onApprove(selected.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      批准发布至 .teamai/
                    </button>
                    <button
                      type="button"
                      disabled={mutating}
                      onClick={() => onReject(selected.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                      归档淘汰
                    </button>
                  </div>
                )}
              </div>

              {selected.sourceReason && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-700 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <span className="font-semibold text-slate-900">防污染溯源：</span>
                    {selected.sourceReason}
                    {selected.sourceTaskId && (
                      <span className="ml-1 font-mono text-slate-500">
                        ({selected.sourceTaskId})
                      </span>
                    )}
                  </div>
                </div>
              )}

              {frontmatterCheck && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-md text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">
                      skill-sdk YAML Frontmatter 校验
                    </span>
                    <span
                      className={`font-medium ${
                        frontmatterCheck.valid ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {frontmatterCheck.valid ? '格式合法' : '校验未通过'}
                    </span>
                  </div>
                  {frontmatterCheck.triggers && frontmatterCheck.triggers.length > 0 && (
                    <p className="font-mono text-[11px] text-slate-600">
                      triggers: [{frontmatterCheck.triggers.join(', ')}]
                    </p>
                  )}
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold text-slate-700 mb-2">资产内容 (Markdown)</h3>
                <pre className="p-4 bg-slate-950 text-slate-100 rounded-md font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap">
                  {selected.contentMd}
                </pre>
              </div>
            </div>

            {/* 4-level ACL Table */}
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  四级 ACL 权限隔离矩阵 (asset_acl)
                </h3>
                <span className="text-[11px] text-slate-500">
                  Team / Project / User / Agent
                </span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">主体类型 (subject_type)</th>
                    <th className="px-5 py-2.5 font-medium">主体标识 (subject_id)</th>
                    <th className="px-5 py-2.5 font-medium">权限 (permission)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {selected.acl.map((entry, idx) => (
                    <tr key={`${entry.subjectType}-${entry.subjectId}-${idx}`} className="h-9">
                      <td className="px-5 py-2 text-slate-700">{entry.subjectType}</td>
                      <td className="px-5 py-2 text-slate-900">{entry.subjectId}</td>
                      <td className="px-5 py-2 text-emerald-700">{entry.permission}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
