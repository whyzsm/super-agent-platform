import type { DagNode } from '../protocol';
import type { RecallResult } from '../memory/recallEngine';

/**
 * MCP（Model Context Protocol）服务端实现：JSON-RPC 2.0 语义 + tools 能力。
 *
 * 之前 `/api/mcp/recall` 只是一个普通 HTTP POST，任何模型客户端都无法用标准 MCP
 * 握手接进来。本模块把协议层做真：
 *   - 严格的 JSON-RPC 2.0 校验（jsonrpc 字面量、id、method、params）；
 *   - 标准错误码：-32700 解析失败 / -32600 非法请求 / -32601 方法不存在 / -32602 参数非法 / -32603 内部错误；
 *   - 支持 initialize / notifications/initialized / ping / tools/list / tools/call；
 *   - 支持批量请求，按规范对「全为通知」的批量不返回任何内容；
 *   - 工具级失败（如任务不存在）用 isError 内容表达，不升级成协议错误。
 *
 * 依赖通过 McpContext 注入，模块本身不依赖 server 内部状态，便于单测与复用。
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_INFO = { name: 'superagent-memory', version: '1.0.0' } as const;

export interface JsonRpcId {
  id: string | number | null;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export const RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export interface RecallCaller {
  teamId: string;
  projectId?: string;
  userId?: string;
  agentId?: string;
}

export interface McpContext {
  /** 按四级 ACL 召回记忆（实现方负责按 ACL 过滤；本模块再兜底剔除 draft） */
  recall(query: string, caller: RecallCaller, limit: number): RecallResult[];
  getTask(taskId: string): DagNode | undefined;
  listTasks(): DagNode[];
  countDrafts(): number;
  /** 注入当前时间以便测试；默认 new Date() */
  now?(): Date;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const RECALL_TOOL: ToolDef = {
  name: 'recall_memory',
  title: '团队记忆召回',
  description:
    '按团队 / 项目 / 用户 / Agent 四级 ACL 召回已发布（published）的团队记忆资产；draft 状态的草案永不返回。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: '自然语言或关键词查询' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数上限，默认 6' },
      teamId: { type: 'string', description: '调用方团队 ID，缺省用服务端默认团队' },
      projectId: { type: 'string', description: '项目 ID（ACL 一级）' },
      userId: { type: 'string', description: '用户 ID（ACL 一级）' },
      agentId: { type: 'string', description: 'Agent ID（ACL 一级）' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

const GET_TASK_TOOL: ToolDef = {
  name: 'get_task',
  title: '查询任务节点',
  description: '按 taskId 查询 DAG 任务节点的真实状态、重试次数、门禁检查点与验证结果摘要。',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', minLength: 1, description: '任务节点 ID，如 task-2041-b1' },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
};

const LIST_BLOCKED_TOOL: ToolDef = {
  name: 'list_blocked_tasks',
  title: '列出待处理任务',
  description:
    '列出需要人工或调度器介入的任务：HUMAN_GATE / WAITING_APPROVAL / RETRY_WAIT / BLOCKED_BY_RESOURCE / QUARANTINED。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数上限，默认 20' },
    },
    required: [],
    additionalProperties: false,
  },
};

const TOOLS: ToolDef[] = [RECALL_TOOL, GET_TASK_TOOL, LIST_BLOCKED_TOOL];

