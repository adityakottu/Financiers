-- Phase 2: platform, identity, organisation, audit, numbering, customers & KYC.
-- Conventions: see docs/03-database-schema.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- Time-ordered UUIDv7 (index-friendly, not sequential-guessable).
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
DECLARE
  b bytea;
BEGIN
  b := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
       || gen_random_bytes(10);
  b := set_byte(b, 6, (b'0111' || get_byte(b, 6)::bit(4))::bit(8)::int);
  b := set_byte(b, 8, (b'10' || get_byte(b, 8)::bit(6))::bit(8)::int);
  RETURN encode(b, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

-- Generic guard for append-only tables.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

/* ------------------------------------------------------------------ */
/* Organisation                                                        */
/* ------------------------------------------------------------------ */

CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  legal_name      text NOT NULL,
  trade_name      text,
  address         text,
  phone           text,
  email           text,
  gstin           varchar(15),
  receipt_footer  text,
  logo_file_id    uuid,
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  date_format     text NOT NULL DEFAULT 'DD/MM/YYYY',
  currency        char(3) NOT NULL DEFAULT 'INR',
  fy_start_month  smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        varchar(8) NOT NULL UNIQUE,
  name        text NOT NULL,
  address     text,
  phone       varchar(10),
  is_active   boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

/* ------------------------------------------------------------------ */
/* Identity & access                                                   */
/* ------------------------------------------------------------------ */

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  username              citext NOT NULL UNIQUE,
  full_name             text NOT NULL,
  email                 citext UNIQUE,
  mobile                varchar(10) UNIQUE,
  password_hash         text NOT NULL,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  must_change_password  boolean NOT NULL DEFAULT true,
  mfa_enabled           boolean NOT NULL DEFAULT false,
  totp_secret_enc       bytea,
  totp_pending_enc      bytea,
  totp_last_step        bigint,
  failed_login_count    int NOT NULL DEFAULT 0,
  lockout_level         int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  last_login_at         timestamptz,
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);

CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('ALL', 'BRANCH', 'ASSIGNED')),
  mfa_required  boolean NOT NULL DEFAULT false,
  is_system     boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (
  code         text PRIMARY KEY,
  description  text NOT NULL
);

CREATE TABLE role_permissions (
  role_id          uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  user_id  uuid NOT NULL REFERENCES users(id),
  role_id  uuid NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_permission_overrides (
  user_id          uuid NOT NULL REFERENCES users(id),
  permission_code  text NOT NULL REFERENCES permissions(code),
  effect           text NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  PRIMARY KEY (user_id, permission_code)
);

CREATE TABLE user_branches (
  user_id    uuid NOT NULL REFERENCES users(id),
  branch_id  uuid NOT NULL REFERENCES branches(id),
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  token_hash       bytea NOT NULL UNIQUE,
  csrf_hash        bytea NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  ip               inet,
  user_agent       text,
  mfa_pending      boolean NOT NULL DEFAULT false,
  reauth_at        timestamptz,
  revoked_at       timestamptz,
  revoke_reason    text
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_events (
  id                bigserial PRIMARY KEY,
  user_id           uuid REFERENCES users(id),
  identifier        citext NOT NULL,
  success           boolean NOT NULL,
  reason            text NOT NULL,
  ip                inet,
  user_agent        text,
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_identifier_idx ON login_events (identifier, at DESC);
CREATE INDEX login_events_ip_idx ON login_events (ip, at DESC);
CREATE INDEX login_events_user_idx ON login_events (user_id, at DESC);
CREATE TRIGGER login_events_append_only BEFORE UPDATE OR DELETE ON login_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid
);

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id    uuid NOT NULL REFERENCES users(id),
  code_hash  bytea NOT NULL,
  used_at    timestamptz
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE employees (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  user_id        uuid UNIQUE REFERENCES users(id),
  employee_code  varchar(20) NOT NULL UNIQUE,
  full_name      text NOT NULL,
  designation    text,
  mobile         varchar(10),
  joined_on      date,
  is_collector   boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version        int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);
CREATE INDEX employees_branch_idx ON employees (branch_id, status);

/* ------------------------------------------------------------------ */
/* Settings, numbering, idempotency, outbox, files                     */
/* ------------------------------------------------------------------ */

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

CREATE TABLE numbering_formats (
  seq_type    text PRIMARY KEY,
  format      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

-- Gapless counters: rows are locked FOR UPDATE inside the business transaction.
CREATE TABLE numbering_sequences (
  seq_type     text NOT NULL,
  scope_key    text NOT NULL DEFAULT '',
  fiscal_year  int NOT NULL,
  next_value   bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (seq_type, scope_key, fiscal_year)
);

CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id),
  key              uuid NOT NULL,
  route            text NOT NULL,
  request_hash     bytea NOT NULL,
  response_status  int NOT NULL,
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  processed_at  timestamptz,
  last_error    text
);
CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE processed_at IS NULL;

CREATE TABLE files (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  storage_key     text NOT NULL UNIQUE,
  original_name   text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      int NOT NULL CHECK (size_bytes > 0),
  sha256          bytea NOT NULL,
  scan_status     text NOT NULL DEFAULT 'PENDING'
                    CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'FAILED')),
  classification  text NOT NULL,
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

/* ------------------------------------------------------------------ */
/* Audit log — append-only and hash-chained                            */
/* ------------------------------------------------------------------ */

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id      uuid,
  role_codes   text[] NOT NULL DEFAULT '{}',
  branch_id    uuid,
  ip           inet,
  user_agent   text,
  session_id   uuid,
  request_id   text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  old_values   jsonb,
  new_values   jsonb,
  reason       text,
  prev_hash    bytea,
  hash         bytea NOT NULL
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, id DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, id DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, id DESC);
CREATE INDEX audit_logs_at_idx ON audit_logs (at);

