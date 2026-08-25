# L3 Worker Brief — blogman #68 · 剩余作者与后台读者切到 canonical 事实

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue68-l3/blogman -b pi/issue-68-canonical-readers a914cd5d`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 68 --repo nardinmarcus/blogman` 全文。

## 实现

作者列表、工作台、后台 AI 输入、索引输入及所有内部读者不再从 legacy posts 取文章事实——切到 canonical（identity/versions/投影）。每个读者有来源清单（注释或清单文件）与测试证据。工作台/生命周期/修订/AI/来源/渠道取共享事实或可重建投影。

## 测试

每读者来源断言（不再 import legacy posts 读路径）。D1+组件 <60s。

## 硬边界

零生产；禁止全量 vitest/wrangler。PR refs #68，不合并。
