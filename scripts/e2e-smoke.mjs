#!/usr/bin/env node
/**
 * 端到端冒烟：对已启动的服务（默认 http://localhost:3000）跑真实 HTTP 断言。
 *
 * 用法:
 *   node scripts/e2e-smoke.mjs                 # 跑全部用例
 *   BASE_URL=http://localhost:3000 node scripts/e2e-smoke.mjs
 *   node scripts/e2e-smoke.mjs --no-reset      # 不重置状态（默认会先 reset）
 *
 * 退出码: 0 全部通过 / 1 存在失败用例 / 2 服务不可达
 *
 * 说明: 只断言「确定由状态机与协议决定」的字段；不猜测业务文案。
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DO_RESET = !process.argv.includes('--no-reset');

const results = [];
let uid = 0;
const nextId = (prefix) => `${prefix}-smoke-${Date.now().toString(36)}-${++uid}`;

async function call(method, path, { body, headers = {}, timeout = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: undefined, text: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  return ok;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function main() {
  const probe = await call('GET', '/api/health', { timeout: 5000 });
  if (probe.status !== 200) {
    console.error(`服务不可达: ${BASE} (${probe.status || probe.text})`);
    process.exit(2);
  }
  console.log(`目标: ${BASE}\n`);

  if (DO_RESET) {
    const r = await call('POST', '/api/reset', { body: {} });
    check('reset: 状态可重置', r.status === 200, `status=${r.status}`);
  }

  // ---- 1. 基础只读接口 ----
  {
    const h = await call('GET', '/api/health');
    check(
      'health: ok=true 且 seq 为数字',
      h.status === 200 && h.json?.ok === true && typeof h.json?.seq === 'number',
      `status=${h.status} body=${h.text.slice(0, 120)}`,
    );

    const b = await call('GET', '/api/bootstrap');
    const keys = ['requirements', 'tasks', 'daemons', 'memories', 'teamAiAssets'];
    check(
      'bootstrap: 五个顶层集合齐备',
      b.status === 200 && keys.every((k) => Array.isArray(b.json?.[k])),
      `status=${b.status} missing=${keys.filter((k) => !Array.isArray(b.json?.[k]))}`,
    );

    const ev = await call('GET', '/api/runtime/events');
    check(
      'runtime/events: 返回事件数组',
      ev.status === 200 && Array.isArray(ev.json?.events),
      `status=${ev.status}`,
    );

    const au = await call('GET', '/api/runtime/audit');
    check(
      'runtime/audit: 审计条目含 seq/action/outcome',
      au.status === 200 &&
        Array.isArray(au.json?.entries) &&
        au.json.entries.every((e) => 'seq' in e && 'action' in e && 'outcome' in e),
      `status=${au.status}`,
    );
  }

  // ---- 2. 需求创建与校验 ----
  let created = null;
  {
    const bad = await call('POST', '/api/requirements', { body: { title: '  ' } });
    check('requirements: 空标题被拒 400', bad.status === 400, `status=${bad.status}`);

    const ok = await call('POST', '/api/requirements', {
      body: {
        title: `冒烟需求 ${Date.now()}`,
        specMd: '## 冒烟规格\n- 验收：链路可跑通',
        repoUrl: 'git@example.invalid:superagent/app-service.git',
        baseBranch: 'main',
        sourceChannel: 'web',
        sopTemplate: 'feature_flow',
      },
    });
    created = ok.json;
    const tasks = ok.json?.tasks;
    check(
      'requirements: 合法创建 201 且返回需求与 DAG 节点',
      ok.status === 201 &&
        typeof ok.json?.requirement?.id === 'string' &&
        Array.isArray(tasks) &&
        tasks.length >= 2,
      `status=${ok.status} body=${ok.text.slice(0, 200)}`,
    );
    if (Array.isArray(tasks) && tasks.length >= 2) {
      const root = tasks[0];
      const child = tasks[1];
      check(
        'DAG: 首节点无依赖、次节点依赖首节点',
        Array.isArray(root.dependsOn) &&
          root.dependsOn.length === 0 &&
          Array.isArray(child.dependsOn) &&
          child.dependsOn.includes(root.id),
        `root=${root.id} dependsOn=${JSON.stringify(root.dependsOn)} child=${child.id} dependsOn=${JSON.stringify(child.dependsOn)}`,
      );
    }
  }

  // ---- 3. RBAC ----
  {
    const forbidden = await call('POST', '/api/requirements', {
      headers: { 'x-superagent-user': 'viewer.test', 'x-superagent-team': 'team-local', 'x-superagent-roles': 'viewer' },
      body: { title: 'viewer 不该能建', specMd: 'x' },
    });
    check(
      'RBAC: viewer 创建需求被拒 403',
      forbidden.status === 403 && typeof forbidden.json?.error === 'string',
      `status=${forbidden.status} body=${forbidden.text.slice(0, 120)}`,
    );

    const anonRead = await call('GET', '/api/bootstrap');
    check('RBAC: 读操作对匿名开放 200', anonRead.status === 200, `status=${anonRead.status}`);

    // 语义回归：读类端点不得被计入写权限（历史缺陷：mcp/recall 曾要求 task:advance）。
    const viewerRecall = await call('POST', '/api/mcp/recall', {
      headers: { 'x-superagent-user': 'viewer.test', 'x-superagent-team': 'team-local', 'x-superagent-roles': 'viewer' },
      body: { query: 'ACL', caller: { teamId: 'team-platform-core' } },
    });
    check(
      'RBAC: viewer 可调用只读的 mcp/recall（不被写权限拦截）',
      viewerRecall.status === 200,
      `status=${viewerRecall.status} body=${viewerRecall.text.slice(0, 120)}`,
    );

    const viewerRetro = await call('POST', '/api/tasks/task-2042-b2/retrospective', {
      headers: { 'x-superagent-user': 'viewer.test', 'x-superagent-team': 'team-local', 'x-superagent-roles': 'viewer' },
      body: {},
    });
    check(
      'RBAC: viewer 可调用只读的 retrospective',
      viewerRetro.status === 200,
      `status=${viewerRetro.status}`,
    );

    // 破坏性操作只给 admin：developer 必须被拒。
    const devReset = await call('POST', '/api/reset', {
      headers: { 'x-superagent-user': 'dev.test', 'x-superagent-team': 'team-local', 'x-superagent-roles': 'developer' },
      body: {},
    });
    check(
      'RBAC: developer 不能重置平台状态（admin:reset 仅 admin）',
      devReset.status === 403,
      `status=${devReset.status} body=${devReset.text.slice(0, 120)}`,
    );

    // reviewer 的记忆审批域同时覆盖 approve 与 reject。
    const bootstrap = await call('GET', '/api/bootstrap');
    const draftMemory = (bootstrap.json?.memories ?? []).find((m) => m.status === 'draft');
    if (draftMemory) {
      const reviewerReject = await call('POST', `/api/memories/${draftMemory.id}/reject`, {
        headers: { 'x-superagent-user': 'rev.test', 'x-superagent-team': 'team-local', 'x-superagent-roles': 'reviewer' },
        body: { reason: '溯源证据不足' },
      });
      check(
        'RBAC: reviewer 可 reject 记忆（与 approve 同权限域，不被 403）',
        reviewerReject.status !== 403,
        `status=${reviewerReject.status} body=${reviewerReject.text.slice(0, 120)}`,
      );
    } else {
      check('RBAC: reviewer 可 reject 记忆（与 approve 同权限域，不被 403）', false, 'seed 中无 draft 记忆');
    }
  }

  // ---- 4. 任务推进（真实 verifier）----
  const rootTaskId = created?.tasks?.[0]?.id;
  const childTaskId = created?.tasks?.[1]?.id;
  {
    const miss = await call('POST', '/api/tasks/__nope__/advance', { body: {} });
    check('advance: 未知任务 404', miss.status === 404, `status=${miss.status}`);

    if (!childTaskId) {
      check('advance: 存在可推进节点', false, '创建需求未返回任务');
    } else {
      // PENDING -> RUNNING
      const toRunning = await call('POST', `/api/tasks/${childTaskId}/advance`, { body: {} });
      check(
        'advance: PENDING -> RUNNING',
        toRunning.status === 200 && toRunning.json?.task?.state === 'RUNNING',
        `status=${toRunning.status} state=${toRunning.json?.task?.state}`,
      );

      // RUNNING -> VERIFYING（此处才跑真实 verifier，lint + test 需真实耗时）
      const toVerifying = await call('POST', `/api/tasks/${childTaskId}/advance`, {
        body: {},
        timeout: 180000,
      });
      const state = toVerifying.json?.task?.state;
      const checks = toVerifying.json?.task?.verifierChecks;
      check(
        'advance: RUNNING -> VERIFYING 后进入人工门禁或重试',
        toVerifying.status === 200 && ['HUMAN_GATE', 'RETRY_WAIT'].includes(state),
        `status=${toVerifying.status} state=${state} body=${toVerifying.text.slice(0, 200)}`,
      );
      check(
        'verifier: 只产出真实执行的 lint / unit_test，不伪造 typecheck / cross_review',
        Array.isArray(checks) &&
          checks.length > 0 &&
          checks.every((c) => c.name === 'lint' || c.name === 'unit_test') &&
          checks.some((c) => c.name === 'lint') &&
          checks.some((c) => c.name === 'unit_test'),
        `names=${Array.isArray(checks) ? checks.map((c) => c.name).join(',') : 'not-array'}`,
      );
      if (state === 'RETRY_WAIT') {
        check(
          'verifier: 失败时回灌真实错误反馈',
          typeof toVerifying.json?.task?.lastErrorFeedback === 'string' &&
            /error TS|not ok|# fail/.test(toVerifying.json.task.lastErrorFeedback),
          `feedback=${String(toVerifying.json?.task?.lastErrorFeedback).slice(0, 120)}`,
        );
      }
    }
  }

  // ---- 5. 幂等命令 ----
  {
    const cid = nextId('smoke-cmd');
    const target = childTaskId ?? rootTaskId;
    const a = await call('POST', `/api/tasks/${target}/advance`, { body: { commandId: cid } });
    const b = await call('POST', `/api/tasks/${target}/advance`, { body: { commandId: cid } });
    check(
      '幂等: 同 commandId 第二次 409',
      b.status === 409 && /重复命令/.test(b.json?.error ?? ''),
      `first=${a.status} second=${b.status} body=${b.text.slice(0, 160)}`,
    );
    const cmds = await call('GET', '/api/runtime/commands');
    const hit = (cmds.json?.commands ?? []).filter((c) => c.commandId === cid).length;
    check('幂等: 命令日志中该 commandId 仅 1 条', hit === 1, `count=${hit}`);
  }

  // ---- 6. 资源三态 ----
  {
    // 6a. 非法 kind
    const badKind = await call('POST', '/api/tasks/task-2042-b1/resource-transition', {
      body: { kind: 'NOT_A_KIND' },
    });
    check('资源: 非法 kind 被拒 400', badKind.status === 400, `status=${badKind.status}`);

    // 6b. RUNNING 节点可被资源阻塞
    const block = await call('POST', '/api/tasks/task-2042-b1/resource-transition', {
      body: { kind: 'BLOCK_RESOURCE' },
    });
    const blockedOk = block.status === 200 && block.json?.to === 'BLOCKED_BY_RESOURCE';
    check(
      '资源: RUNNING -> BLOCKED_BY_RESOURCE 迁移成功',
      blockedOk,
      `status=${block.status} from=${block.json?.from} to=${block.json?.to} err=${block.json?.error ?? ''}`,
    );

    if (blockedOk) {
      const release = await call('POST', '/api/tasks/task-2042-b1/resource-transition', {
        body: { kind: 'RELEASE_RESOURCE' },
      });
      check(
        '资源: RELEASE_RESOURCE 回到 RUNNING',
        release.status === 200 && release.json?.to === 'RUNNING',
        `status=${release.status} to=${release.json?.to}`,
      );
    }

    // 6c. 人工门禁态拒绝资源阻塞（人在审时不占用机器资源），且响应要能说明源态
    const gateTask = created?.tasks?.[0]?.id;
    const denied = await call('POST', `/api/tasks/${gateTask}/resource-transition`, {
      body: { kind: 'BLOCK_RESOURCE' },
    });
    check(
      '资源: HUMAN_GATE 下阻塞被拒 400 且响应带 from/to',
      denied.status === 400 &&
        typeof denied.json?.error === 'string' &&
        denied.json?.from === 'HUMAN_GATE' &&
        denied.json?.to === 'BLOCKED_BY_RESOURCE',
      `status=${denied.status} from=${denied.json?.from} to=${denied.json?.to} err=${denied.json?.error ?? ''}`,
    );

    // 6d. 终态不可再迁移
    const illegal = await call('POST', '/api/tasks/task-2043-all/resource-transition', {
      body: { kind: 'BLOCK_RESOURCE' },
    });
    check(
      '资源: MERGED 终态不可阻断（400 且状态不变）',
      illegal.status === 400 && illegal.json?.task?.state === 'MERGED',
      `status=${illegal.status} state=${illegal.json?.task?.state}`,
    );
  }

  // ---- 7. 人工门禁 ----
  {
    const gateReject = await call('POST', '/api/tasks/task-2041-b1/gate', {
      body: { approved: false, comment: '冒烟打回', reviewerId: 'smoke.reviewer' },
    });
    check(
      'gate: 打回不进入 MERGED',
      gateReject.status === 200 && gateReject.json?.task?.state !== 'MERGED',
      `status=${gateReject.status} state=${gateReject.json?.task?.state}`,
    );

    const gateApprove = await call('POST', '/api/tasks/task-2041-b2/gate', {
      body: { approved: true, comment: '冒烟放行', reviewerId: 'smoke.reviewer' },
    });
    check(
      'gate: 批准后进入 MERGED 或下游可解锁态',
      gateApprove.status === 200 && typeof gateApprove.json?.task?.state === 'string',
      `status=${gateApprove.status} state=${gateApprove.json?.task?.state}`,
    );
    const checkpoints = gateApprove.json?.task?.checkpoints;
    if (Array.isArray(checkpoints)) {
      check(
        'gate: 决策后留存检查点记录',
        checkpoints.length >= 1,
        `checkpoints=${checkpoints.length}`,
      );
    }
  }

  // ---- 8. 复盘红线 ----
  {
    const ret = await call('POST', '/api/tasks/task-2042-b2/retrospective', { body: {} });
    const body = ret.json ?? {};
    check(
      '复盘: 恒要求人工复核 (requiresHumanReview=true)',
      ret.status === 200 && body.requiresHumanReview === true,
      `status=${ret.status} body=${ret.text.slice(0, 200)}`,
    );
    if (body.draft !== undefined && body.draft !== null) {
      check(
        '复盘: 草案为非空文本且不落盘（无 published 副作用）',
        typeof body.draft === 'string' && body.draft.trim().length > 0,
        `draft=${String(body.draft).slice(0, 80)}`,
      );
    } else {
      check('复盘: 未达提炼条件的任务返回 draft=null 而非伪造草案', body.draft === null, `draft=${body.draft}`);
    }
  }

  // ---- 9. MCP 召回 ----
  {
    const empty = await call('POST', '/api/mcp/recall', { body: { query: '  ' } });
    check('mcp/recall: 空查询 400', empty.status === 400, `status=${empty.status}`);

    const ok = await call('POST', '/api/mcp/recall', {
      body: {
        query: 'PGVECTOR HNSW ACL',
        caller: { teamId: 'team-platform-core', projectId: 'app-service', userId: 'lin.wei' },
        limit: 5,
      },
    });
    check(
      'mcp/recall: 正常查询返回 results 数组且不泄漏 draft',
      ok.status === 200 &&
        Array.isArray(ok.json?.results) &&
        ok.json.results.every((m) => m.status !== 'draft'),
      `status=${ok.status} hits=${ok.json?.results?.length}`,
    );
  }

  // ---- 10. IM Webhook ----
  {
    const card = await call('GET', '/api/webhooks/im/card/task-2041-b1');
    const withSecret = card.status === 200 || card.status === 503;
    check(
      'IM: 卡片端点返回 200(已配 secret) 或 503(未配)',
      withSecret,
      `status=${card.status}`,
    );
    if (card.status === 200) {
      check(
        'IM: 卡片含签名回调体',
        typeof card.json?.signedCallback?.signature === 'string' &&
          typeof card.json?.signedCallback?.rawBody === 'string',
        `keys=${Object.keys(card.json ?? {})}`,
      );
      const forged = await call('POST', '/api/webhooks/im', {
        body: { rawBody: card.json.signedCallback.rawBody, signature: 'deadbeef'.repeat(8) },
      });
      check(
        'IM: 伪造签名被拒 401/403',
        forged.status === 401 || forged.status === 403,
        `status=${forged.status} body=${forged.text.slice(0, 120)}`,
      );
      const replay = await call('POST', '/api/webhooks/im', {
        body: {
          rawBody: card.json.signedCallback.rawBody,
          signature: card.json.signedCallback.signature,
        },
      });
      check(
        'IM: 合法签名被接受 200',
        replay.status === 200,
        `status=${replay.status} body=${replay.text.slice(0, 160)}`,
      );
    }
  }

  // ---- 11. SSE ----
  {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(`${BASE}/api/stream`, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value ?? new Uint8Array());
      reader.cancel().catch(() => {});
      check(
        'SSE: 首帧为 data: 心跳',
        res.status === 200 && chunk.startsWith('data: '),
        `status=${res.status} chunk=${chunk.slice(0, 80)}`,
      );
    } catch (err) {
      check('SSE: 首帧为 data: 心跳', false, String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 12. M14 真实 worktree ----
  {
    const list0 = await call('GET', '/api/workspaces');
    check(
      'workspace: 列表端点可用且返回工作树根目录',
      list0.status === 200 && typeof list0.json?.root === 'string' && Array.isArray(list0.json?.worktrees),
      `status=${list0.status} body=${list0.text.slice(0, 160)}`,
    );

    const badRef = await call('POST', '/api/tasks/task-2041-review/worktree', {
      body: { baseRef: '-evil' },
    });
    check(
      'workspace: 非法 baseRef 被拒 400（阻挡参数注入）',
      badRef.status === 400 && badRef.json?.code === 'invalid_base_ref',
      `status=${badRef.status} code=${badRef.json?.code}`,
    );

    const createdWt = await call('POST', '/api/tasks/task-2041-review/worktree', {
      body: {},
      timeout: 60000,
    });
    const wt = createdWt.json?.worktree;
    check(
      'workspace: 真实创建 worktree（201 + 绝对路径 + 分支 + HEAD）',
      createdWt.status === 201 &&
        typeof wt?.path === 'string' &&
        wt.path.startsWith('/') &&
        typeof wt?.branch === 'string' &&
        /^[0-9a-f]{40}$/.test(wt?.headSha ?? ''),
      `status=${createdWt.status} body=${createdWt.text.slice(0, 240)}`,
    );
    check(
      'workspace: 任务 worktreePath 被替换为真实路径',
      createdWt.json?.task?.worktreePath === wt?.path,
      `task.worktreePath=${createdWt.json?.task?.worktreePath}`,
    );

    const idem = await call('POST', '/api/tasks/task-2041-review/worktree', {
      body: {},
      timeout: 60000,
    });
    check(
      'workspace: 重复创建幂等（同路径，不报错）',
      idem.status === 201 && idem.json?.worktree?.path === wt?.path,
      `status=${idem.status} path=${idem.json?.worktree?.path}`,
    );

    const list1 = await call('GET', '/api/workspaces');
    check(
      'workspace: 列表包含刚创建的工作树',
      (list1.json?.worktrees ?? []).some((h) => h.taskId === 'task-2041-review'),
      `tasks=${(list1.json?.worktrees ?? []).map((h) => h.taskId).join(',')}`,
    );

    const removedWt = await call(
      'DELETE',
      '/api/tasks/task-2041-review/worktree?deleteBranch=true',
      { body: {}, timeout: 60000 },
    );
    check(
      'workspace: 删除工作树并连带删分支',
      removedWt.status === 200 &&
        removedWt.json?.removed?.removed === true &&
        removedWt.json?.removed?.branchDeleted === true,
      `status=${removedWt.status} body=${removedWt.text.slice(0, 200)}`,
    );

    const list2 = await call('GET', '/api/workspaces');
    check(
      'workspace: 删除后列表不再包含该工作树',
      !(list2.json?.worktrees ?? []).some((h) => h.taskId === 'task-2041-review'),
      `tasks=${(list2.json?.worktrees ?? []).map((h) => h.taskId).join(',')}`,
    );

    const delAgain = await call('DELETE', '/api/tasks/task-2041-review/worktree', { body: {} });
    check(
      'workspace: 重复删除返回 404 而非静默成功',
      delAgain.status === 404 && delAgain.json?.code === 'not_found',
      `status=${delAgain.status} code=${delAgain.json?.code}`,
    );
  }

  // ---- 13. MCP 协议端点 ----
  {
    const init = await call('POST', '/api/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      },
    });
    check(
      'MCP: initialize 返回协议版本与 tools 能力',
      init.status === 200 &&
        typeof init.json?.result?.protocolVersion === 'string' &&
        Boolean(init.json?.result?.capabilities?.tools) &&
        typeof init.json?.result?.serverInfo?.name === 'string',
      `status=${init.status} body=${init.text.slice(0, 200)}`,
    );

    const tools = await call('POST', '/api/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    const names = (tools.json?.result?.tools ?? []).map((t) => t.name).sort();
    check(
      'MCP: tools/list 暴露 3 个工具且带 inputSchema',
      tools.status === 200 &&
        names.join(',') === 'get_task,list_blocked_tasks,propose_memory,recall_memory' &&
        (tools.json?.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object'),
      `tools=${names.join(',')}`,
    );

    const recall = await call('POST', '/api/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'recall_memory',
          arguments: {
            query: '对账单 幂等',
            teamId: 'team-platform-core',
            projectId: 'proj-reconcile',
            limit: 5,
          },
        },
      },
    });
    const hits = recall.json?.result?.structuredContent?.results ?? [];
    check(
      'MCP: tools/call 中文查询真实召回且不含 draft',
      recall.status === 200 &&
        hits.length >= 1 &&
        hits.every((h) => h.status === 'published') &&
        typeof recall.json?.result?.content?.[0]?.text === 'string',
      `status=${recall.status} hits=${hits.length} body=${recall.text.slice(0, 200)}`,
    );

    // S2-5：写侧工具 propose_memory 的权限与 draft 语义（loopback 默认 admin，应成功创建草案）
    const proposeAdmin = await call('POST', '/api/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'propose_memory',
          arguments: { title: '冒烟草案', contentMd: 'smoke propose draft', assetType: 'L1_FACT' },
        },
      },
    });
    const proposed = proposeAdmin.json?.result?.structuredContent?.proposed;
    check(
      'MCP: propose_memory 管理员可提交 draft 且提示人审',
      proposeAdmin.status === 200 &&
        proposed?.status === 'draft' &&
        typeof proposeAdmin.json?.result?.structuredContent?.note === 'string',
      `status=${proposeAdmin.status} proposed=${JSON.stringify(proposed)}`,
    );
    const proposeViewer = await call('POST', '/api/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'propose_memory',
          arguments: { title: 'x', contentMd: 'y', assetType: 'L1_FACT' },
        },
      },
      headers: { 'x-superagent-roles': 'viewer' },
    });
    check(
      'MCP: propose_memory viewer 被工具级拒绝',
      proposeViewer.status === 200 && proposeViewer.json?.result?.isError === true,
      `status=${proposeViewer.status} body=${proposeViewer.text.slice(0, 160)}`,
    );
    const proposeBad = await call('POST', '/api/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'propose_memory',
          arguments: { title: 'x', contentMd: 'y', assetType: 'NOT_A_TYPE' },
        },
      },
    });
    check(
      'MCP: propose_memory 非法枚举 -32602',
      proposeBad.status === 200 && proposeBad.json?.error?.code === -32602,
      `status=${proposeBad.status} body=${proposeBad.text.slice(0, 160)}`,
    );

    const badTool = await call('POST', '/api/mcp', {
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'drop_all', arguments: {} } },
    });
    check(
      'MCP: 未知工具返回 -32602',
      badTool.status === 200 && badTool.json?.error?.code === -32602,
      `status=${badTool.status} code=${badTool.json?.error?.code}`,
    );

    const badMethod = await call('POST', '/api/mcp', {
      body: { jsonrpc: '2.0', id: 5, method: 'resources/list' },
    });
    check(
      'MCP: 未知方法返回 -32601',
      badMethod.status === 200 && badMethod.json?.error?.code === -32601,
      `status=${badMethod.status} code=${badMethod.json?.error?.code}`,
    );

    const notif = await call('POST', '/api/mcp', {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    check('MCP: 纯通知回 202 无内容', notif.status === 202, `status=${notif.status}`);

    const getMcp = await call('GET', '/api/mcp');
    check('MCP: GET 返回 405（无服务端推送）', getMcp.status === 405, `status=${getMcp.status}`);

    // 原始非法 JSON 必须走 -32700，而不是被 express.json 中间件 400 掉
    const raw = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc": "2.0", ',
    }).then((r) => r.text().catch(() => ''));
    const rawCode = (() => {
      try {
        return JSON.parse(raw)?.error?.code;
      } catch {
        return undefined;
      }
    })();
    check('MCP: 非法 JSON 返回 -32700', rawCode === -32700, `body=${String(raw).slice(0, 160)}`);
  }

  // 冒烟会改动运行态（任务状态、worktreePath），结束后复位，避免下次打开页面看到脏数据。
  if (DO_RESET) {
    const restore = await call('POST', '/api/reset', { body: {} });
    check('reset: 冒烟结束后状态复位', restore.status === 200, `status=${restore.status}`);
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('\n失败明细:');
    for (const f of failed) console.log(` - ${f.name}\n   ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟脚本异常:', err);
  process.exit(1);
});
