# B3-05 Worker Brief — blogman #37 · 取消发布、重新上线与软删除恢复

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue37-b305/blogman -b pi/issue-37-unpublish-restore 010fa141`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。先读 `gh issue view 37 --repo nardinmarcus/blogman`。

独立生命周期命令：状态前置条件 + operation id。取消发布/删除暂停排期，保留版本、修订、恢复点与历史。可重新上线最后正式版或当前修订；软删后恢复为未发布。

不改 slug 历史（#36）、不改比较 UI（#35）。零生产；禁止全量 vitest。pr create refs #37。
