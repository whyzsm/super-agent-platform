# 状态管理

> 全局状态只用两个 zustand store：一个管控制面数据与 `fetch` 变更，一个管 SSE 事件流。没有 React Query / SWR / Context。

---

## 何时适用

新增 action、改 loading / error / notice 反馈、或接入 `/api/stream` 事件时。

## 本地模式

- `src/stores/useWorkspaceStore.ts`：`create<WorkspaceStore>`（`:65`），持有 `activeTab: ActiveTab`（`:12`，联合类型 `'workbench' | 'memory' | 'teamai' | 'daemons'`）、`loading` / `mutating` / `error` / `notice`（`:23–26`）与约 20 个 action。
  - 读：`fetch('/api/bootstrap')`（`:97`）；写：`fetch('/api/requirements' | '/api/tasks/:id/advance' | ... , { method: 'POST' })`。
  - 错误统一 `throw new Error(body.error || \`HTTP ${res.status}\`)`（`:140`），catch 里 `set({ error: err.message, mutating: false })`。
  - 成功用 `notice` 中文提示（如 `:152`、`:170`），配合 `App.tsx` 的 `role="status"` 提示条。
- `src/stores/useAgentStreamStore.ts`：`startStream()`（`:18`）`new EventSource('/api/stream')`，`window.setInterval(..., 100)`（`:21`）每 100ms 批量 flush，`recentEnvelopes` 保留最近 40 条（`:27`，`.slice(0, 40)`）；`startStream()` **返回清理函数**，关闭 `flushTimer` 与 `EventSource`（`:52`）。
- 派生状态不下沉到 store：`App.tsx:59 / :64 / :69` 用 `useMemo` 由 store 原始数据算 `selectedRequirement` / `reqTasks` / `selectedTask`。
- 事件类型 `DaemonEnvelope` 来自 `src/protocol/index.ts`，store 不自行定义。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/stores/useWorkspaceStore.ts:12 / :65` | `ActiveTab` / `create<WorkspaceStore>` |
| `src/stores/useWorkspaceStore.ts:97 / :130` | `bootstrap` / `createRequirement` |
| `src/stores/useAgentStreamStore.ts:18 / :21 / :27 / :52` | SSE 启动 / 100ms flush / 40 条上限 / 清理 |
| `src/App.tsx:59–71` | `useMemo` 派生选中态 |

## 当前实现状态（演示态）

- 无缓存层、无乐观更新、无请求去重；每次 action 结束靠 SSE 广播回来的数据刷新。
- 前端把后端的 `{ error }`（见 [backend/error-handling.md](../backend/error-handling.md)）转成 `error` 字符串；后端 `saveState()` 写失败只在 `stderr` 告警、不改变响应码，前端仍可能显示成功 `notice`。
- `notice` 文案里硬编码了 SOP 名（`:152` 的「标准 Feature 开发流 / Bug 修复流」），与 `SOP_TEMPLATE_LABELS`（`src/utils/statusStyles.ts:76`）并存，存在重复。

## 常见错误

- 组件挂载 `EventSource` 却不调用 `startStream()` 返回的清理函数 → 定时器与连接泄漏。
- 把异步请求结果 `useState` 复制一份到组件里，而不是放进 store 或 `useMemo`。
- 新增 action 忘了同时设 `mutating` 与 `error` / `notice`，UI 反馈缺失。
- 把 store 逻辑复制进组件，使 `npm test` 无法覆盖；新增测试放在 `src/**/*.test.ts` 下即可被自动收集。

## 验证

`npm run lint`（`tsc --noEmit`）。
