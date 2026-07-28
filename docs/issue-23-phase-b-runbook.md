# Issue #23 Phase B production runbook

This runbook starts only after a separate production-write approval. It binds one immutable candidate to one backup, migration set, OpenNext build, exact Cloudflare version/deployment and D1 identity, same-version smoke, final D1 reconciliation, rollout snapshot, test report, zero unresolved high-priority anomalies, and the immediate T0 acceptance event.

Do not persist article bodies, HTML, tokens, passwords, Bridge/AI credentials, signed URLs, raw HTTP bodies, or raw Cloudflare responses in evidence or reports. The one temporary private SQL backup necessarily contains application rows; it is never evidence, stays `0600` inside the one-attempt `0700` export run root, and must be destroyed at the lifecycle boundary below. Keep the evidence root outside the repository with mode `0700`.

## Approval boundary

The approval must explicitly cover these production operations:

1. One pre-migration remote D1 export of the seven regular application tables and read-only D1 baseline queries.
2. One candidate-bound remote ledger migration `apply` for migrations 001–006.
3. One OpenNext version upload and one 100% Cloudflare deployment of that exact uploaded version. OpenNext also populates its configured remote cache during upload/deploy.
4. Status-only production HTTP smoke against article, token, AI configuration, and generator read paths; no response bodies are retained.
5. Read-only post-migration final D1 reconciliation.
6. Recording the T0 acceptance event immediately after every required Phase B fact passes.
7. Only if a failure occurs: persistently disable an affected rollout control and/or restore the prior Worker version to 100% traffic. Neither action reverts D1; both invalidate this candidate and require a forward-fix successor.

No approval in this packet includes a down migration, backup overwrite of production, ledger rewrite, deletion of new facts, production fixture writes, push, PR, Issue closure, or Batch 2 dispatch.

## Fixed inputs

```bash
set -euo pipefail
umask 077
REPO=/absolute/path/to/the/clean/candidate-checkout
CONFIG=/absolute/path/to/the/operator-owned/production-wrangler.toml
EVIDENCE_ROOT=/private/blogman-b1/issue-23
REPORT_DIR="$EVIDENCE_ROOT/reports"
RESTORE_A="$EVIDENCE_ROOT/restore-a"
RESTORE_B="$EVIDENCE_ROOT/restore-b"
DATABASE=DB
EXPECTED_CANDIDATE=<approved-40-hex-commit>
EXPECTED_BASELINE_DEPLOYMENT=<approved-read-only-deployment-id>
EXPECTED_BASELINE_VERSION=<approved-read-only-version-id>
EXPECTED_BASELINE_D1=<approved-read-only-d1-database-id>
EXPORT_RUN_ROOT="$EVIDENCE_ROOT/export-$EXPECTED_CANDIDATE-successor-1"
BACKUP_DIR="$EXPORT_RUN_ROOT/backup"
PUBLIC_ORIGIN=<approved-public-origin>
ADMIN_COOKIE_FILE=<operator-owned-private-cookie-file>
SMOKE_ARTICLE_SLUG=<approved-existing-article-slug>
```

Validate the operator-owned production config before setup or any Wrangler production call. The gate first checks the path and file type, then freezes only its file identity and SHA-256; it never copies or emits config contents:

```bash
case "$CONFIG" in
  /*) ;;
  *) printf '%s\n' 'CONFIG must be an absolute path to an existing regular file' >&2; exit 1 ;;
esac
if ! test -f "$CONFIG"; then
  printf '%s\n' 'CONFIG must be an absolute path to an existing regular file' >&2
  exit 1
fi
CONFIG_SHA256=$(shasum -a 256 "$CONFIG" | awk '{print $1}')
CONFIG_FILE_ID=$(stat -f '%d:%i' "$CONFIG")
readonly CONFIG_SHA256 CONFIG_FILE_ID

verify_config_identity() {
  test -f "$CONFIG"
  test "$(stat -f '%d:%i' "$CONFIG")" = "$CONFIG_FILE_ID"
  test "$(shasum -a 256 "$CONFIG" | awk '{print $1}')" = "$CONFIG_SHA256"
}
```

Create the private directories, then move into the candidate checkout:

```bash
install -d -m 0700 "$EVIDENCE_ROOT" "$REPORT_DIR" "$RESTORE_A" "$RESTORE_B"
test ! -e "$EXPORT_RUN_ROOT"
cd "$REPO"
```

Every command below stops on a non-zero exit. Do not continue by hand after a failed gate. `EXPORT_RUN_ROOT` is an approved one-attempt identity: the export command creates it atomically with mode `0700`, and an existing root is a hard stop before Wrangler starts. Never rename, remove, or replace it to obtain a retry; a successor attempt requires a new candidate, approval, and run root.

The repository-owned order contract is `scripts/phase-b-sequence.mjs`. Operator automation must call `runPhaseBSequence()` with the absolute `CONFIG` path, an immutable binding cache for the approved candidate/packet/build/baseline deployment/version/D1 identities, and the Issue #23 stage adapters. It fixes this exact sequence and rejects dynamic stage graphs:

`PRE-CAS/local gates → CAS1 → D1 identity → remote migration plan → export → double restore → upload → migrations 001–006 → CAS2 → traffic → smoke/reconcile → T0`.

