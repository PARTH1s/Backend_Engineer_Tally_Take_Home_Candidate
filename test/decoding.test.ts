import { describe, expect, it } from 'vitest';
import { DocumentError } from '../src/errors';
import { processDocument } from '../src/ingest/process';
import { decodeXmlBytes } from '../src/xml/decode';
import { sanitizeIllegalXmlCharacters } from '../src/xml/sanitize';
import { envelope, fixture } from './helpers/harness';

const run = (bytes: Buffer) => processDocument(bytes, { maxXmlDepth: 64 });

function utf16be(text: string): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]!;
    be[i + 1] = le[i]!;
  }
  return be;
}

describe('encoding detection', () => {
  it('decodes plain UTF-8', () => {
    const d = decodeXmlBytes(fixture('01_receipt_with_allocations.xml'));
    expect(d.detectedEncoding).toBe('UTF-8');
    expect(d.bomPresent).toBe(false);
    expect(d.text.startsWith('<?xml')).toBe(true);
  });

  it('decodes UTF-8 with BOM and strips the BOM from the text', () => {
    const d = decodeXmlBytes(fixture('07_utf8_bom_payment.xml'));
    expect(d.detectedEncoding).toBe('UTF-8');
    expect(d.bomPresent).toBe(true);
    expect(d.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('decodes UTF-16LE with BOM (fixture 04)', () => {
    const d = decodeXmlBytes(fixture('04_utf16_invalid_control_ref.xml'));
    expect(d.detectedEncoding).toBe('UTF-16LE');
    expect(d.bomPresent).toBe(true);
    expect(d.text).toContain('JRN-DEMO-UTF16');
    expect(d.issues).toEqual([]); // declaration says UTF-16, which matches
  });

  it('decodes UTF-16BE with BOM', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><RESPONSE><ERRORS>0</ERRORS></RESPONSE>';
    const d = decodeXmlBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(xml)]));
    expect(d.detectedEncoding).toBe('UTF-16BE');
    expect(d.text).toBe(xml);
  });

  it('decodes BOM-less UTF-16LE from the "<?" byte pattern', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><RESPONSE/>';
    const d = decodeXmlBytes(Buffer.from(xml, 'utf16le'));
    expect(d.detectedEncoding).toBe('UTF-16LE');
    expect(d.text).toBe(xml);
  });

  it('keeps non-ASCII text intact across encodings', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><RESPONSE><LINEERROR>₹ खाता नहीं मिला</LINEERROR></RESPONSE>';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const r = run(le);
    expect(r.ok && r.tallyResponse?.lineError).toBe('₹ खाता नहीं मिला');
  });

  it('warns when the declaration contradicts the bytes', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?><RESPONSE/>')]);
    const d = decodeXmlBytes(bytes);
    expect(d.detectedEncoding).toBe('UTF-8');
    expect(d.issues.map((i) => i.code)).toEqual(['ENCODING_DECLARATION_MISMATCH']);
  });

  it('rejects invalid UTF-8 instead of inserting replacement characters', () => {
    const bytes = Buffer.concat([Buffer.from('<RESPONSE><LINEERROR>'), Buffer.from([0xc3, 0x28]), Buffer.from('</LINEERROR></RESPONSE>')]);
    expect(() => decodeXmlBytes(bytes)).toThrowError(DocumentError);
    const r = run(bytes);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('INVALID_ENCODING');
  });

  it('rejects UTF-32 explicitly', () => {
    expect(() => decodeXmlBytes(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x3c, 0, 0, 0]))).toThrowError(/UTF-32/);
  });
});

describe('illegal XML character recovery', () => {
  it('removes &#4; from UTF-16 fixture 04 and records a warning on the owning field', () => {
    const r = run(fixture('04_utf16_invalid_control_ref.xml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('completed');
    expect(r.vouchers).toHaveLength(1);
    expect(r.vouchers[0]!.narration).toBe('Recoverable control reference  in UTF-16 input');
    expect(r.summary.warnings).toBe(1);
    expect(r.issues[0]).toMatchObject({
      severity: 'warning',
      code: 'ILLEGAL_XML_CHARACTERS_REMOVED',
      voucherIndex: 0,
      path: 'VOUCHER[0]/NARRATION',
      details: { removed: ['&#4;'] },
    });
    // The rest of the voucher is intact.
    expect(r.vouchers[0]!.ledgerEntries.map((l) => l.amount)).toEqual(['-75.50', '75.50']);
  });

  it('keeps legal references (&#9; &#10; &#x20AC; &amp;) and only removes illegal ones', () => {
    const s = sanitizeIllegalXmlCharacters('a&#9;b&#10;c&#x20AC;&amp;#4;d&#x1F;e&#0;');
    expect(s.removals.map((r) => r.original)).toEqual(['&#x1F;', '&#0;']);
    expect(s.text.startsWith('a&#9;b&#10;c&#x20AC;&amp;#4;d')).toBe(true);
  });

  it('removes raw control characters and attributes each removal to its element', () => {
    const r = run(
      envelope(
        '<VOUCHER VCHTYPE="Re\u0001ceipt"><DATE>20260101</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>' +
          '<VOUCHERNUMBER>R-1</VOUCHERNUMBER><ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank&#5;</LEDGERNAME>' +
          '<AMOUNT>1.00</AMOUNT></ALLLEDGERENTRIES.LIST><!-- note &#6; --><NARRATION>x\u0002y</NARRATION></VOUCHER>',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.vouchers[0]!;
    expect(v.attributes.VCHTYPE).toBe('Receipt');
    expect(v.ledgerEntries[0]!.ledgerName).toBe('Bank');
    expect(v.narration).toBe('xy');
    const removed = r.issues.filter((i) => i.code === 'ILLEGAL_XML_CHARACTERS_REMOVED');
    expect(removed.map((i) => [i.path, i.details?.removed])).toEqual([
      ['VOUCHER[0]/@VCHTYPE', ['U+0001']],
      ['VOUCHER[0]/ALLLEDGERENTRIES.LIST[0]/LEDGERNAME', ['&#5;']],
      // The reference inside the comment is consumed without misattributing later ones.
      ['VOUCHER[0]/NARRATION', ['U+0002']],
    ]);
  });
});
