# 通用规范导航

> 本目录放跨前后端都适用的约定与两份思考指南。全库规范统一用中文；`code-reuse-thinking-guide.md` 与 `cross-layer-thinking-guide.md` 是英文历史文件，按要求原样保留。

---

## 文件导航（与最终文件集一一对应）

| 文件 | 主题 | 何时读 |
|------|------|--------|
| [shared-contracts.md](./shared-contracts.md) | `src/protocol` 单一契约、类型重复反模式、枚举 / 标签映射 | 新增或修改跨层类型、枚举、事件字段时 |
| [team-assets.md](./team-assets.md) | `.teamai` 四类资产、frontmatter 约定、门禁与工程实际的不一致、讨论稿与现状的区别 | 改团队资产、理解门禁或分辨"目标 vs 现状"时 |
| [code-reuse-thinking-guide.md](./code-reuse-thinking-guide.md) | 识别重复模式、减少复制（英文，原样保留） | 发现相似代码 / 新加常量或工具函数时 |
| [cross-layer-thinking-guide.md](./cross-layer-thinking-guide.md) | 思考跨层数据流（英文，原样保留） | 功能跨越 3+ 层、改动数据格式或事件契约时 |

---

## 快速参考：什么时候该停下来想一想

### 跨层问题（→ 读 cross-layer-thinking-guide）

- 功能触及 3+ 层（端点 / 纯逻辑 / store / 组件）。
- 数据在层间换了格式，或多个消费方读同一份数据。
- 正在加事件 kind、NDJSON 记录、RPC payload、config 字段。
- UI / 命令代码开始对原始 payload 字段做本地类型断言。

### 代码复用（→ 读 code-reuse-thinking-guide）

- 写出与既有代码雷同的逻辑，或同一模式出现 3 次以上。
- 正在改任何常量 / 配置、或准备新建工具函数 —— **先搜索**。
- 两个文件各自对同一个未类型化的 payload 字段做本地转换。

### 共享契约（→ 读 shared-contracts.md）

- 想在一个组件或 store 里 `export type` 一个前端也要用的类型。
- 给 `TaskState` / `GateType` 等联合类型加值，需要同步展示映射。

---

## 修改前规则（务必遵守）

> 改动任何值、常量或类型前，先全局搜索它在哪些文件被引用。

```bash
grep -r "要改的值或符号" src server.ts
```

这条习惯能避免"改了 A 忘了 B"。本仓库尤其重要：`src/protocol/index.ts` 的契约会被 `src/components/TeamAiProtocolView.tsx:11` 的展示字符串复制、被 `src/utils/statusStyles.ts` 的 `Record` 映射穷举、被 4 个 `*.test.ts` 断言。

---

## 验证 AI 交叉审查结论

审查意见声称"输入可能是恶意的""缺少校验""行为被改变"时，先对照真实数据源与代码注释再决定是否采纳；每条 CRITICAL / WARNING 都要在代码里核实。演示态原型里很多"看起来像 bug"的写法（硬编码 `passed: true`、静默吞异常、`syncedToGit` 无 git 操作）是有意的现状，见各层 spec 的「当前实现状态」。

---

## 验证命令

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，136 个 `node:test` 用例全绿）。
