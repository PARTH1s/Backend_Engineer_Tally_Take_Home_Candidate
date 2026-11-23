import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { PARSER_VERSION } from '../config';
import { processDocument } from './process';
import { findImportByHash, persistImport, recordDuplicateUpload, type ImportRecord } from './repository';
import type { ImportIssue } from './types';

export interface IngestInput {
  bytes: Buffer;
  /** Client-supplied filename; audit metadata only, never part of content identity. */
  filename: string | null;
}

export interface IngestResult {
  duplicate: boolean;
  record: ImportRecord;
  /** Present for a failed import: the structured reason (also persisted as an error). */
  failure: ImportIssue | null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Upload use case: hash -> (fast duplicate check) -> process -> atomic persist.
 *
 * The fast check only avoids re-parsing on an obvious re-upload. Correctness never depends
 * on it: two concurrent first uploads both pass it, and the UNIQUE constraint inside
 * `persistImport` decides the single winner.
 */
export async function ingestUpload(
  pool: Pool,
  input: IngestInput,
  options: { maxXmlDepth: number },
): Promise<IngestResult> {
  const contentHash = sha256Hex(input.bytes);

  const existing = await findImportByHash(pool, contentHash);
  if (existing) {
    await recordDuplicateUpload(pool, existing.id, input.filename);
    return { duplicate: true, record: existing, failure: await failureOf(pool, existing) };
  }

  const processed = processDocument(input.bytes, { maxXmlDepth: options.maxXmlDepth });

  const outcome = await persistImport(pool, {
    contentHash,
    bytes: input.bytes,
    filename: input.filename,
    parserVersion: PARSER_VERSION,
    documentType: processed.ok ? processed.documentType : null,
    status: processed.status,
    detectedEncoding: processed.detectedEncoding,
    summary: processed.summary,
    issues: processed.issues,
    tallyResponse: processed.ok ? processed.tallyResponse : null,
    vouchers: processed.ok ? processed.vouchers : [],
  });

  const record = await findImportByHash(pool, contentHash);
  if (!record) throw new Error('Import row missing after persist');
  return {
    duplicate: !outcome.created,
    record,
    failure: await failureOf(pool, record),
  };
}

async function failureOf(pool: Pool, record: ImportRecord): Promise<ImportIssue | null> {
  if (record.status !== 'failed') return null;
  const { rows } = await pool.query<{ code: ImportIssue['code']; message: string; details: Record<string, unknown> | null }>(
    `SELECT code, message, details FROM import_issue
      WHERE import_id = $1 AND severity = 'error' ORDER BY ordinal LIMIT 1`,
    [record.id],
  );
  const r = rows[0];
  if (!r) return null;
  return { severity: 'error', code: r.code, message: r.message, voucherIndex: null, path: null, occurrences: 1, details: r.details };
}
