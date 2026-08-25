# B8-05 Worker Brief — blogman #64 · 移动全页发布确认与发布回执

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue64-b805/blogman -b pi/issue-64-mobile-publish d2e9d839`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 64 --repo nardinmarcus/blogman` + #33 首次发布 / #34 修订上线（复用内核）。

## 实现

移动端全页发布确认：展示精确版本内容与阻塞项状态；确认走 #33/#34 发布内核（精确版本、单事件）；发布后显示独立回执（事件/版本/时间/公开地址）。卡片不直接执行——全页确认后才能发布（票面口径优先）。

## 测试

确认流程、发布幂等、回执事实。组件+D1 测 <60s。**禁止 client import node:crypto**（用 crypto.randomUUID）。

## 硬边界

零生产；禁止全量 vitest/wrangler。PR refs #64，不合并。
