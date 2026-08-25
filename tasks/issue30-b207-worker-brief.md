# B2-07 Worker Brief — blogman #30 · 后台 AI 迟到结果不得覆盖新版本

你是 #30 唯一 writer。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue30-b207/blogman -b pi/issue-30-ai-stale-guard 301dc0df`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 硬边界

- **禁止修改** `lib/article-commands/` 内核（create/save/publishTemp 实现）。只调用。
- 禁止碰管理列表/生命周期/批量分类（那是 #29）。
- 禁止 wrangler、禁止 migration-runner；文件 >80 行用 rg/offset。
- 零生产；不进 ledger-migrations。
- commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #30，不合并。

## 实现

后台 AI 任务保存 article identity + expected version + 稳定 operation id；结果经统一写入内核提交完整快照，不直接 UPDATE posts。作者已前进版本则迟到结果过期（冲突/丢弃），不覆盖。不把 Queue/waitUntil/缓存/旧日志迁成文章事实。

## 测试

迟到结果 vs 新版本、同 operation id 重放不增版本。vitest 只 tail。

## 输出

`~/.local/state/blogman/b207/report.md` + PR URL。
