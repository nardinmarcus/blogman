# Issue #23 Phase B production runbook

This runbook starts only after a separate production-write approval. It binds one immutable candidate to one backup, migration set, OpenNext build, Cloudflare version/deployment, same-version smoke, D1 reconciliation, rollout snapshot, test report, and a real observation window of at least 24 hours.

Do not persist article bodies, HTML, tokens, passwords, Bridge/AI credentials, signed URLs, raw HTTP bodies, or raw Cloudflare responses in evidence or reports. The one temporary private SQL backup necessarily contains application rows; it is never evidence, stays `0600` inside the one-attempt `0700` export run root, and must be destroyed at the lifecycle boundary below. Keep the evidence root outside the repository with mode `0700`.

## Approval boundary

The approval must explicitly cover these production operations:

1. One pre-migration remote D1 export of the seven regular application tables and read-only D1 baseline queries.
2. One candidate-bound remote ledger migration `apply` for migrations 001–006.
3. One OpenNext version upload and one 100% Cloudflare deployment of that exact uploaded version. OpenNext also populates its configured remote cache during upload/deploy.
4. Status-only production HTTP smoke against article, token, AI configuration, and generator read paths; no response bodies are retained.
5. Read-only post-migration and observation-start/end D1 reconciliation.
6. Starting and ending the 24-hour observation window.
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
EXPORT_RUN_ROOT="$EVIDENCE_ROOT/export-$EXPECTED_CANDIDATE-successor-1"
BACKUP_DIR="$EXPORT_RUN_ROOT/backup"
PUBLIC_ORIGIN=<approved-public-origin>
ADMIN_COOKIE_FILE=<operator-owned-private-cookie-file>
SMOKE_ARTICLE_SLUG=<approved-existing-article-slug>
```

Validate the operator-owned production config before setup or any Wrangler production call. This gate checks only the path and file type; it does not read the file:

```bash
case "$CONFIG" in
  /*) ;;
  *) printf '%s\n' 'CONFIG must be an absolute path to an existing regular file' >&2; exit 1 ;;
esac
if ! test -f "$CONFIG"; then
  printf '%s\n' 'CONFIG must be an absolute path to an existing regular file' >&2
  exit 1
fi
```

Create the private directories, then move into the candidate checkout:

```bash
install -d -m 0700 "$EVIDENCE_ROOT" "$REPORT_DIR" "$RESTORE_A" "$RESTORE_B"
test ! -e "$EXPORT_RUN_ROOT"
cd "$REPO"
```

Every command below stops on a non-zero exit. Do not continue by hand after a failed gate. `EXPORT_RUN_ROOT` is an approved one-attempt identity: the export command creates it atomically with mode `0700`, and an existing root is a hard stop before Wrangler starts. Never rename, remove, or replace it to obtain a retry; a successor attempt requires a new candidate, approval, and run root.

The repository-owned order contract is `scripts/phase-b-sequence.mjs`. Operator automation must call `runPhaseBSequence()` with the absolute `CONFIG` path, an immutable binding cache for the approved candidate/packet/build/baseline identities, and the Issue #23 stage adapters. It fixes this exact sequence and rejects dynamic stage graphs:

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

The smoke helper retains status only; every response body is discarded:

```bash
run_production_smoke() {
  curl --fail --silent --output /dev/null "$PUBLIC_ORIGIN/api/search?q=blogman"
  curl --fail --silent --output /dev/null "$PUBLIC_ORIGIN/api/settings/appearance"
  curl --fail --silent --output /dev/null --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/posts/$SMOKE_ARTICLE_SLUG"
  curl --fail --silent --output /dev/null --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/tokens"
  curl --fail --silent --output /dev/null --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/ai-provider"
  curl --fail --silent --output /dev/null --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/ai-post-generators"
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
```

Stop if the checkout is dirty, the candidate differs, `main` and `origin/main` differ, the candidate does not descend from `origin/main`, the installed versions differ from the lockfile, the build fails, or the active production deployment/version is not the explicitly approved baseline at 100%. `BASELINE_VERSION_ID` is the only version eligible for the separately authorized emergency traffic restore. Local build output is not production proof.

## 2. Remote migration plan hard gate

Classification: production read-only. This is the first operation requiring explicit production access approval. It runs after CAS1 and D1 identity, but before the one-shot export or either isolated restore.

```bash
node scripts/migrations.mjs plan --database "$DATABASE" --remote --config "$CONFIG" \
  --failure-report "$REPORT_DIR/production-plan-before-failure.json" \
  > "$REPORT_DIR/production-plan-before.json"
```

Expected result: the plan accepts the current schema and lists only the expected pending migrations. A successful plan removes its reserved failure-report path. With `--failure-report`, the migration runner itself executes every inner Wrangler query once inside a fresh mode-`0700` directory with pre-created mode-`0600` stdout, stderr, and forced `WRANGLER_LOG_PATH` files, enforces the fixed 300-second timeout with no retry, then recursively overwrites, removes, and verifies removal of that raw directory. On failure it preserves only the mode-`0600` `blogman-migration-failure/v1` report with fixed classification fields; `failure_domain` records the confirmed layer while `failure_hint` records only non-confirmed auth/network text signals. The report must never contain SQL, raw output, URLs, credentials, or response bodies. An existing failure-report path is a hard stop and must never be removed or reused to obtain another attempt.

Stop on any remote plan failure or unexpected pending migration. In that case export, double restore, upload, migrations 001–006, CAS2, traffic, smoke/reconciliation, and T0 must all remain at attempt count `0`. Do not bypass query 7 or replace its read-only/opcode proof in this phase.

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
run_production_smoke

./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-after-smoke.json"
cmp "$REPORT_DIR/deployment-after.json" "$REPORT_DIR/deployment-after-smoke.json"

node scripts/rollout-safety.mjs reconcile compare \
  --expected "$REPORT_DIR/expected-production-after.json" \
  --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/reconciliation-report.json"

jq -n --arg candidate "$EXPECTED_CANDIDATE" --arg build "$BUILD_SHA256" \
  --arg deployment "$DEPLOYMENT_ID" --arg version "$VERSION_ID" \
  '{state:"passed",candidate_id:$candidate,build_sha256:$build,deployment_id:$deployment,version_id:$version}' \
  > "$REPORT_DIR/production-smoke.json"

ROLLOUT_ROWS=$(./node_modules/.bin/wrangler d1 execute "$DATABASE" --remote -c "$CONFIG" --json \
  --command 'SELECT control_key, desired_enabled FROM rollout_controls ORDER BY control_key' \
  | jq -c '.[-1].results')
test "$ROLLOUT_ROWS" = '[]'
jq -n '{format:"blogman-rollout-state/v1",state:"captured",controls:{producer:"disabled",authority:"disabled",executors:{}}}' \
  > "$REPORT_DIR/rollout-state.json"
```

Expected result: all six real GET paths return success, the deployment is unchanged at 100%, D1 matches the locally migrated restore, and producer/authority/executors remain disabled. Any response failure, version drift, schema/ledger/count/status/content delta, or unexpected enabled control stops the gate. Do not create production fixtures to make smoke pass.

## 9. Assemble and verify the pending candidate

Create `observation-start-smoke.json` and `observation-start-reconciliation.json` as immutable copies of the initial production reports. Set `T0` only after steps 1–8 all pass.

```bash
cp "$REPORT_DIR/production-smoke.json" "$REPORT_DIR/observation-start-smoke.json"
cp "$REPORT_DIR/reconciliation-report.json" "$REPORT_DIR/observation-start-reconciliation.json"
STARTED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
EARLIEST_END=$(node -e "process.stdout.write(new Date(Date.parse(process.argv[1])+24*60*60*1000).toISOString())" "$STARTED_AT")

START_SMOKE_SHA=$(shasum -a 256 "$REPORT_DIR/observation-start-smoke.json" | awk '{print $1}')
START_RECON_SHA=$(shasum -a 256 "$REPORT_DIR/observation-start-reconciliation.json" | awk '{print $1}')
jq -n --arg started "$STARTED_AT" --arg smoke "$START_SMOKE_SHA" --arg recon "$START_RECON_SHA" \
  '{format:"blogman-observation-window/v1",state:"pending",required_hours:24,
    started_at:$started,ended_at:null,
    start:{observed_at:$started,smoke_report_sha256:$smoke,reconciliation_report_sha256:$recon},
    end:null,anomaly_audit:null}' > "$REPORT_DIR/observation-window.json"
```

Assemble `candidate.json` using the exact SHA-256 of every report. Its schema is documented in `docs/rollout-safety.md`; do not add notes, raw output, or placeholders:

```bash
file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

write_candidate() {
  jq -n \
    --arg candidate "$EXPECTED_CANDIDATE" \
    --arg lockfile "$LOCKFILE_SHA256" --arg wrangler "$WRANGLER_VERSION" --arg opennext "$OPENNEXT_VERSION" \
    --arg build "$BUILD_SHA256" --arg deployment "$DEPLOYMENT_ID" --arg version "$VERSION_ID" \
    --arg migration_set "$MIGRATION_SET_SHA256" \
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
    --arg observation "$(file_sha256 "$REPORT_DIR/observation-window.json")" \
    '{format:"blogman-rollout-candidate/v1",candidate_id:$candidate,
      lockfile:{sha256:$lockfile,wrangler:$wrangler,opennextjs_cloudflare:$opennext},
      build:{sha256:$build},cloudflare:{deployment_id:$deployment,version_id:$version},
      migration:{state:"verified",candidate_id:$candidate,set_sha256:$migration_set,report_sha256:$migration_report,verification_report_sha256:$migration_verification},
      backup:{backup_id:$backup_id,verify_report_sha256:$backup_report,restore_report_sha256:$restore_report},
      reconciliation:{report_sha256:$reconciliation},smoke:{report_sha256:$smoke,runtime_report_sha256:$smoke_runtime},
      rollout:{report_sha256:$rollout},tests:{report_sha256:$tests},observation:{report_sha256:$observation}}' \
    > "$REPORT_DIR/candidate.json"
}

write_candidate
```

Then verify:

```bash
node scripts/rollout-safety.mjs candidate verify \
  --evidence "$REPORT_DIR/candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile package-lock.json \
  --build "$REPORT_DIR/open-next-build.zip" \
  --deployment "$DEPLOYMENT_ID" --version "$VERSION_ID" \
  --backup-report "$REPORT_DIR/backup-report.json" \
  --restore-report "$REPORT_DIR/restore-a-report.json" \
  --migration-report "$REPORT_DIR/migration-report.json" \
  --migration-verification-report "$REPORT_DIR/production-verify.json" \
  --reconciliation-report "$REPORT_DIR/reconciliation-report.json" \
  --smoke-report "$REPORT_DIR/production-smoke.json" \
  --smoke-runtime-report "$REPORT_DIR/restored-workerd-smoke.json" \
  --rollout-report "$REPORT_DIR/rollout-state.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  --observation-report "$REPORT_DIR/observation-window.json" \
  --observation-start-smoke-report "$REPORT_DIR/observation-start-smoke.json" \
  --observation-start-reconciliation-report "$REPORT_DIR/observation-start-reconciliation.json"

node scripts/rollout-safety.mjs rollout status \
  --evidence "$REPORT_DIR/candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile package-lock.json \
  --build "$REPORT_DIR/open-next-build.zip" \
  --deployment "$DEPLOYMENT_ID" --version "$VERSION_ID" \
  --backup-report "$REPORT_DIR/backup-report.json" \
  --restore-report "$REPORT_DIR/restore-a-report.json" \
  --migration-report "$REPORT_DIR/migration-report.json" \
  --migration-verification-report "$REPORT_DIR/production-verify.json" \
  --reconciliation-report "$REPORT_DIR/reconciliation-report.json" \
  --smoke-report "$REPORT_DIR/production-smoke.json" \
  --smoke-runtime-report "$REPORT_DIR/restored-workerd-smoke.json" \
  --rollout-report "$REPORT_DIR/rollout-state.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  --observation-report "$REPORT_DIR/observation-window.json" \
  --observation-start-smoke-report "$REPORT_DIR/observation-start-smoke.json" \
  --observation-start-reconciliation-report "$REPORT_DIR/observation-start-reconciliation.json" \
  --database "$DATABASE" --remote --config "$CONFIG"
```

The observation starts at `STARTED_AT`; its earliest possible end is `EARLIEST_END`. Neither timestamp passes the gate by itself.

## 10. Observation end

Classification: production read-only plus private evidence update. Run no earlier than `EARLIEST_END`.

First prove wall-clock eligibility, then repeat the exact real paths, same-version deployment proof, and D1 comparison. These commands are read-only against production and write only redacted private evidence:

```bash
node -e "if (Date.now() < Date.parse(process.argv[1])) process.exit(1)" "$EARLIEST_END"

./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-observation-end-before.json"
cmp "$REPORT_DIR/deployment-after.json" "$REPORT_DIR/deployment-observation-end-before.json"

run_production_smoke

node scripts/rollout-safety.mjs reconcile compare \
  --expected "$REPORT_DIR/expected-production-after.json" \
  --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/reconciliation-report.json"
jq -e '.state == "matched" and ([.checks[]] | all(. == "matched"))' \
  "$REPORT_DIR/reconciliation-report.json" >/dev/null

./node_modules/.bin/wrangler deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-observation-end-after.json"
cmp "$REPORT_DIR/deployment-after.json" "$REPORT_DIR/deployment-observation-end-after.json"

END_OBSERVED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg candidate "$EXPECTED_CANDIDATE" --arg build "$BUILD_SHA256" \
  --arg deployment "$DEPLOYMENT_ID" --arg version "$VERSION_ID" \
  '{state:"passed",candidate_id:$candidate,build_sha256:$build,deployment_id:$deployment,version_id:$version}' \
  > "$REPORT_DIR/production-smoke.json"
```

Stop if the eligibility check fails, any request fails, either deployment snapshot differs byte-for-byte from the original deployment proof, or any reconciliation dimension drifts. Do not create an end report from partial checks.

Then review the exact UTC `[STARTED_AT, END_OBSERVED_AT]` interval in Cloudflare Workers **Errors & Exceptions** and the Issue #23 incident record without exporting raw logs or responses. The GitHub review command is read-only and prints to the operator terminal only:

```bash
gh issue view 23 --repo nardinmarcus/blogman --comments
```

A high-priority anomaly is any data loss/duplication, authority mismatch, schema drift, sensitive disclosure, broken disable control, unexplained stuck state, or wrong-version traffic. After that review finishes, write only this redacted anomaly summary:

```bash
CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg checked "$CHECKED_AT" \
  '{format:"blogman-anomaly-audit/v1",state:"clear",checked_at:$checked,high_priority_open:0}' \
  > "$REPORT_DIR/observation-anomaly-audit.json"
```

If the audit is not clear, write `state=blocked` with the actual non-zero count, stop, disable the affected control if authorized, and prepare a forward-fix candidate. Never falsify `clear` because 24 hours elapsed. The verifier additionally requires `end.observed_at >= started_at + required_hours` and `ended_at >= anomaly.checked_at >= end.observed_at`; moving only `ended_at` cannot make early evidence pass.

Regenerate the main `production-smoke.json` and `reconciliation-report.json` from the end checks, then complete the observation report:

```bash
ENDED_AT="$CHECKED_AT"
END_SMOKE_SHA=$(shasum -a 256 "$REPORT_DIR/production-smoke.json" | awk '{print $1}')
END_RECON_SHA=$(shasum -a 256 "$REPORT_DIR/reconciliation-report.json" | awk '{print $1}')
ANOMALY_SHA=$(shasum -a 256 "$REPORT_DIR/observation-anomaly-audit.json" | awk '{print $1}')

jq -n --arg started "$STARTED_AT" --arg ended "$ENDED_AT" --arg end_observed "$END_OBSERVED_AT" \
  --arg start_smoke "$START_SMOKE_SHA" --arg start_recon "$START_RECON_SHA" \
  --arg end_smoke "$END_SMOKE_SHA" --arg end_recon "$END_RECON_SHA" --arg anomaly "$ANOMALY_SHA" \
  '{format:"blogman-observation-window/v1",state:"complete",required_hours:24,
    started_at:$started,ended_at:$ended,
    start:{observed_at:$started,smoke_report_sha256:$start_smoke,reconciliation_report_sha256:$start_recon},
    end:{observed_at:$end_observed,smoke_report_sha256:$end_smoke,reconciliation_report_sha256:$end_recon},
    anomaly_audit:{report_sha256:$anomaly}}' > "$REPORT_DIR/observation-window.json"
```

Regenerate only the report hashes in `candidate.json` with `write_candidate`, then run the complete final gate:

```bash
write_candidate
node scripts/rollout-safety.mjs candidate verify \
  --evidence "$REPORT_DIR/candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile package-lock.json \
  --build "$REPORT_DIR/open-next-build.zip" \
  --deployment "$DEPLOYMENT_ID" --version "$VERSION_ID" \
  --backup-report "$REPORT_DIR/backup-report.json" \
  --restore-report "$REPORT_DIR/restore-a-report.json" \
  --migration-report "$REPORT_DIR/migration-report.json" \
  --migration-verification-report "$REPORT_DIR/production-verify.json" \
  --reconciliation-report "$REPORT_DIR/reconciliation-report.json" \
  --smoke-report "$REPORT_DIR/production-smoke.json" \
  --smoke-runtime-report "$REPORT_DIR/restored-workerd-smoke.json" \
  --rollout-report "$REPORT_DIR/rollout-state.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  --observation-report "$REPORT_DIR/observation-window.json" \
  --observation-start-smoke-report "$REPORT_DIR/observation-start-smoke.json" \
  --observation-start-reconciliation-report "$REPORT_DIR/observation-start-reconciliation.json" \
  --anomaly-report "$REPORT_DIR/observation-anomaly-audit.json" \
  > "$REPORT_DIR/observation-complete-candidate-verify.json"

jq -e '.state == "verified"' \
  "$REPORT_DIR/observation-complete-candidate-verify.json" >/dev/null
```

Only `state=verified`, unchanged same-version traffic, matched end reconciliation, clear anomaly audit, and an actual duration of at least 24 hours can pass Issue #23. Until then Batch 2 remains blocked.

## Failure stop and forward-fix boundaries

| Failure point | Immediate stop | Allowed recovery | Forbidden recovery |
|---|---|---|---|
| Preflight/backup/restore/local verify | Before any production write | Correct local evidence or create a successor candidate | Production apply/deploy |
| Version upload | Before D1 apply | Leave uploaded version undeployed; create a successor if bytes drift | Pretend upload is a deployment |
| Migration plan/apply/verify | Before traffic change | Preserve successful additive facts; add a forward migration and new candidate | Restore backup, down-migrate, edit ledger |
| Deployment/version proof | Before smoke/observation | Read current status; emergency prior-version traffic restore only if approved; then forward-fix | Mix old deployment/version evidence with new candidate |
| Smoke/reconciliation/rollout | Before observation start | Disable affected control, preserve D1, forward-fix | Create fixtures, enable authority, ignore drift |
| 24-hour observation | Keep Issue #23 blocked | Disable affected capability, investigate, forward-fix, restart the full affected window | Pass on elapsed time alone or dispatch Batch 2 |
