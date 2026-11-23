import { DocumentError } from '../errors';
import type { ImportIssue } from '../ingest/types';

/**
 * Byte -> text decoding for uploaded XML.
 *
 * Detection order follows XML 1.0 Appendix F:
 *   1. Byte order mark (UTF-8, UTF-16LE, UTF-16BE). UTF-32 is rejected explicitly.
 *   2. BOM-less UTF-16, recognised from the `<?` byte pattern.
 *   3. For ASCII-compatible bytes, the `encoding="..."` pseudo-attribute of the XML
 *      declaration; no declaration means UTF-8.
 *
 * Decoding is *fatal*: an invalid byte sequence fails the import instead of silently
 * inserting U+FFFD into accounting data.
 */
export interface DecodedDocument {
  text: string;
  /** Canonical name of the encoding used, e.g. `UTF-8`, `UTF-16LE`. */
  detectedEncoding: string;
  bomPresent: boolean;
  /** Encoding named in the XML declaration, if any (as written in the source). */
  declaredEncoding: string | null;
  issues: ImportIssue[];
}

const DECL_ENCODING = /^<\?xml\s[^>]*?encoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/;

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

function decode(bytes: Uint8Array, label: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    throw new DocumentError('UNSUPPORTED_ENCODING', `Unsupported character encoding "${label}"`, {
      encoding: label,
    });
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new DocumentError(
      'INVALID_ENCODING',
      `The document contains byte sequences that are not valid ${decoder.encoding.toUpperCase()}`,
      { encoding: decoder.encoding.toUpperCase() },
    );
  }
}

function canonicalName(label: string): string {
  // TextDecoder normalises labels (e.g. "utf8" -> "utf-8", "latin1" -> "windows-1252").
  return new TextDecoder(label).encoding.toUpperCase();
}

function isUtf16Label(label: string): boolean {
  return /^(utf-?16(le|be)?|ucs-?2|iso-10646-ucs-2|unicode)$/i.test(label);
}

/** Comparable encoding family: all UTF-16 variants are one family; others use WHATWG names. */
function family(label: string): string {
  if (isUtf16Label(label)) return 'UTF-16';
  try {
    return canonicalName(label);
  } catch {
    return label.toUpperCase();
  }
}

export function decodeXmlBytes(input: Uint8Array): DecodedDocument {
  const bytes = input;
  let label: string;
  let bomPresent = false;

  if (startsWith(bytes, [0x00, 0x00, 0xfe, 0xff]) || startsWith(bytes, [0xff, 0xfe, 0x00, 0x00])) {
    throw new DocumentError('UNSUPPORTED_ENCODING', 'UTF-32 encoded documents are not supported', {
      encoding: 'UTF-32',
    });
  } else if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    label = 'utf-8';
    bomPresent = true;
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    label = 'utf-16le';
    bomPresent = true;
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    label = 'utf-16be';
    bomPresent = true;
  } else if (startsWith(bytes, [0x3c, 0x00, 0x3f, 0x00])) {
    label = 'utf-16le';
  } else if (startsWith(bytes, [0x00, 0x3c, 0x00, 0x3f])) {
    label = 'utf-16be';
  } else {
    // ASCII-compatible: the declaration itself is readable as latin1.
    const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
    const declared = DECL_ENCODING.exec(head)?.[1];
    // A UTF-16 declaration on ASCII-compatible bytes cannot be true; decode by the bytes.
    label = declared && !isUtf16Label(declared) ? declared : 'utf-8';
  }

  // TextDecoder strips a BOM that matches the decoder's encoding.
  const text = decode(bytes, label);
  const detectedEncoding = canonicalName(label);
  const declaredEncoding = DECL_ENCODING.exec(text.slice(0, 1024))?.[1] ?? null;

  const issues: ImportIssue[] = [];
  if (declaredEncoding && family(declaredEncoding) !== family(detectedEncoding)) {
    issues.push({
      severity: 'warning',
      code: 'ENCODING_DECLARATION_MISMATCH',
      message: `XML declaration says "${declaredEncoding}" but the bytes were decoded as ${detectedEncoding}`,
      voucherIndex: null,
      path: null,
      occurrences: 1,
      details: { declaredEncoding, detectedEncoding, bomPresent },
    });
  }

  return { text, detectedEncoding, bomPresent, declaredEncoding, issues };
}
