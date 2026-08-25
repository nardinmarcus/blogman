# B3-03 Worker Brief — blogman #35 · 修订比较、放弃与恢复

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue35-b303/blogman -b pi/issue-35-revision-compare 010fa141`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。先读 `gh issue view 35 --repo nardinmarcus/blogman`。

比较/放弃修订；恢复点恢复为草稿或修订并可撤销本次恢复。高风险操作前存完整可编辑快照；每篇最近 10 个恢复点；执行时重验预览版本。

只消费 #34 修订模型，不重写发布内核。零生产；禁止全量 vitest。pr create refs #35。
