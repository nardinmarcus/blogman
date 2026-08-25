# B4-02 Worker Brief — blogman #41 · 暂停、重新确认、改期、取消与立即发布

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin pi/issue-40-scheduled-publish && git worktree add ~/.pi/worktrees/issue41-b402/blogman -b pi/issue-41-schedule-controls ee2c5af`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 41 --repo nardinmarcus/blogman` + #40 的排期模块（只调用）。

## 实现

独立排期控制命令：暂停（pause）、重新确认（re-confirm 绑定新精确版本）、改期（reschedule）、取消（cancel）、立即发布（publish-now 走既有发布内核）。全部带状态前置条件 + operation id 幂等。取消/暂停不删事实。

## 测试

重复命令幂等、错误状态下拒绝、立即发布不绕过发布内核。Miniflare <60s。

## 硬边界

零生产；禁止全量 vitest；>80 行 rg/offset。commit→push→gh pr create refs #41，不合并。
