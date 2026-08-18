-- migration-number: 007
-- Seed the scheduled executor rollout control so every clean-start delivery
-- captures a non-empty, fully-disabled executors set. The smoke contract
-- (worker stages) requires executors to be non-empty; before this migration
-- nothing ever registered an executor row, so the contract could never be
-- satisfied by a real delivery.

INSERT INTO rollout_controls (
  control_key,
  control_kind,
  desired_enabled,
  candidate_id,
  evidence_sha256,
  evidence_state,
  actor,
  reason
) VALUES (
  'executor:scheduled',
  'executor',
  0,
  '0000000000000000000000000000000000000000',
  'ebdb386f8d60260232e81a4c130ea53c8e190aab4ade87d8ef9dc9221fe9f61c',
  'verified',
  'migrations:seed',
  'Seed executor:scheduled disabled for clean-start rollouts'
);