/**
 * Domain types shared by the parser, the persistence layer and the HTTP layer.
 *
 * All Tally values (dates, money, quantities, rates, Yes/No flags) are kept as the exact
 * source strings. `null` means "element not present in the source"; an empty element
 * (`<NARRATION/>`) is the empty string. This makes "absent" and "blank" distinguishable.
 */

export type DocumentType = 'voucherExport' | 'tallyResponse';
export type ImportStatus = 'completed' | 'partial' | 'failed';
export type IssueSeverity = 'warning' | 'error';

export type IssueCode =
  | 'UNKNOWN_ELEMENT'
  | 'UNKNOWN_ATTRIBUTE'
  | 'UNEXPECTED_TEXT'
  | 'DUPLICATE_SCALAR_ELEMENT'
  | 'ILLEGAL_XML_CHARACTERS_REMOVED'
  | 'ENCODING_DECLARATION_MISMATCH'
  | 'NON_NUMERIC_RESPONSE_COUNTER'
  | 'VOUCHER_MISSING_REQUIRED_FIELDS'
  | 'UNSUPPORTED_ENCODING'
  | 'INVALID_ENCODING'
  | 'MALFORMED_XML'
  | 'DTD_NOT_ALLOWED'
  | 'XML_TOO_DEEP'
  | 'UNSUPPORTED_DOCUMENT';

/**
 * A warning or error recorded during an import.
 *
 * `path` points at the first source location, e.g. `VOUCHER[0]/ALLLEDGERENTRIES.LIST[1]/UDF:X`
 * (zero-based index among same-named siblings). Repeats of the same issue at the same
 * index-free path within one voucher are aggregated into `occurrences` so a large export
 * with a common custom field produces one warning per voucher, not thousands.
 */
export interface ImportIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  voucherIndex: number | null;
  path: string | null;
  occurrences: number;
  details: Record<string, unknown> | null;
}

export interface BillAllocation {
  name: string | null;
  billType: string | null;
  amount: string | null;
}

export interface BankAllocation {
  date: string | null;
  name: string | null;
  transactionType: string | null;
  amount: string | null;
}

export interface RateDetail {
  dutyHead: string | null;
  rate: string | null;
}

export type LedgerSourceTag = 'ALLLEDGERENTRIES.LIST' | 'LEDGERENTRIES.LIST';
export type InventorySourceTag = 'ALLINVENTORYENTRIES.LIST';

export interface LedgerEntry {
  sourceTag: LedgerSourceTag;
  ledgerName: string | null;
  isDeemedPositive: string | null;
  amount: string | null;
  billAllocations: BillAllocation[];
  bankAllocations: BankAllocation[];
  rateDetails: RateDetail[];
}

export interface BatchAllocation {
  godownName: string | null;
  batchName: string | null;
  actualQty: string | null;
  billedQty: string | null;
  amount: string | null;
}

export interface AccountingAllocation {
  ledgerName: string | null;
  isDeemedPositive: string | null;
  amount: string | null;
  rateDetails: RateDetail[];
}

export interface InventoryEntry {
  sourceTag: InventorySourceTag;
  stockItemName: string | null;
  isDeemedPositive: string | null;
  actualQty: string | null;
  billedQty: string | null;
  rate: string | null;
  amount: string | null;
  batchAllocations: BatchAllocation[];
  accountingAllocations: AccountingAllocation[];
  rateDetails: RateDetail[];
}

export interface VoucherAttributes {
  VCHTYPE?: string;
  ACTION?: string;
}

/** A voucher as produced by the parser, before it is given an import id. */
export interface ParsedVoucher {
  voucherIndex: number;
  attributes: VoucherAttributes;
  date: string | null;
  voucherType: string | null;
  voucherNumber: string | null;
  partyLedgerName: string | null;
  narration: string | null;
  ledgerEntries: LedgerEntry[];
  inventoryEntries: InventoryEntry[];
}

/** Tally counters are kept as the source strings (e.g. "0", "1"); null when absent. */
export interface TallyCounters {
  CREATED: string | null;
  ALTERED: string | null;
  DELETED: string | null;
  IGNORED: string | null;
  ERRORS: string | null;
}

export interface TallyResponseResult {
  businessStatus: 'succeeded' | 'failed';
  /** Which element the counters were read from: `RESPONSE` or `ENVELOPE/BODY/DATA/IMPORTRESULT`. */
  sourceElement: 'RESPONSE' | 'IMPORTRESULT';
  counters: TallyCounters;
  /** First non-empty LINEERROR, or null. */
  lineError: string | null;
  /** Every LINEERROR in source order (Tally can emit several). */
  lineErrors: string[];
}

export interface ImportSummary {
  vouchers: number;
  ledgerEntries: number;
  inventoryEntries: number;
  warnings: number;
  errors: number;
}
