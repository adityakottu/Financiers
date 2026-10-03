-- Phase 6: daily reconciliation — employee cash settlement, differences (E11), bank/UPI
-- statement import and matching (E7), branch day close. See docs/09.

/* ------------------------------------------------------------------ */
/* Business days                                                       */
/* ------------------------------------------------------------------ */

CREATE TABLE business_days (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  branch_id              uuid NOT NULL REFERENCES branches(id),
  business_date          date NOT NULL,
  status                 text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_by              uuid REFERENCES users(id),
  closed_at              timestamptz,
  summary                jsonb,
  reopen_requested_by    uuid REFERENCES users(id),
  reopen_requested_at    timestamptz,
  reopen_reason          text,
  reopened_by            uuid REFERENCES users(id),
  reopened_at            timestamptz,
  UNIQUE (branch_id, business_date),
  -- Reopening is two people: whoever asks cannot approve.
  CHECK (reopened_by IS NULL OR reopened_by <> reopen_requested_by)
);

-- Money movements cannot be posted into a closed branch day. System accruals and penalties
-- (non-cash) still run; corrections after close are dated today.
CREATE OR REPLACE FUNCTION journal_day_check() RETURNS trigger AS $$
BEGIN
  IF NEW.branch_id IS NOT NULL AND NEW.entry_type IN ('PAYMENT', 'DEPOSIT', 'EXPENSE', 'DISBURSEMENT', 'MANUAL', 'TRANSFER', 'FEE')
     AND EXISTS (SELECT 1 FROM business_days d WHERE d.branch_id = NEW.branch_id AND d.business_date = NEW.value_date AND d.status = 'CLOSED') THEN
    RAISE EXCEPTION 'The business day % is closed for this branch', NEW.value_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_day_check BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_day_check();

/* ------------------------------------------------------------------ */
/* Employee cash settlement (one per employee per day)                 */
/* ------------------------------------------------------------------ */

CREATE TABLE employee_settlements (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  branch_id           uuid NOT NULL REFERENCES branches(id),
  business_date       date NOT NULL,
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'MATCHED', 'SHORT', 'EXCESS', 'APPROVED')),
  declared_cash       numeric(18, 2),
  declared_by         uuid REFERENCES users(id),
  declared_at         timestamptz,
  declaration_note    text,
  -- Snapshot taken when cash is counted; the day can't close if the ledger moves afterwards.
  expected_cash       numeric(18, 2),
  snapshot            jsonb,
  counted_cash        numeric(18, 2),
  counted_by          uuid REFERENCES users(id),
  counted_at          timestamptz,
  difference          numeric(18, 2),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  employee_user_id    uuid REFERENCES users(id),
  version             int NOT NULL DEFAULT 1,
  UNIQUE (employee_id, business_date),
  -- The employee can declare but never count or approve their own cash.
  CHECK (counted_by IS NULL OR employee_user_id IS NULL OR counted_by <> employee_user_id),
  CHECK (approved_by IS NULL OR employee_user_id IS NULL OR approved_by <> employee_user_id)
);
CREATE INDEX employee_settlements_branch_date_idx ON employee_settlements (branch_id, business_date);

CREATE TABLE settlement_differences (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  settlement_id     uuid NOT NULL REFERENCES employee_settlements(id),
  amount            numeric(18, 2) NOT NULL CHECK (amount > 0),
  direction         text NOT NULL CHECK (direction IN ('SHORT', 'EXCESS')),
  reason_code       text NOT NULL CHECK (reason_code IN ('PENDING_DEPOSIT', 'EXPENSE', 'CUSTOMER_REFUND', 'CORRECTION', 'COUNTING_ERROR', 'OTHER')),
  resolution        text NOT NULL CHECK (resolution IN ('CARRY_FORWARD', 'RECOVER_FROM_EMPLOYEE', 'WRITE_OFF', 'CASH_EXCESS_INCOME', 'TO_SUSPENSE')),
  notes             text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  recorded_by       uuid NOT NULL REFERENCES users(id),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  journal_entry_id  uuid REFERENCES journal_entries(id),
  CHECK (decided_by IS NULL OR decided_by <> recorded_by),
  CHECK ((direction = 'SHORT') = (resolution IN ('CARRY_FORWARD', 'RECOVER_FROM_EMPLOYEE', 'WRITE_OFF'))),
  CHECK ((resolution = 'CARRY_FORWARD') = (reason_code = 'PENDING_DEPOSIT'))
);
CREATE INDEX settlement_differences_settlement_idx ON settlement_differences (settlement_id);
CREATE TRIGGER settlement_differences_no_delete BEFORE DELETE OR TRUNCATE ON settlement_differences FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Bank / UPI statements and matching                                  */
/* ------------------------------------------------------------------ */