const NEEDS_ATTENTION = new Set([
  'HUMAN_GATE',
  'WAITING_APPROVAL',
  'RETRY_WAIT',
  'BLOCKED_BY_RESOURCE',
  'QUARANTINED',
]);

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcErrorBody = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(payload: unknown, isError = false) {
  const base = {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
  // isError 按 MCP 规范可省略（默认 false）；只在失败时显式置位，避免客户端误读。
  return isError ? { ...base, isError: true as const } : base;
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isJsonRpcId(v: unknown): v is string | number | null {
  return v === null || typeof v === 'string' || typeof v === 'number';
}

/** 校验单个请求信封；返回 null 表示结构合法。 */
function validateEnvelope(msg: unknown): JsonRpcErrorBody | null {
  if (!isPlainObject(msg)) {
    return { code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: 请求必须是 JSON 对象' };
  }
  if (msg.jsonrpc !== '2.0') {
    return { code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: jsonrpc 必须为 "2.0"' };
  }
  if (typeof msg.method !== 'string' || msg.method.trim() === '') {
    return { code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: method 必须是非空字符串' };
  }
  if ('id' in msg && !isJsonRpcId(msg.id)) {
    return {
      code: RPC_ERRORS.INVALID_REQUEST,
      message: 'Invalid Request: id 必须是 string / number / null',
    };
  }
  if ('params' in msg && msg.params !== undefined && !isPlainObject(msg.params) && !Array.isArray(msg.params)) {
    return { code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: params 必须是对象或数组' };
  }
  return null;
}

interface SchemaCheck {
  ok: boolean;
  message?: string;
}

/** 最小 JSON Schema 校验：覆盖本仓库工具用到的 type / required / minLength / minimum / maximum / additionalProperties。 */
export function validateAgainstSchema(
  input: unknown,
  schema: Record<string, unknown>,
): SchemaCheck {
  if (!isPlainObject(input)) return { ok: false, message: '参数必须是 JSON 对象' };

  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  for (const key of required) {
    if (!(key in input) || input[key] === undefined || input[key] === null) {
      return { ok: false, message: `缺少必填参数：${key}` };
    }
  }

  if (schema.additionalProperties === false) {
    const extra = Object.keys(input).filter((k) => !(k in props));
    if (extra.length) return { ok: false, message: `不支持的参数：${extra.join(', ')}` };
  }

  for (const [key, rawRule] of Object.entries(input)) {
    if (rawRule === undefined) continue;
    const rule = isPlainObject(props[key]) ? (props[key] as Record<string, unknown>) : undefined;
    if (!rule) continue;

    const type = rule.type;
    if (type === 'string') {
      if (typeof rawRule !== 'string') return { ok: false, message: `参数 ${key} 必须是 string` };
      const minLength = typeof rule.minLength === 'number' ? rule.minLength : 0;
      if (rawRule.length < minLength) {
        return { ok: false, message: `参数 ${key} 长度不足 ${minLength}` };
      }
    } else if (type === 'integer') {
      if (typeof rawRule !== 'number' || !Number.isInteger(rawRule)) {
        return { ok: false, message: `参数 ${key} 必须是整数` };
      }
      if (typeof rule.minimum === 'number' && rawRule < rule.minimum) {
        return { ok: false, message: `参数 ${key} 不得小于 ${rule.minimum}` };
      }
      if (typeof rule.maximum === 'number' && rawRule > rule.maximum) {
        return { ok: false, message: `参数 ${key} 不得大于 ${rule.maximum}` };
      }
    } else if (type === 'boolean' && typeof rawRule !== 'boolean') {
      return { ok: false, message: `参数 ${key} 必须是 boolean` };
    }
  }

  return { ok: true };
}

function serializeTask(node: DagNode) {
  return {
    id: node.id,
    reqId: node.reqId,
    title: node.title,
    role: node.role,
    provider: node.provider,
    adapterMode: node.adapterMode,
    state: node.state,
    dependsOn: node.dependsOn,
    retryCount: node.retryCount,
    maxRetries: node.maxRetries,
    worktreeBranch: node.worktreeBranch,
    worktreePath: node.worktreePath,
    assignedMachine: node.assignedMachine,
    verifierChecks: node.verifierChecks?.map((c) => ({
      name: c.name,
      passed: c.passed,
      durationMs: c.durationMs,
      summary: c.summary,
    })),
    lastErrorFeedback: node.lastErrorFeedback,
  };
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): { ok: true; result: unknown } | { ok: false; code: number; message: string } {
  switch (name) {
    case 'recall_memory': {
      const query = String(args.query);
      const limit = typeof args.limit === 'number' ? args.limit : 6;
      const caller: RecallCaller = {
        teamId: typeof args.teamId === 'string' ? args.teamId : 'team-platform-core',
        projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
        userId: typeof args.userId === 'string' ? args.userId : undefined,
        agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
      };
      const results = ctx.recall(query, caller, limit);
      // 兜底：即便召回实现出错放进了 draft，也绝不外泄草案。
      const published = results.filter((r) => r.asset.status === 'published');
      return {
        ok: true,
        result: toolResult({
          tool: 'recall_memory',
          caller,
          results: published.map((r) => ({
            id: r.asset.id,
            title: r.asset.title,
            assetType: r.asset.assetType,
            contentMd: r.asset.contentMd,
            status: r.asset.status,
            score: Number(r.score.toFixed(4)),
            matchedAcl: r.matchedAcl,
          })),
          excludedDraftsCount: ctx.countDrafts(),
        }),
      };
    }
    case 'get_task': {
      const task = ctx.getTask(String(args.taskId));
      if (!task) return { ok: true, result: toolError(`任务不存在：${String(args.taskId)}`) };
      return { ok: true, result: toolResult(serializeTask(task)) };
    }
    case 'list_blocked_tasks': {
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const tasks = ctx
        .listTasks()
        .filter((t) => NEEDS_ATTENTION.has(t.state))
        .slice(0, limit)
        .map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          retryCount: t.retryCount,
          assignedMachine: t.assignedMachine,
        }));
      return { ok: true, result: toolResult({ total: tasks.length, tasks }) };
    }
    default:
      return { ok: false, code: RPC_ERRORS.INVALID_PARAMS, message: `未知工具：${name}` };
  }
}

function handleSingle(msg: unknown, ctx: McpContext): JsonRpcResponse | null {
  const envelopeError = validateEnvelope(msg);
  if (envelopeError) {
    const rawId = isPlainObject(msg) && 'id' in msg && isJsonRpcId(msg.id) ? (msg.id as JsonRpcId['id']) : null;
    return rpcError(rawId, envelopeError.code, envelopeError.message);
  }

  const req = msg as JsonRpcRequest;
  const hasId = 'id' in req;
  const id = hasId ? (req.id as JsonRpcId['id']) : null;
  const params = isPlainObject(req.params) ? req.params : {};

  // 通知（无 id）：执行副作用但不回包。当前仅 initialized 属通知。
  if (!hasId) {
    if (req.method === 'notifications/initialized') return null;
    // 未知通知按规范应忽略，不回错误报文。
    return null;
  }

  switch (req.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return success(id, {
        protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          'SuperAgent 团队研发管理平台记忆与任务查询服务。工具调用受四级 ACL 与 Q5 人审红线约束，draft 记忆永不返回。',
      });
    }
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !name.trim()) {
        return rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call 需要 string 类型的 name');
      }
      const def = TOOLS.find((t) => t.name === name);
      if (!def) {
        return rpcError(id, RPC_ERRORS.INVALID_PARAMS, `未知工具：${name}`);
      }
      const args = params.arguments === undefined ? {} : params.arguments;
      const checked = validateAgainstSchema(args, def.inputSchema);
      if (!checked.ok) {
        return rpcError(id, RPC_ERRORS.INVALID_PARAMS, `参数校验失败：${checked.message}`, {
          tool: name,
        });
      }
      const outcome = callTool(name, args as Record<string, unknown>, ctx);
      if (!outcome.ok) {
        return rpcError(id, outcome.code, outcome.message);
      }
      return success(id, outcome.result);
    }
    default:
      return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `方法不存在：${req.method}`);
  }
}

/**
 * 处理一条 JSON-RPC 报文（对象 / 数组 / 原始字符串）。
 * 返回 null 表示「无需回包」（纯通知）；数组请求返回响应数组（全通知时也为 null）。
 */
export function handleMcpMessage(
  raw: unknown,
  ctx: McpContext,
): JsonRpcResponse | JsonRpcResponse[] | null {
  let payload = raw;

  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return rpcError(null, RPC_ERRORS.PARSE, 'Parse error: 报文不是合法 JSON');
    }
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request: 批量请求不能为空数组');
    }
    const responses = payload
      .map((item) => handleSingle(item, ctx))
      .filter((r): r is JsonRpcResponse => r !== null);
    return responses.length ? responses : null;
  }

  return handleSingle(payload, ctx);
}

/** 供 HTTP 层判断：结果为 null 时按 JSON-RPC 规范应回 202 无内容。 */
export function isNotificationOnly(
  result: JsonRpcResponse | JsonRpcResponse[] | null,
): result is null {
  return result === null;
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
