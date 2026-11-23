import type { IssueCode } from './ingest/types';

/**
 * The uploaded bytes cannot be safely processed (bad encoding, malformed XML, DTD,
 * unsupported root...). This is deterministic for given bytes, so the import is persisted
 * with `status: failed` for traceability and the client receives a structured 422.
 */
export class DocumentError extends Error {
  constructor(
    public readonly code: IssueCode,
    message: string,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

/**
 * A problem with the HTTP request itself (missing file, too large, unknown id...).
 * Nothing is persisted. `message` is always safe to show to clients.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
