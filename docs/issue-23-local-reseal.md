# Issue #23 local T0 reseal

`scripts/issue-23-reseal.mjs` is the repository-owned generator and verifier for
the current local-only Issue #23 input evidence and T0 quartet:

- `input-evidence-manifest.json` —
  `blogman-issue-23-input-evidence-manifest/v2`

- `preflight-candidate.json` — `blogman-local-preflight-candidate/v2`
- `approval-packet.json` — `blogman-issue-23-approval-packet/v4`
- `pre-cas-bindings.json` — `blogman-issue-23-pre-cas-bindings/v4`
- `package-manifest.json` — `blogman-issue-23-package-manifest/v4`

This tool does not create a formal production candidate, grant production
authorization, contact Cloudflare, run Wrangler, mutate D1, apply migrations,
upload a version, change traffic, run production smoke/reconciliation, or start
T0. A successful seal has `production_authorization_granted=false`,
`production_counters_all_zero=true`, and every Phase B stage count at `0`.
The approval packet's historical
`state=ready-for-fresh-production-authorization` means that a separate,
candidate-bound authorization is still required.

## Canonical bytes and hashes

Each JSON schema in `schemas/issue-23-reseal/` is closed with
`additionalProperties=false`. Canonical JSON is the schema property order,
two-space indentation, UTF-8, and exactly one trailing LF:

```js
`${JSON.stringify(valueInSchemaOrder, null, 2)}\n`
```

Every SHA-256 binds those raw canonical bytes. The generator writes the
preflight first, binds its SHA into the approval packet, binds the approval SHA
into PRE-CAS, and binds all three into the package manifest. The v4 approval
scope binds one in-place reset of the existing D1 UUID, an empty-D1 proof,
migrations 001–006, traffic, rollback/control proof, and immediate T0 event
acceptance. It also binds the reset SQL hash and marks production export, double
restore, and historical baseline queries as `NOT_APPLICABLE`. The v4 package
manifest repeats those three values in its required, closed
`historical_data_disposition` object; missing, additional, or changed disposition
members invalidate the quartet. Historical v2/v3
packages remain valid byte-for-byte for read-only validation and have
`acceptance_authority=false`.

## Canonical input evidence

The current input-evidence contract is repository-owned
`blogman-issue-23-input-evidence-manifest/v2`. The earlier authorized recovery
recorded v2; an evidence-local v1 schema is not a current-main authority and
must not be copied into a new lineage. The v2 manifest is always named
`input-evidence-manifest.json` beside the canonical v3 reseal request. The
running tool validates its canonical bytes against
`schemas/issue-23-reseal/blogman-issue-23-input-evidence-manifest-v2.schema.json`
and verifies that the frozen snapshot contains the same schema bytes and hash.

The manifest fixes `nardinmarcus/blogman`, candidate commit/tree/parents, exact
completed/success main push CI, request/runbook/schema/build paths and SHA-256
values, root/file modes, full-tree counts, false authorization flags, zero
formal production/Cloudflare/D1/Phase B mutation counters, and all twelve zero
stage counters. Closed objects reject unknown production-write fields. A
terminal lineage may appear only in `lineage_policy.denylist` or history;
`input_dependencies` is empty, and denied paths cannot name the frozen root,
snapshot, request, artifacts, or any request dependency.

`prepare`, `seal`, and `verify` all load this same manifest through the same
context boundary. A missing, non-canonical, wrong-version, wrong-hash, or
mutating manifest stops before the seal output parent is reserved.
The adversarial seal tests have a scoped 15-second per-test budget because they
launch real Git/Node children and hash complete frozen fixtures; this is test
budgeting only and does not add or change a reseal runtime timeout.

`canonical_long_migration_runner` accepts the historical `unverified` object
or the current verified object `{state:"passed",passed:46,failed:0}`. The
preflight v2 top-level fields do not change. The package manifest retains the
`github_ci:"pending"` string. GitHub run/job details are external seal
prerequisites and are not represented as self-contained package evidence.

## Frozen input

The seal request must be canonical
`blogman-issue-23-local-reseal-request/v3`, validated by
`blogman-issue-23-local-reseal-request-v3.schema.json`. Historical request/v1
and v2 bytes remain valid under their original schemas, but current `seal` and
`verify` reject them as stale. The current request binds:

