# D11-R4 Worker Brief — blogman #23 第 6 次投递链 · prepare 段

你是执行 worker（唯一 writer），在本工作区（~/.pi/worktrees/issue134-prepare/blogman，detached @ b715bee919af58cda1e58b10a35c597b45eb6952，tree 57d4967129ad85f6a648b140289f8b34e8577523）完成 D11-R4：生成 fresh canonical frozen manifest → C1-C5 全套证据 → 开票/发证据/关票。

## 先读（按序，只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md — 交接全貌（五次燃烧史、流程资产、雷区）
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh api repos/nardinmarcus/blogman/issues/comments/5312690184 --jq .body` — #143 的 C1-C5 证据模板，本次照此结构产出
3. ~/.pi/worktrees/issue96-manifest/blogman/.issue-23-delivery/prepare-config.json — 旧轮 config 结构模板（仅结构参考，绑定旧 commit 2824563a 不可复用）
4. 本工作区 scripts/issue-23-delivery-prepare.mjs 与 schemas/issue-23-delivery/

## 当前状态（前一轮 worker 部分完成，已被叫停）

- **npm sharp 问题已修复**：node_modules/@img/sharp-darwin-arm64 已存在，opennextjs build 已成功过一轮（.open-next 有 22:16 的产物）。诊断证据在 /tmp/blogman-npmignore-r4.*/（含最小复现）。⚠️ 你必须先复验：`node -e "require('sharp')"` 成功 + 重跑 `npm ci --no-audit --no-fund` exit 0（若再失败，用 /tmp 证据重诊断，修复不得改 tracked 文件、不得换 node 大版本跑 prepare——node 必须保持 22.22.3）
- bootstrap config 已写好（.issue-23-delivery/prepare-config.json，3 项 file_tree，绑定 b715bee），bootstrap prepare 跑到 migration rehearsal 段被中断（stdout 空）。孤儿进程已由 Commander 清理
- prepare 脚本每次 runOpenNextBuild 会先 rmSync .open-next 再全新构建——直接重跑即可

## prepare 执行（两遍流程）

1. bootstrap：用现有 bootstrap config 跑 prepare 完成全新构建：`GIT_CONFIG_GLOBAL=/dev/null env -u GITHUB_TOKEN -u GH_TOKEN node scripts/issue-23-delivery-prepare.mjs --config .issue-23-delivery/prepare-config.json` → exit 0
2. 从 bootstrap 产物 harvest 完整 file-list（.open-next 实际枚举 + prepare 的 pattern 排除规则），重写完整 config
3. 最终 prepare（同命令）→ 必须 exit 0 → manifest.json 诞生，记 SHA-256

- CI 绑定：run 32022371753（push/attempt-1/success/head_sha=b715bee）——prepare 自行 gh 校验，需 env -u GITHUB_TOKEN -u GH_TOKEN
- live facts（C1 只读复核，wrangler 同样 env 清理）：account 4f16b53a560765de8773b667ead62bd8、D1 5d1cadcf-e10e-4245-b07d-16c64754f00d、worker blogman、origin https://blog.namooca.com；baseline 以 wrangler deployments status 实时读数为准（前值 92422ae1-e7ce-45b7-95ab-bac8cc69f808 / bf8666ae-996f-496d-a090-4c779ad57c3a，若变化如实记录并上报）
- 凭证：/Users/dapeng/projects/blogman/.env.local（已验证非空；值永不打印）

## C3 预烧门禁（全部重放，逐项记录）

1. 排序/JSON-全等重放：comparePathSegments 全路径 collect-then-sort 双遍历逐字节一致；与冻结 file_tree JSON-exact 全等；file_tree.sha256 模块内不变量 PASS；三遍历一致证零残渣
2. production 门禁：WORKER_COMMAND_CONTRACT.validateArtifactSource 对真实磁盘 bindings PASS（no Manifest Drift）
3. d1_identity 原始解析器预烧（只读）：parseRemoteD1InfoResponse 接受 live d1 info；parseWranglerWhoamiResponse 接受 live env-token whoami（production 精确 argv `whoami --account <id> --config wrangler.toml --json`）
4. Stage 3-7 envelope 解析重放（runD1Stages 无网络 replay transport）：d1_identity=live d1 info+whoami 全链；clean_start_reset=#150 fixture 信封（float duration+upstream meta）；empty_d1_proof=本轮 live 只读捕获 `wrangler d1 execute DB --remote --command 'SELECT 1' --json` 信封；migration 全链 runner 语义输出；要求 outcome PASS、first_terminal_stage=null、五 stage 各 1 次调用
5. R2 探测接受度重放：live_preconditions R2 probe 以 production 精确 argv（curl stdin config 传 token）实测 HTTP 200 且 parseR2ProbeResponse ACCEPT

#159 新增的 upload stderr 耐久化在 prepare 阶段无预烧面——记为已知边界即可。

## C4/C5

- C4 secret-safety：manifest 全量扫描——0 credential/token/private-key/JWT/sk-/Bearer、0 私路径（/Users/ /private/ /home/ .local/state /tmp /var）、0 base64 数据块；长字符串计数归类
- C5 输出纪律：authority root ~/.local/state/blogman/issue-23-production-authority-v1 只读（基线 21 文件、聚合 sha256 096ca60e241b900601874b27cceb86600a87244445f83a9e7967b69f3821de8b，结束必须逐字节一致）；.issue-23-delivery 最终仅留 prepare-config.json + manifest.json；git status clean；scratch 仅 /tmp

## Tracker（每段一票）

`env -u GITHUB_TOKEN -u GH_TOKEN gh --repo nardinmarcus/blogman`：先 gh issue list 核对无重号 → 创建票「[B1-G D11-R4] 从 b715bee 五修基线生成 fresh manifest」→ 加入 #85 sub_issues（sub_issue_id 用 INTEGER 号）→ 发 C1-C5 证据评论（manifest sha256、CI run 32022371753、file 计数、五项预烧逐项判定）→ 关票。禁触 #99/#131/#23/#85/#24；PR #102 悬置不动。

## 硬边界（违反即事故）

- 绝不 execute、绝不请求/签发 authorization（D13 人工专属）、绝不手动 probe 上传（guard 在盯）
- 绝不写 authority root；绝不 push/merge/main 仓库改动
- 工作区 tracked 文件零改动（仅 .issue-23-delivery/.next/.open-next/node_modules 产物）
- 已知 4 个本机环境性 prepare 套件失败（manifest-order×2、canonical CLI、F1 OpenNext）不追，CI 为准
- 遇新墙：证据耐久化到 /tmp 与 ~/.local/state/blogman/prepare-r4-evidence/，不盲目重试，停下在最终回复里报告
- 凭证值永不打印；gh 用 env -u GITHUB_TOKEN -u GH_TOKEN；prepare 的 git 解析用 GIT_CONFIG_GLOBAL=/dev/null

## 输出

耐久报告写 ~/.local/state/blogman/prepare-r4/report.md（npm 根因与修复、manifest sha256、票号、证据评论 URL、C1-C5 逐项判定）。最终回复：manifest sha256 + 票号 + 票链接 + 建议下一步（进入 D12-R5 review）。
