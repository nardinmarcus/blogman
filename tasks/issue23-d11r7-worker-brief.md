# D11-R7 Worker Brief — blogman #23 · 第 9 次投递链 prepare 段（新基线 117fe57e）

你是 prepare 执行 worker（唯一 writer）。工作区 ~/.pi/worktrees/issue134-prepare/blogman。这是八烧全修（含 #173 shellSafeAbsolutePath 缺 @——四烧共因）后的 D11-R7。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 173 --repo nardinmarcus/blogman --comments` — 第八烧根因（@ 字符墙，决定性复现）与 #174 修复
3. 上一轮同段报告 ~/.local/state/blogman/prepare-r6/report.md — R6 全流程实作参考（照抄流程，仅换基线）

## 新基线事实

- origin/main == `117fe57e58b00451f3786b2b4e62ab918313a140`（PR #174 merge，tree `e6dae77b0b246e15d51e786ee3fbef0c2ee96f03`）
- CI：push run `32120709730` 已 completed/success（head=117fe57e）——无需等待，直接可用
- 旧 manifest `2b02bb99…` 与授权 `18be9c42…` 已烧毁：清 `.issue-23-delivery/` 全部重来

## 流程（照 R6 实作）

1. fetch → checkout --detach 117fe57e… → 记 tree e6dae77b…
2. 清 `.issue-23-delivery/`（含死凭证）`.next/` `.open-next/`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund` → exit 0
3. bootstrap config（3 占位 file_tree 绑 117fe57e；占位路径用 R6 验证过的真值形态）→ bootstrap prepare
4. harvest 完整 file-list → 重写 config → 最终 prepare exit 0 → 记 manifest sha256
5. C1 live 只读复核（同 R6：account/D1/worker/origin/baseline 实时读数；D1 为迁移后状态，baseline 指 worker deployment/version/traffic 92422ae1/bf8666ae@100%）

## C3 预烧门禁（七项）

1. 排序/JSON-全等重放
2. validateArtifactSource PASS
3. d1 双解析器 live 预烧
4. Stage 3-7 envelope replay（fixture 语义同 R6）
5. R2 probe 实测 200
6. v3-prod 横幅信封重放（#163 回归）
7. worker preflight 重放（#169 回归 + **#174 直接验证**：runPreflight 对真实 @opennextjs 路径跑到 spawn 前 ACCEPT——第八烧场景在修复后代码上绿灯的直接证明）

## C4/C5

- C4 secret-safety 同 R6
- C5：authority root 只读，基线 = 第八烧后 **54 文件**（以实际枚举为准记录起始聚合 sha，结束一致）；.issue-23-delivery 最终仅 config+manifest；git clean

## Tracker

开票「[B1-G D11-R7] 从 117fe57e 八修基线生成 fresh manifest」→ 挂 #85（GraphQL addSubIssue）→ C1-C5 证据评论 → 关票。禁触 #99/#131/#173；PR #102 不动。

## 硬边界

同 R6：绝不 execute/授权/probe 上传/写 authority root/push/merge/改 tracked；凭证零打印；gh env 清理；新墙证据耐久化 ~/.local/state/blogman/prepare-r7-evidence/ 后停下报告。

## 输出

~/.local/state/blogman/prepare-r7/report.md。最终回复：manifest sha256 + 票号 + 链接 + 建议 D12-R8。
