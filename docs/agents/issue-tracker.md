# Issue tracker: GitHub

Issues, specifications, and implementation tickets for this repository live in GitHub Issues in the canonical `nardinmarcus/blogman` repository.

## Conventions

- Always pass `--repo nardinmarcus/blogman` to every `gh` command. Never target `namooca/blogman` or infer the repository from the working directory.
- Issue #19 is the closed historical Wayfinder implementation tracker, not an active queue. Independent follow-ups use their own issues; reference #19 for lineage when relevant rather than attaching new work to the closed parent.
- Do not create a parallel local Markdown tracker or `.scratch` issue graph.
- Read issue bodies, comments, labels, and native `blockedBy` / `blocking` relationships before acting.
- Publish specifications and implementation tickets as GitHub Issues. Use GitHub native issue dependencies for blocking edges.
- Do not close or rewrite a parent issue when publishing child tickets.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests are implementation and review artifacts, not an alternative requirements tracker.
