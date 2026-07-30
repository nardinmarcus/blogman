# Issue #23 clean-start Phase B production runbook

This is the current Issue #23 production contract. It is executable only after a separate authorization binds one exact clean-start v4 sealed package. The product decision that existing Blogman data may be discarded is not itself production authorization or a deletion instruction.

The clean-start path keeps the approved D1 database UUID, uploads the candidate before the destructive boundary, resets only the known Blogman objects with the candidate-bound SQL file, proves the same D1 is empty, applies migrations 001–006 as new-database `apply` actions, and then performs CAS, traffic, smoke, reconciliation, rollback/control, and T0 proof.

Historical-data steps have these explicit dispositions:

- historical data export: `NOT_APPLICABLE`
- double restore: `NOT_APPLICABLE`
- historical baseline queries: `NOT_APPLICABLE`

They are not optional operator choices. All three values and the reset SQL SHA-256 must match the sealed request, approval packet, PRE-CAS bindings, package manifest, and fixed sequence before the first production command. A missing, different, or unbound disposition is a hard stop.

Never persist article bodies, HTML, tokens, credentials, signed URLs, raw HTTP bodies, or raw Cloudflare responses in reports. Private Wrangler output stays in the one-attempt evidence root with mode `0600`; the evidence root is outside the repository with mode `0700`.

## Fixed sequence and stop rule

The repository-owned sequence is `scripts/phase-b-sequence.mjs`:

`PRE-CAS/local gates → CAS1 → D1 identity → upload → clean-start reset → empty D1 verify → empty D1 migration plan → migrations 001–006 → CAS2 → traffic → smoke/reconcile → T0`.

Every applicable stage runs at most once. There is no retry, fallback to the historical-preservation path, down migration, ledger edit, or restoration of discarded data. A failure stops before the suffix. After reset, recovery is a forward-fix successor against the preserved empty/additive D1 facts; an emergency traffic restore may restore only the previously approved Worker version and never D1 data.

## 0. Bound inputs

Use absolute paths. Example variable names are placeholders; do not copy identities from an older lineage.

```bash
set -euo pipefail
umask 077

TOOL_WORKSPACE=/absolute/path/to/blogman-tool-workspace
FROZEN_ROOT=/absolute/private/frozen
FROZEN_SNAPSHOT=/absolute/private/frozen/snapshot
FROZEN_ARTIFACTS=/absolute/private/frozen/artifacts
OPERATOR_EVIDENCE_ROOT=/absolute/private/issue-23-clean-start
CONFIG="$OPERATOR_EVIDENCE_ROOT/wrangler.toml"
LOCAL_CONFIG="$FROZEN_SNAPSHOT/wrangler.toml"
WRANGLER="$TOOL_WORKSPACE/node_modules/.bin/wrangler"
LOCKFILE="$FROZEN_SNAPSHOT/package-lock.json"
DATABASE=blogman-db
EXPECTED_CANDIDATE=replace-with-40-hex-approved-commit
RESEAL_REQUEST="$FROZEN_ROOT/reseal-input.json"
INPUT_EVIDENCE_MANIFEST="$(dirname "$RESEAL_REQUEST")/input-evidence-manifest.json"
SEALED_PACKAGE="$OPERATOR_EVIDENCE_ROOT/sealed/package"
APPROVAL_PACKET="$SEALED_PACKAGE/approval-packet.json"
RESET_SQL="$FROZEN_SNAPSHOT/db/issue-23-clean-start-reset.sql"
BUILD_ZIP="$FROZEN_ARTIFACTS/open-next-build.zip"
UPLOAD_SOURCE_DIRECTORY="$FROZEN_ARTIFACTS/open-next"
REPORT_DIR="$OPERATOR_EVIDENCE_ROOT/reports"
PUBLIC_ORIGIN=https://replace-with-approved-public-origin.invalid
ADMIN_COOKIE_FILE=/absolute/private/operator-owned-cookie-file
CLEAN_START_MISSING_SLUG=__issue-23-clean-start-empty__

for bound_path in \
  "$TOOL_WORKSPACE" "$FROZEN_ROOT" "$FROZEN_SNAPSHOT" "$FROZEN_ARTIFACTS" \
  "$OPERATOR_EVIDENCE_ROOT" "$CONFIG" "$LOCAL_CONFIG" "$WRANGLER" \
  "$LOCKFILE" "$RESEAL_REQUEST" "$SEALED_PACKAGE" "$REPORT_DIR"
do
  case "$bound_path" in
    /*) ;;
    *) exit 1 ;;
  esac
done
test -d "$TOOL_WORKSPACE"
test -d "$FROZEN_ROOT"
test -d "$FROZEN_SNAPSHOT"
test -d "$FROZEN_ARTIFACTS"
test -d "$OPERATOR_EVIDENCE_ROOT"
test -x "$WRANGLER"
test -f "$CONFIG"
test -f "$LOCAL_CONFIG"
test -f "$LOCKFILE"
test "$(git -C "$TOOL_WORKSPACE" rev-parse HEAD)" = "$EXPECTED_CANDIDATE"
test -z "$(git -C "$TOOL_WORKSPACE" status --porcelain --untracked-files=all)"
test "$(git -C "$FROZEN_SNAPSHOT" rev-parse HEAD)" = "$EXPECTED_CANDIDATE"
test -z "$(git -C "$FROZEN_SNAPSHOT" status --porcelain --untracked-files=all)"
test -f "$RESEAL_REQUEST"
test -f "$INPUT_EVIDENCE_MANIFEST"
test -d "$SEALED_PACKAGE"
test -f "$APPROVAL_PACKET"
test -f "$RESET_SQL"
test -d "$UPLOAD_SOURCE_DIRECTORY"
test -d "$REPORT_DIR"
test "$(stat -f '%Lp' "$REPORT_DIR")" = 700

DATABASE_ID=$(jq -er .expected_baseline.d1_database_id "$APPROVAL_PACKET")
BUILD_SHA256=$(shasum -a 256 "$BUILD_ZIP" | awk '{print $1}')
test "$BUILD_SHA256" = "$(jq -er .build_archive_sha256 "$APPROVAL_PACKET")"
CONFIG_SHA256=$(shasum -a 256 "$CONFIG" | awk '{print $1}')
CONFIG_FILE_ID=$(stat -f '%d:%i' "$CONFIG")
readonly DATABASE_ID BUILD_SHA256 CONFIG_SHA256 CONFIG_FILE_ID

verify_config_identity() {
  test -f "$CONFIG"
  test "$(stat -f '%d:%i' "$CONFIG")" = "$CONFIG_FILE_ID"
  test "$(shasum -a 256 "$CONFIG" | awk '{print $1}')" = "$CONFIG_SHA256"
}
```