CREATE TABLE bank_statement_imports (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  file_name       text NOT NULL,
  file_sha256     text NOT NULL,
  mapping         jsonb NOT NULL,
  period_from     date,
  period_to       date,
  rows_total      int NOT NULL,
  rows_new        int NOT NULL,
  rows_duplicate  int NOT NULL,
  rows_invalid    int NOT NULL,
  invalid_rows    jsonb NOT NULL DEFAULT '[]',
  imported_by     uuid NOT NULL REFERENCES users(id),
  imported_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bank_statement_imports_append_only BEFORE UPDATE OR DELETE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE bank_statement_lines (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  -- Order of lines as they appear in the statement (several share one date).
  seq             bigserial NOT NULL,
  import_id       uuid NOT NULL REFERENCES bank_statement_imports(id),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  txn_date        date NOT NULL,
  description     text NOT NULL,
  reference       text,
  utr             text,
  debit           numeric(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit          numeric(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance         numeric(18, 2),
  row_hash        text NOT NULL UNIQUE,
  match_status    text NOT NULL DEFAULT 'UNMATCHED' CHECK (match_status IN ('UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED')),
  ignore_reason   text,
  handled_by      uuid REFERENCES users(id),
  handled_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX bank_statement_lines_account_idx ON bank_statement_lines (account_id, txn_date);
CREATE INDEX bank_statement_lines_status_idx ON bank_statement_lines (match_status) WHERE match_status IN ('UNMATCHED', 'SUGGESTED');
CREATE INDEX bank_statement_lines_utr_idx ON bank_statement_lines (utr) WHERE utr IS NOT NULL;

CREATE TABLE reconciliation_matches (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  statement_line_id      uuid NOT NULL REFERENCES bank_statement_lines(id),
  target_type            text NOT NULL CHECK (target_type IN ('PAYMENT', 'DEPOSIT', 'DISBURSEMENT', 'EXPENSE', 'SUSPENSE')),
  target_id              text NOT NULL,
  amount                 numeric(18, 2) NOT NULL CHECK (amount > 0),
  confidence             numeric(3, 2) NOT NULL,
  method                 text NOT NULL CHECK (method IN ('AUTO_REFERENCE', 'AUTO_AMOUNT_DATE', 'MANUAL')),
  status                 text NOT NULL DEFAULT 'SUGGESTED' CHECK (status IN ('SUGGESTED', 'CONFIRMED', 'REJECTED', 'UNDONE')),
  suggested_at           timestamptz NOT NULL DEFAULT now(),
  confirmed_by           uuid REFERENCES users(id),
  confirmed_at           timestamptz,
  undone_by              uuid REFERENCES users(id),
  undone_at              timestamptz,
  undo_reason            text,
  journal_entry_id       uuid REFERENCES journal_entries(id),
  undo_journal_entry_id  uuid REFERENCES journal_entries(id)
);
-- One confirmed match per statement line and per target (no double counting).
CREATE UNIQUE INDEX reconciliation_matches_line_live_idx ON reconciliation_matches (statement_line_id) WHERE status = 'CONFIRMED';
CREATE UNIQUE INDEX reconciliation_matches_target_live_idx ON reconciliation_matches (target_type, target_id) WHERE status = 'CONFIRMED';
CREATE INDEX reconciliation_matches_line_idx ON reconciliation_matches (statement_line_id);

ALTER TABLE payments ADD COLUMN reconciled_at timestamptz;
ALTER TABLE cash_deposits ADD COLUMN reconciled_at timestamptz;