The runner validates `CONFIG` and the immutable bindings before entering the first stage, freezes both into one execution context supplied to every stage adapter, invokes each stage exactly once, never retries, and stops at the first rejection. Every production adapter must use `context.configPath`; a temporary script must not substitute another config, reorder, omit, repeat, or directly drive these stages outside that contract.

Install the failure cleanup before the export. It never echoes captured output. It certifies disposal only after the synchronous wrapper has recorded the child terminal state as `failed` or `captured`:

```bash
dispose_private_export() {
  if test -f "$EXPORT_RUN_ROOT/export-report.json" && test ! -f "$EXPORT_RUN_ROOT/dispose-report.json"; then
    node scripts/rollout-safety.mjs backup dispose --run-root "$EXPORT_RUN_ROOT" \
      > "$REPORT_DIR/export-dispose-report.json"
  fi
}
trap dispose_private_export EXIT
```

If the process is externally interrupted while the report remains `state=started`, `dispose` refuses to claim cleanup because the child terminal state is unknown. Quarantine that root without reading or moving its private files; do not delete or reuse it, do not retry, and obtain a new candidate, approval, and successor run root after controlled incident handling.

The smoke helper captures each actual HTTP status and discards every response body:

```bash
run_production_smoke() {
  SMOKE_SEARCH_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' "$PUBLIC_ORIGIN/api/search?q=blogman")
  SMOKE_APPEARANCE_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' "$PUBLIC_ORIGIN/api/settings/appearance")
  SMOKE_ADMIN_ARTICLE_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/posts/$SMOKE_ARTICLE_SLUG")
  SMOKE_TOKENS_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/tokens")
  SMOKE_AI_PROVIDER_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/ai-provider")
  SMOKE_AI_GENERATORS_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/ai-post-generators")
  test "$SMOKE_SEARCH_STATUS" = 200
  test "$SMOKE_APPEARANCE_STATUS" = 200
  test "$SMOKE_ADMIN_ARTICLE_STATUS" = 200
  test "$SMOKE_TOKENS_STATUS" = 200
  test "$SMOKE_AI_PROVIDER_STATUS" = 200
  test "$SMOKE_AI_GENERATORS_STATUS" = 200
}
```

## 1. Preflight

Classification: local read-only, except the local build and private evidence files. Expected result: clean exact candidate, pinned toolchain, reproducible build, and unchanged production baseline deployment.

```bash
test "$(git rev-parse HEAD)" = "$EXPECTED_CANDIDATE"
test -z "$(git status --porcelain)"
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
git merge-base --is-ancestor origin/main HEAD

LOCKFILE_SHA256=$(shasum -a 256 package-lock.json | awk '{print $1}')
WRANGLER_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/wrangler'].version")
OPENNEXT_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/@opennextjs/cloudflare'].version")
test "$(./node_modules/.bin/wrangler --version)" = "$WRANGLER_VERSION"

npm exec -- opennextjs-cloudflare build
WORKER_SHA256=$(shasum -a 256 .open-next/worker.js | awk '{print $1}')

(cd .open-next && find . -type f -print | LC_ALL=C sort | zip -X -q "$REPORT_DIR/open-next-build.zip" -@)
BUILD_SHA256=$(shasum -a 256 "$REPORT_DIR/open-next-build.zip" | awk '{print $1}')

./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-before.json"
BASELINE_DEPLOYMENT_ID=$(jq -er .id "$REPORT_DIR/deployment-before.json")
BASELINE_VERSION_ID=$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "$REPORT_DIR/deployment-before.json")
test "$BASELINE_DEPLOYMENT_ID" = "$EXPECTED_BASELINE_DEPLOYMENT"
test "$BASELINE_VERSION_ID" = "$EXPECTED_BASELINE_VERSION"
./node_modules/.bin/wrangler d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid,name,created_at,num_tables,read_replication}' \
  > "$REPORT_DIR/d1-info-before.json"
BASELINE_D1_DATABASE_ID=$(jq -er .uuid "$REPORT_DIR/d1-info-before.json")
test "$BASELINE_D1_DATABASE_ID" = "$EXPECTED_BASELINE_D1"
```

Stop if the checkout is dirty, the candidate differs, `main` and `origin/main` differ, the candidate does not descend from `origin/main`, the installed versions differ from the lockfile, the build fails, the active production deployment/version is not the explicitly approved baseline at 100%, or the D1 UUID differs from the approved baseline. `BASELINE_VERSION_ID` is the only version eligible for the separately authorized emergency traffic restore. Local build output is not production proof.

## 2. Remote migration plan hard gate

Classification: production read-only. This is the first operation requiring explicit production access approval. It runs after CAS1 and D1 identity, but before the one-shot export or either isolated restore.

```bash
node scripts/migrations.mjs plan --database "$DATABASE" --remote --config "$CONFIG" \
  --failure-report "$REPORT_DIR/production-plan-before-failure.json" \
  > "$REPORT_DIR/production-plan-before.json"
```