The reseal must have been prepared in a build/preflight workspace outside its
frozen evidence root. Dependencies and toolchains, including `node_modules`,
must remain in `TOOL_WORKSPACE` and outside that root. `FROZEN_SNAPSHOT` is a
self-contained Git worktree whose effective git-dir, common-dir, index, and
primary object store are all inside `FROZEN_ROOT`; linked worktrees, object
alternates, and Git storage environment overrides are forbidden. The root contains only the final snapshot,
canonical v3 request, canonical input-evidence v2 manifest, and bound artifacts;
its complete recursive tree has zero symlinks, hardlinked regular files,
special files, realpath escapes, and transient dependency/toolchain entries.

Validate the canonical input-evidence v2 manifest, canonical v3 request, and
current v4 package locally with `scripts/issue-23-reseal.mjs`; the package must
be current, not historical. `prepare`, `seal`, and `verify` all consume the
fixed sibling `input-evidence-manifest.json` and validate it before any sealed
output reservation. The later candidate verifier consumes those same original
paths and hashes the original bytes. The package must have
`production_authorization_granted=false` and all clean-start stage counters at
zero before a separate authorization binds its exact package manifest SHA-256.
A v2 or v3 package may validate only as historical read-only evidence and
cannot start this sequence. A terminal or blocked lineage is immutable history;
never patch or continue it in place.

Before every repository or Cloudflare adapter call, recheck the absolute config realpath and SHA-256 captured at PRE-CAS. Do not accept a symlink replacement or a different D1 binding.

## 1. PRE-CAS local gates

Classification: local-only except separately reviewed GitHub status. No Cloudflare command runs in this stage.

Prove all of the following:

- repository-owned input-evidence v2 canonical bytes/schema/hash pass and its
  denied terminal lineages are not input dependencies;
- `HEAD`, tree, `main`, and `origin/main` match the sealed candidate and the worktree is clean;
- lockfile, build ZIP, Worker, tree manifest, runbook, reset SQL, and migrations have the sealed hashes;
- approval `delivery_mode=clean-start`, strategy `reset-bound-d1-in-place`, and all three historical dispositions are `NOT_APPLICABLE`;
- the approval baseline deployment, version, and D1 UUID match PRE-CAS immutable bindings;
- affected tests, static gates, OpenNext build, Standards review, Spec review, and required terminal CI are green;
- one isolated local empty D1 applies and verifies migrations 001–006, passes real Workerd request smoke, and produces the expected post-migration reconciliation snapshot;
- production authorization is fresh, exact, unused, and names this package; no other production writer exists.

The local empty-D1 rehearsal is:

