import pino, { type Logger } from 'pino';

/**
 * Structured JSON logs. Policy: log identifiers, sizes, hashes and counts; never request
 * bodies, raw XML, voucher contents or headers. `redact` is a second line of defence in
 * case an object with such fields is ever logged by mistake.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'tally-xml-ingestion' },
    redact: {
      paths: ['req.headers', 'req.body', 'file.buffer', 'bytes', 'xml', 'content', '*.authorization'],
      censor: '[redacted]',
    },
  });
}
