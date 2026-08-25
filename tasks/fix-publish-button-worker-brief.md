# Fix Worker Brief — blogman · 管理列表「发布」按钮接通 first-publish 正式发布流

## 背景（Commander 生产验收发现的产品级 bug）

用户在生产报告：列表点「发布」提示成功，但文章既不进「已发布」列表也不出现在首页。

根因（D1 已证实）：`app/admin/(protected)/posts/PostRow.tsx` 的发布按钮调用 `/api/article-commands {action:'publishTemp'}`——这是 B2 的**临时状态命令**（仅推进 version 快照里的 `fields.status`），**不创建 formal_publication / 不发事件 / 不产生公开 URL**。而公开首页与「已发布」筛选都读 formal_publications（B3 canonical）。结果：status=published 的快照存在，但文章永远不出现在公开侧。

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/fix-publish-button/blogman -b pi/fix-publish-button <origin/main 最新>`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 实现

1. **PostRow.tsx 发布按钮分流**：
   - `post.formalPublished === false`（无 formal_publication，从列表读模型取该标志；若无此字段需在 admin 读模型补出）→ 点击「发布」打开**首次发布确认流**（复用现有 first-publish 前端组件/页面：prepare → 展示四阻塞项与精确版本 → confirm → 显示回执 publicUrl）。完成后刷新列表。
   - 曾正式发布（formal 存在）→ 「发布/重新上线」走 article-commands `relive`，「取消发布」走 `unpublish`（现状保留）。
2. **admin 读模型补字段**：列表 API 返回每篇的 `articleId/version/formalPublished/lifecycle`（canonical 来源），供分流判断。
3. **publishTemp 按钮语义收窄**：仅在文章已有正式发布且需要临时上下线时出现（避免再次误用）；文案区分「发布（首次上线）」vs「重新上线」。
4. 移动端如有同款列表/发布入口（app/api/mobile、mobile-publish view），同步检查是否需要相同分流。

## 测试

- 未发布文章点发布 → 走 first-publish 全链（mock 或集成测），成功后 formal_publications 出现行、公开可访问。
- 已发布文章 → relive/unpublish 路径不回归。
- ledger-only 库兼容路径不回归。
定向测试 <60s/文件。禁止全量 vitest/wrangler/migration-runner。

## 输出

PR refs #19（base main），报告 ~/.local/state/blogman/fix-publish-button/report.md。不合并。
