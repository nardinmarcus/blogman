# B3-04 Worker Brief — blogman #36 · 新 slug 上线并永久保留历史地址

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue36-b304/blogman -b pi/issue-36-slug-history 010fa141`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。先读 `gh issue view 36 --repo nardinmarcus/blogman`。

候选 slug 只随修订上线；旧地址永久单跳到当前地址。当前/候选/历史地址按文章身份独占。

不改修订比较 UI（#35）、不改取消发布（#37）。零生产；禁止全量 vitest。pr create refs #36。
