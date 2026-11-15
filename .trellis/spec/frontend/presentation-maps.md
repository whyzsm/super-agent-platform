# 展示映射（枚举 → 文案 / 样式）

> 本文件由模板 `hook-guidelines.md` 重命名而来：项目**没有自定义 hooks**，但有一套明确的"展示映射集中管理"模式，故改为该主题，不保留任何 hook 内容。

---

## 何时适用

需要把 `TaskState` / `GateType` / `AgentProvider` / `TaskRole` / `SopTemplateId` 等枚举渲染成中文标签、颜色或图标时。

## 本地模式

- 唯一落点 `src/utils/statusStyles.ts`，5 个 `Record<Union, Meta>` 映射：
  - `TASK_STATE_META`（`:3`）：`Record<TaskState, { label; textClass; borderClass; bgClass }>`，覆盖 11 态（原 8 态 PENDING / RUNNING / VERIFYING / RETRY_WAIT / HUMAN_GATE / ESCALATED / MERGED / CANCELLED，加 S0-4 新增的 BLOCKED_BY_RESOURCE / QUARANTINED / WAITING_APPROVAL），值是 Tailwind class 字符串（如 `text-emerald-700` / `bg-emerald-50`）。`TaskState` 加值时此 Record 必须同步，否则 `npm run lint` 会因缺 key 失败。
  - `GATE_TYPE_LABELS`（`:57`）：`Record<GateType, string>`，PLAN_GATE / DANGER_GATE / MERGE_GATE → 中英混排标签。
  - `PROVIDER_LABELS`（`:63`）：`Record<AgentProvider, string>`（Codex CLI / WorkBuddy / Claude Code / OpenCode）。
  - `ROLE_LABELS`（`:70`）：`Record<TaskRole, string>`（Planner / Builder / Reviewer）。
  - `SOP_TEMPLATE_LABELS`（`:76`）：`Record<SopTemplateId, string>`（标准 Feature 开发流 / Bug 修复流）。
- 用 `Record<Union, ...>` 而非 `switch` / 字面量对象：新增枚举值时 `npm run lint`（`tsc --noEmit`）会因缺 key 直接报错，形成穷举性检查。
- 消费方：`src/components/DagCanvas.tsx` 按 `TaskState` 取 `TASK_STATE_META` 的 `textClass` / `borderClass` / `bgClass` 拼接节点样式，并按状态选 lucide 图标（`:43–56`，均带 `aria-hidden="true"`）。
- 类型键从 `import type { ... } from '../protocol'` 引入（`statusStyles.ts:1`），映射文件不自行定义枚举。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `src/utils/statusStyles.ts:3 / :57 / :63 / :70 / :76` | 5 个 `Record` 映射 |
| `src/protocol/index.ts:1–19` | 被映射的 5 个联合类型 |
| `src/components/DagCanvas.tsx:43 / :60` | 状态 → 图标 / 样式拼接 |
| `src/index.css` | Tailwind 4 `@theme` 与 `.react-flow__*` 覆盖 |

## 当前实现状态（诚实标注）

- 映射值是中文文案 + Tailwind class，属于"展示层"，不含业务逻辑；`src/components/TeamAiProtocolView.tsx` 的 `PROTOCOL_SPEC` / `PGVECTOR_DDL` 也是展示用字符串，不是可执行契约或真实 DDL。
- 尚无 `ASSET_TYPE_LABELS` / `SCOPE_LABELS` / `MEMORY_STATUS_LABELS` 等映射；`MemoryAsset` 的 5 种 `assetType`、4 级 `scope`、3 种 `status` 在 UI 中按需硬编码。
- 已知重复：`src/stores/useWorkspaceStore.ts:152` 的 `notice` 直接写「标准 Feature 开发流 / Bug 修复流」，未复用 `SOP_TEMPLATE_LABELS`。

## 常见错误

- 在组件里手写 `taskState === 'MERGED' ? '已合入' : ...` 或内联 Tailwind 状态色 → 与集中映射漂移。
- 给 `TaskState` 加新值却漏改 `TASK_STATE_META`；依赖编译报错来发现，不要靠运行时兜底。
- 在 `statusStyles.ts` 里重新声明 `TaskState` 等类型；应始终从 `src/protocol/index.ts` 引入。
- 误以为这里有自定义 hook 可复用（文件原名 `hook-guidelines.md` 的残留印象）；项目无 `src/hooks/`。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，136 个 `node:test` 用例全绿）。
