# B2-03 Worker Brief — blogman #26 · 版本化文章写入与临时发布命令内核

你是实现 worker（唯一 writer）。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue26-b203/blogman -b pi/issue-26-versioned-write 6f200000`（先确认 origin/main 前 8 位=6f200000）；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 26 --repo nardinmarcus/blogman` 全文
2. lib/article-identity.ts + lib/repositories/articles.ts + lib/content-envelope/（只消费不改内核）
3. app/api/posts/route.ts 现有写路径（本票建命令层，route 可薄封装调用，不重写整个 API 面）

## 实现

新模块 `lib/article-commands/`（隔离 D1 应用命令层，这是票面核心证据面）：

1. `create({ creationId, snapshot })`：同一 creationId 最多一篇；空白会话（无 title 且无正文）不建稿；原子写 articles + version 1 + posts 兼容投影。
2. `save({ articleId, expectedVersion, operationId, snapshot })`：expected 匹配才写入下一单调版本；同 operationId 返回原结果；冲突返回当前服务端版本+比较事实，零部分写入。
3. `publishTemp({ articleId, expectedVersion, operationId, status })`：临时发布/状态，带版本与状态前置条件+幂等键；**不**建发布意图/事件/Outbox。
4. 同一 D1 事务更新 posts 兼容投影与版本事实。KV/FTS/相关文章/向量只当事务外可重建投影（失败不回滚核心事实；测试覆盖投影失败）。

## 测试（隔离 D1）

响应丢失重放、重复命令、并发保存、旧 expected version、slug 冲突、事务中断、投影失败。定向 vitest 绿即可。

## 硬边界

- **不要跑 migration-runner 全量套件**（本机挂死）。
- 不进 ledger-migrations。
- 零生产调用。
- 不提前做批次 3 事实。
- commit → push → `env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman`（refs #26）→ 回 PR URL，不合并。

## 输出

`~/.local/state/blogman/b203/report.md`（命令表、冲突语义、PR URL）。
