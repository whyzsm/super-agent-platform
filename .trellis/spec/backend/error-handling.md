# 错误处理

> 后端用极简约定：端点返回统一 `{ error: string }` + HTTP 状态码；多处 `try/catch` 静默吞掉异常（`saveState()` 已改为 `console.error` 显式告警），没有自定义错误类型或日志框架。

---

## 何时适用

新增或修改 `server.ts` 端点、校验请求体、处理第三方回调验签时。

## 本地模式

- 客户端错误统一为 `res.status(4xx).json({ error: '中文提示' })`：
  - `400` 参数 / 业务校验失败，如 `server.ts:203`「需求标题与需求规格说明书不能为空」、`:808`「NDJSON 行内容不能为空」。
  - `401` IM 验签失败（`server.ts:1104`，`{ error: verified.error || 'IM Webhook 验签失败' }`）。
  - `404` 目标不存在，如 `server.ts:498`「任务节点不存在」、`:1205`「记忆资产不存在」、`:1065`「任务或关联需求不存在」。
- `201` 用于创建成功并返回实体（`server.ts:492` `{ requirement, tasks }`、`:1056` `{ lineComment, task }`）。
- 没有自定义 `Error` 子类、没有错误码枚举、没有集中式 error middleware；每个 handler 自己判空并 `return`。
- 验签逻辑返回判别式结果对象而非抛异常：`verifyImWebhookPayload()`（`src/gateway/imWebhook.ts:20`）返回 `{ valid, error? }`，错误字符串以 `ReplayWindowError:` 开头。

## 证据文件

| 位置 | 行为 |
|------|------|
| `server.ts:203 / :808 / :888 / :1043 / :1180 / :1249` | 各类 `400` 校验 |
| `server.ts:498 / :618 / :668 / :712 / :802 / :922 / :1205` | 各类 `404` |
| `server.ts:1102 / :1104` | IM 验签 `401` |
| `src/gateway/imWebhook.ts:20 / :39 / :46` | `verifyImWebhookPayload` / 重放窗口 / `timingSafeEqual` |

## 当前实现状态（演示态 / 反模式）

- `saveState()`（`server.ts:67`）与 `syncTeamAiFileToDisk()`（`:38`）的 `catch {}` 只留注释、不记录、不重抛：写盘失败对调用方完全不可见。
- `loadOrInitState()`（`:50`）解析失败静默回退种子态，损坏的状态文件不会告警。
- `broadcastEnvelope()`（`:79`）单个 SSE 客户端写失败时仅从 `Set` 删除该连接。
- `IM_WEBHOOK_SECRET`（`server.ts:46`）只从 `process.env` 注入、无默认回退；缺失时两个 IM webhook 端点返回 `503 { error: 'IM_WEBHOOK_SECRET is not configured' }`，启动时打印一次性告警。
- 前端配套做法见 [frontend/state-management.md](../frontend/state-management.md)：store 把 `body.error || HTTP ${res.status}` 转成 `error` 字段。

## 常见错误

- 新增端点时返回裸字符串或不带 `error` 键的对象，前端 `useWorkspaceStore` 读 `body.error` 会拿到 `undefined`。
- 复制 `catch {}` 静默吞异常的写法到新代码；至少应在边界处让失败可观测。
- 误以为有结构化日志或错误上报中间件；项目只有 `console.log` 形式的调度器打印（如 `server.ts:128`）。

## 验证

`npm run lint`（`tsc --noEmit`）与 `npm test`（`node --import tsx --test`，136 个 `node:test` 用例全绿）。
