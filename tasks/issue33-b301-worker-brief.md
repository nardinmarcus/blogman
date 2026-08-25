# B3-01 Worker Brief — blogman #33 · 草稿以精确版本完成首次正式发布

你是实现 worker。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue33-b301/blogman -b pi/issue-33-first-publish 8a3bcf7e`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 硬边界

零生产；不进 ledger-migrations；禁止全量 vitest、禁止 wrangler 每测 spawn、禁止 migration-runner。文件 >80 行 rg/offset。commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #33，不合并。定向测试绿即可。

## 实现

作者确认精确已保存版本后立即发布，独立博客回执。准备/意图/事件/Outbox/正式版本/公开地址分离。单 D1 事务复核版本、生命周期、slug、四个阻塞项；写首次发布时间、唯一事件、Outbox；外部 I/O 在事务后。草稿不伪造正式版本。legacy 状态切换不得绕过准备。同一意图最多一个事件；失败无部分上线；后续编辑不被顺带发布。

先读 `gh issue view 33 --repo nardinmarcus/blogman` 全文与 article-commands / rollout-controls。

## 测试

隔离 D1：四阻塞项、确认期间版本变化、重复确认、事务中断、slug 冲突、重复 Outbox。Miniflare 共享实例，目标套件 <60s。

## 输出

`~/.local/state/blogman/b301/report.md` + PR URL。
