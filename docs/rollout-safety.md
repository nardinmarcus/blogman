# Rollout safety

`scripts/rollout-safety.mjs` 提供 Blogman 的备份恢复、D1 对账、restored-D1 request smoke 与 rollout control 只读状态接口。Issue #23 新交付的 Stage 顺序由 `prepare(config)` / `execute(manifest, authorization)` 深模块拥有；本工具不再是生产顺序控制面，也不再接受 candidate、pre-migration candidate 或 control mutation 命令。所有命令以 JSON 输出脱敏报告；失败返回非零。正文、HTML、token、密码、Bridge 凭证、AI key 和原始外部响应不得进入报告。

## 安全边界

- Issue #23 当前唯一生产入口是 `execute(manifest, authorization)`。Canonical Frozen Manifest 固定正式 entry、私有 Worker upload entry、D1/Worker/Smoke adapters、十个 Stage 与硬超时；Authorization 在入口消耗，首个非 PASS 立即停止 suffix。operator 不得用本工具拼装、跳过、重排或重试 Stage。
- `backup restore` 和 `request smoke` 只接受 `--local`，必须显式指定仓库外的绝对 `--persist-to` 空目录，绝不回退到默认 `.wrangler/state`。
- `reconcile capture|compare` 支持显式 local D1，也为经授权的未来 production read-only 对账保留 `--remote` 接口；普通本地验收只使用 `--local`。
- 旧备份不能恢复到已有文件的 persist 目录。新事实出现后必须保留现有事实并前向修复，不能用旧备份覆盖、down migration 或清空新表。
- Cloudflare D1 不支持导出包含 FTS5 virtual table 的数据库。备份包可按恢复顺序列出多个 SQL artifact，例如常规表导出和候选绑定的 FTS/index/trigger 重建脚本；每个 artifact 都必须有字节数和 SHA-256。

### 历史保存路径：私有生产导出封装

本节保留旧候选证据的只读验证和其他获准保存数据的操作能力。Issue #23 当前 clean-start 密封包必须把生产导出、双隔离恢复和历史 baseline query 全部绑定为 `NOT_APPLICABLE`，不得从当前序列进入本节命令。

生产 D1 导出只能通过一次性私有封装执行，禁止直接运行 `wrangler d1 export` 或继承父进程 stdio：

```bash
node scripts/rollout-safety.mjs backup export \
  --run-root /private/evidence/export-candidate-successor-1 \
  --database DB --remote --config /private/wrangler.toml \
  > /private/evidence/reports/export-report.json
```

`--run-root` 必须是仓库外尚不存在的绝对路径。命令在启动 Wrangler 前原子创建 mode `0700` 的 run root，并固定七张普通表；已存在的 root 一律拒绝，失败后也不能删除或复用它来重试。Wrangler stdout/stderr 直接写入 root 内 `0600` 文件描述符；`WRANGLER_LOG_PATH` 也被强制覆盖为同一私有目录内预建的 `0600` debug 文件，因此三种原始输出都不会进入父进程内存、终端、工具输出或 Wrangler 默认日志位置，并在成功或失败时统一覆盖删除。导出子进程有不可放宽的 300 秒上限，超时会被终止且不会重试。命令还要求 SQL 非空、权限精确为 `0600`，并用私有临时 SQLite 校验 SQL 可执行、普通表集合精确匹配、列名集合及 `type/notnull/default/pk/hidden` 语义精确匹配，只允许冻结的 Issue #21 text-AI A/B/C 变体（`ai_actions.profile_id` 的位置/存在性与获准的 `max_tokens` 默认值配对）。这里不宣称覆盖全部 UNIQUE/FK/CHECK/index 约束；后续 candidate migration plan 仍是这些冻结兼容规则的权威。成功只输出 `blogman-d1-private-export/v1` 脱敏 JSON；子进程失败/超时、空/畸形 SQL、权限或 schema 不符时只保留 `attempt_count=1` 的脱敏失败报告，并立即覆盖删除原始 SQL。私有目录的清理与销毁按实际递归枚举结果执行并复查为空，包括未知 debug 文件和 SQLite sidecar，而不是依赖固定文件名清单。

成功的 SQL 只在获准的隔离审计生命周期内保留。生命周期结束时必须显式调用：

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

## 4. Rollout control 只读状态

`rollout_controls` 是 migration 006 留下的历史控制事实。当前 execute 只读取它们；没有控制行或值为 `0` 均解释为 disabled。命令不接受 candidate evidence，不写 D1，也不能开启、关闭或重绑定控制：

```bash
node scripts/rollout-safety.mjs rollout controls-status \
  --database DB --remote --config wrangler.toml
```

返回值只包含 producer、authority 与 executor 的 enabled/disabled 状态。`BLOGMAN_DISABLE_*` 仍只能把已有 enabled 状态紧急解释为 disabled；非法值 fail-closed，任何环境变量都不能开启控制。旧 `candidate verify*`、`rollout set` 与 `rollout status` 已退役，不是兼容入口。

历史 candidate、pre-migration、reseal 和 v1–v7 证据只能由 [`issue-23-history-audit.md`](./issue-23-history-audit.md) 的独立只读适配器审计；审计结果没有 acceptance authority，不能进入 `prepare`、`execute`、Authorization 或 Terminal Result。