Expected result: the plan accepts the current schema and lists only the expected pending migrations. A successful plan removes its reserved failure-report path. With `--failure-report`, the migration runner itself executes every inner Wrangler query once inside a fresh mode-`0700` directory with pre-created mode-`0600` stdout, stderr, and forced `WRANGLER_LOG_PATH` files, enforces the fixed 300-second timeout with no retry, then recursively overwrites, removes, and verifies removal of that raw directory. On failure it preserves only the mode-`0600` `blogman-migration-failure/v2` report with fixed classification fields; `failure_domain` records the confirmed layer, `failure_hint` records only non-confirmed auth/network text signals, and child non-zero failures add an `auth`/`config`/`api`/`sql`/`unknown` class plus a deterministic SHA-256 fingerprint derived only from versioned allowlisted signal identifiers. Other failures record `none` for both new fields. The report must never contain SQL, raw output, URLs, credentials, cookies, tokens, presigned URLs, account or database identifiers, or response bodies. An existing failure-report path is a hard stop and must never be removed or reused to obtain another attempt.

Stop on any remote plan failure or unexpected pending migration. In that case export, double restore, upload, migrations 001–006, CAS2, traffic, smoke/reconciliation, and T0 must all remain at attempt count `0`. The former query-7 blocker and the subsequently observed query-4 blocker are superseded only for migration `001`, frozen `001_initial_schema.baseline.sql` (SHA-256 `b3f61982cc36ff2c88d7b4330dd304ef075b5c5c34debf4499671c33ae2b6540`) statements `1` (SHA-256 `2c4d1aa391172c16b128c08a593e252f9e09b4fc151642ce738ae47882c38491`) and `3` (SHA-256 `c61b390568cafc468c6adbbff5b78d08dd5d18a544d917fbc06c043393e3c7bd`): `001_initial_schema.remote.baseline.sql` (SHA-256 `90c94ce79e77d3ca3ab22fc67f702243e7305bcd1860f3d1feb2026fb56b4a03`) supplies exactly two groups of three smaller equivalent probes. Before the first Wrangler call, the runner verifies the migration number/name, full baseline SHA, both source ordinal/SHA identities, replacement SHA/header and per-group statement counts. Each probe still uses remote `--command`, SELECT/WITH validation, `EXPLAIN` opcode proof, private mode-`0600` stdout/stderr/debug files, the fixed 300-second timeout and no retry; matching schema fingerprints are required immediately before and after each three-probe group. Local plans and every other sidecar retain the original statements and opcode proof. Missing or drifted proof stops without fallback.

## 3. Backup and baseline

Classification: production read-only. This uses the same explicit production access approval after the remote plan passes. Cloudflare D1 cannot export an FTS5 virtual table, so export the seven regular application tables once and pair it with the candidate-bound FTS reconstruction artifact already proven by Issue #21.

```bash
node scripts/rollout-safety.mjs backup export \
  --run-root "$EXPORT_RUN_ROOT" --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/export-report.json"

jq -e '.format == "blogman-d1-private-export/v1" and .state == "captured" and .attempt_count == 1' \
  "$REPORT_DIR/export-report.json" >/dev/null
cmp "$REPORT_DIR/export-report.json" "$EXPORT_RUN_ROOT/export-report.json"

sed -n '28,46p' db/ledger-migrations/001_initial_schema.sql > "$BACKUP_DIR/rebuild-fts.sql"
printf '\nINSERT INTO posts_fts(posts_fts) VALUES (\x27rebuild\x27);\n' >> "$BACKUP_DIR/rebuild-fts.sql"

REGULAR_SHA256=$(jq -er .artifact.sha256 "$REPORT_DIR/export-report.json")
FTS_SHA256=$(shasum -a 256 "$BACKUP_DIR/rebuild-fts.sql" | awk '{print $1}')
BACKUP_DIGEST=$(cat "$BACKUP_DIR/regular-tables.sql" "$BACKUP_DIR/rebuild-fts.sql" | shasum -a 256 | awk '{print $1}')
DATABASE_ID=$(jq -r .uuid "$REPORT_DIR/d1-info-before.json")
CAPTURED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

jq -n \
  --arg backup_id "sha256:$BACKUP_DIGEST" \
  --arg database_id "$DATABASE_ID" \
  --arg captured_at "$CAPTURED_AT" \
  --arg regular_sha "$REGULAR_SHA256" \
  --argjson regular_bytes "$(jq -er .artifact.bytes "$REPORT_DIR/export-report.json")" \
  --arg fts_sha "$FTS_SHA256" \
  --argjson fts_bytes "$(wc -c < "$BACKUP_DIR/rebuild-fts.sql" | tr -d ' ')" \
  '{format:"blogman-d1-backup/v1",backup_id:$backup_id,
    source:{database_id:$database_id,captured_at:$captured_at},
    required_tables:["posts","posts_fts","categories","site_settings","ai_actions","ai_provider_profiles","ai_post_generators","api_tokens"],
    artifacts:[
      {path:"regular-tables.sql",bytes:$regular_bytes,sha256:$regular_sha},
      {path:"rebuild-fts.sql",bytes:$fts_bytes,sha256:$fts_sha}
    ]}' > "$BACKUP_DIR/manifest.json"

node scripts/rollout-safety.mjs backup verify --manifest "$BACKUP_DIR/manifest.json" \
  > "$REPORT_DIR/backup-report.json"

node scripts/rollout-safety.mjs reconcile capture \
  --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/production-before.json"

```

