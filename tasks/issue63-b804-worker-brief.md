# B8-04 Worker Brief — blogman #63 · 移动端安全管理排期

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue63-b804/blogman -b pi/issue-63-mobile-schedule 6715b415`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 63 --repo nardinmarcus/blogman` + #41 schedule-control（复用命令，不改内核）。

## 实现

移动端排期管理：改期/取消/立即发布/暂停排期重新准备确认，全部走 #41 命令（前置条件+幂等）；时间固定显示 Asia/Shanghai；不新建排期事实表。

## 测试

四命令移动路径、时区显示、幂等。组件+D1 测 <60s。

## 硬边界

零生产；禁止全量 vitest/wrangler。PR refs #63，不合并。
