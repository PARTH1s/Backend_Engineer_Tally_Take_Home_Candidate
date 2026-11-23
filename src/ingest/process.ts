import { DocumentError } from '../errors';
import { decodeXmlBytes } from '../xml/decode';
import { interpretDocument, missingRequiredFields, normalizeVoucher } from '../xml/normalize';
import { sanitizeIllegalXmlCharacters } from '../xml/sanitize';
import { parseXmlTree } from '../xml/tree';
import { IssueCollector } from './issues';
import type {
  DocumentType,
  ImportIssue,
  ImportStatus,
  ImportSummary,
  ParsedVoucher,
  TallyResponseResult,
} from './types';

/**
 * Pure (I/O-free) processing of uploaded bytes: decode -> sanitize -> parse -> normalize
 * -> validate. Keeping this free of HTTP and database concerns makes it unit-testable and
 * makes the persistence step a single, short transaction.
 */
export type ProcessedDocument =
  | {
      ok: true;
      documentType: DocumentType;
      status: Exclude<ImportStatus, 'failed'>;
      detectedEncoding: string;
      vouchers: ParsedVoucher[];
      tallyResponse: TallyResponseResult | null;
      issues: ImportIssue[];
      summary: ImportSummary;
    }
  | {
      ok: false;
      status: 'failed';
      detectedEncoding: string | null;
      error: DocumentError;
      issues: ImportIssue[];
      summary: ImportSummary;
    };

export interface ProcessOptions {
  maxXmlDepth: number;
}

function summarize(vouchers: ParsedVoucher[], issues: ImportIssue[]): ImportSummary {
  return {
    vouchers: vouchers.length,
    ledgerEntries: vouchers.reduce((n, v) => n + v.ledgerEntries.length, 0),
    inventoryEntries: vouchers.reduce((n, v) => n + v.inventoryEntries.length, 0),
    warnings: issues.filter((i) => i.severity === 'warning').length,
    errors: issues.filter((i) => i.severity === 'error').length,
  };
}

export function processDocument(bytes: Uint8Array, options: ProcessOptions): ProcessedDocument {
  let detectedEncoding: string | null = null;
  try {
    const decoded = decodeXmlBytes(bytes);
    detectedEncoding = decoded.detectedEncoding;

    const sanitized = sanitizeIllegalXmlCharacters(decoded.text);
    const issues = new IssueCollector();
    issues.addAll(decoded.issues);

    const vouchers: ParsedVoucher[] = [];
    const parsed = parseXmlTree(sanitized, {
      maxDepth: options.maxXmlDepth,
      onVoucher: (el, voucherIndex) => {
        const voucher = normalizeVoucher(el, voucherIndex, issues);
        const missing = missingRequiredFields(voucher);
        if (missing.length > 0) {
          // Optional extension 1: an invalid voucher is an object-level error. It is not
          // persisted (no child rows), while valid siblings are.
          issues.add({
            severity: 'error',
            code: 'VOUCHER_MISSING_REQUIRED_FIELDS',
            message: `Voucher is missing required field(s): ${missing.join(', ')}; it was not imported`,
            voucherIndex,
            path: `VOUCHER[${voucherIndex}]`,
            details: { missing },
          });
          return;
        }
        vouchers.push(voucher);
      },
    });
    issues.addAll(parsed.sanitizationIssues);

    const { documentType, tallyResponse } = interpretDocument(parsed.root, issues);
    if (documentType === 'tallyResponse' && parsed.voucherCount > 0) {
      // Cannot happen with the supported shapes, but never let a response invent vouchers.
      vouchers.length = 0;
    }

    const allIssues = sortIssues(issues.list());
    const summary = summarize(vouchers, allIssues);
    return {
      ok: true,
      documentType,
      status: summary.errors > 0 ? 'partial' : 'completed',
      detectedEncoding,
      vouchers,
      tallyResponse,
      issues: allIssues,
      summary,
    };
  } catch (err) {
    if (!(err instanceof DocumentError)) throw err; // programming error -> 500
    const issues: ImportIssue[] = [
      {
        severity: 'error',
        code: err.code,
        message: err.message,
        voucherIndex: null,
        path: null,
        occurrences: 1,
        details: err.details,
      },
    ];
    return { ok: false, status: 'failed', detectedEncoding, error: err, issues, summary: summarize([], issues) };
  }
}

/** Document-level issues first, then per voucher in source order; stable otherwise. */
function sortIssues(issues: ImportIssue[]): ImportIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => {
      const av = a.issue.voucherIndex ?? -1;
      const bv = b.issue.voucherIndex ?? -1;
      return av - bv || a.i - b.i;
    })
    .map(({ issue }) => issue);
}
