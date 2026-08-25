# B8-G Worker Brief — blogman #65 · 批次 8 验收夹具（零生产）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue65-b8g/blogman -b pi/issue-65-b8-acceptance 1eee4374`。先读 issue #65 全文。

实现：scripts/reconcile-b8-facts.mjs——对账移动矩阵事实：导航/深链恢复、本机稿恢复、三向冲突选择、建议生命周期、排期命令、发布确认与回据，全部从 D1 事实面读（不依赖 UI 状态）。测试覆盖矩阵一致性。

零生产。禁止全量 vitest。PR refs #65，不合并。
