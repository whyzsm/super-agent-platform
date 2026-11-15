import { createPublicKey, verify as cryptoVerify, createHash } from 'node:crypto';
import type { IdentityProvider, Principal, Role } from './types';

/**
 * OIDC IdentityProvider 适配器（S2-1）：从 Authorization: Bearer 头验 RS256 JWT。
 *
 * 零依赖实现（node:crypto + fetch）：
 * - JWKS 按kid 选取并缓存（TTL + 失败回源）；
 * - 验签 RSA-SHA256 + exp/iss 校验，claims 映射 Principal
 *   （preferred_username -> userId；realm_access.roles ∩ 合法角色）；
 * - 无 token / 验签失败 / 过期 -> 匿名 viewer（与 localProvider 匿名语义一致，fail-safe）。
 *
 * 本地单测用 node:http 起真 JWKS 服务 + 自签 RSA JWT，全链路真实验证（无需 Keycloak）；
 * Keycloak 端到端（真实 realm/client/token）见集成验证与 D-16。
 */

const VALID_ROLES: ReadonlySet<string> = new Set<Role>([
  'viewer', 'developer', 'reviewer', 'admin',
]);

export interface OidcIdentityProviderOptions {
  /** issuer，如 https://127.0.0.1:8080/realms/superagent；token 的 iss 必须精确匹配 */
  issuer: string;
  /** JWKS 地址；缺省 \`\${issuer}/protocol/openid-connect/certs\`（Keycloak 形态） */
  jwksUrl?: string;
  /** JWKS 缓存毫秒，默认 5 分钟 */
  jwksCacheMs?: number;
  /** 验签时钟容忍毫秒，默认 60s */
  clockToleranceMs?: number;
  /** 注入 fetch（测试替身）；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

function b64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 解码 JWT 各段（不验签）；结构非法返回 null。 */
function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: Buffer; signature: Buffer } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlToBuffer(parts[0]).toString('utf-8')) as Record<string, unknown>;
    const payload = JSON.parse(b64urlToBuffer(parts[1]).toString('utf-8')) as Record<string, unknown>;
    return {
      header,
      payload,
      signingInput: Buffer.from(parts[0] + '.' + parts[1], 'ascii'),
      signature: b64urlToBuffer(parts[2]),
    };
  } catch {
    return null;
  }
}

/** RS256 验签（严格 alg 混淆防护：只接受 alg=RS256 的 token 与 RSA JWKS key）。 */
function verifyRs256(signingInput: Buffer, signature: Buffer, jwk: Jwk): boolean {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return false;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as never, format: 'jwk' });
    return cryptoVerify('RSA-SHA256', signingInput, key, signature);
  } catch {
    return false;
  }
}

/** 与 localProvider 相同的兜底：匿名 viewer。 */
const ANONYMOUS: Principal = {
  userId: 'anonymous',
  teamId: 'anonymous',
  roles: ['viewer'],
  authenticated: false,
};

export interface OidcIdentityProvider extends IdentityProvider {
  /** 预热 JWKS 缓存；resolve 是同步契约，未预热时一律匿名（fail-safe）。 */
  warmup(): Promise<void>;
}

