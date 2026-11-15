import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  createOidcIdentityProvider,
  exportTestJwk,
  mintTestJwt,
  startTestJwksServer,
} from './oidcProvider';

/**
 * OIDC 适配器测试（S2-1）：本地真实验证链路——真 RSA 密钥、真 JWKS HTTP 服务、
 * 真 RS256 签名/验签，不依赖 Keycloak 在线（Keycloak 端到端另做集成验证，D-16）。
 */
const ISSUER = 'http://127.0.0.1:1/realms/superagent';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KID = 'test-key-1';

let jwksServer: Awaited<ReturnType<typeof startTestJwksServer>>;
let issuer: string;

before(async () => {
  const jwk = await exportTestJwk(publicPem, KID);
  jwksServer = await startTestJwksServer({ keys: [jwk] });
  issuer = `http://127.0.0.1:${new URL(jwksServer.url).port}/realms/superagent`;
});
after(async () => {
  await jwksServer.close();
});

async function makeProvider() {
  const p = createOidcIdentityProvider({ issuer, jwksUrl: jwksServer.url });
  await p.warmup();
  return p;
}

describe('OIDC IdentityProvider', () => {
  test('合法 token：身份与 realm 角色映射为 Principal', async () => {
    const p = await makeProvider();
    const jwt = await mintTestJwt({
      issuer, username: 'lin.wei', roles: ['developer', 'offline_access', 'not-a-role'],
      expiresInSeconds: 300, signingKey: {} as never, privateKeyPem: privatePem, kid: KID,
    });
    const principal = p.resolve({ authorization: `Bearer ${jwt}` });
    assert.equal(principal.authenticated, true);
    assert.equal(principal.userId, 'lin.wei');
    assert.deepEqual(principal.roles, ['developer']);
  });

  test('无 Authorization 头 -> 匿名 viewer（fail-safe）', async () => {
    const p = await makeProvider();
    const principal = p.resolve({});
    assert.equal(principal.authenticated, false);
    assert.equal(principal.userId, 'anonymous');
    assert.deepEqual(principal.roles, ['viewer']);
  });

  test('过期 token 拒绝', async () => {
    const p = await makeProvider();
    const jwt = await mintTestJwt({
      issuer, username: 'u', roles: ['admin'],
      expiresInSeconds: -3600, signingKey: {} as never, privateKeyPem: privatePem, kid: KID,
    });
    assert.equal(p.resolve({ authorization: `Bearer ${jwt}` }).authenticated, false);
  });

  test('issuer 不匹配拒绝', async () => {
    const p = await makeProvider();
    const jwt = await mintTestJwt({
      issuer: 'http://evil.example/realms/other', username: 'u', roles: ['admin'],
      expiresInSeconds: 300, signingKey: {} as never, privateKeyPem: privatePem, kid: KID,
    });
    assert.equal(p.resolve({ authorization: `Bearer ${jwt}` }).authenticated, false);
  });

  test('错误签名拒绝（换一把私钥签）', async () => {
    const p = await makeProvider();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = await mintTestJwt({
      issuer, username: 'u', roles: ['admin'],
      expiresInSeconds: 300, signingKey: {} as never,
      privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), kid: KID,
    });
    assert.equal(p.resolve({ authorization: `Bearer ${jwt}` }).authenticated, false);
  });

  test('alg 混淆防护：非 RS256 头直接拒绝', async () => {
    const p = await makeProvider();
    // 手工构造 alg=HS256 头的 token（签名段随便填）
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const forged = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID }))}.${b64(JSON.stringify({ iss: issuer, exp: 9999999999, preferred_username: 'u', realm_access: { roles: ['admin'] } }))}.whatever`;
    assert.equal(p.resolve({ authorization: `Bearer ${forged}` }).authenticated, false);
  });

  test('未预热（无 JWKS 缓存）时合法 token 也拒绝——绝不放行未验签 token', async () => {
    const p = createOidcIdentityProvider({ issuer, jwksUrl: jwksServer.url });
    const jwt = await mintTestJwt({
      issuer, username: 'u', roles: ['admin'],
      expiresInSeconds: 300, signingKey: {} as never, privateKeyPem: privatePem, kid: KID,
    });
    assert.equal(p.resolve({ authorization: `Bearer ${jwt}` }).authenticated, false);
  });

  test('结构垃圾 token 拒绝', async () => {
    const p = await makeProvider();
    assert.equal(p.resolve({ authorization: 'Bearer not.a.jwt' }).authenticated, false);
    assert.equal(p.resolve({ authorization: 'Bearer !!!' }).authenticated, false);
  });
});
