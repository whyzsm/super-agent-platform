import type {
  DaemonRunner,
  DagNode,
  MemoryAsset,
  Requirement,
  TeamAiAsset,
} from '../protocol';

export interface PlatformState {
  requirements: Requirement[];
  tasks: DagNode[];
  daemons: DaemonRunner[];
  memories: MemoryAsset[];
  teamAiAssets: TeamAiAsset[];
}

export function createInitialSeedState(): PlatformState {
  const requirements: Requirement[] = [
    {
      id: 'req-2041',
      teamId: 'team-platform-core',
      title: '企业微信 / 飞书 IM 网关与 ACP 双向高危拦截接入',
      specMd:
        '### 需求背景\n打通企业微信与飞书群聊机器人触发研发流水线能力，并在 Local Daemon 执行高危命令前通过 ACP 双向协议推送 Danger Gate 审批卡片。\n\n### 验收标准\n1. IM 卡片支持批准放行 / 附带意见打回 / 终止任务，回调具备幂等校验。\n2. Local Daemon 隔离 worktree 内执行 lint + typecheck + 单测全绿后再由异构模型 Reviewer 交叉审查。\n3. 出站 L0 日志必须完成密钥与 PII 正则脱敏。',
      repoUrl: 'git@example.invalid:superagent/platform-core.git',
      baseBranch: 'main',
      sourceChannel: 'wecom',
      sopTemplate: 'feature_flow',
      status: 'AWAITING_GATE',
      createdBy: 'lin.wei',
      createdAt: '2026-11-15T00:12:00Z',
    },
    {
      id: 'req-2042',
      teamId: 'team-platform-core',
      title: '支付对账流水异步幂等重构与死信重放',
      specMd:
        '### 需求背景\n将日终对账单解析拆分为独立并发 Worktree 任务，修复并发写入竞态并补齐幂等键约束。\n\n### 验收标准\n1. 唯一索引 `(merchant_id, settle_date, batch_seq)` 防止重复入账。\n2. 支持指数退避重放与人工熔断恢复。',
      repoUrl: 'git@example.invalid:fintech/reconcile-engine.git',
      baseBranch: 'release/v2.4',
      sourceChannel: 'web',
      sopTemplate: 'bugfix_flow',
      status: 'IN_PROGRESS',
      createdBy: 'zhou.min',
      createdAt: '2026-11-14T22:40:00Z',
    },
    {
      id: 'req-2043',
      teamId: 'team-platform-core',
      title: 'Memory Hub pgvector HNSW 召回与四级 ACL 过滤',
      specMd:
        '### 需求背景\n为 MCP Tool 召回接口增加 Team / Project / User / Agent 四级 ACL 权限过滤，防止跨项目私有方案泄露。\n\n### 验收标准\n1. HNSW 检索延迟 P95 < 45ms。\n2. 仅允许 status=published 资产参与团队自动注入。',
      repoUrl: 'git@example.invalid:superagent/memory-hub.git',
      baseBranch: 'main',
      sourceChannel: 'cli',
      sopTemplate: 'feature_flow',
      status: 'COMPLETED',
      createdBy: 'chen.hao',
      createdAt: '2026-11-14T18:10:00Z',
    },
  ];

  const tasks: DagNode[] = [
    // REQ-2041 DAG
    {
      id: 'task-2041-plan',
      reqId: 'req-2041',
      title: '需求拆解与 Worktree 拓扑规划',
      role: 'planner',
      provider: 'claude-code',
      adapterMode: 'headless_json',
      dependsOn: [],
      state: 'MERGED',
      retryCount: 0,
      maxRetries: 3,
      assignedMachine: 'mac-studio-sh-01',
      worktreeBranch: 'agent/task-2041-plan',
      worktreePath: '~/.superagent/worktrees/platform-core/task-2041-plan',
      localPort: 4101,
      position: { x: 40, y: 140 },
      events: [
        {
          id: 'ev-1',
          ts: '00:12:08',
          seq: 101,
          kind: 'thought',
          title: '解析需求上下文与 .teamai/AGENTS.md 规范',
          detail: '识别出 2 个无文件重叠的子模块：IM Webhook 验签层 与 ACP 双向拦截器，可分配并行 Worktree。',
          status: 'ok',
        },
        {
          id: 'ev-2',
          ts: '00:12:19',
          seq: 102,
          kind: 'verifier_check',
          title: 'Plan Gate 已通过人工确认',
          detail: 'Reviewer lin.wei 确认拆解方案与依赖拓扑。',
          status: 'ok',
        },
      ],
      terminalLines: [
        '[claude-code --output-format stream-json] reading .teamai/AGENTS.md ...',
        '[planner] generated 4-node DAG (1 planner, 2 parallel builders, 1 cross-model reviewer)',
        '[gate] PLAN_GATE approved by lin.wei -> MERGED',
      ],
      verifierChecks: [
        { name: 'lint', passed: true, durationMs: 420, summary: '0 warnings' },
        { name: 'typecheck', passed: true, durationMs: 680, summary: 'tsc --noEmit passed' },
      ],
      lineComments: [],
      usage: {
        inputTokens: 9800,
        outputTokens: 2450,
        costUsd: 0.0662,
        durationSec: 28,
        budgetTokens: 40000,
      },
      diffPatch: `--- a/.teamai/plans/req-2041.md
+++ b/.teamai/plans/req-2041.md
@@ -0,0 +1,6 @@
+# Execution DAG for REQ-2041
+- Builder A (codex): IM Webhook 验签与卡片回调路由
+- Builder B (workbuddy): ACP 双向工具拦截与 Danger Gate 挂起
+- Reviewer (claude-code): 异构模型交叉安全审查`,
    },
    {
      id: 'task-2041-b1',
      reqId: 'req-2041',
      title: 'IM Webhook 验签与审批卡片回调',
      role: 'builder',
      provider: 'codex',
      adapterMode: 'headless_json',
      dependsOn: ['task-2041-plan'],
      state: 'HUMAN_GATE',
      retryCount: 1,
      maxRetries: 3,
      hadFailureOrCorrection: true,
      lastErrorFeedback: '首次单测因缺少时间戳重放窗口校验失败，已补充 300s 防重放校验并全绿。',
      assignedMachine: 'mac-studio-sh-01',
      worktreeBranch: 'agent/task-2041-b1',
      worktreePath: '~/.superagent/worktrees/platform-core/task-2041-b1',
      localPort: 4102,
      position: { x: 340, y: 40 },
      events: [
        {
          id: 'ev-b1-1',
          ts: '00:14:02',
          seq: 204,
          kind: 'file_edit',
          title: '编辑 src/gateway/wecomCallback.ts',
          detail: '实现 HMAC-SHA256 签名校验与 300 秒防重放时间窗校验',
          status: 'ok',
        },
        {
          id: 'ev-b1-2',
          ts: '00:15:11',
          seq: 205,
          kind: 'shell_exec',
          title: '运行脱敏日志与单测校验',
          detail: '检测出 1 处测试 Token 样本，已自动脱敏为 [REDACTED_BEARER_TOKEN]',
          status: 'ok',
          redactedHits: 1,
        },
        {
          id: 'ev-b1-3',
          ts: '00:16:05',
          seq: 206,
          kind: 'verifier_check',
          title: '本地确定性门禁全绿 + 异构 Reviewer 预审通过',
          detail: 'lint (0 err) · typecheck (0 err) · unit_test (14/14) · claude-code cross-review passed',
          status: 'ok',
        },
      ],
      terminalLines: [
        '$ git worktree add -b agent/task-2041-b1 ~/.superagent/worktrees/platform-core/task-2041-b1 main',
        '[codex exec --json] attempt #1 failed: ReplayWindowError not thrown on stale timestamp',
        '[server] INJECT_RETRY -> injected stacktrace into agent/task-2041-b1',
        '[codex exec --json] patched src/gateway/wecomCallback.ts (+24 -4)',
        '$ pnpm test:unit src/gateway/wecomCallback.test.ts -> 14 passed (118ms)',
        '[verifier] all deterministic checks passed -> entering MERGE_GATE',
      ],
      verifierChecks: [
        { name: 'lint', passed: true, durationMs: 510, summary: 'eslint clean (0 issues)' },
        { name: 'typecheck', passed: true, durationMs: 920, summary: 'tsc --noEmit 0 errors' },
        { name: 'unit_test', passed: true, durationMs: 118, summary: '14/14 assertions passed' },
        { name: 'cross_review', passed: true, durationMs: 2140, summary: 'claude-code 交叉审查通过' },
      ],
      lineComments: [
        {
          id: 'lc-1',
          file: 'src/gateway/wecomCallback.ts',
          line: 14,
          author: 'lin.wei',
          comment: '建议将 300_000 抽取为常量 REPLAY_WINDOW_MS 便于配置中心覆盖。',
          createdAt: '2026-11-15T00:18:00Z',
        },
      ],
      activeCheckpoint: {
        id: 'ckpt-2041-b1',
        taskId: 'task-2041-b1',
        gateType: 'MERGE_GATE',
        summaryMd:
          '已完成企业微信/飞书审批卡片回调验签与幂等锁（历经 1 次失败自愈后全绿）。等待人类确认合入 main。',
        status: 'WAITING',
        createdAt: '2026-11-15T00:16:10Z',
      },
      usage: {
        inputTokens: 28400,
        outputTokens: 7600,
        costUsd: 0.1992,
        durationSec: 114,
        budgetTokens: 80000,
      },
      diffPatch: `--- a/src/gateway/wecomCallback.ts
+++ b/src/gateway/wecomCallback.ts
@@ -6,12 +6,25 @@ export interface GateCardAction {
   taskId: string;
   approved: boolean;
   comment?: string;
+  timestamp: number;
+  nonce: string;
 }
 
 export function verifyWecomSignature(
   signature: string,
   payload: string,
-  secret: string
+  secret: string,
+  nowMs = Date.now()
 ): boolean {
+  const parsed = JSON.parse(payload) as GateCardAction;
+  if (Math.abs(nowMs - parsed.timestamp) > 300_000) {
+    throw new Error('ReplayWindowError: callback timestamp expired');
+  }
   const expected = createHmac('sha256', secret).update(payload).digest('hex');
-  return expected === signature;
+  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
 }`,
    },
    {
      id: 'task-2041-b2',
      reqId: 'req-2041',
      title: 'ACP 双向工具拦截与高危命令熔断',
      role: 'builder',
      provider: 'workbuddy',
      adapterMode: 'acp_bidirectional',
      dependsOn: ['task-2041-plan'],
      state: 'HUMAN_GATE',
      retryCount: 0,
      maxRetries: 3,
      assignedMachine: 'ubuntu-ci-runner-04',
      worktreeBranch: 'agent/task-2041-b2',
      worktreePath: '~/.superagent/worktrees/platform-core/task-2041-b2',
      localPort: 4103,
      position: { x: 340, y: 240 },
      events: [
        {
          id: 'ev-b2-1',
          ts: '00:13:45',
          seq: 301,
          kind: 'tool_call',
          title: 'WorkBuddy 请求执行数据库迁移清理脚本',
          detail: 'tool_call: shell_exec("psql -c \\"DROP TABLE temp_legacy_sessions;\\"")',
          status: 'blocked',
        },
        {
          id: 'ev-b2-2',
          ts: '00:13:46',
          seq: 302,
          kind: 'acp_intercept',
          title: 'ACP 双向拦截器命中 NO_DESTRUCTIVE_SQL 规则',
          detail: '已挂起子进程标准输入流，等待操作员确认 Danger Gate。',
          status: 'blocked',
        },
      ],
      terminalLines: [
        '[workbuddy --acp stdio] connected to local runner ubuntu-ci-runner-04',
        '[acp-guard] intercepted tool_call#tc_8821: psql -c "DROP TABLE temp_legacy_sessions;"',
        '[acp-guard] RULE HIT: NO_DESTRUCTIVE_SQL -> suspending tool execution',
        '[checkpoint] emitted DANGER_GATE card to Web Console & WeCom',
      ],
      verifierChecks: [
        { name: 'lint', passed: true, durationMs: 390, summary: 'passed prior to intercept' },
      ],
      lineComments: [],
      activeCheckpoint: {
        id: 'ckpt-2041-b2',
        taskId: 'task-2041-b2',
        gateType: 'DANGER_GATE',
        summaryMd:
          'ACP 双向协议拦截到高危 SQL 指令：`DROP TABLE temp_legacy_sessions;`。\n命中安全规则 `NO_DESTRUCTIVE_SQL`，已冻结沙箱进程等待人工裁决。',
        status: 'WAITING',
        createdAt: '2026-11-15T00:13:48Z',
      },
      usage: {
        inputTokens: 16200,
        outputTokens: 4100,
        costUsd: 0.1101,
        durationSec: 64,
        budgetTokens: 60000,
      },
      diffPatch: `--- a/src/daemon/acpGuard.ts
+++ b/src/daemon/acpGuard.ts
@@ -18,6 +18,12 @@ export async function onToolCallRequest(call: AcpToolCall): Promise<AcpDecision>
   const check = detectDangerousCommand(call.command);
   if (check.dangerous) {
+    await emitCheckpoint({
+      taskId: call.taskId,
+      gateType: 'DANGER_GATE',
+      rule: check.rule,
+      command: call.command,
+    });
     return { allow: false, waitForHumanGate: true, reason: check.reason };
   }
   return { allow: true };`,
    },
    {
      id: 'task-2041-review',
      reqId: 'req-2041',
      title: '异构模型全链路安全与回归交叉审查',
      role: 'reviewer',
      provider: 'claude-code',
      adapterMode: 'headless_json',
      dependsOn: ['task-2041-b1', 'task-2041-b2'],
      state: 'PENDING',
      retryCount: 0,
      maxRetries: 3,
      assignedMachine: 'mac-studio-sh-01',
      worktreeBranch: 'agent/task-2041-review',
      worktreePath: '~/.superagent/worktrees/platform-core/task-2041-review',
      localPort: 4104,
      position: { x: 660, y: 140 },
      events: [
        {
          id: 'ev-rev-1',
          ts: '00:12:20',
          seq: 401,
          kind: 'thought',
          title: '等待上游并行 Worktree 节点全部 MERGED',
          detail: '依赖节点：task-2041-b1 (HUMAN_GATE), task-2041-b2 (HUMAN_GATE)',
          status: 'running',
        },
      ],
      terminalLines: [
        '[scheduler] task-2041-review waiting for upstream MERGED: [task-2041-b1, task-2041-b2]',
      ],
      verifierChecks: [],
      lineComments: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationSec: 0,
        budgetTokens: 50000,
      },
      diffPatch: `// 上游任务合并后自动在隔离 Worktree 拉起交叉审查`,
    },

    // REQ-2042 DAG
    {
      id: 'task-2042-plan',
      reqId: 'req-2042',
      title: '对账状态机边界拆解与索引设计',
      role: 'planner',
      provider: 'claude-code',
      adapterMode: 'headless_json',
      dependsOn: [],
      state: 'MERGED',
      retryCount: 0,
      maxRetries: 3,
      assignedMachine: 'ubuntu-ci-runner-04',
      worktreeBranch: 'agent/task-2042-plan',
      position: { x: 40, y: 140 },
      events: [
        {
          id: 'ev-2042-p',
          ts: '22:42:10',
          seq: 501,
          kind: 'verifier_check',
          title: 'Plan Gate 已批准',
          detail: '拆分为幂等表约束与死信重放队列两路并发开发',
          status: 'ok',
        },
      ],
      terminalLines: ['[planner] approved -> MERGED'],
      verifierChecks: [{ name: 'lint', passed: true, durationMs: 310, summary: '0 errors' }],
      lineComments: [],
      usage: {
        inputTokens: 8400,
        outputTokens: 1950,
        costUsd: 0.0545,
        durationSec: 21,
        budgetTokens: 40000,
      },
      diffPatch: `--- a/docs/reconcile-plan.md\n+++ b/docs/reconcile-plan.md\n@@ -0,0 +1,3 @@\n+# Reconcile Idempotency Plan\n+1. Unique key on (merchant_id, settle_date, batch_seq)\n+2. Exponential backoff DLQ worker`,
    },
    {
      id: 'task-2042-b1',
      reqId: 'req-2042',
      title: '幂等唯一索引与并发冲突重试实现',
      role: 'builder',
      provider: 'codex',
      adapterMode: 'headless_json',
      dependsOn: ['task-2042-plan'],
      state: 'RUNNING',
      retryCount: 0,
      maxRetries: 3,
      assignedMachine: 'ubuntu-ci-runner-04',
      worktreeBranch: 'agent/task-2042-b1',
      worktreePath: '~/.superagent/worktrees/reconcile-engine/task-2042-b1',
      localPort: 4201,
      position: { x: 350, y: 60 },
      events: [
        {
          id: 'ev-2042-b1',
          ts: '22:45:12',
          seq: 512,
          kind: 'file_edit',
          title: '正在更新 src/reconcile/ledgerUpsert.ts',
          detail: '使用 ON CONFLICT DO NOTHING RETURNING 实现幂等入账',
          status: 'running',
        },
      ],
      terminalLines: [
        '[codex exec --json] modifying src/reconcile/ledgerUpsert.ts ...',
        '[codex exec --json] running vitest reconcile.spec.ts ...',
      ],
      verifierChecks: [],
      lineComments: [],
      usage: {
        inputTokens: 19500,
        outputTokens: 4800,
        costUsd: 0.1305,
        durationSec: 53,
        budgetTokens: 60000,
      },
      diffPatch: `--- a/src/reconcile/ledgerUpsert.ts
+++ b/src/reconcile/ledgerUpsert.ts
@@ -11,5 +11,9 @@ export async function insertSettleBatch(row: SettleRow) {
-  return db.insert(settleBatches).values(row);
+  return db
+    .insert(settleBatches)
+    .values(row)
+    .onConflictDoNothing({ target: [settleBatches.merchantId, settleBatches.settleDate, settleBatches.batchSeq] })
+    .returning();
 }`,
    },
    {
      id: 'task-2042-b2',
      reqId: 'req-2042',
      title: '死信队列指数退避重放器',
      role: 'builder',
      provider: 'opencode',
      adapterMode: 'pty_tmux',
      dependsOn: ['task-2042-plan'],
      state: 'RETRY_WAIT',
      retryCount: 2,
      maxRetries: 3,
      hadFailureOrCorrection: true,
      lastErrorFeedback:
        'TypeError: Cannot read properties of undefined (reading "backoffMs") in retryPolicy.test.ts:44',
      assignedMachine: 'thinkpad-dev-chen',
      worktreeBranch: 'agent/task-2042-b2',
      worktreePath: '~/.superagent/worktrees/reconcile-engine/task-2042-b2',
      localPort: 4202,
      position: { x: 350, y: 220 },
      events: [
        {
          id: 'ev-2042-b2',
          ts: '22:48:03',
          seq: 530,
          kind: 'verifier_check',
          title: '单测校验失败，已注入错误栈等待第 3 次重试',
          detail: 'retryPolicy.test.ts:44 backoffMs undefined when attempt=0',
          status: 'failed',
        },
      ],
      terminalLines: [
        '[opencode run --format json] running unit tests...',
        'FAIL src/dlq/retryPolicy.test.ts > calculates jitter backoff',
        'TypeError: Cannot read properties of undefined (reading "backoffMs")',
        '[loop] state -> RETRY_WAIT (attempt 2/3)',
      ],
      verifierChecks: [
        { name: 'lint', passed: true, durationMs: 280, summary: 'eslint passed' },
        { name: 'typecheck', passed: true, durationMs: 610, summary: 'tsc passed' },
        { name: 'unit_test', passed: false, durationMs: 95, summary: '1 failed in retryPolicy.test.ts' },
      ],
      lineComments: [],
      usage: {
        inputTokens: 41000,
        outputTokens: 11200,
        costUsd: 0.291,
        durationSec: 138,
        budgetTokens: 60000,
      },
      diffPatch: `--- a/src/dlq/retryPolicy.ts
+++ b/src/dlq/retryPolicy.ts
@@ -4,5 +4,5 @@ export function nextBackoff(attempt: number, opts?: { baseMs: number }) {
-  return opts.baseMs * Math.pow(2, attempt);
+  const base = opts?.baseMs ?? 500;
+  return Math.min(base * Math.pow(2, attempt), 60_000);
 }`,
    },

    // REQ-2043 DAG
    {
      id: 'task-2043-all',
      reqId: 'req-2043',
      title: 'HNSW 索引调优与四级 ACL SQL 过滤器',
      role: 'builder',
      provider: 'claude-code',
      adapterMode: 'headless_json',
      dependsOn: [],
      state: 'MERGED',
      retryCount: 1,
      maxRetries: 3,
      hadFailureOrCorrection: true,
      assignedMachine: 'mac-studio-sh-01',
      worktreeBranch: 'agent/task-2043-acl',
      worktreePath: '~/.superagent/worktrees/memory-hub/task-2043-acl',
      localPort: 4301,
      position: { x: 180, y: 140 },
      events: [
        {
          id: 'ev-2043-1',
          ts: '18:25:00',
          seq: 601,
          kind: 'verifier_check',
          title: 'Merge Gate 已放行并自动提炼 Skill Draft',
          detail: 'P95 延迟从 140ms 降至 31ms，ACL 隔离测试 100% 通过。',
          status: 'ok',
        },
      ],
      terminalLines: [
        '[claude-code] benchmark: p95=31.4ms (<45ms target)',
        '[gate] MERGE_GATE approved by chen.hao -> MERGED',
      ],
      verifierChecks: [
        { name: 'lint', passed: true, durationMs: 300, summary: '0 errors' },
        { name: 'typecheck', passed: true, durationMs: 540, summary: '0 errors' },
        { name: 'unit_test', passed: true, durationMs: 420, summary: '22/22 passed' },
        { name: 'cross_review', passed: true, durationMs: 1850, summary: 'codex 交叉审查通过' },
      ],
      lineComments: [],
      usage: {
        inputTokens: 31200,
        outputTokens: 8900,
        costUsd: 0.2271,
        durationSec: 96,
        budgetTokens: 60000,
      },
      diffPatch: `--- a/src/memory/aclQuery.ts
+++ b/src/memory/aclQuery.ts
@@ -12,4 +12,8 @@ export function buildAclFilter(ctx: CallerContext) {
   return sql\`status = 'published' AND EXISTS (
     SELECT 1 FROM asset_acl a WHERE a.asset_id = memory_assets.id
+    AND ((a.subject_type = 'team' AND a.subject_id = \${ctx.teamId})
+      OR (a.subject_type = 'project' AND a.subject_id = \${ctx.projectId})
+      OR (a.subject_type = 'user' AND a.subject_id = \${ctx.userId})
+      OR (a.subject_type = 'agent' AND a.subject_id = \${ctx.agentId}))
   )\`;
 }`,
    },
  ];

  const daemons: DaemonRunner[] = [
    {
      machineId: 'mac-studio-sh-01',
      hostname: 'build-mac-01.example.invalid',
      os: 'macOS 15.2 (arm64)',
      status: 'online',
      providers: ['codex', 'claude-code', 'workbuddy'],
      activeTaskIds: ['task-2041-b1'],
      cpuLoad: 38.4,
      memUsedGb: 24.6,
      memTotalGb: 64,
      lastHeartbeatAt: '2026-11-15T00:44:10Z',
      lastAckSeq: 206,
      pendingOfflineEvents: 0,
      worktrees: [
        {
          taskId: 'task-2041-b1',
          branch: 'agent/task-2041-b1',
          path: '~/.superagent/worktrees/platform-core/task-2041-b1',
          port: 4102,
          provider: 'codex',
          adapterMode: 'headless_json',
        },
        {
          taskId: 'task-2041-review',
          branch: 'agent/task-2041-review',
          path: '~/.superagent/worktrees/platform-core/task-2041-review',
          port: 4104,
          provider: 'claude-code',
          adapterMode: 'headless_json',
        },
      ],
    },
    {
      machineId: 'ubuntu-ci-runner-04',
      hostname: 'runner-04.example.invalid',
      os: 'Ubuntu 24.04 LTS (x86_64)',
      status: 'online',
      providers: ['codex', 'workbuddy', 'opencode'],
      activeTaskIds: ['task-2041-b2', 'task-2042-b1'],
      cpuLoad: 64.2,
      memUsedGb: 18.2,
      memTotalGb: 32,
      lastHeartbeatAt: '2026-11-15T00:44:12Z',
      lastAckSeq: 512,
      pendingOfflineEvents: 0,
      worktrees: [
        {
          taskId: 'task-2041-b2',
          branch: 'agent/task-2041-b2',
          path: '~/.superagent/worktrees/platform-core/task-2041-b2',
          port: 4103,
          provider: 'workbuddy',
          adapterMode: 'acp_bidirectional',
        },
        {
          taskId: 'task-2042-b1',
          branch: 'agent/task-2042-b1',
          path: '~/.superagent/worktrees/reconcile-engine/task-2042-b1',
          port: 4201,
          provider: 'codex',
          adapterMode: 'headless_json',
        },
      ],
    },
    {
      machineId: 'thinkpad-dev-chen',
      hostname: 'dev-laptop-01.example.invalid',
      os: 'Ubuntu 24.04 (WSL2)',
      status: 'reconnecting',
      providers: ['opencode', 'claude-code'],
      activeTaskIds: ['task-2042-b2'],
      cpuLoad: 21.0,
      memUsedGb: 11.4,
      memTotalGb: 32,
      lastHeartbeatAt: '2026-11-15T00:42:55Z',
      lastAckSeq: 528,
      pendingOfflineEvents: 4,
      worktrees: [
        {
          taskId: 'task-2042-b2',
          branch: 'agent/task-2042-b2',
          path: '~/.superagent/worktrees/reconcile-engine/task-2042-b2',
          port: 4202,
          provider: 'opencode',
          adapterMode: 'pty_tmux',
        },
      ],
    },
  ];

  const memories: MemoryAsset[] = [
    {
      id: 'mem-skill-draft-1',
      teamId: 'team-platform-core',
      projectId: 'proj-memory-hub',
      ownerId: 'chen.hao',
      assetType: 'SKILL',
      scope: 'team',
      status: 'draft',
      title: 'SOP 草案：pgvector HNSW 多租户 ACL 联合过滤规范',
      contentMd: `---
name: "sop-pgvector-acl-filter"
triggers: ["pgvector", "memory_assets", "acl", "mcp-recall"]
scope: "team"
version: 1
---

# 经验沉淀：pgvector HNSW 多租户 ACL 过滤

## 触发根因（Failure / Review Correction）
在 REQ-2043 首次压测中，先做向量 KNN 再在应用层过滤 ACL 导致 Top-K 召回不足且 P95 超出 120ms；在人工纠偏后改为下推 \`status = 'published'\` 与 \`EXISTS (asset_acl)\` 联合条件并调优 \`hnsw.ef_search = 64\`。

## 标准化修复规范（SOP）
1. 所有 MCP 召回查询必须显式限定 \`status = 'published'\`，严禁召回 \`draft\` 草案。
2. 必须通过 \`asset_acl\` 验证 Team / Project / User / Agent 四级主体任一命中。`,
      sourceTaskId: 'task-2043-all',
      sourceReason: '由 REQ-2043 失败重试并经人工纠偏通过后自动提炼',
      duplicateScore: 0.12,
      version: 1,
      createdAt: '2026-11-14T18:45:00Z',
      acl: [
        {
          assetId: 'mem-skill-draft-1',
          subjectType: 'team',
          subjectId: 'team-platform-core',
          permission: 'admin',
        },
      ],
    },
    {
      id: 'mem-skill-pub-1',
      teamId: 'team-platform-core',
      ownerId: 'lin.wei',
      assetType: 'SKILL',
      scope: 'team',
      status: 'published',
      title: 'Webhook 签名校验与 300s 防重放窗口规范',
      contentMd: `---
name: "sop-webhook-replay-guard"
triggers: ["webhook", "wecom", "feishu", "hmac"]
scope: "team"
version: 2
---

# Webhook 签名校验与防重放规范

1. 必须使用 \`crypto.timingSafeEqual\` 对比 HMAC 摘要，禁止使用 \`===\` 直接字符串比对。
2. 回调负载必须校验 \`timestamp\` 与服务器当前时间差 <= 300,000ms。`,
      sourceReason: '已发布并同步至 .teamai/skills/webhook-replay-guard.md',
      duplicateScore: 0.05,
      version: 2,
      createdAt: '2026-11-10T09:30:00Z',
      acl: [
        {
          assetId: 'mem-skill-pub-1',
          subjectType: 'team',
          subjectId: 'team-platform-core',
          permission: 'read',
        },
        {
          assetId: 'mem-skill-pub-1',
          subjectType: 'agent',
          subjectId: 'codex',
          permission: 'read',
        },
      ],
    },
    {
      id: 'mem-l2-1',
      teamId: 'team-platform-core',
      projectId: 'proj-reconcile',
      ownerId: 'zhou.min',
      assetType: 'L2_SOLUTION',
      scope: 'project',
      status: 'published',
      title: '日终对账单并发写入幂等键落库方案',
      contentMd:
        '### 场景方案\n当多个 Worktree 或消费线程并发处理对账切片时，采用 PostgreSQL 联合唯一索引 `(merchant_id, settle_date, batch_seq)` 配合 `ON CONFLICT DO NOTHING RETURNING`，避免应用层分布式锁超时导致的幽灵重复入账。',
      version: 1,
      createdAt: '2026-11-12T15:20:00Z',
      acl: [
        {
          assetId: 'mem-l2-1',
          subjectType: 'project',
          subjectId: 'proj-reconcile',
          permission: 'read',
        },
      ],
    },
    {
      id: 'mem-wiki-1',
      teamId: 'team-platform-core',
      ownerId: 'system-extractor',
      assetType: 'LLM_WIKI',
      scope: 'team',
      status: 'published',
      title: '仓库架构图谱：platform-core 沙箱与 ACP 通信路径',
      contentMd:
        '### CodeGraph 摘要\n`apps/daemon/src/worktreeManager.ts` -> `apps/daemon/src/adapters/acpBridge.ts` -> `apps/server/src/ws/gateway.ts` -> `task_checkpoints`。\n所有本地子进程的工作目录强制锁定在 `~/.superagent/worktrees/<repo>/<taskId>`，依赖缓存通过只读 symlink 挂载。',
      version: 4,
      createdAt: '2026-11-14T11:00:00Z',
      acl: [
        {
          assetId: 'mem-wiki-1',
          subjectType: 'team',
          subjectId: 'team-platform-core',
          permission: 'read',
        },
      ],
    },
    {
      id: 'mem-fact-1',
      teamId: 'team-platform-core',
      ownerId: 'lin.wei',
      assetType: 'L1_FACT',
      scope: 'user',
      status: 'published',
      title: 'L1 原子事实：测试环境 Redis 7 默认关闭持久化 AOF',
      contentMd:
        '本地集成测试启动 Redis 7 容器时需挂载 `--appendonly no` 防止工作区磁盘膨胀；任务状态机权威快照以 PostgreSQL `task_nodes` 与 `task_checkpoints` 为准。',
      version: 1,
      createdAt: '2026-11-13T16:40:00Z',
      acl: [
        {
          assetId: 'mem-fact-1',
          subjectType: 'user',
          subjectId: 'lin.wei',
          permission: 'write',
        },
      ],
    },
  ];

  const teamAiAssets: TeamAiAsset[] = [
    {
      path: '.teamai/AGENTS.md',
      category: 'agents_md',
      title: '团队 Agent 全局行为规范 (AGENTS.md)',
      syncedToGit: false,
      updatedAt: '2026-11-14T20:00:00Z',
      content: `# SuperAgent 团队研发协作规范 (AGENTS.md)

## 1. 沙箱与隔离红线
- 所有代码修改必须在 \`.worktrees/<taskId>\`（真实 \`git worktree\`，绝对路径以 \`/api/workspaces\` 返回为准）隔离分支执行，严禁直接操作主干分支。
- 严禁输出或提交任何未脱敏的 API Key、数据库密码或 PII 个人敏感信息。

## 2. 确定性门禁前置
- 提交 \`MERGE_GATE\` 前，Local Daemon 必须依次执行：
  1. \`npm run lint\`
  2. \`npm test\`
- 上述两项全绿后，方可唤醒异构模型 Reviewer Agent 进行交叉审查。
- 说明：本仓库为 npm 工程，不存在 \`typecheck\` 独立脚本（\`tsc --noEmit\` 已由 \`npm run lint\` 覆盖）；
  禁止在门禁脚本里登记未定义的命令，否则 hook 会必然失败。`,
    },
    {
      path: '.teamai/rules/sandbox-guard.md',
      category: 'rule',
      title: '高危指令与敏感路径拦截规则',
      syncedToGit: false,
      updatedAt: '2026-11-13T14:10:00Z',
      content: `# Sandbox Guard Rules
- BLOCK & TRIGGER DANGER_GATE:
  - \`rm -rf /\` or destructive root wildcards
  - \`DROP TABLE\` / \`DROP DATABASE\`
  - \`git push --force\` / \`git push -f\`
  - Read/Write outside assigned worktree or accessing \`.env*\`, \`~/.ssh/\`, \`/etc/\``,
    },
    {
      path: '.teamai/skills/webhook-replay-guard.md',
      category: 'skill',
      title: 'Skill: Webhook 签名与防重放窗口',
      syncedToGit: false,
      updatedAt: '2026-11-10T09:30:00Z',
      content: `---
name: "sop-webhook-replay-guard"
triggers: ["webhook", "wecom", "feishu", "hmac"]
scope: "team"
version: 2
---

# Webhook 签名校验与防重放规范
1. 使用 \`timingSafeEqual\` 防止时序侧信道攻击。
2. 强制校验 300s 时间戳重放窗口。`,
    },
    {
      path: '.teamai/hooks/pre-merge-gate.sh',
      category: 'hook',
      title: 'Hook: 确定性验证门禁脚本',
      syncedToGit: false,
      updatedAt: '2026-11-11T11:20:00Z',
      content: `#!/usr/bin/env bash
set -euo pipefail
npm run lint
npm test`,
    },
  ];

  return {
    requirements,
    tasks,
    daemons,
    memories,
    teamAiAssets,
  };
}
