import type { ActiveTab } from '../stores/useWorkspaceStore';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenNewRequirement: () => void;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'workbench', label: '工作台' },
  { id: 'memory', label: '记忆与 Skill' },
  { id: 'teamai', label: '规范与协议' },
  { id: 'daemons', label: '执行节点' },
];

export function TopBar({
  activeTab,
  onSelectTab,
  onOpenNewRequirement,
}: TopBarProps) {
  return (
    <header className="h-14 shrink-0 bg-white border-b border-slate-200 px-4 md:px-6 flex items-center justify-between gap-4 md:gap-8">
      <a
        href="#workbench"
        onClick={(e) => {
          e.preventDefault();
          onSelectTab('workbench');
        }}
        className="text-base md:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
      >
        SuperAgent
      </a>

      <nav aria-label="主导航" className="flex items-center gap-4 md:gap-6 overflow-x-auto no-scrollbar">
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`py-4 text-xs md:text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                active
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="shrink-0">
        <button
          type="button"
          onClick={onOpenNewRequirement}
          className="px-3 md:px-4 py-1.5 md:py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          + 新建需求
        </button>
      </div>
    </header>
  );
}
