# Blogman Issue #23 Delivery Program

goal_id: blogman-issue-23-delivery-program
goal_revision: 1
contract_status: armed
candidate_id: "git:7a11de76f9df7c2ed6b137d1e7758baab2b64967 is the terminal initial review candidate; stage-specific exact identities are recorded in evidence.md"

Outcome: Complete the governed Issue #23 delivery chain only when the native GitHub tracker path through #86–#101 has completed, a single separately authorized exact-manifest production Delivery Attempt has finalized PASS evidence, an independent acceptance review has passed, and #101 has verified the native #23 → #24 frontier. This contract does not promise Batch 2 or later product delivery.

Canonical sources: 

1. Live GitHub Issues #19, #23, #24, and #85–#101, including their native dependency relations, bodies, labels, and comments.
2. The exact candidate, PR, CI run, manifest, authorization, and Terminal Result named by the active child ticket.
3. `CONTEXT.md` and `docs/adr/` once they are integrated on canonical main.
4. This Goal package for program state and evidence links only; it never replaces GitHub as the work tracker.

On conflict, live tracker state and exact candidate evidence override this package; runtime cache, chat history, screen state, and a green CI badge do not.

Invariants:

- The Commander dispatches and tracks; each implementation, review, integration, preparation, authorization, production execution, and acceptance action runs in a fresh, dedicated task window.
- Work the first unblocked smallest ticket only. Do not start a dependent ticket before its native blockers and its required evidence pass.
- Every review, CI result, test report, manifest, authorization, and production receipt is bound to its exact candidate identity.
- Standards and Spec reviews remain independent. A green test, CI run, or PR status is not a substitute for either.
- The old frozen-runner and v1–v7 evidence remains historical read-only. No retry, repair, or continuation may reuse a consumed production lineage.
- Authorization contains no plan override. No production D1, Worker, traffic, or deployment action occurs before #98 records a fresh explicit authorization bound to the exact manifest and revision.

Boundaries: In scope: correction and re-review of #86; #87–#97 implementation, integration, manifest, rehearsal, and independent-review gates; #98 human authorization; #99 one production execution; #100 independent acceptance; #101 frontier confirmation.

Out of scope: Batch 2–8 implementation, generic delivery-platform work, a new R7/bundle hierarchy, untracked side work, production rollback/compensation, or treating local rehearsal as production acceptance.

Authority:

The Commander may read canonical sources, create and monitor dedicated task windows, dispatch the next unblocked ticket, and record checkpoints in this package.

Child tasks may perform only the read/write actions explicitly permitted by their assigned Issue and fresh worktree. Source changes, commits, PR updates, tracker mutations, and merges remain ticket-scoped. #98 requires explicit human authorization. #99 may perform exactly one production attempt only after #98 passes and only with an exact manifest-bound authorization. No other stage grants production authority.

Approval required: A fresh explicit human authorization at #98, bound to this Goal revision, the exact manifest SHA-256, and the exact #99 action, is required before any production D1, Worker, traffic, or deployment mutation.

Completion evidence:

| Stage | Ticket frontier | Required fresh evidence | Claim ceiling |
| --- | --- | --- | --- |
| S0 | Correct #86 P1 | Native #19 ↔ #23 authority relation or an approved corrected authority statement; readable tracker receipt | Tracker authority only |
| S1 | #86 | Candidate-bound independent Standards PASS and Spec PASS | Architecture documents are reviewable |
| S2 | #87–#93 | Per-ticket focused tests, required integration evidence, and reviews on exact candidates | Local implementation/rehearsal only |
| S3 | #94–#97 | Independent implementation review, canonical-main CI, exact manifest, and independent manifest/entry review | Candidate is ready for authorization review |
| S4 | #98 | Explicit human authorization bound to the exact manifest and action | One attempt is permitted, not successful |
| S5 | #99 | One serialized real-adapter execution, finalized Terminal Result, and counters/evidence bound to the manifest | One observed attempt only |
| S6 | #100–#101 | Independent acceptance PASS, real T0 evidence, and live native frontier readback | Issue #23 complete and #24 unblocked |

For every evidence item, record the producer, expected work, positive execution proof, readable oracle, observed time, exact target, digest or URL, and PASS/FAIL/INCONCLUSIVE result in `evidence.md`. Missing, stale, interrupted, ambiguous, zero-work, or candidate-mismatched evidence is INCONCLUSIVE, never PASS.

Progress:

`state.md` is a compact projection of the active stage, current child task windows, wait conditions, and last safe checkpoint. `evidence.md` is append-only. Each Commander checkpoint records Done, Evidence, Remaining, Next, current wait/blocker, and last safe checkpoint.

Before dispatching or resuming a child task, reread its Issue, native blockers, exact target identity, current PR/CI state, and any active task window. If a child action may already have mutated GitHub or production, reread durable receipts before any retry. Never resume a consumed #99 attempt.

Recovery:

Before resuming, reread the active child Issue, native blockers, exact target identity, current PR/CI state, and any active task window. If a child action may already have mutated GitHub or production, reread durable receipts before any retry. Never resume a consumed #99 attempt.

Execution:

- A child may retry only its failing leaf after a recorded transient cause or meaningful change in input, method, instrumentation, external state, or backoff.
- Two identical no-delta failures make that child stage NON_PASS and pause the Program pending a new corrective child task or an approved successor Goal revision.
- Every child task has one ticket-sized outcome. The Commander does not queue dependent implementation in parallel merely to use capacity.
- A time, token, or task-window limit pauses or marks the affected stage NON_PASS; it never proves completion.

Pause when: A required native blocker, authorization, external dependency, candidate identity, or durable receipt is missing, stale, unreadable, ambiguous, or candidate-mismatched. Resume only after fresh evidence resolves that named condition.

Complete only when: all S0 through S6 gates pass with fresh, readable evidence for their exact candidates; the #99 Terminal Result is finalized PASS; #100 independent acceptance passes; and #101 confirms the live native #23 → #24 frontier.

Stop NON_PASS when: evidence is terminally contradictory, a protected production action has an unresolvable terminal result, the program outcome cannot be reached under this revision, or the bounded no-progress rule is exhausted without an authorized corrective successor.

## Resumable and terminal states

- `ACTIVE`: an unblocked child task has been dispatched and is being monitored.
- `PAUSED_TRACKER_REPAIR`: S0 is awaiting its corrective child result.
- `PAUSED_AUTHORIZATION`: #98 is the only remaining gate before #99 and no exact authorization exists.
- `PAUSED_EXTERNAL_STATE`: a named external dependency cannot be verified; resume only after fresh reread.
- `COMPLETE`: every S0–S6 gate has fresh PASS evidence for the exact final artifacts and #101 verifies #24's native frontier.
- `NON_PASS`: the program's declared outcome cannot be reached under this revision, its exact evidence is terminally contradictory, or the bounded no-progress rule is exhausted without an authorized corrective successor.
- `CANCELLED`: the user cancels the program.

Amendment:

This armed revision is immutable. A change to outcome, tracker root, authority, production semantics, evidence gates, stage ordering, or retry policy requires a separately approved successor revision. Carry evidence forward only when its exact target, freshness, and claim remain valid; all old authorization is invalidated by a successor revision.
