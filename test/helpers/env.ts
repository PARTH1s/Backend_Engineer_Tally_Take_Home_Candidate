/**
 * The test suite TRUNCATES tables, so it refuses to run against a database whose name does
 * not contain "test". Default: the tally_test database created by docker compose.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally_test';
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run tests against database "${dbName}": its name must contain "test"`);
  }
  return url;
}
