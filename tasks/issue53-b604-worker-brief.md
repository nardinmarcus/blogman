# B6-04 Worker Brief — blogman #53 · 明确选边解决主要源稿内容冲突

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue53-b604/blogman -b pi/issue-53-conflict-sides ef517f39`。先读 issue #53 全文 + #51 source-sync / #52 write-back（只消费）。

实现：双方偏离基线时显示标题/正文/媒体差异（diff 投影），暂停同步；作者显式选源稿或 Blogman，不自动合并。选源稿：先建恢复点再走版本内核；选 Blogman：走 #52 显式写回确认。冲突由双方投影与基线推导。

测试：双方偏离检测、diff 完整性、选边各路径、无自动合并。Miniflare <60s。

零生产；禁止全量 vitest/wrangler。PR refs #53，不合并。
