# B7-01 Worker Brief — blogman #57 · 按规范化 URL 幂等剪藏来源网页

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue57-b701/blogman -b pi/issue-57-clip-source 05c0faa3`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 57 --repo nardinmarcus/blogman` + #50 源稿身份（规范化 URL 可复用其身份链）。

## 实现

Chrome 剪藏入口：规范化来源 URL → 幂等身份；首次剪藏建文章（creation id）+ 来源关系（pending-link 语义，来源网页**不成为主要源稿**）；重复剪藏返回既有文章身份进入比较（不重复建）。creation/operation id + 唯一约束幂等。既有文章不回填；Agent/API 不建来源关系（仅 Chrome 入口）。

## 测试

URL 规范化幂等、首次建链、重复剪藏返回既有、无正文回填。Miniflare <60s。

## 硬边界

零生产；禁止全量 vitest/wrangler/migration-runner；>80 行 rg/offset。commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #57，不合并。
