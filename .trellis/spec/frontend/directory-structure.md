# 前端目录结构

> 前端全部在 `src/` 下按"入口 / 组件 / store / 工具 / 共享契约 / 领域纯逻辑 / 样式"平铺，没有按 feature 分目录。

---

## 何时适用

新增组件、store action、样式或展示映射时，决定文件放在哪个 `src/` 子目录。

## 目录布局（真实）

```
src/
├── main.tsx                 # createRoot + import App from './App.tsx' + './index.css'
├── App.tsx                  # default export，4 个 tab + useMemo 派生
├── index.css                # @import tailwindcss / @xyflow 样式 + @theme + @layer base
├── components/              # 8 个视图组件，全部命名导出
│   ├── TopBar.tsx  LeftQueuePane.tsx  DagCanvas.tsx  NodeInspectorPane.tsx
│   └── NewRequirementModal.tsx  MemoryHubView.tsx  TeamAiProtocolView.tsx  DaemonsView.tsx
├── stores/
│   ├── useWorkspaceStore.ts     # 主状态 + fetch('/api/*') + ~20 action
│   └── useAgentStreamStore.ts   # EventSource('/api/stream') + 批量 flush
├── utils/statusStyles.ts    # TASK_STATE_META 等展示映射
├── protocol/index.ts        # 前后端唯一共享契约（非前端私有）
├── data/seed.ts  engine/  daemon/  gateway/  memory/   # 后端 / 共享纯逻辑
└── *.test.ts                # 与被测模块同目录并列
```

## 本地模式

- **视图组件**放 `src/components/`，文件名 PascalCase 与导出函数同名（`DagCanvas.tsx` → `export function DagCanvas`）。
- **全局状态**放 `src/stores/`，`useXxxStore` 命名，用 `create` from `zustand`。
- **展示映射**（枚举 → 中文标签 / Tailwind class）放 `src/utils/statusStyles.ts`，不要在组件里散落 `switch` 或字面量。
- **共享类型**只在 `src/protocol/index.ts`；前端用相对路径 `../protocol` 引入，`@/*` 别名虽在 `tsconfig.json` 配置但项目未普遍使用。
- 样式：`src/index.css` 顶部 `@import "tailwindcss"` + `@import "@xyflow/react/dist/style.css"`，`@theme` 定义 `--font-sans` / `--font-mono`，`@layer base` 设全局高度与字体，并覆盖 `.react-flow__*` 类名。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/main.tsx:1` | `createRoot` 挂载 |
| `src/App.tsx:14` | `export default function App` |
| `src/components/DagCanvas.tsx:130` | `export function DagCanvas` |
| `src/stores/useWorkspaceStore.ts:65` | `create<WorkspaceStore>` |
| `src/utils/statusStyles.ts:3` | `TASK_STATE_META` |

## 当前实现状态（演示态）

无路由库（`react-router` 不在依赖里），tab 切换靠 `ActiveTab` 联合类型 + `activeTab` 状态（`src/stores/useWorkspaceStore.ts:12`）；无 CSS Modules / styled-components；无组件级 `index.ts` barrel。

## 常见错误

- 新建一个 `src/hooks/` 目录——项目没有任何自定义 hook，状态与派生逻辑都在 store 或 `App.tsx` 的 `useMemo`。
- 把共享枚举类型写进 `components/` 或 `stores/`；应放 `src/protocol/index.ts`。
- 在组件里手写 Tailwind 状态色而不用 `TASK_STATE_META`，造成标签与配色不一致。
