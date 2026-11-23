import { describe, expect, it } from 'vitest';
import { processDocument, type ProcessedDocument } from '../src/ingest/process';
import { envelope, fixture } from './helpers/harness';

type Ok = Extract<ProcessedDocument, { ok: true }>;

function ok(bytes: Buffer): Ok {
  const r = processDocument(bytes, { maxXmlDepth: 64 });
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.message}`);
  return r;
}

const REQUIRED = '<DATE>20260101</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>J-1</VOUCHERNUMBER>';

describe('repeated ledger entries (required test 1)', () => {
  it('keeps every ledger entry separate and in source order (fixture 01)', () => {
    const v = ok(fixture('01_receipt_with_allocations.xml')).vouchers[0]!;
    expect(v.ledgerEntries.map((l) => [l.sourceTag, l.ledgerName, l.amount])).toEqual([
      ['ALLLEDGERENTRIES.LIST', 'Demo Bank', '1250.00'],
      ['ALLLEDGERENTRIES.LIST', 'Demo Customer', '-1250.00'],
    ]);
  });

  it('preserves interleaved ALLLEDGERENTRIES.LIST / LEDGERENTRIES.LIST order and sourceTag', () => {
    const v = ok(
      envelope(
        `<VOUCHER>${REQUIRED}
          <LEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME></LEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME></ALLLEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST><LEDGERNAME>C</LEDGERNAME></LEDGERENTRIES.LIST>
        </VOUCHER>`,
      ),
    ).vouchers[0]!;
    expect(v.ledgerEntries.map((l) => `${l.sourceTag}:${l.ledgerName}`)).toEqual([
      'LEDGERENTRIES.LIST:A',
      'ALLLEDGERENTRIES.LIST:B',
      'LEDGERENTRIES.LIST:C',
    ]);
  });

  it('does not merge identical rows: equal values are still separate items', () => {
    const entry = '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Same</LEDGERNAME><AMOUNT>10.00</AMOUNT>' +
      '<BILLALLOCATIONS.LIST><NAME>X</NAME><AMOUNT>10.00</AMOUNT></BILLALLOCATIONS.LIST>' +
      '<BILLALLOCATIONS.LIST><NAME>X</NAME><AMOUNT>10.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>';
    const v = ok(envelope(`<VOUCHER>${REQUIRED}${entry}${entry}</VOUCHER>`)).vouchers[0]!;
    expect(v.ledgerEntries).toHaveLength(2);
    expect(v.ledgerEntries[0]).toEqual(v.ledgerEntries[1]);
    expect(v.ledgerEntries[0]!.billAllocations).toHaveLength(2);
  });

  it('represents a single occurrence as a one-item array, and absence as []', () => {
    const v = ok(fixture('01_receipt_with_allocations.xml')).vouchers[0]!;
    expect(v.ledgerEntries[0]!.bankAllocations).toHaveLength(1);
    expect(v.ledgerEntries[0]!.billAllocations).toEqual([]);
    expect(v.ledgerEntries[1]!.billAllocations).toHaveLength(1);
    expect(v.ledgerEntries[1]!.bankAllocations).toEqual([]);
    expect(v.inventoryEntries).toEqual([]);
  });
});

describe('AMOUNT ownership (required test 2)', () => {
  it('keeps ledger, bill, inventory, batch and accounting amounts under their own parents (fixture 02)', () => {
    // Make every level's AMOUNT distinct so any overwrite or leak is visible.
    const xml = fixture('02_sales_invoice_nested.xml')
      .toString('utf8')
      .replace(/(<BILLALLOCATIONS.LIST>[\s\S]*?)<AMOUNT>-118.00<\/AMOUNT>/, '$1<AMOUNT>-118.01</AMOUNT>')
      .replace(/(<BATCHALLOCATIONS.LIST>[\s\S]*?)<AMOUNT>100.00<\/AMOUNT>/, '$1<AMOUNT>100.02</AMOUNT>')
      .replace(/(<ACCOUNTINGALLOCATIONS.LIST>[\s\S]*?)<AMOUNT>100.00<\/AMOUNT>/, '$1<AMOUNT>100.03</AMOUNT>');
    const v = ok(Buffer.from(xml)).vouchers[0]!;

    expect(v.ledgerEntries[0]!.amount).toBe('-118.00');
    expect(v.ledgerEntries[0]!.billAllocations[0]!.amount).toBe('-118.01');
    const inv = v.inventoryEntries[0]!;
    expect(inv.amount).toBe('100.00');
    expect(inv.batchAllocations[0]!.amount).toBe('100.02');
    expect(inv.accountingAllocations[0]!.amount).toBe('100.03');
  });

  it('matches the normalized contract for fixture 02 exactly', () => {
    const v = ok(fixture('02_sales_invoice_nested.xml')).vouchers[0]!;
    expect(v.inventoryEntries).toEqual([
      {
        sourceTag: 'ALLINVENTORYENTRIES.LIST',
        stockItemName: 'Demo Item',
        isDeemedPositive: 'No',
        actualQty: '2 PCS',
        billedQty: '2 PCS',
        rate: '50.00/PCS',
        amount: '100.00',
        batchAllocations: [
          { godownName: 'Main Location', batchName: 'Primary Batch', actualQty: '2 PCS', billedQty: '2 PCS', amount: '100.00' },
        ],
        accountingAllocations: [
          {
            ledgerName: 'Demo Sales',
            isDeemedPositive: 'No',
            amount: '100.00',
            rateDetails: [
              { dutyHead: 'CGST', rate: '9' },
              { dutyHead: 'SGST/UTGST', rate: '9' },
            ],
          },
        ],
        rateDetails: [],
      },
    ]);
    // Rate details stay with the ledger entry that owns them.
    expect(v.ledgerEntries.map((l) => l.rateDetails)).toEqual([
      [],
      [{ dutyHead: 'CGST', rate: '9' }],
      [{ dutyHead: 'SGST/UTGST', rate: '9' }],
    ]);
  });

  it('attaches RATEDETAILS.LIST to an inventory entry directly when it appears there', () => {
    const v = ok(
      envelope(
        `<VOUCHER>${REQUIRED}<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>I</STOCKITEMNAME>
           <RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST>
           <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>S</LEDGERNAME></ACCOUNTINGALLOCATIONS.LIST>
         </ALLINVENTORYENTRIES.LIST></VOUCHER>`,
      ),
    ).vouchers[0]!;
    expect(v.inventoryEntries[0]!.rateDetails).toEqual([{ dutyHead: 'IGST', rate: '18' }]);
    expect(v.inventoryEntries[0]!.accountingAllocations[0]!.rateDetails).toEqual([]);
  });

  it('reads voucher fields from direct children only (no descendant search)', () => {
    // DATE and NAME exist only inside a bank allocation; the voucher must not borrow them.
    const v = ok(
      envelope(
        `<VOUCHER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>R-1</VOUCHERNUMBER><DATE>20260102</DATE>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME>
            <BANKALLOCATIONS.LIST><DATE>20991231</DATE><NAME>UTR</NAME><AMOUNT>5.00</AMOUNT></BANKALLOCATIONS.LIST>
          </ALLLEDGERENTRIES.LIST></VOUCHER>`,
      ),
    ).vouchers[0]!;
    expect(v.date).toBe('20260102');
    expect(v.partyLedgerName).toBeNull();
    expect(v.narration).toBeNull();
    const le = v.ledgerEntries[0]!;
    expect(le.amount).toBeNull(); // the bank allocation's AMOUNT must not leak upward
    expect(le.bankAllocations[0]).toEqual({ date: '20991231', name: 'UTR', transactionType: null, amount: '5.00' });
  });
});

describe('lossless values', () => {
  it('keeps signs, ISDEEMEDPOSITIVE and unit-bearing text exactly as written', () => {
    const v = ok(fixture('01_receipt_with_allocations.xml')).vouchers[0]!;
    const customer = v.ledgerEntries[1]!;
    expect(customer.isDeemedPositive).toBe('Yes');
    expect(customer.amount).toBe('-1250.00'); // not flipped to 1250.00
    expect(customer.billAllocations[0]!.amount).toBe('-1250.00');
  });

  it('does not round, trim or reformat numeric-looking text', () => {
    const v = ok(
      envelope(
        `<VOUCHER>${REQUIRED}<ALLLEDGERENTRIES.LIST><AMOUNT>-0.10</AMOUNT></ALLLEDGERENTRIES.LIST>
         <ALLLEDGERENTRIES.LIST><AMOUNT>12345678901234567890.123456789</AMOUNT></ALLLEDGERENTRIES.LIST>
         <ALLINVENTORYENTRIES.LIST><ACTUALQTY> 2.500 Kgs</ACTUALQTY><RATE>1,250.00/Nos</RATE><AMOUNT>007.50</AMOUNT></ALLINVENTORYENTRIES.LIST>
        </VOUCHER>`,
      ),
    ).vouchers[0]!;
    expect(v.ledgerEntries.map((l) => l.amount)).toEqual(['-0.10', '12345678901234567890.123456789']);
    expect(v.inventoryEntries[0]).toMatchObject({ actualQty: ' 2.500 Kgs', rate: '1,250.00/Nos', amount: '007.50' });
  });

  it('distinguishes an empty element ("") from a missing one (null)', () => {
    const v = ok(envelope(`<VOUCHER>${REQUIRED}<NARRATION/></VOUCHER>`)).vouchers[0]!;
    expect(v.narration).toBe('');
    expect(v.partyLedgerName).toBeNull();
  });

  it('decodes standard entities and CDATA in values', () => {
    const v = ok(envelope(`<VOUCHER>${REQUIRED}<PARTYLEDGERNAME>A &amp; B &lt;Ltd&gt;</PARTYLEDGERNAME><NARRATION><![CDATA[x < y]]></NARRATION></VOUCHER>`)).vouchers[0]!;
    expect(v.partyLedgerName).toBe('A & B <Ltd>');
    expect(v.narration).toBe('x < y');
  });

  it('keeps VCHTYPE and ACTION attributes and only those', () => {
    const r = ok(envelope(`<VOUCHER VCHTYPE="Receipt" ACTION="Create" REMOTEID="abc">${REQUIRED}</VOUCHER>`));
    expect(r.vouchers[0]!.attributes).toEqual({ VCHTYPE: 'Receipt', ACTION: 'Create' });
    expect(r.issues).toMatchObject([{ code: 'UNKNOWN_ATTRIBUTE', path: 'VOUCHER[0]/@REMOTEID' }]);
  });
});

describe('empty collections and unknown children (required test 6)', () => {
  it('completes an empty collection with zero vouchers and no warnings', () => {
    const r = ok(fixture('05_empty_collection.xml'));
    expect(r.documentType).toBe('voucherExport');
    expect(r.status).toBe('completed');
    expect(r.vouchers).toEqual([]);
    expect(r.summary).toEqual({ vouchers: 0, ledgerEntries: 0, inventoryEntries: 0, warnings: 0, errors: 0 });
  });

  it('warns about an unknown voucher child (PERSISTEDVIEW in fixture 02) without inventing data', () => {
    const r = ok(fixture('02_sales_invoice_nested.xml'));
    expect(r.vouchers).toHaveLength(1);
    expect(r.issues).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'UNKNOWN_ELEMENT', voucherIndex: 0, path: 'VOUCHER[0]/PERSISTEDVIEW' }),
    ]);
    expect(JSON.stringify(r.vouchers)).not.toContain('Invoice Voucher View');
  });

  it('handles nested UDF / unknown nodes at every level, aggregating repeats per voucher', () => {
    const r = ok(
      envelope(
        `<VOUCHER>${REQUIRED}<UDF:CUSTOMFIELD.LIST TYPE="String"><UDF:CUSTOMFIELD>x</UDF:CUSTOMFIELD></UDF:CUSTOMFIELD.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>L</LEDGERNAME><UDF:NOTE>a</UDF:NOTE><AMOUNT>1</AMOUNT></ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>M</LEDGERNAME><UDF:NOTE>b</UDF:NOTE><AMOUNT>2</AMOUNT>
            <BILLALLOCATIONS.LIST><NAME>B</NAME><SURPRISE><DEEP>1</DEEP></SURPRISE></BILLALLOCATIONS.LIST>
          </ALLLEDGERENTRIES.LIST>
          <INVENTORYENTRIES.LIST><STOCKITEMNAME>out of scope</STOCKITEMNAME></INVENTORYENTRIES.LIST>
        </VOUCHER>
        <SOMETHINGELSE/>`,
      ),
    );
    const v = r.vouchers[0]!;
    expect(v.ledgerEntries.map((l) => [l.ledgerName, l.amount])).toEqual([['L', '1'], ['M', '2']]);
    expect(v.ledgerEntries[1]!.billAllocations).toEqual([{ name: 'B', billType: null, amount: null }]);
    expect(v.inventoryEntries).toEqual([]); // INVENTORYENTRIES.LIST is not claimed as normalized

    // Order: document-level first, then per voucher; within a voucher, a node's own unknown
    // children are reported before those of its descendants.
    const warnings = r.issues.map((i) => [i.voucherIndex, i.path, i.occurrences]);
    expect(warnings).toEqual([
      [null, 'ENVELOPE/BODY/DATA/COLLECTION/SOMETHINGELSE', 1],
      [0, 'VOUCHER[0]/UDF:CUSTOMFIELD.LIST[0]', 1],
      [0, 'VOUCHER[0]/INVENTORYENTRIES.LIST[0]', 1],
      [0, 'VOUCHER[0]/ALLLEDGERENTRIES.LIST[0]/UDF:NOTE', 2],
      [0, 'VOUCHER[0]/ALLLEDGERENTRIES.LIST[1]/BILLALLOCATIONS.LIST[0]/SURPRISE', 1],
    ]);
    expect(r.summary.warnings).toBe(5);
  });

  it('flags a duplicated scalar instead of silently picking one', () => {
    const r = ok(envelope(`<VOUCHER>${REQUIRED}<ALLLEDGERENTRIES.LIST><AMOUNT>1.00</AMOUNT><AMOUNT>2.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`));
    expect(r.vouchers[0]!.ledgerEntries[0]!.amount).toBe('1.00');
    expect(r.issues).toMatchObject([
      { code: 'DUPLICATE_SCALAR_ELEMENT', path: 'VOUCHER[0]/ALLLEDGERENTRIES.LIST[0]/AMOUNT[1]', details: { ignoredValue: '2.00' } },
    ]);
  });
});

describe('Tally RESPONSE documents (required test 5)', () => {
  it('reports businessStatus failed for ERRORS=1 while processing itself completed', () => {
    const r = ok(fixture('03_tally_error_response.xml'));
    expect(r.documentType).toBe('tallyResponse');
    expect(r.status).toBe('completed');
    expect(r.vouchers).toEqual([]);
    expect(r.tallyResponse).toEqual({
      businessStatus: 'failed',
      sourceElement: 'RESPONSE',
      counters: { CREATED: '0', ALTERED: '0', DELETED: '0', IGNORED: '1', ERRORS: '1' },
      lineError: 'Demo ledger does not exist',
      lineErrors: ['Demo ledger does not exist'],
    });
  });

  it.each([
    ['ERRORS=0 and no LINEERROR', '<CREATED>1</CREATED><ERRORS>0</ERRORS>', 'succeeded'],
    ['ERRORS=0 but a LINEERROR', '<ERRORS>0</ERRORS><LINEERROR>Bad date</LINEERROR>', 'failed'],
    ['ERRORS=2 without LINEERROR', '<ERRORS>2</ERRORS>', 'failed'],
    ['whitespace-only LINEERROR', '<ERRORS>0</ERRORS><LINEERROR>  </LINEERROR>', 'succeeded'],
    ['second LINEERROR non-empty', '<ERRORS>0</ERRORS><LINEERROR></LINEERROR><LINEERROR>Oops</LINEERROR>', 'failed'],
    ['non-numeric ERRORS (fail safe)', '<ERRORS>n/a</ERRORS>', 'failed'],
    ['huge ERRORS value', '<ERRORS>99999999999999999999</ERRORS>', 'failed'],
  ])('%s -> %s', (_label, body, expected) => {
    const r = ok(Buffer.from(`<RESPONSE>${body}</RESPONSE>`));
    expect(r.tallyResponse!.businessStatus).toBe(expected);
  });

  it('normalizes ENVELOPE/BODY/DATA/IMPORTRESULT into the same shape (extension 5)', () => {
    const r = ok(
      Buffer.from(
        `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT>
           <CREATED>0</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><LASTVCHID>0</LASTVCHID>
           <IGNORED>0</IGNORED><ERRORS>1</ERRORS><LINEERROR>Voucher totals do not match!</LINEERROR>
         </IMPORTRESULT></DATA></BODY></ENVELOPE>`,
      ),
    );
    expect(r.documentType).toBe('tallyResponse');
    expect(r.tallyResponse).toMatchObject({
      businessStatus: 'failed',
      sourceElement: 'IMPORTRESULT',
      counters: { CREATED: '0', ALTERED: '0', DELETED: '0', IGNORED: '0', ERRORS: '1' },
      lineError: 'Voucher totals do not match!',
    });
    expect(r.issues).toMatchObject([{ code: 'UNKNOWN_ELEMENT', path: 'ENVELOPE/BODY/DATA/IMPORTRESULT/LASTVCHID' }]);
  });
});

describe('per-voucher partial failure (extension 1)', () => {
  it('rejects only vouchers missing DATE/VOUCHERTYPENAME/VOUCHERNUMBER and keeps source indexes', () => {
    const r = ok(
      envelope(
        `<VOUCHER>${REQUIRED}<ALLLEDGERENTRIES.LIST><AMOUNT>1</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
         <VOUCHER><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><DATE>  </DATE>
           <ALLLEDGERENTRIES.LIST><AMOUNT>99</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
         <VOUCHER>${REQUIRED.replace('J-1', 'J-3')}</VOUCHER>`,
      ),
    );
    expect(r.status).toBe('partial');
    expect(r.vouchers.map((v) => [v.voucherIndex, v.voucherNumber])).toEqual([[0, 'J-1'], [2, 'J-3']]);
    expect(r.summary).toMatchObject({ vouchers: 2, ledgerEntries: 1, errors: 1 });
    expect(r.issues).toMatchObject([
      { severity: 'error', code: 'VOUCHER_MISSING_REQUIRED_FIELDS', voucherIndex: 1, details: { missing: ['DATE', 'VOUCHERNUMBER'] } },
    ]);
  });
});

describe('unsupported and malformed documents', () => {
  it.each([
    ['unknown root', '<FOO/>', 'UNSUPPORTED_DOCUMENT'],
    ['ENVELOPE without BODY/DATA', '<ENVELOPE><HEADER/></ENVELOPE>', 'UNSUPPORTED_DOCUMENT'],
    ['ENVELOPE with an unsupported DATA shape', '<ENVELOPE><BODY><DATA><TALLYMESSAGE/></DATA></BODY></ENVELOPE>', 'UNSUPPORTED_DOCUMENT'],
    ['truncated XML', '<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER>', 'MALFORMED_XML'],
    ['two roots', '<RESPONSE/><RESPONSE/>', 'MALFORMED_XML'],
    ['not XML at all', 'DATE,AMOUNT\n20260101,1.00', 'MALFORMED_XML'],
  ])('%s -> %s', (_label, xml, code) => {
    const r = processDocument(Buffer.from(xml), { maxXmlDepth: 64 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe(code);
    expect(r.summary.errors).toBe(1);
  });
});
