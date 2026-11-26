# D1 增量迁移

Blogman 的部署和初始化只通过 `scripts/migrations.mjs` 修改 D1 schema。Runner 按编号执行 `db/ledger-migrations` 中尚未应用的 migration，并在 `migration_ledger` 保存编号、SHA-256 校验和、应用时间和候选身份。

## 接口

以下示例使用远端 D1；`--config` 应指向实际部署配置：

```bash
node scripts/migrations.mjs plan --database DB --remote --config wrangler.local.toml
node scripts/migrations.mjs status --database DB --remote --config wrangler.local.toml
node scripts/migrations.mjs verify --database DB --remote --config wrangler.local.toml
node scripts/migrations.mjs apply --database DB --remote --config wrangler.local.toml --candidate "$(git rev-parse HEAD)"
```

- `plan`：只读展示已应用项、待执行项，以及已有 current schema 是否会执行 `baseline`。
- `status`：只读展示账本是 `uninitialized`、`pending` 还是 `current`。
- `verify`：先校验账本表及不可变 trigger 的 canonical contract，再校验连续顺序、账本前缀和已应用文件校验和；存在待迁移项时返回非零。
- `apply`：先执行与 `plan` 相同的全部只读校验；每项写入前再次取得 schema 指纹，并把原子指纹 guard、必要的账本/baseline 初始化、migration SQL 和账本登记放在同一批次。检查后若受影响 schema 漂移，该批次整体回滚并立即返回非零。

本地演练必须使用隔离的 Cloudflare D1 runtime：

```bash
D1_STATE="$(mktemp -d)"
trap 'rm -r -- "${D1_STATE}"' EXIT
node scripts/migrations.mjs apply \
  --database DB \
  --local \
  --persist-to "${D1_STATE}" \
  --config wrangler.toml \
  --candidate local-check
```

## 新增 migration

1. 在 `db/ledger-migrations` 新建下一个连续三位编号文件，例如 `002_add_example.sql`。
2. 首行必须声明同一编号：`-- migration-number: 002`。
3. 只做 additive 变更，并让同一文件内的全部语句构成一个可原子提交的 migration。
4. migration 一旦在任何环境登记成功，禁止修改、改号、删除或重排；修复必须新增前向 migration。

Migration 可以带 checksum companion，以及一个仅用于 remote baseline 验证的 companion：

- `NNN_name.preflight.sql`：在该 migration 的任何写入前只读验证可兼容的已有 schema 形状；返回任意 `issue` 行都会 fail-closed。
- `NNN_name.data.mjs`：为必须使用运行时 secret、或必须先读取现有数据才能决定的一次性数据迁移生成 SQL。模块每次只能执行一条 `SELECT` / `WITH` 查询，生成的 SQL 与主 migration 及账本登记在同一批次提交。
- `NNN_name.remote.baseline.sql`：只允许 runner 内置合同按 migration 编号/名称、完整 baseline SHA、原 statement ordinal/SHA 和 replacement SHA 精确绑定。它只在 remote baseline 验证中用多个较小的只读 query 替换一个或多个已确认受 D1 remote 限制的 statement；任一身份漂移都在首次 Wrangler 调用前停止，且不得回退到原 statement。

主 SQL、baseline、preflight 与 data sidecar 都参与账本 checksum；已应用后任一文件发生变化都会被 `verify` 拒绝。`remote.baseline.sql` 不改变历史 ledger checksum。Runner 在加载 migration 时绑定全部已校验 companion 原始字节，后续不会按路径重新读取。普通 sidecar 仍逐条通过 SQLite `EXPLAIN` 拒绝持久写 opcode；唯一例外是 migration `001` baseline statements `1` 与 `3` remote replacement，原 baseline 字节、本地验证路径和其他 statement 的 opcode proof 均保持不变。两个 replacement group 的六条 query 也各自经过普通 SELECT/WITH 与 `EXPLAIN` gate，并分别要求执行前后 schema fingerprint 完全一致。直接 `PRAGMA`、写型 CTE 和多语句 data query 都会在主 migration 批次前 fail-closed。条件加列由主 SQL 中声明的受限 directive 驱动，runner 先检查真实表/列形状，再把需要的 additive `ALTER TABLE ... ADD COLUMN` 注入同一个原子批次；不得用失败重试或吞错判断 schema。

`db/migrations` 保存引入账本前的历史补丁，不是当前 runner 的输入。`001_initial_schema.sql` 是新空库的 canonical baseline；其中的初始 seed 只随空库 migration 执行一次。已有 current schema 只有在 `001_initial_schema.baseline.sql` 的 DDL 语义检查全部通过后才会被明确登记，不会重放业务 schema 或 seed。

Legacy baseline 不把 `categories`、`site_settings`、`ai_actions`、`ai_post_generators` 等可变业务行当作 schema checksum。用户已修改或删除的数据会原样保留；只有列类型、约束、索引、触发器、FTS 等不可变 DDL 事实参与 baseline 判断。

`002_add_ai_image_configuration` 收编图像 provider/action schema，兼容 absent、已知 legacy 缺列和 current-full 三种形状。legacy 的 `size` / `quality` 能映射时优先保留实际值，只有 `auto` 或未知值才按已知内置 `action_key` 使用 canonical fallback；其他作者字段不覆盖，已存在表也不会恢复被删除的默认 action。

