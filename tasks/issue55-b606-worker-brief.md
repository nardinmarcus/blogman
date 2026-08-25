# B6-06 Worker Brief — blogman #55 · 安全解除并显式重新关联主要源稿

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue55-b606/blogman -b pi/issue-55-source-relink 77a77151`。先读 issue #55 全文。

实现：作者显式解除源稿关联（保留历史事实，不删身份/基线）；显式重新关联（重新建立待确认关联，走 #50 身份链）；解除后同步结论清空；重新关联不自动同步。

测试：解除幂等、重链幂等、解除后 sync 结论为空、历史保留。Miniflare <60s。

零生产；禁止全量 vitest/wrangler。PR refs #55，不合并。
