# B4-03 Worker Brief — blogman #42 · 发布重试、租约与不可变尝试

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin pi/issue-40-scheduled-publish && git worktree add ~/.pi/worktrees/issue42-b403/blogman -b pi/issue-42-publish-attempts ee2c5af`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 42 --repo nardinmarcus/blogman` + #40 Cron 补偿循环。

## 实现

每次 Cron 触发的发布执行产生**不可变 attempt 记录**（幂等键、开始/结束、结果）。失败按策略重试（上限+退避），重试不产生重复发布事件。租约（lease）防多实例并发抢同一排期：领取/心跳/过期回收。核心事实（排期/事件）与 attempt 分离。

## 测试

并发抢租约只赢一家、重试上限后停、attempt 不可变（旧不改新追加）、Cron 重复扫描幂等。Miniflare <60s。

## 硬边界

零生产；禁止全量 vitest；>80 行 rg/offset。commit→push→gh pr create refs #42，不合并。
