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

/**
 * 查询覆盖率：查询侧 trigram 被语料命中的比例（intersection / |query trigrams|）。
 *
 * 为什么不复用 computeTextSimilarity（Jaccard）：召回场景里查询很短、语料很长，
 * Jaccard 的分母被语料长度主导，短查询天然趋近 0——「对账单」「幂等」明明在标题里
 * 却召回不到（实测 score≈0.008 < 阈值）。覆盖率对长短不对称比较是正确度量，
 * 因此召回用本函数；去重（computeMaxDuplicateScore）是对称比较，仍用 Jaccard。
 */
export function computeQueryCoverage(query: string, corpus: string): number {
  const setA = tokenizeTrigrams(query);
  const setB = tokenizeTrigrams(corpus);
  if (setA.size === 0 || setB.size === 0) return 0;
  let hit = 0;
  for (const g of setA) {
    if (setB.has(g)) hit += 1;
  }
  return Number((hit / setA.size).toFixed(4));
}

/** 召回准入分：低于该值视为不相关，避免把噪声塞进上下文。 */
export const MIN_RECALL_SCORE = 0.2;

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
    // 整串包含 = 精准命中，直接给满分；否则按「全语料覆盖率 0.6 + 标题覆盖率 0.4」加权，
    // 让标题命中的资产排在正文偶然命中的前面。
    const exactHit = corpus.toLowerCase().includes(q.toLowerCase());
    const coverage = computeQueryCoverage(q, corpus);
    const titleCoverage = computeQueryCoverage(q, asset.title);
    const score = exactHit
      ? 1
      : Math.min(1, Number((coverage * 0.6 + titleCoverage * 0.4).toFixed(4)));

    if (score >= MIN_RECALL_SCORE) {
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
