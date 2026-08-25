# L1 Worker Brief — blogman #66 · 移除旧写适配器（验收门 + 拆除）

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue66-l1/blogman -b pi/issue-66-remove-legacy-writer a914cd5d`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 66 --repo nardinmarcus/blogman` 全文。

## 实现

1. **验收探针**（代码化）：完整客户端矩阵（主编辑器/Inline/管理/Bearer/Agent/Obsidian/Chrome/AI/批量）全走版本化命令的验证测试；legacy 写计数探针（断言零路径）；负向探针（旧式无版本更新/直接发布被拒绝，旧客户端仅可建草稿+升级信号）。
2. **拆除**：移除旧写适配器代码路径（保留 telemetry 类型记录）；posts 表保留为读投影（L2/L4 的事）。

## 测试

矩阵探针全绿 + 拆除后全测绿。Miniflare <60s/文件。

## 硬边界

零生产；禁止全量 vitest/wrangler。PR refs #66，不合并。