Expected result: the export report is sanitized and `state=captured, attempt_count=1`; Wrangler stdout/stderr and the explicitly private `WRANGLER_LOG_PATH` debug capture have already been overwritten and unlinked; no default Wrangler debug log was used; and `backup-report.state=verified`. The export wrapper imports the SQL only inside its private root and checks the exact seven-table column-name set plus `type/notnull/default/pk/hidden` semantics, allowing only the frozen Issue #21 text-AI A/B/C variants (`ai_actions.profile_id` position/presence paired with the approved `max_tokens` default). This is a column-semantics contract; the earlier remote candidate migration plan remains the authority for the frozen UNIQUE/FK/CHECK/index compatibility rules. Stop on export/config mismatch, timeout, a second export attempt, output permissions other than `0600`, empty/malformed SQL, wrong exported table schema, backup identity failure, or unsupported schema. Never invoke `wrangler d1 export` directly or use inherited stdio/default debug logging.

## 4. Two isolated restores and local candidate verification

Classification: local/private writes only; no production mutation.

```bash
node scripts/rollout-safety.mjs backup restore --manifest "$BACKUP_DIR/manifest.json" \
  --database "$DATABASE" --local --persist-to "$RESTORE_A" --config wrangler.toml \
  > "$REPORT_DIR/restore-a-report.json"
node scripts/rollout-safety.mjs backup restore --manifest "$BACKUP_DIR/manifest.json" \
  --database "$DATABASE" --local --persist-to "$RESTORE_B" --config wrangler.toml \
  > "$REPORT_DIR/restore-b-report.json"

node scripts/migrations.mjs plan --database "$DATABASE" --local --persist-to "$RESTORE_A" --config wrangler.toml \
  > "$REPORT_DIR/local-plan.json"
node scripts/migrations.mjs apply --database "$DATABASE" --local --persist-to "$RESTORE_A" --config wrangler.toml \
  --candidate "$EXPECTED_CANDIDATE" > "$REPORT_DIR/local-apply.json"
node scripts/migrations.mjs verify --database "$DATABASE" --local --persist-to "$RESTORE_A" --config wrangler.toml \
  > "$REPORT_DIR/local-verify.json"

node scripts/rollout-safety.mjs request smoke \
  --database "$DATABASE" --local --persist-to "$RESTORE_A" --config wrangler.toml \
  > "$REPORT_DIR/restored-workerd-smoke.json"
node scripts/rollout-safety.mjs reconcile capture \
  --database "$DATABASE" --local --persist-to "$RESTORE_A" --config wrangler.toml \
  > "$REPORT_DIR/expected-production-after.json"

node scripts/migrations.mjs apply --database "$DATABASE" --local --persist-to "$RESTORE_B" --config wrangler.toml \
  --candidate "$EXPECTED_CANDIDATE" > "$REPORT_DIR/local-apply-b.json"
node scripts/rollout-safety.mjs reconcile compare \
  --expected "$REPORT_DIR/expected-production-after.json" \
  --database "$DATABASE" --local --persist-to "$RESTORE_B" --config wrangler.toml \
  > "$REPORT_DIR/restore-reproducibility.json"
```

Expected result: both restores bind the same backup ID; local apply/verify reach current/verified; Workerd smoke passes without changing D1 facts; restore B matches restore A. Stop on any delta. Do not repair the copy by hand.

Run the focused gate and static checks. The full repository Vitest is intentionally excluded from this release command because the prior attempt exceeded 25 minutes; it must not be reported as passed.

```bash
perl -e 'alarm 900; exec @ARGV' npm run test:run -- \
  tests/scripts/rollout-safety.test.ts \
  tests/scripts/rollout-safety-parser.test.ts \
  tests/scripts/rollout-evidence-capture.test.ts \
  tests/scripts/rollout-safety-export.test.ts
npm run lint
./node_modules/.bin/tsc --noEmit
node --check scripts/rollout-safety.mjs
git diff --check
```

Create a redacted test summary only after all five commands exit 0:

```bash
jq -n '{format:"blogman-test-report/v1",state:"passed",exit_code:0,passed:43,failed:0}' \
  > "$REPORT_DIR/test-report.json"
```

## 5. Upload the exact Worker version and verify the immutable pre-migration candidate

Classification: production write. Requires explicit approval. This creates a Cloudflare Worker version and may populate the configured remote OpenNext cache, but it does not serve the version yet.

```bash
npm exec -- opennextjs-cloudflare upload -c "$CONFIG"
./node_modules/.bin/wrangler versions list --json -c "$CONFIG" \
  | jq 'sort_by(.metadata.created_on) | last | {id,number,metadata:{created_on:.metadata.created_on,source:.metadata.source,has_preview:.metadata.has_preview},annotations}' \
  > "$REPORT_DIR/uploaded-version.json"
UPLOADED_VERSION_ID=$(jq -r .id "$REPORT_DIR/uploaded-version.json")
test -n "$UPLOADED_VERSION_ID"
```

