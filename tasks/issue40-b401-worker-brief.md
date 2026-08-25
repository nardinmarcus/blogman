# B4-01 Worker Brief — blogman #40 · 精确版本排期与每分钟 Cron 补偿发布

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue40-b401/blogman -b pi/issue-40-scheduled-publish 3861dcc7`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 40 --repo nardinmarcus/blogman` 与 first-publish / publish-revision / article-lifecycle。

## 实现

按精确版本排期：排期绑定 article identity + version（不是「最新」）。每分钟 Cron 补偿：到期扫排期、版本未变则按该精确版本走既有发布内核上线；版本已变则不改期不误发（记录过期，等作者重新排期）。幂等：同一排期意图只产生一次发布事件（operation id）。取消排期走 #41 的命令面（本票留接口即可，不实现暂停/改期 UI）。

## 测试

到期触发、版本漂移过期、重复扫描幂等、错过窗口补偿。Miniflare，套件 <60s。

## 硬边界

零生产（不建真实 Cloudflare Cron trigger，只写 worker 代码与测试；部署留给后续批次）。禁止全量 vitest。commit→push→gh pr create refs #40，不合并。
