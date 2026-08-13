# Issue #23 historical evidence audit

Historical Issue #23 pre-interface records are immutable audit material. They are not a delivery plan, candidate, authorization, retry token, or compatibility input for the current `prepare(config)` / `execute(manifest, authorization)` interface.

Use `npm run issue-23:audit -- audit --document <absolute-path>` to inspect one historical document, or `npm run issue-23:audit -- audit --package <absolute-directory>` to inspect a historical package. The adapter validates exact canonical bytes, the matching frozen schema, SHA-256 identity, package membership, and historical cross-bindings. Its output is sanitized and non-promotable.

The audit adapter is read-only:

- it does not prepare, seal, verify, repair, rewrite, copy, or migrate evidence;
- it does not create a Canonical Frozen Manifest, Authorization, Terminal Result, bundle, marker, closure record, or candidate projection;
- it does not call GitHub, Cloudflare, Wrangler, D1, Worker, traffic, smoke, or production adapters;
- it does not authorize or enter the current delivery state machine; and
- it rejects unknown formats, mixed contract versions, non-canonical bytes, and unsupported commands.

Historical schemas and fixtures stay in their existing repository paths so prior evidence remains attributable. The current delivery implementation, reconciliation, control-status, prepare, and execute paths do not import this adapter or any historical schema. Retired candidate and control-mutation commands are not compatibility routes into the adapter.
