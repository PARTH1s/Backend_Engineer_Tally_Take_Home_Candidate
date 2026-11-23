import { DocumentError } from '../errors';
import type { IssueCollector } from '../ingest/issues';
import type {
  AccountingAllocation,
  BankAllocation,
  BatchAllocation,
  BillAllocation,
  DocumentType,
  InventoryEntry,
  LedgerEntry,
  LedgerSourceTag,
  ParsedVoucher,
  RateDetail,
  TallyCounters,
  TallyResponseResult,
  VoucherAttributes,
} from '../ingest/types';
import type { XmlElement } from './tree';

/**
 * Converts XML element trees into the normalized contract.
 *
 * Rule: every field is read from a *direct child* of the element that owns it. There is
 * no descendant-wide search anywhere in this file, which is what keeps
 * `ALLLEDGERENTRIES.LIST/AMOUNT` and `.../BILLALLOCATIONS.LIST/AMOUNT` apart.
 *
 * Each node type declares the scalar children, repeated `.LIST` children and attributes it
 * understands. Anything else is reported as "retained but not normalized" instead of
 * being dropped silently or crashing the import.
 */

interface NodeSpec {
  scalars: readonly string[];
  lists?: readonly string[];
  attributes?: readonly string[];
}

interface NodeReader {
  /** Exact direct text of the first direct child named `tag`; null when absent. */
  scalar(tag: string): string | null;
  /** Direct children named `tag`, in source order. */
  list(tag: string): XmlElement[];
  /** Direct children whose name is in `tags`, in source order (interleaving preserved). */
  inOrder(tags: readonly string[]): XmlElement[];
}

function warnUnknownElement(issues: IssueCollector, el: XmlElement, voucherIndex: number | null): void {
  issues.add({
    code: 'UNKNOWN_ELEMENT',
    message: `<${el.name}> is not part of the normalized contract; it is retained in the raw upload but was not normalized`,
    voucherIndex,
    path: el.path,
    details: { element: el.name },
  });
}

function readNode(
  el: XmlElement,
  spec: NodeSpec,
  issues: IssueCollector,
  voucherIndex: number | null,
): NodeReader {
  const scalars = new Map<string, XmlElement>();
  const listTags = new Set(spec.lists ?? []);
  const scalarTags = new Set(spec.scalars);

  for (const child of el.children) {
    if (scalarTags.has(child.name)) {
      if (scalars.has(child.name)) {
        issues.add({
          code: 'DUPLICATE_SCALAR_ELEMENT',
          message: `<${child.name}> appears more than once under one parent; the first occurrence was used`,
          voucherIndex,
          path: child.path,
          details: { element: child.name, ignoredValue: child.text },
        });
      } else {
        scalars.set(child.name, child);
      }
      // A scalar should not contain elements; report rather than silently ignore them.
      for (const grandchild of child.children) warnUnknownElement(issues, grandchild, voucherIndex);
    } else if (!listTags.has(child.name)) {
      warnUnknownElement(issues, child, voucherIndex);
    }
  }

  if (el.text.trim() !== '') {
    issues.add({
      code: 'UNEXPECTED_TEXT',
      message: `<${el.name}> contains text directly; it is retained in the raw upload but was not normalized`,
      voucherIndex,
      path: el.path,
    });
  }

  const knownAttributes = new Set(spec.attributes ?? []);
  for (const name of Object.keys(el.attributes)) {
    if (!knownAttributes.has(name)) {
      issues.add({
        code: 'UNKNOWN_ATTRIBUTE',
        message: `Attribute ${name} on <${el.name}> is retained in the raw upload but was not normalized`,
        voucherIndex,
        path: `${el.path}/@${name}`,
        details: { attribute: name },
      });
    }
  }

  return {
    // Values are returned exactly as written (no trimming): they are lossless source text.
    scalar: (tag) => scalars.get(tag)?.text ?? null,
    list: (tag) => el.children.filter((c) => c.name === tag),
    inOrder: (tags) => el.children.filter((c) => tags.includes(c.name)),
  };
}

