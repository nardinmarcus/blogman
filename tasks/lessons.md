# Lessons

- Before invoking a repository verification script, read `package.json` and use an existing script name; this repository has no `typecheck` script.
- Local Wrangler D1 integration tests routinely exceed Vitest's 5-second default; give the individual test an explicit bounded timeout and treat an earlier timeout as failed evidence, not a product failure or pass.
- Generated reseal package files are intentionally mode `0400`; mutation tests must explicitly make only their temporary fixture file writable before changing it, rather than weakening production package permissions.
- Before launching a bounded local suite, confirm that a prior Vitest/Workerd runner has actually exited; an orphan focused runner can create false local-D1 timeouts and must be stopped before interpreting failures.
- A mutable upload source needs a fresh byte proof immediately adjacent to the upload adapter; a PRE-CAS rehearsal proof cannot close changes that occur after rehearsal.
- Acceptance reconciliation must enumerate each allowed platform-internal object exactly; namespace-wide exclusions such as `_cf_%` can hide unknown production drift.
- When editing a generated executable embedded in a test template literal, inspect the closing delimiter before running the test so helper code is not inserted into the generated program.
- A CLI `--json` flag does not prove stdout is pure JSON: Wrangler 4.86.0 remote D1 file execution emits a fixed non-interactive progress prefix outside its logger level. Bind parsers to the exact known prefix and deterministic envelope, reject every other mixed stream, and never infer a destructive effect from exit status alone.
- Exact-key checks after `JSON.parse` cannot detect contradictory duplicate members because the parser has already kept one value. For evidence contracts, scan the valid raw JSON structure and reject duplicate decoded key names at every object level, including escaped aliases, before trusting the parsed object.
- Before a follow-up tracker mutation, assert the exact remote reread condition in the command's exit status; printing local and remote digests is not a gate, and display-layer newline normalization should be resolved with a bounded diff before continuing.
