import fs from 'node:fs';
import path from 'node:path';

/**
 * append-only 运行轨迹（旁路证据，不参与状态决策：重放不会二次写 state）。
 *
 * S1-1 遗留缺口修复：EVENT_FILE 曾是模块顶层基于 process.cwd() 的常量，
 * append/replay 均不接受路径参数，测试只能靠 chdir + 动态 import 绕开。
 * 现在改为工厂（与 fileStateStore / auditLog / commandBus 同款端口形态）：
 *   - ServerContext 持有实例，路径来自 dataDir（生产默认仍是 <cwd>/.superagent-events.jsonl）；
 *   - 模块级默认单例 + 旧命名导出保留，供 realRuntime / taskLifecycle 这类
 *     无请求上下文的模块使用（写默认路径，与历史行为一致）。
 * 每次 append 与 lastSeq 仍从文件真实扫描 max seq（日志小，正确性优先），
 * 因此**单进程单写者**仍是前提；多 worker 需文件锁或换生产 adapter。
 */

export interface RuntimeEvent {
  seq: number;
  ts: string;
  traceId: string;
  type: string;
  taskId?: string;
  detail?: string;
}

export interface EventLog {
  /** 追加一条事件；seq = 文件真实 max+1，ts = ISO 时间。返回实际落盘的事件。 */
  append(input: Omit<RuntimeEvent, 'seq' | 'ts'>): RuntimeEvent;
  /** 按 traceId 过滤重放（缺省全部）；损坏行被跳过，纯读不落盘。 */
  replay(traceId?: string): RuntimeEvent[];
  /** 当前文件最大 seq；文件不存在返回 0。 */
  lastSeq(): number;
  /** 实例绑定的日志文件路径（测试与诊断用）。 */
  readonly filePath: string;
}

export interface EventLogOptions {
  path: string;
}

export function createEventLog(options: EventLogOptions): EventLog {
  const filePath = options.path;

  function scanMaxSeq(): number {
    if (!fs.existsSync(filePath)) return 0;
    let max = 0;
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
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

  function parseEvents(): RuntimeEvent[] {
    if (!fs.existsSync(filePath)) return [];
    const events: RuntimeEvent[] = [];
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as RuntimeEvent;
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.seq === 'number') {
          events.push(parsed);
        }
      } catch {
        // 损坏行：跳过，不修复、不改写。
      }
    }
    return events;
  }

  return {
    filePath,
    append(input: Omit<RuntimeEvent, 'seq' | 'ts'>): RuntimeEvent {
      const event: RuntimeEvent = {
        seq: scanMaxSeq() + 1,
        ts: new Date().toISOString(),
        ...input,
      };
      // 显式以 O_APPEND 打开 + 单次 writeSync 写完整 JSON 行 + closeSync，避免半行。
      const fd = fs.openSync(filePath, 'a');
      try {
        fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return event;
    },
    replay(traceId?: string): RuntimeEvent[] {
      const events = parseEvents();
      return traceId === undefined ? events : events.filter((e) => e.traceId === traceId);
    },
    lastSeq(): number {
      return scanMaxSeq();
    },
  };
}

// ---- 模块级默认单例（旧命名导出，兼容无请求上下文的调用方）----

/** 默认日志路径：与历史行为一致，基于 process.cwd()。 */
export const EVENT_FILE = path.resolve(process.cwd(), '.superagent-events.jsonl');

const defaultEventLog: EventLog = createEventLog({ path: EVENT_FILE });

/** 追加到默认路径日志（模块单例）。请求上下文内请优先用 ServerContext.eventLog。 */
export function appendRuntimeEvent(input: Omit<RuntimeEvent, 'seq' | 'ts'>): RuntimeEvent {
  return defaultEventLog.append(input);
}

export function lastEventSeq(): number {
  return defaultEventLog.lastSeq();
}

export function replayRuntimeEvents(traceId?: string): RuntimeEvent[] {
  return defaultEventLog.replay(traceId);
}
