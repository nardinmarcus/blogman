# Blogman Wayfinder Charting

- [x] Confirm the destination and scope with the author.
- [x] Confirm the GitHub issue tracker and repository instruction file.
- [x] Write the repository skill configuration.
- [x] Create the Wayfinder map and initial decision tickets.
- [x] Link tickets as sub-issues and wire native blocking relationships.
- [x] Verify the initial frontier.
- [x] Dispatch all initial research tickets.

## Review

- Canonical map: https://github.com/nardinmarcus/blogman/issues/2
- Created ten typed child decision tickets and ten native blocking edges.
- Initial unblocked tickets: two research tickets and three grilling tickets.
- Dispatched both research tickets to isolated background agents; no feature implementation started.

## Current Wayfinder Ticket: Define Article Ingress and Update Semantics

- [x] Reconcile completed research decisions into the map.
- [x] Graduate newly specified failure-notification and persistence questions into tickets.
- [x] Claim the first open frontier ticket.
- [x] Inspect the current ingress implementations and identify conflicting semantics.
- [x] Resolve ingress decisions with the author one question at a time.
- [x] Record the resolution, close the ticket, and update the map.

### Ticket Review

- Resolved stable article identity, source association, conflict handling, field ownership, external-update safety, media reuse, and non-cascading unlink/delete behavior.
- Added `Source Draft Association`, `Content Conflict`, `Pending Revision`, `Publication Metadata`, `Media Asset`, and `Primary Source Draft` concepts to `CONTEXT.md` using their Chinese canonical terms.
- Added follow-up decision tickets for source-sync persistence and the pending-revision lifecycle, then wired them into the existing state-model and prototype blockers.
- Verified that the next first frontier ticket is `定义发布准备检查与 AI 建议规则`.

## Current Wayfinder Ticket: Define Publication Readiness and AI Suggestion Rules

- [x] Claim the first open frontier ticket.
- [x] Inspect the current publish validation, save/upload failure, and AI-action behavior.
- [x] Resolve readiness checks and AI suggestion semantics with the author one decision at a time.
- [x] Update the domain glossary when terminology becomes stable.
- [x] Record the resolution, close the ticket, and update the map.

### Verification

1. Current behavior inspection → verify: cite concrete editor/API files and distinguish existing facts from proposed product behavior.
2. Decision interview → verify: every blocking rule and AI-control rule has an explicit author-approved outcome.
3. Wayfinder resolution → verify: the ticket is closed with a resolution comment and the map contains one linked decision gist.

### Ticket Review

- Resolved the deterministic publication blockers: empty title/body, unsaved current version, and unfinished media only.
- Limited non-blocking suggestions to publication metadata, focused local content improvements, and selected-channel adaptation; excluded scoring, fact checking, originality checks, and whole-article rewrites.
- Defined publication-readiness results as version-bound, cross-device current state with pending, applied, ignored, and expired suggestions.
- Required per-suggestion preview, apply, immediate undo, and skip; stale or late AI results cannot overwrite newer author edits.
- Confirmed that pending suggestions and AI execution never block publication, while all publication entry points must rerun deterministic blockers.
- Added `发布阻塞项`, `发布建议`, and `发布准备结果` to `CONTEXT.md`.
- Verified the next first frontier ticket is `定义关键恢复点的保留与恢复规则`.

## Current Wayfinder Ticket: Define Recovery Point Retention and Restore Rules

- [x] Claim the first open frontier ticket.
- [x] Inspect current editor undo, autosave, soft-delete, and persisted-version behavior.
- [x] Resolve recovery-point triggers, payload, retention, and restore semantics with the author one decision at a time.
- [x] Update the domain glossary when recovery terminology becomes stable.
- [x] Record the resolution, close the ticket, and update the map.

### Verification

1. Current recovery inspection → verify: distinguish in-session editor undo, autosaved current state, deletion recovery, and durable article versions.
2. Decision interview → verify: every trigger, retained field, expiry rule, and restore outcome has an explicit author-approved answer.
3. Wayfinder resolution → verify: the ticket is closed with a resolution comment and the map contains one linked decision gist.

### Ticket Review

- Defined four recovery-point triggers: first AI suggestion application per readiness result, external source overwrite, pending-revision publication, and restoration of another point.
- Recovery points retain the complete author-editable version but exclude identity, source association, lifecycle, scheduling, channel jobs, and statistics.
- Draft restoration replaces the draft; restoration for a published article creates a pending revision and never changes the live article directly.
- Retention is the latest ten points per article without time expiry; soft deletion retains them and permanent deletion removes them.
- Restore requires a diff, optimistic version check, atomic pre-restore snapshot plus apply, and a reversible outcome.
- Restoring scheduled content pauses its schedule and requires a fresh readiness check and author confirmation.
- Added and wired `定义草稿保存与并发编辑语义` after code inspection exposed missing durable revision and concurrency boundaries.
- Verified the next first frontier ticket is `定义定时发布的产品语义`.

## Current Wayfinder Ticket: Define Scheduled Publication Product Semantics

