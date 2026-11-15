# 前端质量规范

> 前端质量基线是"一致的组件形态 + 集中展示映射 + 单一共享契约"，验证只靠 `tsc --noEmit`，没有 ESLint 规则文件或组件测试。

---

## 何时适用

提交前端改动前自检，尤其是新增组件、复制展示文案、或改动共享类型时。

## 本地模式（required patterns）

- 组件坚持 `export function Xxx` + `interface XxxProps` + 命名导出（`src/components/` 8 个文件一致）。
- 派生值用 `useMemo`（`src/App.tsx:59–71`），不要把可计算的状态再 `useState` 一份。
- 枚举 → 文案 / 配色统一走 `src/utils/statusStyles.ts` 的 `Record<Union, Meta>`，见 [presentation-maps.md](./presentation-maps.md)。
- 共享类型只从 `src/protocol/index.ts` 引入；装饰图标加 `aria-hidden`，状态提示加 `role="status"`。
- 副作用（fetch / SSE）只在 `src/stores/`，组件通过 action 触发，见 [state-management.md](./state-management.md)。

## 证据文件

- `src/App.tsx:84 / :95`（a11y）、`src/components/DagCanvas.tsx:43–56`（`aria-hidden`）、`src/utils/statusStyles.ts`（映射）、`src/protocol/index.ts`（契约）。

## 验证命令（只写真实存在的）

- `npm run lint` → `tsc --noEmit`；`npm test` → `node --import tsx --test "src/**/*.test.ts"`（14 个用例全绿）。`package.json` 仍没有 `typecheck` 脚本。
- `.teamai/hooks/pre-merge-gate.sh` 与 `.teamai/AGENTS.md` 要求 `pnpm lint && pnpm typecheck && pnpm test --run`，**与本仓库脚本仍不一致**，详见 [guides/team-assets.md](../guides/team-assets.md)。
- 4 个 `node:test` 测试都在 `src/engine|daemon|gateway|memory/`（后端 / 共享纯逻辑），前端没有任何测试；新增前端测试直接放进 `src/**/*.test.ts` 即可被 `npm test` 收集。

## 当前实现状态（诚实标注）

- `tsconfig.json` 未开 `strict`；`npm run lint` 通过不代表无类型漏洞，见 [type-safety.md](./type-safety.md)。
- 后端 `verifierChecks` 硬编码 `passed: true`，前端展示的"门禁全绿"不是真实校验结果。
- 无 ESLint / Prettier 配置、无 storybook、无可视化回归测试。

## 常见错误 / 禁止模式（真实反模式）

- 在 `src/components/TeamAiProtocolView.tsx` 的 `PROTOCOL_SPEC` 字符串里复制共享类型文本，却不同步 `src/protocol/index.ts` → 契约漂移。
- 在组件里硬编码「标准 Feature 开发流」等标签（`useWorkspaceStore.ts:152` 已有一处），而不复用 `SOP_TEMPLATE_LABELS`。
- 把 `.teamai` 门禁脚本里的 `pnpm ...` 当本仓库可用命令。
- 以演示态的"门禁通过"或"资产已写盘"为依据跳过 `npm run lint`；真实运行时默认开启，门禁结果必须来自真实退出码。
- 新建 `src/hooks/` 目录或写自定义 hook——项目无此模式（本文件由 `hook-guidelines.md` 重命名而来，主题已改为展示映射，见 [presentation-maps.md](./presentation-maps.md)）。
