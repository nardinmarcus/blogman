# B2-05 Worker Brief — blogman #28 · Inline Editor 同一版本/冲突协议

你是实现 worker。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue28-b205/blogman -b pi/issue-28-inline-versioned-save 31532141`（确认 origin/main 前 8=31532141）；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。之后所有读写都在该 worktree。

## 先读（禁止整文件 >80 行）

`env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 28 --repo nardinmarcus/blogman`；用 rg/offset 看 `components/InlineArticleEditor.tsx`、`lib/editor-save-coordinator.ts`、`lib/article-commands/`、`app/api/article-commands/`。只消费命令层，不改内核。

## 实现

1. Inline 不再直接覆盖 posts 行；读 article identity + 当前版本 + 完整快照；save 带 expected version + operation id。
2. 与主编辑器共享保存确认与冲突语义（coordinator / 三选一）。冲突保留本机输入。
3. 不改变公开地址与访问控制。旧无版本 Inline 写在 authority 切换后拒绝。
4. 保存确认必须对应实际服务端版本。

## 测试（必须快）

主编辑器 vs Inline 互撞、响应丢失重试不增版本、缓存失败、访问控制。单测/组件测；禁止 wrangler、禁止 migration-runner、禁止把 vitest 全文灌进会话（只 tail）。

## 硬边界

零生产；不进 ledger-migrations；commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #28，不合并。上下文紧：rg/offset，不要 cat 大组件。

## 输出

`~/.local/state/blogman/b205/report.md` + PR URL。
