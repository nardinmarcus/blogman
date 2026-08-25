# B2-02 Worker Brief — blogman #25 · 文章身份、版本快照与影子回填

你是实现 worker（唯一 writer）。worktree：`cd /Users/dapeng/projects/blogman && git worktree add ~/.pi/worktrees/issue25-b202/blogman -b pi/issue-25-article-identity 72dda8c5`（先 git fetch origin main 确认 = 72dda8c5…）；依赖 `SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 25 --repo nardinmarcus/blogman` — 完整票面（上面的 What/Interfaces/Migration/Testing 全文）
2. lib/content-envelope/（B2-01 内核——canonical 正文与双哈希来源）
3. lib/content-envelope-columns.ts + scripts/apply-content-envelope-ddl.mjs（B2-01b 的幂等 DDL 通道模式——本票新表沿用同模式）
4. db/ledger-migrations/001_initial_schema.sql（posts 现状）+ lib/repositories/posts.ts

## 实现（旧 posts 保持权威，纯影子层新增）

1. **新表 DDL**（独立幂等 DDL 脚本 scripts/apply-article-identity-ddl.mjs，沿 B2-01b 模式，不进 ledger-migrations）：
   - `articles`（文章身份：id、post_ref 旧表关联、created_at；不猜 slug/源稿/来源网页身份——nullable 关联列留空）
   - `article_versions`（单调版本：article_id、version 单调递增、完整修订快照 JSON（title/content envelope/description/category/tags/status 等）、content_snapshot_sha256、操作幂等键 operation_id UNIQUE）
2. **幂等 backfill**：scripts/backfill-article-identity.mjs——扫旧 posts（--local/--remote 模式），每篇：现有 HTML/Markdown 为保真输入 → content-envelope 内核 parse/normalize → 建 article 身份 + version 1 完整快照；**保留迁移前原始字段供审计**（original_content/original_html 列或审计 JSON）；幂等（重跑零新增——按 post_ref 查重）；发布文章保留可观察发布时间、草稿不继承旧默认 published_at
3. **shadow reconciliation**：scripts/reconcile-article-shadow.mjs——对账旧 posts vs 影子层（数量/字段哈希/envelope 快照一致），输出差异报告
4. **repository 层**：lib/repositories/articles.ts 提供 getByPostRef/listVersions/appendVersion(operationId, snapshot)（幂等：同 operationId 返回既有版本）
5. **测试**：DDL 幂等、backfill 幂等与保真（代表性 posts 矩阵——发布/草稿/带媒体）、reconciliation 差异检出、appendVersion 幂等/单调

## 流程与边界

TDD；定向测试绿即 commit（**不跑 migration-runner 全量套件——本机挂死教训，CI 仲裁**）→ push → gh pr create（refs #25）→ CI 三作业绿（flake rerun）→ 回 PR URL 不合并。零生产调用（脚本 --local 与 --remote 两模式都实现，但验证只用 --local）。

## 输出

~/.local/state/blogman/b202/report.md（DDL、backfill 保真摘要、reconciliation 样例、PR URL）。
