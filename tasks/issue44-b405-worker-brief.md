# B4-05 Worker Brief — blogman #44 · 阈值/静默时段/去重邮件提醒

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue44-b405/blogman -b pi/issue-44-email-digest dd3fa28f`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 44 --repo nardinmarcus/blogman` + #43 的通知读模型（只消费）。

## 实现

邮件提醒消费 #43 通知事实：按阈值（threshold 触发条件）、静默时段（quiet hours 不外发、过后补发或不补按票面）、去重（同源通知聚合）。外发失败不丢事实（记录发送状态，可重试）。「已知晓」语义沿用：只停外部提醒。

## 测试

阈值触发/不触发、静默时段抑制、去重聚合、失败重试幂等。Miniflare <60s。

## 硬边界

零生产（不真发邮件，provider 接口 mock）；禁止全量 vitest；>80 行 rg/offset。commit→push→gh pr create refs #44，不合并。
