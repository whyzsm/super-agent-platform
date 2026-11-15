# 状态持久化（当前无数据库）

> 本文件由模板 `database-guidelines.md` 重命名而来：项目没有 ORM、迁移或表结构，只有一份本地 JSON 状态文件，因此不保留 database 主题。

---

## 何时适用

任何读取 / 修改模块级 `state: PlatformState`、给 `PlatformState` 新增字段、或改动 `/api/reset` 的地方。

## 本地模式

- 唯一数据源：`server.ts:36` `STATE_FILE = path.resolve(process.cwd(), '.superagent-state.json')`。
- 读：`loadOrInitState()`（`server.ts:50`）用 `fs.existsSync` + `fs.readFileSync` 全量解析，仅当 `requirements` 与 `tasks` 都是数组才采用；否则回退 `createInitialSeedState()`（`src/data/seed.ts`）并 `saveState()`。
- 写：`saveState()`（`server.ts:67`）`fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))` **全量覆盖**，无增量、无事务、无并发控制、无版本号。
- 团队资产落盘：`syncTeamAiFileToDisk()`（`server.ts:38`）只在 `relPath.startsWith('.teamai/')` 时 `mkdirSync` + `writeFileSync` 写 `.teamai/skills/*.md`，仍静默忽略写失败。
- 所有端点共享模块级 `let state = loadOrInitState()`；改完状态后统一 `saveState(state)` 并 `broadcastEnvelope()`。

## 证据文件

| 文件 | 符号 / 行为 |
|------|-------------|
| `server.ts:36` | `STATE_FILE` 定义 |
| `server.ts:50 / :67 / :38` | `loadOrInitState` / `saveState` / `syncTeamAiFileToDisk` |
| `src/data/seed.ts` | `PlatformState` / `createInitialSeedState` |
| `.superagent-state.json` | 已提交的运行时快照 |
| `server.ts:1287` | `POST /api/reset` 重置为种子态 |

## 当前实现状态（演示态 / 反模式）

- `saveState()` 写失败已改为 `console.error` 向 `stderr` 输出明确错误（含错误 message），不抛错、不返回状态：客户端可能收到 `201` 但数据未落盘；`syncTeamAiFileToDisk()` 仍用 `try/catch` 静默忽略写失败。
- `.superagent-state.json` 含内部主机名（`mac-studio-sh-01`、`ubuntu-ci-runner-04`）与模拟 DAG / 门禁数据，且被提交进仓库。
- `syncedToGit` 在 `POST /api/requirements/:id/solidify-sop`、`POST /api/memories/:id/approve`、`PUT /api/teamai` 里被置 `true`，但**没有任何 git commit / MR**；它只表示写了本地 `.teamai/skills/*.md`。
- `src/components/TeamAiProtocolView.tsx` 的 `PGVECTOR_DDL` 只是 UI 展示字符串，不是真实建表。

## 常见错误

- 假设 `saveState()` 失败会抛异常打挂服务——它不会，已改为 `stderr` 显式告警，别依赖返回值判断持久化成功。
- 把 `syncedToGit: true` 当成"已推送远端"；当前无任何 git 操作。
- 给 `PlatformState` 加字段却漏改 `createInitialSeedState()`，`/api/reset` 后该字段丢失。
- 直接编辑 `.superagent-state.json` 期望热更新：`loadOrInitState()` 只在进程启动时读一次。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，14 个 `node:test` 用例全绿）。
