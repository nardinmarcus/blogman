-- migration-number: 009
-- Retire the legacy posts compat projection (ADR 0008). Production dropped
-- posts/posts_fts during #234; this brings every other database to the same
-- schema. Every read and write path resolves against canonical facts only.
-- The data sidecar fails closed while posts holds a row without a canonical
-- article identity, so legacy content is never dropped.
DROP TRIGGER IF EXISTS posts_ai;
DROP TRIGGER IF EXISTS posts_au;
DROP TRIGGER IF EXISTS posts_ad;
DROP TABLE IF EXISTS posts_fts;
DROP TABLE IF EXISTS posts;
