import express, { type Response } from 'express';
import type { DaemonEnvelope } from '../protocol';
import { createRbacMiddleware } from './middleware';
import type { ServerContext } from './context';
import { registerTaskRoutes } from './tasks';
import { registerRequirementRoutes } from './requirements';
import { registerMemoryRoutes } from './memory';
import { registerWebhookRoutes } from './webhooks';
import { registerRuntimeRoutes } from './runtime';
import { registerWorkspaceRoutes } from './workspace';

/**
 * 组装 Express 应用：JSON 解析 → RBAC/审计/幂等中间件 → 各域路由 → 错误边界。
 *
 * 不在此处 listen、不挂 vite/static——那些是 server.ts（启动引导）的职责，
 * 这样 HTTP 层测试可以只导入 createApp + 临时目录 context 完整驱动路由。
 */
export function createApp(ctx: ServerContext): express.Express {
  const { state, seq, sseClients, broadcastEnvelope } = ctx;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(createRbacMiddleware(ctx));

  registerTaskRoutes(app, ctx);
  registerRequirementRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);

  // ---- 系统路由 ----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, seq: seq.current, requirements: state.current.requirements.length });
  });

  app.get('/api/bootstrap', (_req, res) => {
    res.json(state.current);
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    const hb: DaemonEnvelope = {
      machineId: 'mac-studio-sh-01',
      seq: ++seq.current,
      ts: Date.now(),
      payload: {
        type: 'HEARTBEAT',
        activeTaskIds: state.current.tasks
          .filter((t) => t.state === 'RUNNING' || t.state === 'VERIFYING')
          .map((t) => t.id),
        cpuLoad: 39.2,
      },
    };
    res.write(`data: ${JSON.stringify(hb)}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.post('/api/reset', (_req, res) => {
    res.json(ctx.resetState());
  });

  // JSON-RPC 错误边界：express.json() 解析失败时默认抛 SyntaxError 并返回 HTML 错误页，
  // 这对 MCP 客户端是协议违规（它期待 JSON-RPC 帧）。此处把 /api/mcp 的解析失败
  // 转成标准 -32700 响应，其余路径仍走默认处理。
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: Response,
      next: express.NextFunction,
    ) => {
      const isBodyParseError =
        err instanceof SyntaxError && typeof err === 'object' && err !== null && 'body' in err;
      if (isBodyParseError && req.path.startsWith('/api/mcp')) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: 报文不是合法 JSON' },
        });
        return;
      }
      next(err);
    },
  );

  return app;
}
