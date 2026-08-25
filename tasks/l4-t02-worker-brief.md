# #234-02 Worker Brief — 文章级命令版本化（pin/hide/password/category/软删/恢复）

你是 #234 拆分后的 **#02 实现者**。lead 正并行做 #01（article-commands posts-less），你做 #02，两者文件面基本不重叠（#01 改 article-commands/kernel.ts 的 create/save/publishTemp；#02 改文章级命令 dispatch 与版本快照）。

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/l4-t02/blogman -b pi/l4-t02-article-level <BASE>`（BASE=当前 origin/main，开工前 fetch 确认）。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读
1. `.scratch/l4-final/issues/02-article-level-versioned.md`（票面全文）
2. `.scratch/l4-final/spec-234.md` 相关节
3. `docs/adr/0007-record-article-level-state-changes-as-immutable-versions.md`
4. `lib/article-commands/kernel.ts` 的文章级命令 dispatch（setPinned/setHidden/setPassword/setCategory/softDelete/restore）——**与 lead 并行改同一文件时只动你的段落，rebase 时按行归属解冲突**

## 实现（票面验收为准）
六个文章级命令各追加不可变版本快照（operation_id 幂等 replay）；目标值已 live 返回 replayed 不写；公开读（canonical）立即可见状态变化；categories.post_count 记账保持现状；admin 命令路由适配 version 前进语义。

## 测试
六命令各自新版本快照、幂等 replay、公开读立即可见、categories 增减。Miniflare <60s/文件。禁止全量 vitest/wrangler/migration-runner。

## 输出
PR refs #234（base main），不合并。报告 ~/.local/state/blogman/l4-t02/report.md。
