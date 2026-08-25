# D14-C10 Fix Worker Brief — blogman #168 · 第七烧诊断优先修复

你是修正 writer（唯一 writer）。工作区：从 c5b784a5 建专用 worktree `~/.pi/worktrees/issue168-fix/blogman`（分支 pi/issue-168-wrapper-stderr）：`cd /Users/dapeng/projects/blogman && git worktree add ~/.pi/worktrees/issue168-fix/blogman -b pi/issue-168-wrapper-stderr c5b784a556bb8e6e4dc89bd2d7d9c0879a84d103`。依赖：`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 168 --repo nardinmarcus/blogman` — 第七烧事实与验收
2. ~/.local/state/blogman/delivery-r7/report.md + authority root 只读：records/f64f80c5…json（全 null 哈希）、upload-evidence/ 空目录、terminals/8620a4b9…json
3. scripts/issue-23-delivery-worker-upload.mjs 的前置链（855-1000 行段：holdStablePathChain→bindUploadAssetsDirectory→copyUploadSourceSnapshot→verifyFrozenSnapshotAgainstArchive→verifyBoundExecutable→npmBinDirectory→assertExecutionDirectoryIdentity→spawnSync）
4. scripts/issue-23-delivery-worker-transport.mjs childFailure()（163-170：stderr 丢弃点）
5. tests/scripts/issue-23-delivery-worker-upload.test.ts（既有 seam 用法）

## 任务 A（核心）：诊断 harness——本地复现前置链失败

用 worker-upload.mjs 导出的 upload 函数 + 生产同构条件在本地复现：
- 真实冻结 archive（~/.pi/worktrees/issue134-prepare/blogman/.open-next/open-next-build.zip，只读复制）+ 真实 wrangler.toml/config sha
- temp 树物化（照 entry 的 transport 树构造：report dir / source snapshot / config 拷贝）
- projected env 同构（environments.cloudflare = projectedEnvironment({CLOUDFLARE_*})——注意它剥掉了 HOME/PATH 等全部其他变量；wrapper 子进程继承的就是这个）
- spawn 拦截：不打网络。方法：openNextPath 参数指向真实 opennextjs-cloudflare 但在 spawn 前断点？不行——直接用你发现的 seam：若 upload 函数不可注入 spawn，则给 worker-upload.mjs 增加可测试的内部拆分（把前置链拆成独立导出函数 runPreflight(...)，spawnSync 之后的部分分开），先跑 preflight 复现
- 复现判据：preflight 在生产同构 bindings+env 下 throw。定位到具体语句后：判定为什么 rehearsal 没抓住（rehearsal transport 与 production 的 env/路径差异），写进报告

**重点怀疑面（按序排查）**：(a) projected env 剥离 PATH/HOME 后 wrapper 内部某调用（如 realpathSync 依赖、spawnSync 的 shell?、copyUploadSourceSnapshot 用的 zip 命令?）失败；(b) verifyBoundExecutable/npmBinDirectory 对 temp 树中 node/npm 副本的 realpath 校验在 production temp 路径下失败；(c) holdStablePathChain 对 authority-root 附近路径（upload-evidence dir 0700 属主）的权限假设；(d) executionDirectoryIdentity 在 temp 树物化后的 inode 假设。

## 任务 B：wrapper stderr 耐久化（无论 A 是否复现都做）

1. worker-upload.mjs：main() 包 try/catch——catch 时先把 {error stack 摘要, upload_stdout/stderr_sha256(null), stage: preflight|child} 写入 UPLOAD_FAILURE_PATH + upload-evidence/（O_EXCL 0600）再 process.exit(1)
2. worker-transport.mjs childFailure：D1ChildError 的 stderr bytes（bounded）携带进 WorkerStageError（新字段 wrapper_stderr_sha256），sidecar evidence.hashes 落 wrapper_stderr_sha256
3. 测试：A 的复现用例（若复现成功）+ wrapper stderr 耐久用例（人为 preflight 失败验证字节落盘）+ 既有全回归

## 流程与边界

- TDD RED→GREEN → `SHARP_IGNORE_GLOBAL_LIBV433...`（注意：SHARP_IGNORE_GLOBAL_LIBVIPS=true）`npx vitest run tests/scripts`（本机已知 1 环境性失败可忽略）→ push → `env -u GITHUB_TOKEN -u GH_TOKEN gh pr create`（refs #168）→ CI 全绿 → 报告，不自行合并
- **绝对零生产调用**：无 wrangler --remote、无 execute、无 probe；诊断全部本地 temp
- authority root 只读；不触 #99/#131/#168 外票；凭证零打印

## 输出

~/.local/state/blogman/fix-168/report.md：A 复现结论（复现/未复现 + 定位到的 throw 点 + rehearsal 为何没抓住）+ B 改动清单 + 测试计数 + PR URL。
