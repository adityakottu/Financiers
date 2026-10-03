-- Phase 7: recovery (cases, configurable stages, actions, asset repossession and sale, write-off E13)
-- and reporting support (remembered report filters, export jobs). See docs/07 §E13–E14, docs/10.

/* ------------------------------------------------------------------ */
/* Loan write-off status                                               */
/* ------------------------------------------------------------------ */

ALTER TABLE loans DROP CONSTRAINT loans_status_check;
ALTER TABLE loans ADD CONSTRAINT loans_status_check CHECK (status IN
  ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ACTIVE', 'CLOSED', 'CANCELLED', 'WRITTEN_OFF'));
ALTER TABLE loans ADD COLUMN written_off_at timestamptz;

-- Asset sales and write-offs are dated postings too: refused on a closed branch day.
CREATE OR REPLACE FUNCTION journal_day_check() RETURNS trigger AS $$
BEGIN
  IF NEW.branch_id IS NOT NULL AND NEW.entry_type IN ('PAYMENT', 'DEPOSIT', 'EXPENSE', 'DISBURSEMENT', 'MANUAL', 'TRANSFER', 'FEE', 'SALE', 'WRITE_OFF')
     AND EXISTS (SELECT 1 FROM business_days d WHERE d.branch_id = NEW.branch_id AND d.business_date = NEW.value_date AND d.status = 'CLOSED') THEN
    RAISE EXCEPTION 'The business day % is closed for this branch', NEW.value_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Days past due at which the nightly job opens a recovery case automatically (0 = never).
ALTER TABLE companies ADD COLUMN recovery_auto_open_dpd int NOT NULL DEFAULT 30 CHECK (recovery_auto_open_dpd >= 0);

/* ------------------------------------------------------------------ */
/* Recovery stages (configurable; no legal step is hard-coded ⚖)       */
/* ------------------------------------------------------------------ */

CREATE TABLE recovery_stage_definitions (
  code               text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name               text NOT NULL,
  description        text,
  sort_order         int NOT NULL,
  -- Moving INTO this stage needs a second person with recovery.approve.
  requires_approval  boolean NOT NULL DEFAULT false,
  -- A terminal stage closes the case.
  is_terminal        boolean NOT NULL DEFAULT false,
  allowed_next       text[] NOT NULL DEFAULT '{}',
  active             boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id)
);

INSERT INTO recovery_stage_definitions (code, name, description, sort_order, requires_approval, is_terminal, allowed_next) VALUES
  ('FOLLOW_UP',   'Follow-up',             'Calls and reminders by the assigned collector', 10, false, false, '{FIELD_VISIT,SETTLEMENT,RESOLVED}'),
  ('FIELD_VISIT', 'Field recovery',        'Regular visits; promises to pay tracked',       20, false, false, '{FOLLOW_UP,ESCALATED,SETTLEMENT,RESOLVED}'),
  ('ESCALATED',   'Escalated to manager',  'Branch manager meets the customer / guarantor', 30, false, false, '{FIELD_VISIT,SETTLEMENT,REPOSSESSION,RESOLVED}'),
  ('SETTLEMENT',  'Settlement discussion', 'Negotiating a plan or one-time settlement',     40, false, false, '{FIELD_VISIT,ESCALATED,RESOLVED,WRITTEN_OFF}'),
  ('REPOSSESSION','Repossession',          'Only after the steps your legal advisor requires ⚖', 50, true, false, '{ESCALATED,SETTLEMENT,RESOLVED,WRITTEN_OFF}'),
  ('RESOLVED',    'Resolved',              'Dues cleared or the account regularised',        90, false, true,  '{}'),
  ('WRITTEN_OFF', 'Closed — written off',  'Closed after an approved write-off',            95, true,  true,  '{}');

/* ------------------------------------------------------------------ */
/* Cases and actions                                                   */
/* ------------------------------------------------------------------ */

