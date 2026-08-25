# D11-R6 Worker Brief — blogman #23 · 第 8 次投递链 prepare 段（新基线 6c2e001f）

你是 prepare 执行 worker（唯一 writer）。工作区 ~/.pi/worktrees/issue134-prepare/blogman。这是第七烧（#168，worker preflight 字符集墙 + wrapper stderr 缺口）修复后的 D11-R6。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 168 --repo nardinmarcus/blogman --comments` — 第七烧根因与 #169 修复
3. 上一轮同段报告 ~/.local/state/blogman/prepare-r5/report.md — R5 全流程实作参考（照抄流程，仅换基线）

## 新基线事实

- origin/main == `6c2e001fb84333ffce6baecb7eea2728d8249126`（PR #169 merge）；tree `66493445a451d90b4c5b64bb28d062f5ac3b5e14`
- CI：push run `32105066670` @ 6c2e001f 正在跑——bootstrap 并行做，最终 prepare 前必须等 completed/success
- 旧 manifest `a976dfeb…` 与授权 `5793ae3f…` 已烧毁：清 `.issue-23-delivery/` 全部重来

## 流程（照 R5 实作）

1. fetch → checkout --detach 6c2e001f… → 记 tree 66493445…
2. 清 `.issue-23-delivery/` `.next/` `.open-next/`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund` → exit 0
3. bootstrap config（3 占位 file_tree 绑 6c2e001f；占位路径用 R5 验证过的真值形态：assets css + 真实 sha 的 migration runner/catalog）
4. bootstrap prepare → harvest 1686 项 → 重写 config → **等 CI success** → 最终 prepare exit 0 → 记 manifest sha256
5. C1 live 只读复核（同 R5：account/D1/worker/origin/baseline 实时读数；**注意 D1 已非空库**——第七烧已交付迁移，baseline 不变仍指 worker deployment/version/traffic 92422ae1/bf8666ae@100）

## C3 预烧门禁（六项，R5 同款 + 本轮重点）

1. 排序/JSON-全等重放
2. validateArtifactSource PASS
3. d1 双解析器 live 预烧
4. Stage 3-7 envelope replay——**注意**：本轮 live D1 是迁移后状态（非空库），replay 的 empty_d1_proof fixture 语义按代码 fixture（不是 live 空库捕获——live 查询信封仅验证形态）；migration replay 走本地 runner
5. R2 probe 实测 200
6. v3-prod 横幅信封重放（#163 回归）+ **新增（#169 直接验证）**：worker preflight 在含 `[slug]` 动态路由目录字符集的真实冻结 file_tree 上重放（本地 harness 语义，不打网络）→ 必须 ACCEPT（第七烧场景在修复后代码上绿灯）

## C4/C5

- C4 secret-safety 同 R5
- C5：authority root 只读，**基线 = 第七烧后 37 文件**（7 auth/16 records/7 terminals + d1-evidence 14 + upload-evidence 空 0=14 文件计入——以实际枚举为准记录起始聚合 sha，结束一致）；.issue-23-delivery 最终仅 config+manifest；git clean

## Tracker

开票「[B1-G D11-R6] 从 6c2e001f 七修基线生成 fresh manifest」→ 挂 #85 → C1-C5 证据评论 → 关票。禁触 #99/#131/#168；PR #102 不动。

## 硬边界

同 R5：绝不 execute/授权/probe 上传/写 authority root/push/merge/改 tracked；凭证零打印；gh env 清理；新墙证据耐久化 ~/.local/state/blogman/prepare-r6-evidence/ 后停下报告。

## 输出

~/.local/state/blogman/prepare-r6/report.md。最终回复：manifest sha256 + 票号 + 链接 + 建议 D12-R7。
