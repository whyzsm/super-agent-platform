import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  GitBranch,
  MessageSquarePlus,
  Play,
  RotateCcw,
  ShieldAlert,
  Terminal as TerminalIcon,
  XCircle,
} from 'lucide-react';
import type { DagNode } from '../protocol';
import {
  GATE_TYPE_LABELS,
  PROVIDER_LABELS,
  ROLE_LABELS,
  TASK_STATE_META,
} from '../utils/statusStyles';

type InspectorTab = 'events' | 'terminal' | 'diff' | 'checks';

interface NodeInspectorPaneProps {
  task: DagNode | null;
  siblingTasks: DagNode[];
  mutating: boolean;
  onSelectTask: (taskId: string) => void;
  onAdvanceTask: (taskId: string) => void;
  onProvisionWorktree: (taskId: string) => void;
  onReleaseWorktree: (taskId: string) => void;
  onSimulateFailure: (taskId: string) => void;
  onSimulateDanger: (taskId: string) => void;
  onGateDecision: (
    taskId: string,
    payload: { approved: boolean; abort?: boolean; comment?: string },
  ) => void;
  onAddLineComment: (
    taskId: string,
    payload: { file: string; line: number; comment: string },
  ) => void;
  onSendNdjsonLine: (taskId: string, line: string) => void;
  onSendInput: (taskId: string, text: string) => void;
  onTriggerImCallback: (taskId: string, approved: boolean) => void;
}

