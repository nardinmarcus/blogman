# B5-01 Worker Brief — blogman #46 · 从精确正式版本派生微信公众号草稿

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin pi/issue-45-b4-acceptance && git worktree add ~/.pi/worktrees/issue46-b501/blogman -b pi/issue-46-wechat-draft 71c9872`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 46 --repo nardinmarcus/blogman`。

## 实现（读票面全文为准）

从精确正式版本派生微信草稿：派生绑定 article identity + 精确版本（非「最新」）；草稿内容 = 该版本快照的微信适配投影（HTML/纯文本/封面/摘要）。幂等：同一版本重复派生返回同一草稿（operation id）。不直接发布——只建草稿。微信 API 层留 provider 接口（mock 实现），真实调用留给后续批次。

## 测试

同版本幂等、版本切换后重新派生、投影保真。Miniflare <60s。

## 硬边界

零生产（不真调微信 API）；禁止全量 vitest；>80 行 rg/offset。commit→push→gh pr create refs #46，不合并。