```bash
node "$TOOL_WORKSPACE/scripts/issue-23-reseal.mjs" validate --document "$RESEAL_REQUEST" \
  > "$REPORT_DIR/reseal-request-validation.json"
node "$TOOL_WORKSPACE/scripts/issue-23-reseal.mjs" validate --document "$INPUT_EVIDENCE_MANIFEST" \
  > "$REPORT_DIR/input-evidence-validation.json"
node "$TOOL_WORKSPACE/scripts/issue-23-reseal.mjs" prepare \
  --input "$RESEAL_REQUEST" --repo "$FROZEN_SNAPSHOT" --artifacts "$FROZEN_ARTIFACTS" \
  > "$REPORT_DIR/reseal-input-preparation.json"
node "$TOOL_WORKSPACE/scripts/issue-23-reseal.mjs" validate --package "$SEALED_PACKAGE" \
  > "$REPORT_DIR/sealed-package-validation.json"
node "$TOOL_WORKSPACE/scripts/issue-23-reseal.mjs" verify-build-directory \
  --archive "$BUILD_ZIP" --directory "$UPLOAD_SOURCE_DIRECTORY" \
  --archive-sha256 "$BUILD_SHA256" > "$REPORT_DIR/pre-cas-build-directory-proof.json"

LOCAL_D1_STATE=$(mktemp -d)
node "$TOOL_WORKSPACE/scripts/migrations.mjs" apply \
  --database DB --local --persist-to "$LOCAL_D1_STATE" --config "$LOCAL_CONFIG" \
  --candidate "$EXPECTED_CANDIDATE" > "$REPORT_DIR/local-apply.json"
node "$TOOL_WORKSPACE/scripts/migrations.mjs" verify \
  --database DB --local --persist-to "$LOCAL_D1_STATE" --config "$LOCAL_CONFIG" \
  > "$REPORT_DIR/local-verify.json"
node "$TOOL_WORKSPACE/scripts/rollout-safety.mjs" reconcile capture \
  --database DB --local --persist-to "$LOCAL_D1_STATE" --config "$LOCAL_CONFIG" \
  > "$REPORT_DIR/expected-production-after.json"
node "$TOOL_WORKSPACE/scripts/rollout-safety.mjs" request smoke \
  --database DB --local --persist-to "$LOCAL_D1_STATE" --config "$LOCAL_CONFIG" \
  > "$REPORT_DIR/empty-migrated-workerd-smoke.json"
node "$TOOL_WORKSPACE/scripts/rollout-safety.mjs" reconcile compare \
  --expected "$REPORT_DIR/expected-production-after.json" \
  --database DB --local --persist-to "$LOCAL_D1_STATE" --config "$LOCAL_CONFIG" \
  > "$REPORT_DIR/local-reconciliation.json"
```

Keep the local state until final reconciliation. Any local failure invalidates the candidate before production.

## 2. CAS1 and D1 identity

Classification: production read-only. These are the first commands requiring the separate production authorization.

```bash
verify_config_identity
"$WRANGLER" deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-before.json"

verify_config_identity
"$WRANGLER" d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-before.json"
```

Require one version at 100%, exact approval baseline deployment/version, and exact approval D1 UUID. Stop on drift or ambiguous output. The D1 UUID is rechecked after reset, after migration, before traffic, and at T0.

## 3. Upload before the destructive boundary

Classification: production Worker version write, no traffic change and no D1 write.

