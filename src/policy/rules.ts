import type { Action } from '../identity/types';

/**
 * 策略规则集（S2-9）：全平台唯一的声明式策略数据。
 *
 * 收敛前规则散落四处：stateMachine.ts 的危险命令正则与脱敏正则、
 * server/middleware.ts 的路由动作表、worktreeManager.ts 的 taskId/baseRef
 * 白名单。现在规则数据全部在本文件，求值逻辑在 engine.ts / routeActions.ts，
 * 逐规则正反例见 policy.test.ts。
 *
 * 约定：
 * - `code` 是稳定规则代号，属对外契约（拦截事件、UI 文案、审计引用），不得随意改名；
 * - 危险命令规则按数组顺序求值，**首条命中即返回**，调整顺序会改变拦截优先级；
 * - 改规则必须同步补 policy.test.ts 的正反例。
 */

export interface DangerCommandRule {
  /** 稳定规则代号（出口字段名为 rule），对外契约，勿改名 */
  code: string;
  /** 规则说明（审计与文档用，不进入运行时判定） */
  description: string;
  /** 命中即判定危险 */
  regex: RegExp;
  /** 面向用户的拦截原因（中文文案） */
  reason: string;
}

export const DANGER_COMMAND_RULES: readonly DangerCommandRule[] = [
  {
    code: 'NO_ROOT_DELETE',
    description: '禁止递归删除根目录',
    regex: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$|\*)/i,
    reason: '检测到高危根目录删除命令 (rm -rf /)，触发 Danger Gate 拦截。',
  },
  {
    code: 'NO_DESTRUCTIVE_SQL',
    description: '禁止不可逆数据库结构删除',
    regex: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    reason: '检测到不可逆数据库结构删除语句 (DROP TABLE/DATABASE)，触发 Danger Gate 拦截。',
  },
  {
    code: 'NO_FORCE_PUSH',
    description: '禁止强推改写远端历史',
    regex: /\bgit\s+push\s+(--force|-f)\b/i,
    reason: '检测到强推历史提交命令 (git push --force)，触发 Danger Gate 拦截。',
  },
  {
    code: 'SENSITIVE_PATH_GUARD',
    description: '禁止访问沙箱白名单之外的敏感路径',
    regex: /(^|\s)(\/etc\/|\.env(\.local|\.production)?\b|~\/\.ssh\/)/i,
    reason: '检测到越权访问沙箱白名单之外的敏感文件 (.env / ~/.ssh / /etc)，触发 Danger Gate 拦截。',
  },
];

export interface RedactionRule {
  /** 稳定规则代号 */
  code: string;
  /** 规则说明 */
  description: string;
  /** 全局匹配；含捕获组的 replacement 用 $1/$2 引用 */
  regex: RegExp;
  replacement: string;
}

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    code: 'OPENAI_API_KEY',
    description: 'sk- 开头的 API key',
    regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    code: 'GITHUB_TOKEN',
    description: 'ghp_ 开头的 GitHub token',
    regex: /\bghp_[A-Za-z0-9]{16,}\b/g,
    replacement: '[REDACTED_GH_TOKEN]',
  },
  {
    code: 'AWS_ACCESS_KEY',
    description: 'AKIA 开头的 AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    code: 'BEARER_TOKEN',
    description: 'Authorization Bearer 令牌（保留方案前缀）',
    regex: /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi,
    replacement: '$1[REDACTED_BEARER_TOKEN]',
  },
  {
    code: 'DB_CONNECTION_PASSWORD',
    description: 'postgres 连接串口令（保留用户名与主机）',
    regex: /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi,
    replacement: '$1[REDACTED_DB_PASS]$2',
  },
  {
    code: 'EMAIL',
    description: '邮箱地址（PII）',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
];

/**
 * worktree taskId / baseRef 白名单（原 worktreeManager.ts 的 TASK_ID_RE / BASE_REF_RE）。
 * 白名单即策略：改这里等于改允许的 worktree 命名面，必须同步 worktreeManager 测试。
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** 路由动作登记表：每条 /api 路由需要的最小 Action。写方法未登记 → fail-closed 403。 */
export const ROUTE_ACTIONS: ReadonlyArray<readonly [method: string, re: RegExp, action: Action]> = [
  ['GET', /^\/api\/(health|bootstrap|stream)$/, 'read'],
  ['GET', /^\/api\/runtime\/(audit|commands)$/, 'read'],
  ['GET', /^\/api\/runtime\/events$/, 'runtime:events'],
  ['GET', /^\/api\/webhooks\/im\/card\/[^/]+$/, 'read'],
  ['POST', /^\/api\/requirements$/, 'requirement:create'],
  ['POST', /^\/api\/requirements\/[^/]+\/solidify-sop$/, 'teamai:write'],
  ['POST', /^\/api\/tasks\/[^/]+\/advance$/, 'task:advance'],
  ['POST', /^\/api\/tasks\/[^/]+\/input$/, 'task:advance'],
  ['POST', /^\/api\/tasks\/[^/]+\/comments$/, 'task:advance'],
  ['POST', /^\/api\/tasks\/[^/]+\/resource-transition$/, 'task:advance'],
  ['POST', /^\/api\/tasks\/[^/]+\/simulate-(failure|danger)$/, 'task:advance'],
  ['POST', /^\/api\/tasks\/[^/]+\/gate$/, 'task:gate'],
  ['POST', /^\/api\/tasks\/[^/]+\/retrospective$/, 'read'],
  ['POST', /^\/api\/tasks\/[^/]+\/real-spawn$/, 'runtime:spawn'],
  ['POST', /^\/api\/tasks\/[^/]+\/ndjson$/, 'runtime:spawn'],
  ['POST', /^\/api\/daemons\/[^/]+\/replay$/, 'runtime:spawn'],
  ['POST', /^\/api\/mcp$/, 'read'],
  ['POST', /^\/api\/mcp\/recall$/, 'read'],
  ['POST', /^\/api\/memories\/[^/]+\/(approve|reject)$/, 'memory:approve'],
  ['POST', /^\/api\/teamai$/, 'teamai:write'],
  ['PUT', /^\/api\/teamai$/, 'teamai:write'],
  ['POST', /^\/api\/tasks\/[^/]+\/worktree$/, 'runtime:spawn'],
  ['DELETE', /^\/api\/tasks\/[^/]+\/worktree$/, 'runtime:spawn'],
  ['POST', /^\/api\/reset$/, 'admin:reset'],
];