- [x] Claim the first open frontier ticket.
- [x] Inspect current publication timestamps/status behavior and reconcile the completed scheduler research.
- [x] Resolve schedule creation, editing, cancellation, missed-time, retry, and post-publication semantics one decision at a time.
- [x] Update the domain glossary when scheduling terminology becomes stable.
- [x] Record the resolution, close the ticket, and update the map.

### Verification

1. Current scheduling inspection → verify: distinguish existing immediate-publication behavior from the planned Cron/D1 mechanism.
2. Decision interview → verify: every author action and success/failure transition has an explicit outcome.
3. Wayfinder resolution → verify: the ticket is closed with a resolution comment and the map contains one linked decision gist.

### Ticket Review

- Bound every schedule to an explicitly confirmed article version; author-editable changes pause rather than silently mutate the schedule.
- Distinguished pause, cancel, reschedule, early publication, invalid past-time input, and overdue catch-up behavior.
- Standardized scheduling on explicit author time zone `Asia/Shanghai`, persisted as an absolute UTC instant plus IANA time zone for intent-preserving display.
- Defined first publication time as actual successful go-live time, distinct from draft creation, planned time, and later revision time.
- Defined core publication failure as `发布重试中`, with automatic/manual retry, while version mismatch enters `排期暂停`.
- Allowed pending revisions to be scheduled without affecting the live version until successful promotion and recovery-point creation.
- Sequenced WeChat draft generation strictly after Blogman success and bound it to the published version with independent retries.
- Added `排期暂停`, `发布重试中`, `作者时区`, and `首次发布时间` to `CONTEXT.md`, and sharpened `定时发布`, `待发布修订`, and `派生发布`.
- Verified the next first frontier ticket is `定义草稿保存与并发编辑语义`.

## Current Wayfinder Ticket: Define Draft Saving and Concurrent Editing Semantics

- [x] Claim the first open frontier ticket.
- [x] Inspect every article writer, autosave lifecycle, navigation loss, and existing concurrency behavior.
- [x] Resolve stable revision, offline/exit saving, and conflict-handling semantics one decision at a time.
- [x] Update the domain glossary when version and conflict terminology becomes stable.
- [x] Record the resolution, close the ticket, and update the map.

### Verification

1. Current write-path inspection → verify: enumerate browser, inline editor, API, and external-source writers and their overwrite behavior.
2. Decision interview → verify: every save acknowledgement, navigation edge, version mismatch, and conflict outcome has an explicit answer.
3. Wayfinder resolution → verify: the ticket is closed with a resolution comment and the map contains one linked decision gist.

### Ticket Review

- Established immutable article identity plus a monotonic server-confirmed article version for all browser, mobile, API, external-source, background-AI, and bulk-metadata writers.
- Defined saved status as an atomic full editable snapshot whose returned version still matches the current UI; in-flight newer edits remain unsaved.
- Added one per-article, per-device `本机未确认稿` for crash, refresh, and temporary-network recovery without creating an offline source of truth.
- Defined conflict handling as paused autosave plus diff, with explicit server-version, local-version-with-recovery-point, or separate-draft outcomes and no automatic merge.
- Made first draft creation idempotent through a stable creation identity, while keeping completely empty editor sessions out of the article list.
- Prohibited version-check bypasses for background AI, external tools, API clients, and category bulk updates.
- Added `文章版本`, `保存冲突`, `保存确认`, and `本机未确认稿` to `CONTEXT.md`.
- Verified the next first frontier ticket is `定义源稿关联与同步状态模型`.

## Current Wayfinder Ticket: Define Source Association and Sync State Model

- [x] Claim the first open frontier ticket.
- [x] Inspect Chrome, Obsidian, Agent, API, and repository source-identity behavior.
- [x] Resolve source roles, stable identity, sync baseline, state transitions, unlinking, and invalidation one decision at a time.
- [x] Update the domain glossary when source-sync terminology becomes stable.
- [x] Record the resolution, close the ticket, and update the map.

### Verification

1. Current source inspection → verify: every shipped external writer is accounted for and existing capabilities are separated from proposed behavior.
2. Decision interview → verify: source identity, comparison baseline, lifecycle, and author-visible conflict outcomes all have explicit answers.
3. Wayfinder resolution → verify: the ticket is closed with a resolution comment and the map contains one linked decision gist.

### Ticket Review

- Separated the single writable primary source draft from optional read-only source-webpage provenance; one article may retain both without creating competing writing authorities.
- Defined independent immutable article and source identities, idempotent creation with write-back confirmation, collision handling for copied Markdown, and path/slug/title-independent association.
- Limited the synchronization baseline to normalized title, body, and referenced media content identities; publication metadata changes do not create content conflicts.
- Made synchronized, source-ahead, Blogman-ahead, and conflict outcomes derived from persisted facts; Blogman-ahead content requires explicit write-back to the primary source.
- Separated source availability from content synchronization, retaining associations through temporary unavailability or confirmed source loss.
- Made unlinking server-enforced and non-cascading; stale IDs cannot revive an association, while explicit relinking compares both sides and establishes a new baseline.
- Defined content-addressed source-media mappings and author-confirmed webpage refresh behavior without background polling or direct live-article replacement.
- Verified the resolution comment, closed ticket, linked map gist, and next unclaimed frontier ticket `定义待发布修订的生命周期` against live GitHub state.

