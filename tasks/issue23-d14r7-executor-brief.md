# D14-R7 Executor Brief — blogman #23 · 第 8 次生产投递（唯一一次）

你是投递 executor（唯一 writer）。工作区 ~/.pi/worktrees/issue134-prepare/blogman（detached @ 6c2e001fb84333ffce6baecb7eea2728d8249126，tree 66493445a451d90b4c5b64bb28d062f5ac3b5e14）。这是七烧全修（含 #168 preflight 字符集墙 + wrapper stderr 耐久化）后的第 8 次、本授权下唯一一次。

## 先读（只读）

1. /Users/dapeng/projects/blogman/tasks/handoff-2026-08-17-issue23-delivery-chain.md
2. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 99 --repo nardinmarcus/blogman --comments` — 七次投递先例（R7 格式照抄 R6/R5）
3. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 172 --repo nardinmarcus/blogman --comments` — 本轮授权 receipt

## 冻结事实

- Manifest：sha256 `2b02bb9988fc7bb82186e39f2ceaa08348d092f4d706bdde593a42d05c235444`
- Authorization：bytes-sha256 `18be9c42b810b58a8bbafc1fa463a40abc05ddb0a4e01b1473220e0a92b08391`，id `issue23-authorization-de489470…`
- 闭包：`a2fde1979d780312591a0b62e8af45d8bf4827f6242f2db401e616240e1c6af4`

## D1 — Pre-entry 复读（照 R7 前例逐项）

1. manifest sha == 2b02bb99…；authorization bytes-sha == 18be9c42… + 4 字段门
2. authority root：44 文件 / 聚合 sha256 `b578cec94b425da7efca990826fd23a351ab4b9382f33f286d67f3674bd575bc`（烧毁前基线）
3. 祖先权限；env VALUES 非空（含 DELIVERY_SMOKE_ADMIN 派生，零打印）
4. HEAD == 6c2e001f、clean、三件套；CI 32105066670 success；#99/#131 OPEN
任何不符 → 停。

## 执行（恰好一次）

/tmp bootstrap（/tmp/issue99-execute-r8.mjs）：import 公开 execute（绝对路径），manifest {value,bytes,sha256} + authorization {bytes,sha256}；env 注入 CLOUDFLARE_*（.env.local）+ DELIVERY_SMOKE_ADMIN 进程内派生 + GIT_CONFIG_GLOBAL=/dev/null。预期 wall ~2-3 分钟。绝对规则：恰一次；首错即终态；无其他 mutation。

## Post-entry

1. authority root 烧毁后枚举（预期 44→50±：+burn marker +records/terminal +sidecars + 可能的新 d1-evidence/upload-evidence 文件；#168 后 wrapper 失败路径也会留 wrapper-failure 记录）全部 0600
2. **若失败**：直读 d1-evidence/ + upload-evidence/ + wrapper-failure 记录（#169 后字节证据全链耐久），全文耐久化 ~/.local/state/blogman/delivery-r8-evidence/
3. #99 证据评论（照 R7 格式）
4. PASS → 关 #99；ERROR → #99/#131 保持 OPEN，报告即止
5. 凭证零打印；gh env 清理

## 输出

~/.local/state/blogman/delivery-r8/report.md。最终回复：outcome + first_terminal_stage + 摘要。
