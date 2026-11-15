import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePipelineToTemplate,
  deserializeTemplate,
  type SerializedSopTemplate,
} from './compile';
import type { DagNode } from '../protocol';

function node(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: 'task-1-plan',
    reqId: 'req-1',
    title: '拆解',
    role: 'planner',
    provider: 'claude-code',
    adapterMode: 'headless_json',
    dependsOn: [],
    state: 'MERGED',
    retryCount: 0,
    maxRetries: 3,
    position: { x: 0, y: 0 },
    events: [],
    terminalLines: [],
    verifierChecks: [],
    lineComments: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationSec: 0, budgetTokens: 50000 },
    ...overrides,
  };
}

const PIPELINE: DagNode[] = [
  node({ id: 'task-1-plan', role: 'planner', provider: 'claude-code' }),
  node({
    id: 'task-1-b1',
    title: '实现',
    role: 'builder',
    provider: 'codex',
    dependsOn: ['task-1-plan'],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationSec: 0, budgetTokens: 80000 },
  }),
  node({
    id: 'task-1-rev',
    title: '审查',
    role: 'reviewer',
    provider: 'claude-code',
    dependsOn: ['task-1-b1'],
  }),
];

describe('compilePipelineToTemplate：流水线 -> 模板骨架', () => {
  test('拓扑/角色/预算保真，依赖映射为步骤序号', () => {
    const t = compilePipelineToTemplate(PIPELINE, { id: 'req-1', title: '需求 A' });
    assert.equal(t.id, 'sop-req-1');
    assert.equal(t.version, 1);
    assert.equal(t.steps.length, 3);
    assert.deepEqual(t.steps[1].dependsOn, [0]);
    assert.deepEqual(t.steps[2].dependsOn, [1]);
    assert.equal(t.steps[1].role, 'builder');
    assert.equal(t.steps[1].provider, 'codex');
    assert.equal(t.steps[1].budgetTokens, 80000);
    assert.equal(t.steps[0].isPlan, true);
    assert.equal(t.steps[1].isPlan, false);
  });

  test('重复固化（传 existing）bump version', () => {
    const v1 = compilePipelineToTemplate(PIPELINE, { id: 'req-1', title: 'A' });
    const v2 = compilePipelineToTemplate(PIPELINE, { id: 'req-1', title: 'A' }, v1);
    assert.equal(v2.version, 2);
    assert.deepEqual(v2.steps.map((s) => s.title), v1.steps.map((s) => s.title));
  });

  test('空流水线拒绝编译', () => {
    assert.throws(() => compilePipelineToTemplate([], { id: 'r', title: 't' }), /空流水线/);
  });

  test('引用不存在节点的依赖被丢弃（骨架仍可实例化）', () => {
    const dangling = [PIPELINE[1], { ...PIPELINE[2], dependsOn: ['task-1-b1', 'ghost'] }];
    const t = compilePipelineToTemplate(dangling, { id: 'req-x', title: 'x' });
    assert.deepEqual(t.steps[1].dependsOn, [0]);
  });
});

describe('deserializeTemplate：模板 -> 新 reqId 节点链', () => {
  const compiled = compilePipelineToTemplate(PIPELINE, { id: 'req-1', title: '需求 A' });
  const nodes = deserializeTemplate(compiled).build({
    reqId: 'req-7777',
    nowIso: '2026-11-16T00:00:00Z',
    timeStr: '00:00:00',
    nextSeq: (() => { let s = 100; return () => ++s; })(),
  });

  test('节点按新 reqId 实例化且带版本戳', () => {
    assert.equal(nodes.length, 3);
    assert.ok(nodes.every((n) => n.reqId === 'req-7777'));
    assert.ok(nodes.every((n) => n.templateId === 'sop-req-1'));
    assert.ok(nodes.every((n) => n.templateVersion === 1));
  });

  test('依赖按序号还原为新 id；首节点 PLAN_GATE 挂起，其余 PENDING', () => {
    const [plan, b1, rev] = nodes;
    assert.equal(plan.state, 'HUMAN_GATE');
    assert.equal(plan.activeCheckpoint?.gateType, 'PLAN_GATE');
    assert.deepEqual(b1.dependsOn, [plan.id]);
    assert.deepEqual(rev.dependsOn, [b1.id]);
    assert.equal(b1.state, 'PENDING');
    assert.equal(rev.state, 'PENDING');
    assert.ok(plan.terminalLines.some((l) => l.includes('sop-req-1@v1')));
  });

  test('预算与角色随步骤还原', () => {
    assert.equal(nodes[1].usage?.budgetTokens, 80000);
    assert.equal(nodes[2].role, 'reviewer');
    assert.equal(nodes[1].provider, 'codex');
  });

  test('事件 seq 由 nextSeq 分配且不重复', () => {
    const seqs = nodes.flatMap((n) => n.events.map((e) => e.seq));
    assert.equal(new Set(seqs).size, seqs.length);
  });
});
