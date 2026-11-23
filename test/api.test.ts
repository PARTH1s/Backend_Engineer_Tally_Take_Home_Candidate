import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { envelope, fixture, useTestDatabase } from './helpers/harness';

const { app, upload } = useTestDatabase();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('GET /health', () => {
  it('returns 200 with a JSON status', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready checks the database', async () => {
    const res = await request(app()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });
});

describe('voucher export end to end (fixture 01)', () => {
  it('imports, describes and returns the normalized contract', async () => {
    const bytes = fixture('01_receipt_with_allocations.xml');
    const created = await upload(bytes, '01.xml');
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      importId: expect.any(String),
      documentType: 'voucherExport',
      status: 'completed',
      duplicate: false,
      summary: { vouchers: 1, ledgerEntries: 2, inventoryEntries: 0, warnings: 0, errors: 0 },
    });
    const { importId } = created.body;

    const details = await request(app()).get(`/api/tally/imports/${importId}`);
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({
      importId,
      documentType: 'voucherExport',
      status: 'completed',
      contentHash: sha256(bytes),
      detectedEncoding: 'UTF-8',
      summary: created.body.summary,
      warnings: [],
      errors: [],
      byteSize: bytes.length,
      originalFilename: '01.xml',
    });
    expect(details.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(details.body).not.toHaveProperty('tallyResponse');
    expect(JSON.stringify(details.body)).not.toContain('<VOUCHER'); // no raw XML exposed

    const vouchers = await request(app()).get(`/api/tally/imports/${importId}/vouchers`);
    expect(vouchers.status).toBe(200);
    expect(vouchers.body).toEqual({
      count: 1,
      items: [
        {
          source: { importId, contentHash: sha256(bytes), voucherIndex: 0 },
          attributes: { VCHTYPE: 'Receipt', ACTION: 'Create' },
          date: '20260715',
          voucherType: 'Receipt',
          voucherNumber: 'RCP-DEMO-001',
          partyLedgerName: 'Demo Customer',
          narration: 'Sanitized receipt fixture',
          ledgerEntries: [
            {
              sourceTag: 'ALLLEDGERENTRIES.LIST',
              ledgerName: 'Demo Bank',
              isDeemedPositive: 'No',
              amount: '1250.00',
              billAllocations: [],
              bankAllocations: [
                { date: '20260715', name: 'UTR-DEMO-001', transactionType: 'Inter Bank Transfer', amount: '1250.00' },
              ],
              rateDetails: [],
            },
            {
              sourceTag: 'ALLLEDGERENTRIES.LIST',
              ledgerName: 'Demo Customer',
              isDeemedPositive: 'Yes',
              amount: '-1250.00',
              billAllocations: [{ name: 'INV-DEMO-001', billType: 'Agst Ref', amount: '-1250.00' }],
              bankAllocations: [],
              rateDetails: [],
            },
          ],
          inventoryEntries: [],
          warnings: [],
        },
      ],
    });
  });
});

describe('nested sales invoice through the database (fixture 02)', () => {
  it('round-trips every level of the tree and the voucher warning', async () => {
    const res = await upload(fixture('02_sales_invoice_nested.xml'));
    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ vouchers: 1, ledgerEntries: 3, inventoryEntries: 1, warnings: 1, errors: 0 });

    const { body } = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    const v = body.items[0];
    expect(v.ledgerEntries.map((l: { sourceTag: string; amount: string }) => [l.sourceTag, l.amount])).toEqual([
      ['LEDGERENTRIES.LIST', '-118.00'],
      ['LEDGERENTRIES.LIST', '9.00'],
      ['LEDGERENTRIES.LIST', '9.00'],
    ]);
    expect(v.ledgerEntries[0].billAllocations).toEqual([{ name: 'SAL-DEMO-001', billType: 'New Ref', amount: '-118.00' }]);
    expect(v.ledgerEntries[1].rateDetails).toEqual([{ dutyHead: 'CGST', rate: '9' }]);
    expect(v.ledgerEntries[2].rateDetails).toEqual([{ dutyHead: 'SGST/UTGST', rate: '9' }]);
    expect(v.inventoryEntries[0]).toMatchObject({
      actualQty: '2 PCS',
      rate: '50.00/PCS',
      amount: '100.00',
      batchAllocations: [{ godownName: 'Main Location', batchName: 'Primary Batch', amount: '100.00' }],
      accountingAllocations: [
        { ledgerName: 'Demo Sales', amount: '100.00', rateDetails: [{ dutyHead: 'CGST', rate: '9' }, { dutyHead: 'SGST/UTGST', rate: '9' }] },
      ],
      rateDetails: [],
    });
    expect(v.narration).toBeNull();
    expect(v.warnings).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_ELEMENT', path: 'VOUCHER[0]/PERSISTEDVIEW', voucherIndex: 0 }),
    ]);
  });
});

