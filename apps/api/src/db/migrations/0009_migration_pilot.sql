-- Phase 9: data migration from the old system (customers, running loans with opening balances E15)
-- and the pilot's parallel run (daily comparison with the old process). See docs/07 E15, docs/15.

-- The number a customer / loan had in the old system: searchable, unique, never reused.
ALTER TABLE customers ADD COLUMN legacy_no text;
CREATE UNIQUE INDEX customers_legacy_no_idx ON customers (legacy_no) WHERE legacy_no IS NOT NULL;
ALTER TABLE loans ADD COLUMN legacy_no text;
ALTER TABLE loans ADD COLUMN migrated_on date;   -- cut-over date for loans brought over from the old system
CREATE UNIQUE INDEX loans_legacy_no_idx ON loans (legacy_no) WHERE legacy_no IS NOT NULL;
CREATE INDEX loans_legacy_no_trgm_idx ON loans USING gin (legacy_no gin_trgm_ops) WHERE legacy_no IS NOT NULL;

/* ------------------------------------------------------------------ */
/* Import batches: upload → validate → second person confirms         */
/* ------------------------------------------------------------------ */

CREATE TABLE import_batches (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  batch_no        text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('CUSTOMERS', 'LOANS')),
  file_name       text NOT NULL,
  file_sha256     text NOT NULL,
  cutover_date    date,                     -- loans: the date their balances are true at
  status          text NOT NULL CHECK (status IN ('VALIDATED', 'REJECTED', 'CONFIRMED', 'CANCELLED')),
  rows_total      int NOT NULL,
  rows_valid      int NOT NULL,
  rows_invalid    int NOT NULL,
  errors          jsonb NOT NULL DEFAULT '[]',   -- [{ row, field, message }]
  rows            jsonb NOT NULL,                -- the validated, normalised rows (what will be created)
  totals          jsonb NOT NULL DEFAULT '{}',   -- e.g. principal outstanding to be brought over
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by    uuid REFERENCES users(id),
  confirmed_at    timestamptz,
  result          jsonb,                         -- created ids / numbers, journal entry
  -- Four eyes: whoever uploaded cannot confirm.
  CHECK (confirmed_by IS NULL OR confirmed_by <> uploaded_by)
);
-- The same file cannot be imported twice.
CREATE UNIQUE INDEX import_batches_file_idx ON import_batches (kind, file_sha256) WHERE status = 'CONFIRMED';

/* ------------------------------------------------------------------ */
/* Pilot parallel run: the old process's day sheet vs the system       */
/* ------------------------------------------------------------------ */

CREATE TABLE parallel_run_days (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  business_date    date NOT NULL,
  file_name        text NOT NULL,
  legacy_rows      jsonb NOT NULL,   -- [{ row, receiptNo, loanRef, amount, method, collector }]
  uploaded_by      uuid NOT NULL REFERENCES users(id),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  signed_off_by    uuid REFERENCES users(id),
  signed_off_at    timestamptz,
  sign_off_note    text,
  result           jsonb,            -- the comparison frozen at sign-off
  UNIQUE (branch_id, business_date)
);

INSERT INTO numbering_formats (seq_type, format) VALUES ('IMPORT', 'IMP-{FY}-{SEQ:4}') ON CONFLICT (seq_type) DO NOTHING;
