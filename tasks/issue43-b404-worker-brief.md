# B4-04 Worker Brief — blogman #43 · 今天工作台、活动通知与安全深链

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue43-b404/blogman -b pi/issue-43-today-workbench be38f15e`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 43 --repo nardinmarcus/blogman` + scheduled-publish / publish-attempts / article-lifecycle（只消费事实）。

## 实现

「今天」工作台读模型：按责任方（作者 vs 系统）分组展示草稿、排期、系统处理中、作者待办。通知以 D1 为源：引用来源类型/ID，去重，「已知晓」只停外部提醒不停事实。安全深链：只导航并重读当前状态（不带过期数据跳参数注入语义），过期深链落到当前实况。投影可重建（由权威事实构建），不作恢复源；可关闭投影不影响来源任务。

## 测试

D1：通知去重、解决、重建、已知晓、竞态。组件/路由层：分组正确、过期深链、无副作用。Miniflare + 组件测 <60s。

## 硬边界

零生产；禁止全量 vitest；>80 行 rg/offset。commit→push→gh pr create refs #43，不合并。
