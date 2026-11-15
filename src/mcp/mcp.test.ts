import test from 'node:test';
import assert from 'node:assert/strict';

import type { DagNode, MemoryAsset } from '../protocol';
import { recallMemoryAssets } from '../memory/recallEngine';
import {
  MCP_PROTOCOL_VERSION,
  RPC_ERRORS,
  handleMcpMessage,
  isNotificationOnly,
  validateAgainstSchema,
} from './server';
import type { JsonRpcError, JsonRpcSuccess, McpContext } from './server';

function memory(overrides: Partial<MemoryAsset> = {}): MemoryAsset {
  const id = overrides.id ?? 'mem-1';
  return {
    id,
    teamId: 'team-platform-core',
    ownerId: 'lin.wei',
    assetType: 'L1_FACT',
    scope: 'team',
    status: 'published',
    title: 'PGVECTOR HNSW 调优事实',
    contentMd: 'HNSW m=16 ef_construction=200 时召回率与延迟最优',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    // ACL 必须显式声明四级之一，否则召回引擎按「未授权」排除。
    acl: [{ assetId: id, subjectType: 'team', subjectId: 'team-platform-core', permission: 'read' }],
    ...overrides,
  };
}

function task(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: 'task-1',
    reqId: 'req-1',
    title: '示例任务',
    role: 'builder',
    provider: 'codex',
    adapterMode: 'headless_json',
    dependsOn: [],
    state: 'HUMAN_GATE',
    retryCount: 1,
    maxRetries: 3,
    assignedMachine: 'mac-1',
    worktreeBranch: 'agent/task-1',
    worktreePath: '/tmp/wt/task-1',
    localPort: 4401,
    position: { x: 0, y: 0 },
    events: [],
    terminalLines: [],
    verifierChecks: [],
    lineComments: [],
    ...overrides,
  };
}

const MEMORIES: MemoryAsset[] = [
  memory({ id: 'mem-pub', status: 'published' }),
  memory({ id: 'mem-draft', status: 'draft', title: 'PGVECTOR 草案' }),
];

function makeCtx(): McpContext {
  return {
    recall: (query, caller, limit) => recallMemoryAssets(MEMORIES, query, caller, limit),
    getTask: (id) =>
      id === 'task-1' ? task() : id === 'task-2' ? task({ id: 'task-2', state: 'RUNNING' }) : undefined,
    listTasks: () => [task(), task({ id: 'task-2', state: 'RUNNING' }), task({ id: 'task-3', state: 'MERGED' })],
    countDrafts: () => MEMORIES.filter((m) => m.status === 'draft').length,
  };
}

const ctx = makeCtx();

function asSuccess(r: unknown): JsonRpcSuccess {
  assert.equal(Array.isArray(r), false, '期望单个响应而非数组');
  const obj = r as JsonRpcSuccess | JsonRpcError;
  assert.ok('result' in obj, `期望成功响应，实际：${JSON.stringify(obj)}`);
  return obj as JsonRpcSuccess;
}

function asError(r: unknown): JsonRpcError {
  const obj = r as JsonRpcSuccess | JsonRpcError;
  assert.ok('error' in obj, `期望错误响应，实际：${JSON.stringify(obj)}`);
  return obj as JsonRpcError;
}

test('mcp: initialize 返回协议版本、tools 能力与 serverInfo', () => {
  const res = asSuccess(
    handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx),
  );
  assert.equal(res.id, 1);
  const result = res.result as {
    protocolVersion: string;
    capabilities: { tools?: unknown };
    serverInfo: { name: string; version: string };
  };
  assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.ok(result.capabilities.tools, '必须声明 tools 能力');
  assert.equal(typeof result.serverInfo.name, 'string');
  assert.equal(typeof result.serverInfo.version, 'string');
});

test('mcp: initialize 对不支持的客户端版本回服务端支持版本（协商）', () => {
  const res = asSuccess(
    handleMcpMessage(
      { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2024-01-01' } },
      ctx,
    ),
  );
  assert.equal((res.result as { protocolVersion: string }).protocolVersion, MCP_PROTOCOL_VERSION);
});

test('mcp: ping 返回空结果对象', () => {
  const res = asSuccess(handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, ctx));
  assert.deepEqual(res.result, {});
});

test('mcp: tools/list 暴露三个工具且 inputSchema 结构合法', () => {
  const res = asSuccess(handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, ctx));
  const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.equal(tools.length, 3);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_task', 'list_blocked_tasks', 'recall_memory']);
  for (const t of tools) {
    assert.equal(typeof t.description, 'string');
    const schema = t.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, 'object');
    assert.ok(Array.isArray(schema.required));
  }
});

test('mcp: tools/call recall_memory 返回已发布记忆并排除 draft', () => {
  const res = asSuccess(
    handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'recall_memory',
          arguments: { query: 'HNSW', teamId: 'team-platform-core', limit: 5 },
        },
      },
      ctx,
    ),
  );
  const result = res.result as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent: { results: Array<{ id: string; status: string }>; excludedDraftsCount: number };
  };
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.structuredContent.results.every((m) => m.status === 'published'), true);
  assert.equal(
    result.structuredContent.results.some((m) => m.id === 'mem-draft'),
    false,
    'draft 记忆绝不能被召回',
  );
  assert.equal(result.structuredContent.excludedDraftsCount, 1);
});

