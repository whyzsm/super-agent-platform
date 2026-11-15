import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  extractSkillDraft,
  getReadyDagNodes,
  parseSkillFrontmatter,
  resolveGateDecision,
  transitionTaskVerification,
} from './stateMachine';
// detectDangerousCommand / redactSecrets 的用例已随实现迁移至 src/policy/policy.test.ts（S2-9）。
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

test('canTransition allows the legal exits of the 3 new states', () => {
  // BLOCKED_BY_RESOURCE 可回 RUNNING 或 CANCELLED
  assert.equal(canTransition('BLOCKED_BY_RESOURCE', 'RUNNING'), true);
  assert.equal(canTransition('BLOCKED_BY_RESOURCE', 'CANCELLED'), true);
  // QUARANTINED 可回 RETRY_WAIT 或 CANCELLED
  assert.equal(canTransition('QUARANTINED', 'RETRY_WAIT'), true);
  assert.equal(canTransition('QUARANTINED', 'CANCELLED'), true);
  // WAITING_APPROVAL 可到 RUNNING / MERGED / CANCELLED
  assert.equal(canTransition('WAITING_APPROVAL', 'RUNNING'), true);
  assert.equal(canTransition('WAITING_APPROVAL', 'MERGED'), true);
  assert.equal(canTransition('WAITING_APPROVAL', 'CANCELLED'), true);
});

test('canTransition lets RUNNING / HUMAN_GATE / ESCALATED and peers enter the 3 new states', () => {
  assert.equal(canTransition('PENDING', 'BLOCKED_BY_RESOURCE'), true);
  assert.equal(canTransition('RUNNING', 'BLOCKED_BY_RESOURCE'), true);
  assert.equal(canTransition('RUNNING', 'QUARANTINED'), true);
  assert.equal(canTransition('RUNNING', 'WAITING_APPROVAL'), true);
  assert.equal(canTransition('VERIFYING', 'QUARANTINED'), true);
  assert.equal(canTransition('RETRY_WAIT', 'BLOCKED_BY_RESOURCE'), true);
  assert.equal(canTransition('RETRY_WAIT', 'QUARANTINED'), true);
  assert.equal(canTransition('HUMAN_GATE', 'WAITING_APPROVAL'), true);
  assert.equal(canTransition('ESCALATED', 'QUARANTINED'), true);
  assert.equal(canTransition('ESCALATED', 'WAITING_APPROVAL'), true);
});

test('canTransition rejects illegal transitions involving the 3 new states', () => {
  // 终态不可再迁出
  assert.equal(canTransition('MERGED', 'BLOCKED_BY_RESOURCE'), false);
  assert.equal(canTransition('CANCELLED', 'QUARANTINED'), false);
  // 新状态的出口必须有限：未列入的迁移一律拒绝
  assert.equal(canTransition('BLOCKED_BY_RESOURCE', 'MERGED'), false);
  assert.equal(canTransition('BLOCKED_BY_RESOURCE', 'VERIFYING'), false);
  assert.equal(canTransition('QUARANTINED', 'RUNNING'), false);
  assert.equal(canTransition('QUARANTINED', 'MERGED'), false);
  assert.equal(canTransition('WAITING_APPROVAL', 'PENDING'), false);
  assert.equal(canTransition('WAITING_APPROVAL', 'VERIFYING'), false);
  // 不允许任意旧状态跳进这些新状态
  assert.equal(canTransition('PENDING', 'QUARANTINED'), false);
  assert.equal(canTransition('PENDING', 'WAITING_APPROVAL'), false);
});

test('canTransition keeps the original 8-state transition semantics unchanged', () => {
  // 原有正向迁移全部保留
  assert.equal(canTransition('PENDING', 'RUNNING'), true);
  assert.equal(canTransition('PENDING', 'CANCELLED'), true);
  assert.equal(canTransition('RUNNING', 'VERIFYING'), true);
  assert.equal(canTransition('RUNNING', 'HUMAN_GATE'), true);
  assert.equal(canTransition('RUNNING', 'RETRY_WAIT'), true);
  assert.equal(canTransition('RUNNING', 'ESCALATED'), true);
  assert.equal(canTransition('RUNNING', 'CANCELLED'), true);
  assert.equal(canTransition('VERIFYING', 'HUMAN_GATE'), true);
  assert.equal(canTransition('VERIFYING', 'RETRY_WAIT'), true);
  assert.equal(canTransition('VERIFYING', 'ESCALATED'), true);
  assert.equal(canTransition('VERIFYING', 'CANCELLED'), true);
  assert.equal(canTransition('RETRY_WAIT', 'RUNNING'), true);
  assert.equal(canTransition('RETRY_WAIT', 'ESCALATED'), true);
  assert.equal(canTransition('RETRY_WAIT', 'CANCELLED'), true);
  assert.equal(canTransition('HUMAN_GATE', 'MERGED'), true);
  assert.equal(canTransition('HUMAN_GATE', 'RUNNING'), true);
  assert.equal(canTransition('HUMAN_GATE', 'RETRY_WAIT'), true);
  assert.equal(canTransition('HUMAN_GATE', 'ESCALATED'), true);
  assert.equal(canTransition('HUMAN_GATE', 'CANCELLED'), true);
  assert.equal(canTransition('ESCALATED', 'RETRY_WAIT'), true);
  assert.equal(canTransition('ESCALATED', 'RUNNING'), true);
  assert.equal(canTransition('ESCALATED', 'CANCELLED'), true);
  // 原有被拒绝的迁移仍被拒绝（未被新状态放宽）
  assert.equal(canTransition('PENDING', 'MERGED'), false);
  assert.equal(canTransition('VERIFYING', 'RUNNING'), false);
  assert.equal(canTransition('MERGED', 'RUNNING'), false);
  assert.equal(canTransition('MERGED', 'CANCELLED'), false);
  assert.equal(canTransition('CANCELLED', 'RUNNING'), false);
});
