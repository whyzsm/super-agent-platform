import fs from 'node:fs';
import path from 'node:path';

/**
 * append-only 运行轨迹。旁路证据，不参与状态决策：重放不会二次写 state。
 * 模块顶层不做 IO，序列号在首次 append 时才从文件恢复。
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

let cachedLastSeq: number | null = null;

function readLastSeq(): number {
  if (cachedLastSeq !== null) return cachedLastSeq;
  if (!fs.existsSync(EVENT_FILE)) {
    cachedLastSeq = 0;
    return 0;
  }
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
  cachedLastSeq = max;
  return max;
}

export function lastEventSeq(): number {
  return readLastSeq();
}

export function appendRuntimeEvent(
  input: Omit<RuntimeEvent, 'seq' | 'ts'>,
): RuntimeEvent {
  const event: RuntimeEvent = {
    seq: readLastSeq() + 1,
    ts: new Date().toISOString(),
    ...input,
  };
  fs.appendFileSync(EVENT_FILE, `${JSON.stringify(event)}\n`, 'utf-8');
  cachedLastSeq = event.seq;
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
