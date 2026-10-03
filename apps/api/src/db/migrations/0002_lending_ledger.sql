-- Phase 3: ledger core, loan products, loans, schedules, assets, scheduled jobs.
-- See docs/03-database-schema.md, docs/06 (calculations) and docs/07 (accounting).

/* ------------------------------------------------------------------ */
/* Ledger core                                                         */
/* ------------------------------------------------------------------ */

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  normal_balance  text NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  parent_id       uuid REFERENCES accounts(id),
  is_postable     boolean NOT NULL DEFAULT true,
  subtype         text,
  branch_id       uuid REFERENCES branches(id),
  employee_id     uuid REFERENCES employees(id),
  is_system       boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid
);
CREATE INDEX accounts_subtype_idx ON accounts (subtype, branch_id);

CREATE TABLE bank_accounts (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id        uuid NOT NULL UNIQUE REFERENCES accounts(id),
  bank_name         text NOT NULL,
  branch_name       text,
  account_no_enc    bytea,
  account_no_last4  varchar(4),
  ifsc              varchar(11),
  upi_vpa           text,
  kind              text NOT NULL CHECK (kind IN ('CURRENT', 'SAVINGS', 'UPI_SETTLEMENT', 'WALLET')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid
);

CREATE TABLE accounting_periods (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  period_start  date NOT NULL UNIQUE,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SOFT_LOCKED', 'LOCKED')),
  locked_by     uuid,
  locked_at     timestamptz,
  CHECK (period_end >= period_start)
);

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  entry_no           text NOT NULL UNIQUE,
  entry_type         text NOT NULL CHECK (entry_type IN (
                       'DISBURSEMENT', 'FEE', 'PAYMENT', 'ACCRUAL', 'PENALTY', 'EXPENSE', 'DEPOSIT', 'TRANSFER',
                       'ADJUSTMENT', 'REVERSAL', 'OPENING', 'WRITE_OFF', 'REPOSSESSION', 'SALE', 'MANUAL')),
  value_date         date NOT NULL,
  posted_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  branch_id          uuid REFERENCES branches(id),
  source_type        text,
  source_id          text,
  narration          text NOT NULL,
  reverses_entry_id  uuid UNIQUE REFERENCES journal_entries(id),
  created_by         uuid,
  approved_by        uuid
);
CREATE INDEX journal_entries_source_idx ON journal_entries (source_type, source_id);
CREATE INDEX journal_entries_value_date_idx ON journal_entries (value_date);

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  line_no      smallint NOT NULL,
  account_id   uuid NOT NULL REFERENCES accounts(id),
  debit        numeric(18, 2) NOT NULL DEFAULT 0,
  credit       numeric(18, 2) NOT NULL DEFAULT 0,
  branch_id    uuid REFERENCES branches(id),
  loan_id      uuid,
  customer_id  uuid,
  employee_id  uuid,
  memo         text,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit = 0) <> (credit = 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_lines_account_idx ON journal_lines (account_id, entry_id);
CREATE INDEX journal_lines_loan_idx ON journal_lines (loan_id) WHERE loan_id IS NOT NULL;

-- Journals are permanent. Corrections are new REVERSAL/ADJUSTMENT entries.
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Only active leaf accounts take postings.
CREATE OR REPLACE FUNCTION journal_line_account_check() RETURNS trigger AS $$
DECLARE
  a record;
BEGIN
  SELECT is_postable, is_active, code INTO a FROM accounts WHERE id = NEW.account_id;
  IF NOT a.is_postable OR NOT a.is_active THEN
    RAISE EXCEPTION 'Account % cannot take postings', a.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_account_check BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_line_account_check();

-- Every entry must balance (Σ debit = Σ credit) with at least two lines, checked at COMMIT
-- so the lines of one entry can be inserted one by one inside the transaction.
CREATE OR REPLACE FUNCTION journal_entry_balance_check() RETURNS trigger AS $$
DECLARE
  eid uuid;
  d numeric;
  c numeric;
  n int;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    eid := NEW.id;
  ELSE
    eid := NEW.entry_id;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
    FROM journal_lines WHERE entry_id = eid;
  IF n < 2 OR d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced (debit %, credit %, % lines)', eid, d, c, n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balance_check();
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balance_check();

-- Locked periods take no postings; soft-locked periods take only adjustments and reversals.
CREATE OR REPLACE FUNCTION journal_period_check() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM accounting_periods
    WHERE NEW.value_date BETWEEN period_start AND period_end;
  IF st = 'LOCKED' THEN
    RAISE EXCEPTION 'Accounting period for % is locked', NEW.value_date USING ERRCODE = 'check_violation';
  ELSIF st = 'SOFT_LOCKED' AND NEW.entry_type NOT IN ('ADJUSTMENT', 'REVERSAL') THEN
    RAISE EXCEPTION 'Accounting period for % is soft-locked: only adjustments and reversals allowed', NEW.value_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_period_check BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_period_check();

-- Chart of accounts (doc 07 §2). Per-branch cash, employee cash-in-hand and bank accounts are
-- created by the application as branches/employees/banks are added.
INSERT INTO accounts (code, name, type, normal_balance, is_postable, subtype, is_system) VALUES
  ('1000', 'Assets', 'ASSET', 'DEBIT', false, NULL, true),
  ('1100', 'Cash', 'ASSET', 'DEBIT', false, NULL, true),
  ('1200', 'Bank', 'ASSET', 'DEBIT', false, NULL, true),
  ('1300', 'Loan Receivables', 'ASSET', 'DEBIT', false, NULL, true),
  ('1310', 'Loan Principal Receivable', 'ASSET', 'DEBIT', true, 'LOAN_RECEIVABLE', true),
  ('1320', 'Interest Receivable', 'ASSET', 'DEBIT', true, 'INTEREST_RECEIVABLE', true),
  ('1330', 'Fees Receivable', 'ASSET', 'DEBIT', true, 'FEES_RECEIVABLE', true),
  ('1340', 'Penal Charges Receivable', 'ASSET', 'DEBIT', true, 'PENAL_RECEIVABLE', true),
  ('1400', 'Other Receivables', 'ASSET', 'DEBIT', false, NULL, true),
  ('1410', 'Employee Shortage Recoverable', 'ASSET', 'DEBIT', true, 'EMPLOYEE_SHORTAGE', true),
  ('1420', 'Staff Advances', 'ASSET', 'DEBIT', true, NULL, true),
  ('1500', 'Repossessed Assets Held for Sale', 'ASSET', 'DEBIT', true, NULL, true),
  ('1600', 'Fixed Assets', 'ASSET', 'DEBIT', true, NULL, true),
  ('1710', 'GST Input Credit', 'ASSET', 'DEBIT', true, NULL, true),
  ('2000', 'Liabilities', 'LIABILITY', 'CREDIT', false, NULL, true),
  ('2100', 'Payables — Vendors', 'LIABILITY', 'CREDIT', true, NULL, true),
  ('2200', 'Customer Advances', 'LIABILITY', 'CREDIT', true, 'CUSTOMER_ADVANCE', true),
  ('2250', 'Unidentified Receipts (Suspense)', 'LIABILITY', 'CREDIT', true, 'SUSPENSE', true),
  ('2310', 'GST Output Payable', 'LIABILITY', 'CREDIT', true, 'GST_OUTPUT', true),
  ('2400', 'Insurance Premium Payable', 'LIABILITY', 'CREDIT', true, NULL, true),
  ('2500', 'Borrowings', 'LIABILITY', 'CREDIT', true, NULL, true),
  ('2900', 'Other Liabilities', 'LIABILITY', 'CREDIT', true, NULL, true),
  ('3000', 'Equity', 'EQUITY', 'CREDIT', false, NULL, true),
  ('3100', 'Capital', 'EQUITY', 'CREDIT', true, NULL, true),
  ('3200', 'Retained Earnings', 'EQUITY', 'CREDIT', true, NULL, true),
  ('3900', 'Opening Balance Equity', 'EQUITY', 'CREDIT', true, 'OPENING_EQUITY', true),
  ('4000', 'Income', 'INCOME', 'CREDIT', false, NULL, true),
  ('4100', 'Interest Income', 'INCOME', 'CREDIT', true, 'INTEREST_INCOME', true),
  ('4210', 'Processing Fee Income', 'INCOME', 'CREDIT', true, 'FEE_INCOME', true),
  ('4220', 'Documentation Fee Income', 'INCOME', 'CREDIT', true, 'FEE_INCOME', true),
  ('4230', 'Other Charges Income', 'INCOME', 'CREDIT', true, 'FEE_INCOME', true),
  ('4300', 'Penal Charges Income', 'INCOME', 'CREDIT', true, 'PENAL_INCOME', true),
  ('4400', 'Other Income', 'INCOME', 'CREDIT', true, NULL, true),
  ('4500', 'Bad Debts Recovered', 'INCOME', 'CREDIT', true, NULL, true),
  ('4600', 'Cash Excess (Over)', 'INCOME', 'CREDIT', true, NULL, true),
  ('5000', 'Expenses', 'EXPENSE', 'DEBIT', false, NULL, true),
  ('5100', 'Salaries', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5200', 'Rent', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5300', 'Fuel', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5310', 'Travel', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5400', 'Office Expenses', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5500', 'Bank Charges', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5600', 'Bad Debts Written Off', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5610', 'Loss on Sale of Repossessed Asset', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5700', 'Cash Shortage Written Off', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5800', 'Interest / Penalty Waived', 'EXPENSE', 'DEBIT', true, NULL, true),
  ('5900', 'Other Expenses', 'EXPENSE', 'DEBIT', true, NULL, true);

UPDATE accounts c SET parent_id = p.id FROM accounts p
  WHERE p.code = CASE
    WHEN c.code IN ('1100', '1200', '1300', '1400', '1500', '1600', '1710') THEN '1000'
    WHEN c.code LIKE '13_0' AND c.code <> '1300' THEN '1300'
    WHEN c.code IN ('1410', '1420') THEN '1400'
    WHEN c.code LIKE '2%' AND c.code <> '2000' THEN '2000'
    WHEN c.code LIKE '3%' AND c.code <> '3000' THEN '3000'
    WHEN c.code LIKE '4%' AND c.code <> '4000' THEN '4000'
    WHEN c.code LIKE '5%' AND c.code <> '5000' THEN '5000'
  END;

/* ------------------------------------------------------------------ */
/* Loan products (versioned)                                           */
/* ------------------------------------------------------------------ */

CREATE TABLE loan_products (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  code                 text NOT NULL,
  version              int NOT NULL DEFAULT 1,
  is_latest            boolean NOT NULL DEFAULT true,
  name                 text NOT NULL,
  description          text,
  category             text NOT NULL CHECK (category IN
                         ('ELECTRONICS', 'TWO_WHEELER', 'THREE_WHEELER', 'FOUR_WHEELER', 'BUS', 'LORRY_TRUCK', 'OTHER')),
  interest_method      text NOT NULL CHECK (interest_method IN ('FLAT', 'REDUCING_EMI', 'SIMPLE')),
  rate_min             numeric(9, 4) NOT NULL,
  rate_default         numeric(9, 4) NOT NULL,
  rate_max             numeric(9, 4) NOT NULL,
  amount_min           numeric(18, 2) NOT NULL,
  amount_max           numeric(18, 2) NOT NULL,
  tenure_min           int NOT NULL CHECK (tenure_min >= 1),
  tenure_max           int NOT NULL,
  allowed_frequencies  text[] NOT NULL,
  rounding_unit        text NOT NULL DEFAULT '1' CHECK (rounding_unit IN ('0.01', '1', '10')),
  skip_sundays         boolean NOT NULL DEFAULT false,
  fee_rules            jsonb NOT NULL DEFAULT '[]',
  penalty_rule         jsonb NOT NULL,
  allocation_rule      jsonb NOT NULL,
  max_ltv_pct          numeric(5, 2),
  approval_limit       numeric(18, 2),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  UNIQUE (code, version),
  CHECK (rate_min <= rate_default AND rate_default <= rate_max),
  CHECK (amount_min <= amount_max AND amount_min > 0),
  CHECK (tenure_min <= tenure_max)
);
CREATE UNIQUE INDEX loan_products_latest_idx ON loan_products (code) WHERE is_latest;

/* ------------------------------------------------------------------ */
/* Loans, schedules, charges                                           */
/* ------------------------------------------------------------------ */

CREATE TABLE loans (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_no                    text NOT NULL UNIQUE,
  customer_id                uuid NOT NULL REFERENCES customers(id),
  branch_id                  uuid NOT NULL REFERENCES branches(id),
  product_id                 uuid NOT NULL REFERENCES loan_products(id),
  category                   text NOT NULL,
  status                     text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                               ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ACTIVE', 'CLOSED', 'CANCELLED')),
  -- Terms, frozen at creation (the product can change later without affecting this loan).
  asset_value                numeric(18, 2),
  down_payment               numeric(18, 2) NOT NULL DEFAULT 0,
  principal                  numeric(18, 2) NOT NULL CHECK (principal > 0),
  annual_rate                numeric(9, 4) NOT NULL,
  interest_method            text NOT NULL,
  frequency                  text NOT NULL,
  custom_interval_days       int,
  num_installments           int NOT NULL,
  rounding_unit              text NOT NULL,
  skip_sundays               boolean NOT NULL DEFAULT false,
  disbursement_date          date NOT NULL,
  first_due_date             date NOT NULL,
  maturity_date              date NOT NULL,
  fees                       jsonb NOT NULL DEFAULT '[]',
  penalty_rule               jsonb NOT NULL,
  allocation_rule            jsonb NOT NULL,
  -- Engine totals.
  total_interest             numeric(18, 2) NOT NULL,
  total_fees                 numeric(18, 2) NOT NULL,
  total_gst                  numeric(18, 2) NOT NULL,
  fees_deducted              numeric(18, 2) NOT NULL,
  fees_in_installments       numeric(18, 2) NOT NULL,
  total_payable              numeric(18, 2) NOT NULL,
  installment_amount         numeric(18, 2) NOT NULL,
  net_disbursement           numeric(18, 2) NOT NULL,
  apr                        numeric(9, 4) NOT NULL,
  engine_version             text NOT NULL,
  calc_snapshot              jsonb NOT NULL,
  -- Disbursement.
  disbursed_at               timestamptz,
  disbursed_on               date,
  disbursement_account_id    uuid REFERENCES accounts(id),
  disbursement_mode          text CHECK (disbursement_mode IN ('CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE')),
  disbursement_reference     text,
  disbursement_journal_id    uuid REFERENCES journal_entries(id),
  -- Balances maintained in the same transaction as every change; verifiable from installments.
  principal_outstanding      numeric(18, 2) NOT NULL DEFAULT 0,
  interest_outstanding       numeric(18, 2) NOT NULL DEFAULT 0,
  fees_outstanding           numeric(18, 2) NOT NULL DEFAULT 0,
  penalty_outstanding        numeric(18, 2) NOT NULL DEFAULT 0,
  balance_payable            numeric(18, 2) NOT NULL DEFAULT 0,
  overdue_amount             numeric(18, 2) NOT NULL DEFAULT 0,
  dpd                        int NOT NULL DEFAULT 0,
  next_due_date              date,
  next_due_amount            numeric(18, 2),
  assigned_collector_id      uuid REFERENCES employees(id),
  -- Workflow.
  created_by                 uuid NOT NULL,
  submitted_by               uuid,
  submitted_at               timestamptz,
  approved_by                uuid,
  approved_at                timestamptz,
  rejected_by                uuid,
  rejected_at                timestamptz,
  decision_note              text,
  cancelled_by               uuid,
  cancelled_at               timestamptz,
  cancel_reason              text,
  closed_at                  timestamptz,
  version                    int NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- Maker-checker: the person who created a loan cannot approve it.
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX loans_branch_status_idx ON loans (branch_id, status, id DESC);
CREATE INDEX loans_customer_idx ON loans (customer_id);
CREATE INDEX loans_status_next_due_idx ON loans (status, next_due_date);
CREATE INDEX loans_collector_idx ON loans (assigned_collector_id, status);
CREATE INDEX loans_no_trgm_idx ON loans USING gin (loan_no gin_trgm_ops);

CREATE TABLE loan_installments (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id              uuid NOT NULL REFERENCES loans(id),
  schedule_version     int NOT NULL DEFAULT 1,
  installment_no       int NOT NULL,
  due_date             date NOT NULL,
  opening_principal    numeric(18, 2) NOT NULL,
  closing_principal    numeric(18, 2) NOT NULL,
  principal_due        numeric(18, 2) NOT NULL CHECK (principal_due >= 0),
  interest_due         numeric(18, 2) NOT NULL CHECK (interest_due >= 0),
  fees_due             numeric(18, 2) NOT NULL DEFAULT 0 CHECK (fees_due >= 0),
  penalty_due          numeric(18, 2) NOT NULL DEFAULT 0 CHECK (penalty_due >= 0),
  principal_paid       numeric(18, 2) NOT NULL DEFAULT 0,
  interest_paid        numeric(18, 2) NOT NULL DEFAULT 0,
  fees_paid            numeric(18, 2) NOT NULL DEFAULT 0,
  penalty_paid         numeric(18, 2) NOT NULL DEFAULT 0,
  waived_amount        numeric(18, 2) NOT NULL DEFAULT 0,
  total_due            numeric(18, 2) GENERATED ALWAYS AS (principal_due + interest_due + fees_due + penalty_due - waived_amount) STORED,
  total_paid           numeric(18, 2) GENERATED ALWAYS AS (principal_paid + interest_paid + fees_paid + penalty_paid) STORED,
  status               text NOT NULL DEFAULT 'UPCOMING' CHECK (status IN
                         ('UPCOMING', 'DUE_TODAY', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'RESCHEDULED')),
  days_overdue         int NOT NULL DEFAULT 0,
  paid_on              date,
  interest_accrued_at  timestamptz,
  CHECK (principal_paid BETWEEN 0 AND principal_due),
  CHECK (interest_paid BETWEEN 0 AND interest_due),
  CHECK (fees_paid BETWEEN 0 AND fees_due),
  CHECK (penalty_paid BETWEEN 0 AND penalty_due),
  UNIQUE (loan_id, schedule_version, installment_no)
);
CREATE INDEX loan_installments_due_idx ON loan_installments (due_date, status);
CREATE INDEX loan_installments_loan_idx ON loan_installments (loan_id, schedule_version, installment_no);

CREATE TABLE loan_charges (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id           uuid NOT NULL REFERENCES loans(id),
  installment_id    uuid REFERENCES loan_installments(id),
  charge_type       text NOT NULL CHECK (charge_type IN ('FEE', 'PENALTY')),
  code              text NOT NULL,
  description       text NOT NULL,
  amount            numeric(18, 2) NOT NULL CHECK (amount > 0),
  gst_amount        numeric(18, 2) NOT NULL DEFAULT 0,
  collection_mode   text,
  assessed_on       date NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COLLECTED', 'DEDUCTED', 'WAIVED')),
  journal_entry_id  uuid REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- A penalty is assessed at most once per installment per day (makes the nightly job idempotent).
CREATE UNIQUE INDEX loan_charges_penalty_day_idx ON loan_charges (installment_id, assessed_on) WHERE charge_type = 'PENALTY';
CREATE INDEX loan_charges_loan_idx ON loan_charges (loan_id);

ALTER TABLE customer_events ADD COLUMN loan_id uuid REFERENCES loans(id);
CREATE INDEX customer_events_loan_idx ON customer_events (loan_id, at DESC) WHERE loan_id IS NOT NULL;

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

CREATE TABLE assets (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  asset_no              text NOT NULL UNIQUE,
  loan_id               uuid NOT NULL REFERENCES loans(id),
  customer_id           uuid NOT NULL REFERENCES customers(id),
  branch_id             uuid NOT NULL REFERENCES branches(id),
  category              text NOT NULL,
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN
                          ('PENDING', 'ACTIVE', 'REPOSSESSED', 'RELEASED', 'SOLD', 'CLOSED', 'WRITTEN_OFF', 'CANCELLED')),
  description           text,
  make                  text,
  model                 text,
  variant               text,
  manufacture_year      smallint,
  colour                text,
  serial_no             text,
  registration_no       text,
  chassis_no            text,
  engine_no             text,
  vehicle_type          text,
  asset_value           numeric(18, 2),
  purchase_price        numeric(18, 2),
  purchase_date         date,
  dealer_name           text,
  invoice_no            text,
  hypothecation_marked  boolean NOT NULL DEFAULT false,
  hypothecation_date    date,
  insurer               text,
  insurance_policy_no   text,
  insurance_expiry      date,
  permit_no             text,
  permit_expiry         date,
  fitness_expiry        date,
  tax_valid_till        date,
  attributes            jsonb NOT NULL DEFAULT '{}',
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);
-- The same vehicle cannot be financed twice while a loan on it is live.
CREATE UNIQUE INDEX assets_registration_live_idx ON assets (registration_no)
  WHERE registration_no IS NOT NULL AND status IN ('PENDING', 'ACTIVE', 'REPOSSESSED');
CREATE UNIQUE INDEX assets_chassis_live_idx ON assets (chassis_no)
  WHERE chassis_no IS NOT NULL AND status IN ('PENDING', 'ACTIVE', 'REPOSSESSED');
CREATE INDEX assets_registration_trgm_idx ON assets USING gin (registration_no gin_trgm_ops);
CREATE INDEX assets_chassis_trgm_idx ON assets USING gin (chassis_no gin_trgm_ops);
CREATE INDEX assets_engine_trgm_idx ON assets USING gin (engine_no gin_trgm_ops);
CREATE INDEX assets_serial_idx ON assets (serial_no) WHERE serial_no IS NOT NULL;
CREATE INDEX assets_loan_idx ON assets (loan_id);

CREATE TABLE asset_documents (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  file_id      uuid NOT NULL REFERENCES files(id),
  doc_type     text NOT NULL CHECK (doc_type IN ('RC', 'INSURANCE', 'INVOICE', 'PERMIT', 'FITNESS', 'NOC', 'PHOTO', 'OTHER')),
  expiry_date  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL
);

CREATE TABLE asset_events (
  id           bigserial PRIMARY KEY,
  asset_id     uuid NOT NULL REFERENCES assets(id),
  at           timestamptz NOT NULL DEFAULT now(),
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  actor_id     uuid
);
CREATE TRIGGER asset_events_append_only BEFORE UPDATE OR DELETE ON asset_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Scheduled jobs                                                      */
/* ------------------------------------------------------------------ */

CREATE TABLE job_runs (
  job            text NOT NULL,
  business_date  date NOT NULL,
  status         text NOT NULL CHECK (status IN ('RUNNING', 'DONE', 'FAILED')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  details        jsonb,
  PRIMARY KEY (job, business_date)
);

INSERT INTO numbering_formats (seq_type, format) VALUES ('ASSET', 'AST-{FY}-{SEQ:6}')
  ON CONFLICT (seq_type) DO NOTHING;
