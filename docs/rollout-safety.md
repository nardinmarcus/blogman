# Rollout safety

`scripts/rollout-safety.mjs` 是 Blogman 迁移后备份恢复、对账、候选身份和 rollout 控制的统一接口。所有命令以 JSON 输出脱敏报告；失败返回非零。正文、HTML、token、密码、Bridge 凭证、AI key 和原始外部响应不得进入 manifest、candidate evidence、audit actor/reason 或报告。

## 安全边界

- Issue #23 Phase B 的唯一仓库顺序合同是 `scripts/phase-b-sequence.mjs`：`PRE-CAS/local gates → CAS1 → D1 identity → remote migration plan → export → double restore → upload → migrations 001–006 → CAS2 → traffic → smoke/reconcile → T0`。runner 在任何 stage 前验证 absolute production `CONFIG` 和冻结的 candidate/approval packet/build/baseline deployment/version/D1 binding cache，将两者冻结为每个 adapter 必须使用的同一 execution context；每 stage exactly once、无 retry，任一失败立即停止。remote plan 失败时 export 及全部后缀计数必须为 `0`。这不改变八批交付顺序。Issue #23 的 superseding decision 只允许 migration `001` 的 `001_initial_schema.baseline.sql` statements `1` 与 `3` 在 remote baseline 验证中由 checksum-bound `001_initial_schema.remote.baseline.sql`（SHA-256 `90c94ce79e77d3ca3ab22fc67f702243e7305bcd1860f3d1feb2026fb56b4a03`）替换。原 migration/baseline 字节与 ledger checksum、本地路径、其他 sidecar 的 `EXPLAIN` opcode proof 和完整 compatibility issue multiset 均不变；两个 replacement group 的六条 probe 由 source/replacement identity、私有 0600 输出、300 秒上限、one-shot/no-retry 和各组前后 schema fingerprint 共同约束，任一失败禁止 fallback 并保持全部 downstream Phase B stage 为 `0`。
- `backup restore` 和 `request smoke` 只接受 `--local`，必须显式指定仓库外的绝对 `--persist-to` 空目录，绝不回退到默认 `.wrangler/state`。
- `reconcile capture|compare` 支持显式 local D1，也为经授权的未来 production read-only 对账保留 `--remote` 接口；普通本地验收只使用 `--local`。
- 旧备份不能恢复到已有文件的 persist 目录。新事实出现后只能停用 producer/authority/executor 并前向修复，不能用旧备份覆盖、down migration 或清空新表。
- Cloudflare D1 不支持导出包含 FTS5 virtual table 的数据库。备份包可按恢复顺序列出多个 SQL artifact，例如常规表导出和候选绑定的 FTS/index/trigger 重建脚本；每个 artifact 都必须有字节数和 SHA-256。

### 私有生产导出封装

生产 D1 导出只能通过一次性私有封装执行，禁止直接运行 `wrangler d1 export` 或继承父进程 stdio：

```bash
node scripts/rollout-safety.mjs backup export \
  --run-root /private/evidence/export-candidate-successor-1 \
  --database DB --remote --config /private/wrangler.toml \
  > /private/evidence/reports/export-report.json
```

`--run-root` 必须是仓库外尚不存在的绝对路径。命令在启动 Wrangler 前原子创建 mode `0700` 的 run root，并固定七张普通表；已存在的 root 一律拒绝，失败后也不能删除或复用它来重试。Wrangler stdout/stderr 直接写入 root 内 `0600` 文件描述符；`WRANGLER_LOG_PATH` 也被强制覆盖为同一私有目录内预建的 `0600` debug 文件，因此三种原始输出都不会进入父进程内存、终端、工具输出或 Wrangler 默认日志位置，并在成功或失败时统一覆盖删除。导出子进程有不可放宽的 300 秒上限，超时会被终止且不会重试。命令还要求 SQL 非空、权限精确为 `0600`，并用私有临时 SQLite 校验 SQL 可执行、普通表集合精确匹配、列名集合及 `type/notnull/default/pk/hidden` 语义精确匹配，只允许冻结的 Issue #21 text-AI A/B/C 变体（`ai_actions.profile_id` 的位置/存在性与获准的 `max_tokens` 默认值配对）。这里不宣称覆盖全部 UNIQUE/FK/CHECK/index 约束；后续 candidate migration plan 仍是这些冻结兼容规则的权威。成功只输出 `blogman-d1-private-export/v1` 脱敏 JSON；子进程失败/超时、空/畸形 SQL、权限或 schema 不符时只保留 `attempt_count=1` 的脱敏失败报告，并立即覆盖删除原始 SQL。私有目录的清理与销毁按实际递归枚举结果执行并复查为空，包括未知 debug 文件和 SQLite sidecar，而不是依赖固定文件名清单。