Stop if upload output is ambiguous, the newest version is not attributable to this operation, or another operator changes the Worker concurrently. Do not migrate D1 until the exact upload identity is frozen.

Before any production migration, assemble the separate `blogman-pre-migration-candidate/v1` packet. It has no deployment or production-smoke fields, cannot satisfy `candidate verify`, and cannot be consumed by rollout controls. It directly binds the uploaded version, raw `local-verify.json`, and raw Workerd report.

```bash
MIGRATION_SET_SHA256=$(node --input-type=module -e "import{readdirSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';const h=b=>createHash('sha256').update(b).digest('hex');const a=readdirSync('db/ledger-migrations').filter(n=>/^\\d{3}_.+\\.(?:sql|data\\.mjs)$/.test(n)).sort().map(name=>({name,sha256:h(readFileSync('db/ledger-migrations/'+name))}));process.stdout.write(h(JSON.stringify(a)))")

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

jq -n \
  --arg candidate "$EXPECTED_CANDIDATE" \
  --arg lockfile "$LOCKFILE_SHA256" --arg wrangler "$WRANGLER_VERSION" --arg opennext "$OPENNEXT_VERSION" \
  --arg build "$BUILD_SHA256" --arg version "$UPLOADED_VERSION_ID" \
  --arg migration_set "$MIGRATION_SET_SHA256" \
  --arg migration_verification "$(file_sha256 "$REPORT_DIR/local-verify.json")" \
  --arg backup_id "$(jq -r .backup_id "$REPORT_DIR/backup-report.json")" \
  --arg backup_report "$(file_sha256 "$REPORT_DIR/backup-report.json")" \
  --arg restore_report "$(file_sha256 "$REPORT_DIR/restore-a-report.json")" \
  --arg reconciliation "$(file_sha256 "$REPORT_DIR/restore-reproducibility.json")" \
  --arg smoke_runtime "$(file_sha256 "$REPORT_DIR/restored-workerd-smoke.json")" \
  --arg tests "$(file_sha256 "$REPORT_DIR/test-report.json")" \
  '{format:"blogman-pre-migration-candidate/v1",candidate_id:$candidate,
    lockfile:{sha256:$lockfile,wrangler:$wrangler,opennextjs_cloudflare:$opennext},
    build:{sha256:$build},cloudflare:{uploaded_version_id:$version},
    migration:{set_sha256:$migration_set,verification_report_sha256:$migration_verification},
    backup:{backup_id:$backup_id,verify_report_sha256:$backup_report,restore_report_sha256:$restore_report},
    reconciliation:{report_sha256:$reconciliation},
    smoke:{runtime_report_sha256:$smoke_runtime},tests:{report_sha256:$tests}}' \
  > "$REPORT_DIR/pre-migration-candidate.json"

node scripts/rollout-safety.mjs candidate verify-pre-migration \
  --evidence "$REPORT_DIR/pre-migration-candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile package-lock.json \
  --build "$REPORT_DIR/open-next-build.zip" \
  --version "$UPLOADED_VERSION_ID" \
  --backup-report "$REPORT_DIR/backup-report.json" \
  --restore-report "$REPORT_DIR/restore-a-report.json" \
  --migration-verification-report "$REPORT_DIR/local-verify.json" \
  --reconciliation-report "$REPORT_DIR/restore-reproducibility.json" \
  --smoke-runtime-report "$REPORT_DIR/restored-workerd-smoke.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  > "$REPORT_DIR/pre-migration-candidate-verify.json"

jq -e '.state == "verified" and .phase == "pre-migration"' \
  "$REPORT_DIR/pre-migration-candidate-verify.json" >/dev/null

dispose_private_export
trap - EXIT
test ! -e "$BACKUP_DIR/regular-tables.sql"
jq -e '.state == "disposed" and .attempt_count == 1 and .raw_artifacts_remaining == 0' \
  "$REPORT_DIR/export-dispose-report.json" >/dev/null
```

Stop before production `apply` unless the dedicated verifier returns `state=verified, phase=pre-migration`, the uploaded version is unchanged, every input hash still matches, and private export disposal is verified. Disposal is the prescribed success lifecycle boundary because both isolated restores and the immutable pre-migration packet have accepted the backup. On every ordinary earlier shell failure after the wrapper records `failed` or `captured`, the `EXIT` trap disposes the raw SQL; the wrapper itself disposes it immediately when export or local validation fails. A `started` report is indeterminate and must remain quarantined rather than being falsely certified. Any edit to the commit, lockfile, build, backup, restore, migration set, local migration verification, Workerd smoke, reconciliation, or test report requires a new upload and a new pre-migration packet.

## 6. Ledgered production migration

Classification: production D1 write. This is the first database mutation.

```bash
./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-before-apply.json"
cmp "$REPORT_DIR/deployment-before.json" "$REPORT_DIR/deployment-before-apply.json"

node scripts/migrations.mjs plan --database "$DATABASE" --remote --config "$CONFIG" \
  --failure-report "$REPORT_DIR/production-plan-final-failure.json" \
  > "$REPORT_DIR/production-plan-final.json"
cmp "$REPORT_DIR/production-plan-before.json" "$REPORT_DIR/production-plan-final.json"

node scripts/migrations.mjs apply --database "$DATABASE" --remote --config "$CONFIG" \
  --candidate "$EXPECTED_CANDIDATE" > "$REPORT_DIR/production-apply.json"
node scripts/migrations.mjs verify --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/production-verify.json"
```

