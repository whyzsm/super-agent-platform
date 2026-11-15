import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GATE_TIER_CONFIG,
  evaluateGateRelease,
  GATE_TIER_VALUES,
  parseGateTier,
  type GateTierConfig,
} from './gateTiers';
import type { VerifierCheck } from '../protocol';

const green: VerifierCheck[] = [
  { name: 'lint', passed: true, durationMs: 1, summary: 'ok' },
  { name: 'unit_test', passed: true, durationMs: 1, summary: 'ok' },
];
const red: VerifierCheck[] = [
  { name: 'lint', passed: true, durationMs: 1, summary: 'ok' },
  { name: 'unit_test', passed: false, durationMs: 1, summary: 'fail' },
];

describe('parseGateTier：配置解析 fail-safe 到最严挡', () => {
  test('合法值与缺省', () => {
    assert.equal(parseGateTier(undefined), 'always_confirm');
    assert.equal(parseGateTier(''), 'always_confirm');
    assert.equal(parseGateTier('always_confirm'), 'always_confirm');
    assert.equal(parseGateTier('auto_approve_when_green'), 'auto_approve_when_green');
    assert.equal(parseGateTier('delegate_to_reviewer'), 'delegate_to_reviewer');
  });
  test('非法值回落 always_confirm', () => {
    assert.equal(parseGateTier('yolo'), 'always_confirm');
    assert.equal(parseGateTier('MERGE_EVERYTHING'), 'always_confirm');
    assert.equal(GATE_TIER_VALUES.length, 3);
  });
});

describe('always_confirm：与历史行为一致', () => {
  test('任何门禁都等人工', () => {
    for (const gateType of ['PLAN_GATE', 'MERGE_GATE', 'DANGER_GATE'] as const) {
      const r = evaluateGateRelease(DEFAULT_GATE_TIER_CONFIG, {
        gateType,
        verifierChecks: green,
        worktreeBranch: 'agent/task-1-b1',
      });
      assert.equal(r.outcome, 'require_human');
    }
  });
});

describe('delegate_to_reviewer：诚实降级', () => {
  test('未接代批模型时降级人工且原因可审计', () => {
    const r = evaluateGateRelease({ tier: 'delegate_to_reviewer' }, {
      gateType: 'MERGE_GATE',
      verifierChecks: green,
      worktreeBranch: 'agent/task-1-b1',
    });
    assert.equal(r.outcome, 'require_human');
    assert.ok(r.reason.includes('代批模型未接入'));
    assert.ok(r.reason.includes('降级'));
  });
});

describe('auto_approve_when_green：确定性放行矩阵', () => {
  const cfg: GateTierConfig = { tier: 'auto_approve_when_green' };

  test('全绿 MERGE_GATE + 非保护分支 -> 放行', () => {
    const r = evaluateGateRelease(cfg, {
      gateType: 'MERGE_GATE',
      verifierChecks: green,
      worktreeBranch: 'agent/task-1-b1',
    });
    assert.equal(r.outcome, 'auto_approve');
    assert.ok(r.reason.includes('全绿'));
  });

  test('DANGER_GATE 永不放行（红线）', () => {
    const r = evaluateGateRelease(cfg, {
      gateType: 'DANGER_GATE',
      verifierChecks: green,
      worktreeBranch: 'agent/task-1-b1',
    });
    assert.equal(r.outcome, 'require_human');
    assert.ok(r.reason.includes('永不'));
  });

  test('PLAN_GATE 默认不放行，显式配置后才放行', () => {
    const def = evaluateGateRelease(cfg, {
      gateType: 'PLAN_GATE',
      verifierChecks: green,
      worktreeBranch: 'agent/task-1-plan',
    });
    assert.equal(def.outcome, 'require_human');
    const widened = evaluateGateRelease(
      { ...cfg, autoApproveGateTypes: ['MERGE_GATE', 'PLAN_GATE'] },
      { gateType: 'PLAN_GATE', verifierChecks: green, worktreeBranch: 'agent/task-1-plan' },
    );
    assert.equal(widened.outcome, 'auto_approve');
  });

  test('有未通过项 -> 不放行', () => {
    const r = evaluateGateRelease(cfg, {
      gateType: 'MERGE_GATE',
      verifierChecks: red,
      worktreeBranch: 'agent/task-1-b1',
    });
    assert.equal(r.outcome, 'require_human');
    assert.ok(r.reason.includes('未通过'));
  });

  test('无任何真实执行项 -> 不放行', () => {
    const r = evaluateGateRelease(cfg, {
      gateType: 'MERGE_GATE',
      verifierChecks: [],
      worktreeBranch: 'agent/task-1-b1',
    });
    assert.equal(r.outcome, 'require_human');
    assert.ok(r.reason.includes('无任何真实执行项'));
  });

  test('受保护分支（默认 main）-> 不放行；自定义名单生效', () => {
    const main = evaluateGateRelease(cfg, {
      gateType: 'MERGE_GATE',
      verifierChecks: green,
      worktreeBranch: 'main',
    });
    assert.equal(main.outcome, 'require_human');
    assert.ok(main.reason.includes('受保护'));
    const custom = evaluateGateRelease(
      { ...cfg, protectedBranches: ['release/v2.4'] },
      { gateType: 'MERGE_GATE', verifierChecks: green, worktreeBranch: 'release/v2.4' },
    );
    assert.equal(custom.outcome, 'require_human');
  });

  test('分支缺失按受保护处理', () => {
    const r = evaluateGateRelease(cfg, { gateType: 'MERGE_GATE', verifierChecks: green });
    assert.equal(r.outcome, 'require_human');
  });
});