成功的 SQL 仅保留到双隔离恢复和 pre-migration candidate 全部验收通过。任一中途失败由 runbook 的 `EXIT` trap 调用相同销毁命令；成功验收后也必须显式调用：

```bash
node scripts/rollout-safety.mjs backup dispose \
  --run-root /private/evidence/export-candidate-successor-1 \
  > /private/evidence/reports/export-dispose-report.json
```

`dispose` 只接受已经确认子进程终态的 `failed|captured` attempt，递归覆盖删除 raw SQL 和私有目录内所有残留 capture/validation/sidecar 文件，并在实际复查为空后才输出 `raw_artifacts_remaining=0` 的脱敏报告。若报告仍为 `started`，子进程状态未知，命令会拒绝生成销毁证明；该 root 必须原地隔离，不能读取、移动、删除或复用。无论哪种状态，attempt root 都不能成为第二次 export。

## 1. 备份验证与隔离恢复

备份目录包含 `manifest.json` 和一个或多个相对路径 SQL artifact：

```json
{
  "format": "blogman-d1-backup/v1",
  "backup_id": "sha256:<按顺序连接全部 artifact 字节后的 SHA-256>",
  "source": {
    "database_id": "non-secret-source-id",
    "captured_at": "2026-07-25T00:00:00.000Z"
  },
  "required_tables": ["posts", "categories", "site_settings"],
  "artifacts": [
    { "path": "backup.sql", "bytes": 1234, "sha256": "<64 hex>" }
  ]
}
```

```bash
node scripts/rollout-safety.mjs backup verify --manifest /private/backup/manifest.json \
  > /private/evidence/backup-report.json

RESTORED_D1_DIR="$(mktemp -d)"
node scripts/rollout-safety.mjs backup restore \
  --manifest /private/backup/manifest.json \
  --database DB --local --persist-to "${RESTORED_D1_DIR}" \
  --config wrangler.toml
```

`verify` 检查格式、路径边界、重复 artifact、字节数、artifact SHA-256、稳定 backup ID、required table 声明和敏感字段。`restore` 先由 Wrangler 初始化隔离 local D1，再用本机 `sqlite3` 按清单顺序导入 artifact，避免生产导出中的大单条 INSERT 被 Wrangler file import 以 `SQLITE_TOOBIG` 拒绝；最后重新由 Wrangler 核对 required tables。“SQL 成功执行”本身不算恢复完成，缺少 `sqlite3`、不能唯一定位隔离 D1 文件或任一 artifact 失败都会 fail-closed。

## 2. Schema 与数据对账

```bash
node scripts/rollout-safety.mjs reconcile capture \
  --database DB --local --persist-to "${RESTORED_D1_DIR}" \
  --config wrangler.toml \
  > /private/evidence/before.json

node scripts/rollout-safety.mjs reconcile compare \
  --expected /private/evidence/before.json \
  --database DB --local --persist-to "${RESTORED_D1_DIR}" \
  --config wrangler.toml \
  > /private/evidence/reconciliation-report.json
```

快照格式为 `blogman-d1-reconciliation/v1`，只记录：

- 完整非内部 `sqlite_schema` 指纹；
- migration ledger 是否存在、行数和内容指纹；
- 文章总数；
- 文章状态分布；
- 排除状态、但覆盖作者可编辑内容与关键元数据的文章内容指纹。

`compare` 分别报告 `schema`、`migration_ledger`、`post_count`、`post_status` 和 `post_content`。任一 drift 都输出 `state=drift`、列出 `drift_dimensions` 并返回非零，不输出参与哈希的原始行。

## 3. 外部 restored D1 request smoke

```bash
node scripts/rollout-safety.mjs request smoke \
  --database DB --local --persist-to "${RESTORED_D1_DIR}" \
  --config wrangler.toml \
  > /private/evidence/restored-request-smoke.json
```

