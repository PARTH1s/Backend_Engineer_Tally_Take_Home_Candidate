import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ingestUpload } from '../src/ingest/service';
import { fixture, useTestDatabase } from './helpers/harness';

const { pool, app, upload } = useTestDatabase();

async function count(table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

describe('content-based idempotency (required test 3)', () => {
  it('fixture 06 (same bytes as 01, different filename) returns the original import', async () => {
    const first = await upload(fixture('01_receipt_with_allocations.xml'), '01_receipt_with_allocations.xml');
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);

    const second = await upload(fixture('06_duplicate_receipt.xml'), '06_duplicate_receipt.xml');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, duplicate: true });

    // No duplicate vouchers or child rows were created.
    expect(await count('tally_import')).toBe(1);
    expect(await count('voucher')).toBe(1);
    expect(await count('ledger_entry')).toBe(2);
    expect(await count('bill_allocation')).toBe(1);
    expect(await count('bank_allocation')).toBe(1);

    // Both attempts are audited, with their own filenames; the import keeps the first.
    const uploads = await pool.query('SELECT filename, outcome FROM tally_import_upload ORDER BY received_at');
    expect(uploads.rows).toEqual([
      { filename: '01_receipt_with_allocations.xml', outcome: 'created' },
      { filename: '06_duplicate_receipt.xml', outcome: 'duplicate' },
    ]);
    const details = await request(app()).get(`/api/tally/imports/${first.body.importId}`);
    expect(details.body.originalFilename).toBe('01_receipt_with_allocations.xml');
  });

  it('identity is the exact bytes: semantically equal XML with different whitespace is a new import', async () => {
    const original = fixture('01_receipt_with_allocations.xml');
    const reformatted = Buffer.from(original.toString('utf8').replace(/\n\s*/g, '\n'));
    const a = await upload(original);
    const b = await upload(reformatted);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.importId).not.toBe(a.body.importId);
  });

  it('a re-uploaded failed document returns the same failed import', async () => {
    const a = await upload(Buffer.from('<ENVELOPE><BODY>'));
    const b = await upload(Buffer.from('<ENVELOPE><BODY>'), 'other-name.xml');
    expect([a.status, b.status]).toEqual([422, 422]);
    expect(b.body).toMatchObject({ importId: a.body.importId, status: 'failed', duplicate: true });
    expect(await count('tally_import')).toBe(1);
  });
});

describe('concurrency (extension 3)', () => {
  it('simultaneous HTTP uploads of identical bytes produce exactly one import', async () => {
    const bytes = fixture('02_sales_invoice_nested.xml');
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => upload(bytes, `copy-${i}.xml`)));

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.body.importId)).size).toBe(1);
    expect(responses.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(await count('tally_import')).toBe(1);
    expect(await count('voucher')).toBe(1);
    expect(await count('ledger_entry')).toBe(3);
    expect(await count('tally_import_upload')).toBe(8);
  });

  it('racing service calls that all miss the fast-path check still yield one winner', async () => {
    // Calling the service directly in parallel makes every caller pass the initial
    // SELECT before any INSERT commits, so only the UNIQUE constraint can arbitrate.
    const bytes = fixture('04_utf16_invalid_control_ref.xml');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ingestUpload(pool, { bytes, filename: null }, { maxXmlDepth: 64 })),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(await count('tally_import')).toBe(1);
    expect(await count('voucher')).toBe(1);
  });

  it('the database itself rejects a second row with the same content hash', async () => {
    const res = await upload(fixture('05_empty_collection.xml'));
    const { rows } = await pool.query('SELECT content_hash FROM tally_import WHERE id = $1', [res.body.importId]);
    await expect(
      pool.query(
        `INSERT INTO tally_import (id, content_hash, document_type, status, byte_size, parser_version)
         VALUES (gen_random_uuid(), $1, 'voucherExport', 'completed', 1, 'test')`,
        [rows[0].content_hash],
      ),
    ).rejects.toThrow(/tally_import_content_hash_key/);
  });
});
