# D14-C9 Fix Worker Brief — blogman #163 · D1 v3-prod 上传横幅修复（TDD → PR）

你是修正 writer（唯一 writer）。目标：修复 #163 根因（第六烧），走 TDD RED→GREEN → PR → CI 全绿 → 交 Commander 审合并。

## 工作区纪律

- 从 b715bee 建专用 worktree：`git worktree add ~/.pi/worktrees/issue163-fix/blogman -b pi/issue-163-d1-upload-banner b715bee`（在 /Users/dapeng/projects/blogman 下执行）
- 所有改动只在该 worktree；主仓库/投递工作区（issue134-prepare）零接触
- node_modules：`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`（本机已知坑：Homebrew vips 8.18.5 会误触发 sharp 源码构建）

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 163 --repo nardinmarcus/blogman` — 根因与验收
2. ~/.local/state/blogman/prepare-r4-evidence/d14c9/ — 只读探测信封 2 份 + ROOT-CAUSE.md（fixture 直接取材）
3. scripts/issue-23-delivery-d1-stages.mjs 的 parseResetResponse/parseQueryEnvelope/parseEmptyObjects/parseCatalog 全家
4. #159 先例（git log / PR #159）：upload-evidence 耐久 sink 的实现模式（O_EXCL|O_NOFOLLOW 0600、成败皆写、哈希入 receipt）——D1 sink 照此镜像
5. tests/scripts/issue-150-meta-envelope.test.ts — 既有 reset 信封 fixture 风格

## 修复要求

1. **稳健 JSON 提取**：从 stdout 定位 JSON 文档起点（如首个 `\n[` 或平衡扫描），剥离任意横幅噪声；fail-closed 不变——无 JSON 即 reset_response_invalid。注意 `parseQueryEnvelope`/`parseEmptyObjects`（query 捕获也可能带横幅）与 catalog 路径同族加固，但**不得放宽语义门**（success/meta/summary 交叉核对原样保留）
2. **D1 stage 耐久证据**：D1_EVIDENCE_DIR sink，每 stage 原始 stdout/stderr 落盘（O_EXCL 0600，文件名含 stage + sha），receipt 携带哈希；失败路径也要落盘（这是本次若早有就能直接定位的字节证据）
3. **测试**：新横幅变体（动态哈希上传行、两行/多行横幅、横幅后多信封数组）、旧 2 行前缀回归、无 JSON fail-closed、sink 耐久性、既有 142 例零回归
4. commit 信息 refs #163；风格照 #158 先例（fix(delivery): …）

## 流程

TDD：先写 RED 测试（新横幅 fixture 重放本次失败）→ 实现 → GREEN → `SHARP_IGNORE_GLOBAL_LIBVIPS=true npx vitest run tests/scripts`（已知本机环境性 4 失败可忽略，CI 为准）→ push 分支 → `env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman`（标题照 #158 风格）→ 等 CI 三作业全绿 → 报告 PR URL，**不自行合并**（Commander 审后合）

## 硬边界

- 绝不碰生产（无 wrangler --remote 写、无 execute、无 probe 上传；只读探测也不需要——证据已在）
- 绝不写 authority root ~/.local/state/blogman/issue-23-production-authority-v1
- 绝不改 #99/#131/#163 之外的票；#163 只发证据评论（PR 链接 + 测试结果），关票留给 Commander
- 凭证值零打印；gh 一律 env -u GITHUB_TOKEN -u GH_TOKEN

## 输出

PR URL + 测试计数（新旧）+ 改动文件清单 + 自评风险。耐久记录 ~/.local/state/blogman/fix-163/report.md。
