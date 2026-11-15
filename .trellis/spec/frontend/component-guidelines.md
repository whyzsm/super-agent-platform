# 组件规范

> 8 个组件形态高度一致：命名导出的函数组件 + 同名 `interface XxxProps` + props 驱动 + Tailwind 拼接 + 少量 a11y 属性。

---

## 何时适用

新增 / 修改 `src/components/*.tsx` 或 `src/App.tsx` 的视图层时。

## 本地模式

- **导出形式**：`export function Xxx(props: XxxProps) { ... }` 命名导出 + 局部 `interface XxxProps`（不导出）。唯一例外是 `src/App.tsx:14` 的 `export default function App`，由 `src/main.tsx` 以 `import App from './App.tsx'` 引入。
- **Props 命名**：`DaemonsViewProps` / `DagCanvasProps` / `LeftQueuePaneProps` / `MemoryHubViewProps` / `NewRequirementModalProps` / `NodeInspectorPaneProps` / `TeamAiProtocolViewProps` / `TopBarProps`，全部用 `interface` 声明（见各文件头部）。
- **组合方式**：`App.tsx` 按 `activeTab` 条件渲染四大视图，把 `selectedRequirement` / `reqTasks` / `selectedTask` 等派生值作为 props 下发；组件本身不直接 `fetch`。
- **样式**：Tailwind 4 原子类，按状态用模板字符串拼接 class（如 `DagCanvas.tsx` 里按 `TaskState` 取 `TASK_STATE_META` 的 `textClass` / `borderClass` / `bgClass`）。全局覆盖写在 `src/index.css` 的 `.react-flow__*` 规则。
- **DagCanvas**：`src/components/DagCanvas.tsx` 用 `@xyflow/react` 的 `ReactFlow` / `Background` / `Controls` / `MiniMap` / `Handle` / `Position` / `MarkerType`，自定义节点 `nodeTypes`，节点签名为 `NodeProps<Node<TaskNodeData>>`（`:60`）。
- **可访问性**：提示条带 `role="status"`（`App.tsx:84`）与 `aria-label="关闭提示"`（`:95`）；纯装饰图标加 `aria-hidden="true"`（`DagCanvas.tsx:43–56`、`:95` 等）。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/main.tsx` | `createRoot` + default `App` |
| `src/App.tsx:59 / :64 / :69` | `useMemo` 派生三份选中态 |
| `src/components/DagCanvas.tsx:60 / :115` | `TaskDagNode` / `nodeTypes` |
| `src/components/*.tsx` 头部 | 8 个 `interface XxxProps` |
| `src/index.css` | `@theme` / `@layer base` / `.react-flow__*` |

## 当前实现状态（诚实标注）

- 无自定义 hooks、无 `React.memo`、无 ErrorBoundary、无组件测试。
- `src/components/TeamAiProtocolView.tsx` 内 `PROTOCOL_SPEC`（`:11`）是一段**展示用模板字符串**，把 `src/protocol/index.ts` 的若干类型文本复制进 UI；它不是编译期类型，但改动契约时极易漏同步，见 [guides/shared-contracts.md](../guides/shared-contracts.md)。

## 常见错误

- 给新组件写 `export default` 或把 Props 写成 `type` 别名——与 8 个既有组件不一致。
- 在组件内 `useEffect` 里自己 `fetch('/api/...')`；应通过 `useWorkspaceStore` 的 action。
- 给图标漏 `aria-hidden`、或给提示条漏 `role="status"`，破坏既有 a11y 约定。
- 把状态色 / 标签硬编码在组件里，而不复用 `statusStyles.ts`。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，136 个 `node:test` 用例全绿）。
