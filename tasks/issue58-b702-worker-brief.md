# B7-02 Worker Brief — blogman #58 · 比较后显式刷新来源网页

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue58-b702/blogman -b pi/issue-58-refresh-source a8c128eb`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 58 --repo nardinmarcus/blogman` + #57 剪藏 / #53 冲突选边（复用比较协议）。

## 实现

重复剪藏或主动刷新：先展示与当前文章差异（标题/正文/媒体），作者明确确认后才通过版本化命令更新（带 expected version + operation id）；正式文章只形成修订（走 #34 修订通道）；草稿形成新版本。刷新记录与来源快照持久化；媒体按内容身份复用。

## 测试

差异展示、确认后更新、expected version 冲突拒绝、刷新记录幂等。Miniflare <60s。

## 硬边界

零生产（fetch 来源用 mock）；禁止全量 vitest/wrangler。PR refs #58，不合并。