```bash
UPLOAD_PRIVATE="$REPORT_DIR/upload-private.jsonl"
UPLOAD_OPERATION_ID="issue-23-$EXPECTED_CANDIDATE-upload-1"
install -m 600 /dev/null "$UPLOAD_PRIVATE"
node "$TOOL_WORKSPACE/scripts/issue-23-reseal.mjs" verify-build-directory \
  --archive "$BUILD_ZIP" --directory "$UPLOAD_SOURCE_DIRECTORY" \
  --archive-sha256 "$BUILD_SHA256" > "$REPORT_DIR/upload-source-directory-proof.json"
UPLOAD_SOURCE_SNAPSHOT_DIRECTORY="$REPORT_DIR/upload-source-snapshot"
readonly UPLOAD_SOURCE_SNAPSHOT_DIRECTORY
UPLOAD_SOURCE_SNAPSHOT_PROOF="$REPORT_DIR/upload-source-snapshot.json"
UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER="$REPORT_DIR/upload-source-snapshot-after.json"
UPLOAD_BUILD_DIRECTORY_PROOF="$REPORT_DIR/upload-build-directory-proof.json"
readonly UPLOAD_SOURCE_SNAPSHOT_PROOF UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER UPLOAD_BUILD_DIRECTORY_PROOF
install -m 600 /dev/null "$UPLOAD_SOURCE_SNAPSHOT_PROOF"
install -m 600 /dev/null "$UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER"
install -m 600 /dev/null "$UPLOAD_BUILD_DIRECTORY_PROOF"
verify_config_identity
UPLOAD_ACCEPTANCE=$(WRANGLER_OUTPUT_FILE_PATH="$UPLOAD_PRIVATE" node "$TOOL_WORKSPACE/scripts/phase-b-sequence.mjs" \
  run-upload-source-lifecycle \
  --config "$CONFIG" \
  --source "$UPLOAD_SOURCE_DIRECTORY" \
  --destination "$UPLOAD_SOURCE_SNAPSHOT_DIRECTORY" \
  --operation-id "$UPLOAD_OPERATION_ID" \
  --proof-before "$UPLOAD_SOURCE_SNAPSHOT_PROOF" \
  --proof-after "$UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER" \
  --archive "$BUILD_ZIP" \
  --archive-sha256 "$BUILD_SHA256" \
  --build-proof "$UPLOAD_BUILD_DIRECTORY_PROOF" \
  --expected-config-sha256 "$CONFIG_SHA256")
readonly UPLOAD_ACCEPTANCE
jq -e 'keys == ["build_directory_proof_sha256","config_sha256","format",
    "snapshot_identity_sha256","snapshot_proof_after_sha256",
    "snapshot_proof_before_sha256","snapshot_tree_sha256","state",
    "upload_operation_id","version_id","wrangler_output_sha256"]
  and .format == "blogman-upload-source-lifecycle-acceptance/v1"
  and .state == "accepted" and .upload_operation_id == $operation
  and (.version_id | type == "string" and length > 0)
  and ([.config_sha256,.snapshot_identity_sha256,.snapshot_proof_after_sha256,
    .snapshot_proof_before_sha256,.snapshot_tree_sha256,
    .build_directory_proof_sha256,.wrangler_output_sha256]
    | all(test("^[a-f0-9]{64}$")))' \
  --arg operation "$UPLOAD_OPERATION_ID" <<< "$UPLOAD_ACCEPTANCE" >/dev/null
UPLOADED_VERSION_ID=$(jq -er .version_id <<< "$UPLOAD_ACCEPTANCE")
UPLOAD_OUTPUT_SHA256=$(jq -er .wrangler_output_sha256 <<< "$UPLOAD_ACCEPTANCE")
BUILD_DIRECTORY_PROOF_SHA256=$(jq -er .build_directory_proof_sha256 <<< "$UPLOAD_ACCEPTANCE")
UPLOAD_SOURCE_SNAPSHOT_PROOF_SHA256=$(jq -er .snapshot_proof_before_sha256 <<< "$UPLOAD_ACCEPTANCE")
UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER_SHA256=$(jq -er .snapshot_proof_after_sha256 <<< "$UPLOAD_ACCEPTANCE")
test "$(jq -er .config_sha256 <<< "$UPLOAD_ACCEPTANCE")" = "$CONFIG_SHA256"
test "$(shasum -a 256 "$UPLOAD_PRIVATE" | awk '{print $1}')" = "$UPLOAD_OUTPUT_SHA256"
test "$(shasum -a 256 "$UPLOAD_BUILD_DIRECTORY_PROOF" | awk '{print $1}')" = "$BUILD_DIRECTORY_PROOF_SHA256"
test "$(shasum -a 256 "$UPLOAD_SOURCE_SNAPSHOT_PROOF" | awk '{print $1}')" = "$UPLOAD_SOURCE_SNAPSHOT_PROOF_SHA256"
test "$(shasum -a 256 "$UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER" | awk '{print $1}')" = "$UPLOAD_SOURCE_SNAPSHOT_PROOF_AFTER_SHA256"
UPLOAD_COMPLETED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg uploaded "$UPLOAD_COMPLETED_AT" --arg candidate "$EXPECTED_CANDIDATE" \
  --arg build "$BUILD_SHA256" --arg proof "$BUILD_DIRECTORY_PROOF_SHA256" \
  --arg output "$UPLOAD_OUTPUT_SHA256" --arg operation "$UPLOAD_OPERATION_ID" \
  --arg version "$UPLOADED_VERSION_ID" \
  '{format:"blogman-clean-start-upload/v1",state:"captured",uploaded_at:$uploaded,
    candidate_id:$candidate,build_archive_sha256:$build,
    build_directory_proof_sha256:$proof,wrangler_output_sha256:$output,
    upload_operation_id:$operation,version_id:$version,attempt_count:1}' \
  > "$REPORT_DIR/clean-start-upload-report.json"
```

The upload-source proof is regenerated from the actual `.open-next` directory after CAS1. One `run-upload-source-lifecycle` process opens and holds complete descriptor chains from the filesystem root through the report directory, config, source, sealed archive, and frozen snapshot. Every ancestor pathname must still resolve to its held device and inode. The critical paths' string common ancestor becomes an unconditional metadata-strict root only when it is not `/`, is owned by the effective user, and grants no group or other permissions. Until that verified private candidate root is reached, only ancestor entries that the effective user can rename or replace under POSIX parent write/search and sticky-owner rules must retain nanosecond ctime, mode, and size throughout the upload window. System-owned shared ancestors whose entries the effective user cannot replace retain descriptor/path identity checks without treating unrelated directory-content ctime changes as candidate drift, including when otherwise valid inputs have only `/` in common. Only the report-directory metadata change caused by exclusive snapshot creation is rebased. Immutable config, archive, snapshot, and path anchors are never refreshed after proof. The PRE-CAS `CONFIG_SHA256` is a required lifecycle input and config bytes are checked through the held descriptor before and after archive proof, as the final gate before the child spawn, and after the child returns. Wrangler's parsed config-relative `assets.directory` semantics are rechecked at the same lifecycle boundaries.

The archive verifier is a shared pure module loaded with the lifecycle process, not a helper launched later through a mutable pathname. The lifecycle proves the snapshot byte-for-byte against the bound sealed archive before invoking OpenNext exactly once, then repeats both snapshot and sealed-archive proofs after the child returns. It writes the terminal proof and only then performs the final anchor check. A complete report-directory, candidate-root, or higher owned-ancestor swap therefore remains observable even if the original path and snapshot subtree are restored before the post-proof.

