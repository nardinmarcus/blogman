# Handoff — #234 L4-FINAL 写内核 canonical 化 + 物理退役 posts

**给右侧新窗口的接棒者。** 按选定路线执行：`/grill-with-docs` → `/to-spec` → `/to-tickets` → 逐个 `/implement`。全程审计。

## 目标（github.com/nardinmarcus/blogman）
现在只需做 **#234** 这一票的完整流程（Phase A 代码改造为主）：

> #234 — [L4-FINAL] 写内核 posts 兼容投影 canonical-only + 物理退役 posts 表
> 父 #69。使写事务内核（first-publish / article-commands / admin CRUD）不再依赖 `posts` 作为投影表，从而允许最终物理 drop `posts`/`posts_fts`。验收：`grep -rn "FROM posts\b" app lib --include=*.ts`（排除 posts_fts/*test*）≈ 0；无 posts 表的生产库仍能首次发布/创建/保存/管理更新；可安全 DROP。

## 关键背景（Commander 已勘察，2026-08-21）
- L4 门禁（`node --import tsx scripts/retire-posts-projection.mjs --remote`）终态：对账六维 PASS、投影 rebuildable=1/1、公开读已 100% canonical（PR #232/#233 已合，related-content/search/public-read 无 posts 回退）、authority=1（producer=0，L1 拆 legacy 写）。
- 唯一 drift=posts.published_at 陈旧 vs canonical=null（测试文章已下线，投影陈旧，非数据风险）。
- **posts 表现在不能 drop**——写内核仍把它当兼容投影读写。
- 备份：`~/.local/state/blogman/l4/`（posts-20260821-*.sql + posts-projection-backup.json）。
- 完整生产验收报告：`~/.local/state/blogman/prod-acceptance-2026-08-21/report.md`。

## 待改点（grep `FROM posts` 定位，写内核）
- `lib/first-publish/kernel.ts`（数处：slug 唯一性/title+content 校验/投影写）
- `lib/article-commands/kernel.ts`（create/save 的 slug 冲突、postRef 解析）
- `app/api/posts/route.ts` + `lib/repositories/posts.ts`（旧 CRUD/读）
- `app/api/admin/posts/[slug]/route.ts`（管理更新）

目标：全部改从 canonical（articles / article_versions / article_lifecycles / formal_publications）读写；posts 仅作可重建一次性投影（或不写）。

## 硬边界（沿用仓库铁律）
- **零生产写入**；不进 ledger-migrations（幂等 DDL 通道）。`gh` 一律 `env -u GITHUB_TOKEN -u GH_TOKEN gh ... --repo nardinmarcus/blogman`。
- 禁止全量 vitest / migration-runner / 每测试 spawn wrangler；本地只跑定向测试（CI 仲裁）。
- 文件 >80 行用 rg/offset。客户端/共享模块禁 import `node:*` scheme。
- 物理 drop posts 属破坏性**需用户显式授权后另行执行**——Phase A 代码只做到「无 posts 也可运行 + 门禁通过」，不在本流程 drop。

## 流程路线（选定）
1. `/grill-with-docs` 钉清范围与边界（stateful，写 CONTEXT.md/ADR）。
2. `/to-spec` 汇总为可建计划。
3. `/to-tickets` 拆成 tracer-bullet 票，标 blocking edges（本地 `.scratch/<feature>/issues/` 或 #19 tracker）。
4. 逐个 `/implement`（内部 `/tdd`；闭口 `/code-review` 双轴后 commit）。每票独立上下文。
5. 全程：Commander 旧窗 w4:p9W 只做规划/审阅/决策；执行放本窗。

## 工人（如需派发子 worker）
- 模型：`opencode-go/deepseek-v4-flash --thinking minimal --no-skills --no-extensions --no-context-files --tools read,bash,edit,write`
- 记得 models-store.json 已把该模型 maxTokens 修到 131072（避免 400）。
- 每个实现 worker = herdr 独立 pane + `tasks/*-brief.md` + herdr agent prompt 下达。G/验收只改代码夹具，不写生产。

## 当前环境
- CWD：/Users/dapeng/projects/blogman（主仓已在 main 分支 = 5e2daf1，含 #232/#233/reconcile+retire persist-to 修复）。
- 站点在线，生产运行新版本；测试文章已下线。凭证在 .env.local（勿打印）。
- #234 已建（子 #69）。ART: 从它开始 grill。
