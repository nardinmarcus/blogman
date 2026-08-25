# B2-06 Worker Brief — blogman #29 · 版本化管理列表、生命周期和批量分类

你是实现 worker。worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue29-b206/blogman -b pi/issue-29-admin-versioned-list 301dc0df`（origin/main 前 8=301dc0df）；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。之后只在该 worktree 干活。

## 先读（禁止整文件 >80 行，用 rg/offset）

`env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 29 --repo nardinmarcus/blogman`；管理列表 API/UI、`lib/article-commands/`、`app/api/article-commands/`、admin posts 路由。

## 实现

1. 列表读模型带 article identity + 当前版本；写命令带 expected version + operation id。
2. 发布/取消/再次发布走临时版本化命令；置顶等文章级动作独立命令，**不推进正文版本**。
3. 批量分类返回逐文章成功/冲突。
4. 禁止通用字段 PATCH 直接改状态；保持软删/永久删授权边界。
5. 修订内容变化才出完整版本。

## 测试（必须快）

批量分类 vs 并发编辑、重复生命周期命令、访问设置冲突、旧请求拒绝。禁止 wrangler、禁止 migration-runner、vitest 只 tail。ledger-only 库缺 identity 表时不要 503 炸掉现有 CRUD。

## 硬边界

零生产；不进 ledger-migrations；commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #29，不合并。

## 输出

`~/.local/state/blogman/b206/report.md` + PR URL。