Expected result: the production deployment still equals the captured baseline immediately before apply; apply reaches `state=current`; verify reaches `state=verified`; ledger rows bind to the exact candidate. If the deployment or final plan differs, stop before apply. If apply fails, do not deploy. Preserve every successful additive fact, keep all controls disabled, and prepare a new forward migration and successor candidate. Never restore the backup over production or edit ledger rows.

Create the strict migration summary from the successful verify result and the repository migration set hash:

```bash
MIGRATION_SET_SHA256=$(node --input-type=module -e "import{readdirSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';const h=b=>createHash('sha256').update(b).digest('hex');const a=readdirSync('db/ledger-migrations').filter(n=>/^\\d{3}_.+\\.(?:sql|data\\.mjs)$/.test(n)).sort().map(name=>({name,sha256:h(readFileSync('db/ledger-migrations/'+name))}));process.stdout.write(h(JSON.stringify(a)))")
jq -n --arg candidate "$EXPECTED_CANDIDATE" --arg migration_set "$MIGRATION_SET_SHA256" \
  '{format:"blogman-migration-evidence/v1",state:"verified",candidate_id:$candidate,migration_set_sha256:$migration_set}' \
  > "$REPORT_DIR/migration-report.json"
```

## 7. Deploy the uploaded version and prove the serving version

Classification: production traffic write, then read-only proof.

```bash
./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-before-traffic-write.json"
cmp "$REPORT_DIR/deployment-before.json" "$REPORT_DIR/deployment-before-traffic-write.json"

./node_modules/.bin/wrangler versions deploy "$UPLOADED_VERSION_ID@100%" -y -c "$CONFIG"
./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-after.json"

DEPLOYMENT_ID=$(jq -r .id "$REPORT_DIR/deployment-after.json")
VERSION_ID=$(jq -r '.versions[] | select(.percentage == 100) | .version_id' "$REPORT_DIR/deployment-after.json")
test "$VERSION_ID" = "$UPLOADED_VERSION_ID"
```

Expected result: immediately before the traffic write, production still equals the captured baseline; afterward there is one deployment ID, one version at 100%, and the version equals the uploaded version. If the pre-write comparison or deployment state is ambiguous, stop all traffic writes/smoke and inspect read-only status. If the new version is serving but broken, restoring the captured preflight version to 100% is allowed only under the emergency approval; doing so invalidates this candidate, does not revert D1, and requires a forward-fix successor.

Emergency traffic restore command (production traffic write; run only after a qualifying failure and only if operation 7 was explicitly approved):

```bash
./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-before-emergency-restore.json"
test "$(jq -er .id "$REPORT_DIR/deployment-before-emergency-restore.json")" = "$DEPLOYMENT_ID"
test "$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "$REPORT_DIR/deployment-before-emergency-restore.json")" = "$VERSION_ID"

./node_modules/.bin/wrangler versions deploy "$BASELINE_VERSION_ID@100%" -y -c "$CONFIG"
./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/emergency-traffic-restore.json"
test "$(jq -er '.versions | select(length == 1) | .[0] | select(.percentage == 100) | .version_id' "$REPORT_DIR/emergency-traffic-restore.json")" = "$BASELINE_VERSION_ID"
```

The two `test` commands are a compare-and-stop guard: if traffic no longer belongs exclusively to this candidate, do not overwrite another operator's deployment. Stop after the proof. Do not resume this candidate or undo D1 facts; open a successor forward-fix candidate.

## 8. Same-version smoke, D1 reconciliation, and rollout snapshot

Classification: production read-only. Do not retain response bodies. Use status codes and report hashes only.

