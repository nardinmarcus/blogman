# B5-G Worker Brief — blogman #49 · 批次 5 验收夹具（零生产）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue49-b5g/blogman -b pi/issue-49-b5-acceptance ef517f39`。先读 issue #49 全文。

实现：scripts/reconcile-b5-facts.mjs——对账微信草稿链事实：派生（版本绑定）、失败/重试/结果未知状态机、代次与替代草稿历史、待微信确认状态。测试覆盖全链一致性 + 幂等重放。

零生产（不真调微信）。禁止全量 vitest。PR refs #49，不合并。
