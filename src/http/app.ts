import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from '../config';
import { HttpError } from '../errors';
import { findImportById, loadIssues, loadTallyResponse, loadVouchers } from '../ingest/repository';
import { ingestUpload } from '../ingest/service';
import { detailsJson, uploadJson, voucherJson } from './serialize';

export interface AppDeps {
  pool: Pool;
  config: Pick<AppConfig, 'maxUploadBytes' | 'maxXmlDepth'>;
  logger: Logger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Allowance for multipart boundaries/headers on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Keeps only a safe display name: no directories, no control characters, bounded length. */
export function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = path.win32.basename(path.posix.basename(name)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '' ? null : base.slice(0, 255);
}

function importIdParam(req: Request): string {
  const id = String(req.params.importId);
  // Unknown or malformed ids are both simply "not found"; never pass junk to a uuid cast.
  if (!UUID_RE.test(id)) throw new HttpError(404, 'IMPORT_NOT_FOUND', 'Import not found');
  return id.toLowerCase();
}

export function createApp({ pool, config, logger }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Log request metadata only: never bodies (accounting XML) or headers (credentials).
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, fieldSize: 1024, parts: 20 },
  });

  /**
   * Multer/busboy report malformed bodies as plain Errors ("Unexpected end of form").
   * Anything raised while reading the multipart body is a client problem: map it to 400.
   */
  const receiveFile: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (!err || err instanceof multer.MulterError) {
        next(err);
        return;
      }
      next(new HttpError(400, 'INVALID_MULTIPART', 'The multipart request could not be parsed'));
    });
  };

  /** Reject obviously oversized requests before reading the body at all. */
  const rejectLargeBodies: RequestHandler = (req, _res, next) => {
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > config.maxUploadBytes + MULTIPART_OVERHEAD_BYTES) {
      next(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Upload exceeds the limit of ${config.maxUploadBytes} bytes`));
      return;
    }
    next();
  };

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  /** Readiness: also verifies the database is reachable. */
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    }
  });

  app.post('/api/tally/imports', rejectLargeBodies, receiveFile, async (req, res) => {
    const file = req.file;
    if (!file) {
      throw new HttpError(400, 'FILE_REQUIRED', 'Send the XML as multipart/form-data in a field named "file"');
    }
    if (file.size === 0) throw new HttpError(400, 'EMPTY_FILE', 'The uploaded file is empty');

    const result = await ingestUpload(
      pool,
      { bytes: file.buffer, filename: safeFilename(file.originalname) },
      { maxXmlDepth: config.maxXmlDepth },
    );

    req.log.info(
      {
        importId: result.record.id,
        contentHash: result.record.contentHash,
        byteSize: file.size,
        duplicate: result.duplicate,
        status: result.record.status,
        summary: result.record.summary,
      },
      'tally import processed',
    );

    // 422: the bytes cannot be processed (persisted as `failed` for traceability).
    // 200: these exact bytes were imported before. 201: newly accepted content.
    const status = result.record.status === 'failed' ? 422 : result.duplicate ? 200 : 201;
    res.status(status).json(uploadJson(result.record, result.duplicate, result.failure));
  });

  app.get('/api/tally/imports/:importId', async (req, res) => {
    const record = await findImportById(pool, importIdParam(req));
    if (!record) throw new HttpError(404, 'IMPORT_NOT_FOUND', 'Import not found');
    const [issues, tallyResponse] = await Promise.all([loadIssues(pool, record.id), loadTallyResponse(pool, record.id)]);
    res.json(detailsJson(record, issues, tallyResponse));
  });

  app.get('/api/tally/imports/:importId/vouchers', async (req, res) => {
    const record = await findImportById(pool, importIdParam(req));
    if (!record) throw new HttpError(404, 'IMPORT_NOT_FOUND', 'Import not found');
    const [vouchers, issues] = await Promise.all([loadVouchers(pool, record.id), loadIssues(pool, record.id)]);
    const items = vouchers.map((v) => voucherJson(record, v, issues));
    res.json({ items, count: items.length });
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found')));

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';

    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        status = 413;
        code = 'PAYLOAD_TOO_LARGE';
        message = `Upload exceeds the limit of ${config.maxUploadBytes} bytes`;
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        status = 400;
        code = 'UNEXPECTED_FIELD';
        message = 'Only one file is accepted, in the multipart field named "file"';
      } else {
        status = 400;
        code = 'INVALID_MULTIPART';
        message = 'The multipart request is invalid or exceeds request limits';
      }
    }

    if (status >= 500) req.log.error({ err }, 'request failed');
    else req.log.warn({ code }, 'request rejected');

    // Never include stack traces, SQL, or filesystem paths in responses.
    res.status(status).json({ error: { code, message, requestId: String(req.id) } });
  };
  app.use(errorHandler);

  return app;
}
