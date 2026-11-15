import type { MemoryAsset } from '../protocol';

export interface RecallCallerContext {
  teamId: string;
  projectId?: string;
  userId?: string;
  agentId?: string;
}

export interface RecallResult {
  asset: MemoryAsset;
  score: number;
  matchedAcl: string;
}

function tokenizeTrigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  if (normalized.length < 3) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let i = 0; i <= normalized.length - 3; i += 1) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

export function computeTextSimilarity(a: string, b: string): number {
  const setA = tokenizeTrigrams(a);
  const setB = tokenizeTrigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

export function findMatchedAcl(
  asset: MemoryAsset,
  caller: RecallCallerContext,
): string | null {
  for (const entry of asset.acl) {
    if (entry.subjectType === 'team' && entry.subjectId === caller.teamId) {
      return `team:${entry.subjectId} (${entry.permission})`;
    }
    if (
      entry.subjectType === 'project' &&
      caller.projectId &&
      entry.subjectId === caller.projectId
    ) {
      return `project:${entry.subjectId} (${entry.permission})`;
    }
    if (entry.subjectType === 'user' && caller.userId && entry.subjectId === caller.userId) {
      return `user:${entry.subjectId} (${entry.permission})`;
    }
    if (
      entry.subjectType === 'agent' &&
      caller.agentId &&
      entry.subjectId === caller.agentId
    ) {
      return `agent:${entry.subjectId} (${entry.permission})`;
    }
  }
  return null;
}

export function recallMemoryAssets(
  assets: MemoryAsset[],
  query: string,
  caller: RecallCallerContext,
  limit = 5,
): RecallResult[] {
  const results: RecallResult[] = [];
  const q = query.trim();
  if (!q) return [];

  for (const asset of assets) {
    // Anti-pollution rule: only published assets can be recalled by MCP tools
    if (asset.status !== 'published') continue;
    const matchedAcl = findMatchedAcl(asset, caller);
    if (!matchedAcl) continue;

    const corpus = `${asset.title}\n${asset.contentMd}`;
    const trigramScore = computeTextSimilarity(q, corpus);
    const keywordBoost = corpus.toLowerCase().includes(q.toLowerCase()) ? 0.35 : 0;
    const score = Math.min(1, Number((trigramScore + keywordBoost).toFixed(4)));

    if (score > 0.02) {
      results.push({ asset, score, matchedAcl });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function computeMaxDuplicateScore(
  candidateMarkdown: string,
  existingAssets: MemoryAsset[],
): number {
  let max = 0;
  for (const asset of existingAssets) {
    if (asset.assetType !== 'SKILL' || asset.status === 'archived') continue;
    const sim = computeTextSimilarity(candidateMarkdown, asset.contentMd);
    if (sim > max) max = sim;
  }
  return max;
}
