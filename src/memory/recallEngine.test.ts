import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialSeedState } from '../data/seed';
import { computeMaxDuplicateScore, recallMemoryAssets } from './recallEngine';

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
