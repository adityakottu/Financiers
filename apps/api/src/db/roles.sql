-- Least-privilege database roles (doc 11 §7). Run by the database owner after migrations
-- (`pnpm --filter @fin/api db:roles`); safe to run again. Passwords are NOT set here — set them
-- from the secrets manager:  ALTER ROLE fin_app PASSWORD '…';
--
--   fin_migrator  owns the schema (runs migrations; CI/deploy only)
--   fin_app       what the API and workers connect as: read, insert, update — but never TRUNCATE,
--                 never DDL, never UPDATE on append-only financial history, and DELETE only on the
--                 few housekeeping tables that need it
--   fin_readonly  reports / BI / restore checks: read only
--   fin_audit     auditors: read the audit trail and sign-in history only
--
-- The append-only tables also carry triggers that refuse UPDATE/DELETE; the grants make the
-- database refuse it for the application role even if a trigger were dropped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_app') THEN CREATE ROLE fin_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_readonly') THEN CREATE ROLE fin_readonly LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_audit') THEN CREATE ROLE fin_audit LOGIN; END IF;
END $$;

DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO fin_app, fin_readonly, fin_audit', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO fin_app, fin_readonly, fin_audit;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Application: read / insert / update everywhere, then take away what it must never do.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fin_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fin_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO fin_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fin_app;

-- Financial and evidential history: written once, never changed.
REVOKE UPDATE ON
  journal_entries, journal_lines, audit_logs, payment_allocations, recovery_actions, asset_events,
  customer_events, login_events, bank_statement_imports, integrity_runs, schema_migrations
FROM fin_app;

-- Housekeeping rows the application legitimately removes (sessions, rate counters, role links, …).
GRANT DELETE ON
  rate_limits, job_runs, mfa_recovery_codes, role_permissions, user_branches, user_roles, idempotency_keys
TO fin_app;

-- Read-only roles.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fin_readonly, fin_audit;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fin_readonly;
GRANT SELECT ON audit_logs, login_events, users TO fin_audit;
