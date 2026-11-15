import fs from 'node:fs';
import path from 'node:path';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import opentelemetry, { type Tracer } from '@opentelemetry/api';

/**
 * OTel 追踪第一步（S3-6）：真实 OpenTelemetry SDK span + 本地 NDJSON 导出。
 *
 * 零外部服务：自定义 SpanExporter 把 ReadableSpan 写成
 * `.superagent-traces.jsonl` 单行 JSON（append-only，与事件/审计日志同款纪律）。
 * 后续接 Langfuse/OTLP endpoint 时只需把这里的导出器换成 OTLP exporter，
 * span 产生侧（realRuntime / verifier）不动。
 *
 * 开关：SUPERAGENT_TRACING=1 启用（默认关闭，零行为差异）；
 * SUPERAGENT_TRACES_FILE 覆盖输出路径（默认 <dataDir>/.superagent-traces.jsonl）。
 * SimpleSpanProcessor：每 span 立即写盘，本地闭环优先可观测性而非吞吐。
 *
 * 边界：未注册 OTel context manager（避免额外依赖），startActiveSpan 的自动
 * 父子传播不可用；需要嵌套 span 时显式经 setSpan 传 parent context（见测试）。
 */

export interface TracingHandle {
  tracer: Tracer;
  /** 强制写出暂存 span；测试与进程退出前调用 */
  shutdown(): Promise<void>;
  /** 导出文件路径（诊断用） */
  readonly filePath: string;
}

export function isTracingEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** HrTime（[秒, 纳秒]）转毫秒，保留 3 位小数。 */
function hrTimeToMs(hr: readonly [number, number]): number {
  return Number((hr[0] * 1e3 + hr[1] / 1e6).toFixed(3));
}

/** NDJSON 行导出器：一个 span 一行完整 JSON，损坏不修复、不改写既有行。 */
export function createNdjsonSpanExporter(filePath: string): SpanExporter {
  return {
    export(spans: ReadableSpan[], resultCallback: (r: { code: ExportResultCode }) => void): void {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const lines = spans.map((span) =>
          JSON.stringify({
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parentSpanId: span.parentSpanContext?.spanId ?? null,
            name: span.name,
            kind: String(span.kind),
            startTimeUnixNano: span.startTime[0] * 1e9 + span.startTime[1],
            durationMs: hrTimeToMs(span.duration),
            attributes: span.attributes,
            status: span.status.code,
            statusMessage: span.status.message ?? null,
            serviceName: span.resource.attributes['service.name'] ?? null,
          }),
        );
        const fd = fs.openSync(filePath, 'a');
        try {
          fs.writeSync(fd, lines.map((l) => l + '\n').join(''));
        } finally {
          fs.closeSync(fd);
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      } catch {
        resultCallback({ code: ExportResultCode.FAILED });
      }
    },
    async shutdown(): Promise<void> {
      /* NDJSON 导出器无缓冲，无需清理 */
    },
  };
}

export interface TracingOptions {
  filePath: string;
  serviceName?: string;
  /** 注册为全局 TracerProvider（进程唯一）；测试多实例时保持 false。默认 false。 */
  registerGlobal?: boolean;
}

export function createTracing(options: TracingOptions): TracingHandle {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? 'super-agent-platform',
      'service.version': '0.0.0',
    }),
    spanProcessors: [
      new SimpleSpanProcessor(createNdjsonSpanExporter(options.filePath)),
    ],
  });
  if (options.registerGlobal) {
    opentelemetry.trace.setGlobalTracerProvider(provider);
  }
  return {
    tracer: provider.getTracer('superagent.runtime'),
    filePath: options.filePath,
    shutdown: () => provider.shutdown(),
  };
}