## Current Wayfinder Ticket: Define Pending Revision Lifecycle

- [x] Claim the first open frontier ticket.
- [x] Inspect current published-post mutation, unpublish, scheduling, AI, external-sync, and recovery behavior.
- [x] Resolve revision cardinality, write targeting, discard, scheduling, promotion, and recovery semantics one decision at a time.
- [x] Update the domain glossary when pending-revision terminology becomes stable.
- [x] Record the resolution, close the ticket, and update the map.

### Verification

1. Current lifecycle inspection → verify: distinguish current single-row published-post mutation from the planned live-plus-pending model across every writer.
2. Decision interview → verify: editing, external sync, AI, discard, schedule, publish, retry, and recovery each target an explicit version with no ambiguous overwrite path.
3. Wayfinder resolution → verify: the ticket is closed with a resolution comment and the map contains one linked decision gist.

### Ticket Review

- Established at most one active pending revision per published article; station editing, primary-source sync, AI application, APIs, and background writers all update it through article identity and version checks while the formal version remains unchanged.
- Defined the revision field boundary, version-bound readiness and scheduling, atomic promotion, retry behavior, and preservation of immutable article identity and first publication time.
- Made discard and restore reversible through recovery points; restoring with an existing revision replaces that same revision rather than creating a parallel branch.
- Distinguished unpublish, republish, soft delete, and revision discard, preserving formal content and pending work while pausing schedules where publication intent is no longer current.
- Defined delayed slug activation, exclusive candidate validation, and permanent old-address aliases tied to immutable article identity.
- Added `待发布修订`, `修订内容`, `修订上线`, `放弃修订`, `修订恢复`, `取消发布`, `软删除`, `公开地址`, and `历史公开地址` semantics to `CONTEXT.md`.
- Verified the live resolution comment, closed issue, updated map gist, recovery-rule amendment pointer, and native dependency frontier.
- Verified the next first frontier ticket is `设计文章工作台与发布准备流程`; `设计微信派生发布流程` is also unblocked but remains untouched in this session.

## Current Wayfinder Ticket: Design Article Workbench and Publication Readiness Flow

- [x] Recompute the live Wayfinder frontier and claim the first unassigned ticket.
- [x] Inspect the existing editor route, metadata controls, AI surfaces, recovery affordances, and administration navigation.
- [x] Build three structurally distinct read-only UI variants on the existing editor route, switchable by URL and keyboard.
- [x] Run the prototype locally and verify every variant at desktop and narrow viewport widths.
- [x] Resolve the workbench hierarchy and publication-readiness interaction with the author one decision at a time.
- [x] Capture the winning design, record the resolution, close the ticket, and update the map.

### Verification

1. Current UI inspection → verify: each prototype decision is grounded in the shipped editor and existing navigation rather than an isolated mockup.
2. Prototype safety → verify: variants never call real save, AI, scheduling, recovery, or publication mutations and the switcher cannot appear in production.
3. Responsive review → verify: all variants remain understandable at desktop and narrow widths, with full relevant mock state visible.
4. Wayfinder resolution → verify: the author selects or composes a winning structure, the prototype is captured outside main, and the ticket/map are updated.

### Ticket Review

- Selected the write-first Variant A: the unified workbench always reopens in writing mode, while source, save version, pending revision, and recovery remain a compact status line.
- Made publication readiness author-invoked, collapsed by default, and version-bound; desktop uses a right panel while mobile uses the same flow as a full page.
- Ordered readiness as blockers and conclusion, optional AI suggestions, item-level publication-metadata summary, and one final-confirmation action.
- Kept text-selection AI local to writing and document-level suggestions inside readiness; every candidate requires preview and explicit author application.
- Defined final confirmation as an in-panel view of the exact saved version, access URL, and immediate or scheduled intent; any version change invalidates confirmation.
- Kept offline input editable while blocking publication until save recovery, and required explicit diff resolution for source conflicts.
- Added the stable `发布确认` term and sharpened `文章工作台` and `AI 辅助驾驶` in `CONTEXT.md`.
- Captured the complete A/B/C prototype on `codex/prototype-article-workbench-10` at commit `b8f20df`; no prototype route or component remains on `main`.
- Verified TypeScript, targeted ESLint, diff hygiene, desktop and 390 px browser flows, zero browser-console errors, the closed resolution comment, and the linked map gist.
- Recomputed native blockers: the next first unassigned frontier ticket is `设计微信派生发布流程`; all other open decision tickets remain blocked.

## Current Wayfinder Ticket: Design WeChat-Derived Publication Flow

