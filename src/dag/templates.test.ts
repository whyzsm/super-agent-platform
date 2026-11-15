import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTasksForTemplate,
  DAG_TEMPLATES,
  normalizeSopTemplateId,
  type DagTemplateContext,
} from './templates';
import type { AgentProvider, SopTemplateId } from '../protocol';

/** 与路由行为一致：seq 从 1000 起严格递增分配。 */
function makeCtx(overrides: Partial<DagTemplateContext> = {}): DagTemplateContext {
  let seq = 1000;
  return {
    reqId: 'req-9999',
    requirement: { title: '对账幂等重构', baseBranch: 'release/v2.4' },
    provider: 'codex',
    nowIso: '2026-11-16T00:00:00Z',
    timeStr: '00:00:00',
    nextSeq: () => ++seq,
    ...overrides,
  };
}

describe('normalizeSopTemplateId：历史兜底语义', () => {
  test('只有显式 bugfix_flow 走缺陷流', () => {
    assert.equal(normalizeSopTemplateId('bugfix_flow'), 'bugfix_flow');
    assert.equal(normalizeSopTemplateId('feature_flow'), 'feature_flow');
    assert.equal(normalizeSopTemplateId(undefined), 'feature_flow');
    assert.equal(normalizeSopTemplateId('garbage'), 'feature_flow');
    assert.equal(normalizeSopTemplateId(42), 'feature_flow');
  });
});

describe('注册表完整性', () => {
  test('两个模板 id 与协议 SopTemplateId 一一对应', () => {
    assert.deepEqual(Object.keys(DAG_TEMPLATES).sort(), ['bugfix_flow', 'feature_flow']);
    for (const t of Object.values(DAG_TEMPLATES)) {
      assert.ok(t.title && t.description, `${t.id} 必须有元数据`);
    }
  });
});

describe('feature_flow：4 节点并行 DAG', () => {
  const nodes = buildTasksForTemplate('feature_flow', makeCtx());
  test('结构与拓扑', () => {
    assert.equal(nodes.length, 4);
    const [plan, b1, b2, rev] = nodes;
    assert.equal(plan.state, 'HUMAN_GATE');
    assert.deepEqual(plan.dependsOn, []);
    assert.deepEqual(b1.dependsOn, [plan.id]);
    assert.deepEqual(b2.dependsOn, [plan.id]);
    assert.deepEqual(rev.dependsOn, [b1.id, b2.id]);
    for (const n of [b1, b2, rev]) assert.equal(n.state, 'PENDING');
    assert.ok(nodes.every((n) => n.reqId === 'req-9999'));
  });
  test('plan 节点带 PLAN_GATE 等审检查点与事件', () => {
    const plan = nodes[0];
    assert.equal(plan.activeCheckpoint?.gateType, 'PLAN_GATE');
    assert.equal(plan.activeCheckpoint?.status, 'WAITING');
    assert.equal(plan.role, 'planner');
    assert.equal(plan.events.length, 1);
  });
  test('事件 seq 由 nextSeq 严格递增分配', () => {
    const ctx = makeCtx();
    const a = buildTasksForTemplate('feature_flow', ctx);
    const b = buildTasksForTemplate('bugfix_flow', ctx);
    const seqs = [...a[0].events, ...b[0].events].map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.equal(new Set(seqs).size, seqs.length, 'seq 不得重复');
  });
});

describe('bugfix_flow：3 节点链', () => {
  const nodes = buildTasksForTemplate('bugfix_flow', makeCtx());
  test('结构与拓扑', () => {
    assert.equal(nodes.length, 3);
    const [plan, fix, rev] = nodes;
    assert.equal(plan.state, 'HUMAN_GATE');
    assert.deepEqual(fix.dependsOn, [plan.id]);
    assert.deepEqual(rev.dependsOn, [fix.id]);
    assert.equal(fix.role, 'builder');
    assert.equal(rev.role, 'reviewer');
  });
  test('provider=workbuddy 时 fix 节点走 acp 双向适配', () => {
    const wb = buildTasksForTemplate(
      'bugfix_flow',
      makeCtx({ provider: 'workbuddy' as AgentProvider }),
    );
    assert.equal(wb[1].adapterMode, 'acp_bidirectional');
    assert.equal(wb[1].provider, 'workbuddy');
  });
  test('文案渲染需求标题与基线分支', () => {
    const plan = nodes[0];
    assert.ok(plan.activeCheckpoint!.summaryMd.includes('对账幂等重构'));
    assert.ok(plan.terminalLines.some((l) => l.includes('release/v2.4')));
  });
});

describe('未知模板 id 兜底', () => {
  test('非登记 id 一律构建 feature_flow（与路由旧行为一致）', () => {
    const ctx = makeCtx();
    const fallback = buildTasksForTemplate('nope' as SopTemplateId, ctx);
    assert.equal(fallback.length, 4);
  });
});
