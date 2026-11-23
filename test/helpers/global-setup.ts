import { migrate } from '../../src/db/migrate';
import { createPool } from '../../src/db/pool';
import { testDatabaseUrl } from './env';

export default async function setup(): Promise<void> {
  const pool = createPool(testDatabaseUrl());
  try {
    await migrate(pool);
  } catch (err) {
    throw new Error(
      `Could not migrate the test database. Is Postgres running? Start it with "docker compose up -d db".\n${String(err)}`,
    );
  } finally {
    await pool.end();
  }
}
