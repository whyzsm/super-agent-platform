import { GitBranch, RefreshCw, Server, Shield } from 'lucide-react';
import type { DaemonEnvelope, DaemonRunner } from '../protocol';
import { PROVIDER_LABELS } from '../utils/statusStyles';

interface DaemonsViewProps {
  daemons: DaemonRunner[];
  envelopes: DaemonEnvelope[];
  streamConnected: boolean;
  lastSeq: number;
  mutating: boolean;
  onReplayQueue: (machineId: string) => void;
}

export function DaemonsView({
  daemons,
  envelopes,
  streamConnected,
  lastSeq,
  mutating,
  onReplayQueue,
}: DaemonsViewProps) {
  const allWorktrees = daemons.flatMap((d) =>
    d.worktrees.map((w) => ({ ...w, machineId: d.machineId })),
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">
              本地异构 CLI 守护进程与隔离 Worktree 沙箱
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              支持 Headless JSON 流、ACP 双向高危拦截、PTY/tmux 托管及断线按 seq 补发。
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-600 bg-white border border-slate-200 rounded-md px-3 py-1.5">
            SSE 网关：{streamConnected ? '已连接' : '重连中'} · 最新 seq #{lastSeq}
          </div>
        </div>

        {/* Daemons Table */}
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <Server className="w-4 h-4 text-slate-500" aria-hidden="true" />
              在线 Runner 节点 ({daemons.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-5 py-2.5 font-medium">机器标识</th>
                  <th className="px-5 py-2.5 font-medium">环境 / CLI 适配器</th>
                  <th className="px-5 py-2.5 font-medium">状态</th>
                  <th className="px-5 py-2.5 font-medium text-right">CPU / 内存</th>
                  <th className="px-5 py-2.5 font-medium text-right">lastAckSeq</th>
                  <th className="px-5 py-2.5 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {daemons.map((d) => (
                  <tr key={d.machineId} className="h-11 hover:bg-slate-50/70">
                    <td className="px-5 py-2.5">
                      <p className="font-mono font-semibold text-slate-900">{d.machineId}</p>
                      <p className="text-[11px] text-slate-500">{d.hostname}</p>
                    </td>
                    <td className="px-5 py-2.5">
                      <p className="text-slate-700">{d.os}</p>
                      <p className="text-[11px] text-slate-500">
                        {d.providers.map((p) => PROVIDER_LABELS[p]).join(' · ')}
                      </p>
                    </td>
                    <td className="px-5 py-2.5">
                      <span
                        className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded border ${
                          d.status === 'online'
                            ? 'text-emerald-700 bg-emerald-50 border-emerald-300'
                            : 'text-amber-800 bg-amber-50 border-amber-300'
                        }`}
                      >
                        {d.status === 'online'
                          ? '在线就绪'
                          : `断线续传 (${d.pendingOfflineEvents} 待补发)`}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      {d.cpuLoad.toFixed(1)}% · {d.memUsedGb}/{d.memTotalGb} GB
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      #{d.lastAckSeq}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        type="button"
                        disabled={mutating}
                        onClick={() => onReplayQueue(d.machineId)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden="true" />
                        SQLite 队列补发
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Worktrees Table */}
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <GitBranch className="w-4 h-4 text-slate-500" aria-hidden="true" />
              物理隔离 Git Worktree 实例 ({allWorktrees.length})
            </h2>
            <span className="text-[11px] text-slate-500 flex items-center gap-1">
              <Shield className="w-3.5 h-3.5" aria-hidden="true" />
              路径白名单锁定 ~/.superagent/worktrees/
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="px-5 py-2.5 font-medium">分支 (Branch)</th>
                  <th className="px-5 py-2.5 font-medium">隔离目录</th>
                  <th className="px-5 py-2.5 font-medium">宿主机</th>
                  <th className="px-5 py-2.5 font-medium">CLI / 协议模式</th>
                  <th className="px-5 py-2.5 font-medium text-right">沙箱端口</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                {allWorktrees.map((wt) => (
                  <tr key={wt.taskId} className="h-10 hover:bg-slate-50/70">
                    <td className="px-5 py-2 font-semibold text-slate-900">{wt.branch}</td>
                    <td className="px-5 py-2 text-slate-600">{wt.path}</td>
                    <td className="px-5 py-2 text-slate-700">{wt.machineId}</td>
                    <td className="px-5 py-2 text-slate-700">
                      {wt.provider} · {wt.adapterMode}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-slate-700">
                      :{wt.port}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Live Envelope Stream */}
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200">
            <h2 className="text-xs font-semibold text-slate-900">
              实时 DaemonEnvelope 信封流（100ms 批量合批）
            </h2>
          </div>
          <div className="p-4 bg-slate-950 text-slate-200 font-mono text-[11px] space-y-1 max-h-56 overflow-y-auto">
            {envelopes.length === 0 ? (
              <p className="text-slate-500">等待下一周期心跳或节点状态事件...</p>
            ) : (
              envelopes.map((env, idx) => (
                <div key={`${env.seq}-${idx}`} className="truncate">
                  <span className="text-slate-500">#{env.seq}</span>{' '}
                  <span className="text-blue-400">[{env.machineId}]</span>{' '}
                  <span className="text-emerald-400">{env.payload.type}</span>{' '}
                  <span className="text-slate-300">{JSON.stringify(env.payload)}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