Both snapshot proof files, the sealed-build proof, and Wrangler's private output are empty mode-`0600` regular files created before the lifecycle. The lifecycle opens each with `O_NOFOLLOW`, requires the current owner, link count one, exact pathname device/inode, and empty initial bytes, and keeps all four descriptors open across the upload. Repository-generated evidence is written through the held descriptors; child-generated Wrangler output is captured as an exact held-descriptor byte boundary. OpenNext child stdout is routed to lifecycle stderr so lifecycle stdout contains only the machine-readable acceptance JSON. While those descriptors and every path anchor remain held, the lifecycle validates exactly one `version-upload/v1` record, the matched proof states, and all final bytes, then returns the accepted version ID and evidence SHA-256 values as one JSON stdout value. The shell derives its decision values only from that atomic return. Subsequent pathname hashes are audits that must equal the already accepted digests; they cannot replace the accepted version or evidence.

Writing the precreated evidence files does not add a directory entry to the held report directory, avoiding a self-trigger before the terminal identity check. Snapshot root, every directory, and every file remain separately bound by the identity hash and byte-tree hash. The snapshot's absolute `worker.js` is the positional Wrangler script and its sibling `assets` directory is the explicit `--assets` source, so the complete Worker version comes from the same frozen and sealed snapshot even when the external config has a different or missing `main`. Any failed pre-upload archive or config proof leaves the unique child invocation count at zero; no version record or report is accepted unless every post-upload proof and final anchor check succeeds. The no-other-production-writer reservation established at PRE-CAS must remain held through version acceptance.

OpenNext 1.19.10 internally forwards Wrangler arguments with `shell:true`, so every path entering this adapter must already be absolute, normalized, and match the conservative `^/[A-Za-z0-9._/-]+$` character set. Paths containing whitespace or shell metacharacters fail closed before snapshot creation or forwarding. This remains correct when the operator config directory is outside the snapshot repository. Any config or upload-directory mismatch, path alias, content mutation, symlink swap, or snapshot reuse therefore stops without accepting the upload; the earlier rehearsal proof cannot be reused. The output file may contain other Wrangler records from the OpenNext upload path, but it must contain exactly one `version-upload/v1` record. The version ID comes only from that record; `versions list | last` is forbidden. Freeze the report and prove it belongs to this candidate, sealed build bytes, fresh upload-source proof, and operation. Re-run CAS1 and D1 identity immediately before reset. If another writer changed deployment, config, D1 identity, or upload attribution, stop without reset.

## 4. Candidate-bound in-place reset

Classification: destructive production D1 write. This is the only data-discard operation. It is allowed only for the exact bound D1 UUID and exact `db/issue-23-clean-start-reset.sql` bytes.

```bash
APPROVAL_SHA256=$(shasum -a 256 "$APPROVAL_PACKET" | awk '{print $1}')
RESET_SQL_SHA256=$(shasum -a 256 "$RESET_SQL" | awk '{print $1}')
test "$RESET_SQL_SHA256" = "$(jq -er .clean_start.reset_sql_sha256 "$APPROVAL_PACKET")"
test "$(jq -er .delivery_mode "$APPROVAL_PACKET")" = clean-start
test "$(jq -er .expected_baseline.d1_database_id "$APPROVAL_PACKET")" = "$DATABASE_ID"

RESET_PRIVATE="$REPORT_DIR/reset-private.json"
install -m 600 /dev/null "$RESET_PRIVATE"
verify_config_identity
"$WRANGLER" deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-before-reset.json"
cmp "$REPORT_DIR/deployment-before.json" "$REPORT_DIR/deployment-before-reset.json"
verify_config_identity
"$WRANGLER" d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-before-reset.json"
test "$(jq -er .uuid "$REPORT_DIR/d1-info-before-reset.json")" = "$DATABASE_ID"
verify_config_identity
"$WRANGLER" d1 execute "$DATABASE" --remote -c "$CONFIG" --json \
  --file "$RESET_SQL" > "$RESET_PRIVATE"
node "$TOOL_WORKSPACE/scripts/phase-b-sequence.mjs" validate-wrangler-d1-file-response \
  < "$RESET_PRIVATE" >/dev/null

RESET_COMPLETED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg completed "$RESET_COMPLETED_AT" --arg candidate "$EXPECTED_CANDIDATE" \
  --arg approval "$APPROVAL_SHA256" --arg reset "$RESET_SQL_SHA256" --arg d1 "$DATABASE_ID" \
  '{format:"blogman-clean-start-reset/v1",state:"reset",completed_at:$completed,
    candidate_id:$candidate,approval_packet_sha256:$approval,reset_sql_sha256:$reset,
    d1_database_id:$d1,attempt_count:1}' > "$REPORT_DIR/clean-start-reset-report.json"
```

Wrangler 4.86.0 writes one fixed non-interactive progress prefix before the JSON
result for remote file execution. The repository parser accepts only that exact
prefix (or plain JSON) followed by one deterministic successful file envelope.
Do not run the reset command twice. A non-zero or indeterminate child result
consumes this attempt. Preserve the private output and stop; do not infer that
the database is empty.

## 5. Empty D1 proof and empty-database migration plan

Classification: production read-only after reset.

