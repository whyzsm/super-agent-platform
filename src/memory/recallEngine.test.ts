import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialSeedState } from '../data/seed';
import {
  MIN_RECALL_SCORE,
  computeMaxDuplicateScore,
  computeQueryCoverage,
  recallMemoryAssets,
} from './recallEngine';

test('recallMemoryAssets excludes draft assets and enforces 4-level ACL isolation', () => {
  const { memories } = createInitialSeedState();

  // Query as generic team agent without user=lin.wei or project=proj-reconcile
  const teamHits = recallMemoryAssets(memories, 'Webhook', {
    teamId: 'team-platform-core',
    agentId: 'codex',
  });
  assert.ok(teamHits.length >= 1);
  assert.equal(
    teamHits.every((r) => r.asset.status === 'published'),
    true,
  );

  // Draft pgvector skill must NOT be recalled even if query matches
  const draftQuery = recallMemoryAssets(memories, 'pgvector', {
    teamId: 'team-platform-core',
    userId: 'chen.hao',
  });
  assert.equal(
    draftQuery.some((r) => r.asset.id === 'mem-skill-draft-1'),
    false,
  );

  // User-scoped L1 fact (owner lin.wei) must not leak to another user without team/project ACL
  const otherUserHits = recallMemoryAssets(memories, 'Redis', {
    teamId: 'other-team',
    userId: 'zhou.min',
  });
  assert.equal(otherUserHits.length, 0);

  const ownerHits = recallMemoryAssets(memories, 'Redis', {
    teamId: 'other-team',
    userId: 'lin.wei',
  });
  assert.equal(ownerHits.length, 1);
});

test('computeMaxDuplicateScore detects overlap against existing skills', () => {
  const { memories } = createInitialSeedState();
  const sim = computeMaxDuplicateScore(memories[1].contentMd, memories);
  assert.equal(sim, 1);
});

test('queryCoverage: 短中文查询对长文档不再被 Jaccard 稀释到阈值以下', () => {
  const title = '日终对账单并发写入幂等键落库方案';
  const content = `${title}\n采用幂等键 + 唯一索引解决并发重复入账，冲突时指数退避重试。`;

  // 关键词确实在标题里：覆盖率必须显著高于 0
  const coverage = computeQueryCoverage('对账单 幂等', content);
  assert.ok(coverage > 0, `覆盖率应大于 0，实际 ${coverage}`);

  // 召回侧必须真的把它召回来（回归：修复前为 0 条）
  const memories = [
    {
      id: 'mem-cn',
      teamId: 'team-platform-core',
      ownerId: 'lin.wei',
      assetType: 'L2_SOLUTION' as const,
      scope: 'team' as const,
      status: 'published' as const,
      title,
      contentMd: content,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      acl: [
        {
          assetId: 'mem-cn',
          subjectType: 'team' as const,
          subjectId: 'team-platform-core',
          permission: 'read' as const,
        },
      ],
    },
  ];
  const hits = recallMemoryAssets(memories, '对账单 幂等', {
    teamId: 'team-platform-core',
    projectId: 'proj-reconcile',
  });
  assert.equal(hits.length, 1, '标题含关键词的中文资产必须可召回');
  assert.ok(hits[0].score >= MIN_RECALL_SCORE);
});

test('queryCoverage: 完全无关的查询仍被过滤（不因放宽度量引入噪声）', () => {
  const { memories } = createInitialSeedState();
  const hits = recallMemoryAssets(memories, 'zzzz 完全无关的关键词 qqqq', {
    teamId: 'team-platform-core',
    projectId: 'proj-reconcile',
    userId: 'lin.wei',
    agentId: 'codex',
  });
  assert.equal(hits.length, 0);
});
