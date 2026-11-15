import type { Express } from 'express';
import type {
  AgentProvider,
  MemoryAsset,
  Requirement,
  SopTemplateId,
  TeamAiAsset,
} from '../protocol';
import { buildTasksForTemplate, normalizeSopTemplateId } from '../dag/templates';
import type { ServerContext } from './context';

/**
 * 需求域路由：创建需求（经 src/dag/templates.ts 注册表生成 DAG）与固化 SOP。
 */
export function registerRequirementRoutes(app: Express, ctx: ServerContext): void {
  const { state, seq, saveState, syncTeamAiFileToDisk } = ctx;

  app.post('/api/requirements', (req, res) => {
    const {
      title,
      specMd,
      repoUrl,
      baseBranch,
      sourceChannel,
      primaryProvider,
      sopTemplate,
    } = req.body as {
      title?: string;
      specMd?: string;
      repoUrl?: string;
      baseBranch?: string;
      sourceChannel?: 'web' | 'cli' | 'wecom' | 'feishu';
      primaryProvider?: AgentProvider;
      sopTemplate?: SopTemplateId;
    };

    if (!title || !title.trim() || !specMd || !specMd.trim()) {
      res.status(400).json({ error: '需求标题与需求规格说明书不能为空' });
      return;
    }

    const reqId = `req-${Date.now().toString().slice(-4)}`;
    const nowIso = new Date().toISOString();
    const provider: AgentProvider = primaryProvider || 'codex';
    const template = normalizeSopTemplateId(sopTemplate);

    const newReq: Requirement = {
      id: reqId,
      teamId: 'team-platform-core',
      title: title.trim(),
      specMd: specMd.trim(),
      repoUrl: (repoUrl || 'git@example.invalid:superagent/app-service.git').trim(),
      baseBranch: (baseBranch || 'main').trim(),
      sourceChannel: sourceChannel || 'web',
      sopTemplate: template,
      status: 'AWAITING_GATE',
      createdBy: 'lin.wei',
      createdAt: nowIso,
    };

    const newTasks = buildTasksForTemplate(template, {
      reqId,
      requirement: newReq,
      provider,
      nowIso,
      timeStr: new Date().toTimeString().slice(0, 8),
      nextSeq: () => ++seq.current,
    });

    state.current.requirements.unshift(newReq);
    state.current.tasks.push(...newTasks);
    saveState(state.current);

    res.status(201).json({ requirement: newReq, tasks: newTasks });
  });

  app.post('/api/requirements/:id/solidify-sop', (req, res) => {
    const reqItem = state.current.requirements.find((r) => r.id === req.params.id);
    if (!reqItem) {
      res.status(404).json({ error: '目标需求不存在' });
      return;
    }

    const reqNodes = state.current.tasks.filter((t) => t.reqId === reqItem.id);
    const allFinished =
      reqNodes.length > 0 &&
      reqNodes.every((t) => t.state === 'MERGED' || t.state === 'CANCELLED');
    if (!allFinished) {
      res.status(400).json({ error: '仅已全部合入完成的研发流水线可固化为团队 SOP' });
      return;
    }

    const nowIso = new Date().toISOString();
    const sopSlug = `sop-${reqItem.id}`;
    const gitPath = `.teamai/skills/${sopSlug}.md`;
    const stepLines = reqNodes
      .map(
        (n, idx) =>
          `${idx + 1}. **${n.title}** (\`${n.role}\` / \`${n.provider}\` / \`${n.adapterMode}\`) — 验证项：${
            n.verifierChecks.map((c) => c.name).join(', ') || 'gate-approved'
          }`,
      )
      .join('\n');

    const contentMd = `---
name: "${sopSlug}"
triggers: ["${reqItem.sopTemplate || 'feature_flow'}", "${reqItem.baseBranch}", "solidified-sop"]
scope: "team"
version: 1
---

# 固化 SOP：${reqItem.title}

## 来源流水线
- 需求编号：\`${reqItem.id.toUpperCase()}\`
- 模板类型：\`${reqItem.sopTemplate || 'feature_flow'}\`
- 目标仓库：\`${reqItem.repoUrl}\`

## 标准化 DAG 执行步骤
${stepLines}

## 复用规范
- 所有写入操作必须在隔离 \`git worktree\` 中完成并通过确定性门禁（lint / typecheck / unit_test / cross_review）。
`;

    const existingMem = state.current.memories.find((m) => m.id === `mem-${sopSlug}`);
    let asset: MemoryAsset;
    if (existingMem) {
      existingMem.contentMd = contentMd;
      existingMem.version += 1;
      existingMem.status = 'published';
      asset = existingMem;
    } else {
      asset = {
        id: `mem-${sopSlug}`,
        teamId: reqItem.teamId,
        ownerId: reqItem.createdBy,
        assetType: 'SKILL',
        scope: 'team',
        status: 'published',
        title: `SOP 模板：${reqItem.title}`,
        contentMd,
        sourceReason: `由已完成流水线 ${reqItem.id.toUpperCase()} 一键固化并同步至 ${gitPath}`,
        duplicateScore: 0.04,
        version: 1,
        createdAt: nowIso,
        acl: [
          {
            assetId: `mem-${sopSlug}`,
            subjectType: 'team',
            subjectId: reqItem.teamId,
            permission: 'read',
          },
        ],
      };
      state.current.memories.unshift(asset);
    }

    const existingTeamAi = state.current.teamAiAssets.find((a) => a.path === gitPath);
    let teamAiAsset: TeamAiAsset;
    if (existingTeamAi) {
      existingTeamAi.content = contentMd;
      existingTeamAi.updatedAt = nowIso;
      existingTeamAi.syncedToGit = false;
      teamAiAsset = existingTeamAi;
    } else {
      teamAiAsset = {
        path: gitPath,
        category: 'skill',
        title: `SOP: ${reqItem.title}`,
        content: contentMd,
        updatedAt: nowIso,
        syncedToGit: false,
      };
      state.current.teamAiAssets.push(teamAiAsset);
    }

    syncTeamAiFileToDisk(gitPath, contentMd);
    saveState(state.current);
    res.json({
      asset,
      teamAiAsset,
      memories: state.current.memories,
      teamAiAssets: state.current.teamAiAssets,
    });
  });
}
