-- Phase 4: collections, payments, allocations, receipts, reversals, messaging.
-- See docs/03-database-schema.md §4, §5, §8, docs/07 (E4, E5, E10) and docs/08 (allocation).

/* ------------------------------------------------------------------ */
/* Accounts used by collections                                        */
/* ------------------------------------------------------------------ */

-- A bank account that receives UPI settlements is still a bank account; "UPI clearing" is the internal
-- holding account below.
UPDATE accounts SET subtype = 'BANK' WHERE subtype = 'UPI_CLEARING' AND id IN (SELECT account_id FROM bank_accounts);

-- UPI receipts land in a per-branch clearing account until matched to the bank statement (Phase 6).
INSERT INTO accounts (code, name, type, normal_balance, parent_id, subtype, branch_id, is_system)
  SELECT '1250-' || b.code, 'UPI Clearing — ' || b.name, 'ASSET', 'DEBIT', p.id, 'UPI_CLEARING', b.id, true
  FROM branches b CROSS JOIN (SELECT id FROM accounts WHERE code = '1200') p
  ON CONFLICT (code) DO NOTHING;

/* ------------------------------------------------------------------ */
/* Loans: advance balance and collector history                        */
/* ------------------------------------------------------------------ */

ALTER TABLE loans
  ADD COLUMN advance_balance  numeric(18, 2) NOT NULL DEFAULT 0 CHECK (advance_balance >= 0),
  ADD COLUMN total_collected  numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN last_payment_at  timestamptz;

