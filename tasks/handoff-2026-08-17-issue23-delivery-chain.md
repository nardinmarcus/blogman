# Handoff — Blogman #23 Delivery Chain (2026-08-17)

> 交接给新主任务窗口。本窗口（issue93-runbook, w4:p5M）承载了 D09→D14 全链上下文，已按用户指示退役。新窗口从本文件 + GitHub tracker 重建状态。

## 当前状态一句话

D14 生产投递已烧 5 颗授权，第 6 次链路的前置修复**全部完成并入 main（`b715bee`）**，站点降级运行中（home 200 / posts 404，D1 空库为设计终态），下一步 = 新 prepare → 新 review → 新人工授权 → 第 6 次投递。

## 权威事实源

- **Tracker**: GitHub Issues #19→#23→#85 图谱（`gh --repo nardinmarcus/blogman`）
- **Main**: `b715bee919af58cda1e58b10a35c597b45eb6952`（PR #159 merge）
- **Authority root**: `~/.local/state/blogman/issue-23-production-authority-v1/` — **21 个历史文件，全部冻结不可动**（4 auth + 8 records + …，每次投递烧毁后递增，属正常终态记录）
- **凭证**: `/Users/dapeng/projects/blogman/.env.local` — CLOUDFLARE_API_TOKEN（53 位，含 R2 scope，已实测可用）+ CLOUDFLARE_ACCOUNT_ID（=manifest 绑定账户）
- **保留 worktree**: `~/.pi/worktrees/issue134-prepare/blogman`（投递链工作区，需 rebase 到新 main 后清 `.issue-23-delivery/.next/.open-next` 重跑 prepare）；`issue96-manifest`（reviewer 常驻区）；`issue94-correction-guard`（guard 常驻区）

## 五次燃烧史（每墙已修）

| # | 烧于 | 根因 | 修复 PR |
|---|---|---|---|
| 1 | live_preconditions (drift) | .open-next 残渣 + 排序比较器分歧 | #133 (#132) |
| 2 | d1_identity (malformed) | d1 info 变体缺 jurisdiction 等键 | #142 (#141) |
| 3 | d1_identity (malformed) | whoami env-token 形态 + api_access_enabled null | #145/#147 (#144/#146) |
| 4 | clean_start_reset (invalid) | 响应 meta 含 duration；**reset 已执行 → D1 清空（设计内）** | #151 (#150) |
| 5 | worker_deploy (nonzero, ~1.1s) | opennext upload 内部 spawn bash，受限 PATH 无 /bin；stderr 证据被清理不可检索 | #159 (#158) |

## 已确立的流程资产

- **预烧门禁（pre-burn proofs）**：validateArtifactSource 重放 + 双 d1 解析器 live 捕获接受 + runD1Stages envelope replay + R2 probe 接受 + （新增）上传失败 stderr 耐久化——每次 prepare 的 C3 必做，防再烧授权
- **每段一票**：修正票 (#NNN) → writer worktree+pane → TDD RED→GREEN → 门禁 → push → PR → CI×review 并行 → merge → 关票。模式见 #158→PR #159
- **模型政策**：worker=deepseek-v4-flash（限额即轮换，勿停）；guard=glm-5.3 新 pane；限额轮换顺序见 user memory
- **Pane 纪律**：agent 报告完成即关窗；guard 一次性不续用；主会话过载即 handoff 新开（本次即例）
- **Guard**: NAMOO Task Guard 契约模板见历次 `~/.local/state/blogman/guard-*/report.log`

## 下一步（新窗口接手清单）

1. 读本文件 + `gh issue view 99 --comments`（5 次燃烧 lineage）+ `gh api repos/nardinmarcus/blogman/issues/85/sub_issues`
2. **D11-R4**：issue134-prepare worktree rebase 到 `b715bee`，清 `.issue-23-delivery/.next/.open-next`，重跑 prepare（先例：#143 evidence comment 5312690184 的 C1–C5 模板 + C3 全套预烧证明）
3. **D12-R5** review → **D13-R5 人工授权（用户批准，不可代批）** → **D14 第 6 次投递**（executor+guard 模式）
4. 投递成功后：D15 (#100) 验收 Terminal Result → D16 (#101) 完成票 → #23 关闭评估 → #24 frontier
5. 若第 6 次又烧：先读 upload-evidence/ 耐久 stderr（#159 的新资产）再开修正票，**不要**再手动 probe 上传（guard 会 P0，需用户授权）

## 用户已批的存量授权

- 牺牲性 probe worker `blogman-delivery-probe` 的**清理**（用户已授权，未执行——用 `wrangler delete` 删除该脚本）
- 站点内容策略：用户选 A（接受 clean-start 空库终态，内容日后自行重建）

## 雷区

- `~/.gitconfig` 的 https→ssh insteadOf：prepare/rehearsal 需 `GIT_CONFIG_GLOBAL=/dev/null`
- 本机 4 个 prepare 套件环境性失败（manifest-order×2、canonical CLI、F1 OpenNext）：已在 pristine base 验证，**不追**，CI 为准
- `gh` 需 `env -u GITHUB_TOKEN -u GH_TOKEN`；凭证值永不打印
- PR #102（docs）REWORK 悬置——用户未处置，别动
