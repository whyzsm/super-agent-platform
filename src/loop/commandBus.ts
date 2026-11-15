import fs from 'node:fs';

export type LoopCommandKind =
  | 'ADVANCE'
  | 'BLOCK_RESOURCE'
  | 'RELEASE_RESOURCE'
  | 'QUARANTINE'
  | 'RELEASE_QUARANTINE'
  | 'WAIT_APPROVAL'
  | 'APPROVE'
  | 'RETRY'
  | 'CANCEL'
  | 'RETRO';

export interface LoopCommand {
  commandId: string;
  taskId: string;
  kind: LoopCommandKind;
  payload?: Record<string, unknown>;
}

export interface SubmittedCommand extends LoopCommand {
  seq: number;
  ts: string;
}

const VALID_KINDS = new Set<string>([
  'ADVANCE',
  'BLOCK_RESOURCE',
  'RELEASE_RESOURCE',
  'QUARANTINE',
  'RELEASE_QUARANTINE',
  'WAIT_APPROVAL',
  'APPROVE',
  'RETRY',
  'CANCEL',
  'RETRO',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把一行日志解析为结构完整的 SubmittedCommand；损坏行（非法 JSON / 缺字段 /
 * 类型不符 / 非法 kind）一律返回 null，供读取侧跳过，绝不抛异常。
 */
function parseLine(line: string): SubmittedCommand | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const { commandId, taskId, kind, seq, ts } = parsed;
  if (
    typeof commandId !== 'string' || !commandId.trim() ||
    typeof taskId !== 'string' || !taskId.trim() ||
    typeof kind !== 'string' || !VALID_KINDS.has(kind) ||
    typeof seq !== 'number' || !Number.isFinite(seq) ||
    typeof ts !== 'string'
  ) {
    return null;
  }

  let payload: Record<string, unknown> | undefined;
  if (parsed.payload !== undefined) {
    if (!isPlainObject(parsed.payload)) return null;
    payload = parsed.payload;
  }

  const record: SubmittedCommand = {
    commandId,
    taskId,
    kind: kind as LoopCommandKind,
    seq,
    ts,
  };
  if (payload !== undefined) record.payload = payload;
  return record;
}

/** 读取并跳过损坏行；纯读，不创建文件、不追加。 */
function readAll(logPath: string): SubmittedCommand[] {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf-8');
  const records: SubmittedCommand[] = [];
  for (const line of raw.split('\n')) {
    const record = parseLine(line);
    if (record) records.push(record);
  }
  return records;
}

function maxSeq(records: SubmittedCommand[]): number {
  let max = 0;
  for (const record of records) {
    if (record.seq > max) max = record.seq;
  }
  return max;
}

/**
 * durable loop 的本地幂等命令底座：append-only 单行 JSON 日志。
 * seq 每次从日志真实 max 现算（不缓存），因此外部追加/进程重启都不冲突；
 * commandId 全局幂等去重；读取侧跳过损坏行；任何非法输入只返回结果、绝不抛异常。
 */
export function createCommandBus(options: { logPath: string }): {
  submit(cmd: LoopCommand): {
    accepted: boolean;
    duplicate: boolean;
    reason?: string;
    record?: SubmittedCommand;
  };
  list(taskId?: string): SubmittedCommand[];
  lastSeq(): number;
} {
  const logPath = options.logPath;

  function submit(cmd: LoopCommand): {
    accepted: boolean;
    duplicate: boolean;
    reason?: string;
    record?: SubmittedCommand;
  } {
    // 入口校验：任何非法输入都只返回结果，绝不抛异常打挂服务。
    if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return { accepted: false, duplicate: false, reason: '命令必须是非空对象' };
    }
    if (typeof cmd.commandId !== 'string' || !cmd.commandId.trim()) {
      return { accepted: false, duplicate: false, reason: '缺少或为空的 commandId' };
    }
    if (typeof cmd.taskId !== 'string' || !cmd.taskId.trim()) {
      return { accepted: false, duplicate: false, reason: '缺少或为空的 taskId' };
    }
    if (typeof cmd.kind !== 'string' || !VALID_KINDS.has(cmd.kind)) {
      return { accepted: false, duplicate: false, reason: `非法 kind：${String(cmd.kind)}` };
    }
    if (cmd.payload !== undefined && !isPlainObject(cmd.payload)) {
      return { accepted: false, duplicate: false, reason: 'payload 必须是对象' };
    }

    try {
      const existing = readAll(logPath);

      // commandId 幂等去重：命中即返回，不追加、不改变任何状态。
      if (existing.some((record) => record.commandId === cmd.commandId)) {
        return {
          accepted: false,
          duplicate: true,
          reason: `commandId=${cmd.commandId} 已存在，幂等忽略（不追加、不改变状态）`,
        };
      }

      // seq 每次都从日志真实 max 现算，外部追加也不会冲突。
      const seq = maxSeq(existing) + 1;
      const record: SubmittedCommand = {
        commandId: cmd.commandId,
        taskId: cmd.taskId,
        kind: cmd.kind,
        seq,
        ts: new Date().toISOString(),
      };
      if (cmd.payload !== undefined) record.payload = cmd.payload;

      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf-8');
      return { accepted: true, duplicate: false, record };
    } catch (err) {
      return {
        accepted: false,
        duplicate: false,
        reason: `命令日志读写失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  function list(taskId?: string): SubmittedCommand[] {
    let records: SubmittedCommand[];
    try {
      records = readAll(logPath);
    } catch {
      return [];
    }
    const filtered = taskId === undefined
      ? records
      : records.filter((record) => record.taskId === taskId);
    return filtered.sort((a, b) => a.seq - b.seq);
  }

  function lastSeq(): number {
    try {
      return maxSeq(readAll(logPath));
    } catch {
      return 0;
    }
  }

  return { submit, list, lastSeq };
}