// ---------------------------------------------------------------------------------------
// Voucher subtree
// ---------------------------------------------------------------------------------------

const LEDGER_TAGS: readonly LedgerSourceTag[] = ['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST'];

class VoucherNormalizer {
  constructor(
    private readonly issues: IssueCollector,
    private readonly voucherIndex: number,
  ) {}

  private read(el: XmlElement, spec: NodeSpec): NodeReader {
    return readNode(el, spec, this.issues, this.voucherIndex);
  }

  voucher(el: XmlElement): ParsedVoucher {
    const n = this.read(el, {
      scalars: ['DATE', 'VOUCHERTYPENAME', 'VOUCHERNUMBER', 'PARTYLEDGERNAME', 'NARRATION'],
      lists: [...LEDGER_TAGS, 'ALLINVENTORYENTRIES.LIST'],
      attributes: ['VCHTYPE', 'ACTION'],
    });

    const attributes: VoucherAttributes = {};
    if (el.attributes.VCHTYPE !== undefined) attributes.VCHTYPE = el.attributes.VCHTYPE;
    if (el.attributes.ACTION !== undefined) attributes.ACTION = el.attributes.ACTION;

    return {
      voucherIndex: this.voucherIndex,
      attributes,
      date: n.scalar('DATE'),
      voucherType: n.scalar('VOUCHERTYPENAME'),
      voucherNumber: n.scalar('VOUCHERNUMBER'),
      partyLedgerName: n.scalar('PARTYLEDGERNAME'),
      narration: n.scalar('NARRATION'),
      ledgerEntries: n.inOrder(LEDGER_TAGS).map((c) => this.ledgerEntry(c)),
      inventoryEntries: n.list('ALLINVENTORYENTRIES.LIST').map((c) => this.inventoryEntry(c)),
    };
  }

  private ledgerEntry(el: XmlElement): LedgerEntry {
    const n = this.read(el, {
      scalars: ['LEDGERNAME', 'ISDEEMEDPOSITIVE', 'AMOUNT'],
      lists: ['BILLALLOCATIONS.LIST', 'BANKALLOCATIONS.LIST', 'RATEDETAILS.LIST'],
    });
    return {
      sourceTag: el.name as LedgerSourceTag,
      ledgerName: n.scalar('LEDGERNAME'),
      isDeemedPositive: n.scalar('ISDEEMEDPOSITIVE'),
      amount: n.scalar('AMOUNT'),
      billAllocations: n.list('BILLALLOCATIONS.LIST').map((c) => this.billAllocation(c)),
      bankAllocations: n.list('BANKALLOCATIONS.LIST').map((c) => this.bankAllocation(c)),
      rateDetails: n.list('RATEDETAILS.LIST').map((c) => this.rateDetail(c)),
    };
  }

  private billAllocation(el: XmlElement): BillAllocation {
    const n = this.read(el, { scalars: ['NAME', 'BILLTYPE', 'AMOUNT'] });
    return { name: n.scalar('NAME'), billType: n.scalar('BILLTYPE'), amount: n.scalar('AMOUNT') };
  }

  private bankAllocation(el: XmlElement): BankAllocation {
    const n = this.read(el, { scalars: ['DATE', 'NAME', 'TRANSACTIONTYPE', 'AMOUNT'] });
    return {
      date: n.scalar('DATE'),
      name: n.scalar('NAME'),
      transactionType: n.scalar('TRANSACTIONTYPE'),
      amount: n.scalar('AMOUNT'),
    };
  }