- [x] Recompute the live Wayfinder frontier and claim the first unassigned ticket.
- [x] Inspect the shipped WeChat-related surfaces and reconcile the completed automation and scheduling decisions.
- [x] Build three structurally distinct read-only UI variants next to the actual publication-result flow.
- [x] Run the prototype locally and verify every variant at desktop and narrow viewport widths.
- [x] Resolve generation, preview, author handoff, failure, and return-to-edit behavior one decision at a time.
- [x] Capture the winning design, record the resolution, close the ticket, and update the map.

### Verification

1. Current capability inspection → verify: distinguish shipped behavior, official WeChat limits, and already-decided Blogman semantics.
2. Prototype safety → verify: variants cannot publish, create a real WeChat draft, or mutate article/channel state.
3. Responsive review → verify: success, pending, failure, stale-version, and return-to-edit states remain understandable on desktop and narrow screens.
4. Wayfinder resolution → verify: the author selects a winning structure, the prototype is captured outside `main`, and the ticket/map are updated.

### Ticket Review

- Selected Variant A `发布回执`: Blogman success remains the primary result, followed by one independent WeChat task card rather than a separate channel control center.
- Moved account selection, channel metadata, and optional phone preview into version-bound final publication confirmation; body changes return to the article workbench, while channel-only settings remain adjustable.
- Bound each task to one formal article version plus one WeChat account; retry and settings adjustment continue that task, while another account, new formal version, or explicit replacement creates a separate task.
- Separated the system terminal state `微信草稿已交付` from the author to-do `待微信确认`; marking handled clears only the reminder and never asserts WeChat publication.
- Defined persistent independent failure handling with immediate retry, channel adjustment, stop/resume, and no Blogman rollback; retry cadence and notification policy remain for their dedicated tickets.
- Preserved delivered old drafts as history and paused queued/running/retrying old-version tasks; only the explicit WeChat correction path pauses a task, while ordinary article editing has no implicit channel side effect.
- Confirmed scheduled publication validates channel settings up front, publishes Blogman first at due time, and then starts the WeChat task without requiring the author online.
- Kept per-article history and manual generation in the article workbench, immediate status in the publication receipt, and only action-required items in the today workbench.
- Added `渠道派生任务`, `微信派生草稿`, and `待微信确认` to `CONTEXT.md`, and sharpened `派生发布` to preserve author confirmation.
- Captured the complete A/B/C prototype on `codex/prototype-wechat-derived-flow-11` at commit `9232f1d`; no prototype route or component remains on `main`.
- Verified TypeScript, targeted ESLint, diff hygiene, five scenario states, desktop and narrow browser layouts, zero horizontal overflow, and zero page errors.
- Verified the live resolution comment, closed ticket, and map gist. Native blockers make `定义发布失败通知策略` the next first unassigned frontier ticket; `定义发布调度与渠道任务状态模型` is also unblocked.

## Current Wayfinder Ticket: Define Publication Failure Notification Policy

- [x] Recompute the live Wayfinder frontier and claim the first unassigned ticket.
- [x] Inspect current in-app, browser, and external notification capabilities plus every decided failure event.
- [x] Resolve notification triggers, timing, channels, deduplication, silence, and escalation one decision at a time.
- [x] Update the domain glossary when notification terminology becomes stable.
- [x] Record the resolution, close the ticket, update the map, and recompute the frontier.

### Verification

1. Current capability inspection → verify: distinguish shipped notification mechanisms from planned behavior and never treat runtime cache as truth.
2. Decision interview → verify: each publishing or channel failure has an explicit first-notice, repeat, recovery, and author-acknowledgement rule.
3. Wayfinder resolution → verify: the live ticket contains the complete answer, is closed, and the map contains one linked decision gist.

### Ticket Review

- Confirmed that the shipped application has only short-lived foreground toasts; it has no durable in-app notification store, browser Push, email delivery, or external notification channel today.
- Made the today workbench the persistent notification source of truth, with optional email as the first proactive channel and browser Push deferred as a non-exclusive enhancement.
- Defined a five-minute grace period for retryable Blogman publication failures, immediate notice for non-recoverable failures, and a recovery notice only when a failure notice was previously sent.
- Defined a thirty-minute threshold for retrying WeChat failures, immediate notice when author action is required, and an actionable delivery notice for `待微信确认`.
- Applied core-publication urgency only to post-publication tasks that affect reader-visible correctness; recommendations, AI enrichment, statistics, and similar enhancements retry silently.
- Distinguished author-visible schedule pauses from remote or due-time version mismatches: known foreground changes stay in-app, while unexpected pauses notify immediately.
- Deduplicated every task into one active notification, grouped common-system incidents within ten minutes, and separated acknowledgement from resolution.
- Escalated unresolved core failures once after one hour and then in a 09:00 daily digest; lower-priority items enter only the daily digest.
- Set default quiet hours to 22:00–08:00 in the author timezone, with an explicit opt-in exception only for core Blogman publication failures.
- Required safe notification content and confirmation deep links; email links never directly retry or publish, and delivery acceptance never claims receipt or reading.
- Ended active notifications on success, cancellation, or explicit stop; preserved histories per article and avoided a separate global notification center.
- Added `活动通知` and `已知晓` to `CONTEXT.md`, and sharpened `今日工作台` to include unresolved attention items.
- Verified the live resolution comment, completed ticket, linked map gist, and native blockers. The next first unassigned frontier ticket is `定义发布调度与渠道任务状态模型`; `设计今日工作台` remains blocked by it.

