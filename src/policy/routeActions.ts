import type { Action } from '../identity/types';
import { ROUTE_ACTIONS } from './rules';

/**
 * 路由动作求值（S2-9）：对 ROUTE_ACTIONS 登记表求值。
 *
 - 历史教训（handoff 缺陷 #2）：`actionFor()` 曾对未登记路由默认返回 `task:advance`，
 * 导致只读端点要求写权限、`/api/reset` 任何开发者都能调。现在写操作未登记时
 * fail-closed（403 + 审计 denied），新增写端点必须先在 rules.ts 登记。
 */
export function actionFor(method: string, url: string): Action | 'exempt' | null {
  // IM 回调由 HMAC-SHA256 + 300s 防重放独立鉴权，豁免 RBAC。
  if (method === 'POST' && url === '/api/webhooks/im') return 'exempt';
  for (const [m, re, action] of ROUTE_ACTIONS) {
    if (m === method && re.test(url)) return action;
  }
  // 只读方法兜底为 read（不扩大权限面）；写方法未登记则返回 null（调用方 fail-closed）。
  return method === 'GET' ? 'read' : null;
}