describe('encodings through the API (required test 4)', () => {
  it('UTF-16 with an illegal control reference completes with a persisted warning', async () => {
    const res = await upload(fixture('04_utf16_invalid_control_ref.xml'));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.summary.warnings).toBe(1);

    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body.detectedEncoding).toBe('UTF-16LE');
    expect(details.body.warnings).toEqual([
      expect.objectContaining({ code: 'ILLEGAL_XML_CHARACTERS_REMOVED', path: 'VOUCHER[0]/NARRATION', details: { removed: ['&#4;'] } }),
    ]);

    const vouchers = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    expect(vouchers.body.items[0].voucherNumber).toBe('JRN-DEMO-UTF16');
    expect(vouchers.body.items[0].warnings).toHaveLength(1);
  });

  it('UTF-8 with BOM imports cleanly', async () => {
    const res = await upload(fixture('07_utf8_bom_payment.xml'));
    expect(res.status).toBe(201);
    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body).toMatchObject({ detectedEncoding: 'UTF-8', warnings: [], errors: [] });
    const vouchers = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    expect(vouchers.body.items[0].ledgerEntries.map((l: { amount: string }) => l.amount)).toEqual(['-42.10', '42.10']);
  });
});

describe('Tally response through the API (required test 5)', () => {
  it('accepts the upload (201) while reporting businessStatus failed', async () => {
    const res = await upload(fixture('03_tally_error_response.xml'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ documentType: 'tallyResponse', status: 'completed', duplicate: false });
    expect(res.body.summary).toEqual({ vouchers: 0, ledgerEntries: 0, inventoryEntries: 0, warnings: 0, errors: 0 });

    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body.tallyResponse).toEqual({
      businessStatus: 'failed',
      sourceElement: 'RESPONSE',
      counters: { CREATED: '0', ALTERED: '0', DELETED: '0', IGNORED: '1', ERRORS: '1' },
      lineError: 'Demo ledger does not exist',
      lineErrors: ['Demo ledger does not exist'],
    });

    const vouchers = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    expect(vouchers.body).toEqual({ items: [], count: 0 });
  });

  it('reports succeeded for a clean response', async () => {
    const res = await upload(Buffer.from('<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>'));
    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body.tallyResponse.businessStatus).toBe('succeeded');
  });
});

describe('empty collection and unknown children through the API (required test 6)', () => {
  it('completes an empty collection with zero counts', async () => {
    const res = await upload(fixture('05_empty_collection.xml'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      documentType: 'voucherExport',
      status: 'completed',
      summary: { vouchers: 0, ledgerEntries: 0, inventoryEntries: 0, warnings: 0, errors: 0 },
    });
    const vouchers = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    expect(vouchers.body).toEqual({ items: [], count: 0 });
  });

  it('a document with only unknown children does not invent vouchers', async () => {
    const res = await upload(envelope('<UDF:SOMETHING>1</UDF:SOMETHING><STOCKITEM NAME="x"/>'));
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ vouchers: 0, warnings: 2 });
    const vouchers = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    expect(vouchers.body.count).toBe(0);
  });
});

describe('per-voucher partial failure through the API (extension 1)', () => {
  it('persists valid vouchers, leaves no rows for the invalid one, and returns partial', async () => {
    const good = (n: string) =>
      `<VOUCHER><DATE>20260101</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>${n}</VOUCHERNUMBER>` +
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><AMOUNT>1.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`;
    const bad =
      '<VOUCHER><DATE>20260101</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>' +
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>BAD</LEDGERNAME><AMOUNT>9.99</AMOUNT>' +
      '<BILLALLOCATIONS.LIST><NAME>BAD</NAME></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>';
    const res = await upload(envelope(good('J-0') + bad + good('J-2')));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('partial');
    expect(res.body.summary).toEqual({ vouchers: 2, ledgerEntries: 2, inventoryEntries: 0, warnings: 0, errors: 1 });

    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body.errors).toEqual([
      expect.objectContaining({ code: 'VOUCHER_MISSING_REQUIRED_FIELDS', voucherIndex: 1, details: { missing: ['VOUCHERNUMBER'] } }),
    ]);

    const vouchers = await request(app()).get(`/api/tally/imports/${res.body.importId}/vouchers`);
    expect(vouchers.body.items.map((v: { source: { voucherIndex: number } }) => v.source.voucherIndex)).toEqual([0, 2]);
    expect(JSON.stringify(vouchers.body)).not.toContain('BAD');
  });
});

describe('import lookups', () => {
  it('returns structured 404s for unknown and malformed ids', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "1' OR '1'='1"]) {
      const res = await request(app()).get(`/api/tally/imports/${encodeURIComponent(id)}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'IMPORT_NOT_FOUND', requestId: expect.any(String) });
      const v = await request(app()).get(`/api/tally/imports/${encodeURIComponent(id)}/vouchers`);
      expect(v.status).toBe(404);
    }
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(app()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