CREATE TABLE recovery_cases (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  case_no               text NOT NULL UNIQUE,
  loan_id               uuid NOT NULL REFERENCES loans(id),
  branch_id             uuid NOT NULL REFERENCES branches(id),
  stage                 text NOT NULL REFERENCES recovery_stage_definitions(code),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opened_by             uuid REFERENCES users(id),           -- NULL = opened by the nightly job
  dpd_at_open           int NOT NULL,
  overdue_at_open       numeric(18, 2) NOT NULL,
  owner_employee_id     uuid REFERENCES employees(id),
  -- A stage move that needs approval waits here until a second person decides.
  requested_stage       text REFERENCES recovery_stage_definitions(code),
  requested_by          uuid REFERENCES users(id),
  requested_at          timestamptz,
  request_note          text,
  closed_at             timestamptz,
  closed_by             uuid REFERENCES users(id),
  close_reason          text,
  version               int NOT NULL DEFAULT 1,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
-- At most one open case per loan.
CREATE UNIQUE INDEX recovery_cases_open_idx ON recovery_cases (loan_id) WHERE status = 'OPEN';
CREATE INDEX recovery_cases_branch_idx ON recovery_cases (branch_id, status);

CREATE TABLE recovery_actions (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  case_id      uuid NOT NULL REFERENCES recovery_cases(id),
  action_type  text NOT NULL CHECK (action_type IN ('OPENED', 'NOTE', 'CALL', 'VISIT', 'STAGE_CHANGED', 'STAGE_REQUESTED', 'STAGE_REJECTED',
                                                     'REPOSSESSED', 'RELEASED', 'SALE_REQUESTED', 'SALE_APPROVED', 'SALE_REJECTED',
                                                     'WRITE_OFF_REQUESTED', 'WRITTEN_OFF', 'WRITE_OFF_REJECTED', 'CLOSED', 'REOPENED')),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users(id),
  summary      text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX recovery_actions_case_idx ON recovery_actions (case_id, at);
-- The recovery history is evidence: append-only.
CREATE TRIGGER recovery_actions_append_only BEFORE UPDATE OR DELETE ON recovery_actions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Repossession and sale of the financed asset (E14) ⚖                 */
/* ------------------------------------------------------------------ */

CREATE TABLE asset_repossessions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  asset_id            uuid NOT NULL REFERENCES assets(id),
  loan_id             uuid NOT NULL REFERENCES loans(id),
  case_id             uuid REFERENCES recovery_cases(id),
  repossessed_on      date NOT NULL,
  location            text NOT NULL,         -- where the asset is kept (yard)
  condition_notes     text NOT NULL,
  valuation           numeric(18, 2) CHECK (valuation > 0),
  recorded_by         uuid NOT NULL REFERENCES users(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  released_on         date,
  released_by         uuid REFERENCES users(id),
  release_reason      text
);
CREATE UNIQUE INDEX asset_repossessions_live_idx ON asset_repossessions (asset_id) WHERE released_on IS NULL;

CREATE TABLE asset_sales (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  sale_no           text NOT NULL UNIQUE,
  asset_id          uuid NOT NULL REFERENCES assets(id),
  loan_id           uuid NOT NULL REFERENCES loans(id),
  case_id           uuid REFERENCES recovery_cases(id),
  sale_price        numeric(18, 2) NOT NULL CHECK (sale_price > 0),
  sold_on           date NOT NULL,
  buyer_name        text NOT NULL,
  buyer_reference   text,                    -- invoice / agreement number
  account_id        uuid NOT NULL REFERENCES accounts(id),   -- bank account receiving the money
  notes             text,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by      uuid NOT NULL REFERENCES users(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  applied_amount    numeric(18, 2),          -- applied to the loan's dues
  surplus_amount    numeric(18, 2),          -- owed back to the customer (held in 2200)
  journal_entry_id  uuid REFERENCES journal_entries(id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX asset_sales_live_idx ON asset_sales (asset_id) WHERE status IN ('PENDING', 'APPROVED');

/* ------------------------------------------------------------------ */
/* Write-off (E13) ⚖                                                   */
/* ------------------------------------------------------------------ */

CREATE TABLE loan_write_offs (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id           uuid NOT NULL REFERENCES loans(id),
  case_id           uuid REFERENCES recovery_cases(id),
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by      uuid NOT NULL REFERENCES users(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  written_off_on    date,
  -- Ledger balances removed, by component, at approval.
  principal         numeric(18, 2),
  interest          numeric(18, 2),
  fees              numeric(18, 2),
  penalty           numeric(18, 2),
  advance_used      numeric(18, 2),
  amount            numeric(18, 2),          -- charged to 5600 Bad Debts
  journal_entry_id  uuid REFERENCES journal_entries(id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX loan_write_offs_live_idx ON loan_write_offs (loan_id) WHERE status IN ('PENDING', 'APPROVED');

-- Money received after a write-off is income (4500 Bad Debts Recovered), not a loan repayment:
-- it has no allocations at all, and none can be added to it.
ALTER TABLE payments ADD COLUMN is_post_write_off boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION allocation_total_check() RETURNS trigger AS $$
DECLARE
  expected numeric;
  got numeric;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    SELECT CASE WHEN NEW.is_post_write_off THEN 0 ELSE NEW.amount END, coalesce(sum(amount), 0) INTO expected, got FROM payment_allocations WHERE payment_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'advance_applications' THEN
    SELECT NEW.amount, coalesce(sum(amount), 0) INTO expected, got FROM payment_allocations WHERE advance_application_id = NEW.id;
  ELSIF NEW.payment_id IS NOT NULL THEN
    SELECT CASE WHEN p.is_post_write_off THEN 0 ELSE p.amount END, (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = p.id) INTO expected, got
      FROM payments p WHERE p.id = NEW.payment_id;
  ELSE
    SELECT a.amount, (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE advance_application_id = a.id) INTO expected, got
      FROM advance_applications a WHERE a.id = NEW.advance_application_id;
  END IF;
  IF expected IS DISTINCT FROM got THEN
    RAISE EXCEPTION 'Allocations (%) do not add up to the amount received (%)', got, expected USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

-- Last filters a user chose per report (doc 10: remembered per user).
CREATE TABLE report_preferences (
  user_id     uuid NOT NULL REFERENCES users(id),
  report      text NOT NULL,
  filters     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, report)
);

-- Large exports run in the background; the file is kept for 7 days, only for its requester.
CREATE TABLE export_jobs (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  report        text NOT NULL,
  format        text NOT NULL CHECK (format IN ('xlsx', 'pdf')),
  filters       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  row_count     int,
  file_name     text,
  content       bytea,
  error         text,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX export_jobs_user_idx ON export_jobs (requested_by, requested_at DESC);

INSERT INTO numbering_formats (seq_type, format) VALUES ('RECOVERY', 'REC-{BR}-{FY}-{SEQ:5}'), ('SALE', 'SALE-{FY}-{SEQ:5}') ON CONFLICT (seq_type) DO NOTHING;
