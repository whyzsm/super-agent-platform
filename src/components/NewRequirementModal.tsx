import { useState } from 'react';
import { X } from 'lucide-react';
import type { AgentProvider, SopTemplateId } from '../protocol';

interface NewRequirementModalProps {
  open: boolean;
  mutating: boolean;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    specMd: string;
    repoUrl: string;
    baseBranch: string;
    sourceChannel: 'web' | 'cli' | 'wecom' | 'feishu';
    primaryProvider: AgentProvider;
    sopTemplate: SopTemplateId;
  }) => Promise<boolean>;
}

export function NewRequirementModal({
  open,
  mutating,
  onClose,
  onSubmit,
}: NewRequirementModalProps) {
  const [title, setTitle] = useState('');
  const [repoUrl, setRepoUrl] = useState('git@code.internal:superagent/platform-core.git');
  const [baseBranch, setBaseBranch] = useState('main');
  const [sourceChannel, setSourceChannel] = useState<'web' | 'cli' | 'wecom' | 'feishu'>('web');
  const [primaryProvider, setPrimaryProvider] = useState<AgentProvider>('codex');
  const [sopTemplate, setSopTemplate] = useState<SopTemplateId>('feature_flow');
  const [specMd, setSpecMd] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !specMd.trim()) {
      setFormError('请填写需求标题与详细规格描述后再提交拆解。');
      return;
    }
    setFormError(null);
    const ok = await onSubmit({
      title: title.trim(),
      specMd: specMd.trim(),
      repoUrl: repoUrl.trim() || 'git@code.internal:superagent/platform-core.git',
      baseBranch: baseBranch.trim() || 'main',
      sourceChannel,
      primaryProvider,
      sopTemplate,
    });
    if (ok) {
      setTitle('');
      setSpecMd('');
      setSopTemplate('feature_flow');
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-req-heading"
    >
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-xl shadow-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 id="new-req-heading" className="text-base font-semibold text-slate-900">
            新建研发需求并拆解 DAG
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭新建需求弹窗"
            className="p-1 text-slate-400 hover:text-slate-700 rounded"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {formError && (
            <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
              {formError}
            </div>
          )}

          <div>
            <label htmlFor="req-title" className="block text-xs font-medium text-slate-700 mb-1">
              需求标题
            </label>
            <input
              id="req-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：接入 SSO OIDC 回调幂等校验与审计日志"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="req-repo" className="block text-xs font-medium text-slate-700 mb-1">
                目标仓库 (Repo URL)
              </label>
              <input
                id="req-repo"
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>

            <div>
              <label htmlFor="req-branch" className="block text-xs font-medium text-slate-700 mb-1">
                基线分支 (Base Branch)
              </label>
              <input
                id="req-branch"
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="req-channel" className="block text-xs font-medium text-slate-700 mb-1">
                触发来源通道
              </label>
              <select
                id="req-channel"
                value={sourceChannel}
                onChange={(e) =>
                  setSourceChannel(e.target.value as 'web' | 'cli' | 'wecom' | 'feishu')
                }
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md text-slate-900 bg-white focus:outline-none focus:border-blue-600"
              >
                <option value="web">Web 控制台</option>
                <option value="wecom">企业微信机器人</option>
                <option value="feishu">飞书 IM 网关</option>
                <option value="cli">本地 SuperAgent CLI</option>
              </select>
            </div>

            <div>
              <label htmlFor="req-provider" className="block text-xs font-medium text-slate-700 mb-1">
                主执行 Agent CLI
              </label>
              <select
                id="req-provider"
                value={primaryProvider}
                onChange={(e) => setPrimaryProvider(e.target.value as AgentProvider)}
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md text-slate-900 bg-white focus:outline-none focus:border-blue-600"
              >
                <option value="codex">Codex CLI (Headless JSON)</option>
                <option value="claude-code">Claude Code (Stream JSON)</option>
                <option value="workbuddy">WorkBuddy (ACP 双向)</option>
                <option value="opencode">OpenCode (JSON / PTY)</option>
              </select>
            </div>
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">
              SOP 编排模板
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" role="radiogroup" aria-label="SOP 编排模板">
              {(
                [
                  {
                    id: 'feature_flow',
                    label: '标准 Feature 开发流',
                    desc: 'Plan Gate → 2 路并行 Builder → 交叉 Review（4 节点）',
                  },
                  {
                    id: 'bugfix_flow',
                    label: 'Bug 修复流',
                    desc: '复现定位 → 单 Worktree 修复与单测 → 回归审查（3 节点）',
                  },
                ] as const
              ).map((tpl) => {
                const active = sopTemplate === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSopTemplate(tpl.id)}
                    className={`text-left p-2.5 rounded-md border transition-colors ${
                      active
                        ? 'border-blue-600 bg-blue-50/70'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <p className="text-xs font-semibold text-slate-900">{tpl.label}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500 leading-snug">{tpl.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="req-spec" className="block text-xs font-medium text-slate-700 mb-1">
              需求规格与验收标准 (Spec Markdown)
            </label>
            <textarea
              id="req-spec"
              rows={4}
              value={specMd}
              onChange={(e) => setSpecMd(e.target.value)}
              placeholder="描述目标模块、验收标准与沙箱约束..."
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={mutating}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-50"
            >
              提交并生成 DAG
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
