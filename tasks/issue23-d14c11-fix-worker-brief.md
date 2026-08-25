# D14-C11 Fix Worker Brief — blogman #173 · shellSafeAbsolutePath 缺 @ 修复（四烧共因）

你是修正 writer（唯一 writer）。工作区：`git worktree add ~/.pi/worktrees/issue173-fix/blogman -b pi/issue-173-at-sign-path 6c2e001fb84333ffce6baecb7eea2728d8249126`（在 /Users/dapeng/projects/blogman 执行）；依赖 `SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 173 --repo nardinmarcus/blogman` — 根因全文
2. ~/.local/state/blogman/delivery-r8/diagnosis.md — 决定性复现（faithful argv 37 元素 + projectedEnvironment 同构 + temp 树物化，零网络）+ 仪表化定位表
3. /tmp/issue99-repro-r8.mjs（若仍在）与 /tmp/issue99-diag/ 仪表化副本——复现方法直接取材
4. scripts/issue-23-delivery-worker-upload.mjs:27 shellSafeAbsolutePath 及其**全部使用点**（executionDirectoryIdentity 等——逐一判断加 @ 的影响）；:612-640 verifyBoundExecutable/stableRegularFileBytes
5. tests/scripts/issue-23-delivery-worker-upload.test.ts 既有 harness（#169 的 runPreflight seam 就在这里）

## 修复

1. **字符类加 @**：`/^\/[A-Za-z0-9._/@-]+$/`。audit 所有使用点：spawnSync 用 argv 数组不经 shell，@ 非元字符；working_directory 不含 @ 但允许无害。若发现其他正当路径字符也被拒（如未来需要），**不要扩大**——本票只修实证的 @
2. **全 preflight 本地重放测试**（核心防护）：以 #169 的 harness 为基础扩展——真实 worktree 形态（node/npm 真实路径 + openNext 真实 @ 路径 + 真实 sha）+ temp 树物化（realpath /private/var 规避 macOS /var symlink）+ projectedEnvironment 同构 → runPreflight 跑到 spawn 前一步必须 ACCEPT。这就是 rehearsal 结构性缺口的 CI 钉子
3. 回归测试：@ 路径 ACCEPT；既有无 @ 路径用例全保持；fail-closed 不变（构造真非法字符如空格/分号的路径仍 throw）
4. 顺带核查：worker-transport/entry 侧对 open_next_path 的其他门（assertPath/assertBoundFile）是否也有字符类缺口（stages 1-3 已过说明无，但写出核查结论）

## 流程

TDD RED→GREEN → `SHARP_IGNORE_GLOBAL_LIBVIPS=true npx vitest run tests/scripts`（已知 1 环境性失败忽略）→ push → `env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman`（refs #173，标题风格 fix(delivery): …）→ CI 三作业全绿（macOS flake 按 #134 runbook rerun）→ 报告不自行合并。

## 硬边界

零生产调用（无 wrangler --remote/execute/probe）；authority root 只读；不触 #99/#131/#173 外票；凭证零打印；gh env 清理。

## 输出

~/.local/state/blogman/fix-173/report.md（改动清单 + 测试计数 + 使用点 audit 结论 + PR URL）。
