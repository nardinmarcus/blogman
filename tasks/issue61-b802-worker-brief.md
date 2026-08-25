# B8-02 Worker Brief — blogman #61 · 移动小修、保存恢复与三向冲突

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue61-b802/blogman -b pi/issue-61-mobile-edit d35124ce`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 61 --repo nardinmarcus/blogman` + #27 editor-save-coordinator（复用，不建移动版本表）。

## 实现

移动编辑：标题/普通段落/基础行内格式小修；自动保存 = 服务端确认当前输入后才显示完成；本机稿（每篇每设备最多一份）只用于恢复。保存复用 expected version/operation id 命令。冲突三选一：服务器版/本机安全重提/另存新草稿（复用 #27 协议）。复杂块只读 + 交接桌面（只带身份/定位）。

## 测试

小修保存确认、断网恢复、三向冲突、复杂块只读。组件/路由测 <60s。

## 硬边界

零生产；禁止全量 vitest/wrangler；>80 行 rg/offset。PR refs #61，不合并。
