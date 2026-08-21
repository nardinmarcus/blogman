# Blogman Delivery Control Plane

This context defines the production-delivery facts and authority relationships used to complete Blogman Issue #23 without treating runtime state or operator tooling as a source of truth.

## Language

**Issue #23 Delivery**:
The Issue #23-specific process that prepares and, under a separately verified authorization, attempts the Batch 1 production migration and T0 acceptance exactly once.
_Avoid_: Generic deployment, Phase B script, release platform

**Canonical Frozen Manifest**:
The single immutable record of the facts, identities, policies, and fixed production plan that an Issue #23 Delivery may execute. It is the only input allowed to determine production behaviour.
_Avoid_: Bundle, packet, runner state, runtime cache

**Authorization**:
An immutable user decision bound to exactly one Canonical Frozen Manifest hash that permits one execution invocation without adding or overriding any production behaviour.
_Avoid_: Approval packet, runtime flag, plan override

**Delivery Preparation**:
A repeatable, deterministic, and production-read-only process that resolves every locally provable delivery fact and produces a Canonical Frozen Manifest.
_Avoid_: Dry run, pre-authorization execution, partial delivery

**Delivery Attempt**:
The single invocation created when an Authorization is presented to the formal Issue #23 Delivery execution entry. It is terminal after its first failure, timeout, uncertainty, or successful T0 acceptance.
_Avoid_: Retry, continuation, resumed run

**Stage**:
One named, strictly ordered transition in a Delivery Attempt. A Stage may be entered at most once, and no later Stage may begin after it fails.
_Avoid_: Callback, optional step, retry unit

**Manifest Drift**:
A mismatch between a live production precondition and the corresponding fact frozen in the Canonical Frozen Manifest.
_Avoid_: Cache miss, warning, acceptable difference

**Terminal Result**:
The immutable final account of a Delivery Attempt, binding its manifest and authorization identities to the first terminal outcome, Stage counters, and evidence hashes.
_Avoid_: Success marker, mutable status, console log

**Production Evidence**:
Evidence produced by real adapters during the single authorized Delivery Attempt and bound through the Terminal Result to its exact manifest.
_Avoid_: Test fixture, synthetic rehearsal, screen state

**Upload Child Evidence**:
Bounded (64 KiB cap) stdout/stderr captured from the single upload child of the authorized Worker deploy, persisted hash-named (sha256.stdout / sha256.stderr) under the durable sink's `upload-evidence/` directory on success and failure. The acceptance and Worker stage receipt keep only the hash references — never the raw bytes.
_Avoid_: Transport temp tree storage, raw output in canonical records, unbounded captures

### Article Write Model

**Canonical Facts**:
The only authoritative records of article identity, content versions, formal publication, and lifecycle transitions. Every read and write resolves against them; nothing else may be treated as authoritative.
_Avoid_: Shadow layer, source-of-truth copy, dual write target

**Compat Projection**:
The frozen, rebuildable mirror of canonical facts kept only for legacy compatibility. It is never authoritative and receives no new writes.
_Avoid_: Legacy table, authority, second source of truth

**Post Ref**:
The legacy numeric identifier carried on an article identity for compatibility with the Compat Projection era. It carries no meaning beyond uniqueness and is no longer derived from the projection.
_Avoid_: Post id, row number

**Slug Address Registry**:
The single record of every public address ever bound to an article, classified as current, candidate, or historical. Slug exclusivity and resolution resolve only against it.
_Avoid_: Slug lookup table, title slug

**Article-Level Command**:
A state change that does not revise body content (pin, hide, password, category, soft delete, restore), recorded as its own immutable version snapshot.
_Avoid_: Field patch, in-place update, side-table write