## Current Wayfinder Ticket: Define Publication Scheduling and Channel Task State Model

- [x] Recompute the live Wayfinder frontier and claim the first unassigned ticket.
- [x] Inspect the shipped D1 schema, article lifecycle fields, background jobs, and every completed scheduling/channel decision.
- [x] Resolve entity boundaries, state transitions, version binding, idempotency, retries, and author actions one decision at a time.
- [x] Update the domain glossary when state-model terminology becomes stable.
- [x] Record the resolution, close the ticket, update the map, and recompute the frontier.

### Verification

1. Current model inspection → verify: distinguish shipped single-row article state and best-effort jobs from the planned durable model.
2. Decision interview → verify: every automatic and author-triggered transition has one owner, preconditions, terminal outcome, and retry behavior.
3. Consistency review → verify: D1 remains the source of truth and every duplicate Cron, queue, webhook, or button action is idempotent.
4. Wayfinder resolution → verify: the live ticket contains the complete model, is closed, and the map contains one linked decision gist.

### Ticket Review

- Confirmed the shipped model is a single mutable `posts` row with draft/published/deleted status, creation-defaulted `published_at`, no server article version, schedule, publication event, durable channel task, attempt, or notification tables, and best-effort background error logging.
- Separated article lifecycle, immutable version, publication intent, publication event, post-publication task, execution attempt, channel delivery group, and activity-notification projection into distinct facts.
- Unified immediate and scheduled publication as one version-bound publication intent with at most one active intent per article; time-only rescheduling revises it, while target-version changes require a new intent.
- Defined publication-intent states as scheduled, running, retry-wait, paused, completed, cancelled, and superseded, with leases for execution and no permanent generic failure state.
- Required one D1 atomic core commit for final preconditions, recovery point, formal-version promotion, first-publication semantics, unique publication event, completed intent, and durable Outbox task registration.
- Made Queues a wake-up accelerator only; D1 task records and deterministic event/type/target keys remain the source of truth when messages duplicate or disappear.
- Defined common durable-task states, immutable attempt records, normalized error categories and responsible party, persisted retry times, task revisions, and conditional late-result handling.
- Stopped automatic retry for unknown non-idempotent external outcomes; authors must verify the remote system or explicitly accept duplicate risk before another generation.
- Introduced one channel delivery group per formal version and account, with current task generation plus immutable replacement and stopped-task history.
- Applied version and lifecycle invalidation atomically, rechecked all final preconditions after leases, and kept runtime queues and caches from becoming state truth.
- Distinguished lease recovery for idempotent internal tasks from unknown-result handling for non-idempotent external tasks, and approved urgency-specific retry backoff with jitter and `Retry-After` support.
- Made activity notifications durable, source-linked, unique attention projections that can be reconciled from underlying facts but never drive task execution.
- Preserved publication and task summaries with the article, retained detailed attempts for 90 days, cascaded permanent deletion, and kept soft-delete history intact.
- Distinguished reversible pause from terminal stop; restarting a stopped task creates a linked new generation, while retry-now continues the existing task.
- Prevented channel-setting changes from mutating a running or delivered task, and separated latest-state tasks that may coalesce from exact-version tasks that never retarget.
- Kept article lifecycle limited to draft, published, unpublished, and soft-deleted; schedules, revisions, retries, channel work, and notifications remain orthogonal.
- Required stable idempotency identities across browser, mobile, API, Agent, Cron, Queue, and future webhook entry points.
- Defined the today workbench as a rebuildable D1 read model and required exact-version tasks to use immutable input snapshots, with only convergence tasks reading current state.
- Added `发布意图`, `发布事件`, `发布后任务`, `任务尝试`, `渠道交付组`, and `结果未知` to `CONTEXT.md`, and sharpened `渠道派生任务` around task generations.
- Verified the live resolution comment, completed ticket, linked map gist, and native blockers. The next first unassigned frontier ticket is `设计今日工作台`; `设计移动端作者流程` remains blocked by it.

## Current Wayfinder Ticket: Design Today Workbench

- [x] Recompute the live Wayfinder frontier and claim the first unassigned ticket.
- [x] Inspect the shipped admin entry, article list, editor entry points, and every completed workbench-related decision.
- [x] Build three safe, structurally distinct today-workbench prototype variants against representative states.
- [x] Resolve information hierarchy, grouping, primary actions, and responsive behavior through author review.
- [x] Capture the prototype, record the resolution, close the ticket, update the map, and recompute the frontier.

### Verification

