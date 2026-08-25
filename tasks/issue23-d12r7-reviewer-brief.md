# D12-R7 Reviewer Brief — blogman #23 · 独立审查 manifest 2b02bb99 与 formal entry

你是独立 reviewer（fresh context，一切独立复算）。工作区：~/.pi/worktrees/issue96-manifest/blogman（将 detach @ 6c2e001fb84333ffce6baecb7eea2728d8249126，tree 66493445a451d90b4c5b64bb28d062f5ac3b5e14）。被审：.issue-23-delivery/manifest.json（声称 sha256 2b02bb9988fc7bb82186e39f2ceaa08348d092f4d706bdde593a42d05c235444，Commander 已从 prepare 区复制——第一步独立复算）。

## 准备

`cd ~/.pi/worktrees/issue96-manifest/blogman && git fetch origin && git checkout --detach 6c2e001f…`；替换 .issue-23-delivery/manifest.json 为 prepare 区最新（~/.pi/worktrees/issue134-prepare/blogman/.issue-23-delivery/manifest.json，只读复制）。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 168 --repo nardinmarcus/blogman --comments` — 第七烧根因（preflight 字符集墙）与 #169 修复
3. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 170 --repo nardinmarcus/blogman --comments` — D11-R6 证据（含勘误：C5 正确聚合 b578cec9…）
4. 先例 #166 结构：`env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 166 --repo nardinmarcus/blogman --comments`
5. scripts/ 全套交付脚本 + schemas/

## 审查面

### M1-M9（同 R6 结构，绑定值更新）
M1 sha=2b02bb99…/425632B；M2 parseCanonicalManifest；M3 commit/tree=6c2e001f/66493445 与 origin/main 一致；M4 CI run 32105066670（attempt1/push/success/exact-head）；M5 toolchain identities（execute_entry 新闭包 a2fde197…，worker_upload_entry baf2a341…）；M6 artifact/file_tree 1686 + sha 9e845ca9… 复算 + 跨工作区磁盘全等；M7 migration（catalog 9421f735… 三轮一致合理性）；M8 live 只读 target facts（**D1 现为迁移后状态**——第七烧已交付，empty 状态不再成立，reconciliation 预期 matched 形态；baseline 仍 92422ae1/bf8666ae@100%）；M9 policy/rehearsal（receipt b27a0ac0…）。

### E1-E4（同 R6 结构）
E1 entry 状态机全文；E2 **#169 增量审查（c5b784a5..6c2e001f）**：preflight source-walk 字符集修复（对 [slug]/[id]/[...key]/(protected) 等 14 动态路由目录的遍历与冻结 artifact 文法对齐）+ wrapper stderr 耐久化（wrapper-failure/v1 记录 + childFailure bounded stderr 携带 + 侧车 wrapper_stderr_sha256）+ runPreflight 拆分 seam + 测试 214 行新增覆盖评估；E3 闭包哈希 a2fde197… 三处全等；E4 **八墙静态覆盖**（在 R6 七墙上加 #168 墙的代码证据）。

### X1-X2（同 R6）
X1: C3.7 声称的 preflight 重放 ACCEPT——独立用 create-upload-source-snapshot harness 语义在冻结 file_tree 上重放；X2: authority root = 44 文件/聚合 b578cec9…（独立复算，与 #170 勘误一致）。

### 边界（P0 红线）
零执行/零授权/零写；authority root 只读；prepare 工作区只读；不触 #99/#131/#168/#170；凭证零打印；gh/wrangler env 清理。

## Tracker

开票「[B1-G D12-R7] 独立审查 manifest 2b02bb99 与 formal entry」→ 挂 #85（GraphQL）→ 证据评论（M/E/X 逐项 + verdict）→ PASS 才关票；FAIL 留 OPEN。

## 输出

~/.local/state/blogman/review-r7/report.md。最终回复：verdict + 票号 + 关键发现。
