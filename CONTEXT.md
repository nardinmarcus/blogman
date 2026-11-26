# Blogman

This context defines the canonical article write and read vocabulary.

## Language

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

**Article Command Client**:
The single client-side seam through which admin surfaces (list rows, the batch bar, the password modal) issue every command on the `/api/article-commands` wire: request building, operation-id generation, and normalized outcomes. Targets without versioned authority are refused client-side (ADR 0011 retired the ledger-only legacy PUT bypass). It is the client counterpart of the wire route — distinct from the editor save protocol in `editor-command-transport` and from the Article-Level Command domain concept it transports.
_Avoid_: editor-command-transport, the Article-Level Command domain concept, per-caller fetch wrappers

**Publication Intent**:
The single mapping from canonical facts (versioned authority, formal publication, lifecycle status) to the ONE publish-surface action and its copy: the first-publish confirmation page, an unpublish/relive command, or a client-side refusal. Editors' save-time status toggles (publishTemp via the save coordinator) and the external write API are out of scope.
_Avoid_: publish-button branching, per-caller publish-command guessing, first-publish vs relive heuristics