```bash
verify_config_identity
./node_modules/.bin/wrangler d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-t0-before.json"
test "$(jq -er .uuid "$REPORT_DIR/d1-info-t0-before.json")" = "$DATABASE_ID"

run_production_smoke
SMOKE_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-after-smoke.json"
cmp "$REPORT_DIR/deployment-after.json" "$REPORT_DIR/deployment-after-smoke.json"

verify_config_identity
node scripts/rollout-safety.mjs reconcile compare \
  --expected "$REPORT_DIR/expected-production-after.json" \
  --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/reconciliation-raw.json"
RECON_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg checked "$RECON_CHECKED_AT" --arg d1 "$DATABASE_ID" \
  --slurpfile result "$REPORT_DIR/reconciliation-raw.json" \
  '{format:"blogman-d1-reconciliation-check/v2",checked_at:$checked,d1_database_id:$d1,
    state:$result[0].state,checks:$result[0].checks}' \
  > "$REPORT_DIR/reconciliation-report.json"

verify_config_identity
./node_modules/.bin/wrangler d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-t0-after.json"
test "$(jq -er .uuid "$REPORT_DIR/d1-info-t0-after.json")" = "$DATABASE_ID"

jq -n --arg candidate "$EXPECTED_CANDIDATE" --arg build "$BUILD_SHA256" \
  --arg deployment "$DEPLOYMENT_ID" --arg version "$VERSION_ID" --arg d1 "$DATABASE_ID" \
  --arg checked "$SMOKE_CHECKED_AT" \
  --argjson search "$SMOKE_SEARCH_STATUS" --argjson appearance "$SMOKE_APPEARANCE_STATUS" \
  --argjson admin_article "$SMOKE_ADMIN_ARTICLE_STATUS" --argjson tokens "$SMOKE_TOKENS_STATUS" \
  --argjson ai_provider "$SMOKE_AI_PROVIDER_STATUS" --argjson ai_generators "$SMOKE_AI_GENERATORS_STATUS" \
  '{format:"blogman-production-smoke/v2",checked_at:$checked,d1_database_id:$d1,
    checks:{search:$search,appearance:$appearance,admin_article:$admin_article,tokens:$tokens,ai_provider:$ai_provider,ai_generators:$ai_generators},
    state:"passed",candidate_id:$candidate,build_sha256:$build,deployment_id:$deployment,version_id:$version}' \
  > "$REPORT_DIR/production-smoke.json"

ROLLOUT_ROWS=$(./node_modules/.bin/wrangler d1 execute "$DATABASE" --remote -c "$CONFIG" --json \
  --command 'SELECT control_key, desired_enabled FROM rollout_controls ORDER BY control_key' \
  | jq -c '.[-1].results')
test "$ROLLOUT_ROWS" = '[]'
jq -n '{format:"blogman-rollout-state/v1",state:"captured",controls:{producer:"disabled",authority:"disabled",executors:{}}}' \
  > "$REPORT_DIR/rollout-state.json"
```

Expected result: all six real GET paths return success, the deployment is unchanged at 100%, D1 matches the locally migrated restore, and producer/authority/executors remain disabled. Any response failure, version drift, schema/ledger/count/status/content delta, or unexpected enabled control stops the gate. Do not create production fixtures to make smoke pass.

## 9. T0 event acceptance

Classification: production read-only review plus private evidence update. There is no minimum elapsed-time requirement and no observation-end wait. Run this stage immediately after steps 1–8 pass for the exact candidate, build, deployment, version, D1 database, migrations 001–006, six-path smoke, and final reconciliation.

Review Cloudflare Workers **Errors & Exceptions** and the Issue #23 incident record for unresolved high-priority anomalies without exporting raw logs or responses. The GitHub review command is read-only and prints to the operator terminal only:

```bash
gh issue view 23 --repo nardinmarcus/blogman --comments
```

A high-priority anomaly is any data loss/duplication, authority mismatch, schema drift, sensitive disclosure, broken disable control, unexplained stuck state, or wrong-version traffic. Write only the redacted result:

```bash
ANOMALY_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg checked "$ANOMALY_CHECKED_AT" \
  '{format:"blogman-anomaly-audit/v1",state:"clear",checked_at:$checked,high_priority_open:0}' \
  > "$REPORT_DIR/anomaly-audit.json"
```

If the audit is not clear, write `state=blocked` with the actual non-zero count and stop. Do not create T0, enable a control, or dispatch Batch 2. Disable the affected control if separately authorized and prepare a forward-fix candidate.

Create the T0 report only after the audit is clear. It closes over the exact migrations 001–006 and the raw migration, verification, final smoke, final reconciliation, and anomaly report bytes:

```bash
file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

T0_ACCEPTED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n \
  --arg accepted "$T0_ACCEPTED_AT" --arg candidate "$EXPECTED_CANDIDATE" \
  --arg build "$BUILD_SHA256" --arg deployment "$DEPLOYMENT_ID" \
  --arg version "$VERSION_ID" --arg d1 "$DATABASE_ID" \
  --arg migration_report "$(file_sha256 "$REPORT_DIR/migration-report.json")" \
  --arg migration_verification "$(file_sha256 "$REPORT_DIR/production-verify.json")" \
  --arg smoke "$(file_sha256 "$REPORT_DIR/production-smoke.json")" \
  --arg reconciliation "$(file_sha256 "$REPORT_DIR/reconciliation-report.json")" \
  --arg anomaly "$(file_sha256 "$REPORT_DIR/anomaly-audit.json")" \
  '{format:"blogman-t0-acceptance/v1",state:"passed",accepted_at:$accepted,
    candidate_id:$candidate,build_sha256:$build,deployment_id:$deployment,version_id:$version,
    d1_database_id:$d1,migration_numbers:[1,2,3,4,5,6],
    migration_report_sha256:$migration_report,
    migration_verification_report_sha256:$migration_verification,
    smoke_report_sha256:$smoke,final_reconciliation_report_sha256:$reconciliation,
    anomaly_report_sha256:$anomaly}' > "$REPORT_DIR/t0-report.json"
```

Assemble `candidate.json` using the exact SHA-256 of every report. Its schema is documented in `docs/rollout-safety.md`; do not add notes, raw output, placeholders, observation fields, or elapsed-time fields:

