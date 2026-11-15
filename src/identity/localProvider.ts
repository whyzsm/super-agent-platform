import type { IdentityProvider, Principal, Role } from './types';

// ============================================================================
// 可替换的 dev adapter（本地身份提供者）
// ----------------------------------------------------------------------------
// 本机没有 OIDC / SSO 时，用请求头里的身份字段构造 Principal，让团队化协作
// （身份 / RBAC / 四级 ACL / 审计）可以完整跑通，消解「没有 SSO 就做不了团队化」。
//
// 生产接入 OIDC / SSO 时：实现同一个 IdentityProvider 接口（例如从已校验的 JWT /
// session 中解析 userId、teamId、roles），在装配处替换本 provider 即可，业务代码
// （rbac.ts 以及 server.ts 的调用方）无需任何改动。
// ============================================================================

const VALID_ROLES: ReadonlySet<string> = new Set<Role>([
  'viewer',
  'developer',
  'reviewer',
  'admin',
]);

// header 值既可能是 string，也可能是 string[]；按约定取第一项。
function firstValue(value: string | string[] | undefined): string | undefined {
  const picked = Array.isArray(value) ? value[0] : value;
  if (picked === undefined) return undefined;
  const trimmed = picked.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRoles(raw: string | undefined): Role[] {
  if (raw === undefined) return ['viewer'];
  const roles = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is Role => VALID_ROLES.has(part));
  // 最小权限兜底：无合法角色时退化为 viewer。
  return roles.length > 0 ? roles : ['viewer'];
}

export function createLocalIdentityProvider(): IdentityProvider {
  return {
    resolve(headers: Record<string, string | string[] | undefined>): Principal {
      const user = firstValue(headers['x-superagent-user']);
      const team = firstValue(headers['x-superagent-team']);
      const project = firstValue(headers['x-superagent-project']);
      const agent = firstValue(headers['x-superagent-agent']);
      const rolesRaw = firstValue(headers['x-superagent-roles']);

      const anyProvided =
        user !== undefined ||
        team !== undefined ||
        project !== undefined ||
        agent !== undefined ||
        rolesRaw !== undefined;

      // 所有身份头都缺失（或全为空值）→ 匿名主体。
      if (!anyProvided) {
        return {
          userId: 'anonymous',
          teamId: 'anonymous',
          roles: ['viewer'],
          authenticated: false,
        };
      }

      const principal: Principal = {
        userId: user ?? 'anonymous',
        teamId: team ?? 'anonymous',
        roles: parseRoles(rolesRaw),
        authenticated: true,
      };
      if (project !== undefined) principal.projectId = project;
      if (agent !== undefined) principal.agentId = agent;
      return principal;
    },
  };
}
