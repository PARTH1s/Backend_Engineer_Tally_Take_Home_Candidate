import type { ImportRecord } from '../ingest/repository';
import type { ImportIssue, ParsedVoucher, TallyResponseResult } from '../ingest/types';

/**
 * JSON shapes returned by the API. Kept separate from persistence rows so the public
 * contract cannot drift by accident when a column is added.
 */

export function issueJson(issue: ImportIssue) {
  return {
    code: issue.code,
    message: issue.message,
    voucherIndex: issue.voucherIndex,
    path: issue.path,
    occurrences: issue.occurrences,
    ...(issue.details ? { details: issue.details } : {}),
  };
}

export function uploadJson(record: ImportRecord, duplicate: boolean, failure: ImportIssue | null) {
  return {
    importId: record.id,
    documentType: record.documentType,
    status: record.status,
    duplicate,
    summary: record.summary,
    ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
  };
}

export function detailsJson(record: ImportRecord, issues: ImportIssue[], tallyResponse: TallyResponseResult | null) {
  return {
    importId: record.id,
    documentType: record.documentType,
    status: record.status,
    contentHash: record.contentHash,
    detectedEncoding: record.detectedEncoding,
    summary: record.summary,
    warnings: issues.filter((i) => i.severity === 'warning').map(issueJson),
    errors: issues.filter((i) => i.severity === 'error').map(issueJson),
    ...(record.documentType === 'tallyResponse' && tallyResponse ? { tallyResponse } : {}),
    // Extra, documented fields (allowed by the contract):
    byteSize: record.byteSize,
    originalFilename: record.originalFilename,
    parserVersion: record.parserVersion,
    createdAt: record.createdAt.toISOString(),
    // The raw bytes are retained server-side; they are never returned by this endpoint.
    rawSource: { retained: true, byteSize: record.byteSize, sha256: record.contentHash },
  };
}

export function voucherJson(record: ImportRecord, voucher: ParsedVoucher, issues: ImportIssue[]) {
  return {
    source: {
      importId: record.id,
      contentHash: record.contentHash,
      voucherIndex: voucher.voucherIndex,
    },
    attributes: voucher.attributes,
    date: voucher.date,
    voucherType: voucher.voucherType,
    voucherNumber: voucher.voucherNumber,
    partyLedgerName: voucher.partyLedgerName,
    narration: voucher.narration,
    ledgerEntries: voucher.ledgerEntries,
    inventoryEntries: voucher.inventoryEntries,
    warnings: issues
      .filter((i) => i.severity === 'warning' && i.voucherIndex === voucher.voucherIndex)
      .map(issueJson),
  };
}