该命令临时 bundle 当前源码并启动 Wrangler local `workerd`，通过 loopback HTTP 执行真实 `/api/search` 与 `/api/settings/appearance` route；D1 使用 Workerd 原生 `env.DB` binding，明确指向传入的外部 local-D1 persist。它不使用 Node route adapter、不创建测试 fixture、不启动默认 preview state、不访问 remote D1。smoke 前后运行同一 reconciliation capture；任何 D1 事实变化都失败。报告只记录 `runtime=workerd`、route 名、HTTP status、对账结论和报告哈希。

## 4. 候选证据

生产 migration `apply` 前使用独立的 `blogman-pre-migration-candidate/v1` 合同。它只绑定 commit、lockfile/toolchain、build、已上传但未承载流量的 Cloudflare version、备份/隔离恢复、原始 local migration verify、原始 Workerd smoke、D1 对账和测试报告；不含 deployment、production smoke、rollout 或 T0 字段。因此它只能由专用命令验证，不能被正式 `candidate verify`、`rollout set` 或 `rollout status` 当成生产候选：

```bash
node scripts/rollout-safety.mjs candidate verify-pre-migration \
  --evidence /private/evidence/pre-migration-candidate.json \
  --candidate "$(git rev-parse HEAD)" --lockfile package-lock.json \
  --build /private/evidence/open-next-build.tar \
  --version "${UPLOADED_CLOUDFLARE_VERSION_ID}" \
  --backup-report /private/evidence/backup-report.json \
  --restore-report /private/evidence/restore-report.json \
  --migration-verification-report /private/evidence/local-migration-verify.json \
  --reconciliation-report /private/evidence/local-reconciliation.json \
  --smoke-runtime-report /private/evidence/restored-request-smoke.json \
  --test-report /private/evidence/test-report.json
```

只有 `state=verified, phase=pre-migration` 才允许进入生产 apply。该格式没有可伪造的 deployment placeholder，也不能解锁 rollout control。验证器通过 migration runner 的只读 `catalog` 输出逐条交叉检查 raw verify 中的 migration number、name 和 canonical checksum；旧 verify report 不能与新的 migration set 拼接通过。

当前候选文件格式为 `blogman-rollout-candidate/v2`，绑定：

- 40 位 Git commit、lockfile/toolchain、不可变 build；
- exact Cloudflare deployment ID、version ID 和 D1 database UUID；
- migrations 001–006 的 migration-set、candidate-bound apply summary 与原始 verify report；
- 同一 backup ID 的 verify 与 isolated restore 报告；
- 最终 schema、migration ledger、文章 count/status/content 五维 D1 reconciliation；
- 原始本地 Workerd smoke 与六条真实 production critical-path smoke；
- producer、authority、各 executor 的 rollout 状态快照；
- 退出码、通过/失败计数明确的测试报告；
- `blogman-t0-acceptance/v1`，闭包绑定上述 exact identity、迁移 001–006、最终 smoke/reconciliation 和零未解决高优先级异常。

Production smoke 使用 `blogman-production-smoke/v2`，必须记录采集时间、同一 D1 UUID、同一 candidate/build/deployment/version，以及 `search`、`appearance`、`admin_article`、`tokens`、`ai_provider`、`ai_generators` 六项 HTTP 200。最终 reconciliation 使用 `blogman-d1-reconciliation-check/v2`，必须记录采集时间、同一 D1 UUID，并使 `schema`、`migration_ledger`、`post_count`、`post_status`、`post_content` 全部为 `matched`。

```json
{
  "format": "blogman-t0-acceptance/v1",
  "state": "passed",
  "accepted_at": "2026-07-26T01:00:00.000Z",
  "candidate_id": "<40 hex>",
  "build_sha256": "<64 hex>",
  "deployment_id": "<deployment id>",
  "version_id": "<version uuid>",
  "d1_database_id": "<d1 uuid>",
  "migration_numbers": [1, 2, 3, 4, 5, 6],
  "migration_report_sha256": "<64 hex>",
  "migration_verification_report_sha256": "<64 hex>",
  "smoke_report_sha256": "<64 hex>",
  "final_reconciliation_report_sha256": "<64 hex>",
  "anomaly_report_sha256": "<64 hex>"
}
```

当前验收命令为：

