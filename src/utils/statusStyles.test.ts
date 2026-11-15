import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_TYPE_LABELS,
  NEEDS_ATTENTION_STATES,
  PROVIDER_LABELS,
  ROLE_LABELS,
  SOP_TEMPLATE_LABELS,
  TASK_STATE_META,
  needsAttention,
  sopTemplateLabel,
} from './statusStyles';
import type { TaskState } from '../protocol';

/**
 * 前端纯逻辑测试（零依赖 node:test）：状态映射与「需介入」集合。
 * 组件渲染行为不在此覆盖（无 DOM 测试设施，诚实标注）；类型穷举由
 * Record<TaskState, ...> + tsc 保证，这里锁运行时形状与语义。
 */

const ALL_11_STATES: TaskState[] = [
  'PENDING', 'RUNNING', 'VERIFYING', 'RETRY_WAIT', 'HUMAN_GATE', 'ESCALATED',
  'MERGED', 'CANCELLED', 'BLOCKED_BY_RESOURCE', 'QUARANTINED', 'WAITING_APPROVAL',
];

describe('TASK_STATE_META：11 态全覆盖且样式字段完整', () => {
  test('键集合与协议 11 态一一对应', () => {
    assert.deepEqual(Object.keys(TASK_STATE_META).sort(), [...ALL_11_STATES].sort());
  });
  test('每态有非空 label 与三个 Tailwind class', () => {
    for (const [state, meta] of Object.entries(TASK_STATE_META)) {
      assert.ok(meta.label.length > 0, `${state} label`);
      assert.ok(meta.textClass.length > 0, `${state} textClass`);
      assert.ok(meta.borderClass.length > 0, `${state} borderClass`);
      assert.ok(meta.bgClass.length > 0, `${state} bgClass`);
    }
  });
});

describe('needsAttention：与后端 MCP list_blocked_tasks 集合对齐', () => {
  test('恰好 5 态为需介入', () => {
    const expected = ['HUMAN_GATE', 'WAITING_APPROVAL', 'RETRY_WAIT', 'BLOCKED_BY_RESOURCE', 'QUARANTINED'];
    assert.deepEqual([...NEEDS_ATTENTION_STATES].sort(), [...expected].sort());
  });
  test('正反例逐态断言', () => {
    for (const s of ALL_11_STATES) {
      const want = (['HUMAN_GATE', 'WAITING_APPROVAL', 'RETRY_WAIT', 'BLOCKED_BY_RESOURCE', 'QUARANTINED'] as string[]).includes(s);
      assert.equal(needsAttention(s), want, s);
    }
  });
});

describe('sopTemplateLabel：内置走映射，固化 sop-* 回退原始 id', () => {
  test('内置模板', () => {
    assert.equal(sopTemplateLabel('feature_flow'), '标准 Feature 开发流');
    assert.equal(sopTemplateLabel('bugfix_flow'), 'Bug 修复流');
  });
  test('固化子 SOP 回退显示 id（S3-2）', () => {
    assert.equal(sopTemplateLabel('sop-req-2043'), 'sop-req-2043');
  });
  test('缺省回落 feature_flow 标签', () => {
    assert.equal(sopTemplateLabel(undefined), '标准 Feature 开发流');
  });
});

describe('其余展示映射的运行时形状', () => {
  test('GATE_TYPE / PROVIDER / ROLE / SOP_TEMPLATE 标签非空', () => {
    for (const group of [GATE_TYPE_LABELS, PROVIDER_LABELS, ROLE_LABELS, SOP_TEMPLATE_LABELS]) {
      for (const label of Object.values(group)) assert.ok(label.length > 0);
    }
  });
});
