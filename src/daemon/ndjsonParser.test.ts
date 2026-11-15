import test from 'node:test';
import assert from 'node:assert/strict';
import { OfflineSeqQueue, parseCliNdjsonLine } from './ndjsonParser';
import { detectDangerousCommand } from '../policy/engine';

test('parseCliNdjsonLine parses Codex edit events and redacts embedded secrets', () => {
  const line = JSON.stringify({
    type: 'file_edit',
    title: 'Update gateway token parser',
    content: 'Configured key sk-live1234567890abcdef in test stub',
  });
  const parsed = parseCliNdjsonLine('codex', line, 42, '00:55:00');
  assert.ok(parsed.event);
  assert.equal(parsed.event.kind, 'file_edit');
  assert.equal(parsed.event.redactedHits, 1);
  assert.equal(parsed.event.detail.includes('sk-live'), false);
  assert.equal(parsed.event.detail.includes('[REDACTED_API_KEY]'), true);
});

test('parseCliNdjsonLine triggers ACP dangerIntercept on destructive shell command', () => {
  const line = JSON.stringify({
    type: 'shell_exec',
    command: 'git push --force origin main',
  });
  const parsed = parseCliNdjsonLine('workbuddy', line, 43, '00:55:01');
  assert.ok(parsed.dangerIntercept);
  assert.equal(parsed.dangerIntercept.rule, 'NO_FORCE_PUSH');
  assert.equal(parsed.event?.kind, 'acp_intercept');
  assert.equal(parsed.event?.status, 'blocked');
});

test('OfflineSeqQueue buffers unacked envelopes and replays strictly after remoteLastAckSeq', () => {
  const queue = new OfflineSeqQueue(10);
  queue.enqueue({
    machineId: 'm1',
    seq: 10,
    ts: 1,
    payload: { type: 'HEARTBEAT', activeTaskIds: [], cpuLoad: 12 },
  });
  queue.enqueue({
    machineId: 'm1',
    seq: 12,
    ts: 2,
    payload: { type: 'STATE_ACK', taskId: 't1', state: 'RUNNING' },
  });
  queue.enqueue({
    machineId: 'm1',
    seq: 11,
    ts: 3,
    payload: { type: 'TERMINAL_CHUNK', taskId: 't1', chunk: 'ok' },
  });

  assert.equal(queue.pendingCount(), 2);
  const replay = queue.replayFrom(11);
  assert.deepEqual(
    replay.map((r) => r.seq),
    [12],
  );
  queue.ackUpTo(12);
  assert.equal(queue.pendingCount(), 0);
});

test('parseCliNdjsonLine 非法 JSON 纯文本高危命令同样触发 ACP 拦截（NO_ROOT_DELETE）', () => {
  // 先核对 stateMachine 真实规则，不猜正则
  assert.equal(detectDangerousCommand('rm -rf /').dangerous, true);
  assert.equal(detectDangerousCommand('rm -rf /').rule, 'NO_ROOT_DELETE');

  const parsed = parseCliNdjsonLine('workbuddy', 'rm -rf /', 5, '00:00:05');
  assert.ok(parsed.dangerIntercept, '非法 JSON 的纯文本命令不得绕过 Danger Gate');
  assert.equal(parsed.dangerIntercept.rule, 'NO_ROOT_DELETE');
  assert.equal(parsed.dangerIntercept.command, 'rm -rf /');
  assert.ok(parsed.dangerIntercept.reason.length > 0);
  // 与合法分支同结构：acp_intercept 事件 + BLOCKED terminalChunk
  assert.equal(parsed.event?.kind, 'acp_intercept');
  assert.equal(parsed.event?.status, 'blocked');
  assert.equal(parsed.event?.seq, 5);
  assert.equal(parsed.event?.id, 'ev-5');
  assert.ok(parsed.terminalChunk?.includes('[acp-guard] BLOCKED'));
});

test('parseCliNdjsonLine 非法 JSON 高危命令的 terminalChunk 与 event.detail 均脱敏', () => {
  const line = 'rm -rf / --token sk-live1234567890abcdef';
  assert.equal(detectDangerousCommand(line).rule, 'NO_ROOT_DELETE');
  const parsed = parseCliNdjsonLine('codex', line, 6);
  assert.equal(parsed.dangerIntercept?.rule, 'NO_ROOT_DELETE');
  assert.ok(parsed.terminalChunk);
  assert.equal(parsed.terminalChunk.includes('sk-live'), false);
  assert.ok(parsed.terminalChunk.includes('[REDACTED_API_KEY]'));
  assert.equal(parsed.event?.detail.includes('sk-live'), false);
  assert.ok(parsed.event?.detail.includes('[REDACTED_API_KEY]'));
});

test('parseCliNdjsonLine 非法 JSON 但非高危命令仍降级为脱敏 terminalChunk（回归）', () => {
  const parsed = parseCliNdjsonLine('codex', 'just a plain log line', 8);
  assert.equal(parsed.dangerIntercept, undefined);
  assert.equal(parsed.event, undefined);
  assert.equal(parsed.terminalChunk, 'just a plain log line');
});
