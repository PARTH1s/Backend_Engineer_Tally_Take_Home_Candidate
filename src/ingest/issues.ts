import type { ImportIssue, IssueCode, IssueSeverity } from './types';

export interface IssueInput {
  severity?: IssueSeverity;
  code: IssueCode;
  message: string;
  voucherIndex?: number | null;
  path?: string | null;
  details?: Record<string, unknown> | null;
}

/** `VOUCHER[3]/ALLLEDGERENTRIES.LIST[1]/UDF:X` -> `VOUCHER/ALLLEDGERENTRIES.LIST/UDF:X` */
export function schemaPath(path: string): string {
  return path.replace(/\[\d+\]/g, '');
}

/**
 * Collects warnings/errors in source order and aggregates repeats.
 *
 * Two issues are "the same" when they share severity, code, voucher and index-free path.
 * The first occurrence keeps its concrete path; later ones only bump `occurrences`.
 */
export class IssueCollector {
  private readonly issues: ImportIssue[] = [];
  private readonly byKey = new Map<string, ImportIssue>();

  add(input: IssueInput): void {
    const issue: ImportIssue = {
      severity: input.severity ?? 'warning',
      code: input.code,
      message: input.message,
      voucherIndex: input.voucherIndex ?? null,
      path: input.path ?? null,
      occurrences: 1,
      details: input.details ?? null,
    };
    const key = [
      issue.severity,
      issue.code,
      issue.voucherIndex ?? '-',
      issue.path === null ? '-' : schemaPath(issue.path),
      // Attribute warnings are distinct per attribute name.
      typeof issue.details?.attribute === 'string' ? issue.details.attribute : '',
    ].join('|');

    const existing = this.byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      return;
    }
    this.byKey.set(key, issue);
    this.issues.push(issue);
  }

  addAll(issues: readonly ImportIssue[]): void {
    for (const issue of issues) {
      this.issues.push(issue);
    }
  }

  list(): ImportIssue[] {
    return [...this.issues];
  }
}
