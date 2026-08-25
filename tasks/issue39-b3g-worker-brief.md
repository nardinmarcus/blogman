# B3-G Worker Brief — blogman #39 · 批次 3 验收夹具（零生产写入）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue39-b3g/blogman -b pi/issue-39-b3-acceptance 0a1d3d98`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `gh issue view 39 --repo nardinmarcus/blogman`。

## 实现

验收夹具（本地/CI）：同一不可变候选上对账版本、修订、恢复点、意图、事件、Outbox、地址与投影。脚本 `scripts/reconcile-b3-facts.mjs` + 测试覆盖首次发布/修订上线事实完整性。schema additive；不删 legacy 适配器。

## 硬边界

**零生产**（禁止 wrangler --remote、禁止改 Cloudflare rollout/部署）。禁止全量 vitest。commit→push→gh pr create refs #39，不合并。生产事件验收留给 Commander。
