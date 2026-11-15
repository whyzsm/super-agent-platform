import fs from 'node:fs';
import path from 'node:path';

/**
 * append-only 运行轨迹。旁路证据，不参与状态决策：重放不会二次写 state。
 * 模块顶层不做 IO；每次 append 与 lastEventSeq 都从文件真实扫描 max seq，
 * 保证外部进程/另一进程追加后序列号仍严格递增且无重复（日志小，正确性优先）。
 */

export interface RuntimeEvent {
  seq: number;
  ts: string;
  traceId: string;
  type: string;
  taskId?: string;
  detail?: string;
}

export const EVENT_FILE = path.resolve(process.cwd(), '.superagent-events.jsonl');

function scanMaxSeq(): number {
  if (!fs.existsSync(EVENT_FILE)) return 0;
  let max = 0;
  for (const line of fs.readFileSync(EVENT_FILE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { seq?: unknown };
      if (typeof parsed.seq === 'number' && parsed.seq > max) max = parsed.seq;
    } catch {
      // 损坏行不阻断读取，但会在 replay 中被过滤
    }
  }
  return max;
}

export function lastEventSeq(): number {
  return scanMaxSeq();
}

export function appendRuntimeEvent(
  input: Omit<RuntimeEvent, 'seq' | 'ts'>,
): RuntimeEvent {
  const event: RuntimeEvent = {
    seq: scanMaxSeq() + 1,
    ts: new Date().toISOString(),
    ...input,
  };
  // 显式以 O_APPEND 打开 + 单次 writeSync 写完整 JSON 行 + closeSync，避免半行。
  const fd = fs.openSync(EVENT_FILE, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(event)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return event;
}

export function replayRuntimeEvents(traceId?: string): RuntimeEvent[] {
  if (!fs.existsSync(EVENT_FILE)) return [];
  const events: RuntimeEvent[] = [];
  for (const line of fs.readFileSync(EVENT_FILE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RuntimeEvent;
      if (typeof parsed.seq === 'number' && typeof parsed.traceId === 'string') {
        events.push(parsed);
      }
    } catch {
      // 跳过损坏行
    }
  }
  return events
    .filter((event) => !traceId || event.traceId === traceId)
    .sort((a, b) => a.seq - b.seq);
}
