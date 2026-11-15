// 必须先于任何模块顶层 process.env 读取执行：ESM import 提升保证 .env 先于下面
// 的 IM_WEBHOOK_SECRET / SUPERAGENT_* 读取生效。.env 不存在时 dotenv 静默跳过。
import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServerContext } from './src/server/context';
import { createPostgresStateStore } from './src/store/postgresStateStore';
import type { StateStore } from './src/store/types';
import { createOidcIdentityProvider } from './src/identity/oidcProvider';
import type { IdentityProvider } from './src/identity/types';
import { createApp } from './src/server/app';

/**
 * 启动引导：装配上下文与 Express 应用，挂 vite（开发）或静态资源（生产）并监听。
 * 全部路由与中间件在 src/server/ 下按域拆分（S1-1）：
 *   app.ts 装配 · middleware.ts RBAC/审计/幂等 · context.ts 共享状态与端口实例
 *   tasks / requirements / memory / webhooks / runtime / workspace 各域路由
 */
const PORT = 3000;

async function startServer() {
  // S1-2：设置 SUPERAGENT_PG_CMD 即把 StateStore 换成 Postgres
  // （psql 调用前缀，whitespace 切分；如 'docker exec -i superagent-pg psql -U superagent -d superagent'）。
  // 缺省维持本地文件实现，两种后端零行为差异（同一 StateStore 契约）。
  let stateStore: StateStore | undefined;
  const pgCmd = process.env.SUPERAGENT_PG_CMD?.trim();
  if (pgCmd) {
    const pgStore = createPostgresStateStore({ command: pgCmd.split(/\s+/) });
    pgStore.init();
    stateStore = pgStore;
    console.log('[SuperAgent] StateStore = Postgres (SUPERAGENT_PG_CMD 已配置)');
  }
  // S2-1：设置 SUPERAGENT_OIDC_ISSUER 即把 IdentityProvider 换成 OIDC（RS256 JWT 验签）。
  // 注意：OIDC 模式下没有 loopback dev 注入，不带 Bearer 的本地请求是匿名 viewer（写操作 403）。
  const oidcIssuer = process.env.SUPERAGENT_OIDC_ISSUER?.trim();
  let identityProvider: IdentityProvider | undefined;
  if (oidcIssuer) {
    const oidc = createOidcIdentityProvider({ issuer: oidcIssuer });
    await oidc.warmup();
    identityProvider = oidc;
    console.log(`[SuperAgent] IdentityProvider = OIDC (${oidcIssuer})`);
  }
  const ctx = createServerContext({
    ...(stateStore ? { stateStore } : {}),
    ...(identityProvider ? { identityProvider } : {}),
  });

  if (!ctx.imWebhookSecret) {
    console.warn(
      '[SuperAgent] IM_WEBHOOK_SECRET is not configured; IM webhook endpoints will return 503.',
    );
  }

  const app = createApp(ctx);

  // Periodic realistic heartbeat broadcast
  const timer = setInterval(() => {
    if (ctx.sseClients.size === 0) return;
    const activeIds = ctx.state.current.tasks
      .filter((t) => t.state === 'RUNNING' || t.state === 'VERIFYING')
      .map((t) => t.id);
    ctx.broadcastEnvelope({
      machineId: 'mac-studio-sh-01',
      seq: ++ctx.seq.current,
      ts: Date.now(),
      payload: {
        type: 'HEARTBEAT',
        activeTaskIds: activeIds,
        cpuLoad: Number((35 + Math.random() * 12).toFixed(1)),
      },
    });
  }, 8000);
  timer.unref?.();

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SuperAgent control plane listening on http://localhost:${PORT}`);
  });
}

void startServer();
