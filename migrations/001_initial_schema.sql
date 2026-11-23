-- 001_initial_schema.sql
--
-- Design summary (see README "Persistence design" for the reasoning):
--   * Relational rows for every node of the voucher tree, each with a foreign key to its
--     direct parent and an `ordinal` that preserves source order among its siblings.
--   * All Tally values (money, quantity, rate, dates, Yes/No) are TEXT holding the exact
--     source string: lossless by construction, no floating point anywhere.
--   * The raw uploaded bytes are kept (bytea) in a separate table so detail/voucher reads
--     never load them.
--   * Idempotency = UNIQUE(content_hash). The database, not application code, guarantees
--     that one set of bytes produces exactly one import, even under concurrent uploads.

CREATE TABLE tally_import (
    id                     uuid PRIMARY KEY,
    content_hash           text NOT NULL,
    document_type          text,
    status                 text NOT NULL,
    detected_encoding      text,
    byte_size              bigint NOT NULL,
    original_filename      text,
    parser_version         text NOT NULL,
    voucher_count          integer NOT NULL DEFAULT 0,
    ledger_entry_count     integer NOT NULL DEFAULT 0,
    inventory_entry_count  integer NOT NULL DEFAULT 0,
    warning_count          integer NOT NULL DEFAULT 0,
    error_count            integer NOT NULL DEFAULT 0,
    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tally_import_content_hash_key UNIQUE (content_hash),
    CONSTRAINT tally_import_content_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT tally_import_document_type_check
        CHECK (document_type IS NULL OR document_type IN ('voucherExport', 'tallyResponse')),
    CONSTRAINT tally_import_status_check CHECK (status IN ('completed', 'partial', 'failed')),
    -- A failed import may not know its type; a successful one always does.
    CONSTRAINT tally_import_type_known CHECK (status = 'failed' OR document_type IS NOT NULL)
);

-- Exact uploaded bytes, for investigation and reprocessing. 1:1 with tally_import.
CREATE TABLE tally_import_raw (
    import_id  uuid PRIMARY KEY REFERENCES tally_import (id) ON DELETE CASCADE,
    content    bytea NOT NULL
);

