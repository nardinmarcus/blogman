# Separate authorization from the execution plan

Expose `prepare(config) → canonical frozen manifest` and `execute(manifest, authorization) → terminal result`. The manifest is the only input that determines production behaviour; authorization is a separate capability record bound to the manifest hash and may not carry commands, stage overrides, targets, or configuration. Execution accepts no callback or runtime plan override, while credentials remain behind internal adapters, so a human can authorize frozen bytes without creating a second delivery plan.

Status: Completed. Issue #23 Delivery finished with the single production attempt (#99–#101, closed 2026-08-19). The delivery implementation, its schemas, tests, read-only history audit adapter and macOS CI gate were retired in #259; the historical code remains in Git history.
