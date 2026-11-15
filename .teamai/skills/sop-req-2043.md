---
name: "sop-req-2043"
triggers: ["feature_flow", "main", "solidified-sop"]
scope: "team"
version: 1
---

# 固化 SOP：Memory Hub pgvector HNSW 召回与四级 ACL 过滤

## 来源流水线
- 需求编号：`REQ-2043`
- 模板类型：`feature_flow`
- 目标仓库：`git@code.internal:superagent/memory-hub.git`

## 标准化 DAG 执行步骤
1. **HNSW 索引调优与四级 ACL SQL 过滤器** (`builder` / `claude-code` / `headless_json`) — 验证项：lint, typecheck, unit_test, cross_review

## 复用规范
- 所有写入操作必须在隔离 `git worktree` 中完成并通过确定性门禁（lint / typecheck / unit_test / cross_review）。