```bash
node scripts/rollout-safety.mjs candidate verify \
  --evidence /private/evidence/candidate.json \
  --candidate "$(git rev-parse HEAD)" \
  --lockfile package-lock.json \
  --build /private/evidence/open-next-build.zip \
  --deployment "${CLOUDFLARE_DEPLOYMENT_ID}" \
  --version "${CLOUDFLARE_VERSION_ID}" \
  --d1-database "${D1_DATABASE_ID}" \
  --backup-report /private/evidence/backup-report.json \
  --restore-report /private/evidence/restore-report.json \
  --migration-report /private/evidence/migration-report.json \
  --migration-verification-report /private/evidence/production-migration-verify.json \
  --reconciliation-report /private/evidence/reconciliation-report.json \
  --smoke-report /private/evidence/production-smoke.json \
  --smoke-runtime-report /private/evidence/restored-request-smoke.json \
  --rollout-report /private/evidence/rollout-state.json \
  --test-report /private/evidence/test-report.json \
  --t0-report /private/evidence/t0-report.json \
  --anomaly-report /private/evidence/anomaly-audit.json
```

只有 `state=verified, phase=batch-1-t0` 且输出同一 `d1_database_id` 才通过。smoke、reconciliation、anomaly 的采集时间不得晚于 `accepted_at`；允许它们与 T0 在同一时刻完成，不存在最短时长、固定观察窗口或 observation-end wait。任何 hash、migration set、内部状态、candidate/build/deployment/version/D1 交叉绑定不一致，或任一高优先级异常未解决，都会返回 `state=invalid`。

### 历史 v1 只读兼容

`blogman-rollout-candidate/v1` 与 `blogman-observation-window/v1` 的 canonical 字节和完整 24 小时规则保持不变，仅用于验证历史证据：

```bash
node scripts/rollout-safety.mjs candidate verify-historical \
  <旧 v1 candidate verify 参数，包括 observation start/end 与 anomaly 报告>
```

成功只返回 `state=verified-historical, acceptance_authority=false`。把旧 v1 交给当前 `candidate verify` 会返回非零 `state=stale, acceptance_authority=false`；因此旧证据不能被 `rollout set`、`rollout status` 或当前 reseal/authorization 入口用于解锁任何控制。历史文件不会被重写，也不会被升级为 T0 证据。

当前与历史候选及其绑定报告都使用完整必需字段合同和严格 allowlist；未知/缺失字段、错误类型或枚举、无效时间戳、敏感字段名以及任意字段中的凭据样式字符串都会被拒绝且不会回显原值。

## 5. Rollout 控制与状态

控制键只有三类：`producer`、`authority`、`executor:<name>`。状态变更写入 current control，并追加不可更新、不可删除、不可 replace 的 audit event：

```bash
node scripts/rollout-safety.mjs rollout set \
  --control authority --enabled true \
  --operation-id authority-on-20260725-001 \
  --actor release-operator --reason "batch 1 evidence complete" \
  <全部 candidate verify 参数> \
  --database DB --local --persist-to "${RESTORED_D1_DIR}" \
  --config wrangler.toml
```

相同 operation ID 与相同载荷重放返回 `unchanged`；同 ID 不同载荷失败。开启前会重新执行 candidate verify 和实际 migration `verify`，不能复用进程内缓存。停用是非对称的安全操作：candidate 或 migration 证据失效时仍可写入关闭控制和不可变 audit event，并以 `evidence_state=invalid|unavailable` 标明当时证据状态；非法或敏感的 candidate 参数不会持久化或回显，只记录安全的 `candidate_id=unavailable`。停用路径不能借此开启任何控制。

```bash
node scripts/rollout-safety.mjs rollout status \
  <全部 candidate verify 参数> \
  --database DB --local --persist-to "${RESTORED_D1_DIR}" \
  --config wrangler.toml
```

status 分别输出 producer、authority 和每个 executor 的 `desired`、`effective`、`blockers`。缺少持久控制、候选无效、migration 未验证、控制绑定旧候选或紧急关闭时 effective 都是 disabled；authority 不能由环境变量强开。

环境变量只提供紧急关闭：

- `BLOGMAN_DISABLE_PRODUCER=true`
- `BLOGMAN_DISABLE_AUTHORITY=true`
- `BLOGMAN_DISABLE_EXECUTOR_<UPPERCASE_NAME>=true`

只接受空值/`0`/`false` 或 `1`/`true`。其他非空值按 `invalid_emergency_switch` fail-closed。`BLOGMAN_ENABLE_*` 没有任何开启语义。
