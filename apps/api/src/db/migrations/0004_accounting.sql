-- Phase 5: accountant features — expenses (E9), cash deposits (E6), cheque lifecycle (E8),
-- manual journals with approval, and accounting periods. See docs/07 and docs/03 §6.

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

CREATE TABLE expense_categories (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  name           text NOT NULL UNIQUE,
  account_id     uuid NOT NULL REFERENCES accounts(id),
  requires_bill  boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO expense_categories (name, account_id, requires_bill)
  SELECT v.name, a.id, v.bill FROM (VALUES
    ('Fuel', '5300', false),
    ('Travel', '5310', false),
    ('Office expenses', '5400', true),
    ('Rent', '5200', true),
    ('Salaries', '5100', true),
    ('Bank charges', '5500', false),
    ('Other', '5900', true)
  ) AS v(name, code, bill) JOIN accounts a ON a.code = v.code;

CREATE TABLE expenses (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  expense_no                 text NOT NULL UNIQUE,
  branch_id                  uuid NOT NULL REFERENCES branches(id),
  employee_id                uuid REFERENCES employees(id),
  category_id                uuid NOT NULL REFERENCES expense_categories(id),
  amount                     numeric(18, 2) NOT NULL CHECK (amount > 0),
  expense_date               date NOT NULL,
  paid_from                  text NOT NULL CHECK (paid_from IN ('EMPLOYEE_CASH', 'BRANCH_CASH', 'BANK')),
  paid_from_account_id       uuid NOT NULL REFERENCES accounts(id),
  vendor                     text,
  bill_no                    text,
  description                text NOT NULL,
  file_id                    uuid REFERENCES files(id),
  status                     text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED')),
  submitted_by               uuid NOT NULL REFERENCES users(id),
  submitted_at               timestamptz NOT NULL DEFAULT now(),
  approved_by                uuid REFERENCES users(id),
  approved_at                timestamptz,
  posted_by                  uuid REFERENCES users(id),
  posted_at                  timestamptz,
  rejected_by                uuid REFERENCES users(id),
  rejected_at                timestamptz,
  reject_reason              text,
  reversed_by                uuid REFERENCES users(id),
  reversed_at                timestamptz,
  reverse_reason             text,
  journal_entry_id           uuid REFERENCES journal_entries(id),
  reversal_journal_entry_id  uuid REFERENCES journal_entries(id),
  -- Whoever spent the money cannot approve or post it.
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),
  CHECK (posted_by IS NULL OR posted_by <> submitted_by)
);
CREATE INDEX expenses_branch_status_idx ON expenses (branch_id, status, expense_date DESC);
CREATE INDEX expenses_employee_idx ON expenses (employee_id, expense_date DESC);

CREATE OR REPLACE FUNCTION expenses_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expenses are permanent; reject or reverse instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('POSTED', 'REVERSED') AND (
       NEW.amount IS DISTINCT FROM OLD.amount OR NEW.category_id IS DISTINCT FROM OLD.category_id
       OR NEW.paid_from_account_id IS DISTINCT FROM OLD.paid_from_account_id OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'expense % is posted and cannot be changed', OLD.expense_no USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER expenses_guard BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_guard();

/* ------------------------------------------------------------------ */
/* Cash deposits (employee cash / branch cash → bank or branch safe)   */
/* ------------------------------------------------------------------ */

CREATE TABLE cash_deposits (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  deposit_no                 text NOT NULL UNIQUE,
  branch_id                  uuid NOT NULL REFERENCES branches(id),
  employee_id                uuid REFERENCES employees(id),
  from_account_id            uuid NOT NULL REFERENCES accounts(id),
  to_account_id              uuid NOT NULL REFERENCES accounts(id),
  amount                     numeric(18, 2) NOT NULL CHECK (amount > 0),
  deposited_on               date NOT NULL,
  slip_no                    text,
  notes                      text,
  file_id                    uuid REFERENCES files(id),
  status                     text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'REVERSED')),
  recorded_by                uuid NOT NULL REFERENCES users(id),
  recorded_at                timestamptz NOT NULL DEFAULT now(),
  reversed_by                uuid REFERENCES users(id),
  reversed_at                timestamptz,
  reverse_reason             text,
  journal_entry_id           uuid REFERENCES journal_entries(id),
  reversal_journal_entry_id  uuid REFERENCES journal_entries(id),
  reconciliation_status      text NOT NULL DEFAULT 'UNRECONCILED' CHECK (reconciliation_status IN ('UNRECONCILED', 'MATCHED')),
  CHECK (from_account_id <> to_account_id),
  CHECK (reversed_by IS NULL OR reversed_by <> recorded_by)
);
CREATE INDEX cash_deposits_branch_idx ON cash_deposits (branch_id, deposited_on DESC);
CREATE INDEX cash_deposits_employee_idx ON cash_deposits (employee_id, deposited_on DESC);
CREATE TRIGGER cash_deposits_no_delete BEFORE DELETE OR TRUNCATE ON cash_deposits FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Cheque lifecycle on payments                                        */
/* ------------------------------------------------------------------ */

ALTER TABLE payments
  ADD COLUMN cheque_deposit_account_id  uuid REFERENCES accounts(id),
  ADD COLUMN cheque_deposited_on        date,
  ADD COLUMN cheque_deposit_journal_id  uuid REFERENCES journal_entries(id),
  ADD COLUMN cheque_cleared_on          date,
  ADD COLUMN cheque_bounced_on          date;

/* ------------------------------------------------------------------ */
/* Manual journals (two people)                                        */
/* ------------------------------------------------------------------ */

CREATE TABLE manual_journals (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  value_date        date NOT NULL,
  branch_id         uuid REFERENCES branches(id),
  narration         text NOT NULL,
  lines             jsonb NOT NULL,
  total             numeric(18, 2) NOT NULL CHECK (total > 0),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  journal_entry_id  uuid REFERENCES journal_entries(id),
  CHECK (decided_by IS NULL OR decided_by <> created_by)
);
CREATE INDEX manual_journals_status_idx ON manual_journals (status, created_at);
CREATE TRIGGER manual_journals_no_delete BEFORE DELETE OR TRUNCATE ON manual_journals FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Accounting periods: who locked and why                              */
/* ------------------------------------------------------------------ */

ALTER TABLE accounting_periods
  ADD COLUMN soft_locked_by  uuid,
  ADD COLUMN soft_locked_at  timestamptz,
  ADD COLUMN unlocked_by     uuid,
  ADD COLUMN unlocked_at     timestamptz,
  ADD COLUMN unlock_reason   text;

CREATE INDEX journal_lines_branch_idx ON journal_lines (branch_id, account_id);

INSERT INTO numbering_formats (seq_type, format) VALUES ('DEPOSIT', 'DEP-{FY}-{SEQ:6}') ON CONFLICT (seq_type) DO NOTHING;