  private inventoryEntry(el: XmlElement): InventoryEntry {
    const n = this.read(el, {
      scalars: ['STOCKITEMNAME', 'ISDEEMEDPOSITIVE', 'ACTUALQTY', 'BILLEDQTY', 'RATE', 'AMOUNT'],
      lists: ['BATCHALLOCATIONS.LIST', 'ACCOUNTINGALLOCATIONS.LIST', 'RATEDETAILS.LIST'],
    });
    return {
      sourceTag: 'ALLINVENTORYENTRIES.LIST',
      stockItemName: n.scalar('STOCKITEMNAME'),
      isDeemedPositive: n.scalar('ISDEEMEDPOSITIVE'),
      actualQty: n.scalar('ACTUALQTY'),
      billedQty: n.scalar('BILLEDQTY'),
      rate: n.scalar('RATE'),
      amount: n.scalar('AMOUNT'),
      batchAllocations: n.list('BATCHALLOCATIONS.LIST').map((c) => this.batchAllocation(c)),
      accountingAllocations: n.list('ACCOUNTINGALLOCATIONS.LIST').map((c) => this.accountingAllocation(c)),
      rateDetails: n.list('RATEDETAILS.LIST').map((c) => this.rateDetail(c)),
    };
  }

  private batchAllocation(el: XmlElement): BatchAllocation {
    const n = this.read(el, { scalars: ['GODOWNNAME', 'BATCHNAME', 'ACTUALQTY', 'BILLEDQTY', 'AMOUNT'] });
    return {
      godownName: n.scalar('GODOWNNAME'),
      batchName: n.scalar('BATCHNAME'),
      actualQty: n.scalar('ACTUALQTY'),
      billedQty: n.scalar('BILLEDQTY'),
      amount: n.scalar('AMOUNT'),
    };
  }

  private accountingAllocation(el: XmlElement): AccountingAllocation {
    const n = this.read(el, {
      scalars: ['LEDGERNAME', 'ISDEEMEDPOSITIVE', 'AMOUNT'],
      lists: ['RATEDETAILS.LIST'],
    });
    return {
      ledgerName: n.scalar('LEDGERNAME'),
      isDeemedPositive: n.scalar('ISDEEMEDPOSITIVE'),
      amount: n.scalar('AMOUNT'),
      rateDetails: n.list('RATEDETAILS.LIST').map((c) => this.rateDetail(c)),
    };
  }

  private rateDetail(el: XmlElement): RateDetail {
    const n = this.read(el, { scalars: ['GSTRATEDUTYHEAD', 'GSTRATE'] });
    return { dutyHead: n.scalar('GSTRATEDUTYHEAD'), rate: n.scalar('GSTRATE') };
  }
}

export function normalizeVoucher(el: XmlElement, voucherIndex: number, issues: IssueCollector): ParsedVoucher {
  return new VoucherNormalizer(issues, voucherIndex).voucher(el);
}

/** Fields whose absence makes a voucher unusable (optional partial-failure extension). */
export function missingRequiredFields(v: ParsedVoucher): string[] {
  const missing: string[] = [];
  if (v.date === null || v.date.trim() === '') missing.push('DATE');
  if (v.voucherType === null || v.voucherType.trim() === '') missing.push('VOUCHERTYPENAME');
  if (v.voucherNumber === null || v.voucherNumber.trim() === '') missing.push('VOUCHERNUMBER');
  return missing;
}

// ---------------------------------------------------------------------------------------
// Document level (everything outside vouchers)
// ---------------------------------------------------------------------------------------

const COUNTER_TAGS = ['CREATED', 'ALTERED', 'DELETED', 'IGNORED', 'ERRORS'] as const;

/**
 * Interprets Tally's operation result. Applies the exercise rule:
 * `failed` when ERRORS > 0 or any LINEERROR is non-empty, otherwise `succeeded`.
 * A non-numeric ERRORS value is treated as `failed` (fail safe) and warned about.
 */