1. Current-surface inspection → verify: distinguish the shipped admin landing page from the planned today-workbench read model.
2. Prototype safety → verify: variants use representative read-only data and cannot publish, retry, cancel, or mutate article state.
3. Scenario review → verify: continue-writing, future schedule, active progress, author-action failure, and clear-day states remain understandable on desktop and narrow screens.
4. Wayfinder resolution → verify: the author selects a winning structure, the prototype is captured outside `main`, and the ticket/map are updated.

### Ticket Review

- Selected Variant A `继续今天`: one recently author-edited unfinished article remains the primary card, while author-action items interrupt only when necessary.
- Grouped work by next actor: automatic retries and active jobs stay under `接下来`; paused schedules, unknown external results, missing settings, and stopped follow-ups enter `需要你处理`.
- Ordered `接下来` as core retry, running channel work, then valid future schedules; ordered author attention by time risk, unsafe unknown result, missing information, then non-urgent follow-up.
- Capped the main card at one article, other drafts at three, upcoming work at four, and desktop attention at three, with explicit totals and local expansion.
- Kept safe navigation direct while routing state-changing actions through focused detail and explicit confirmation.
- Made narrow layouts show one compact top-priority attention item, a writing-first hero, and compact new/import actions; an empty writing state promotes new/import to the hero.
- Captured the read-only prototype on `codex/prototype-today-workbench-9` at commit `8310643`; no prototype route or component remains on `main`.
- Verified TypeScript, targeted ESLint, diff hygiene, desktop and 390 px layouts, expansion states, zero horizontal overflow, and zero page errors.
- Recorded the complete resolution in closed issue #9, updated map #2, and verified that `设计移动端作者流程` (#12) is the only remaining open decision ticket and the next frontier.

## Current Wayfinder Ticket: Design Mobile Author Flow

- [x] Load the live map, verify the frontier, and claim `设计移动端作者流程`.
- [x] Inspect the shipped mobile admin list, editor header, editing surface, AI entry points, and direct publication actions.
- [x] Build three safe, structurally distinct narrow-screen author-flow variants on the existing admin entry.
- [x] Verify workbench, small edit, AI suggestion, schedule adjustment, and publication-confirmation scenarios at narrow width.
- [x] Resolve mobile scope, navigation, editing, confirmation, and desktop-handoff behavior through author review.
- [x] Capture the prototype, record the resolution, close the ticket, update the map, and recompute the frontier.

### Verification

1. Current mobile inspection → verify: distinguish shipped responsive CSS from the planned mobile author workflow and identify every direct mutation currently exposed.
2. Prototype safety → verify: variants are representative read-only flows and cannot save, apply AI, change a schedule, or publish.
3. Flow review → verify: each supported mobile task has an explicit entry, save/version state, confirmation boundary, and way back to today.
4. Wayfinder resolution → verify: the author selects or composes one coherent mobile flow, the prototype is captured outside `main`, and the ticket/map are updated.

### Ticket Review

- Selected Variant A `任务路径`: mobile work starts from today, enters one focused full-page task, and returns explicitly to the today workbench.
- Limited mobile editing to title, ordinary paragraphs, small paragraph changes, and basic inline formatting; media and complex blocks remain view-only with a desktop-continuation link.
- Kept AI to existing version-bound suggestions and selected-text local candidates; excluded whole-document rewriting, continuation, and media generation.
- Reused server-confirmed article versions, autosave, local unconfirmed recovery, and explicit conflict comparison; mobile never invents a second save model.
- Allowed reschedule, cancel, publish-now, and paused-schedule reconfirmation while preserving exact-version binding and `Asia/Shanghai` intent.
- Used one full-page publication confirmation with one outcome-specific action, immediate duplicate protection, version revalidation, and a publication receipt.
- Standardized global mobile navigation on `今天 / 文章 / 新建`, kept attention inside today, and moved low-frequency settings and session actions to the overflow menu.
- Restricted the mobile article list to search, filters, view, copy link, small edit, and entry into publication detail; direct state toggles and administrative actions remain off the cards.
- Made notification deep links navigation-only, current-state revalidated, resumable after authentication, and safe when the underlying item is resolved, missing, or deleted.
- Captured the in-memory prototype on `codex/prototype-mobile-author-flow-12` at commit `8a55d70`; no prototype route or component remains on `main`.
- Verified TypeScript, targeted ESLint, diff hygiene, all selected A flows at 390 px, zero horizontal overflow, and zero browser errors.
- Recorded the complete resolution in closed issue #12 and updated map #2. Graduated the cleared fog into the unassigned child ticket `规划实施顺序与可验证交付批次` (#18), now the only remaining decision frontier.

## Current Wayfinder Ticket: Plan Implementation Sequence and Verifiable Delivery Batches

- [x] Load the live map, verify the only frontier, and claim `规划实施顺序与可验证交付批次`.
- [x] Inventory the shipped persistence model, every article writer, publication runtime, and deployment constraints.
- [x] Derive the hard dependency graph from completed product and domain decisions.
- [x] Resolve rollout strategy, compatibility boundaries, and batch acceptance gates with the author one decision at a time.
- [x] Record the implementation sequence and verification matrix, close the ticket, update the map, and verify that no planning fog remains.