```bash
verify_config_identity
"$WRANGLER" d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-after-reset.json"
test "$(jq -er .uuid "$REPORT_DIR/d1-info-after-reset.json")" = "$DATABASE_ID"

EMPTY_PRIVATE="$REPORT_DIR/empty-schema-private.json"
install -m 600 /dev/null "$EMPTY_PRIVATE"
verify_config_identity
"$WRANGLER" d1 execute "$DATABASE" --remote -c "$CONFIG" --json \
  --command "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND NOT (type = 'table' AND (name,tbl_name) IN (('_cf_KV','_cf_KV'),('_cf_METADATA','_cf_METADATA'))) ORDER BY type,name" \
  > "$EMPTY_PRIVATE"
jq -e 'type == "array" and length > 0 and .[-1].success == true
  and (.[-1].results | length) == 0' "$EMPTY_PRIVATE" >/dev/null

EMPTY_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg checked "$EMPTY_CHECKED_AT" --arg candidate "$EXPECTED_CANDIDATE" \
  --arg approval "$APPROVAL_SHA256" --arg reset "$RESET_SQL_SHA256" --arg d1 "$DATABASE_ID" \
  '{format:"blogman-clean-start-empty/v1",state:"verified-empty",checked_at:$checked,
    candidate_id:$candidate,approval_packet_sha256:$approval,reset_sql_sha256:$reset,
    d1_database_id:$d1,application_object_count:0,migration_ledger_state:"absent"}' \
  > "$REPORT_DIR/clean-start-empty-report.json"

verify_config_identity
node "$TOOL_WORKSPACE/scripts/migrations.mjs" plan --database "$DATABASE" --remote --config "$CONFIG" \
  --failure-report "$REPORT_DIR/production-plan-failure.json" \
  > "$REPORT_DIR/production-plan-empty.json"
jq -e '.state == "pending" and (.applied|length)==0 and (.pending|length)==6
  and ([.pending[].number] == [1,2,3,4,5,6])
  and ([.pending[].action] | all(. == "apply"))' \
  "$REPORT_DIR/production-plan-empty.json" >/dev/null

PLAN_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
RESET_REPORT_SHA256=$(shasum -a 256 "$REPORT_DIR/clean-start-reset-report.json" | awk '{print $1}')
EMPTY_REPORT_SHA256=$(shasum -a 256 "$REPORT_DIR/clean-start-empty-report.json" | awk '{print $1}')
jq -n --arg checked "$PLAN_CHECKED_AT" --arg candidate "$EXPECTED_CANDIDATE" \
  --arg d1 "$DATABASE_ID" --arg reset "$RESET_REPORT_SHA256" --arg empty "$EMPTY_REPORT_SHA256" \
  --slurpfile plan "$REPORT_DIR/production-plan-empty.json" \
  '{format:"blogman-clean-start-empty-plan/v1",state:"verified-empty-plan",
    checked_at:$checked,candidate_id:$candidate,d1_database_id:$d1,
    reset_report_sha256:$reset,empty_report_sha256:$empty,
    migrations:($plan[0].pending | map({number,name,checksum,action}))}' \
  > "$REPORT_DIR/clean-start-empty-plan-report.json"
```

This plan must not baseline an existing schema. Any application object, ledger row, missing migration, `baseline` action, or D1 UUID drift stops before apply. Historical baseline queries are `NOT_APPLICABLE` because the bound database is proven empty.

## 6. Verify the clean-start pre-migration candidate

Assemble `blogman-pre-migration-candidate/v2` with `delivery_mode=clean-start`. It binds the approval packet, reset SQL, reset report, empty report, uploaded version, local migration verify, local expected reconciliation, Workerd smoke, test report, and migration set. It has no backup field and cannot satisfy final candidate verification.

```bash
node "$TOOL_WORKSPACE/scripts/rollout-safety.mjs" candidate verify-pre-migration \
  --evidence "$REPORT_DIR/pre-migration-candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile "$LOCKFILE" \
  --build "$BUILD_ZIP" --version "$UPLOADED_VERSION_ID" --d1-database "$DATABASE_ID" \
  --reseal-request "$RESEAL_REQUEST" --sealed-package "$SEALED_PACKAGE" \
  --build-directory-proof "$REPORT_DIR/upload-build-directory-proof.json" \
  --clean-start-upload-report "$REPORT_DIR/clean-start-upload-report.json" \
  --clean-start-reset-report "$REPORT_DIR/clean-start-reset-report.json" \
  --clean-start-empty-report "$REPORT_DIR/clean-start-empty-report.json" \
  --clean-start-empty-plan-report "$REPORT_DIR/clean-start-empty-plan-report.json" \
  --migration-verification-report "$REPORT_DIR/local-verify.json" \
  --reconciliation-report "$REPORT_DIR/local-reconciliation.json" \
  --smoke-runtime-report "$REPORT_DIR/empty-migrated-workerd-smoke.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  > "$REPORT_DIR/pre-migration-candidate-verify.json"
jq -e '.state == "verified" and .phase == "pre-migration"' \
  "$REPORT_DIR/pre-migration-candidate-verify.json" >/dev/null
```

## 7. Apply and verify migrations 001–006

Classification: production D1 write, then read-only verification.

