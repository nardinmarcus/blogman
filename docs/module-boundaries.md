# Public reading and settings module boundaries

These implementation boundaries use the language in [CONTEXT.md](../CONTEXT.md) and preserve [ADRs 0007–0011](adr/). Specifications and delivery evidence live in GitHub Issues [#252](https://github.com/nardinmarcus/blogman/issues/252), [#253](https://github.com/nardinmarcus/blogman/issues/253) and [#254](https://github.com/nardinmarcus/blogman/issues/254), not in a second local tracker.

## Public reading

The `lib/public-read` module owns public selection and materialization from Canonical Facts. Its interface separates public discovery from the management compatibility adapter:

- Formal snapshots supply body, HTML, title, description, tags and cover. Latest snapshots supply management fields such as category, password, hidden, pinned and deletion state; lifecycle remains a formal-publication fact.
- Public addresses resolve through the Slug Address Registry, with the existing formal-slug fallback when registry data is unavailable.
- Discovery visibility is not direct-address visibility: hidden articles remain directly addressable; password gates and historical redirects retain their own contracts.
- `canon.ts` owns shared fact selection/materialization; `search.ts`, `categories.ts` and `related.ts` apply the relevant discovery policy. Callers retain ranking, vector order and presentation.
- Admin search deliberately retains `postFromAdminRow`: latest display metadata and latest snapshot slug with formal-slug fallback. It is not interchangeable with the public interface.
- Missing-schema degradation, propagation of unrelated failures, query budgets, request-scoped caching and streaming remain distinct tested contracts. The Compat Projection is not a fallback authority.

The depth comes from owning these decisions, not from adding another forwarding function. Verification crosses the interface in `tests/lib/public-read/`, including canonical search, category/related fallback and registry-missing cases.

## Configured navigation

`components/SiteNavLink.tsx` is the behavior seam shared by header and home-theme adapters:

- `openInNewTab || url.startsWith('http')` selects a native anchor; otherwise use Next Link.
- Only `openInNewTab` adds `_blank` and `noopener noreferrer`; an HTTP URL alone does not force a new tab.
- The interface owns the exact destination and tab policy. Adapters may supply presentation and interaction callbacks, not replace `href`, `target` or `rel`.

Theme adapters retain defaults, empty-array fallback, labels/icons, order, layout, terminal hover treatment, search/category controls and mobile-menu callbacks. Centralizing link policy does not mean unifying theme presentation. The leverage is one policy change across themes; the locality of visual changes stays in each adapter.

`tests/components/site-navigation.test.ts` verifies real callers and distinguishes Next Link from native anchors without mocking the policy itself.

## Settings save and undo

`lib/settings-save-coordinator.ts` owns exactly `nav_links`, `custom_js`, `default_theme` and `body_font` for one `SettingsManager` lifetime. `useSettingsSaveCoordinator.ts` is the React/HTTP/toast adapter; the editors are controlled input/presentation adapters.

- Draft and last acknowledged raw string are separate facts. Display normalization must not replace the raw undo baseline.
- Same-key writes are serialized; unsent intent is coalesced to the latest value. Different keys are independent. Text edits retain the one-second debounce; structural navigation changes save immediately.
- Undo changes the visible draft only after persistence succeeds. Failed undo retains the current value and offers retry. New same-key edits revoke older undo/retry actions; actions are one-use.
- Older completions cannot overwrite newer drafts. Ordinary appearance-save failure restores the acknowledged selection; navigation/text failure retains the editable draft for retry.
- Switching internal tabs preserves drafts, timers and busy state. Leaving the page cancels unsent work and invalidates actions/notices; already-dispatched writes are not retractable.
- Synchronous subscribers can invalidate lifecycle or revision during snapshot publication. Authority is rechecked before dispatch and before completion notices, not only across `await`.

This is page-local coordination, not cross-tab/server conflict control. Other settings sections and the settings HTTP/storage protocol are outside this module.

Verification combines the public coordinator interface (`tests/lib/settings-save-coordinator.test.ts`) with real page/editor/Tabs/Toast lifecycles (`tests/components/settings-save.test.ts`). Controlled transport proves sequencing and UI policy, not production database behavior.

## Fixture runtime

Run browser-fixture tests with the Node version used by CI as well as the local runtime. Explicitly install JSDOM's `window`, `document`, `navigator` and `history` before importing code that needs them: newer Node globals can hide missing fixture setup on Node 20. Assert captured window errors are empty; passing assertions alone do not prove event handlers completed. Cleanup must preserve the original setup failure rather than replace it with an uninitialized-root error.
