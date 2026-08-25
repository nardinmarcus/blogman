# B2-08 Worker Brief — blogman #31 · Bearer/Agent/Obsidian/Chrome 写入口升级

你是 #31 唯一 writer。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue31-b208/blogman -b pi/issue-31-external-write-api 301dc0df`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 硬边界

- **禁止修改** `lib/article-commands/` 内核。只调用。
- 禁止碰管理列表/AI 后台 writer（#29/#30）。
- 禁止 wrangler、禁止 migration-runner；文件 >80 行用 rg/offset。
- 零生产；不进 ledger-migrations；不建源稿/来源网页关系。
- commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #31，不合并。

## 实现

外部写入不得旁路版本内核。升级客户端：幂等建草稿或按版本更新（identity + creation/operation id + expected version + 完整快照）。legacy 客户端：即使请求 published 也只建草稿，并给升级信号；legacy telemetry 只记客户端类型/操作类别/时间，不记正文或凭证。authority 切换后才拒绝无版本更新和直接发布。

## 测试

升级客户端幂等、legacy 只建草稿、无版本更新拒绝（可单测 mock）。vitest 只 tail。

## 输出

`~/.local/state/blogman/b208/report.md` + PR URL。
