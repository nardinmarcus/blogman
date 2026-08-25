# B6-01 Worker Brief — blogman #50 · 幂等建立主要源稿身份与待确认关联

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin pi/issue-45-b4-acceptance && git worktree add ~/.pi/worktrees/issue50-b601/blogman -b pi/issue-50-source-identity 71c9872`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 50 --repo nardinmarcus/blogman`。

## 实现（读票面全文为准）

主要源稿身份：规范化 URL 幂等识别（同一源稿多次录入 = 同一身份）。与文章建立**待确认**关联（pending-link，不自动生效）。幂等：重复录入零副作用。不猜身份：URL 变体需显式合并。

## 测试

URL 规范化幂等、重复录入零新增、待确认关联状态机。Miniflare <60s。

## 硬边界

零生产；禁止全量 vitest；>80 行 rg/offset。commit→push→gh pr create refs #50，不合并。
