# Issue #23 Delivery operator runbook

This document describes how an operator invokes the repository-owned Issue #23 Delivery interface. It is not an executable production sequence. The module owns command construction, parsers, Stage order, deadlines, drift policy, and evidence handling.

Nothing in this document grants production authority. Preparing, reviewing, or auditing evidence does not authorize a deployment, D1 mutation, Worker change, traffic change, smoke request, or retry.

## Delivery Preparation

Run the public `prepare(config)` interface through `npm run issue-23:prepare` with the reviewed configuration path. Preparation is repeatable and production-read-only. It resolves repository, CI, toolchain, artifact, migration, target, policy, and target-macOS rehearsal facts into one Canonical Frozen Manifest.

Preparation must finish with:

- canonical schema-ordered UTF-8 JSON bytes;
- one SHA-256 identity for those exact bytes;
- a clean exact repository commit and tree;
- a successful exact-candidate CI identity;
- the frozen artifact, migration, target, Stage, timeout, drift, and evidence facts;
- a target-macOS no-network runtime receipt; and
- zero production-write adapter calls.

A preparation failure is corrected before review. It is not an execution attempt and must not be worked around with operator commands or a second plan.

## Independent Review

A fresh, independently visible read-only task reviews the exact manifest bytes, manifest SHA-256, formal prepare entry, formal execute entry, repository commit/tree, CI identity, artifact identities, target bindings, and rehearsal receipt.

The reviewer must confirm that the manifest is the only production plan input and that no callback, Stage override, alternate target, runtime configuration, historical record, or synthetic evidence can enter execution. Findings require a new preparation from the corrected integrated candidate. Review prose or a hash copied from another candidate is not sufficient.

## Exact Authorization

Authorization is a separate immutable decision record bound to exactly one reviewed Canonical Frozen Manifest SHA-256. It contains only the authorization format, a unique authorization identity, the exact manifest SHA-256, and the approval decision.

Authorization cannot carry commands, targets, credentials, Stage changes, timeout changes, adapter selection, or recovery instructions. It is consumed when the exact manifest and Authorization enter `execute(manifest, authorization)`. Any later failure, timeout, crash, drift, or uncertainty is terminal. The same Authorization cannot be retried, resumed, replaced, or transferred to different bytes.

Credentials remain outside all canonical records and are available only through the module's private production adapters at the authorized entry.

## Execute

The operator invokes only the public `execute(manifest, authorization)` interface. The operator does not run individual production Stages or reconstruct their shell commands.

Execution validates and consumes the exact Authorization, checks frozen live preconditions, and then runs the fixed repository-owned state machine once. The first non-PASS outcome stops the suffix. A failed Stage has one attempt; every later Stage remains at zero. Manifest Drift always terminates the attempt.

The module owns D1 identity, clean-start reset, empty proof, migrations 001–006, reconciliation, frozen Worker upload/deploy, exact version and traffic verification, smoke/control/T0 checks, and bounded evidence capture. External output is parsed inside the adapters and never becomes an operator-selected execution input.

## Terminal Result

Every invocation is represented by one immutable Terminal Result bound to the exact manifest, Authorization, and attempt identities. It records the first terminal cause, Stage counts and durations, mutation counts, and sanitized evidence hashes. Secret values, SQL bodies, raw private adapter output, and private operator paths remain excluded.

A finalized PASS may advance only through the separately authorized acceptance process. NON_PASS, ERROR, TIMEOUT, UNCERTAIN, or a consumed invocation without a finalized Terminal Result is terminal for that lineage. Preserve its evidence and open a separate read-only adjudication task; do not retry or repair the attempt.

Historical pre-interface schemas and evidence remain inspectable only through `npm run issue-23:audit`. Audit output is read-only, non-promotable, and cannot be converted into a Canonical Frozen Manifest, Authorization, Terminal Result, or execution input.
