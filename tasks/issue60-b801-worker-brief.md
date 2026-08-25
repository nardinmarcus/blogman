# B8-01 Worker Brief — blogman #60 · 移动任务导航与安全提醒深链

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue60-b801/blogman -b pi/issue-60-mobile-nav 05c0faa3`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 60 --repo nardinmarcus/blogman` + #43 工作台读模型（复用，不建移动专用事实）。

## 实现

移动端（响应式或 /m 路由，看现有结构选最小改动）：今天/文章/新建底栏导航；短任务完成后明确返回「今天」；深链登录后恢复原目标并重读当前状态（只导航，不携带过期数据执行命令）；卡片不直接执行发布/生命周期命令；桌面交接只带身份/定位。设置/查看博客/退出放菜单。

## 测试

底栏路由、深链恢复重读、无命令执行副作用。组件/路由测 <60s。

## 硬边界

零生产；禁止全量 vitest/wrangler；>80 行 rg/offset。commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #60，不合并。
