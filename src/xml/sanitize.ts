/**
 * Recovery for characters that XML 1.0 forbids but Tally is known to emit, e.g. `&#4;`.
 *
 * A strict parser rejects the whole document for one such reference. Instead we remove
 * them before parsing, but we do not do it silently: every removed character is replaced
 * by a *marker* character first. The tree builder strips the marker when it meets it in
 * text or attribute values and records exactly which element lost which reference, so
 * the warning can point at `VOUCHER[0]/NARRATION` rather than "somewhere in the file".
 *
 * The marker is a Private Use Area code point that does not occur anywhere in the
 * decoded document, so it can never be confused with real data.
 */

export interface Removal {
  /** `numericReference` for `&#4;`-style text, `rawCharacter` for a literal control char. */
  kind: 'numericReference' | 'rawCharacter';
  /** What was removed, e.g. `&#4;` or `U+0004`. */
  original: string;
}

export interface SanitizedText {
  text: string;
  /** Marker used for removed characters, or null when nothing was removed. */
  marker: string | null;
  /** Removals in document order; the n-th marker in the text is removals[n]. */
  removals: Removal[];
}

/** XML 1.0 `Char` production. */
export function isLegalXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

// Numeric character references (decimal / lowercase-x hex, as XML defines them) and
// literal characters that are illegal in XML 1.0 text.
const CANDIDATES = /&#(?:x([0-9A-Fa-f]{1,8})|([0-9]{1,10}));|[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function chooseMarker(text: string): string {
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) {
    const candidate = String.fromCharCode(cp);
    if (!text.includes(candidate)) return candidate;
  }
  // 6400 distinct PUA characters in one upload is not realistic; fail loudly if it happens.
  throw new Error('Unable to choose a sanitization marker');
}

function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function sanitizeIllegalXmlCharacters(text: string): SanitizedText {
  CANDIDATES.lastIndex = 0;
  if (!CANDIDATES.test(text)) return { text, marker: null, removals: [] };

  const marker = chooseMarker(text);
  const removals: Removal[] = [];
  CANDIDATES.lastIndex = 0;
  const sanitized = text.replace(CANDIDATES, (match: string, hex?: string, dec?: string) => {
    if (hex === undefined && dec === undefined) {
      removals.push({ kind: 'rawCharacter', original: formatCodePoint(match.charCodeAt(0)) });
      return marker;
    }
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
    if (isLegalXmlCodePoint(cp)) return match; // legal reference such as &#10; stays as-is
    removals.push({ kind: 'numericReference', original: match });
    return marker;
  });

  if (removals.length === 0) return { text, marker: null, removals: [] };
  return { text: sanitized, marker, removals };
}