### Verification

1. Current-state inventory → verify: every existing write path and production runtime is assigned an explicit compatibility or migration treatment.
2. Dependency order → verify: no batch depends on a fact, state transition, or durable task introduced only by a later batch.
3. Independent delivery → verify: every batch has a deployable scope, data migration rule, rollback boundary, and observable acceptance evidence.
4. Wayfinder resolution → verify: the author confirms the remaining rollout tradeoffs, the ticket records the complete route, and the map has no unresolved implementation-planning frontier.

### Approved Decisions

- The first two delivery batches may be infrastructure-first: each must be independently deployable, verifiable, compatible with the current author workflow, and reversible, but neither needs to expose a noticeable new UI. Starting with the third batch, every batch must deliver a complete author-usable vertical outcome.
- The first author-usable vertical batch is the safe Blogman publication loop: current draft/import entry, server-confirmed versioned save and conflict handling, one pending revision, publication readiness, immediate formal-version promotion, and publication receipt. Continuous external-source association and scheduled publication follow in later batches; legacy external entry remains draft-compatible during the transition.
- The next author-usable batch extends that publication spine into reliable scheduling: D1-backed publication intents, one-minute Cron reconciliation with catch-up, leases and retries, version-change pause and reconfirmation, durable activity notifications, and the relevant today-workbench entries. It also establishes the reusable durable-task runtime, while external channel delivery remains a separate batch.
- The following batch completes WeChat-derived delivery before switching back to authoring inputs: a formal-version-and-account delivery group, exact-version channel task, retry and unknown-result handling, publication-receipt status, replacement-draft history, and the independent `待微信确认` author action. The existing synchronous bridge call becomes an adapter behind the durable task seam rather than a second source of truth.
- External authoring is then delivered in two source-role batches. The first completes writable primary-source association for Markdown/Obsidian, including identity write-back, pending association, versioned title/body and media synchronization, baselines, conflicts, unlinking, and explicit relinking. The second completes read-only source-page handling for Chrome clipping, including normalized-URL deduplication, explicit refresh comparison, and media reuse. One-off Agent/API writers already use the versioned write interface and never create source associations.
- Every batch uses additive, data-preserving rollback. Before authority changes, take and verify a D1 backup, apply a ledgered migration, backfill, and reconcile counts/content. After the new model receives writes, rollback may disable new UI, Cron, or task executors and continue through compatibility reads, but it never drops new tables or down-migrates article versions, intents, events, tasks, attempts, notifications, source facts, or remote identities. Recovery is forward-fix and re-enable.
- Legacy writes use a monitored, restricted compatibility window. Old clients may temporarily create drafts through the legacy adapter and receive an upgrade signal, but legacy direct publication and unversioned updates are rejected as soon as the versioned model becomes authoritative. After all repository clients are upgraded, seven consecutive days with zero legacy write requests plus a passing client acceptance matrix is required before removing the adapter. The old `posts` shape may remain longer as a read-only compatibility projection until every reader is migrated.
- Production promotion is serialized through risk-tiered observation gates. Additive tooling, shadow tables, and compatibility projections require at least 24 hours. Any authority switch or batch involving formal publication, scheduling, WeChat, or source synchronization requires at least 72 hours. A timer alone never passes a gate: the batch must execute its real production path, reconcile D1 identities/versions/counts/states, and have no unresolved high-priority anomaly. Once these conditions pass, work may advance automatically without another permission checkpoint; a failed gate stops advancement and is repaired in place.
- The confirmed mobile author flow is the final functional batch. Earlier batches keep current narrow-screen access regression-free and expose shared state/command interfaces, but do not build parallel mobile-specific flows while those interfaces are changing. After desktop publication, scheduling, WeChat, primary-source, and source-page flows are stable, the final batch connects today, articles, small edits, selection-local AI, scheduling, full-page confirmation, receipts, and safe notification deep links to those same facts.
- Reliable scheduling includes the first external notification adapter: a destination-restricted Cloudflare Email Service `send_email` binding behind the durable notification-task interface, with an in-memory test adapter. D1 activity notifications remain authoritative; unconfigured deployments explicitly remain site-only, and email failures never recursively create notification-failure notifications.

### Approved Delivery Sequence

