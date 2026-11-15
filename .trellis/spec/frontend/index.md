# 前端开发规范（React 19 演示原型）

> 前端是 Vite + React 19 + Tailwind 4 的单页控制面，用 zustand 管状态、`@xyflow/react` 画 DAG。全库规范统一用中文（guides 下两个英文 thinking guide 为历史文件，原样保留）。

---

## 何时适用

改动 `src/App.tsx`、`src/components/`、`src/stores/`、`src/utils/`、`src/index.css` 或 `src/main.tsx` 时，先读本目录规范。

## 当前实现状态（务必先读）

- 入口 `src/main.tsx`：`createRoot(...).render(<App />)`，`App` 是 `src/App.tsx` 的 **default export**。
- `src/App.tsx` 用 `useMemo` 派生 `selectedRequirement` / `reqTasks` / `selectedTask`，4 个 tab：`workbench` / `memory` / `teamai` / `daemons`；提示条带 `role="status"` 与 `aria-label`。
- 8 个组件全部是 `export function Xxx(...)` **命名导出** + `interface XxxProps`；项目**没有自定义 hooks**，故不保留 hook 主题。
- 两个 zustand store 直接 `fetch('/api/*')` / `EventSource('/api/stream')`，无 React Query / SWR。
- 展示用的枚举 → 文案 / Tailwind class 映射集中在 `src/utils/statusStyles.ts`。

## 文件导航

| 文件 | 主题 |
|------|------|
| [directory-structure.md](./directory-structure.md) | `src/` 布局与组件 / store 落点 |
| [component-guidelines.md](./component-guidelines.md) | 命名导出、Props、Tailwind、a11y、DagCanvas |
| [state-management.md](./state-management.md) | 两个 zustand store 与 `fetch` / SSE |
| [type-safety.md](./type-safety.md) | `src/protocol` 契约、非 strict、无运行时校验 |
| [quality-guidelines.md](./quality-guidelines.md) | 反模式、lint / 测试现状 |
| [presentation-maps.md](./presentation-maps.md) | `Record<Union, Meta>` 展示映射集中管理 |

## 证据文件

- `src/main.tsx`、`src/App.tsx:14`、8 个 `src/components/*.tsx`、`src/stores/*.ts`、`src/utils/statusStyles.ts`、`src/index.css`。

## 验证命令

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，136 个 `node:test` 用例全绿）。

## 常见错误

- 给组件写 `export default`（与既有命名导出不一致）；或在 `App.tsx` 里重复用 `useState` 存可由 `useMemo` 派生的选中态。
- 在组件内重复定义 `AgentProvider` / `TaskState` 等共享类型——真相见 [guides/shared-contracts.md](../guides/shared-contracts.md)。
