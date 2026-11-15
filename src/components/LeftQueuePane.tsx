import { useMemo, useState } from 'react';
import { Search, Server, ShieldAlert } from 'lucide-react';
import type { DaemonRunner, DagNode, Requirement } from '../protocol';

interface LeftQueuePaneProps {
  requirements: Requirement[];
  tasks: DagNode[];
  daemons: DaemonRunner[];
  selectedReqId: string | null;
  onSelectReq: (reqId: string) => void;
  onOpenDaemonsTab: () => void;
}

type QueueFilter = 'all' | 'gate' | 'active';

const CHANNEL_TEXT: Record<Requirement['sourceChannel'], string> = {
  web: 'Web 控制台',
  cli: '本地 CLI',
  wecom: '企业微信',
  feishu: '飞书 IM',
};

export function LeftQueuePane({
  requirements,
  tasks,
  daemons,
  selectedReqId,
  onSelectReq,
  onOpenDaemonsTab,
}: LeftQueuePaneProps) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [query, setQuery] = useState('');

  const gateCountByReq = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (t.state === 'HUMAN_GATE' || t.state === 'ESCALATED') {
        map.set(t.reqId, (map.get(t.reqId) ?? 0) + 1);
      }
    }
    return map;
  }, [tasks]);

  const totalPendingGates = useMemo(
    () => tasks.filter((t) => t.state === 'HUMAN_GATE' || t.state === 'ESCALATED').length,
    [tasks],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requirements.filter((req) => {
      const gates = gateCountByReq.get(req.id) ?? 0;
      if (filter === 'gate' && gates === 0) return false;
      if (filter === 'active' && req.status === 'COMPLETED') return false;
      if (q && !req.title.toLowerCase().includes(q) && !req.id.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [requirements, filter, query, gateCountByReq]);

  return (
    <aside
      aria-label="需求队列与守护进程"
      className="w-full lg:w-[296px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col min-h-0"
    >
      <div className="p-4 border-b border-slate-200 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">需求队列</h2>
          <span className="text-xs font-medium text-amber-700 tabular-nums flex items-center gap-1">
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            待审门禁 {totalPendingGates}
          </span>
        </div>

        <div className="relative">
          <Search
            className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <label htmlFor="req-search" className="sr-only">
            搜索需求标题或编号
          </label>
          <input
            id="req-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索需求标题或编号..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:bg-white"
          />
        </div>

        <div
          role="tablist"
          aria-label="需求状态筛选"
          className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-md"
        >
          {(
            [
              { id: 'all', label: '全部' },
              { id: 'gate', label: '待审批' },
              { id: 'active', label: '进行中' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                filter === item.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {filtered.length === 0 ? (
          <div className="p-6 text-center space-y-2">
            <p className="text-xs text-slate-500">当前筛选条件下暂无匹配需求</p>
            <button
              type="button"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
              className="text-xs font-medium text-blue-600 hover:underline"
            >
              清空筛选条件
            </button>
          </div>
        ) : (
          filtered.map((req) => {
            const active = req.id === selectedReqId;
            const gateCount = gateCountByReq.get(req.id) ?? 0;
            const reqTasks = tasks.filter((t) => t.reqId === req.id);
            const mergedCount = reqTasks.filter((t) => t.state === 'MERGED').length;

            return (
              <button
                key={req.id}
                type="button"
                onClick={() => onSelectReq(req.id)}
                className={`w-full text-left px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 ${
                  active ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={`text-[13px] font-semibold leading-snug line-clamp-2 ${
                      active ? 'text-blue-950' : 'text-slate-900'
                    }`}
                  >
                    {req.title}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 font-mono tabular-nums truncate">
                  <span>{req.id.toUpperCase()}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans">{CHANNEL_TEXT[req.sourceChannel]}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {mergedCount}/{reqTasks.length} 合入
                  </span>
                  {gateCount > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-sans font-semibold text-amber-700">
                        {gateCount} 待审
                      </span>
                    </>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      <div className="border-t border-slate-200 p-4 bg-slate-50/60 space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            本地 Daemon 沙箱节点
          </h3>
          <button
            type="button"
            onClick={onOpenDaemonsTab}
            className="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap"
          >
            管理节点
          </button>
        </div>

        <div className="space-y-1.5">
          {daemons.map((d) => (
            <div
              key={d.machineId}
              className="flex items-center justify-between gap-2 text-xs py-1 border-b border-slate-200/70 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="font-mono text-[11px] font-medium text-slate-800 truncate">
                  {d.machineId}
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {d.status === 'online'
                    ? '在线'
                    : d.status === 'reconnecting'
                      ? `补发中 (${d.pendingOfflineEvents})`
                      : '离线'}
                  {' · '}
                  {d.worktrees.length} worktrees
                </p>
              </div>
              <span className="font-mono text-[11px] tabular-nums text-slate-600 shrink-0">
                CPU {d.cpuLoad.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