-- Every upload attempt, including duplicates: who sent what filename, when, and whether
-- it created the import or matched an existing one. Filenames live here, not in identity.
CREATE TABLE tally_import_upload (
    id           uuid PRIMARY KEY,
    import_id    uuid NOT NULL REFERENCES tally_import (id) ON DELETE CASCADE,
    filename     text,
    outcome      text NOT NULL CHECK (outcome IN ('created', 'duplicate')),
    received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tally_import_upload_import_idx ON tally_import_upload (import_id);

-- Warnings and errors. voucher_index is NULL for document-level issues.
CREATE TABLE import_issue (
    id             uuid PRIMARY KEY,
    import_id      uuid NOT NULL REFERENCES tally_import (id) ON DELETE CASCADE,
    ordinal        integer NOT NULL,
    severity       text NOT NULL CHECK (severity IN ('warning', 'error')),
    code           text NOT NULL,
    message        text NOT NULL,
    voucher_index  integer,
    path           text,
    occurrences    integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
    details        jsonb,
    UNIQUE (import_id, ordinal)
);
CREATE INDEX import_issue_code_idx ON import_issue (code);

-- Result of a Tally operation (RESPONSE root or ENVELOPE/.../IMPORTRESULT). 1:1, optional.
CREATE TABLE tally_response_result (
    import_id        uuid PRIMARY KEY REFERENCES tally_import (id) ON DELETE CASCADE,
    business_status  text NOT NULL CHECK (business_status IN ('succeeded', 'failed')),
    source_element   text NOT NULL CHECK (source_element IN ('RESPONSE', 'IMPORTRESULT')),
    created          text,
    altered          text,
    deleted          text,
    ignored          text,
    errors           text,
    line_error       text,
    line_errors      text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE voucher (
    id                 uuid PRIMARY KEY,
    import_id          uuid NOT NULL REFERENCES tally_import (id) ON DELETE CASCADE,
    voucher_index      integer NOT NULL CHECK (voucher_index >= 0),
    vch_type_attr      text,
    action_attr        text,
    date               text,
    voucher_type       text,
    voucher_number     text,
    party_ledger_name  text,
    narration          text,
    UNIQUE (import_id, voucher_index)
);
-- Lookups like "which imports contain voucher RCP-001" for reconciliation.
CREATE INDEX voucher_number_idx ON voucher (voucher_type, voucher_number);

CREATE TABLE ledger_entry (
    id                  uuid PRIMARY KEY,
    voucher_id          uuid NOT NULL REFERENCES voucher (id) ON DELETE CASCADE,
    ordinal             integer NOT NULL CHECK (ordinal >= 0),
    source_tag          text NOT NULL CHECK (source_tag IN ('ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST')),
    ledger_name         text,
    is_deemed_positive  text,
    amount              text,
    UNIQUE (voucher_id, ordinal)
);

CREATE TABLE bill_allocation (
    id               uuid PRIMARY KEY,
    ledger_entry_id  uuid NOT NULL REFERENCES ledger_entry (id) ON DELETE CASCADE,
    ordinal          integer NOT NULL CHECK (ordinal >= 0),
    name             text,
    bill_type        text,
    amount           text,
    UNIQUE (ledger_entry_id, ordinal)
);

CREATE TABLE bank_allocation (
    id                uuid PRIMARY KEY,
    ledger_entry_id   uuid NOT NULL REFERENCES ledger_entry (id) ON DELETE CASCADE,
    ordinal           integer NOT NULL CHECK (ordinal >= 0),
    date              text,
    name              text,
    transaction_type  text,
    amount            text,
    UNIQUE (ledger_entry_id, ordinal)
);

CREATE TABLE inventory_entry (
    id                  uuid PRIMARY KEY,
    voucher_id          uuid NOT NULL REFERENCES voucher (id) ON DELETE CASCADE,
    ordinal             integer NOT NULL CHECK (ordinal >= 0),
    source_tag          text NOT NULL CHECK (source_tag IN ('ALLINVENTORYENTRIES.LIST')),
    stock_item_name     text,
    is_deemed_positive  text,
    actual_qty          text,
    billed_qty          text,
    rate                text,
    amount              text,
    UNIQUE (voucher_id, ordinal)
);

CREATE TABLE batch_allocation (
    id                  uuid PRIMARY KEY,
    inventory_entry_id  uuid NOT NULL REFERENCES inventory_entry (id) ON DELETE CASCADE,
    ordinal             integer NOT NULL CHECK (ordinal >= 0),
    godown_name         text,
    batch_name          text,
    actual_qty          text,
    billed_qty          text,
    amount              text,
    UNIQUE (inventory_entry_id, ordinal)
);

CREATE TABLE accounting_allocation (
    id                  uuid PRIMARY KEY,
    inventory_entry_id  uuid NOT NULL REFERENCES inventory_entry (id) ON DELETE CASCADE,
    ordinal             integer NOT NULL CHECK (ordinal >= 0),
    ledger_name         text,
    is_deemed_positive  text,
    amount              text,
    UNIQUE (inventory_entry_id, ordinal)
);

-- RATEDETAILS.LIST can hang off three different owners. Exactly one owner column is set
-- (enforced by CHECK), each is a real foreign key, and order is unique per owner.
CREATE TABLE rate_detail (
    id                        uuid PRIMARY KEY,
    ledger_entry_id           uuid REFERENCES ledger_entry (id) ON DELETE CASCADE,
    inventory_entry_id        uuid REFERENCES inventory_entry (id) ON DELETE CASCADE,
    accounting_allocation_id  uuid REFERENCES accounting_allocation (id) ON DELETE CASCADE,
    ordinal                   integer NOT NULL CHECK (ordinal >= 0),
    duty_head                 text,
    rate                      text,
    CONSTRAINT rate_detail_exactly_one_owner
        CHECK (num_nonnulls(ledger_entry_id, inventory_entry_id, accounting_allocation_id) = 1)
);
CREATE UNIQUE INDEX rate_detail_ledger_order
    ON rate_detail (ledger_entry_id, ordinal) WHERE ledger_entry_id IS NOT NULL;
CREATE UNIQUE INDEX rate_detail_inventory_order
    ON rate_detail (inventory_entry_id, ordinal) WHERE inventory_entry_id IS NOT NULL;
CREATE UNIQUE INDEX rate_detail_accounting_order
    ON rate_detail (accounting_allocation_id, ordinal) WHERE accounting_allocation_id IS NOT NULL;
