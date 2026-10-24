-- Phase 8: security & hardening — rate limits shared by every API instance, system flags
-- (maintenance mode), integrity check runs. See docs/11, docs/14.

-- Fixed-window rate-limit counters. UNLOGGED: fast, and losing counters on a crash is harmless.
CREATE UNLOGGED TABLE rate_limits (
  key            text PRIMARY KEY,
  hits           int NOT NULL,
  expires_at     timestamptz NOT NULL,
  blocked_until  timestamptz
);
CREATE INDEX rate_limits_expires_idx ON rate_limits (expires_at);

-- Operational switches set by the Super Admin (audited). maintenance = { enabled, message }.
CREATE TABLE system_flags (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_flags (key, value) VALUES ('maintenance', '{"enabled": false, "message": null}');

-- Results of the ledger / sub-ledger / audit-chain integrity checks (nightly, on demand, restore drills).
CREATE TABLE integrity_runs (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  trigger      text NOT NULL CHECK (trigger IN ('NIGHTLY', 'MANUAL', 'CLI')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  checks       jsonb NOT NULL DEFAULT '[]',
  run_by       uuid REFERENCES users(id)
);
CREATE INDEX integrity_runs_started_idx ON integrity_runs (started_at DESC);
CREATE TRIGGER integrity_runs_no_delete BEFORE DELETE OR TRUNCATE ON integrity_runs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Malware scan bookkeeping on stored files.
ALTER TABLE files ADD COLUMN scanned_at timestamptz;
ALTER TABLE files ADD COLUMN scan_result text;