CREATE OR REPLACE FUNCTION audit_log_payload(r audit_logs) RETURNS text AS $$
  SELECT concat_ws('|',
    r.id::text, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.user_id::text, ''), array_to_string(r.role_codes, ','),
    coalesce(r.branch_id::text, ''), coalesce(host(r.ip), ''),
    coalesce(r.session_id::text, ''), coalesce(r.request_id, ''),
    r.action, coalesce(r.entity_type, ''), coalesce(r.entity_id, ''),
    coalesce(r.old_values::text, ''), coalesce(r.new_values::text, ''), coalesce(r.reason, ''))
$$ LANGUAGE sql IMMUTABLE;

-- Chains each row to the previous one. The transaction-scoped advisory lock serialises
-- audit writers so the chain is linear in commit order. The id is re-drawn inside the lock so
-- id order equals chain order. Requires READ COMMITTED (each statement sees the latest commit).
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(7314001);
  SELECT hash INTO prev FROM audit_logs ORDER BY id DESC LIMIT 1;
  NEW.id := nextval(pg_get_serial_sequence('audit_logs', 'id'));
  NEW.at := clock_timestamp();
  NEW.prev_hash := prev;
  NEW.hash := digest(coalesce(encode(prev, 'hex'), '') || audit_log_payload(NEW), 'sha256');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Customers & KYC                                                     */
/* ------------------------------------------------------------------ */

CREATE TABLE customers (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  customer_no             text NOT NULL UNIQUE,
  branch_id               uuid NOT NULL REFERENCES branches(id),
  full_name               text NOT NULL,
  relation_type           varchar(3) CHECK (relation_type IN ('S/O', 'D/O', 'W/O', 'C/O')),
  relation_name           text,
  dob                     date,
  gender                  text CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
  mobile                  varchar(10) NOT NULL,
  alt_mobile              varchar(10),
  email                   citext,
  address_line1           text,
  address_line2           text,
  village_town            text,
  mandal                  text,
  district                text,
  state                   text,
  pincode                 varchar(6),
  occupation              text,
  employer_business_name  text,
  business_type           text,
  monthly_income          numeric(18, 2) CHECK (monthly_income >= 0),
  work_address            text,
  kyc_status              text NOT NULL DEFAULT 'PENDING'
                            CHECK (kyc_status IN ('PENDING', 'PARTIAL', 'VERIFIED', 'REJECTED')),
  risk_category           text NOT NULL DEFAULT 'MEDIUM' CHECK (risk_category IN ('LOW', 'MEDIUM', 'HIGH')),
  whatsapp_opt_in         boolean NOT NULL DEFAULT false,
  whatsapp_opt_in_at      timestamptz,
  status                  text NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLACKLISTED')),
  version                 int NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid
);
CREATE INDEX customers_name_trgm_idx ON customers USING gin (full_name gin_trgm_ops);
CREATE INDEX customers_no_trgm_idx ON customers USING gin (customer_no gin_trgm_ops);
CREATE INDEX customers_mobile_idx ON customers (mobile);
CREATE INDEX customers_alt_mobile_idx ON customers (alt_mobile) WHERE alt_mobile IS NOT NULL;
CREATE INDEX customers_branch_idx ON customers (branch_id, status, id DESC);

CREATE TABLE customer_kyc_documents (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  customer_id           uuid NOT NULL REFERENCES customers(id),
  doc_type              text NOT NULL CHECK (doc_type IN ('PAN', 'AADHAAR', 'DRIVING_LICENCE', 'VOTER_ID')),
  -- Encrypted full number (AES-256-GCM). Always NULL for Aadhaar: only the last 4 digits are kept.
  number_enc            bytea,
  number_last4          varchar(4) NOT NULL,
  -- Keyed HMAC for exact-match search and duplicate detection.
  number_bidx           bytea,
  key_version           int,
  verified_by           uuid REFERENCES users(id),
  verified_at           timestamptz,
  verification_method   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (doc_type <> 'AADHAAR' OR (number_enc IS NULL AND number_bidx IS NULL)),
  CHECK (doc_type = 'AADHAAR' OR (number_enc IS NOT NULL AND number_bidx IS NOT NULL)),
  UNIQUE (customer_id, doc_type)
);
CREATE UNIQUE INDEX kyc_pan_unique_idx ON customer_kyc_documents (number_bidx) WHERE doc_type = 'PAN';
CREATE INDEX kyc_bidx_idx ON customer_kyc_documents (doc_type, number_bidx);
CREATE INDEX kyc_aadhaar_last4_idx ON customer_kyc_documents (number_last4) WHERE doc_type = 'AADHAAR';

CREATE TABLE customer_references (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  name         text NOT NULL,
  relationship text NOT NULL,
  mobile       varchar(10) NOT NULL,
  address      text,
  sort_order   smallint NOT NULL DEFAULT 0
);
CREATE INDEX customer_references_customer_idx ON customer_references (customer_id);

CREATE TABLE customer_documents (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  file_id      uuid NOT NULL REFERENCES files(id),
  category     text NOT NULL CHECK (category IN ('KYC', 'ADDRESS_PROOF', 'PHOTO', 'AGREEMENT', 'OTHER')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX customer_documents_customer_idx ON customer_documents (customer_id);

CREATE TABLE customer_events (
  id           bigserial PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  at           timestamptz NOT NULL DEFAULT now(),
  event_type   text NOT NULL,
  summary      text NOT NULL,
  ref_type     text,
  ref_id       text,
  actor_id     uuid
);
CREATE INDEX customer_events_customer_idx ON customer_events (customer_id, at DESC);
CREATE TRIGGER customer_events_append_only BEFORE UPDATE OR DELETE ON customer_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
