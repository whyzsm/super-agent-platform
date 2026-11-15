import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { createInitialSeedState, type PlatformState } from '../data/seed';
import { getReadyDagNodes } from '../engine/stateMachine';
import { createFileStateStore } from '../store/fileStateStore';
import type { CommandRecord, StateStore } from '../store/types';
import { createLocalIdentityProvider } from '../identity/localProvider';
import type { IdentityProvider, Principal } from '../identity/types';
import { createAuditLog, type AuditLog } from '../identity/audit';
import { createCommandBus, type LoopCommandKind } from '../loop/commandBus';
import { createEventLog, type EventLog } from '../runtime/eventLog';
import { parseGateTier, type GateApprovalTier, type GateTierConfig } from '../policy/gateTiers';
import type { DaemonEnvelope } from '../protocol';

/**
 * 服务端共享上下文（S1-1 拆分 server.ts 的地基）。
 *
 * 之前 31 个路由 handler 全部闭包引用 server.ts 的模块级可变量
 * （`state` / `globalSeq` / `sseClients` / `saveState` ...），横跨 1500+ 行，
 * 这是拆分一直被 deferred 的根因。本模块把这些闭包收敛成一个显式上下文对象：
 *
 * - `state` 与 `seq` 是「盒子」（`{ current }`）：`POST /api/reset` 会整体替换
 *   `state.current`，任何持有 ctx 的模块（含 mcpContext 这类惰性闭包）都必须
 *   每次实时读取 `.current`，绝不能解构出 PlatformState 本身缓存。
 * - 四个端口实例（store / identity / audit / commandBus）随 ctx 注入，
 *   测试可用临时目录构造完全隔离的实例（见 src/server/http.test.ts）。
 * - 生产接入 Postgres / OIDC / Temporal 时替换这里的工厂调用即可，
 *   路由层不感知（契约见 .trellis/spec/backend/platform-ports.md）。
 */
export interface ServerContext {
  readonly store: StateStore;
  readonly identityProvider: IdentityProvider;
  readonly auditLog: AuditLog;
  readonly commandBus: ReturnType<typeof createCommandBus>;

  /** 全量状态盒子：reset 会替换 .current，读取方必须实时取 .current */
  readonly state: { current: PlatformState };
  /** 全局事件序列盒子，等价于原 server.ts 的 `let globalSeq` */
  readonly seq: { current: number };

  /** SSE 长连接客户端集合；write 失败即摘除 */
  readonly sseClients: Set<Response>;

  /** IM 回调 HMAC 密钥；未配置时相关端点返回 503（设计行为） */
  readonly imWebhookSecret: string | undefined;

  /** Q8 门禁三挡配置；默认 always_confirm（与历史行为一致） */
  readonly gateTierConfig: GateTierConfig;

  /** 运行轨迹旁路日志（.superagent-events.jsonl，落在 dataDir）；单进程单写者前提不变 */
  readonly eventLog: EventLog;

  /** git 仓库根（worktree / verifier 的执行目录），测试可指向临时仓库 */
  readonly repoRoot: string;
  /** agent 工作树根目录，默认 <repoRoot>/.worktrees */
  readonly worktreeRoot: string;

  /** 原子写快照（tmp + rename），失败只记日志不抛（与原 server.ts 行为一致） */
  saveState(next: PlatformState): void;
  broadcastEnvelope(envelope: DaemonEnvelope): void;
  recomputeRequirementStatus(reqId: string): void;
  unlockReadyNodesForRequirement(reqId: string): void;
  /** 把 Team AI 资产写盘；overwrite=false 只补建缺失文件（reset 语义） */
  syncTeamAiFileToDisk(relPath: string, content: string, overwrite?: boolean): void;
  /** POST /api/reset 的实现：重建种子态 + 只补建缺失 .teamai 文件 + 落盘 */
  resetState(): PlatformState;
}

export interface ServerContextOptions {
  /** 状态/日志文件目录，默认 process.cwd() */
  dataDir?: string;
  /** git 仓库根，默认 process.cwd() */
  repoRoot?: string;
  /** 工作树根，默认 <repoRoot>/.worktrees；也接受 SUPERAGENT_WORKTREE_ROOT */
  worktreeRoot?: string;
  /** IM 回调密钥，默认 process.env.IM_WEBHOOK_SECRET（调用时读取，不读 import 时） */
  imWebhookSecret?: string;
  /** 测试注入初始状态；缺省走 loadOrInit（损坏快照隔离 + 种子兜底） */
  initialState?: PlatformState;
  /** Q8 门禁三挡；缺省解析 SUPERAGENT_GATE_TIER（非法值 fail-safe 到 always_confirm） */
  gateTier?: GateApprovalTier;
}

function loadOrInitState(store: StateStore, statePath: string): PlatformState {
  try {
    const loaded = store.load();
    if (loaded) return loaded;
  } catch (err) {
    // 损坏快照先隔离留证，绝不静默覆写——静默回退会永久丢失真实进度。
    const backup = `${statePath}.corrupt-${Date.now()}`;
    try {
      if (fs.existsSync(statePath)) fs.renameSync(statePath, backup);
      console.error(`[loadOrInitState] 状态快照损坏，已备份至 ${backup}`);
    } catch (backupErr) {
      console.error(
        `[loadOrInitState] 状态快照损坏且备份失败: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`,
      );
    }
    console.error(
      `[loadOrInitState] 解析失败原因: ${err instanceof Error ? err.message : String(err)}；命令日志中仍有 ${store.replayCommands().length} 条已提交命令，需人工核对`,
    );
  }
  const initial = createInitialSeedState();
  store.save(initial);
  return initial;
}