- clean Git `HEAD` and `HEAD^{tree}`;
- lockfile, runbook, migration set, migration `001` SQL/ledger/baseline, and
  remote-baseline companion SHA-256 values;
- an existing build ZIP, worker, and canonical source-tree manifest;
- local test/build/review gates;
- the current quick-CI head/tree, terminal result, counts, and raw log SHA;
- immutable long-runner run `30980976783`, job `92225128585`, accepted head
  `dd5f9bc13afc0297747756e5ae731d4d29d27a8c`, tree
  `3fdce4111059f5047213d66be4710b3c4880da41`, 46/46 result, raw log SHA
  `90801ccabe8e11569b721379531867a6a2220d2498734bcb2ed012039bdcd424`,
  migration runner source blob `e026c61529c6f96d30f4415a0697ad70a8ba38c4`,
  and the other nine unchanged repository coverage objects;
- the expected production deployment/version/D1 baseline.
- `delivery_mode=clean-start`, the candidate-bound reset SQL SHA-256, the
  in-place-reset strategy, and all three historical-data dispositions.

The inherited 46/46 result is valid only while the current candidate resolves
the following Git objects to the same IDs as the immutable long-run head:

- blobs for `scripts/migrations.mjs`,
  `tests/migrations/migration-runner.test.ts`, `package-lock.json`,
  `db/schema.sql`, `db/seed-template.sql`, `wrangler.toml`,
  `lib/ai-provider-profiles.ts`, and
  `lib/ai-post-generator/constants.ts`;
- trees for `db/ledger-migrations` and `db/migrations`.

These are the runner, the long test, its dependency lock, and every direct
repository semantic dependency read or runtime-imported by that test.
Type-only imports do not expand the runtime coverage set. `seal` and `verify`
resolve every object from the bound candidate tree with raw `git ls-tree`, then
require the resulting blob/tree locally with `git cat-file -t`; a new candidate
cannot self-report replacement object IDs because the request schema fixes them
to the immutable long-run evidence.

The migration-set SHA is:

```js
sha256(JSON.stringify(
  sortedMigrationNames.map(name => ({ name, sha256: sha256(rawFileBytes) }))
))
```

Migration names match `/^\d{3}_.+\.(?:sql|data\.mjs)$/` and use JavaScript's
default `.sort()`. Migration `001` retains the runner-owned ledger checksum
`sha256(mainSql + NUL + baselineSql)`, currently
`8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05`.
The remote-baseline companion is bound separately and does not change that
ledger identity. Build-tree manifest paths retain the historical
`path.localeCompare` ordering; this differs from default `.sort()` for real
OpenNext paths such as `_next` and `BUILD_ID`.

The request schema freezes the accepted runbook, migration-set, migration
`001`, baseline, ledger checksum, and remote-baseline companion identities to
the values audited for Issue #23. The build ZIP must contain exactly the
regular files in the canonical tree manifest, with matching path, byte count,
and SHA-256. Its worker entry must match the separately frozen worker SHA.
The verifier reads the ZIP once, proves every central-directory entry is a
regular file from its host/type attributes, and decompresses each entry in
memory from that same captured buffer. It never extracts the archive to disk,
so a symlink entry cannot pivot a later child write outside a temporary root.

The dependency/build workspace and frozen evidence root are separate. Install
Node packages, run tests, and build OpenNext in the workspace; then copy only
the final repository snapshot, canonical request, canonical input-evidence
manifest, and bound artifacts into a fresh mode-`0700` frozen root. The frozen
snapshot is also mode `0700`; request and manifest are mode `0600`. Recursively,
the complete frozen root—not only the governed file index or `.open-next`
allowlist—must contain no symlink, no regular file with link count other than
one, no special file, no realpath escape, and no `node_modules` or `toolchain`
entry. Build dependencies and executable toolchains stay outside that root.
The repository snapshot must be a self-contained non-bare worktree: its
effective top-level, absolute git-dir, common-dir, index, and primary object
directory all resolve inside the frozen root. Linked-worktree metadata, object
alternates, shallow repositories, replacement refs, partial-clone/promisor
configuration, config includes, and repository-affecting caller `GIT_*`
variables are rejected before Git identity is trusted. `GIT_PAGER` is discarded
as non-semantic; every Git child otherwise receives the same minimal environment
with system/global config and lazy fetching disabled. Local config is read
without includes and every effective local origin must resolve inside the frozen
root. Candidate tree and parents come from the raw bound commit object, and all
candidate, parent, tree, and inherited path objects must already exist locally.

