# Domain docs

This repository uses a single domain context.

## Before exploring

- Read the root `CONTEXT.md` when it exists.
- Read ADRs under `docs/adr/` that touch the area being changed.
- If either location does not exist, proceed without inventing terminology or decisions. The domain-modeling workflow creates files lazily as terms and durable architectural decisions are resolved.

## Use canonical language

Specifications, tickets, tests, and implementation names must use the vocabulary defined in `CONTEXT.md`. If a needed term is missing or conflicts with existing language, resolve it through domain modeling before publishing downstream work.

If proposed work conflicts with an ADR, surface the conflict explicitly instead of silently overriding the recorded decision.