CREATE TABLE collection_assignments (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id      uuid NOT NULL REFERENCES loans(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  from_at      timestamptz NOT NULL DEFAULT now(),
  to_at        timestamptz,
  assigned_by  uuid NOT NULL REFERENCES users(id),
  reason       text
);
-- At most one current assignment per loan.
CREATE UNIQUE INDEX collection_assignments_current_idx ON collection_assignments (loan_id) WHERE to_at IS NULL;
CREATE INDEX collection_assignments_employee_idx ON collection_assignments (employee_id, from_at DESC);

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

CREATE TABLE payments (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  payment_no             text NOT NULL UNIQUE,
  loan_id                uuid NOT NULL REFERENCES loans(id),
  customer_id            uuid NOT NULL REFERENCES customers(id),
  branch_id              uuid NOT NULL REFERENCES branches(id),
  collected_by           uuid REFERENCES employees(id),
  recorded_by            uuid NOT NULL REFERENCES users(id),
  amount                 numeric(18, 2) NOT NULL CHECK (amount > 0),
  method                 text NOT NULL CHECK (method IN ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE')),
  reference_no           text,
  cheque_bank            text,
  cheque_date            date,
  cheque_status          text CHECK (cheque_status IN ('RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED')),
  received_at            timestamptz NOT NULL DEFAULT now(),
  business_date          date NOT NULL,
  value_date             date NOT NULL,
  location_text          text,
  lat                    numeric(9, 6),
  lng                    numeric(9, 6),
  notes                  text,
  debit_account_id       uuid NOT NULL REFERENCES accounts(id),
  advance_amount         numeric(18, 2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  status                 text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSAL_PENDING', 'REVERSED')),
  reconciliation_status  text NOT NULL DEFAULT 'UNRECONCILED' CHECK (reconciliation_status IN ('UNRECONCILED', 'MATCHED', 'VERIFIED', 'DIFFERENCE')),
  journal_entry_id       uuid REFERENCES journal_entries(id),
  settlement_id          uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (method = 'CASH' OR reference_no IS NOT NULL),
  CHECK ((method = 'CHEQUE') = (cheque_status IS NOT NULL)),
  CHECK (advance_amount <= amount)
);
-- A UTR / UPI transaction id can be used once (unless the earlier payment was reversed).
CREATE UNIQUE INDEX payments_reference_live_idx ON payments (method, upper(reference_no))
  WHERE method IN ('UPI', 'BANK_TRANSFER') AND status <> 'REVERSED';
CREATE INDEX payments_collector_date_idx ON payments (collected_by, business_date);
CREATE INDEX payments_loan_idx ON payments (loan_id, received_at DESC);
CREATE INDEX payments_branch_date_idx ON payments (branch_id, business_date, method);
CREATE INDEX payments_status_idx ON payments (status) WHERE status <> 'POSTED';

-- Payments are never deleted, and what was received is never edited: only workflow columns change.
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are permanent; use a reversal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.payment_no IS DISTINCT FROM OLD.payment_no OR NEW.loan_id IS DISTINCT FROM OLD.loan_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method IS DISTINCT FROM OLD.method OR NEW.reference_no IS DISTINCT FROM OLD.reference_no
     OR NEW.debit_account_id IS DISTINCT FROM OLD.debit_account_id OR NEW.value_date IS DISTINCT FROM OLD.value_date
     OR NEW.business_date IS DISTINCT FROM OLD.business_date OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.collected_by IS DISTINCT FROM OLD.collected_by OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.advance_amount IS DISTINCT FROM OLD.advance_amount
     OR (OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'payment % cannot be edited; reverse it and record it again', OLD.payment_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'REVERSED' AND NEW.status <> 'REVERSED' THEN
    RAISE EXCEPTION 'a reversed payment stays reversed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Exactly one PAYMENT journal per payment.
CREATE UNIQUE INDEX journal_entries_one_payment_idx ON journal_entries (source_id)
  WHERE source_type = 'payment' AND entry_type = 'PAYMENT';

/* Advance applied to an installment on its due date (doc 08 §4d). */
CREATE TABLE advance_applications (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id                    uuid NOT NULL REFERENCES loans(id),
  applied_on                 date NOT NULL,
  amount                     numeric(18, 2) NOT NULL CHECK (amount > 0),
  journal_entry_id           uuid REFERENCES journal_entries(id),
  status                     text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'REVERSED')),
  reversed_at                timestamptz,
  reversal_journal_entry_id  uuid REFERENCES journal_entries(id),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advance_applications_loan_idx ON advance_applications (loan_id, created_at);

CREATE TABLE payment_allocations (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  payment_id              uuid REFERENCES payments(id),
  advance_application_id  uuid REFERENCES advance_applications(id),
  loan_id                 uuid NOT NULL REFERENCES loans(id),
  installment_id          uuid REFERENCES loan_installments(id),
  installment_no          int,
  component               text NOT NULL CHECK (component IN ('PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL', 'ADVANCE')),
  amount                  numeric(18, 2) NOT NULL CHECK (amount > 0),
  seq                     smallint NOT NULL,
  rule_snapshot           jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((payment_id IS NULL) <> (advance_application_id IS NULL)),
  CHECK ((component = 'ADVANCE') = (installment_id IS NULL)),
  CHECK (component <> 'ADVANCE' OR payment_id IS NOT NULL)
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX payment_allocations_application_idx ON payment_allocations (advance_application_id) WHERE advance_application_id IS NOT NULL;
CREATE INDEX payment_allocations_installment_idx ON payment_allocations (installment_id);
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER payment_allocations_no_truncate BEFORE TRUNCATE ON payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Allocations add up to the payment (or advance application) exactly — checked at COMMIT.
CREATE OR REPLACE FUNCTION allocation_total_check() RETURNS trigger AS $$
DECLARE
  expected numeric;
  got numeric;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    SELECT NEW.amount, coalesce(sum(amount), 0) INTO expected, got FROM payment_allocations WHERE payment_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'advance_applications' THEN
    SELECT NEW.amount, coalesce(sum(amount), 0) INTO expected, got FROM payment_allocations WHERE advance_application_id = NEW.id;
  ELSIF NEW.payment_id IS NOT NULL THEN
    SELECT p.amount, (SELECT coalesce(sum(amount), 0) FROM payment_allocations WHERE payment_id = p.id) INTO expected, got
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
CREATE CONSTRAINT TRIGGER payments_allocated AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION allocation_total_check();
CREATE CONSTRAINT TRIGGER advance_applications_allocated AFTER INSERT ON advance_applications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION allocation_total_check();
CREATE CONSTRAINT TRIGGER payment_allocations_total AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION allocation_total_check();

/* ------------------------------------------------------------------ */
/* Reversals and receipts                                              */
/* ------------------------------------------------------------------ */

CREATE TABLE payment_reversals (
  id                         uuid PRIMARY KEY DEFAULT uuid_v7(),
  payment_id                 uuid NOT NULL REFERENCES payments(id),
  reason_code                text NOT NULL CHECK (reason_code IN ('WRONG_AMOUNT', 'WRONG_LOAN', 'DUPLICATE', 'CHEQUE_BOUNCED', 'CUSTOMER_REFUND', 'OTHER')),
  reason_text                text NOT NULL,
  requested_by               uuid NOT NULL REFERENCES users(id),
  requested_at               timestamptz NOT NULL DEFAULT now(),
  status                     text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  decided_by                 uuid REFERENCES users(id),
  decided_at                 timestamptz,
  decision_note              text,
  reversal_journal_entry_id  uuid REFERENCES journal_entries(id),
  -- Two people: whoever asks for a reversal cannot approve it (a bounced cheque is a bank fact, not a judgement).
  CHECK (status <> 'APPROVED' OR decided_by <> requested_by OR reason_code = 'CHEQUE_BOUNCED')
);
CREATE UNIQUE INDEX payment_reversals_open_idx ON payment_reversals (payment_id) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX payment_reversals_status_idx ON payment_reversals (status, requested_at);

CREATE TABLE receipts (
  id                       uuid PRIMARY KEY DEFAULT uuid_v7(),
  receipt_no               text NOT NULL UNIQUE,
  payment_id               uuid NOT NULL UNIQUE REFERENCES payments(id),
  issued_at                timestamptz NOT NULL DEFAULT now(),
  verify_token             text NOT NULL UNIQUE,
  status                   text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CANCELLED')),
  cancelled_at             timestamptz,
  cancelled_by_reversal_id uuid REFERENCES payment_reversals(id),
  snapshot                 jsonb NOT NULL
);
CREATE OR REPLACE FUNCTION receipts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipts are permanent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.receipt_no IS DISTINCT FROM OLD.receipt_no OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.verify_token IS DISTINCT FROM OLD.verify_token
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'receipt % cannot be changed (only cancelled once, by a reversal)', OLD.receipt_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER receipts_guard BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_guard();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ */
/* Field work                                                          */
/* ------------------------------------------------------------------ */

CREATE TABLE promises_to_pay (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id          uuid NOT NULL REFERENCES loans(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  employee_id      uuid REFERENCES employees(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  promised_amount  numeric(18, 2) NOT NULL CHECK (promised_amount > 0),
  promised_date    date NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'KEPT', 'PARTIAL', 'BROKEN', 'CANCELLED')),
  paid_amount      numeric(18, 2) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX promises_open_idx ON promises_to_pay (promised_date) WHERE status = 'OPEN';
CREATE INDEX promises_loan_idx ON promises_to_pay (loan_id, created_at DESC);

CREATE TABLE collection_visits (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id      uuid NOT NULL REFERENCES loans(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  employee_id  uuid REFERENCES employees(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  visited_at   timestamptz NOT NULL DEFAULT now(),
  outcome      text NOT NULL CHECK (outcome IN ('PAID', 'PARTIAL', 'PROMISED', 'NOT_AVAILABLE', 'REFUSED', 'SHIFTED', 'OTHER')),
  notes        text,
  lat          numeric(9, 6),
  lng          numeric(9, 6),
  payment_id   uuid REFERENCES payments(id),
  promise_id   uuid REFERENCES promises_to_pay(id)
);
CREATE INDEX collection_visits_loan_idx ON collection_visits (loan_id, visited_at DESC);
CREATE INDEX collection_visits_employee_idx ON collection_visits (employee_id, visited_at DESC);
CREATE TRIGGER collection_visits_append_only BEFORE UPDATE OR DELETE ON collection_visits
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE loan_closures (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  loan_id            uuid NOT NULL REFERENCES loans(id),
  closed_on          date NOT NULL,
  closing_payment_id uuid REFERENCES payments(id),
  total_paid         numeric(18, 2) NOT NULL,
  principal_paid     numeric(18, 2) NOT NULL,
  interest_paid      numeric(18, 2) NOT NULL,
  fees_paid          numeric(18, 2) NOT NULL,
  penalty_paid       numeric(18, 2) NOT NULL,
  advance_remaining  numeric(18, 2) NOT NULL DEFAULT 0,
  checklist          jsonb NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED', 'VOIDED')),
  voided_at          timestamptz,
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX loan_closures_live_idx ON loan_closures (loan_id) WHERE status = 'CLOSED';

/* ------------------------------------------------------------------ */
/* Messaging (official SMS / WhatsApp Business APIs only)              */
/* ------------------------------------------------------------------ */

CREATE TABLE message_templates (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  channel          text NOT NULL CHECK (channel IN ('SMS', 'WHATSAPP')),
  event_code       text NOT NULL CHECK (event_code IN ('PAYMENT_RECEIVED', 'DUE_REMINDER', 'OVERDUE', 'LOAN_DISBURSED', 'LOAN_CLOSED', 'PAYMENT_REVERSED')),
  language         text NOT NULL DEFAULT 'en',
  body             text NOT NULL,
  variables        text[] NOT NULL,
  dlt_template_id  text,
  wa_template_name text,
  wa_language      text NOT NULL DEFAULT 'en',
  is_active        boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  UNIQUE (event_code, channel, language)
);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  channel              text NOT NULL CHECK (channel IN ('SMS', 'WHATSAPP')),
  event_code           text NOT NULL,
  template_id          uuid REFERENCES message_templates(id),
  customer_id          uuid REFERENCES customers(id),
  loan_id              uuid REFERENCES loans(id),
  payment_id           uuid REFERENCES payments(id),
  installment_id       uuid REFERENCES loan_installments(id),
  to_number            varchar(10) NOT NULL,
  body                 text NOT NULL,
  params               jsonb NOT NULL DEFAULT '[]',
  provider             text,
  provider_message_id  text,
  -- SIMULATED = no provider configured (development/testing): the message was NOT sent.
  status               text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SIMULATED', 'SKIPPED')),
  skip_reason          text,
  error_text           text,
  attempts             int NOT NULL DEFAULT 0,
  available_at         timestamptz NOT NULL DEFAULT now(),
  triggered_by         text NOT NULL DEFAULT 'AUTO',
  created_by           uuid REFERENCES users(id),
  queued_at            timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  dedupe_key           text UNIQUE
);
CREATE INDEX messages_queue_idx ON messages (available_at) WHERE status = 'QUEUED';
CREATE INDEX messages_customer_idx ON messages (customer_id, queued_at DESC);
CREATE INDEX messages_loan_idx ON messages (loan_id, queued_at DESC);
CREATE INDEX messages_provider_idx ON messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_status_idx ON messages (status, queued_at DESC);

CREATE TABLE message_events (
  id          bigserial PRIMARY KEY,
  message_id  uuid REFERENCES messages(id),
  at          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,
  status      text,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX message_events_message_idx ON message_events (message_id, at);
CREATE TRIGGER message_events_append_only BEFORE UPDATE OR DELETE ON message_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE reminder_rules (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  offset_days  int NOT NULL CHECK (offset_days BETWEEN -30 AND 90),
  channel      text NOT NULL CHECK (channel IN ('SMS', 'WHATSAPP')),
  event_code   text NOT NULL CHECK (event_code IN ('DUE_REMINDER', 'OVERDUE')),
  min_amount   numeric(18, 2) NOT NULL DEFAULT 1,
  is_active    boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  UNIQUE (offset_days, channel),
  CHECK ((event_code = 'DUE_REMINDER') = (offset_days <= 0))
);

INSERT INTO message_templates (channel, event_code, body, variables, wa_template_name) VALUES
  ('SMS', 'PAYMENT_RECEIVED', 'Dear {{name}}, we received Rs.{{amount}} for loan {{loan_no}} on {{date}}. Receipt {{receipt_no}}. Balance Rs.{{balance}}. - {{company}}',
     ARRAY['name', 'amount', 'loan_no', 'date', 'receipt_no', 'balance', 'company'], NULL),
  ('SMS', 'DUE_REMINDER', 'Dear {{name}}, installment of Rs.{{amount}} for loan {{loan_no}} is due on {{due_date}}. Please pay on time. - {{company}}',
     ARRAY['name', 'amount', 'loan_no', 'due_date', 'company'], NULL),
  ('SMS', 'OVERDUE', 'Dear {{name}}, Rs.{{amount}} on loan {{loan_no}} is overdue since {{due_date}}. Please pay at the earliest. - {{company}}',
     ARRAY['name', 'amount', 'loan_no', 'due_date', 'company'], NULL),
  ('SMS', 'LOAN_DISBURSED', 'Dear {{name}}, your loan {{loan_no}} of Rs.{{amount}} is disbursed. First installment Rs.{{installment}} due on {{due_date}}. - {{company}}',
     ARRAY['name', 'loan_no', 'amount', 'installment', 'due_date', 'company'], NULL),
  ('SMS', 'LOAN_CLOSED', 'Dear {{name}}, your loan {{loan_no}} is fully repaid and closed. Thank you. - {{company}}',
     ARRAY['name', 'loan_no', 'company'], NULL),
  ('SMS', 'PAYMENT_REVERSED', 'Dear {{name}}, receipt {{receipt_no}} of Rs.{{amount}} for loan {{loan_no}} has been cancelled. Please contact the branch. - {{company}}',
     ARRAY['name', 'receipt_no', 'amount', 'loan_no', 'company'], NULL),
  ('WHATSAPP', 'PAYMENT_RECEIVED', 'Dear {{name}}, we received ₹{{amount}} for loan {{loan_no}} on {{date}}. Receipt {{receipt_no}}. Balance ₹{{balance}}. — {{company}}',
     ARRAY['name', 'amount', 'loan_no', 'date', 'receipt_no', 'balance', 'company'], 'payment_received'),
  ('WHATSAPP', 'DUE_REMINDER', 'Dear {{name}}, your installment of ₹{{amount}} for loan {{loan_no}} is due on {{due_date}}. — {{company}}',
     ARRAY['name', 'amount', 'loan_no', 'due_date', 'company'], 'due_reminder'),
  ('WHATSAPP', 'OVERDUE', 'Dear {{name}}, ₹{{amount}} on loan {{loan_no}} is overdue since {{due_date}}. Please pay at the earliest. — {{company}}',
     ARRAY['name', 'amount', 'loan_no', 'due_date', 'company'], 'overdue_notice'),
  ('WHATSAPP', 'LOAN_DISBURSED', 'Dear {{name}}, your loan {{loan_no}} of ₹{{amount}} is disbursed. First installment ₹{{installment}} due on {{due_date}}. — {{company}}',
     ARRAY['name', 'loan_no', 'amount', 'installment', 'due_date', 'company'], 'loan_disbursed'),
  ('WHATSAPP', 'LOAN_CLOSED', 'Dear {{name}}, your loan {{loan_no}} is fully repaid and closed. Thank you. — {{company}}',
     ARRAY['name', 'loan_no', 'company'], 'loan_closed'),
  ('WHATSAPP', 'PAYMENT_REVERSED', 'Dear {{name}}, receipt {{receipt_no}} of ₹{{amount}} for loan {{loan_no}} has been cancelled. Please contact the branch. — {{company}}',
     ARRAY['name', 'receipt_no', 'amount', 'loan_no', 'company'], 'payment_reversed');

INSERT INTO reminder_rules (offset_days, channel, event_code, is_active) VALUES
  (-3, 'SMS', 'DUE_REMINDER', false),
  (-1, 'SMS', 'DUE_REMINDER', true),
  (0, 'SMS', 'DUE_REMINDER', true),
  (1, 'SMS', 'OVERDUE', true),
  (7, 'SMS', 'OVERDUE', true),
  (15, 'SMS', 'OVERDUE', false),
  (30, 'SMS', 'OVERDUE', false),
  (-1, 'WHATSAPP', 'DUE_REMINDER', true),
  (1, 'WHATSAPP', 'OVERDUE', true);
