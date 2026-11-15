import type { Express } from 'express';
import { appendRuntimeEvent, lastEventSeq, replayRuntimeEvents } from '../runtime/eventLog';
import { createHeadlessJsonAdapter } from '../runtime/adapters/headlessJson';
import { isRealRuntimeEnabled } from '../runtime/realRuntime';
import type { AgentReasoningEvent } from '../protocol';
import type { ServerContext } from './context';

/**
 * 真实运行时域路由：受控 real-spawn、旁路事件/审计/命令日志查询、daemon 重放。
 * real-spawn 强制要求显式 SUPERAGENT_CLI_COMMAND，不会默认发起模型调用。
 */
export function registerRuntimeRoutes(app: Express, ctx: ServerContext): void {
  const { state, seq, saveState, broadcastEnvelope, repoRoot, auditLog, store } = ctx;

  // 真实运行时受控端点：默认关闭，且必须显式配置 CLI 命令，避免误触发模型调用。
  app.post('/api/tasks/:id/real-spawn', (req, res) => {
    if (!isRealRuntimeEnabled()) {
      res.status(404).json({ error: '真实运行时未启用' });
      return;
    }
    if (!process.env.SUPERAGENT_CLI_COMMAND) {
      res.status(400).json({
        error: '未配置 SUPERAGENT_CLI_COMMAND，拒绝默认发起模型调用',
      });
      return;
    }
    const task = state.current.tasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: '任务节点不存在' });
      return;
    }

    const adapter = createHeadlessJsonAdapter({ provider: task.provider });
    const traceId = `spawn-${task.id}-${Date.now()}`;
    let received = 0;
    appendRuntimeEvent({
      traceId,
      type: 'SPAWN',
      taskId: task.id,
      detail: `command=${process.env.SUPERAGENT_CLI_COMMAND}`,
    });

    adapter.onEvent((event) => {
      received += 1;
      appendRuntimeEvent({
        traceId,
        type: 'AGENT_EVENT',
        taskId: task.id,
        detail: JSON.stringify(event).slice(0, 500),
      });
      const normalized: AgentReasoningEvent = {
        id: `ev-real-${Date.now()}-${received}`,
        ts: new Date().toTimeString().slice(0, 8),
        seq: ++seq.current,
        kind: 'thought',
        title: `[real-cli] ${event.type}`,
        detail: JSON.stringify(event).slice(0, 400),
        status:
          event.type === 'completed'
            ? event.exitCode === 0
              ? 'ok'
              : 'failed'
            : 'running',
      };
      task.events.push(normalized);
      task.terminalLines.push(`[real-cli] ${normalized.detail}`);
      broadcastEnvelope({
        machineId: task.assignedMachine || 'mac-studio-sh-01',
        seq: seq.current,
        ts: Date.now(),
        payload: { type: 'AGENT_EVENT', taskId: task.id, event: normalized },
      });
    });

    const prompt =
      (req.body as { prompt?: string })?.prompt?.trim() ||
      `只读说明当前任务：${task.title}`;

    void adapter
      .spawn({
        taskId: task.id,
        // 垂直切片不建 worktree，统一在仓库根执行受控命令。
        worktreePath: repoRoot,
        prompt,
        systemRulesPath: '.teamai/AGENTS.md',
        env: {},
      })
      .then(({ sessionId, pid }) => {
        saveState(state.current);
        res.status(201).json({ sessionId, pid, traceId, received });
      })
      .catch((err: unknown) => {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'CLI 启动失败',
        });
      });
  });

  app.get('/api/runtime/events', (req, res) => {
    if (!isRealRuntimeEnabled()) {
      res.status(404).json({ error: '真实运行时未启用' });
      return;
    }
    const traceId =
      typeof req.query.traceId === 'string' ? req.query.traceId : undefined;
    res.json({
      events: replayRuntimeEvents(traceId),
      lastSeq: lastEventSeq(),
    });
  });

  app.get('/api/runtime/audit', (req, res) => {
    const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : undefined;
    res.json({ entries: auditLog.list(teamId ? { teamId } : undefined) });
  });

  app.get('/api/runtime/commands', (_req, res) => {
    res.json({ commands: store.replayCommands(), lastSeq: store.lastAppliedSeq() });
  });

  app.post('/api/daemons/:machineId/replay', (req, res) => {
    const daemon = state.current.daemons.find((d) => d.machineId === req.params.machineId);
    if (!daemon) {
      res.status(404).json({ error: 'Daemon 节点不存在' });
      return;
    }
    const replayed = daemon.pendingOfflineEvents > 0 ? daemon.pendingOfflineEvents : 3;
    daemon.status = 'online';
    daemon.lastAckSeq += replayed;
    daemon.pendingOfflineEvents = 0;
    daemon.lastHeartbeatAt = new Date().toISOString();

    broadcastEnvelope({
      machineId: daemon.machineId,
      seq: daemon.lastAckSeq,
      ts: Date.now(),
      payload: {
        type: 'HEARTBEAT',
        activeTaskIds: daemon.activeTaskIds,
        cpuLoad: daemon.cpuLoad,
      },
    });

    saveState(state.current);
    res.json({ daemon, replayed });
  });
}