The first complete-tree traversal captures a deterministic identity digest over
every relative entry path, type, POSIX mode, owner/group, link count, size, and
regular-file SHA-256. The final barrier recomputes that digest as well as the
declared counts, so an equal-count rename or byte replacement is not invisible.

A lineage that reaches `BLOCK`, consumed authorization, or another terminal
state is immutable history. Do not repair its schema, replace bytes, reseal it,
or continue in place. Prepare a new root and manifest from reviewed current
main instead.

All input paths are normalized. Repository and artifact roots, the requested
seal-input path and root, bound files, and the migration directory retain their
requested and real identities. Migration membership is the filtered, sorted
runner set and is checked before reading members, after reading them, and again
around the final byte recheck. Package validation similarly checks the exact
four-entry directory before and after reading files, then repeats the complete
membership and byte check after the final live-context verification.

The output must be an absolute repository- and frozen-root-external path whose
parent does not exist. Its existing real grandparent is resolved first; both the
derived output parent and final output path must be outside the repository and
the complete frozen root before the first `mkdir`.
On supported local POSIX filesystems, `seal` reserves the output in one shot by
creating that dedicated parent with one non-recursive `mkdir`, then forces and
verifies owner=current effective UID and mode `0700`. `EEXIST` means another or
stale reservation owns the path: the tool fails closed and never adopts,
steals, empties, or removes it. This is a cooperative single-writer guarantee
for invocations that all follow this reservation protocol; it is not a general
no-replace guarantee against root, ACL overrides, non-POSIX or network
filesystem semantics, same-UID processes that ignore/delete the reservation,
or older tools.

Bound file hashes and semantic checks use their originally captured buffers.
Immediately before publish, the tool rechecks Git identity, inherited long-run
coverage, request/root identities, migration membership, realpaths, and bytes.
A changed input therefore fails without a final package. On an ordinary
failure the tool first removes only its own staging directory, then removes the
dedicated parent with non-recursive `rmdir` only if its saved device/inode still
match and it is empty. A changed or nonempty parent is preserved as evidence;
cleanup diagnostics are appended without replacing the primary error.

## Commands

Use absolute paths:

```bash
npm run issue-23:reseal -- prepare \
  --input /private/issue-23/reseal-input.json \
  --repo /private/issue-23/snapshot \
  --artifacts /private/issue-23/artifacts

npm run issue-23:reseal -- seal \
  --input /private/issue-23/reseal-input.json \
  --repo /private/issue-23/snapshot \
  --artifacts /private/issue-23/artifacts \
  --output /private/issue-23-output/package
```

`/private/issue-23-output` must not exist before this command and must be
outside `/private/issue-23`, the frozen evidence root.

The generator creates the missing dedicated output parent as mode `0700`,
writes a mode-`0700` staging directory inside it, writes the four files as mode
`0400`, validates their schemas and cross-bindings, and performs one
same-parent rename. A completed package remains inside its reservation parent.
Repeated or concurrent cooperating seals fail at the parent reservation.

Validate historical or generated bytes without consulting source inputs:

```bash
npm run issue-23:reseal -- validate --document /absolute/path/document.json
npm run issue-23:reseal -- validate --package /absolute/path/sealed-t0-or-historical
```

Re-verify a seal against live local Git and frozen artifacts:

```bash
npm run issue-23:reseal -- verify \
  --input /private/issue-23/reseal-input.json \
  --repo /private/issue-23/snapshot \
  --artifacts /private/issue-23/artifacts \
  --package /private/issue-23-output/package
```

`verify` regenerates the expected quartet in memory and compares every package
file byte-for-byte. Only the coherent current v4 tuple is eligible here. A
coherent historical v2 or v3 tuple remains accepted by `validate --package` as
`state=valid-historical, acceptance_authority=false`, but current `verify`
rejects it as stale; mixed-version tuples are rejected. The tool does not query GitHub: the request's quick-CI
identity and raw-log hash must come from separately reviewed immutable GitHub
evidence. Removing an external sealed directory is the complete local rollback;
the tool performs no production mutation.
