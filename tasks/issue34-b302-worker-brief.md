# B3-02 Worker Brief — blogman #34 · 唯一待发布修订并安全上线

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue34-b302/blogman -b pi/issue-34-pending-revision c28e8f22`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

正式文章编辑不改变线上版本；全部 writer 共用唯一活动修订；上线先存恢复点再提升修订并生成事件。不虚构既有修订；公共读继续读正式投影；拒绝旧式原地更新。

零生产；禁止全量 vitest / wrangler spawn / migration-runner。rg/offset。commit→push→gh pr create refs #34，不合并。
