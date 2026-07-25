-- migration-number: 006
-- Persist rollout intent separately from effective runtime state and retain an immutable audit trail.

CREATE TABLE rollout_controls (
  control_key TEXT PRIMARY KEY,
  control_kind TEXT NOT NULL CHECK(control_kind IN ('producer', 'authority', 'executor')),
  desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN (0, 1)),
  candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
  evidence_state TEXT NOT NULL CHECK(evidence_state IN ('verified', 'invalid', 'unavailable')),
  actor TEXT NOT NULL CHECK(length(actor) > 0),
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK(
    (control_kind = 'producer' AND control_key = 'producer')
    OR (control_kind = 'authority' AND control_key = 'authority')
    OR (
      control_kind = 'executor'
      AND control_key GLOB 'executor:[a-z0-9_-]*'
      AND length(control_key) > length('executor:')
    )
  )
) STRICT;

CREATE TABLE rollout_control_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT UNIQUE NOT NULL CHECK(length(operation_id) > 0),
  control_key TEXT NOT NULL,
  control_kind TEXT NOT NULL CHECK(control_kind IN ('producer', 'authority', 'executor')),
  previous_enabled INTEGER CHECK(previous_enabled IS NULL OR previous_enabled IN (0, 1)),
  desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN (0, 1)),
  candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
  evidence_state TEXT NOT NULL CHECK(evidence_state IN ('verified', 'invalid', 'unavailable')),
  actor TEXT NOT NULL CHECK(length(actor) > 0),
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER rollout_control_events_no_update
BEFORE UPDATE ON rollout_control_events BEGIN
  SELECT RAISE(ABORT, 'rollout control events are immutable');
END;

CREATE TRIGGER rollout_control_events_no_delete
BEFORE DELETE ON rollout_control_events BEGIN
  SELECT RAISE(ABORT, 'rollout control events are immutable');
END;

CREATE TRIGGER rollout_control_events_no_replace
BEFORE INSERT ON rollout_control_events
WHEN EXISTS (
  SELECT 1 FROM rollout_control_events WHERE operation_id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'rollout control events are immutable');
END;