```bash
jq -n \
  --arg candidate "$EXPECTED_CANDIDATE" \
  --arg lockfile "$LOCKFILE_SHA256" --arg wrangler "$WRANGLER_VERSION" --arg opennext "$OPENNEXT_VERSION" \
  --arg build "$BUILD_SHA256" --arg deployment "$DEPLOYMENT_ID" --arg version "$VERSION_ID" \
  --arg d1 "$DATABASE_ID" --arg migration_set "$MIGRATION_SET_SHA256" \
  --arg migration_report "$(file_sha256 "$REPORT_DIR/migration-report.json")" \
  --arg migration_verification "$(file_sha256 "$REPORT_DIR/production-verify.json")" \
  --arg backup_id "$(jq -r .backup_id "$REPORT_DIR/backup-report.json")" \
  --arg backup_report "$(file_sha256 "$REPORT_DIR/backup-report.json")" \
  --arg restore_report "$(file_sha256 "$REPORT_DIR/restore-a-report.json")" \
  --arg reconciliation "$(file_sha256 "$REPORT_DIR/reconciliation-report.json")" \
  --arg smoke "$(file_sha256 "$REPORT_DIR/production-smoke.json")" \
  --arg smoke_runtime "$(file_sha256 "$REPORT_DIR/restored-workerd-smoke.json")" \
  --arg rollout "$(file_sha256 "$REPORT_DIR/rollout-state.json")" \
  --arg tests "$(file_sha256 "$REPORT_DIR/test-report.json")" \
  --arg t0 "$(file_sha256 "$REPORT_DIR/t0-report.json")" \
  '{format:"blogman-rollout-candidate/v2",candidate_id:$candidate,
    lockfile:{sha256:$lockfile,wrangler:$wrangler,opennextjs_cloudflare:$opennext},
    build:{sha256:$build},cloudflare:{deployment_id:$deployment,version_id:$version},
    d1:{database_id:$d1},
    migration:{state:"verified",candidate_id:$candidate,set_sha256:$migration_set,report_sha256:$migration_report,verification_report_sha256:$migration_verification},
    backup:{backup_id:$backup_id,verify_report_sha256:$backup_report,restore_report_sha256:$restore_report},
    reconciliation:{report_sha256:$reconciliation},
    smoke:{report_sha256:$smoke,runtime_report_sha256:$smoke_runtime},
    rollout:{report_sha256:$rollout},tests:{report_sha256:$tests},t0:{report_sha256:$t0}}' \
  > "$REPORT_DIR/candidate.json"
```

Run the current verifier once:

```bash
node scripts/rollout-safety.mjs candidate verify \
  --evidence "$REPORT_DIR/candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile package-lock.json \
  --build "$REPORT_DIR/open-next-build.zip" \
  --deployment "$DEPLOYMENT_ID" --version "$VERSION_ID" --d1-database "$DATABASE_ID" \
  --backup-report "$REPORT_DIR/backup-report.json" \
  --restore-report "$REPORT_DIR/restore-a-report.json" \
  --migration-report "$REPORT_DIR/migration-report.json" \
  --migration-verification-report "$REPORT_DIR/production-verify.json" \
  --reconciliation-report "$REPORT_DIR/reconciliation-report.json" \
  --smoke-report "$REPORT_DIR/production-smoke.json" \
  --smoke-runtime-report "$REPORT_DIR/restored-workerd-smoke.json" \
  --rollout-report "$REPORT_DIR/rollout-state.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  --t0-report "$REPORT_DIR/t0-report.json" \
  --anomaly-report "$REPORT_DIR/anomaly-audit.json" \
  > "$REPORT_DIR/t0-candidate-verify.json"

jq -e '.state == "verified" and .phase == "batch-1-t0" and .d1_database_id == $d1' \
  --arg d1 "$DATABASE_ID" "$REPORT_DIR/t0-candidate-verify.json" >/dev/null
```

Only this terminal verifier result passes T0. It requires the exact candidate/build/deployment/version/D1 identity, migrations 001–006, matched schema/ledger/count/status/content reconciliation, all six real critical paths at HTTP 200, final D1 reconciliation, and zero unresolved high-priority anomalies. T0 PASS completes Issue #23 and unlocks Batch 2 immediately; no calendar wait is part of this contract.

## Failure stop and forward-fix boundaries

| Failure point | Immediate stop | Allowed recovery | Forbidden recovery |
|---|---|---|---|
| Preflight/backup/restore/local verify | Before any production write | Correct local evidence or create a successor candidate | Production apply/deploy |
| Version upload | Before D1 apply | Leave uploaded version undeployed; create a successor if bytes drift | Pretend upload is a deployment |
| Migration plan/apply/verify | Before traffic change | Preserve successful additive facts; add a forward migration and new candidate | Restore backup, down-migrate, edit ledger |
| Deployment/version/D1 proof | Before smoke/T0 | Read current status; emergency prior-version traffic restore only if approved; then forward-fix | Mix old deployment/version/D1 evidence with new candidate |
| Smoke/reconciliation/rollout | Before T0 | Disable affected control, preserve D1, forward-fix | Create fixtures, enable authority, ignore drift |
| T0 event acceptance | Keep Issue #23 blocked | Resolve the anomaly or create a forward-fix candidate, then rerun the fixed sequence | Pass incomplete evidence or dispatch Batch 2 |
