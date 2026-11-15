import fs from 'node:fs';
import nodePath from 'node:path';
import { redactSecrets } from '../policy/engine';
import type { Action, AuditEntry } from './types';

// ============================================================================
// 不可变审计日志（append-only JSONL）
// ----------------------------------------------------------------------------
// - 每行一条完整 JSON；record 只追加、绝不改写已有行。
// - seq 每次都从文件真实 max(seq) 重新计算，不缓存，避免外部追加导致 seq 重复。
// - 所有字符串字段（含 detail）写盘前统一经 redactSecrets 脱敏。
// - list 跳过损坏行、按 seq 升序返回，且为纯读、不改写文件。
// ============================================================================

export interface AuditLog {
  record(entry: Omit<AuditEntry, 'seq' | 'ts'>): AuditEntry;
  list(filter?: { teamId?: string; action?: Action }): AuditEntry[];
}

// 所有字符串字段统一脱敏；枚举值字段（action/outcome）用 redactSecrets 后仍是
// 恒等变换，再回铸成原联合类型。返回值即"实际落盘的那一条"，保证不泄漏密钥。
function redactEntry(entry: AuditEntry): AuditEntry {
  const clean = (value: string): string => redactSecrets(value).redacted;
  const redacted: AuditEntry = {
    seq: entry.seq,
    ts: clean(entry.ts),
    userId: clean(entry.userId),
    teamId: clean(entry.teamId),
    action: clean(entry.action) as Action,
    target: clean(entry.target),
    outcome: clean(entry.outcome) as AuditEntry['outcome'],
  };
  if (entry.detail !== undefined) {
    redacted.detail = clean(entry.detail);
  }
  return redacted;
}

// 跳过空行与损坏行（无法解析、或缺 numeric seq 的 JSON 均视为损坏）。
function parseEntries(raw: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditEntry;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof parsed.seq === 'number'
      ) {
        entries.push(parsed);
      }
    } catch {
      // 损坏行：跳过，不修复、不改写。
    }
  }
  return entries;
}

function maxSeq(entries: AuditEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.seq) && entry.seq > max) max = entry.seq;
  }
  return max;
}

export function createAuditLog(options: { path: string }): AuditLog {
  const logPath = options.path;

  function readRaw(): string {
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  }

  function record(entry: Omit<AuditEntry, 'seq' | 'ts'>): AuditEntry {
    const raw = readRaw();
    // 每次都重新读取真实文件计算 max(seq)，不缓存 → 外部追加不会造成 seq 冲突。
    const seq = maxSeq(parseEntries(raw)) + 1;
    const full: AuditEntry = {
      seq,
      ts: new Date().toISOString(),
      ...entry,
    };
    const safe = redactEntry(full);
    const line = JSON.stringify(safe) + '\n';
    // 若外部追加的行未以换行结尾，先补一个换行（仍是纯追加，不改旧字节）。
    const prefix = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
    fs.mkdirSync(nodePath.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, prefix + line, 'utf-8');
    return safe;
  }

  function list(filter?: { teamId?: string; action?: Action }): AuditEntry[] {
    const entries = parseEntries(readRaw());
    const filtered = entries.filter((entry) => {
      if (filter?.teamId !== undefined && entry.teamId !== filter.teamId) return false;
      if (filter?.action !== undefined && entry.action !== filter.action) return false;
      return true;
    });
    return filtered.sort((a, b) => a.seq - b.seq);
  }

  return { record, list };
}
