import test from 'node:test';
import assert from 'node:assert/strict';
import { signImWebhookPayload, verifyImWebhookPayload } from './imWebhook';

test('verifyImWebhookPayload accepts valid HMAC signature within 300s replay window', () => {
  const now = 1_763_196_000_000;
  const body = JSON.stringify({
    channel: 'wecom',
    taskId: 'task-2041-b1',
    approved: true,
    comment: 'LGTM',
    reviewerId: 'lin.wei',
    timestamp: now - 15_000,
    nonce: 'n-9912',
  });
  const secret = 'superagent-im-secret';
  const sig = signImWebhookPayload(body, secret);

  const res = verifyImWebhookPayload(body, sig, secret, now);
  assert.equal(res.valid, true);
  assert.equal(res.payload?.taskId, 'task-2041-b1');
});

test('verifyImWebhookPayload rejects expired replay window and invalid signature', () => {
  const now = 1_763_196_000_000;
  const secret = 'superagent-im-secret';

  const staleBody = JSON.stringify({
    channel: 'feishu',
    taskId: 'task-2041-b1',
    approved: true,
    reviewerId: 'lin.wei',
    timestamp: now - 350_000,
    nonce: 'n-old',
  });
  const staleSig = signImWebhookPayload(staleBody, secret);
  const staleRes = verifyImWebhookPayload(staleBody, staleSig, secret, now);
  assert.equal(staleRes.valid, false);
  assert.ok(staleRes.error?.includes('ReplayWindowError'));

  const freshBody = JSON.stringify({
    channel: 'wecom',
    taskId: 'task-2041-b1',
    approved: true,
    reviewerId: 'lin.wei',
    timestamp: now,
    nonce: 'n-fresh',
  });
  const badRes = verifyImWebhookPayload(freshBody, '0'.repeat(64), secret, now);
  assert.equal(badRes.valid, false);
  assert.ok(badRes.error?.includes('SignatureError'));
});
