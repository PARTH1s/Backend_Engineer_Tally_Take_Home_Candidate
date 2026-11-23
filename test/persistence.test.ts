import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixture, useTestDatabase } from './helpers/harness';

const { pool, upload } = useTestDatabase();

/**
 * These tests query the tables directly, the way an operator or a reconciliation script
 * would, to prove the relationships are inspectable without going through the API.
 */
describe('relational model', () => {
  it('links import -> voucher -> ledger -> bill/bank allocations with source order', async () => {
    const res = await upload(fixture('01_receipt_with_allocations.xml'));
    const { rows } = await pool.query(
      `SELECT v.voucher_number, le.ordinal AS le_ord, le.ledger_name, le.amount AS le_amount,
              b.amount AS bill_amount, bk.name AS bank_ref, bk.amount AS bank_amount
         FROM voucher v
         JOIN ledger_entry le ON le.voucher_id = v.id
         LEFT JOIN bill_allocation b ON b.ledger_entry_id = le.id
         LEFT JOIN bank_allocation bk ON bk.ledger_entry_id = le.id
        WHERE v.import_id = $1
        ORDER BY le.ordinal`,
      [res.body.importId],
    );
    expect(rows).toEqual([
      { voucher_number: 'RCP-DEMO-001', le_ord: 0, ledger_name: 'Demo Bank', le_amount: '1250.00', bill_amount: null, bank_ref: 'UTR-DEMO-001', bank_amount: '1250.00' },
      { voucher_number: 'RCP-DEMO-001', le_ord: 1, ledger_name: 'Demo Customer', le_amount: '-1250.00', bill_amount: '-1250.00', bank_ref: null, bank_amount: null },
    ]);
  });

  it('links inventory -> batch/accounting allocations and rate details to their exact owner', async () => {
    const res = await upload(fixture('02_sales_invoice_nested.xml'));
    const owners = await pool.query(
      `SELECT CASE WHEN r.ledger_entry_id IS NOT NULL THEN 'ledger:' || le.ledger_name
                   WHEN r.accounting_allocation_id IS NOT NULL THEN 'accounting:' || aa.ledger_name
                   ELSE 'inventory' END AS owner,
              r.ordinal, r.duty_head, r.rate
         FROM rate_detail r
         LEFT JOIN ledger_entry le ON le.id = r.ledger_entry_id
         LEFT JOIN accounting_allocation aa ON aa.id = r.accounting_allocation_id
        ORDER BY owner, r.ordinal`,
    );
    expect(owners.rows).toEqual([
      { owner: 'accounting:Demo Sales', ordinal: 0, duty_head: 'CGST', rate: '9' },
      { owner: 'accounting:Demo Sales', ordinal: 1, duty_head: 'SGST/UTGST', rate: '9' },
      { owner: 'ledger:Output CGST', ordinal: 0, duty_head: 'CGST', rate: '9' },
      { owner: 'ledger:Output SGST', ordinal: 0, duty_head: 'SGST/UTGST', rate: '9' },
    ]);

    const inv = await pool.query(
      `SELECT ie.amount AS inv, ba.amount AS batch, aa.amount AS acct
         FROM inventory_entry ie
         JOIN voucher v ON v.id = ie.voucher_id
         JOIN batch_allocation ba ON ba.inventory_entry_id = ie.id
         JOIN accounting_allocation aa ON aa.inventory_entry_id = ie.id
        WHERE v.import_id = $1`,
      [res.body.importId],
    );
    expect(inv.rows).toEqual([{ inv: '100.00', batch: '100.00', acct: '100.00' }]);
  });

  it('stores money as text, never as floating point', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('amount', 'rate', 'actual_qty', 'billed_qty')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data_type).toBe('text');
  });

  it('enforces exactly one owner per rate detail', async () => {
    await expect(
      pool.query(`INSERT INTO rate_detail (id, ordinal, duty_head, rate) VALUES (gen_random_uuid(), 0, 'X', '1')`),
    ).rejects.toThrow(/rate_detail_exactly_one_owner/);
  });

  it('retains the exact uploaded bytes and their SHA-256', async () => {
    const bytes = fixture('04_utf16_invalid_control_ref.xml');
    const res = await upload(bytes);
    const { rows } = await pool.query(
      `SELECT i.content_hash, r.content FROM tally_import i JOIN tally_import_raw r ON r.import_id = i.id WHERE i.id = $1`,
      [res.body.importId],
    );
    expect(Buffer.compare(rows[0].content, bytes)).toBe(0);
    expect(rows[0].content_hash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('persists warnings and the Tally response result as queryable rows', async () => {
    await upload(fixture('02_sales_invoice_nested.xml'));
    await upload(fixture('03_tally_error_response.xml'));
    const issues = await pool.query(`SELECT code, voucher_index, path FROM import_issue`);
    expect(issues.rows).toEqual([{ code: 'UNKNOWN_ELEMENT', voucher_index: 0, path: 'VOUCHER[0]/PERSISTEDVIEW' }]);
    const responses = await pool.query(`SELECT business_status, errors, line_error FROM tally_response_result`);
    expect(responses.rows).toEqual([{ business_status: 'failed', errors: '1', line_error: 'Demo ledger does not exist' }]);
  });
});
