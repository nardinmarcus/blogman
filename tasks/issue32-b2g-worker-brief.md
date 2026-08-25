# B2-G Worker Brief — blogman #32 · 版本事实权威切换（实现+验收夹具，零生产写入）

你是实现 worker。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue32-b2g/blogman -b pi/issue-32-authority-switch 0bcd062b`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 硬边界

- **零生产调用**（禁止 wrangler --remote、禁止改 Cloudflare 生产 rollout）。
- 禁止删除 legacy 写适配器或 posts 读投影。
- 禁止 wrangler 每测 spawn、禁止 migration-runner。
- 文件 >80 行用 rg/offset。
- commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #32，不合并。

## 实现

1. 原子切换 producer/authority：版本身份+版本事实为权威；posts 仅为读兼容投影。
2. 切换后：无版本写拒绝；create/save/publishTemp/管理/AI/外部 API 全部只走内核。
3. 验收夹具（本地/测试）：幂等建稿、保存确认、跨入口冲突、临时发布、公共读取兼容、投影/哈希对账。
4. 回滚开关：关新写入口、继续兼容读、保留版本事实。

先读 #32 全文和现有 `rollout_controls` / article-commands / posts 投影。沿用 B2-01b 幂等 DDL，不进 ledger-migrations。

## 输出

`~/.local/state/blogman/b2g/report.md` + PR URL。生产切流留给 Commander，你不做。
