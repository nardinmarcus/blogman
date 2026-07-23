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
- `apply`：先执行全部校验，再逐项原子执行 migration SQL 和账本登记；任一失败立即返回非零。

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

`db/migrations` 保存引入账本前的历史补丁，不是当前 runner 的输入。`001_initial_schema.sql` 是新空库的 canonical baseline；其中的初始 seed 只随空库 migration 执行一次。已有 current schema 只有在 `001_initial_schema.baseline.sql` 的 DDL 语义检查全部通过后才会被明确登记，不会重放业务 schema 或 seed。

Legacy baseline 不把 `categories`、`site_settings`、`ai_actions`、`ai_post_generators` 等可变业务行当作 schema checksum。用户已修改或删除的数据会原样保留；只有列类型、约束、索引、触发器、FTS 等不可变 DDL 事实参与 baseline 判断。

## 失败与回退

所有命令都会在读取账本记录前验证 `migration_ledger` 的 STRICT table contract，以及 `migration_ledger_no_update`、`migration_ledger_no_delete`、`migration_ledger_no_replace` 的精确定义。第三个 guard 会在 INSERT 与既有编号或名称冲突时拒绝写入，避免 `INSERT OR REPLACE` 绕过 UPDATE/DELETE 保护。已有账本缺少保护或出现同名篡改时会直接失败，不会静默重建或修补。

失败 migration 不会登记成功，后续 migration 和部署都不会继续。修复方式是保留账本及所有已成功的 additive 事实，新增或修正尚未应用的前向 migration 后重试。不得 down migration、删除账本或回写已应用记录。
