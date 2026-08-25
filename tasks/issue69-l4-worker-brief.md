# L4 Worker Brief — blogman #69 · 退役 legacy posts 投影

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue69-l4/blogman -b pi/issue-69-retire-posts 5d1b7bbd`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 69 --repo nardinmarcus/blogman` 全文。

## 实现

1. **零读写者断言**（代码探针）：grep/测试证明无 legacy posts 写者（L1 已拆）与读者（L2/L3 已切）；负向断言直接读 posts 的路径为零。
2. **停投影**：兼容投影更新逻辑停用（写内核不再同步 posts 行），保留表结构。
3. **退役脚本**（代码面，不执行生产）：scripts/retire-posts-projection.mjs——对账（身份/版本/数量/内容哈希/状态）+ 备份说明 + 投影重建证明；生产执行留 Commander/用户授权。
4. **不删除**：版本、修订、意图、事件、任务、通知、来源、基线、远端身份一律保留。

## 测试

零读写者断言、停投影后全链测试绿、对账脚本单测。

## 硬边界

零生产（脚本只写不跑远端）；禁止全量 vitest/wrangler。PR refs #69，不合并。