export function createServerContext(options: ServerContextOptions = {}): ServerContext {
  const dataDir = path.resolve(options.dataDir ?? process.cwd());
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const worktreeRoot = options.worktreeRoot
    ? path.resolve(options.worktreeRoot)
    : process.env.SUPERAGENT_WORKTREE_ROOT
      ? path.resolve(process.env.SUPERAGENT_WORKTREE_ROOT)
      : path.join(repoRoot, '.worktrees');

  // Ports & Adapters：业务只依赖接口。生产把 StateStore 换 Postgres、
  // IdentityProvider 换 OIDC、CommandBus 换 Temporal，流程代码不动。
  const store = createFileStateStore({
    statePath: path.join(dataDir, '.superagent-state.json'),
    logPath: path.join(dataDir, '.superagent-commands.jsonl'),
  });
  const identityProvider = createLocalIdentityProvider();
  const auditLog = createAuditLog({ path: path.join(dataDir, '.superagent-audit.jsonl') });
  const commandBus = createCommandBus({
    logPath: path.join(dataDir, '.superagent-loop.jsonl'),
  });
  const eventLog = createEventLog({
    path: path.join(dataDir, '.superagent-events.jsonl'),
  });

  const imWebhookSecret = options.imWebhookSecret ?? process.env.IM_WEBHOOK_SECRET;
  const gateTierConfig: GateTierConfig = {
    tier: options.gateTier ?? parseGateTier(process.env.SUPERAGENT_GATE_TIER),
  };

  const state: { current: PlatformState } = {
    current: options.initialState ?? loadOrInitState(store, path.join(dataDir, '.superagent-state.json')),
  };
  const seq = { current: 1000 };
  const sseClients = new Set<Response>();

  const ctx: ServerContext = {
    store,
    identityProvider,
    auditLog,
    commandBus,
    eventLog,
    state,
    seq,
    sseClients,
    imWebhookSecret,
    gateTierConfig,
    repoRoot,
    worktreeRoot,

    saveState(next: PlatformState): void {
      try {
        // 临时文件 + rename：崩溃后目标文件要么是旧完整快照，要么是新完整快照。
        store.save(next);
      } catch (err) {
        console.error(
          `[saveState] failed to write state snapshot: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    broadcastEnvelope(envelope: DaemonEnvelope): void {
      const payload = `data: ${JSON.stringify(envelope)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(payload);
        } catch {
          sseClients.delete(client);
        }
      }
    },

    recomputeRequirementStatus(reqId: string): void {
      const req = state.current.requirements.find((r) => r.id === reqId);
      if (!req) return;
      const reqTasks = state.current.tasks.filter((t) => t.reqId === reqId);
      if (reqTasks.length === 0) {
        req.status = 'PLANNING';
        return;
      }
      if (reqTasks.some((t) => t.state === 'ESCALATED')) {
        req.status = 'ESCALATED';
      } else if (reqTasks.some((t) => t.state === 'HUMAN_GATE')) {
        req.status = 'AWAITING_GATE';
      } else if (reqTasks.every((t) => t.state === 'MERGED' || t.state === 'CANCELLED')) {
        req.status = 'COMPLETED';
      } else {
        req.status = 'IN_PROGRESS';
      }
    },

    unlockReadyNodesForRequirement(reqId: string): void {
      const reqNodes = state.current.tasks.filter((t) => t.reqId === reqId);
      const ready = getReadyDagNodes(reqNodes);
      for (const node of ready) {
        const target = state.current.tasks.find((t) => t.id === node.id);
        if (!target) continue;
        target.state = 'RUNNING';
        const timeStr = new Date().toTimeString().slice(0, 8);
        const ev = {
          id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ts: timeStr,
          seq: ++seq.current,
          kind: 'thought' as const,
          title: `上游依赖已全部合入，Daemon 自动拉起隔离 Worktree (${target.worktreeBranch})`,
          detail: `在 ${target.assignedMachine || 'mac-studio-sh-01'} 上执行 ${target.provider} (${target.adapterMode})`,
          status: 'running' as const,
        };
        target.events.push(ev);
        target.terminalLines.push(
          `[scheduler] upstream dependencies MERGED -> spawning ${target.id} on ${target.worktreeBranch}`,
        );
        ctx.broadcastEnvelope({
          machineId: target.assignedMachine || 'mac-studio-sh-01',
          seq: seq.current,
          ts: Date.now(),
          payload: { type: 'STATE_ACK', taskId: target.id, state: 'RUNNING' },
        });
        ctx.broadcastEnvelope({
          machineId: target.assignedMachine || 'mac-studio-sh-01',
          seq: ++seq.current,
          ts: Date.now(),
          payload: { type: 'AGENT_EVENT', taskId: target.id, event: ev },
        });
      }
    },

    syncTeamAiFileToDisk(relPath: string, content: string, overwrite = true): void {
      if (!relPath.startsWith('.teamai/')) return;
      try {
        const absPath = path.resolve(repoRoot, relPath);
        if (!overwrite && fs.existsSync(absPath)) return;
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
      } catch {
        // Ignore disk write failure in read-only environments
      }
    },

    resetState(): PlatformState {
      state.current = createInitialSeedState();
      for (const asset of state.current.teamAiAssets) {
        // 只补建缺失文件：`reset` 是重置内存状态，不应顺手覆写仓库里人工维护的团队资产。
        ctx.syncTeamAiFileToDisk(asset.path, asset.content, false);
      }
      ctx.saveState(state.current);
      return state.current;
    },
  };

  return ctx;
}

// ---- 仅为让类型引用处可发现（避免各路由模块重复 import 细节类型）----
export type { CommandRecord, LoopCommandKind, Principal };