export function NodeInspectorPane({
  task,
  siblingTasks,
  mutating,
  onSelectTask,
  onAdvanceTask,
  onProvisionWorktree,
  onReleaseWorktree,
  onSimulateFailure,
  onSimulateDanger,
  onGateDecision,
  onAddLineComment,
  onSendNdjsonLine,
  onSendInput,
  onTriggerImCallback,
}: NodeInspectorPaneProps) {
  const [tab, setTab] = useState<InspectorTab>('diff');
  const [gateComment, setGateComment] = useState('');
  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [lineDraft, setLineDraft] = useState('');
  const [terminalInput, setTerminalInput] = useState('');
  const [ndjsonDraft, setNdjsonDraft] = useState(
    '{"type":"file_edit","title":"写入脱敏配置","content":"Using api key sk-demo1234567890abcdef"}',
  );

  const diffLines = useMemo(() => {
    if (!task?.diffPatch) return [];
    return task.diffPatch.split('\n');
  }, [task?.diffPatch]);

  const diffFile = useMemo(() => {
    const line = diffLines.find((l) => l.startsWith('+++ b/'));
    return line ? line.replace('+++ b/', '') : 'worktree.patch';
  }, [diffLines]);

  if (!task) {
    return (
      <aside
        aria-label="节点检验舱"
        className="w-full lg:w-[460px] shrink-0 bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex items-center justify-center p-6"
      >
        <p className="text-xs text-slate-500">点击中间画布中的任意任务节点，查看推理流与 Worktree Diff。</p>
      </aside>
    );
  }

  const meta = TASK_STATE_META[task.state];
  const isGateState = task.state === 'HUMAN_GATE' || task.state === 'ESCALATED';

  return (
    <aside
      aria-label="节点检验舱"
      className="w-full lg:w-[460px] shrink-0 bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col min-h-0"
    >
      {/* Header + Worktree Branch Switcher */}
      <div className="p-4 border-b border-slate-200 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <GitBranch className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
            <label htmlFor="worktree-switcher" className="sr-only">
              切换并行 Worktree 分支
            </label>
            <select
              id="worktree-switcher"
              value={task.id}
              onChange={(e) => onSelectTask(e.target.value)}
              className="text-xs font-mono bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-800 max-w-[260px] truncate focus:outline-none focus:border-blue-600"
            >
              {siblingTasks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.worktreeBranch || s.id} ({TASK_STATE_META[s.state].label})
                </option>
              ))}
            </select>
          </div>

          <span
            className={`px-2 py-0.5 text-[11px] font-semibold rounded border whitespace-nowrap ${meta.bgClass} ${meta.textClass} ${meta.borderClass}`}
          >
            {meta.label}
          </span>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-slate-900 leading-snug">{task.title}</h2>
          <p className="mt-1 text-xs text-slate-500 flex flex-wrap items-center gap-1.5 font-mono tabular-nums">
            <span className="font-sans font-medium text-slate-700">
              {ROLE_LABELS[task.role]}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-sans">{PROVIDER_LABELS[task.provider]}</span>
            <span aria-hidden="true">·</span>
            <span>{task.assignedMachine || 'mac-studio-sh-01'}</span>
            {task.localPort && (
              <>
                <span aria-hidden="true">·</span>
                <span>:{task.localPort}</span>
              </>
            )}
          </p>
          {task.usage && (
            <p
              className={`mt-1 text-[11px] font-mono tabular-nums flex items-center gap-1.5 ${
                task.usage.inputTokens + task.usage.outputTokens >= task.usage.budgetTokens
                  ? 'text-red-700 font-semibold'
                  : task.usage.inputTokens + task.usage.outputTokens >= task.usage.budgetTokens * 0.8
                    ? 'text-amber-700 font-medium'
                    : 'text-slate-500'
              }`}
            >
              <span>
                {(
                  (task.usage.inputTokens + task.usage.outputTokens) /
                  1000
                ).toFixed(1)}
                k / {(task.usage.budgetTokens / 1000).toFixed(0)}k tokens
              </span>
              <span aria-hidden="true">·</span>
              <span>${task.usage.costUsd.toFixed(3)}</span>
              <span aria-hidden="true">·</span>
              <span>{task.usage.durationSec}s</span>
            </p>
          )}
        </div>

        <div
          role="tablist"
          aria-label="节点检验视图"
          className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-md"
        >
          {(
            [
              { id: 'diff', label: 'Code Diff' },
              { id: 'events', label: `事件树 (${task.events.length})` },
              { id: 'terminal', label: '终端流' },
              { id: 'checks', label: `校验 (${task.verifierChecks.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                tab === item.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {tab === 'events' && (
          <div className="space-y-2.5">
            {task.events.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                节点尚未开始执行，等待上游依赖或调度器唤醒。
              </p>
            ) : (
              task.events.map((ev) => (
                <div
                  key={ev.id}
                  className="border border-slate-200 rounded-md p-3 bg-white space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-500">
                    <span>
                      #{ev.seq} · {ev.kind}
                    </span>
                    <span>{ev.ts}</span>
                  </div>
                  <p className="text-xs font-semibold text-slate-900">{ev.title}</p>
                  <p className="text-xs text-slate-600 leading-relaxed">{ev.detail}</p>
                  {ev.redactedHits && ev.redactedHits > 0 ? (
                    <p className="text-[11px] text-emerald-700 font-medium">
                      已自动脱敏 {ev.redactedHits} 处密钥/PII 敏感字段
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'terminal' && (
          <div className="space-y-3">
            <div className="bg-slate-950 text-slate-100 rounded-md p-3 font-mono text-[11px] leading-relaxed space-y-1 overflow-x-auto">
              <div className="flex items-center justify-between gap-2 text-slate-400 border-b border-slate-800 pb-2 mb-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <TerminalIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate" title={task.worktreePath || task.worktreeBranch}>
                    {task.adapterMode} · {task.worktreePath || task.worktreeBranch}
                  </span>
                </span>
                {/* M14：真实 git worktree 的建删入口，路径为服务端落盘返回的绝对路径 */}
                <span className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={mutating}
                    onClick={() => onProvisionWorktree(task.id)}
                    className="px-2 py-0.5 rounded border border-slate-700 text-[10px] text-emerald-300 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {task.worktreePath ? '重建工作树' : '创建工作树'}
                  </button>
                  <button
                    type="button"
                    disabled={mutating || !task.worktreePath}
                    onClick={() => onReleaseWorktree(task.id)}
                    title={task.worktreePath ? '删除真实工作树目录（分支保留）' : '当前没有已创建的工作树'}
                    className="px-2 py-0.5 rounded border border-slate-700 text-[10px] text-rose-300 hover:bg-slate-800 disabled:opacity-50"
                  >
                    删除
                  </button>
                </span>
              </div>
              {task.terminalLines.map((line, idx) => (
                <div
                  key={`${idx}-${line.slice(0, 12)}`}
                  className={
                    line.includes('FAIL') || line.includes('INTERCEPTED') || line.includes('BLOCKED')
                      ? 'text-rose-400'
                      : line.includes('MERGED') || line.includes('passed')
                        ? 'text-emerald-400'
                        : 'text-slate-200'
                  }
                >
                  {line}
                </div>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!terminalInput.trim()) return;
                onSendInput(task.id, terminalInput.trim());
                setTerminalInput('');
              }}
              className="border border-slate-200 rounded-md p-3 bg-white space-y-2"
            >
              <label htmlFor="session-stdin-input" className="block text-[11px] font-semibold text-slate-700">
                会话交互输入 (AgentRunnerAdapter.sendInput)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="session-stdin-input"
                  type="text"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  placeholder="输入调试指令或确认应答，例如：pnpm test --filter=retryPolicy"
                  className="flex-1 px-2.5 py-1.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
                />
                <button
                  type="submit"
                  disabled={mutating || !terminalInput.trim()}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                >
                  发送指令
                </button>
              </div>
            </form>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!ndjsonDraft.trim()) return;
                onSendNdjsonLine(task.id, ndjsonDraft.trim());
              }}
              className="border border-slate-200 rounded-md p-3 bg-slate-50 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <label htmlFor="ndjson-input" className="text-[11px] font-semibold text-slate-700">
                  Headless NDJSON 流 / ACP 沙箱注入调试
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setNdjsonDraft('{"type":"shell_exec","command":"git push --force origin main"}')
                    }
                    className="text-[11px] text-red-700 hover:underline"
                  >
                    高危指令样本
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setNdjsonDraft(
                        '{"type":"file_edit","title":"写入配置","content":"Loaded key sk-demo1234567890abcdef"}',
                      )
                    }
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    脱敏样本
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setNdjsonDraft(
                        '{"type":"usage","inputTokens":18000,"outputTokens":6000}',
                      )
                    }
                    className="text-[11px] text-amber-700 hover:underline"
                  >
                    预算熔断样本
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="ndjson-input"
                  type="text"
                  value={ndjsonDraft}
                  onChange={(e) => setNdjsonDraft(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 text-[11px] font-mono bg-white border border-slate-200 rounded text-slate-900 focus:outline-none focus:border-blue-600"
                />
                <button
                  type="submit"
                  disabled={mutating}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >
                  解析入流
                </button>
              </div>
            </form>
          </div>
        )}

        {tab === 'diff' && (
          <div className="space-y-3">
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex items-center justify-between text-[11px] font-mono text-slate-600">
                <span className="truncate">{diffFile}</span>
                <span>点击行号添加批注</span>
              </div>
              <div className="bg-slate-950 text-slate-100 font-mono text-[11px] leading-5 overflow-x-auto">
                {diffLines.map((line, i) => {
                  const lineNo = i + 1;
                  const isAdd = line.startsWith('+') && !line.startsWith('+++');
                  const isDel = line.startsWith('-') && !line.startsWith('---');
                  const existingComments = task.lineComments.filter((c) => c.line === lineNo);
                  return (
                    <div key={`${lineNo}-${line.slice(0, 10)}`}>
                      <div
                        className={`flex items-start ${
                          isAdd
                            ? 'bg-emerald-950/50 text-emerald-200'
                            : isDel
                              ? 'bg-rose-950/50 text-rose-200'
                              : 'text-slate-300'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setCommentLine(commentLine === lineNo ? null : lineNo);
                            setLineDraft('');
                          }}
                          title={`在第 ${lineNo} 行添加批注`}
                          className="w-10 shrink-0 px-2 text-right text-slate-500 hover:text-blue-400 select-none tabular-nums"
                        >
                          {lineNo}
                        </button>
                        <span className="px-2 whitespace-pre">{line || ' '}</span>
                      </div>

                      {existingComments.map((c) => (
                        <div
                          key={c.id}
                          className="bg-amber-950/70 border-y border-amber-800/60 px-3 py-1.5 text-[11px] text-amber-100 font-sans"
                        >
                          <span className="font-semibold">{c.author}</span> · 第 {c.line} 行：
                          {c.comment}
                        </div>
                      ))}

                      {commentLine === lineNo && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!lineDraft.trim()) return;
                            onAddLineComment(task.id, {
                              file: diffFile,
                              line: lineNo,
                              comment: lineDraft.trim(),
                            });
                            setGateComment((prev) =>
                              prev
                                ? `${prev}\n[${diffFile}:${lineNo}] ${lineDraft.trim()}`
                                : `[${diffFile}:${lineNo}] ${lineDraft.trim()}`,
                            );
                            setCommentLine(null);
                            setLineDraft('');
                          }}
                          className="bg-slate-900 border-y border-slate-700 p-2 flex items-center gap-2 font-sans"
                        >
                          <input
                            type="text"
                            value={lineDraft}
                            onChange={(e) => setLineDraft(e.target.value)}
                            placeholder={`针对第 ${lineNo} 行的打回或修改建议...`}
                            className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
                          />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
                          >
                            <MessageSquarePlus className="w-3 h-3" aria-hidden="true" />
                            批注
                          </button>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {tab === 'checks' && (
          <div className="space-y-2">
            {task.verifierChecks.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                尚未触发本地确定性门禁校验（lint / typecheck / unit_test）。
              </p>
            ) : (
              task.verifierChecks.map((chk) => (
                <div
                  key={chk.name}
                  className="border border-slate-200 rounded-md p-3 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {chk.passed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold font-mono text-slate-900">{chk.name}</p>
                      <p className="text-xs text-slate-600 truncate">{chk.summary}</p>
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                    {chk.durationMs} ms
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Bottom Gate / Control Action Bar */}
      <div className="border-t border-slate-200 p-4 bg-slate-50 space-y-3">
        {isGateState && task.activeCheckpoint ? (
          <>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {GATE_TYPE_LABELS[task.activeCheckpoint.gateType]}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-slate-500">
                  Retry {task.retryCount}/{task.maxRetries}
                </span>
              </div>
              <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                {task.activeCheckpoint.summaryMd}
              </p>
            </div>

            <div>
              <label htmlFor="gate-comment" className="sr-only">
                审批意见或打回修改指令
              </label>
              <textarea
                id="gate-comment"
                rows={2}
                value={gateComment}
                onChange={(e) => setGateComment(e.target.value)}
                placeholder="填写批准备注或打回修改意见（支持附带代码行级批注）..."
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={mutating}
                onClick={() => {
                  onGateDecision(task.id, {
                    approved: true,
                    comment: gateComment.trim() || undefined,
                  });
                  setGateComment('');
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                批准放行
              </button>

              <button
                type="button"
                disabled={mutating}
                onClick={() => {
                  onGateDecision(task.id, {
                    approved: false,
                    comment: gateComment.trim() || '请按审查意见修复后重新提交门禁验证。',
                  });
                  setGateComment('');
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-800 bg-amber-100 border border-amber-300 rounded-md hover:bg-amber-200 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                附带意见打回
              </button>

              <button
                type="button"
                disabled={mutating}
                onClick={() => {
                  onGateDecision(task.id, {
                    approved: false,
                    abort: true,
                    comment: gateComment.trim() || '操作员终止任务',
                  });
                  setGateComment('');
                }}
                className="px-3 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                终止
              </button>
            </div>

            <div className="pt-1 border-t border-slate-200/80 flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>企业微信 / 飞书卡片 HMAC-SHA256 回调调试</span>
              <button
                type="button"
                disabled={mutating}
                onClick={() => onTriggerImCallback(task.id, true)}
                className="font-medium text-blue-600 hover:underline disabled:opacity-50 whitespace-nowrap"
              >
                模拟 IM 签名放行
              </button>
            </div>
          </>
        ) : task.state === 'MERGED' ? (
          <div className="flex items-center justify-between text-xs text-emerald-700">
            <span className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              节点已合入主干并释放隔离 Worktree 沙箱
            </span>
          </div>
        ) : task.state === 'CANCELLED' ? (
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <XCircle className="w-4 h-4" aria-hidden="true" />
            任务已终止
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-slate-600">
              当前处于 <span className="font-semibold text-slate-900">{meta.label}</span> 阶段，可执行实时推进或故障演练：
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={mutating}
                onClick={() => onAdvanceTask(task.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                推进验证
              </button>
              <button
                type="button"
                disabled={mutating}
                onClick={() => onSimulateFailure(task.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-white border border-amber-300 rounded-md hover:bg-amber-50 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                模拟单测失败
              </button>
              <button
                type="button"
                disabled={mutating}
                onClick={() => onSimulateDanger(task.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                模拟高危拦截
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
