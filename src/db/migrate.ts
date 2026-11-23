import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { createPool } from './pool';

/**
 * Minimal forward-only migration runner.
 *
 * - Applies `migrations/NNN_*.sql` in filename order, each in its own transaction.
 * - Records version + checksum in `schema_migrations`; an edited, already-applied file
 *   is reported as an error instead of being silently skipped or re-run.
 * - A Postgres advisory lock serialises concurrent runners (e.g. two app replicas starting).
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 727_001; // arbitrary, application-specific advisory lock id

export async function migrate(pool: Pool, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = done.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied; add a new migration instead`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

if (require.main === module) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  migrate(pool, (m) => console.log(m))
    .then((applied) => console.log(applied.length ? `migrations complete (${applied.length} applied)` : 'schema up to date'))
    .catch((err: unknown) => {
      console.error('migration failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
