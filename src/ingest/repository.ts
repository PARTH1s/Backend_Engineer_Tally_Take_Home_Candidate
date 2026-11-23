import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import type {
  DocumentType,
  ImportIssue,
  ImportStatus,
  ImportSummary,
  InventoryEntry,
  LedgerEntry,
  ParsedVoucher,
  RateDetail,
  TallyResponseResult,
} from './types';

// ---------------------------------------------------------------------------------------
// Bulk insert
// ---------------------------------------------------------------------------------------

interface Column {
  name: string;
  /** Postgres type of the column, used to cast the array parameter. */
  type: 'uuid' | 'int' | 'text' | 'jsonb';
}

/**
 * Inserts many rows with ONE statement per table using `unnest` over typed arrays:
 *   INSERT INTO t (a, b) SELECT * FROM unnest($1::uuid[], $2::text[])
 * The statement size is constant regardless of row count (no parameter-limit issues),
 * and ids are generated in the application so children can reference parents without
 * relying on RETURNING row order. Table/column names are constants, never user input.
 */
async function bulkInsert(client: PoolClient, table: string, columns: Column[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const names = columns.map((c) => c.name).join(', ');
  const casts = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const params = columns.map((_, i) => rows.map((r) => r[i]));
  await client.query(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${casts})`, params);
}

const uuid = (name: string): Column => ({ name, type: 'uuid' });
const int = (name: string): Column => ({ name, type: 'int' });
const text = (name: string): Column => ({ name, type: 'text' });
const jsonb = (name: string): Column => ({ name, type: 'jsonb' });

/** Rows for every table of the voucher tree, built in one pass over the parsed vouchers. */
function voucherTreeRows(importId: string, vouchers: ParsedVoucher[]) {
  const rows = {
    voucher: [] as unknown[][],
    ledger: [] as unknown[][],
    bill: [] as unknown[][],
    bank: [] as unknown[][],
    inventory: [] as unknown[][],
    batch: [] as unknown[][],
    accounting: [] as unknown[][],
    rate: [] as unknown[][],
  };
  const rateRows = (details: RateDetail[], owner: 'ledger' | 'inventory' | 'accounting', ownerId: string) =>
    details.forEach((r, ordinal) =>
      rows.rate.push([
        randomUUID(),
        owner === 'ledger' ? ownerId : null,
        owner === 'inventory' ? ownerId : null,
        owner === 'accounting' ? ownerId : null,
        ordinal,
        r.dutyHead,
        r.rate,
      ]),
    );

  for (const v of vouchers) {
    const voucherId = randomUUID();
    rows.voucher.push([
      voucherId, importId, v.voucherIndex, v.attributes.VCHTYPE ?? null, v.attributes.ACTION ?? null,
      v.date, v.voucherType, v.voucherNumber, v.partyLedgerName, v.narration,
    ]);

    v.ledgerEntries.forEach((le: LedgerEntry, ordinal) => {
      const id = randomUUID();
      rows.ledger.push([id, voucherId, ordinal, le.sourceTag, le.ledgerName, le.isDeemedPositive, le.amount]);
      le.billAllocations.forEach((b, i) => rows.bill.push([randomUUID(), id, i, b.name, b.billType, b.amount]));
      le.bankAllocations.forEach((b, i) =>
        rows.bank.push([randomUUID(), id, i, b.date, b.name, b.transactionType, b.amount]),
      );
      rateRows(le.rateDetails, 'ledger', id);
    });

    v.inventoryEntries.forEach((ie: InventoryEntry, ordinal) => {
      const id = randomUUID();
      rows.inventory.push([
        id, voucherId, ordinal, ie.sourceTag, ie.stockItemName, ie.isDeemedPositive,
        ie.actualQty, ie.billedQty, ie.rate, ie.amount,
      ]);
      ie.batchAllocations.forEach((b, i) =>
        rows.batch.push([randomUUID(), id, i, b.godownName, b.batchName, b.actualQty, b.billedQty, b.amount]),
      );
      ie.accountingAllocations.forEach((a, i) => {
        const allocationId = randomUUID();
        rows.accounting.push([allocationId, id, i, a.ledgerName, a.isDeemedPositive, a.amount]);
        rateRows(a.rateDetails, 'accounting', allocationId);
      });
      rateRows(ie.rateDetails, 'inventory', id);
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

export interface NewImport {
  contentHash: string;
  bytes: Buffer;
  filename: string | null;
  parserVersion: string;
  documentType: DocumentType | null;
  status: ImportStatus;
  detectedEncoding: string | null;
  summary: ImportSummary;
  issues: ImportIssue[];
  tallyResponse: TallyResponseResult | null;
  vouchers: ParsedVoucher[];
}

export type PersistOutcome = { created: true; importId: string } | { created: false; importId: string };

/**
 * Persists an import and its whole tree atomically, or detects that the same bytes were
 * already imported.
 *
 * Idempotency is decided by `INSERT ... ON CONFLICT (content_hash) DO NOTHING` against the
 * UNIQUE constraint. Under concurrency the second transaction blocks on the unique index
 * until the first commits, then inserts nothing; it then reads the winner's id. If the
 * first transaction rolls back, the second one simply succeeds. There is no window in
 * which two imports for the same bytes can both commit.
 */
export async function persistImport(pool: Pool, input: NewImport): Promise<PersistOutcome> {
  const importId = randomUUID();

  const created = await withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO tally_import (
         id, content_hash, document_type, status, detected_encoding, byte_size, original_filename,
         parser_version, voucher_count, ledger_entry_count, inventory_entry_count, warning_count, error_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING id`,
      [
        importId, input.contentHash, input.documentType, input.status, input.detectedEncoding,
        input.bytes.length, input.filename, input.parserVersion, input.summary.vouchers,
        input.summary.ledgerEntries, input.summary.inventoryEntries, input.summary.warnings, input.summary.errors,
      ],
    );
    if (inserted.rowCount === 0) return false;

    await client.query('INSERT INTO tally_import_raw (import_id, content) VALUES ($1, $2)', [importId, input.bytes]);
    await client.query(
      `INSERT INTO tally_import_upload (id, import_id, filename, outcome) VALUES ($1, $2, $3, 'created')`,
      [randomUUID(), importId, input.filename],
    );

    await bulkInsert(
      client,
      'import_issue',
      [uuid('id'), uuid('import_id'), int('ordinal'), text('severity'), text('code'), text('message'),
        int('voucher_index'), text('path'), int('occurrences'), jsonb('details')],
      input.issues.map((i, ordinal) => [
        randomUUID(), importId, ordinal, i.severity, i.code, i.message, i.voucherIndex, i.path, i.occurrences,
        i.details === null ? null : JSON.stringify(i.details),
      ]),
    );

    if (input.tallyResponse) {
      const r = input.tallyResponse;
      await client.query(
        `INSERT INTO tally_response_result (
           import_id, business_status, source_element, created, altered, deleted, ignored, errors,
           line_error, line_errors)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [importId, r.businessStatus, r.sourceElement, r.counters.CREATED, r.counters.ALTERED, r.counters.DELETED,
          r.counters.IGNORED, r.counters.ERRORS, r.lineError, r.lineErrors],
      );
    }

    const rows = voucherTreeRows(importId, input.vouchers);
    await bulkInsert(client, 'voucher',
      [uuid('id'), uuid('import_id'), int('voucher_index'), text('vch_type_attr'), text('action_attr'),
        text('date'), text('voucher_type'), text('voucher_number'), text('party_ledger_name'), text('narration')],
      rows.voucher);
    await bulkInsert(client, 'ledger_entry',
      [uuid('id'), uuid('voucher_id'), int('ordinal'), text('source_tag'), text('ledger_name'),
        text('is_deemed_positive'), text('amount')],
      rows.ledger);
    await bulkInsert(client, 'bill_allocation',
      [uuid('id'), uuid('ledger_entry_id'), int('ordinal'), text('name'), text('bill_type'), text('amount')],
      rows.bill);
    await bulkInsert(client, 'bank_allocation',
      [uuid('id'), uuid('ledger_entry_id'), int('ordinal'), text('date'), text('name'), text('transaction_type'),
        text('amount')],
      rows.bank);
    await bulkInsert(client, 'inventory_entry',
      [uuid('id'), uuid('voucher_id'), int('ordinal'), text('source_tag'), text('stock_item_name'),
        text('is_deemed_positive'), text('actual_qty'), text('billed_qty'), text('rate'), text('amount')],
      rows.inventory);
    await bulkInsert(client, 'batch_allocation',
      [uuid('id'), uuid('inventory_entry_id'), int('ordinal'), text('godown_name'), text('batch_name'),
        text('actual_qty'), text('billed_qty'), text('amount')],
      rows.batch);
    await bulkInsert(client, 'accounting_allocation',
      [uuid('id'), uuid('inventory_entry_id'), int('ordinal'), text('ledger_name'), text('is_deemed_positive'),
        text('amount')],
      rows.accounting);
    await bulkInsert(client, 'rate_detail',
      [uuid('id'), uuid('ledger_entry_id'), uuid('inventory_entry_id'), uuid('accounting_allocation_id'),
        int('ordinal'), text('duty_head'), text('rate')],
      rows.rate);
    return true;
  });

  if (created) return { created: true, importId };

  // Lost the race (or a plain re-upload): the winner has committed, so it is visible now.
  const existing = await findImportByHash(pool, input.contentHash);
  if (!existing) throw new Error('Content hash conflict without a visible import row');
  await recordDuplicateUpload(pool, existing.id, input.filename);
  return { created: false, importId: existing.id };
}

export async function recordDuplicateUpload(pool: Pool, importId: string, filename: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO tally_import_upload (id, import_id, filename, outcome) VALUES ($1, $2, $3, 'duplicate')`,
    [randomUUID(), importId, filename],
  );
}

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

export interface ImportRecord {
  id: string;
  contentHash: string;
  documentType: DocumentType | null;
  status: ImportStatus;
  detectedEncoding: string | null;
  byteSize: number;
  originalFilename: string | null;
  parserVersion: string;
  createdAt: Date;
  summary: ImportSummary;
}

interface ImportRow {
  id: string;
  content_hash: string;
  document_type: DocumentType | null;
  status: ImportStatus;
  detected_encoding: string | null;
  byte_size: string;
  original_filename: string | null;
  parser_version: string;
  created_at: Date;
  voucher_count: number;
  ledger_entry_count: number;
  inventory_entry_count: number;
  warning_count: number;
  error_count: number;
}

const IMPORT_COLUMNS = `id, content_hash, document_type, status, detected_encoding, byte_size, original_filename,
  parser_version, created_at, voucher_count, ledger_entry_count, inventory_entry_count, warning_count, error_count`;

function toImportRecord(r: ImportRow): ImportRecord {
  return {
    id: r.id,
    contentHash: r.content_hash,
    documentType: r.document_type,
    status: r.status,
    detectedEncoding: r.detected_encoding,
    byteSize: Number(r.byte_size),
    originalFilename: r.original_filename,
    parserVersion: r.parser_version,
    createdAt: r.created_at,
    summary: {
      vouchers: r.voucher_count,
      ledgerEntries: r.ledger_entry_count,
      inventoryEntries: r.inventory_entry_count,
      warnings: r.warning_count,
      errors: r.error_count,
    },
  };
}

export async function findImportByHash(pool: Pool, contentHash: string): Promise<ImportRecord | null> {
  const { rows } = await pool.query<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM tally_import WHERE content_hash = $1`, [contentHash]);
  return rows[0] ? toImportRecord(rows[0]) : null;
}

export async function findImportById(pool: Pool, id: string): Promise<ImportRecord | null> {
  const { rows } = await pool.query<ImportRow>(`SELECT ${IMPORT_COLUMNS} FROM tally_import WHERE id = $1`, [id]);
  return rows[0] ? toImportRecord(rows[0]) : null;
}

export async function loadIssues(pool: Pool, importId: string): Promise<ImportIssue[]> {
  const { rows } = await pool.query<{
    severity: ImportIssue['severity'];
    code: ImportIssue['code'];
    message: string;
    voucher_index: number | null;
    path: string | null;
    occurrences: number;
    details: Record<string, unknown> | null;
  }>(
    `SELECT severity, code, message, voucher_index, path, occurrences, details
       FROM import_issue WHERE import_id = $1 ORDER BY ordinal`,
    [importId],
  );
  return rows.map((r) => ({
    severity: r.severity,
    code: r.code,
    message: r.message,
    voucherIndex: r.voucher_index,
    path: r.path,
    occurrences: r.occurrences,
    details: r.details,
  }));
}

export async function loadTallyResponse(pool: Pool, importId: string): Promise<TallyResponseResult | null> {
  const { rows } = await pool.query<{
    business_status: TallyResponseResult['businessStatus'];
    source_element: TallyResponseResult['sourceElement'];
    created: string | null;
    altered: string | null;
    deleted: string | null;
    ignored: string | null;
    errors: string | null;
    line_error: string | null;
    line_errors: string[];
  }>('SELECT * FROM tally_response_result WHERE import_id = $1', [importId]);
  const r = rows[0];
  if (!r) return null;
  return {
    businessStatus: r.business_status,
    sourceElement: r.source_element,
    counters: { CREATED: r.created, ALTERED: r.altered, DELETED: r.deleted, IGNORED: r.ignored, ERRORS: r.errors },
    lineError: r.line_error,
    lineErrors: r.line_errors,
  };
}

/** Groups rows by a parent key, preserving the (already ordered) row order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/**
 * Rebuilds the voucher trees for one import: one query per table (8 total, independent of
 * voucher count), each ordered by parent then ordinal, then stitched together in memory.
 */
export async function loadVouchers(pool: Pool, importId: string): Promise<ParsedVoucher[]> {
  type Row = Record<string, string | number | null> & { id: string };
  const q = async (sql: string) => (await pool.query<Row>(sql, [importId])).rows;

  const [vouchers, ledgers, bills, banks, inventories, batches, accountings, rates] = await Promise.all([
    q(`SELECT * FROM voucher WHERE import_id = $1 ORDER BY voucher_index`),
    q(`SELECT le.* FROM ledger_entry le JOIN voucher v ON v.id = le.voucher_id
        WHERE v.import_id = $1 ORDER BY le.voucher_id, le.ordinal`),
    q(`SELECT b.* FROM bill_allocation b JOIN ledger_entry le ON le.id = b.ledger_entry_id
        JOIN voucher v ON v.id = le.voucher_id WHERE v.import_id = $1 ORDER BY b.ledger_entry_id, b.ordinal`),
    q(`SELECT b.* FROM bank_allocation b JOIN ledger_entry le ON le.id = b.ledger_entry_id
        JOIN voucher v ON v.id = le.voucher_id WHERE v.import_id = $1 ORDER BY b.ledger_entry_id, b.ordinal`),
    q(`SELECT ie.* FROM inventory_entry ie JOIN voucher v ON v.id = ie.voucher_id
        WHERE v.import_id = $1 ORDER BY ie.voucher_id, ie.ordinal`),
    q(`SELECT b.* FROM batch_allocation b JOIN inventory_entry ie ON ie.id = b.inventory_entry_id
        JOIN voucher v ON v.id = ie.voucher_id WHERE v.import_id = $1 ORDER BY b.inventory_entry_id, b.ordinal`),
    q(`SELECT a.* FROM accounting_allocation a JOIN inventory_entry ie ON ie.id = a.inventory_entry_id
        JOIN voucher v ON v.id = ie.voucher_id WHERE v.import_id = $1 ORDER BY a.inventory_entry_id, a.ordinal`),
    q(`SELECT r.* FROM rate_detail r
         LEFT JOIN ledger_entry le ON le.id = r.ledger_entry_id
         LEFT JOIN inventory_entry ie ON ie.id = r.inventory_entry_id
         LEFT JOIN accounting_allocation aa ON aa.id = r.accounting_allocation_id
         LEFT JOIN inventory_entry aie ON aie.id = aa.inventory_entry_id
         JOIN voucher v ON v.id = COALESCE(le.voucher_id, ie.voucher_id, aie.voucher_id)
        WHERE v.import_id = $1 ORDER BY r.ordinal`),
  ]);

  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const owner = (r: Row) => String(r.ledger_entry_id ?? r.inventory_entry_id ?? r.accounting_allocation_id);
  const ledgersBy = groupBy(ledgers, (r) => String(r.voucher_id));
  const billsBy = groupBy(bills, (r) => String(r.ledger_entry_id));
  const banksBy = groupBy(banks, (r) => String(r.ledger_entry_id));
  const inventoriesBy = groupBy(inventories, (r) => String(r.voucher_id));
  const batchesBy = groupBy(batches, (r) => String(r.inventory_entry_id));
  const accountingsBy = groupBy(accountings, (r) => String(r.inventory_entry_id));
  const ratesBy = groupBy(rates, owner); // ordered by ordinal within each owner
  const rateDetails = (ownerId: string): RateDetail[] =>
    (ratesBy.get(ownerId) ?? []).map((r) => ({ dutyHead: s(r.duty_head), rate: s(r.rate) }));

  return vouchers.map((v) => {
    const attributes: ParsedVoucher['attributes'] = {};
    if (v.vch_type_attr !== null) attributes.VCHTYPE = String(v.vch_type_attr);
    if (v.action_attr !== null) attributes.ACTION = String(v.action_attr);
    return {
      voucherIndex: Number(v.voucher_index),
      attributes,
      date: s(v.date),
      voucherType: s(v.voucher_type),
      voucherNumber: s(v.voucher_number),
      partyLedgerName: s(v.party_ledger_name),
      narration: s(v.narration),
      ledgerEntries: (ledgersBy.get(v.id) ?? []).map((le) => ({
        sourceTag: String(le.source_tag) as LedgerEntry['sourceTag'],
        ledgerName: s(le.ledger_name),
        isDeemedPositive: s(le.is_deemed_positive),
        amount: s(le.amount),
        billAllocations: (billsBy.get(le.id) ?? []).map((b) => ({
          name: s(b.name), billType: s(b.bill_type), amount: s(b.amount),
        })),
        bankAllocations: (banksBy.get(le.id) ?? []).map((b) => ({
          date: s(b.date), name: s(b.name), transactionType: s(b.transaction_type), amount: s(b.amount),
        })),
        rateDetails: rateDetails(le.id),
      })),
      inventoryEntries: (inventoriesBy.get(v.id) ?? []).map((ie) => ({
        sourceTag: 'ALLINVENTORYENTRIES.LIST' as const,
        stockItemName: s(ie.stock_item_name),
        isDeemedPositive: s(ie.is_deemed_positive),
        actualQty: s(ie.actual_qty),
        billedQty: s(ie.billed_qty),
        rate: s(ie.rate),
        amount: s(ie.amount),
        batchAllocations: (batchesBy.get(ie.id) ?? []).map((b) => ({
          godownName: s(b.godown_name), batchName: s(b.batch_name), actualQty: s(b.actual_qty),
          billedQty: s(b.billed_qty), amount: s(b.amount),
        })),
        accountingAllocations: (accountingsBy.get(ie.id) ?? []).map((a) => ({
          ledgerName: s(a.ledger_name), isDeemedPositive: s(a.is_deemed_positive), amount: s(a.amount),
          rateDetails: rateDetails(a.id),
        })),
        rateDetails: rateDetails(ie.id),
      })),
    };
  });
}
