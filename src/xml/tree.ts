import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { DocumentError } from '../errors';
import type { ImportIssue } from '../ingest/types';
import type { SanitizedText } from './sanitize';

/**
 * Minimal, order-preserving XML element tree built from SAX events.
 *
 * Why not a generic XML-to-object library? Those typically collapse repeated tags,
 * turn single occurrences into scalars, merge attributes into children, or expand
 * entities. Here every element keeps its children as an ordered array and its own
 * direct text, so ownership questions ("whose AMOUNT is this?") are structural.
 */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text and CDATA of this element only (not descendants). */
  text: string;
  /** Human-readable source path, e.g. `VOUCHER[0]/ALLLEDGERENTRIES.LIST[1]/AMOUNT`. */
  path: string;
}

/** Path of the voucher element inside a voucher export. */
const VOUCHER_PATH = ['ENVELOPE', 'BODY', 'DATA', 'COLLECTION', 'VOUCHER'];
export const SUPPORTED_ROOTS = new Set(['ENVELOPE', 'RESPONSE']);

export interface ParseOptions {
  maxDepth: number;
  /**
   * Called once per voucher as soon as its closing tag is read. The voucher subtree is
   * then detached from the document tree, so only one voucher is materialised at a time.
   * This is the object boundary a streaming implementation would also use.
   */
  onVoucher: (voucher: XmlElement, voucherIndex: number) => void;
}

export interface ParseResult {
  /** Document tree without voucher subtrees (those went to `onVoucher`). */
  root: XmlElement;
  voucherCount: number;
  /** Warnings for characters removed by sanitization, attributed to their element. */
  sanitizationIssues: ImportIssue[];
}

interface Frame {
  element: XmlElement;
  /** Count of children seen so far, per child name (for path indices). */
  childCounts: Map<string, number>;
  /** Index of the enclosing voucher, or null outside vouchers. */
  voucherIndex: number | null;
  isVoucher: boolean;
}

/** Repeated collection elements always show an index; scalars only when duplicated. */
function segment(name: string, siblingIndex: number, voucherIndex: number | null, isVoucher: boolean): string {
  if (isVoucher) return `VOUCHER[${voucherIndex}]`;
  if (name.endsWith('.LIST') || siblingIndex > 0) return `${name}[${siblingIndex}]`;
  return name;
}

function isVoucherPath(stack: Frame[], name: string): boolean {
  if (stack.length !== VOUCHER_PATH.length - 1) return false;
  for (let i = 0; i < stack.length; i++) {
    if (stack[i]!.element.name !== VOUCHER_PATH[i]) return false;
  }
  return name === VOUCHER_PATH[VOUCHER_PATH.length - 1];
}

export function parseXmlTree(input: SanitizedText, options: ParseOptions): ParseResult {
  const { marker, removals } = input;
  const parser = new SaxesParser<{}>({ xmlns: false, position: true });
  const stack: Frame[] = [];
  const sanitizationIssues: ImportIssue[] = [];
  let removalCursor = 0;
  let root: XmlElement | null = null;
  let voucherCount = 0;
  let failure: DocumentError | null = null;

  /** Strips sanitization markers from `value`, consuming removals in document order. */
  const takeMarkers = (value: string): { value: string; removed: string[] } => {
    if (marker === null || !value.includes(marker)) return { value, removed: [] };
    const parts = value.split(marker);
    const count = parts.length - 1;
    const removed = removals.slice(removalCursor, removalCursor + count).map((r) => r.original);
    removalCursor += count;
    return { value: parts.join(''), removed };
  };

  const recordRemoval = (frame: Frame | undefined, removed: string[], attribute?: string): void => {
    if (removed.length === 0) return;
    const path = frame ? frame.element.path + (attribute ? `/@${attribute}` : '') : null;
    sanitizationIssues.push({
      severity: 'warning',
      code: 'ILLEGAL_XML_CHARACTERS_REMOVED',
      message:
        `Removed ${removed.length} character(s) that are illegal in XML 1.0 (${removed.join(', ')}). ` +
        'The original bytes are retained with the import.',
      voucherIndex: frame?.voucherIndex ?? null,
      path,
      occurrences: 1,
      details: { removed },
    });
  };

  const fail = (error: DocumentError): never => {
    failure = error;
    throw error;
  };

  parser.on('error', (err: Error) => {
    fail(new DocumentError('MALFORMED_XML', `The document is not well-formed XML: ${err.message}`));
  });

  parser.on('doctype', () => {
    // Rejecting DTDs outright removes entity expansion ("billion laughs") and external
    // entity (XXE) attacks. Tally exports never need a DTD.
    fail(new DocumentError('DTD_NOT_ALLOWED', 'Documents containing a DOCTYPE/DTD are not accepted'));
  });

  parser.on('opentag', (tag: SaxesTagPlain) => {
    const parent = stack[stack.length - 1];
    if (!parent && !SUPPORTED_ROOTS.has(tag.name)) {
      fail(
        new DocumentError(
          'UNSUPPORTED_DOCUMENT',
          `Unsupported root element <${tag.name}>; expected <ENVELOPE> or <RESPONSE>`,
          { rootElement: tag.name },
        ),
      );
    }
    if (stack.length >= options.maxDepth) {
      fail(new DocumentError('XML_TOO_DEEP', `XML nesting exceeds the limit of ${options.maxDepth} levels`));
    }

    const isVoucher = isVoucherPath(stack, tag.name);
    const voucherIndex = isVoucher ? voucherCount++ : (parent?.voucherIndex ?? null);
    const siblingIndex = parent ? (parent.childCounts.get(tag.name) ?? 0) : 0;
    parent?.childCounts.set(tag.name, siblingIndex + 1);

    const seg = segment(tag.name, siblingIndex, voucherIndex, isVoucher);
    // Paths restart at VOUCHER[n] so voucher-level warnings are short and self-contained.
    const path = isVoucher || !parent ? seg : `${parent.element.path}/${seg}`;

    const element: XmlElement = { name: tag.name, attributes: {}, children: [], text: '', path };
    const frame: Frame = { element, childCounts: new Map(), voucherIndex, isVoucher };

    for (const [attrName, rawValue] of Object.entries(tag.attributes)) {
      const { value, removed } = takeMarkers(rawValue);
      element.attributes[attrName] = value;
      recordRemoval(frame, removed, attrName);
    }

    if (parent) parent.element.children.push(element);
    else root = element;
    stack.push(frame);
  });

  const onText = (raw: string): void => {
    const frame = stack[stack.length - 1];
    const { value, removed } = takeMarkers(raw);
    if (frame) frame.element.text += value;
    recordRemoval(frame, removed);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  // Markers inside comments / processing instructions must still be consumed so that the
  // n-th marker keeps mapping to the n-th removal.
  parser.on('comment', (c: string) => void takeMarkers(c));
  parser.on('processinginstruction', (pi: { body: string }) => void takeMarkers(pi.body));

  parser.on('closetag', () => {
    const frame = stack.pop();
    if (!frame) return;
    if (frame.isVoucher && frame.voucherIndex !== null) {
      const parent = stack[stack.length - 1];
      parent?.element.children.pop(); // detach: the voucher is handed off, not retained
      options.onVoucher(frame.element, frame.voucherIndex);
    }
  });

  try {
    parser.write(input.text).close();
  } catch (err) {
    // Prefer the structured error raised by our handlers over whatever saxes rethrew.
    throw (failure as DocumentError | null) ?? err;
  }

  if (!root) {
    throw new DocumentError('MALFORMED_XML', 'The document does not contain a root element');
  }
  return { root, voucherCount, sanitizationIssues };
}
