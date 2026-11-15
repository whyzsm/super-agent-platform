import type { Express } from 'express';
import { computeMaxDuplicateScore, recallMemoryAssets } from '../memory/recallEngine';
import { handleMcpMessage, MCP_PROTOCOL_VERSION } from '../mcp/server';
import type { McpContext, ProposeMemoryInput, ProposeMemoryOutcome } from '../mcp/server';
import type { RecallCaller } from '../mcp/server';
import type { MemoryAsset } from '../protocol';
import type { ServerContext } from './context';

/**
 * 记忆 / TeamAI / MCP 域路由。
 *
 * mcpContext 是惰性闭包：必须每次实时读 `state.current`，
 * 这样 `POST /api/reset` 替换状态后 MCP 工具立即看到新状态。
 */
export function registerMemoryRoutes(app: Express, ctx: ServerContext): void {
  const { state, saveState, syncTeamAiFileToDisk, auditLog } = ctx;

  // ---- MCP（Model Context Protocol）标准端点 ----
  // JSON-RPC 2.0：initialize / tools/list / tools/call / ping。
  // mcpContext 是惰性闭包：必须每次实时读 state.current，reset 后立即看到新状态。
  const mcpContext: McpContext = {
    recall: (query, caller, limit) => recallMemoryAssets(state.current.memories, query, caller, limit),
    getTask: (id) => state.current.tasks.find((t) => t.id === id),
    listTasks: () => state.current.tasks,
    countDrafts: () => state.current.memories.filter((m) => m.status === 'draft').length,
    // 写侧落地（S2-5）：只产出 draft；发布仍走 POST /api/memories/:id/approve（memory:approve 人审）。
    proposeMemory: (input: ProposeMemoryInput, caller: RecallCaller): ProposeMemoryOutcome => {
      const asset: MemoryAsset = {
        id: `mem-mcp-${Date.now()}`,
        teamId: caller.teamId,
        ownerId: caller.userId ?? caller.agentId ?? 'mcp-caller',
        assetType: input.assetType,
        scope: input.scope,
        status: 'draft',
        title: input.title,
        contentMd: input.contentMd,
        sourceReason: input.sourceReason ?? 'MCP propose_memory 提交（待人审）',
        duplicateScore: computeMaxDuplicateScore(input.contentMd, state.current.memories),
        version: 0,
        createdAt: new Date().toISOString(),
        acl: [
          {
            assetId: '',
            subjectType: 'team',
            subjectId: caller.teamId,
            permission: 'read',
          },
        ],
      };
      asset.acl[0].assetId = asset.id;
      state.current.memories.unshift(asset);
      saveState(state.current);
      // 写侧动作单独记审计：MCP 入口按只读登记，这里补一条 memory:propose 的 applied 事实。
      auditLog.record({
        userId: caller.userId ?? caller.agentId ?? 'mcp-caller',
        teamId: caller.teamId,
        action: 'memory:propose',
        target: asset.id,
        outcome: 'applied',
        detail: `title=${input.title.slice(0, 80)}`,
      });
      return { ok: true, asset };
    },
  };

  app.post('/api/mcp', (req, res) => {
    // 每请求注入主体：propose_memory 等写侧工具据此做权限校验（工具层，非路由层）。
    const principal = res.locals.principal as McpContext['principal'];
    const result = handleMcpMessage(req.body, { ...mcpContext, principal });
    // 纯通知（如 notifications/initialized）按 JSON-RPC 规范回 202 无内容。
    if (result === null) {
      res.status(202).end();
      return;
    }
    res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
    res.json(result);
  });

  app.get('/api/mcp', (_req, res) => {
    // Streamable HTTP 的 GET 用于服务端主动推送；本服务无服务端推送通道，按规范回 405。
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: '本服务仅支持 POST /api/mcp（无服务端推送通道）' });
  });

  // 兼容旧调用方：普通 HTTP 召回接口保留，但不再是 MCP 协议入口（见上方 /api/mcp）。
  app.post('/api/mcp/recall', (req, res) => {
    const { query, caller, limit } = req.body as {
      query?: string;
      caller?: {
        teamId?: string;
        projectId?: string;
        userId?: string;
        agentId?: string;
      };
      limit?: number;
    };

    const q = (query || '').trim();
    if (!q) {
      res.status(400).json({ error: 'MCP 召回查询词不能为空' });
      return;
    }

    const callerCtx = {
      teamId: caller?.teamId || 'team-platform-core',
      projectId: caller?.projectId,
      userId: caller?.userId,
      agentId: caller?.agentId,
    };

    const results = recallMemoryAssets(state.current.memories, q, callerCtx, limit ?? 6);
    const excludedDraftsCount = state.current.memories.filter((m) => m.status === 'draft').length;

    res.json({
      tool: 'superagent_memory_recall',
      caller: callerCtx,
      results,
      excludedDraftsCount,
    });
  });

  app.post('/api/memories/:id/approve', (req, res) => {
    const asset = state.current.memories.find((m) => m.id === req.params.id);
    if (!asset) {
      res.status(404).json({ error: '记忆资产不存在' });
      return;
    }
    asset.status = 'published';
    asset.version += 1;

    const slug = asset.id.replace(/[^a-z0-9-]/gi, '-');
    const gitPath = `.teamai/skills/${slug}.md`;
    const existing = state.current.teamAiAssets.find((a) => a.path === gitPath);
    if (existing) {
      existing.content = asset.contentMd;
      existing.updatedAt = new Date().toISOString();
      existing.syncedToGit = false;
    } else {
      state.current.teamAiAssets.push({
        path: gitPath,
        category: 'skill',
        title: asset.title,
        content: asset.contentMd,
        updatedAt: new Date().toISOString(),
        syncedToGit: false,
      });
    }

    syncTeamAiFileToDisk(gitPath, asset.contentMd);
    saveState(state.current);
    res.json({ asset, teamAiAssets: state.current.teamAiAssets });
  });

  app.post('/api/memories/:id/reject', (req, res) => {
    const asset = state.current.memories.find((m) => m.id === req.params.id);
    if (!asset) {
      res.status(404).json({ error: '记忆资产不存在' });
      return;
    }
    asset.status = 'archived';
    saveState(state.current);
    res.json({ asset });
  });

  app.put('/api/teamai', (req, res) => {
    const { assetPath, content } = req.body as { assetPath?: string; content?: string };
    const found = state.current.teamAiAssets.find((a) => a.path === assetPath);
    if (!found || typeof content !== 'string') {
      res.status(400).json({ error: '未找到对应的 .teamai 规范文件' });
      return;
    }
    found.content = content;
    found.updatedAt = new Date().toISOString();
    found.syncedToGit = false;
    syncTeamAiFileToDisk(found.path, found.content);
    saveState(state.current);
    res.json({ asset: found });
  });
}
