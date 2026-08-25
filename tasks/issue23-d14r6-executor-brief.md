# D14-R6 Executor Brief — blogman #23 · 第 7 次生产投递（唯一一次）

你是投递 executor（唯一 writer）。工作区 ~/.pi/worktrees/issue134-prepare/blogman（detached @ c5b784a556bb8e6e4dc89bd2d7d9c0879a84d103，tree a02d233424001d15ff486ef87ff8074799bfd2c3）。这是六烧全修（含 #163 D1 v3-prod 横幅）后的第 7 次、本授权下唯一一次。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 99 --repo nardinmarcus/blogman --comments` — 六次投递先例（R5/R6 的 D1 表与方法照抄）
3. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 167 --repo nardinmarcus/blogman --comments` — 本轮授权 receipt

## 冻结事实

- Manifest：sha256 `a976dfeb34e05b62f1e693ad51fb58fd2b6f107bd7fb75f3f2db104872c58a02`
- Authorization：pending 于 root 外，bytes-sha256 `5793ae3fcae2dfea4f8cb928daaa8f6592d0b56b996b3916c794141cfc951abe`，id `issue23-authorization-49307544…`
- 闭包：`da800d8bd743665f574f9db91f2197119af5c538d2b6bfb2ccf974ed87bf305f`

## D1 — Pre-entry 复读（照 R6 先例逐项记录）

1. manifest sha == a976dfeb…；authorization bytes-sha == 5793ae3f… + 4 字段门
2. authority root：**25 文件**（6 auth/13 records/6 terminals）+ 聚合 sha256 `edc5270f9f7357ef2bef0285b1d91018be45602d4fe8948605af83137632d3dc`（烧毁前基线）
3. 祖先权限（~/.local 755 等）；env VALUES 非空（含 DELIVERY_SMOKE_ADMIN 派生）
4. HEAD == c5b784a5、clean、三件套；CI 32093357884 success；#99/#131 OPEN
任何不符 → 停，不调用。

## 执行（恰好一次）

/tmp bootstrap（/tmp/issue99-execute-r7.mjs）：import 公开 execute（绝对路径），manifest {value,bytes,sha256} + authorization {bytes,sha256}；env 注入 CLOUDFLARE_*（.env.local）+ DELIVERY_SMOKE_ADMIN（进程内派生零打印）+ GIT_CONFIG_GLOBAL=/dev/null。预期 wall ~2-3 分钟（D1 全链 + worker upload + traffic + smoke）。绝对规则：恰一次；首错即终态；无任何其他 mutation。

## Post-entry

1. authority root 烧毁后枚举（预期 25→30±：+auth burn marker +records/terminal +sidecars；含新 d1-evidence 目录为 #164 新增合法布局）全部 0600
2. **若任何 stage 失败**：读 d1-evidence sink（#164 新资产：每 stage 原始 stdout/stderr 已落盘 authority root）+ upload-evidence，全文耐久化 ~/.local/state/blogman/delivery-r7-evidence/——本轮起任何烧毁都有精确字节
3. #99 证据评论（照 R6 格式：Terminal Result + D1 表 + 消费 + 烧毁清单 + stage 计数）
4. PASS → 关 #99；ERROR → #99/#131 保持 OPEN，报告即止（修正票 Commander 决策）
5. 凭证零打印；gh env 清理

## 输出

~/.local/state/blogman/delivery-r7/report.md。最终回复：outcome + first_terminal_stage + 摘要。
