# D15 Acceptance Brief — blogman #100 · 独立验收 Terminal Result 与 Production Evidence

你是 D15 验收员（fresh，一切独立复算）。工作区任意（只读任务，用 ~/.pi/worktrees/issue96-manifest/blogman 或主仓均可——本任务零写 repo）。

## 验收对象

第 15 次投递（R15，attempt `d4d526e3d5a3c380df5d8129b14e6480257afc3ab6f42da66fa3a807583c5a60`）：outcome PASS，10/10 stages，production_writes 4/4，#99 CLOSED（24 评论）。

## 核验清单（全部只读，逐项 PASS/FAIL）

1. **Terminal Result**：~/.local/state/blogman/issue-23-production-authority-v1/terminals/d4d526e3….json —— outcome=PASS、finalized、authorization_consumed、attempt/manifest(1a20fce1…)/authorization(daa614ba… 的 sha) 身份链
2. **Authority root 终态**：枚举（预期 R15 烧毁后 15 auth/34 records/15 terminals + d1-evidence/upload-evidence 增量）；R15 新增 5 文件（burn marker + manifest record + terminal + d1/worker sidecar）全 0600；**R15 的 d1-evidence 新增文件含 smoke/traffic 阶段字节**（首次全链字节证据）
3. **#99 关闭证据**：`env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 99 --repo nardinmarcus/blogman --comments` 末条 = R15 PASS 终态评论（含 Terminal Result 全文与四身份）
4. **生产实况只读复核**（env -u GITHUB_TOKEN -u GH_TOKEN + source /Users/dapeng/projects/blogman/.env.local）：
   - `wrangler deployments status --name blogman --config <issue134-prepare>/wrangler.toml --json`：100% 流量在 R15 部署的 version（非 405ab26f/205af4f5 前代）
   - `curl -s -o /dev/null -w %{http_code} https://blog.namooca.com/` = 200；`curl -s https://blog.namooca.com/ | head -c 500` 有 Next.js 站点内容
   - `wrangler d1 execute DB --remote --command "SELECT COUNT(*) FROM rollout_controls" --json --config …` —— 007 播种后 controls 行数 ≥3（producer/authority/executor:scheduled）；`SELECT control_key, desired_enabled FROM rollout_controls` producer=0/authority=0/executor:scheduled=0
   - migrations ledger：`SELECT COUNT(*) FROM d1_migrations`（或 ledger 表名按 schema）= 7
5. **燃烧史一致性**：#99 全部 24 评论的时间线叙事完整（15 attempts + 修复链），无矛盾

## 边界

零写（除 tracker 操作）；authority root 只读；凭证零打印；gh env 清理。

## Tracker

在 #100 发验收评论（逐项判定 + 终 verdict）；**PASS 才关 #100**，FAIL 留 OPEN 写明。

## 输出

~/.local/state/blogman/acceptance-d15/report.md。回复：verdict + 关键发现。