test('mcp: recall_memory 空 query 被参数校验拦截（-32602）', () => {
  const err = asError(
    handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'recall_memory', arguments: { query: '' } },
      },
      ctx,
    ),
  );
  assert.equal(err.error.code, RPC_ERRORS.INVALID_PARAMS);
});

test('mcp: recall_memory 传入未声明参数被拒（additionalProperties:false）', () => {
  const err = asError(
    handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'recall_memory', arguments: { query: 'a', hacker: 'x' } },
      },
      ctx,
    ),
  );
  assert.equal(err.error.code, RPC_ERRORS.INVALID_PARAMS);
  assert.match(err.error.message, /不支持的参数/);
});

test('mcp: limit 越界被拒（-32602）', () => {
  const err = asError(
    handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'recall_memory', arguments: { query: 'a', limit: 999 } },
      },
      ctx,
    ),
  );
  assert.equal(err.error.code, RPC_ERRORS.INVALID_PARAMS);
});

test('mcp: 未知工具返回 -32602', () => {
  const err = asError(
    handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'drop_database', arguments: {} },
      },
      ctx,
    ),
  );
  assert.equal(err.error.code, RPC_ERRORS.INVALID_PARAMS);
});

test('mcp: get_task 命中返回真实状态与验证结果', () => {
  const res = asSuccess(
    handleMcpMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_task', arguments: { taskId: 'task-1' } } },
      ctx,
    ),
  );
  const result = res.result as { structuredContent: { id: string; state: string; retryCount: number } };
  assert.equal(result.structuredContent.id, 'task-1');
  assert.equal(result.structuredContent.state, 'HUMAN_GATE');
  assert.equal(result.structuredContent.retryCount, 1);
});

test('mcp: get_task 不存在是工具级错误（isError），不是协议错误', () => {
  const res = asSuccess(
    handleMcpMessage(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_task', arguments: { taskId: 'nope' } } },
      ctx,
    ),
  );
  const result = res.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /任务不存在/);
});

test('mcp: list_blocked_tasks 只返回需要介入的状态', () => {
  const res = asSuccess(
    handleMcpMessage(
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_blocked_tasks', arguments: {} } },
      ctx,
    ),
  );
  const result = res.result as { structuredContent: { tasks: Array<{ id: string; state: string }> } };
  const ids = result.structuredContent.tasks.map((t) => t.id);
  assert.deepEqual(ids, ['task-1'], 'RUNNING / MERGED 不应出现');
});

test('mcp: 未知方法返回 -32601', () => {
  const err = asError(handleMcpMessage({ jsonrpc: '2.0', id: 12, method: 'resources/list' }, ctx));
  assert.equal(err.error.code, RPC_ERRORS.METHOD_NOT_FOUND);
});

test('mcp: 缺 jsonrpc 或 method 返回 -32600', () => {
  for (const bad of [
    { id: 1, method: 'ping' },
    { jsonrpc: '1.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3 },
    { jsonrpc: '2.0', id: { bad: true }, method: 'ping' },
    {},
    42,
  ]) {
    const err = asError(handleMcpMessage(bad, ctx));
    assert.equal(err.error.code, RPC_ERRORS.INVALID_REQUEST, JSON.stringify(bad));
  }
});

test('mcp: 非 JSON 文本走 -32700（字符串输入按 JSON 解析）', () => {
  for (const bad of ['not an object', '{', '[]x']) {
    const err = asError(handleMcpMessage(bad, ctx));
    assert.equal(err.error.code, RPC_ERRORS.PARSE, JSON.stringify(bad));
  }
});

test('mcp: 非法 JSON 字符串返回 -32700', () => {
  const err = asError(handleMcpMessage('{"jsonrpc": "2.0", ', ctx));
  assert.equal(err.error.code, RPC_ERRORS.PARSE);
});

test('mcp: 通知无 id 时不回包（null）', () => {
  const r = handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx);
  assert.equal(r, null);
  assert.equal(isNotificationOnly(r), true);
  // 未声明的通知也按规范静默忽略，而不是报错
  assert.equal(handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/whatever' }, ctx), null);
});

test('mcp: 批量请求只返回有 id 的响应，顺序保持一致', () => {
  const r = handleMcpMessage(
    [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b1', method: 'ping' },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/list' },
    ],
    ctx,
  );
  assert.ok(Array.isArray(r));
  const arr = r as JsonRpcSuccess[];
  assert.equal(arr.length, 2);
  assert.deepEqual(arr.map((x) => x.id), ['b1', 'b2']);
});

test('mcp: 空批量返回 -32600 单条错误', () => {
  const err = asError(handleMcpMessage([], ctx));
  assert.equal(err.error.code, RPC_ERRORS.INVALID_REQUEST);
});

test('mcp: 全通知批量返回 null（无内容可回）', () => {
  assert.equal(
    handleMcpMessage([{ jsonrpc: '2.0', method: 'notifications/initialized' }], ctx),
    null,
  );
});

test('mcp: JSON Schema 校验器覆盖整数边界与非对象入参', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1, maximum: 3 } },
    required: ['n'],
  };
  assert.equal(validateAgainstSchema({ n: 2 }, schema).ok, true);
  assert.equal(validateAgainstSchema({ n: 0 }, schema).ok, false);
  assert.equal(validateAgainstSchema({ n: 4 }, schema).ok, false);
  assert.equal(validateAgainstSchema({ n: 2.5 }, schema).ok, false);
  assert.equal(validateAgainstSchema([], schema).ok, false);
  assert.equal(validateAgainstSchema({}, schema).ok, false);
});