export function createOidcIdentityProvider(
  options: OidcIdentityProviderOptions,
): OidcIdentityProvider {
  const jwksUrl = options.jwksUrl ?? `${options.issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const cacheMs = options.jwksCacheMs ?? 5 * 60_000;
  const clockToleranceMs = options.clockToleranceMs ?? 60_000;

  let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

  async function fetchJwks(): Promise<Jwk[]> {
    if (jwksCache && Date.now() - jwksCache.fetchedAt < cacheMs) return jwksCache.keys;
    const res = await fetchImpl(jwksUrl);
    if (!res.ok) throw new Error(`[OidcIdentityProvider] JWKS 获取失败 (${res.status}): ${jwksUrl}`);
    const body = JSON.parse(await res.text()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new Error('[OidcIdentityProvider] JWKS 响应缺少 keys 数组');
    jwksCache = { keys: body.keys, fetchedAt: Date.now() };
    return body.keys;
  }

  /** 同步接口约束下的折衷：resolve 同步返回；首次 JWKS 抓取经 warmup() 预热。 */
  async function warmup(): Promise<void> {
    await fetchJwks();
  }

  function resolve(headers: Record<string, string | string[] | undefined>): Principal {
    const raw = headers['authorization'];
    const bearer = Array.isArray(raw) ? raw[0] : raw;
    if (!bearer || !bearer.startsWith('Bearer ')) return ANONYMOUS;
    const token = bearer.slice('Bearer '.length).trim();
    const decoded = decodeJwt(token);
    if (!decoded) return ANONYMOUS;
    if (decoded.header.alg !== 'RS256') return ANONYMOUS;

    const { payload } = decoded;
    // exp / iss 校验（exp 以秒计；容忍时钟偏移）
    const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : Number.NaN;
    if (!Number.isFinite(exp) || Date.now() > exp + clockToleranceMs) return ANONYMOUS;
    if (payload.iss !== options.issuer) return ANONYMOUS;
    if (typeof payload.preferred_username !== 'string') return ANONYMOUS;

    // 验签（JWKS 必须已缓存；未预热/未命中 kid 一律拒绝，绝不放行未验签 token）
    if (!jwksCache) return ANONYMOUS;
    const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : undefined;
    const candidates = jwksCache.keys.filter((k) => (kid ? k.kid === kid : k.kty === 'RSA'));
    const ok = candidates.some((k) => verifyRs256(decoded.signingInput, decoded.signature, k));
    if (!ok) return ANONYMOUS;

    const realmRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles: Role[] = Array.isArray(realmRoles)
      ? realmRoles.filter((r): r is Role => typeof r === 'string' && VALID_ROLES.has(r as Role))
      : [];
    return {
      userId: payload.preferred_username,
      teamId: typeof payload.teamId === 'string' ? payload.teamId : (options.issuer.includes('localhost') || options.issuer.includes('127.0.0.1') ? 'team-local' : 'anonymous'),
      roles: roles.length > 0 ? roles : ['viewer'],
      authenticated: true,
    };
  }

  return { resolve, warmup };
}

/** 测试辅助：生成 RSA 密钥对 + 自签 RS256 JWT（与 Keycloak 签发形态一致）。 */
export async function mintTestJwt(opts: {
  issuer: string;
  username: string;
  roles: string[];
  audience?: string;
  expiresInSeconds: number;
  signingKey: { kty: 'RSA'; n: string; e: string };
  privateKeyPem: string;
  kid?: string;
  issuedAtMs?: number;
}): Promise<string> {
  const { createSign } = await import('node:crypto');
  const header = { alg: 'RS256', typ: 'JWT', ...(opts.kid ? { kid: opts.kid } : {}) };
  const nowSec = Math.floor((opts.issuedAtMs ?? Date.now()) / 1000);
  const payload = {
    iss: opts.issuer,
    sub: opts.username,
    preferred_username: opts.username,
    realm_access: { roles: opts.roles },
    iat: nowSec,
    exp: nowSec + opts.expiresInSeconds,
    ...(opts.audience ? { aud: opts.audience } : {}),
  };
  const b64url = (buf: Buffer) =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(opts.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/** 测试辅助：JWK（公钥）导出。 */
export async function exportTestJwk(publicKeyPem: string, kid: string): Promise<Jwk> {
  const { createPublicKey } = await import('node:crypto');
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...(jwk as unknown as Jwk), kid, alg: 'RS256', use: 'sig' };
}

/** 测试辅助：极简 JWKS HTTP 服务（随机端口）。 */
export async function startTestJwksServer(jwks: { keys: Jwk[] }): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('jwks listen failed');
  return {
    url: `http://127.0.0.1:${addr.port}/certs`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 哈希工具（导出便于测试对齐）。 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
