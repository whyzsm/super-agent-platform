import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  detectDangerousCommand,
  extractSkillDraft,
  getReadyDagNodes,
  parseSkillFrontmatter,
  redactSecrets,
  resolveGateDecision,
  transitionTaskVerification,
} from './stateMachine';
import type { DagNode, TaskCheckpoint } from '../protocol';

function makeNode(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: 'task-1',
    reqId: 'req-1',
    title: 'Implement OAuth Callback Guard',
    role: 'builder',
    provider: 'codex',
    adapterMode: 'headless_json',
    dependsOn: [],
    state: 'VERIFYING',
    retryCount: 0,
    maxRetries: 3,
    worktreeBranch: 'agent/task-1',
    position: { x: 0, y: 0 },
    events: [],
    terminalLines: [],
    verifierChecks: [],
    lineComments: [],
    ...overrides,
  };
}

test('state transitions follow PENDING -> RUNNING -> VERIFYING -> HUMAN_GATE -> MERGED', () => {
  assert.equal(canTransition('PENDING', 'RUNNING'), true);
  assert.equal(canTransition('RUNNING', 'VERIFYING'), true);
  assert.equal(canTransition('VERIFYING', 'HUMAN_GATE'), true);
  assert.equal(canTransition('HUMAN_GATE', 'MERGED'), true);
  assert.equal(canTransition('PENDING', 'MERGED'), false);
  assert.equal(canTransition('MERGED', 'RUNNING'), false);
});

test('getReadyDagNodes only unlocks PENDING nodes whose dependencies are all MERGED', () => {
  const nodes: DagNode[] = [
    makeNode({ id: 'plan', state: 'MERGED', dependsOn: [] }),
    makeNode({ id: 'build-a', state: 'PENDING', dependsOn: ['plan'] }),
    makeNode({ id: 'build-b', state: 'RUNNING', dependsOn: ['plan'] }),
    makeNode({ id: 'review', state: 'PENDING', dependsOn: ['build-a', 'build-b'] }),
  ];

  const ready = getReadyDagNodes(nodes);
  assert.deepEqual(
    ready.map((n) => n.id),
    ['build-a'],
  );
});

test('transitionTaskVerification enters RETRY_WAIT on failure and ESCALATED at max_retries=3', () => {
  const n0 = makeNode({ state: 'VERIFYING', retryCount: 0, maxRetries: 3 });
  const r1 = transitionTaskVerification(n0, false, 'TS2345 typecheck error');
  assert.equal(r1.nextNode.state, 'RETRY_WAIT');
  assert.equal(r1.nextNode.retryCount, 1);
  assert.equal(r1.nextNode.hadFailureOrCorrection, true);

  const n2 = makeNode({ state: 'VERIFYING', retryCount: 2, maxRetries: 3 });
  const r3 = transitionTaskVerification(n2, false, 'Unit test assertion failed');
  assert.equal(r3.nextNode.state, 'ESCALATED');
  assert.equal(r3.nextNode.retryCount, 3);
  assert.ok(r3.nextNode.activeCheckpoint);
});

test('resolveGateDecision handles approve with skill extraction after recovery and reject with feedback', () => {
  const node = makeNode({
    state: 'HUMAN_GATE',
    retryCount: 1,
    hadFailureOrCorrection: true,
    lastErrorFeedback: 'Missing CSRF state validation',
  });
  const ckpt: TaskCheckpoint = {
    id: 'ckpt-1',
    taskId: node.id,
    gateType: 'MERGE_GATE',
    summaryMd: 'Ready for merge',
    status: 'WAITING',
    createdAt: '2026-11-15T00:00:00Z',
  };

  const rejected = resolveGateDecision(node, ckpt, {
    approved: false,
    comment: 'Please check edge case when state is expired',
    reviewerId: 'user-admin',
  });
  assert.equal(rejected.nextNode.state, 'RETRY_WAIT');
  assert.equal(rejected.nextNode.retryCount, 2);
  assert.equal(rejected.shouldExtractSkill, false);

  const approved = resolveGateDecision(node, ckpt, {
    approved: true,
    comment: 'LGTM',
    reviewerId: 'user-admin',
  });
  assert.equal(approved.nextNode.state, 'MERGED');
  assert.equal(approved.shouldExtractSkill, true);

  const draft = extractSkillDraft(approved.nextNode, 'team-core', 'user-admin');
  assert.ok(draft);
  assert.equal(draft.status, 'draft');
  assert.equal(parseSkillFrontmatter(draft.contentMd).valid, true);
});

test('detectDangerousCommand catches rm -rf /, DROP TABLE, git push --force, and sensitive paths', () => {
  assert.equal(detectDangerousCommand('rm -rf /').dangerous, true);
  assert.equal(detectDangerousCommand('psql -c "DROP TABLE task_nodes;"').dangerous, true);
  assert.equal(detectDangerousCommand('git push --force origin main').dangerous, true);
  assert.equal(detectDangerousCommand('cat .env.production').dangerous, true);
  assert.equal(detectDangerousCommand('npm run test').dangerous, false);
});

test('redactSecrets scrubs API keys, bearer tokens, DB passwords, and emails before L0 upload', () => {
  const raw =
    'Using key sk-proj1234567890abcdef and Authorization: Bearer tok_1234567890abcdef on postgres://admin:s3cr3tpass@db:5432/app for alice@company.com';
  const { redacted, hitCount } = redactSecrets(raw);
  assert.equal(hitCount, 4);
  assert.equal(redacted.includes('sk-proj'), false);
  assert.equal(redacted.includes('s3cr3tpass'), false);
  assert.equal(redacted.includes('alice@company.com'), false);
  assert.equal(redacted.includes('[REDACTED_API_KEY]'), true);
});

import { recordUsageAndCheckBudget } from './stateMachine';

test('recordUsageAndCheckBudget escalates task when token budget_limit is exceeded', () => {
  const n = makeNode({
    state: 'RUNNING',
    usage: {
      inputTokens: 40_000,
      outputTokens: 12_000,
      costUsd: 0.3,
      durationSec: 40,
      budgetTokens: 60_000,
    },
  });
  const okStep = recordUsageAndCheckBudget(n, 2_000, 1_000, 5);
  assert.equal(okStep.budgetExceeded, false);
  assert.equal(okStep.nextNode.state, 'RUNNING');

  const overStep = recordUsageAndCheckBudget(okStep.nextNode, 5_000, 2_000, 10);
  assert.equal(overStep.budgetExceeded, true);
  assert.equal(overStep.nextNode.state, 'ESCALATED');
  assert.ok(overStep.nextNode.activeCheckpoint?.summaryMd.includes('Token 预算熔断'));
});
