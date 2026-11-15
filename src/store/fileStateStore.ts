import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PlatformState } from '../data/seed';
import type { CommandRecord, FileStateStoreOptions, StateStore } from './types';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 解析单行日志：损坏行 / 缺字段行一律返回 null，交由调用方跳过。 */
function parseRecord(line: string): CommandRecord | null {
  if (!line.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const r = obj as Record<string, unknown>;
  const { commandId, appliedSeq, ts, kind } = r;
  if (
    typeof commandId !== 'string' ||
    typeof appliedSeq !== 'number' ||
    !Number.isFinite(appliedSeq) ||
    typeof ts !== 'string' ||
    typeof kind !== 'string' ||
    !('payload' in r)
  ) {
    return null;
  }
  return { commandId, appliedSeq, ts, kind, payload: r.payload };
}

/** 纯读日志文本；文件不存在返回空串，不创建也不修复任何文件。 */
function readLogText(logPath: string): string {
  if (!fs.existsSync(logPath)) return '';
  try {
    return fs.readFileSync(logPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[FileStateStore] 读取命令日志失败 (${logPath}): ${messageOf(err)}`,
    );
  }
}

/** 解析出全部合法记录（未排序），损坏/缺字段行被跳过。 */
function parseRecords(text: string): CommandRecord[] {
  const records: CommandRecord[] = [];
  for (const line of text.split('\n')) {
    const rec = parseRecord(line);
    if (rec) records.push(rec);
  }
  return records;
}

/** 从真实日志记录计算最大 appliedSeq，不缓存，外部追加也能被感知。 */
function maxAppliedSeq(records: CommandRecord[]): number {
  let max = 0;
  for (const r of records) {
    if (r.appliedSeq > max) max = r.appliedSeq;
  }
  return max;
}

export function createFileStateStore(
  options: FileStateStoreOptions,
): StateStore {
  const { statePath, logPath } = options;

  function save(state: PlatformState): void {
    const dir = path.dirname(statePath);
    fs.mkdirSync(dir, { recursive: true });
    // 临时文件与 statePath 同目录：rename 是同一文件系统内的原子替换。
    const tmpPath = `${statePath}.tmp-${randomUUID()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      // 目标要么是旧内容，要么是完整的新内容，绝不会处于半写状态。
      fs.renameSync(tmpPath, statePath);
    } finally {
      // rename 成功时 tmpPath 已不存在；失败时清理残留，避免临时文件累积。
      if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }
    }
  }

  function load(): PlatformState | null {
    if (!fs.existsSync(statePath)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(statePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `[FileStateStore] 读取状态快照失败 (${statePath}): ${messageOf(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 绝不静默回退 seed：把损坏显式暴露给调用方决定恢复策略。
      throw new Error(
        `[FileStateStore] 状态快照 JSON 损坏，拒绝静默回退 (${statePath}): ${messageOf(err)}`,
      );
    }
    const obj =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (obj && Array.isArray(obj.requirements) && Array.isArray(obj.tasks)) {
      return parsed as PlatformState;
    }
    throw new Error(
      `[FileStateStore] 状态快照结构无效：缺少 requirements/tasks 数组 (${statePath})`,
    );
  }

  function replayCommands(): CommandRecord[] {
    // 纯读：仅解析并返回，不向日志追加也不修复损坏行。
    return parseRecords(readLogText(logPath)).sort(
      (a, b) => a.appliedSeq - b.appliedSeq,
    );
  }

  function lastAppliedSeq(): number {
    return maxAppliedSeq(parseRecords(readLogText(logPath)));
  }

  function appendCommand(
    commandId: string,
    kind: string,
    payload: unknown,
  ): { accepted: boolean; duplicate: boolean; reason?: string } {
    // 每次从日志真实内容重算，不缓存 seq；外部追加或进程重启都不会造成 seq 重复。
    const text = readLogText(logPath);
    const records = parseRecords(text);

    if (records.some((r) => r.commandId === commandId)) {
      return {
        accepted: false,
        duplicate: true,
        reason: `commandId '${commandId}' 已存在于命令日志`,
      };
    }

    const record: CommandRecord = {
      commandId,
      appliedSeq: maxAppliedSeq(records) + 1,
      ts: new Date().toISOString(),
      kind,
      payload,
    };

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // 上次崩溃可能留下"末尾无换行的不完整 JSON 行"：先补一个换行，
    // 保证新命令独占一行、不与残行粘连而被当成损坏行丢失。仅追加字节，不改写既有内容。
    const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      logPath,
      `${separator}${JSON.stringify(record)}\n`,
      'utf-8',
    );
    return { accepted: true, duplicate: false };
  }

  return { load, save, appendCommand, replayCommands, lastAppliedSeq };
}
