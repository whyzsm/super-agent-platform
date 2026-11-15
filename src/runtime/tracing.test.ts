import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import opentelemetry from '@opentelemetry/api';
import { createTracing, isTracingEnabled } from './tracing';

async function withTempLog(fn: (logPath: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-test-'));
  const logPath = path.join(dir, 'traces.jsonl');
  try {
    await fn(logPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readSpans(logPath: string): Record<string, unknown>[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('isTracingEnabled', () => {
  test('1/true 开，其余关', () => {
    assert.equal(isTracingEnabled('1'), true);
    assert.equal(isTracingEnabled('true'), true);
    assert.equal(isTracingEnabled(undefined), false);
    assert.equal(isTracingEnabled('0'), false);
    assert.equal(isTracingEnabled('yes'), false);
  });
});

describe('NDJSON span 导出（真实 OTel SDK 管线）', () => {
  test('span 端到端落盘且字段完整', async () => {
    await withTempLog(async (logPath) => {
      const handle = createTracing({ filePath: logPath });
      const span = handle.tracer.startSpan('superagent.verify', {
        attributes: { 'superagent.taskId': 'task-1', 'superagent.passed': true },
      });
      span.setStatus({ code: 1 }); // STATUS_CODE_OK
      span.end();
      await handle.shutdown();
      const spans = readSpans(logPath);
      assert.equal(spans.length, 1);
      const s = spans[0];
      assert.match(String(s.traceId), /^[0-9a-f]{32}$/);
      assert.match(String(s.spanId), /^[0-9a-f]{16}$/);
      assert.equal(s.name, 'superagent.verify');
      assert.equal((s.attributes as Record<string, unknown>)['superagent.taskId'], 'task-1');
      assert.equal(typeof s.durationMs, 'number');
      assert.ok((s.durationMs as number) >= 0);
      assert.equal(s.serviceName, 'super-agent-platform');
      assert.equal(s.status, 1);
    });
  });

  test('父子关系：显式 context 传参时 child.parentSpanId === parent.spanId', async () => {
    await withTempLog(async (logPath) => {
      const handle = createTracing({ filePath: logPath });
      // 未注册 context manager（避免额外依赖）：自动 active-context 传播不可用，
      // 显式 setSpan 传 parent context —— 与当前服务端 span 产生方式一致。
      const parent = handle.tracer.startSpan('parent');
      const ctx = opentelemetry.trace.setSpan(opentelemetry.context.active(), parent);
      handle.tracer.startSpan('child', {}, ctx).end();
      parent.end();
      await handle.shutdown();
      const spans = readSpans(logPath);
      assert.equal(spans.length, 2);
      const child = spans.find((s) => s.name === 'child');
      const par = spans.find((s) => s.name === 'parent');
      assert.equal(child!.parentSpanId, par!.spanId);
    });
  });

  test('未 end 的 span 不写盘（SDK 语义透传）', async () => {
    await withTempLog(async (logPath) => {
      const handle = createTracing({ filePath: logPath });
      handle.tracer.startSpan('never-ended').end();
      const leaked = handle.tracer.startSpan('leaked'); // 不 end
      void leaked;
      await handle.shutdown();
      const spans = readSpans(logPath);
      assert.equal(spans.length, 1);
      assert.equal(spans[0].name, 'never-ended');
    });
  });
});
