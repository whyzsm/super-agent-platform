import type { NextFunction, Request, RequestHandler, Response as ExpressResponse } from 'express';
import type { Principal } from '../identity/types';
import { isAllowed } from '../identity/rbac';
import { actionFor } from '../policy/routeActions';
import type { ServerContext } from './context';

/**
 * 本地身份 / RBAC / 不可变审计 / 幂等命令 前置中间件。
 *
 * dev adapter：loopback 且未携带身份头时注入本地管理员，保证开箱可用；
 * 非 loopback 且无身份头 → 匿名 viewer，写操作一律 403。生产换 OIDC adapter 即可。
 */
export function createRbacMiddleware(ctx: ServerContext): RequestHandler {
  const { identityProvider, auditLog, store } = ctx;
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    const url = req.path;
    if (!url.startsWith('/api/')) return next();
    const action = actionFor(req.method, url);
    if (action === 'exempt') return next();

    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    if (action === null) {
      // 写操作未登记动作 → fail-closed，避免新增端点默认继承过宽的权限。
      const denied = identityProvider.resolve(headers);
      auditLog.record({
        userId: denied.userId,
        teamId: denied.teamId,
        action: 'read',
        target: `${req.method} ${url}`,
        outcome: 'denied',
        detail: 'unclassified write route',
      });
      res.status(403).json({
        error: `Forbidden: 路由未登记动作，拒绝执行 ${req.method} ${url}`,
      });
      return;
    }

    const hasIdentity = Object.keys(headers).some((k) => k.startsWith('x-superagent-'));
    const remote = req.socket.remoteAddress ?? '';
    const loopback =
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!hasIdentity && loopback) {
      headers['x-superagent-user'] = process.env.SUPERAGENT_DEV_USER ?? 'local-dev';
      headers['x-superagent-team'] = process.env.SUPERAGENT_DEV_TEAM ?? 'team-local';
      headers['x-superagent-roles'] = process.env.SUPERAGENT_DEV_ROLES ?? 'admin';
    }
    const principal: Principal = identityProvider.resolve(headers);
    const allowed = isAllowed(principal, action);
    auditLog.record({
      userId: principal.userId,
      teamId: principal.teamId,
      action,
      target: `${req.method} ${url}`,
      outcome: allowed ? 'allowed' : 'denied',
    });
    if (!allowed) {
      res.status(403).json({ error: `Forbidden: ${principal.userId} 无权执行 ${action}` });
      return;
    }
    // 可选 commandId：重复命令直接 409，保证重放不二次写状态。
    const body = req.body as { commandId?: unknown } | undefined;
    if (req.method !== 'GET' && typeof body?.commandId === 'string' && body.commandId.trim()) {
      const outcome = store.appendCommand(body.commandId, `${req.method} ${url}`, {
        method: req.method,
        url,
        userId: principal.userId,
      });
      if (outcome.duplicate) {
        res.status(409).json({ error: `重复命令 ${body.commandId} 已执行，拒绝二次写入` });
        return;
      }
    }
    res.locals.principal = principal;
    next();
  };
}