```bash
verify_config_identity
node "$TOOL_WORKSPACE/scripts/migrations.mjs" apply --database "$DATABASE" --remote --config "$CONFIG" \
  --candidate "$EXPECTED_CANDIDATE" > "$REPORT_DIR/production-apply.json"
verify_config_identity
node "$TOOL_WORKSPACE/scripts/migrations.mjs" verify --database "$DATABASE" --remote --config "$CONFIG" \
  > "$REPORT_DIR/production-verify.json"
```

Require `state=current`, then `state=verified`, applied migrations exactly 001–006, empty pending list, canonical checksums, and every ledger `candidate_id` equal to the exact candidate. Capture the migration summary and compare production to `expected-production-after.json` across schema, ledger, post count, post status, and post content. A fresh canonical database contains seed settings/actions/categories but zero posts; these business facts are expected and must match the local empty-D1 rehearsal.

## 8. CAS2, traffic, rollback and controls

Recheck deployment baseline, uploaded version identity, config, exact D1 UUID, migration verify, and final reconciliation. Then deploy only the frozen uploaded version:

```bash
verify_config_identity
"$WRANGLER" versions deploy "$UPLOADED_VERSION_ID@100%" -y -c "$CONFIG"
verify_config_identity
"$WRANGLER" deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-after.json"
DEPLOYMENT_ID=$(jq -er .id "$REPORT_DIR/deployment-after.json")
readonly DEPLOYMENT_ID
```

Require exactly one version at 100%. Producer, authority, and all executors remain disabled through T0. The rollback proof is asymmetric:

- before traffic, stop and forward-fix without changing traffic;
- after traffic, an explicitly approved emergency action may restore only the captured baseline Worker version to 100%; this invalidates the candidate and never restores or clears D1;
- D1 recovery is always forward migration/reconciliation; discarded historical data is not recoverable by this contract.

## 9. Same-version smoke, reconciliation and T0

Run the six real GET paths without retaining response bodies. The five collection/settings paths must return 200. Because the clean-start database has zero posts, the authenticated admin-article read uses the fixed absent slug and must return 404; creating a smoke-only post is forbidden. Recheck deployment/version/D1 before and after smoke. Compare final D1 to the local expected snapshot and record all five dimensions as `matched`. Capture rollout controls as disabled and audit unresolved high-priority anomalies as zero.

```bash
verify_config_identity
"$WRANGLER" d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-t0-before.json"
test "$(jq -er .uuid "$REPORT_DIR/d1-info-t0-before.json")" = "$DATABASE_ID"

SMOKE_SEARCH_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' "$PUBLIC_ORIGIN/api/search?q=blogman")
SMOKE_APPEARANCE_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' "$PUBLIC_ORIGIN/api/settings/appearance")
SMOKE_ADMIN_ARTICLE_STATUS=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/posts/$CLEAN_START_MISSING_SLUG")
SMOKE_TOKENS_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/tokens")
SMOKE_AI_PROVIDER_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/ai-provider")
SMOKE_AI_GENERATORS_STATUS=$(curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --cookie "$ADMIN_COOKIE_FILE" "$PUBLIC_ORIGIN/api/admin/ai-post-generators")
test "$SMOKE_SEARCH_STATUS" = 200
test "$SMOKE_APPEARANCE_STATUS" = 200
test "$SMOKE_ADMIN_ARTICLE_STATUS" = 404
test "$SMOKE_TOKENS_STATUS" = 200
test "$SMOKE_AI_PROVIDER_STATUS" = 200
test "$SMOKE_AI_GENERATORS_STATUS" = 200
SMOKE_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')

verify_config_identity
"$WRANGLER" deployments status --json -c "$CONFIG" \
  | jq '{id,created_on,versions:[.versions[]|{version_id,percentage}]}' \
  > "$REPORT_DIR/deployment-after-smoke.json"
cmp "$REPORT_DIR/deployment-after.json" "$REPORT_DIR/deployment-after-smoke.json"

verify_config_identity
node "$TOOL_WORKSPACE/scripts/rollout-safety.mjs" reconcile compare \
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
"$WRANGLER" d1 info "$DATABASE" --json -c "$CONFIG" \
  | jq '{uuid}' > "$REPORT_DIR/d1-info-t0-after.json"
test "$(jq -er .uuid "$REPORT_DIR/d1-info-t0-after.json")" = "$DATABASE_ID"

jq -n --arg candidate "$EXPECTED_CANDIDATE" --arg build "$BUILD_SHA256" \
  --arg deployment "$DEPLOYMENT_ID" --arg version "$UPLOADED_VERSION_ID" --arg d1 "$DATABASE_ID" \
  --arg checked "$SMOKE_CHECKED_AT" \
  --argjson search "$SMOKE_SEARCH_STATUS" --argjson appearance "$SMOKE_APPEARANCE_STATUS" \
  --argjson admin_article "$SMOKE_ADMIN_ARTICLE_STATUS" --argjson tokens "$SMOKE_TOKENS_STATUS" \
  --argjson ai_provider "$SMOKE_AI_PROVIDER_STATUS" --argjson ai_generators "$SMOKE_AI_GENERATORS_STATUS" \
  '{format:"blogman-production-smoke/v2",checked_at:$checked,d1_database_id:$d1,
    checks:{search:$search,appearance:$appearance,admin_article:$admin_article,tokens:$tokens,ai_provider:$ai_provider,ai_generators:$ai_generators},
    state:"passed",candidate_id:$candidate,build_sha256:$build,deployment_id:$deployment,version_id:$version}' \
  > "$REPORT_DIR/production-smoke.json"

jq -e '.format == "blogman-rollout-state/v1" and .state == "captured"
  and .controls.producer == "disabled" and .controls.authority == "disabled"
  and ([.controls.executors[]] | all(. == "disabled"))' \
  "$REPORT_DIR/rollout-state.json" >/dev/null
BASELINE_VERSION_ID=$(jq -er .expected_baseline.version_id "$APPROVAL_PACKET")
ROLLOUT_REPORT_SHA256=$(shasum -a 256 "$REPORT_DIR/rollout-state.json" | awk '{print $1}')
ROLLBACK_CHECKED_AT=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
jq -n --arg checked "$ROLLBACK_CHECKED_AT" --arg candidate "$EXPECTED_CANDIDATE" \
  --arg baseline "$BASELINE_VERSION_ID" --arg version "$UPLOADED_VERSION_ID" \
  --arg d1 "$DATABASE_ID" --arg rollout "$ROLLOUT_REPORT_SHA256" \
  '{format:"blogman-clean-start-rollback-control-proof/v1",state:"proved",
    checked_at:$checked,candidate_id:$candidate,baseline_version_id:$baseline,
    candidate_version_id:$version,d1_database_id:$d1,
    traffic_restore_scope:"baseline-worker-version-only",d1_recovery:"forward-only",
    discarded_data_recoverable:false,rollout_report_sha256:$rollout}' \
  > "$REPORT_DIR/rollback-control-proof-report.json"
```

