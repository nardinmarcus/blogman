# L4-final Worker Brief — blogman #69 · 剥 legacy posts 回退并完成退役预留

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/l4-retire-final/blogman -b pi/l4-retire-final d9359fa5`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 背景
#232 已把公开 related-content / search 改成「canonical 为主 + canonicalFactsAvailable 门控的 posts 回退」。L4 退役前需把回退分支去掉，使 posts 在运行时非 canonical 库外**零引用**（写内核的 posts 兼容投影由 L1 已拆、authority=1 下不写——保留兼容读函数但标记退役）。

## 实现
1. `lib/related-content.ts`、`lib/repositories/search.ts`、`lib/public-read/*`：删除 posts 回退分支，只保留 canonical 读；`canonicalFactsAvailable(db)` 为 false 时明确返回空/降级**不再查 posts**（避免误用回退）。
2. 移除对 `lib/repositories/search.ts` 里 `SELECT * FROM posts` 的运行时调用（搜索改走 canonical FTS/投影）。
3. 更新/删除相关 fallback 测试（tests/lib/public-read/fallback.test.ts 等）以匹配「无 posts 回退」语义；canonical 测试保持绿。
4. 此 PR 后验证：`grep -rn "FROM posts\b" app lib --include=*.ts`（排除 posts_fts/test）应 ≈ 0 或仅写内核兼容注释。
5. posts/posts_fts 表**不在本 PR 删除**（实际 DROP 由 Commander 在门禁+备份后执行，/暂 DDL）。

## 测试
canonical 搜索/相关/详情/feed/sitemap 全绿；空库不 500；无 posts 表时这些路径不炸（降级）。禁止全量 vitest/wrangler/migration-runner。

## 输出
`~/.local/state/blogman/l4-retire-final/report.md` + PR URL。不合并。
