# D14-R5 Executor Brief — blogman #23 · 第 6 次生产投递（唯一一次）

你是投递 executor（唯一 writer），工作区 ~/.pi/worktrees/issue134-prepare/blogman（detached @ b715bee919af58cda1e58b10a35c597b45eb6952，tree 57d4967129ad85f6a648b140289f8b34e8577523）。前五次投递全部烧毁（燃烧史见 handoff），本次是修复链完备后的第 6 次、也是当前授权下唯一一次。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 99 --repo nardinmarcus/blogman --comments` — 前五次投递证据评论（R3/R4 的 D1 pre-entry 表与执行方法照抄）
3. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 162 --repo nardinmarcus/blogman --comments` — 本轮授权 receipt（authorization_id / bytes-sha256 / consumption semantics）

## 冻结事实（不可变）

- Manifest：.issue-23-delivery/manifest.json，sha256 `9a235e08e5506890f905e3114e15885497cf8f7748839b4fa6e0f7f3472bd48d`
- Authorization：.issue-23-delivery/authorization.json（pending 于 root 外），bytes-sha256 `f09a6e7218de497cb41b1a5018c3572ca3008670f1bccabb7c439640e87215a5`，id `issue23-authorization-0da832da…`
- 消费语义：execute 在 Stage 1 烧毁授权（先烧后写）；烧毁即终局，任何后续失败不再有授权

## D1 — Pre-entry 复读（逐项记录后才可调用）

照 R4 先例（#99 评论 5313150784 的表）：
1. manifest sha256 复算 == 9a235e08…
2. authorization.json 存在 + bytes-sha256 复算 == f09a6e72… + 字段门（4 字段/id 格式/decision=approve）
3. authority root 枚举：21 文件（5 auth/11 records/5 terminals）+ 聚合 sha256 == 096ca60e…（烧毁前基线）
4. 祖先权限：~/.local(755)/~/.local/state(755)/~/.local/state/blogman(700) 非 group/world-writable
5. env VALUES 非空验证（不打印值）：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（.env.local）+ DELIVERY_SMOKE_ADMIN 计算（sha256(ADMIN_PASSWORD:ADMIN_TOKEN_SALT) hex，同样不打印）
6. HEAD == b715bee、tracked clean、.issue-23-delivery 三件套（config/manifest/authorization）
7. CI run 32022371753 仍 completed/success/head=b715bee；#99 OPEN、#131 OPEN
任何一项不符 → 停止，不调用 execute，报告。

## 执行（恰好一次）

/tmp bootstrap（参照 R4：/tmp/issue99-execute.mjs 模式）：node 脚本 import 公开 `execute` from scripts/issue-23-delivery-entry.mjs（绝对路径），读 manifest bytes + authorization bytes，以 `execute(manifest, {bytes, sha256})` 调用；env 注入 CLOUDFLARE_*（从 /Users/dapeng/projects/blogman/.env.local）+ DELIVERY_SMOKE_ADMIN。整体 wall 预期 ~130s，超时上限按 manifest policy 5400s。启动前 echo 开始时间；结束后输出 Terminal Result JSON 全文（outcome / first_terminal_stage / classification / attempt id / authorization_consumed / production_writes）。

绝对规则：
- **恰好一次调用**。任何异常绝不重试、绝不 resume、绝不换入口、绝不补偿/回滚。
- 首个非 PASS stage = 终态，全部停止。后缀 stage 保持零计数。
- 执行期间不做任何其他 mutation（无 probe、无手动 wrangler 写）。

## Post-entry（无论成败）

1. 复读 authority root：烧毁后应 21→26 文件（+authorizations/f09a6e72… burn marker + records/9a235e08… + terminals/<attempt>… + 可能的 D1/Worker sidecar records），全部 0600；记录新增清单
2. 读 upload-evidence（若 Stage 8 失败）：UPLOAD_EVIDENCE_DIR 下 <sha>.stdout/.stderr 全文耐久化到 ~/.local/state/blogman/prepare-r4-evidence/（#159 新资产，先读再开修正票）
3. 在 #99 发证据评论（照 R4 格式）：Terminal Result 全文 + D1 复读表 + 消费证据 + 烧毁清单 + 各 stage 计数
4. outcome PASS → 关 #99（唯一成功路径）；outcome ERROR → #99 保持 OPEN、#131 保持 OPEN，停
5. 全程凭证值零打印；gh 一律 env -u GITHUB_TOKEN -u GH_TOKEN

## 输出

耐久报告 ~/.local/state/blogman/delivery-r6/report.md（Terminal Result + stage 计数 + authority root 变更 + 证据评论 URL）。最终回复：outcome + first_terminal_stage + 关键证据摘要。若 ERROR：只报告不开修正票（修正票由 Commander 决策后另派）。
