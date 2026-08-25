# B2-01b Worker Brief — blogman #24 · 写路径接入 envelope 内核 + 历史样本验证

你是集成 worker（唯一 writer）。worktree：`cd /Users/dapeng/projects/blogman && git worktree add ~/.pi/worktrees/issue24-b201b/blogman -b pi/issue-24-envelope-integration 4c598e29`（merge 后的 main，先 git fetch origin main 确认=4c598e29…再建）；依赖 `SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 24 --repo nardinmarcus/blogman` — Migration and compatibility 段（本票验收核心）
2. lib/content-envelope/（PR #183 刚落的内核：types/whitelist/converters/hashes——你的消费对象，**只读不改**；若发现内核 bug，报告而不是改）
3. app/api/posts/route.ts（现有写路径：markdown content → html 生成）
4. db/ledger-migrations/001_initial_schema.sql（posts 表：content/html 列）

## 实现

1. **写路径接入（新迁移 008 + route 改造，双写不切换）**：
   - migration 008_add_content_envelope.sql：posts 加列 `content_envelope TEXT`（可空 JSON）+ `content_snapshot_sha256 TEXT` + `source_sync_sha256 TEXT`（均建于既有表，不动现有 content/html 列——旧字段继续是只读回退）
   - app/api/posts/route.ts：POST/PUT 写入时用内核 parse/normalize 产出 envelope，存新列 + 两个哈希；**renderer/serializer 升级不推进文章版本或同步基线**（哈希独立计算，不触发现有 updated_at/version 语义）
   - 读路径不改（L2 票的事）
2. **历史样本验证**：脚本 `scripts/verify-content-envelope.mjs`——从本地 D1（wrangler d1 execute DB --local，先 seed 一些代表性 posts 若空）取 content 样本，逐条 markdown→envelope→HTML 与现有 html 列比对，输出保真报告（等价/降级/失配清单）。生产 clean-start 空库，票面"真实历史样本"以代表性样本矩阵+脚本可重放满足（报告注明此边界）
3. **测试**：route 层集成测试（POST 带 markdown → envelope 列/双哈希落库；GET 返回不变）+ 008 迁移 up 测试 + 保真脚本冒烟

## 流程与边界

TDD；定向测试绿（vitest 新文件 + migrations 套件）；commit→push→gh pr create（refs #24）→CI 三作业绿（flake rerun）→回报 PR URL 不自行合并。零生产调用（--local only）；不动 delivery 链。

## 输出

~/.local/state/blogman/b201b/report.md（008 DDL、route 改动面、保真报告摘要、PR URL）。
