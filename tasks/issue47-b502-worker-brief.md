# B5-02 Worker Brief — blogman #47 · 微信失败、重试与结果未知

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue47-b502/blogman -b pi/issue-47-wechat-retry 2196b3f0`。SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci。

先读 `gh issue view 47 --repo nardinmarcus/blogman` 与 #46 微信草稿模块。

实现 provider failure/retry/result-unknown 状态机：草稿事实不丢；重试带 operation id/上限/退避；未知结果禁止盲重试，先 query/reconcile；幂等不重复草稿。真实微信 API 只 mock。

测试：失败重试上限、未知结果冻结+查询后恢复、重复命令幂等。禁止全量 vitest/wrangler/migration-runner。commit→push→gh pr create refs #47，不合并。
