import type { MemoryAsset } from '../protocol';
import { findMatchedAcl } from '../memory/recallEngine';
import { ForbiddenError } from './types';
import type { Action, Principal, Role } from './types';

// ============================================================================
// RBAC 权限矩阵（下表即规格；每个集合是"累积后的有效权限集"）
// ----------------------------------------------------------------------------
//   viewer    : read, runtime:events
//   developer : viewer 的 + requirement:create, task:advance, runtime:spawn
//   reviewer  : viewer 的 + task:gate, memory:approve, teamai:write
//               （注意：reviewer 不继承 developer 的写权限，二者是并列分支）
//   admin     : 全部 8 个 Action
//
// 判定：主体只要拥有任一角色、且该角色有效权限集包含目标 action 即放行（取并集）。
//
// 覆盖性硬约束（优先级高于上表）：
//   匿名主体（authenticated === false）无论 roles 如何，最多只能执行 `read`；
//   任何写操作以及 runtime:events 一律拒绝。
// ============================================================================

const ALL_ACTIONS: Action[] = [
  'read',
  'requirement:create',
  'task:advance',
  'task:gate',
  'memory:approve',
  'teamai:write',
  'runtime:spawn',
  'runtime:events',
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set<Action>(['read', 'runtime:events']),
  developer: new Set<Action>([
    'read',
    'runtime:events',
    'requirement:create',
    'task:advance',
    'runtime:spawn',
  ]),
  reviewer: new Set<Action>([
    'read',
    'runtime:events',
    'task:gate',
    'memory:approve',
    'teamai:write',
  ]),
  admin: new Set<Action>(ALL_ACTIONS),
};

export function isAllowed(principal: Principal, action: Action): boolean {
  if (!principal.authenticated) {
    return action === 'read';
  }
  for (const role of principal.roles) {
    if (ROLE_PERMISSIONS[role]?.has(action)) return true;
  }
  return false;
}

export function assertAllowed(principal: Principal, action: Action): void {
  if (!isAllowed(principal, action)) {
    throw new ForbiddenError(principal, action);
  }
}

// 四级 ACL 复用 recallEngine.findMatchedAcl（team→project→user→agent），不重写。
// 规则：
//   1) ACL 不匹配 → false（即便 admin 也一样）；
//   2) 跨 team（principal.teamId !== asset.teamId）且不是 admin → false；
//   3) 其余情况（同 team 命中，或 admin 跨 team 命中）→ true。
export function canAccessAsset(principal: Principal, asset: MemoryAsset): boolean {
  const matchedAcl = findMatchedAcl(asset, {
    teamId: principal.teamId,
    projectId: principal.projectId,
    userId: principal.userId,
    agentId: principal.agentId,
  });
  if (matchedAcl === null) return false;

  const isAdmin = principal.roles.includes('admin');
  if (principal.teamId !== asset.teamId && !isAdmin) return false;
  return true;
}
