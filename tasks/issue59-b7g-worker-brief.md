# B7-G Worker Brief — blogman #59 · 批次 7 验收夹具（零生产）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue59-b7g/blogman -b pi/issue-59-b7-acceptance 6c330746`。先读 issue #59 全文。

实现：scripts/reconcile-b7-facts.mjs——对账剪藏链事实：URL 规范化身份、文章关联、比较/确认刷新记录、来源快照、媒体身份复用。测试覆盖全链 + 幂等。

零生产。禁止全量 vitest。PR refs #59，不合并。