1. **Delivery safety and migration control** — replace replayed `schema.sql || true` deployment with a ledgered, fail-closed D1 migration runner; add backup/restore rehearsal, schema-drift checks, feature switches, and production reconciliation commands. Verify the unchanged application against an applied-once migration and observe for 24 hours.
2. **Versioned article write kernel** — add immutable article identity, monotonic server-confirmed article versions, atomic editable snapshots, stable creation idempotency, optimistic conflict commands, local-unconfirmed-draft recovery, version-bound internal writers, additive backfill, and the read-only `posts` compatibility projection. Reconcile all 14 live rows and their content hashes/counts, update internal clients, enforce restricted legacy writes, and observe the authority switch for 72 hours.
3. **Safe desktop publication loop** — deliver the unified article workbench, one pending revision, lifecycle and historical-slug rules, recovery points, version-bound readiness and AI suggestions, immediate publication intent/event/Outbox transaction, independent convergence tasks, and publication receipt. Verify draft-first publication, published-article revision, conflict/recovery paths, atomic failure, idempotent replays, and a real production publication over 72 hours.
4. **Reliable scheduling and author attention** — extend publication intents with `Asia/Shanghai` scheduling, one-minute Cron reconciliation, catch-up, leases, retries, pause/reconfirm/reschedule/cancel/publish-now commands, durable tasks/attempts, activity notifications, today-workbench projections, and destination-restricted Cloudflare email delivery. Verify duplicate/missed ticks, version pause, failure/recovery, quiet hours, one real scheduled publication, notification reconciliation, and 72 hours of production evidence.
5. **WeChat-derived delivery** — move the existing bridge behind an exact-version durable channel adapter; add delivery groups and generations, account/settings revisions, retry and unknown-result handling, replacement-draft history, publication-receipt progress, and `待微信确认`. Verify deterministic input, blog-result independence, fake-adapter failure/response-loss cases, one real draft delivery, and 72 hours of reconciliation.
6. **Writable primary-source synchronization** — upgrade Markdown/Obsidian with article/source identity write-back, pending association, versioned title/body synchronization, media content identity and mapping, baselines, conflicts, availability, unlinking, and explicit relinking. Verify rename/move, copied-identity collision, two-sided edits, published-article revision creation, incomplete-media baseline protection, and 72 hours of real use.
7. **Read-only source-page refresh** — upgrade Chrome clipping with normalized-URL deduplication, coexistence with a primary source, explicit compare-and-refresh, published-article revision creation, and media reuse. Verify tracking-URL normalization, repeat clipping without duplicate articles, no silent overwrite, refresh conflicts, and 72 hours of real use.
8. **Mobile author flow** — connect the shared facts and commands to `今天 / 文章 / 新建`, focused small edits, local AI suggestions, schedule actions, full-page version confirmation, receipts, authentication-resumable deep links, and desktop handoff. Verify narrow-screen layouts, confirmed saves, offline/local recovery, conflicts, stale deep links, duplicate-submit protection, and the complete production task matrix over 72 hours.

After every batch, keep migrations additive, preserve new facts on rollback, run automated interface/invariant tests plus a production smoke and D1 reconciliation, and advance only after its observation gate passes. After the final functional batch, remove legacy write adapters only after the separate seven-day zero-legacy gate; retain old data/projections until every reader is migrated rather than treating cleanup as a ninth feature batch.

### Ticket Review

- Confirmed an eight-batch serial route: migration safety, versioned article facts, safe desktop publication, reliable scheduling/attention, WeChat delivery, writable primary sources, read-only source pages, and final mobile author flow.
- Grounded migration planning in the live D1 baseline of 14 posts (9 published and 5 drafts) and verified that no target version, revision, intent, event, durable-task, notification, or source-association tables currently exist.
- Required additive data-preserving rollback, restricted legacy writes, a seven-day zero-legacy retirement gate, and 24/72-hour production observation gates with real-path and D1 reconciliation evidence.
- Selected a destination-restricted Cloudflare Email Service binding as the first external notification adapter while retaining D1 activity notifications as the source of truth.
- Recorded the full resolution in closed GitHub ticket `规划实施顺序与可验证交付批次`, appended its gist to the canonical map, and closed the map after verifying every child ticket is closed, `Not yet specified` is empty, and no repository issues remain open.
- No product implementation, deployment, production mutation, or schema change was performed during this planning ticket; only the planning ledger and GitHub decision artifacts changed.

## Current Task: Translate Deep Research Report to Chinese

- [x] Save the requested translation preferences under Downloads.
- [x] Inspect the source structure and measure its length.
- [x] Analyze the report's domain, voice, terminology, and translation challenges.
- [x] Split the long Markdown source at block boundaries and translate every chunk.
- [x] Merge the translated chunks and verify structural completeness, terminology consistency, and Markdown preservation.
- [x] Check embedded images for possible language-localization needs and deliver the final Markdown file.

### Verification

1. Source coverage → verify: every source heading, table, list, code block, citation marker, and checklist is represented in the merged translation.
2. Terminology → verify: product names remain stable and recurring design, software, portfolio, and study-planning terms use consistent Chinese.
3. Markdown integrity → verify: headings, tables, fenced blocks, links, emphasis, citations, and Mermaid syntax remain parseable.
4. Output isolation → verify: all translation artifacts stay beside the source under Downloads; the source document is unchanged.

### Review

- Translated the 6,223-word report in two Markdown-aware chunks using one shared analysis and terminology guide.
- Preserved all 30 headings, 111 table rows, 14 code fences, 18 citation groups, 21 checklist items, and 2 Mermaid blocks.
- Independently reviewed the merged result against the source; corrected one unnatural `good-to-have` rendering and localized the remaining English month labels in the Mermaid timeline.
- Confirmed that the source contains no embedded image references, so no image-text localization follow-up is required.
