import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PlatformState } from '../data/seed';
import type { CommandRecord, StateStore } from './types';

/**
 * Postgres StateStore 适配器（S1-2）：StateStore 端口的第二个真实实现。
 *
 * 设计取舍（见 docs/decision-log.md D-13）：
 * - **零 npm 依赖**：经 psql 命令行执行单条 SQL（spawnSync 参数数组，无 shell）。
 *   StateStore 契约是同步的，node-postgres 只有异步 API；为不重写全链路调用方，
 *   用 psql 子进程桥接同步语义。每次操作一个进程（~30ms），本地闭环规模完全够用。
 * - **dollar-quoting 防注入**：快照/命令内容用随机 tag 的 $tag$...$tag$ 包裹，
 *   任意 JSON 内容都无法逃出字面量；命令前缀由运营者经 env 提供，不进 shell。
 * - **jsonb 即完整性**：快照列是 jsonb，非法 JSON 在数据库层就被拒绝（文件实现里
 *   的「损坏 JSON 抛错」在这里由 PG 类型系统保证）；结构校验（requirements/tasks
 *   数组存在）仍在 load() 做并抛错，绝不静默回退 seed。
 * - **幂等靠主键**：command_id PRIMARY KEY + INSERT ... ON CONFLICT DO NOTHING，
 *   重复命令返回 duplicate:true，不二次写入。appliedSeq 单写者前提下严格递增。
 */

export interface PostgresStateStoreOptions {
  /**
   * psql 调用前缀（不含 -c / -tA 等执行参数）。
   * 例：['docker','exec','-i','superagent-pg','psql','-U','superagent','-d','superagent']
   * 或 ['/opt/homebrew/opt/postgresql@16/bin/psql','postgresql://user:pass@host/db']。
   */
  command: string[];
  /** 表名前缀（多套环境隔离），默认 superagent */
  tablePrefix?: string;
  /** 单条 SQL 超时毫秒，默认 15000 */
  timeoutMs?: number;
}

export interface PostgresStateStore extends StateStore {
  /** 建表（IF NOT EXISTS）；createServerContext 前调用一次 */
  init(): void;
}

interface PsqlRun {
  status: number | null;
  stdout: string;
  stderr: string;
  spawnError: string;
}

export function createPostgresStateStore(
  options: PostgresStateStoreOptions,
): PostgresStateStore {
  const [bin, ...baseArgs] = options.command;
  if (!bin) throw new Error('[PostgresStateStore] command 不能为空');
  const prefix = options.tablePrefix ?? 'superagent';
  const stateTable = `${prefix}_state`;
  const cmdTable = `${prefix}_commands`;
  const timeoutMs = options.timeoutMs ?? 15_000;

  function run(sql: string, tuplesOnly = false): PsqlRun {
    const args = [
      ...baseArgs,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      ...(tuplesOnly ? ['-t', '-A'] : []),
      '-c',
      sql,
    ];
    const res = spawnSync(bin, args, { encoding: 'utf-8', timeout: timeoutMs });
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      spawnError: res.error ? res.error.message : '',
    };
  }

  function mustRun(sql: string, tuplesOnly = false): string {
    const r = run(sql, tuplesOnly);
    if (r.status !== 0) {
      const detail = (r.stderr || r.spawnError || '').trim().slice(0, 400);
      throw new Error(
        `[PostgresStateStore] SQL 执行失败 (exit=${r.status ?? 'null'}): ${detail} | SQL=${sql.slice(0, 160)}`,
      );
    }
    return r.stdout;
  }

  /** 随机 tag 的 dollar-quote：内容中的任意字符（含引号/反斜杠/$）都无法逃出字面量。 */
  function dollarQuote(content: string): string {
    const tag = `sa${randomUUID().replace(/-/g, '')}`;
    return `$${tag}$${content}$${tag}$`;
  }

  function init(): void {
    mustRun(`CREATE TABLE IF NOT EXISTS ${stateTable} (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`);
    mustRun(`CREATE TABLE IF NOT EXISTS ${cmdTable} (
  command_id text PRIMARY KEY,
  applied_seq bigint NOT NULL,
  ts text NOT NULL,
  kind text NOT NULL,
  payload jsonb
);`);
  }

  function load(): PlatformState | null {
    const out = mustRun(`SELECT snapshot FROM ${stateTable} WHERE id = 1`, true).trim();
    if (out === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch (err) {
      // jsonb 列正常不会产生非法 JSON；此分支防御 pg 客户端层异常，仍显式抛错。
      throw new Error(
        `[PostgresStateStore] 快照内容无法解析为 JSON，拒绝静默回退: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
    if (obj && Array.isArray(obj.requirements) && Array.isArray(obj.tasks)) {
      return parsed as PlatformState;
    }
    throw new Error(
      `[PostgresStateStore] 快照结构无效：缺少 requirements/tasks 数组`,
    );
  }

  function save(state: PlatformState): void {
    const literal = dollarQuote(JSON.stringify(state));
    // 单语句原子 upsert：读者要么看到旧快照要么看到新快照。
    mustRun(`INSERT INTO ${stateTable} (id, snapshot)
VALUES (1, ${literal}::jsonb)
ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`);
  }

  function appendCommand(
    commandId: string,
    kind: string,
    payload: unknown,
  ): { accepted: boolean; duplicate: boolean; reason?: string } {
    const idLit = dollarQuote(commandId);
    const kindLit = dollarQuote(kind);
    const payloadLit = payload === undefined ? 'NULL' : `${dollarQuote(JSON.stringify(payload))}::jsonb`;
    // 幂等由 command_id 主键 + ON CONFLICT DO NOTHING 保证；seq 单写者前提下递增。
    const out = mustRun(
      `INSERT INTO ${cmdTable} (command_id, applied_seq, ts, kind, payload)
SELECT ${idLit}, COALESCE((SELECT MAX(applied_seq) FROM ${cmdTable}), 0) + 1, ${dollarQuote(new Date().toISOString())}, ${kindLit}, ${payloadLit}
ON CONFLICT (command_id) DO NOTHING
RETURNING applied_seq`,
      true,
    ).trim();
    if (out === '') {
      return {
        accepted: false,
        duplicate: true,
        reason: `commandId '${commandId}' 已存在于命令日志`,
      };
    }
    return { accepted: true, duplicate: false };
  }

  function replayCommands(): CommandRecord[] {
    const out = mustRun(
      `SELECT COALESCE(json_agg(rec ORDER BY applied_seq), '[]'::json)
FROM (
  SELECT json_build_object('commandId', command_id, 'appliedSeq', applied_seq, 'ts', ts, 'kind', kind, 'payload', payload) AS rec,
         applied_seq
  FROM ${cmdTable}
) s`,
      true,
    ).trim();
    try {
      const parsed = JSON.parse(out) as CommandRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error('[PostgresStateStore] 命令日志聚合结果无法解析');
    }
  }

  function lastAppliedSeq(): number {
    const out = mustRun(`SELECT COALESCE(MAX(applied_seq), 0) FROM ${cmdTable}`, true).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  }

  return { init, load, save, appendCommand, replayCommands, lastAppliedSeq };
}
