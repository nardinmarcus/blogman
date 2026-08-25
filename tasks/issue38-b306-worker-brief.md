# B3-06 Worker Brief — blogman #38 · 版本绑定发布建议并支持撤销

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue38-b306/blogman -b pi/issue-38-publish-suggestions 7edac44f`。`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

先读 `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 38 --repo nardinmarcus/blogman` 与 publish-revision / article-commands（只调用写入内核）。

## 实现

作者逐项预览/应用/撤销/忽略版本绑定建议。每篇保留当前准备结果与建议状态。字段变化使相关建议过期。应用走写入内核；同一结果首次应用只建一个恢复点。不迁移本地 AI 历史；旧后台 AI 不直写；迟到结果不覆盖新版本。AI 故障不阻塞发布、不改变发布阻塞项。建议绑定版本且不静默应用。正文建议上限 3 条。

## 测试

迟到、字段级过期、逐项动作、同批建议、超时、三条上限；D1 expected version。Miniflare 共享，套件 <60s。

## 硬边界

零生产；禁止全量 vitest / wrangler spawn / migration-runner；文件 >80 行 rg/offset。commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #38，不合并。
