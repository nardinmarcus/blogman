# D12-R6 Reviewer Brief — blogman #23 · 独立审查 manifest a976dfeb 与 formal entry

你是独立 reviewer（fresh context，一切独立复算）。工作区：~/.pi/worktrees/issue96-manifest/blogman（detached @ c5b784a556bb8e6e4dc89bd2d7d9c0879a84d103，tree a02d233424001d15ff486ef87ff8074799bfd2c3，node_modules 就绪）。被审：.issue-23-delivery/manifest.json（声称 sha256 a976dfeb34e05b62f1e693ad51fb58fd2b6f107bd7fb75f3f2db104872c58a02——第一步独立复算）。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 163 --repo nardinmarcus/blogman --comments` — 第六烧根因（D1 v3-prod 上传横幅）与 #164 修复
3. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 165 --repo nardinmarcus/blogman --comments` — D11-R5 证据（含 Commander 勘误评论：C5 聚合正确值 edc5270f…）——作为待核 claim 清单
4. 上一轮先例 #161（你前身的审查结构）：`env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 161 --repo nardinmarcus/blogman --comments`
5. schemas/issue-23-delivery/ + scripts/issue-23-delivery-entry.mjs / -d1-stages / -d1-contracts / -d1-transport / -worker-upload / -worker-stages

## 审查面（独立复算，逐项判定）

### M — Manifest 事实核验（同 R5 的 M1-M9 结构）
M1 sha 复算（=a976dfeb…，425632B）；M2 parseCanonicalManifest；M3 commit/tree == c5b784a5/a02d2334 与 origin/main 一致；M4 CI run 32093357884（attempt1/push/success/exact-head）；M5 toolchain identities 本机实测（注意 execute_entry 新闭包 da800d8b…）；M6 artifact/file_tree 1686 项 + file_tree.sha256=9c17cd59… 复算 + 与 prepare 工作区磁盘全等（跨工作区只读）；M7 migration 全链 checksum（catalog 9421f735… 与 R4 一致性合理性）；M8 live 只读 target facts（baseline 92422ae1/bf8666ae@100%；D1 空库=已知态）；M9 policy/rehearsal 自洽（receipt a7413abd…）。

### E — Formal entry 审查
E1 entry 状态机全文（同 R5 E1：烧毁时序/first-terminal-stop/stage 序/超时重分类）
E2 **#164 增量审查（b715bee..c5b784a5）**：extractJsonDocument（行首隔离+平衡扫描+strict 校验+fail-closed）正确性与边界（嵌套/转义/横幅碎片）；8 解析器接入面；**D1 stage 耐久证据 sink**（O_EXCL 0600/fsync/EEXIST 字节去重/成败皆写/receipt stage_evidence 可寻址/生产 execute 的 authority-root d1-evidence 接线）；tests 12 例覆盖评估（双哈希重放/多行横幅/无 JSON fail-closed）
E3 execute_entry 绑定：闭包哈希 da800d8b… 三处全等复算
E4 **七墙静态覆盖**（六烧全链）：#132/#135 排序、#141/#144/#146 d1 解析变体、#150 meta 容忍、#158/#159 upload PATH+stderr、**#163 横幅提取+D1 sink**——逐墙指向代码证据

### 特别核验（本轮新增）
X1: C3.6 声称的 live v3-prod 信封重放 ACCEPT——你独立用 ~/.local/state/blogman/prepare-r5-evidence/ 里的 live 捕获重放 parseResetResponse 验证
X2: authority root 现状 = 25 文件 / 聚合 edc5270f…（你独立复算；与 #165 勘误一致）

### 边界（P0 红线）
同 R5：零执行/零授权/零写（live 只读）；authority root 只读；prepare 工作区只读；不触 #99/#131/#163/#165；凭证零打印；gh/wrangler env 清理。

## Tracker

开票「[B1-G D12-R6] 独立审查 manifest a976dfeb 与 formal entry」→ 挂 #85（GraphQL）→ 证据评论（M1-M9/E1-E4/X1-X2 + 总 verdict）→ PASS 才关票；FAIL 则票留 OPEN 结束。

## 输出

~/.local/state/blogman/review-r6/report.md。最终回复：verdict + 票号 + 关键发现。