function interpretTallyResponse(
  el: XmlElement,
  sourceElement: TallyResponseResult['sourceElement'],
  issues: IssueCollector,
): TallyResponseResult {
  // LINEERROR is a list: Tally can report one line per failed object.
  const n = readNode(el, { scalars: COUNTER_TAGS, lists: ['LINEERROR'] }, issues, null);

  const counters = {} as TallyCounters;
  for (const tag of COUNTER_TAGS) counters[tag] = n.scalar(tag);

  let failedByCounter = false;
  for (const tag of COUNTER_TAGS) {
    const value = counters[tag];
    if (value === null) continue;
    if (!/^\s*\d+\s*$/.test(value)) {
      issues.add({
        code: 'NON_NUMERIC_RESPONSE_COUNTER',
        message: `Tally counter ${tag} is not a non-negative integer`,
        path: `${el.path}/${tag}`,
        details: { counter: tag, value },
      });
      if (tag === 'ERRORS') failedByCounter = true;
    } else if (tag === 'ERRORS' && BigInt(value.trim()) > 0n) {
      failedByCounter = true;
    }
  }

  const lineErrors = n.list('LINEERROR').map((e) => e.text);
  const lineError = lineErrors.find((t) => t.trim() !== '') ?? null;

  return {
    businessStatus: failedByCounter || lineError !== null ? 'failed' : 'succeeded',
    sourceElement,
    counters,
    lineError,
    lineErrors,
  };
}

export interface DocumentInterpretation {
  documentType: DocumentType;
  tallyResponse: TallyResponseResult | null;
}

/**
 * Validates the envelope skeleton and decides the document type.
 *
 * Supported shapes:
 *   RESPONSE                                -> tallyResponse
 *   ENVELOPE/BODY/DATA/COLLECTION/VOUCHER   -> voucherExport
 *   ENVELOPE/BODY/DATA/IMPORTRESULT         -> tallyResponse (optional extension 5)
 * HEADER and BODY/DESC are envelope metadata: retained in the raw upload, not normalized,
 * and not warned about because they carry no accounting data.
 */
export function interpretDocument(root: XmlElement, issues: IssueCollector): DocumentInterpretation {
  if (root.name === 'RESPONSE') {
    return { documentType: 'tallyResponse', tallyResponse: interpretTallyResponse(root, 'RESPONSE', issues) };
  }

  const unsupported = (): never => {
    throw new DocumentError(
      'UNSUPPORTED_DOCUMENT',
      'ENVELOPE must contain BODY/DATA/COLLECTION (voucher export) or BODY/DATA/IMPORTRESULT (import result)',
    );
  };

  // Containers are declared as `lists` so their children are not inspected at this level;
  // HEADER and DESC are never descended into.
  readNode(root, { scalars: [], lists: ['HEADER', 'BODY'] }, issues, null);
  const body = root.children.find((c) => c.name === 'BODY') ?? unsupported();
  readNode(body, { scalars: [], lists: ['DESC', 'DATA'] }, issues, null);
  const data = body.children.find((c) => c.name === 'DATA') ?? unsupported();

  const collections = data.children.filter((c) => c.name === 'COLLECTION');
  const importResult = data.children.find((c) => c.name === 'IMPORTRESULT');

  if (collections.length > 0) {
    readNode(data, { scalars: [], lists: ['COLLECTION'] }, issues, null);
    // Vouchers were detached by the tree builder; whatever remains is not normalized.
    for (const collection of collections) readNode(collection, { scalars: [] }, issues, null);
    return { documentType: 'voucherExport', tallyResponse: null };
  }

  if (importResult) {
    readNode(data, { scalars: [], lists: ['IMPORTRESULT'] }, issues, null);
    return {
      documentType: 'tallyResponse',
      // Real IMPORTRESULT blocks also carry LASTVCHID, LASTMID, COMBINED, CANCELLED,
      // EXCEPTIONS; they are reported as not-normalized like any other unknown child.
      tallyResponse: interpretTallyResponse(importResult, 'IMPORTRESULT', issues),
    };
  }

  return unsupported();
}
