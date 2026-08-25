# B6-G Worker Brief — blogman #56 · 批次 6 验收夹具（零生产）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue56-b6g/blogman -b pi/issue-56-b6-acceptance fdea7493`。先读 issue #56 全文。

实现：scripts/reconcile-b6-facts.mjs——对账源稿链八面事实：身份/关联（pending/active/unbound）、基线与同步方向、冲突选边记录、恢复点、不可用观察、写回意图与确认。测试覆盖全链一致性 + 关系状态机全转移。

零生产。禁止全量 vitest。PR refs #56，不合并。
