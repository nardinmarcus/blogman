# D11-R5 Worker Brief — blogman #23 · 第 7 次投递链 prepare 段（新基线 c5b784a5）

你是 prepare 执行 worker（唯一 writer）。工作区 ~/.pi/worktrees/issue134-prepare/blogman（当前 detached @ b715bee，将被你 rebase 到新 main）。这是第六烧（#163，D1 v3-prod 上传横幅）修复后的 D11-R5。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 163 --repo nardinmarcus/blogman --comments` — 第六烧根因与修复
3. `env -u GITHUB_TOKEN -u GH_TOKEN gh api repos/nardinmarcus/blogman/issues/comments/5312690184 --jq .body` — #143 C1-C5 证据模板（照此结构）
4. 上一轮同段报告 ~/.local/state/blogman/prepare-r4/report.md — R4 全流程实作参考

## 新基线事实

- origin/main == `c5b784a556bb8e6e4dc89bd2d7d9c0879a84d103`（PR #164 merge，含第六烧修复）；rebase 后 `git rev-parse HEAD^{tree}` 记为新 tree
- CI：push run `32093357884` @ c5b784a5 正在跑（in_progress）——bootstrap 阶段可并行做，**最终 prepare 前必须等它 completed/success**（轮询等待，预计几分钟到二十分钟）
- 旧 manifest `9a235e08…` 与 authorization `f09a6e72…` 均已烧毁死亡：清理 `.issue-23-delivery/`（含 authorization.json——它已被消费，属死凭证）后全新开始

## 流程（照 R4 实作，两遍 prepare）

1. `cd ~/.pi/worktrees/issue134-prepare/blogman && git fetch origin && git checkout --detach c5b784a556bb8e6e4dc89bd2d7d9c0879a84d103`，确认 clean、记 tree
2. 清 `.issue-23-delivery/` `.next/` `.open-next/`；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`（已知本机坑，必须带此 env）→ exit 0
3. bootstrap config（3 项占位 file_tree，绑 c5b784a5）→ bootstrap prepare（与 CI 等待并行）
4. harvest 完整 file-list → 重写 config → **等 CI 32093357884 completed/success** → 最终 prepare：`GIT_CONFIG_GLOBAL=/dev/null env -u GITHUB_TOKEN -u GH_TOKEN node scripts/issue-23-delivery-prepare.mjs --config .issue-23-delivery/prepare-config.json` → exit 0 → 记 manifest sha256
5. C1 live 只读复核（wrangler 命令带 env 清理）：account 4f16b53a…、D1 5d1cadcf…、worker blogman、origin https://blog.namooca.com；baseline 以 wrangler deployments status 实时为准（D1 现为空库——第六烧 reset 实际执行过，属已知状态，不影响 baseline 读数：baseline 指 worker deployment/version/traffic，与 D1 数据无关）

## C3 预烧门禁（全部重放，#163 修复后新增第 6 项）

1. 排序/JSON-全等重放（双遍历逐字节一致 + 冻结全等 + 三遍历零残渣）
2. validateArtifactSource PASS（no Manifest Drift）
3. d1_identity 双解析器 live 预烧（d1 info + whoami 精确 argv）
4. Stage 3-7 envelope replay（live d1 info+whoami + #150 reset fixture + **live SELECT 1 文件导入信封** + migration 全链）→ outcome PASS
5. R2 probe 实测 200 + parseR2ProbeResponse ACCEPT
6. **新增（#163 直接验证）**：用本轮 live 捕获的 v3-prod 文件导入信封（含动态上传横幅）重放 `parseResetResponse` → 必须 ACCEPT（第六烧场景在修复后代码上绿灯的直接证明）；同时验证横幅提取器对两个历史探测哈希 fixture 的回归（tests 已覆盖，此处做 live 形态确认）

## C4/C5

- C4 secret-safety（同 R4 标准）
- C5：authority root 只读，**基线已变：25 文件**（第六烧后：6 auth/12 records/5 terminals + 2 sidecars 实为 25——以实际枚举为准记录起始聚合 sha，结束必须一致）；.issue-23-delivery 最终仅 prepare-config.json + manifest.json；git clean；scratch 仅 /tmp

## Tracker

`env -u GITHUB_TOKEN -u GH_TOKEN gh --repo nardinmarcus/blogman`：核对无重号 → 开票「[B1-G D11-R5] 从 c5b784a5 六修基线生成 fresh manifest」→ 挂 #85（GraphQL addSubIssue，node_id）→ C1-C5 证据评论 → 关票。禁触 #99/#131/#163；PR #102/#164 不动。

## 硬边界

同 R4：绝不 execute/授权/probe 上传/写 authority root/push/merge/改 tracked 文件；凭证零打印；gh env 清理；新墙证据耐久化 ~/.local/state/blogman/prepare-r5-evidence/ 后停下报告。

## 输出

耐久报告 ~/.local/state/blogman/prepare-r5/report.md。最终回复：manifest sha256 + 票号 + 链接 + 建议进入 D12-R6。
