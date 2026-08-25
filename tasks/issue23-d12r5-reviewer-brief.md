# D12-R5 Reviewer Brief — blogman #23 · 独立审查 manifest 9a235e08 与 formal entry

你是独立 reviewer（fresh context，不受 prepare worker 任何自述影响，一切独立复算）。工作区：~/.pi/worktrees/issue96-manifest/blogman（detached @ b715bee919af58cda1e58b10a35c597b45eb6952，tree 57d4967129ad85f6a648b140289f8b34e8577523，node_modules 就绪）。被审对象：.issue-23-delivery/manifest.json（已由 Commander 复制自 prepare 工作区，声称 sha256 9a235e08e5506890f905e3114e15885497cf8f7748839b4fa6e0f7f3472bd48d——你第一步就独立复算）。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md — 全链上下文与五次燃烧史
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 160 --repo nardinmarcus/blogman --comments` — D11-R4 证据（作为待核claim清单，不是结论）
3. 前一轮 D12 review 先例：#156（manifest f08897e6 @ 25321af 的审查）——照它的结构与判定标准
4. 本工作区 schemas/issue-23-delivery/ 与 scripts/issue-23-delivery-entry.mjs、issue-23-delivery-worker-upload.mjs、issue-23-delivery-worker-stages.mjs

## 审查面（全部独立复算，逐项给判定）

### M — Manifest 事实核验
1. sha256 复算（必须等于 9a235e08…，字节 425654）
2. parseCanonicalManifest 通过（canonical schema 序）
3. repository.commit/tree == b715bee/57d49671；与 origin/main `git fetch` 后 rev-parse 一致
4. ci：run 32022371753 / attempt 1 / event push / conclusion success / head_sha 精确（gh 复核）
5. toolchain identities：node 22.22.3 / npm / curl / wrangler 4.86.0 / opennextjs 1.19.10 的 identity_sha256 与本机实测一致（工作区 node_modules 路径实测）
6. artifact：archive 与 worker 的 sha256/bytes 与 manifest 一致；file_tree.files 1686 项、file_tree.sha256 复算一致；与 prepare 工作区 ~/.pi/worktrees/issue134-prepare/blogman/.open-next/ 磁盘逐项全等（跨工作区只读比对）
7. migration：reset_sql/runner/catalog/001-006 checksum 与磁盘一致；expected reconciliation snapshot 合法
8. target facts：account 4f16b53a560765de8773b667ead62bd8、D1 5d1cadcf-e10e-4245-b07d-16c64754f00d、worker blogman、origin https://blog.namooca.com、baseline deployment/version/traffic——只读 live 复核（wrangler deployments status / d1 info，env 清理同 worker 规则）
9. policy/evidence/rehearsal 字段自洽（rehearsal PASS、production_write_adapter_calls=0、receipt sha）

### E — Formal entry 审查（重点：#159 后未复审过的增量）
1. scripts/issue-23-delivery-entry.mjs @ b715bee 全文审查：一次性状态机、first-terminal-stop、authorization 消费时序（先烧毁后写）、Stage 顺序
2. **增量审查（#159/PR #159 相对 25321af 的 diff）**：`git diff 25321af..b715bee -- scripts/ tests/` —— worker-upload.mjs 的上传子进程 PATH 修复（系统 bin 注入）与 stdout/stderr 耐久证据（upload-evidence sink）；worker-stages/entry 相应改动；tests 覆盖是否充分
3. execute 入口绑定：manifest.preparation.execute_entry.sha256 == 磁盘 entry 脚本 sha256；formalExecutionClosureSha256 复算（按 #143 先例的方法）
4. 静态审查结论：第 6 次投递在 Stages 1-8 的已知五墙是否全被当前代码覆盖（drift/d1 info 变体/whoami 形态/meta 容忍/upload PATH+stderr）

### 边界（P0 红线）
- 绝不 execute、绝不签发/请求 authorization、绝不任何写操作（live 命令只读：deployments status / d1 info / whoami）
- 绝不写 authority root ~/.local/state/blogman/issue-23-production-authority-v1（只读枚举允许）
- 绝不改 prepare 工作区任何文件；不触 #99/#131/#23/#85/#24/#160
- 凭证值永不打印；gh/wrangler 一律 env -u GITHUB_TOKEN -u GH_TOKEN

## Tracker（唯一允许的写面）

`env -u GITHUB_TOKEN -u GH_TOKEN gh --repo nardinmarcus/blogman`：创建票「[B1-G D12-R5] 独立审查 manifest 9a235e08 与 formal entry」→ 挂载 #85 sub_issues（INTEGER id）→ 发审查证据评论（M1-M9 / E1-E4 逐项判定 + 总 verdict）→ PASS 才关票。任何一项 FAIL：票保持 OPEN，评论写清 FAIL 项与证据，结束。

## 输出

耐久报告 ~/.local/state/blogman/review-r5/report.md（逐项判定 + 证据）。最终回复：verdict PASS/FAIL + 票号 + 关键发现摘要 + 若 PASS 建议进入 D13-R5 人工授权。
