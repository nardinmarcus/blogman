# Consume authorization at the execute entry

Consume a valid Authorization when its exact bytes and bound Canonical Frozen Manifest are presented to the formal `execute` entry, before live reads, credential access, build tooling, or production adapters. Delivery Preparation, validation, target-runtime rehearsal, and independent review do not consume it. After entry, the first mismatch, error, timeout, process failure, or uncertain outcome makes the Delivery Attempt terminal; uncertainty about consumption is treated as consumed and cannot authorize a retry.

Status: Completed. Issue #23 Delivery finished with the single production attempt (#99–#101, closed 2026-08-19). The delivery implementation, its schemas, tests, read-only history audit adapter and macOS CI gate were retired in #259; the historical code remains in Git history.
