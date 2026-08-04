# Separate authorization from the execution plan

Expose `prepare(config) → canonical frozen manifest` and `execute(manifest, authorization) → terminal result`. The manifest is the only input that determines production behaviour; authorization is a separate capability record bound to the manifest hash and may not carry commands, stage overrides, targets, or configuration. Execution accepts no callback or runtime plan override, while credentials remain behind internal adapters, so a human can authorize frozen bytes without creating a second delivery plan.