Create `blogman-t0-acceptance/v2`; besides the v1 identity/migration/smoke/reconciliation/anomaly bindings it must include:

```json
{
  "delivery_mode": "clean-start",
  "clean_start_reset_report_sha256": "<64 hex>",
  "clean_start_empty_report_sha256": "<64 hex>",
  "clean_start_upload_report_sha256": "<64 hex>",
  "clean_start_empty_plan_report_sha256": "<64 hex>",
  "rollback_control_proof_sha256": "<64 hex>"
}
```

Assemble `blogman-rollout-candidate/v3` with `delivery_mode=clean-start` and a `clean_start` object binding the approval packet, reset SQL, reset report, empty report, and all three `NOT_APPLICABLE` dispositions. It has no backup field.

```bash
node "$TOOL_WORKSPACE/scripts/rollout-safety.mjs" candidate verify \
  --evidence "$REPORT_DIR/candidate.json" \
  --candidate "$EXPECTED_CANDIDATE" --lockfile "$LOCKFILE" --build "$BUILD_ZIP" \
  --deployment "$DEPLOYMENT_ID" --version "$UPLOADED_VERSION_ID" --d1-database "$DATABASE_ID" \
  --reseal-request "$RESEAL_REQUEST" --sealed-package "$SEALED_PACKAGE" \
  --build-directory-proof "$REPORT_DIR/upload-build-directory-proof.json" \
  --clean-start-upload-report "$REPORT_DIR/clean-start-upload-report.json" \
  --clean-start-reset-report "$REPORT_DIR/clean-start-reset-report.json" \
  --clean-start-empty-report "$REPORT_DIR/clean-start-empty-report.json" \
  --clean-start-empty-plan-report "$REPORT_DIR/clean-start-empty-plan-report.json" \
  --rollback-control-proof "$REPORT_DIR/rollback-control-proof-report.json" \
  --migration-report "$REPORT_DIR/migration-report.json" \
  --migration-verification-report "$REPORT_DIR/production-verify.json" \
  --reconciliation-report "$REPORT_DIR/reconciliation-report.json" \
  --smoke-report "$REPORT_DIR/production-smoke.json" \
  --smoke-runtime-report "$REPORT_DIR/empty-migrated-workerd-smoke.json" \
  --rollout-report "$REPORT_DIR/rollout-state.json" \
  --test-report "$REPORT_DIR/test-report.json" \
  --t0-report "$REPORT_DIR/t0-report.json" \
  --anomaly-report "$REPORT_DIR/anomaly-audit.json" \
  > "$REPORT_DIR/t0-candidate-verify.json"
jq -e '.state == "verified" and .phase == "batch-1-t0" and .d1_database_id == $d1' \
  --arg d1 "$DATABASE_ID" "$REPORT_DIR/t0-candidate-verify.json" >/dev/null
```

Only this terminal result passes T0. It requires exact candidate/build/deployment/version/D1, clean-start approval/reset/empty proof, migrations 001–006, schema/ledger/business reconciliation, six real critical paths, controls disabled, rollback proof, and zero unresolved high-priority anomalies. T0 PASS completes #23 immediately; there is no calendar wait. #23 remains open and #24 remains blocked until that separately authorized production event occurs.
