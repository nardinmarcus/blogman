# B8-03 Worker Brief — blogman #62 · 移动小修处理版本绑定局部 AI 建议

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue62-b803/blogman -b pi/issue-62-mobile-ai 6715b415`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 62 --repo nardinmarcus/blogman` + #38 建议协议（复用：版本绑定、预览/应用/撤销/忽略、首次应用单恢复点、AI 故障不阻塞）。

## 实现

移动端：选中文本请求局部建议（AI 层 mock）；处理已有建议列表（预览/应用/撤销/忽略全部复用 #38 内核命令）；建议绑定版本，版本漂移过期。

## 测试

建议生命周期、版本漂移过期、应用走内核。组件+D1 测 <60s。

## 硬边界

零生产（AI mock）；禁止全量 vitest/wrangler。PR refs #62，不合并。
