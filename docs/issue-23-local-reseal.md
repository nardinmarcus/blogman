# Issue #23 local T0 reseal

`scripts/issue-23-reseal.mjs` is the repository-owned generator and verifier for
the current local-only Issue #23 T0 quartet:

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
- immutable long-runner run `30431198339`, job `90508593330`, accepted head
  `91b223430ae92e3510d6767166c112aa94230282`, tree
  `ddbe51814fb037dce98d1aa73b8c1f5b008c8d43`, 46/46 result, raw log SHA
  `d43a3d6f616a3b2adb55a08b1bc6a17c1d64e737c2b8756b81c64969bc46bc48`,
  migration runner source blob `89315421c9179aa5740dbe5ab97207373b9f8860`,
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
recompute every object with `git rev-parse HEAD:<path>`; a new candidate cannot
self-report replacement object IDs because the request schema fixes them to
the immutable long-run evidence.

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

All input paths are normalized. Repository and artifact roots, the requested
seal-input path and root, bound files, and the migration directory retain their
requested and real identities. Migration membership is the filtered, sorted
runner set and is checked before reading members, after reading them, and again
around the final byte recheck. Package validation similarly checks the exact
four-entry directory before and after reading files, then repeats the complete
membership and byte check after the final live-context verification.

The output must be an absolute repository-external path whose parent does not
exist. Its existing real grandparent must also resolve outside the repository.
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
npm run issue-23:reseal -- seal \
  --input /private/issue-23/reseal-input.json \
  --repo /absolute/path/to/blogman \
  --artifacts /private/issue-23/build \
  --output /private/issue-23-sealed-t0/package
```

`/private/issue-23-sealed-t0` must not exist before this command.

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
  --repo /absolute/path/to/blogman \
  --artifacts /private/issue-23/build \
  --package /private/issue-23/sealed-t0
```

`verify` regenerates the expected quartet in memory and compares every package
file byte-for-byte. Only the coherent current v4 tuple is eligible here. A
coherent historical v2 or v3 tuple remains accepted by `validate --package` as
`state=valid-historical, acceptance_authority=false`, but current `verify`
rejects it as stale; mixed-version tuples are rejected. The tool does not query GitHub: the request's quick-CI
identity and raw-log hash must come from separately reviewed immutable GitHub
evidence. Removing an external sealed directory is the complete local rollback;
the tool performs no production mutation.
