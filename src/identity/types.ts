// 团队化协作底座的公共契约：身份主体、动作、审计行、身份提供者与权限错误。
// 业务侧只依赖这些类型/接口，不依赖任何具体身份后端（OIDC / SSO / 本地 dev adapter）。

export type Role = 'viewer' | 'developer' | 'reviewer' | 'admin';

export type Action =
  | 'read'
  | 'requirement:create'
  | 'task:advance'
  | 'task:gate'
  | 'memory:approve'
  // 提交记忆草案（MCP propose_memory）：只产出 draft，发布仍走 memory:approve 人审
  | 'memory:propose'
  | 'teamai:write'
  | 'runtime:spawn'
  | 'runtime:events'
  // 平台级破坏性操作（重置状态等）：只有 admin 可执行，不接受角色并集降级。
  | 'admin:reset';

export interface Principal {
  userId: string;
  teamId: string;
  projectId?: string;
  agentId?: string;
  roles: Role[];
  authenticated: boolean;
}

export interface IdentityProvider {
  resolve(headers: Record<string, string | string[] | undefined>): Principal;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  userId: string;
  teamId: string;
  action: Action;
  target: string;
  outcome: 'allowed' | 'denied' | 'applied';
  detail?: string;
}

export class ForbiddenError extends Error {
  constructor(
    public readonly principal: Principal,
    public readonly action: Action,
  ) {
    super(
      `Forbidden: principal userId=${principal.userId} (teamId=${principal.teamId}) ` +
        `is not allowed to perform action=${action}`,
    );
    this.name = 'ForbiddenError';
  }
}
