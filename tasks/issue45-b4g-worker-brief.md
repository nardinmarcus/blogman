# B4-G Worker Brief — blogman #45 · 批次 4 验收夹具（零生产写入）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue45-b4g/blogman -b pi/issue-45-b4-acceptance 760a7bd1`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 45 --repo nardinmarcus/blogman`。

## 实现

验收夹具（本地/CI）：扩展 reconcile-b3-facts 或新增 scripts/reconcile-b4-facts.mjs——对账排期（pending/paused/fired/stale/cancelled）、租约、attempt、发布事件、Outbox、通知、邮件发送状态八面事实一致性。测试覆盖：到期→租约→attempt→事件→Outbox 全链、补偿重扫幂等、暂停/取消后无外发。

## 硬边界

**零生产**（禁止 wrangler --remote / Cloudflare Cron/部署变更）。禁止全量 vitest。commit→push→gh pr create refs #45，不合并。生产事件验收留给 Commander。
