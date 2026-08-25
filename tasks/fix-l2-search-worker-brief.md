# L2-Gap Worker Brief — blogman #19 后续 · 公开 related-content / search 切 canonical

**背景（Commander 生产验收发现）**：L4（#69）退役前门禁检查发现 56 处 app+lib 仍直读 `posts` 表。其中 `lib/public-read/kernel.ts` 已切 canonical，但**公开相关文章与搜索路径** `lib/related-content.ts` + `lib/repositories/search.ts` 仍 `SELECT * FROM posts`（related-content.ts:156/262/363、search.ts:43），由 `app/api/search` 服务。authority=1 下这是 L2（#67）未切完整的缺口。

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/fix-l2-search/blogman -b pi/fix-l2-public-readers 455afe4`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 实现

把 `lib/related-content.ts` 与 `lib/repositories/search.ts` 的 posts 读取全部切到 canonical：
- 文章内容/字段改读 `article_versions`（snapshot_json 的 title/content/html/description/category/tags）+ `articles`（slug/identity/post_ref）+ `article_lifecycles`（published 状态，替代 posts.status）。
- 检索用 canonical 投影重建 FTS（或从 article_versions 投影全文检索），不再读 posts。
- 保持省略/可见性/密码等公开过滤语义不变（published 且未删且非隐藏）。
- 移除对 posts 表的运行时依赖（此 PR 后 `grep 'FROM posts' app lib --include=*.ts` 应为 0 或仅 posts_fts 影子用于可重建）。
- `posts` 表先不删（L4 退役后续做）。

## 测试

公开搜索、相关文章、详情、列表在新读模型下结果与旧 posts 一致（有 posts 数据时）；空库不 500。组件+D1 测 <60s/文件。禁止全量 vitest/wrangler/migration-runner。

## 输出

`~/.local/state/blogman/fix-l2-search/report.md` + PR URL。不合并。
