# L2 Worker Brief — blogman #67 · 公开阅读路径切换到版本化读模型

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue67-l2/blogman -b pi/issue-67-public-read-model a914cd5d`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 67 --repo nardinmarcus/blogman` 全文 + article-identity/articles 仓储。

## 实现

首页/详情/分类/搜索/feed/sitemap/历史地址/访问控制全部改读 canonical D1 事实（article identity + versions + 生命周期投影）。公共读模型表达：生命周期、访问控制、置顶、首次发布时间、历史地址单跳。缓存/FTS/相关文章只作可重建投影。posts 旧表保留不删（L4 退役）。

## 测试

各公开路径读 canonical、历史地址单跳、访问控制语义不变。组件+D1 <60s。

## 硬边界

零生产；禁止全量 vitest/wrangler。PR refs #67，不合并。
