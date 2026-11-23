import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { fixture, useTestDatabase } from './helpers/harness';

const { pool, app, upload } = useTestDatabase();

/** Asserts a structured error body with no stack traces, SQL or filesystem paths. */
function expectSafeError(body: unknown, code: string) {
  expect(body).toMatchObject({ error: { code, message: expect.any(String), requestId: expect.any(String) } });
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/\bat \S+ \(|node_modules|[A-Za-z]:\\\\|\/usr\/|\/app\/|\.ts:\d+|SELECT |INSERT /);
}

describe('XML entity and DTD defenses', () => {
  it('rejects a billion-laughs document without expanding anything', async () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<RESPONSE><LINEERROR>&lol3;</LINEERROR></RESPONSE>`;
    const res = await upload(Buffer.from(xml));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'failed', error: { code: 'DTD_NOT_ALLOWED' } });
    expect(JSON.stringify(res.body)).not.toContain('lollol');
  });

  it('rejects external entities (XXE) and never reads local files', async () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<RESPONSE><LINEERROR>&xxe;</LINEERROR></RESPONSE>`;
    const res = await upload(Buffer.from(xml));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DTD_NOT_ALLOWED');
    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(JSON.stringify(details.body)).not.toMatch(/root:|passwd/);
  });

  it('rejects undefined entity references as malformed', async () => {
    const res = await upload(Buffer.from('<RESPONSE><LINEERROR>&xxe;</LINEERROR></RESPONSE>'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MALFORMED_XML');
  });

  it('rejects pathologically deep nesting', async () => {
    const deep = '<ENVELOPE>' + '<X>'.repeat(200) + '</X>'.repeat(200) + '</ENVELOPE>';
    const res = await upload(Buffer.from(deep));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('XML_TOO_DEEP');
  });

  it('persists failed imports with the raw bytes for investigation', async () => {
    const bytes = Buffer.from('<ENVELOPE><BODY><DATA><COLLECTION>');
    const res = await upload(bytes);
    expect(res.status).toBe(422);
    const raw = await pool.query('SELECT content FROM tally_import_raw WHERE import_id = $1', [res.body.importId]);
    expect(Buffer.compare(raw.rows[0].content, bytes)).toBe(0);
    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body).toMatchObject({ status: 'failed', documentType: null, warnings: [] });
    expect(details.body.errors).toEqual([expect.objectContaining({ code: 'MALFORMED_XML' })]);
  });
});

describe('upload limits and request validation', () => {
  it('rejects uploads over the configured size limit with 413 and persists nothing', async () => {
    const big = Buffer.alloc(4096, 0x20);
    const res = await upload(big, 'big.xml', { maxUploadBytes: 1024 });
    expect(res.status).toBe(413);
    expectSafeError(res.body, 'PAYLOAD_TOO_LARGE');
    expect((await pool.query('SELECT 1 FROM tally_import')).rowCount).toBe(0);
  });

  it('requires the multipart field to be named "file"', async () => {
    const res = await request(app())
      .post('/api/tally/imports')
      .attach('document', fixture('01_receipt_with_allocations.xml'), 'x.xml');
    expect(res.status).toBe(400);
    expectSafeError(res.body, 'UNEXPECTED_FIELD');
  });

  it('rejects a request without a file', async () => {
    const res = await request(app()).post('/api/tally/imports').field('note', 'hi');
    expect(res.status).toBe(400);
    expectSafeError(res.body, 'FILE_REQUIRED');
  });

  it('rejects a non-multipart body', async () => {
    const res = await request(app()).post('/api/tally/imports').set('content-type', 'application/xml').send('<RESPONSE/>');
    expect(res.status).toBe(400);
    expectSafeError(res.body, 'FILE_REQUIRED');
  });

  it('rejects an empty file', async () => {
    const res = await upload(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expectSafeError(res.body, 'EMPTY_FILE');
  });

  it('rejects a corrupt multipart body with a structured 400', async () => {
    const res = await request(app())
      .post('/api/tally/imports')
      .set('content-type', 'multipart/form-data; boundary=XYZ')
      .send('--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.xml"\r\n\r\n<RESPONSE/>');
    expect(res.status).toBe(400);
    expectSafeError(res.body, 'INVALID_MULTIPART');
  });

  it('stores only a safe basename of the client filename', async () => {
    const res = await upload(fixture('05_empty_collection.xml'), '..\\..\\C:\\Users\\someone\\secret\\export.xml');
    const details = await request(app()).get(`/api/tally/imports/${res.body.importId}`);
    expect(details.body.originalFilename).toBe('export.xml');
  });

  it('structured errors on failed documents contain no stack or paths', async () => {
    const res = await upload(Buffer.from('<<<not xml'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'failed', duplicate: false, error: { code: 'MALFORMED_XML' } });
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|\.ts:\d+|\bat \S+ \(/);
  });
});
