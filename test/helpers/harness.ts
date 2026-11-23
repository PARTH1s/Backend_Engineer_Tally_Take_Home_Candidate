import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';
import { createPool } from '../../src/db/pool';
import { createApp } from '../../src/http/app';
import { testDatabaseUrl } from './env';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');

export function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

/** Builds an XML envelope around voucher markup, for focused test documents. */
export function envelope(vouchers: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><BODY><DATA><COLLECTION>${vouchers}</COLLECTION></DATA></BODY></ENVELOPE>`,
    'utf8',
  );
}

/**
 * Registers per-file hooks: one pool for the file, all tables truncated before each test.
 * Returns accessors so each test gets a fresh app with optional config overrides.
 */
export function useTestDatabase() {
  const pool: Pool = createPool(testDatabaseUrl());

  beforeEach(async () => {
    await pool.query('TRUNCATE tally_import RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  const app = (config: Partial<{ maxUploadBytes: number; maxXmlDepth: number }> = {}) =>
    createApp({
      pool,
      config: { maxUploadBytes: 1024 * 1024, maxXmlDepth: 64, ...config },
      logger: pino({ level: 'silent' }),
    });

  const upload = (bytes: Buffer, filename = 'upload.xml', config = {}) =>
    request(app(config)).post('/api/tally/imports').attach('file', bytes, { filename, contentType: 'application/xml' });

  return { pool, app, upload };
}