`003_migrate_runtime_ai_configuration` 一次性完成旧 AI 配置加密迁移、已知 generator prompt 升级、空缺 built-in 字段补全、默认 profile 与当时已有列的 NULL 引用回填。它不恢复作者删除的 generator，不覆盖自定义非空 prompt/label/description，也保留合法的 generator 数值边界（`temperature` 0–2、`max_tokens` 1–32768），只修复可确定的无效值。它不删除 legacy settings。只有在尚无 provider profile 且存在 legacy config 时才要求 secret：优先 `AI_CONFIG_ENCRYPTION_SECRET`，兼容回退到 `ADMIN_TOKEN_SALT`，所选值必须至少 32 字符；无效 JSON、短值或全缺都会 fail-closed，绝不使用硬编码 secret。

`004_complete_historical_text_ai_schema` 收编旧请求期 `ai_actions.profile_id` 补列与 NULL 引用回填。建账前会对 A/B/C base identity 做同一套只读审计：A 是 `schema.sql` 产生的 `profile_id` 位于 timestamps 前且 provider `DEFAULT 2000`；B 是历史迁移产生的无 `profile_id` 且 `DEFAULT 1200`；C 是旧 ensure 在 B 上追加 `profile_id`，因此该列位于 timestamps 后。三者都只允许无约束的普通尾部扩展列（`NOT NULL` 扩展列必须有非 NULL default），并拒绝目标表的列序/类型/default/约束、FK、generated/hidden、STRICT/WITHOUT ROWID、附着索引或 trigger 漂移；无关表和对象不受影响。历史表的 1200 default 保留以避免重建，作者已有 profile/action 行和非 NULL 引用不覆盖；应用 CRUD 始终显式写入 `max_tokens`，省略时使用 2000。缺列却为 2000 或其他非仓库产物均在创建 ledger 前 fail-closed。

`005_fix_posts_fts_sync` 前向替换 canonical `posts_au` / `posts_ad` trigger。更新时先用 FTS5 external-content 的特殊 `delete` 行移除旧 token，再写入新 token；删除时只移除旧 token。文章行不重建、不覆盖，完整 canonical ledger schema 因而支持真实文章 CRUD 并保持搜索索引一致。

`006_add_rollout_safety_controls` 新增 `rollout_controls` 当前控制事实与 `rollout_control_events` 不可变审计事件。它不 seed producer、authority 或 executor 的开启状态；缺少控制行时一律视为关闭。该迁移已登记，不能修改或删除；这两张表的去留由后续前向迁移决定。

`008_canonical_article_schema` 把规范文章 schema 收编进账本：文章身份与版本、正式发布、Slug 地址注册表、生命周期、发布修订与建议、排期、工作台与通知、源稿、微信草稿、邮件提醒以及 `article_fts`。这些对象此前由已退役的 `scripts/apply-*-ddl.mjs` 在账本外创建；语句文本取自生产 `sqlite_schema` 原文并加 `IF NOT EXISTS`。preflight 对每个已存在的同名对象要求存储的 SQL 逐字一致，否则在任何写入前失败；因此已有库保持原样，新库得到与生产相同的 schema。

`009_retire_posts_projection` 退役 `posts` / `posts_fts` 兼容投影及其 trigger（ADR 0008）。data sidecar 在 `posts` 仍有任何行缺少 `articles.post_ref` 对应时失败关闭，并在同一批次用 guard 复查，因此不会丢弃尚未迁移的旧内容；`posts` 不存在时为空操作。

`010_align_schedule_and_wechat_tables` 修正旁路 DDL 留下的两处原地未升级：`CREATE TABLE IF NOT EXISTS` 不会改动已存在的表，所以生产的 `publish_schedules` 状态 CHECK 缺少排期控制命令写入的 `paused`，`wechat_draft_tasks` 缺少 B5-02/B5-03 的重试与代次列。`publish_schedules` 因 SQLite 不能修改 CHECK 而重建（保留全部行、id 与到期索引），preflight 只接受 008 记录的原形状；微信列用条件加列指令补齐。

D1 备份与恢复使用 Cloudflare D1 Time Travel（`wrangler d1 time-travel info` / `wrangler d1 time-travel restore`）。恢复会覆盖整个数据库；新事实出现后优先前向修复，不用旧时间点覆盖。

应用账本后，真实请求路径不得执行 DDL、schema ensure、默认 seed 或 migration runner。缺表/缺列统一归类为 `DATABASE_MIGRATION_REQUIRED`，API 返回固定 503；修复只能新增下一条前向 migration。

Provider 的 POST、PUT、DELETE 属于显式业务命令。每次 text/image profile 写入、默认项选择、action 引用和 post generator 引用对账必须通过同一个 D1 `batch` 原子提交；任一对账语句失败时整组 profile/default/reference 写入全部回滚。GET、resolve 与其他读取路径不得承担这些补偿写入。

## 失败与回退

所有命令都会在读取账本记录前验证 `migration_ledger` 的 STRICT table contract，以及 `migration_ledger_no_update`、`migration_ledger_no_delete`、`migration_ledger_no_replace` 的精确定义。第三个 guard 会在 INSERT 与既有编号或名称冲突时拒绝写入，避免 `INSERT OR REPLACE` 绕过 UPDATE/DELETE 保护。已有账本缺少保护或出现同名篡改时会直接失败，不会静默重建或修补。

失败 migration 不会登记成功，后续 migration 和部署都不会继续。修复方式是保留账本及所有已成功的 additive 事实，新增或修正尚未应用的前向 migration 后重试。不得 down migration、删除账本或回写已应用记录。
