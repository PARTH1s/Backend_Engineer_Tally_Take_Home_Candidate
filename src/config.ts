/**
 * Runtime configuration, read once from environment variables.
 *
 * Every value has a safe default so `docker compose up` works without a .env file.
 * Invalid values fail fast at startup instead of surfacing later as odd behaviour.
 */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Upload limit in bytes. Requests above this are rejected with HTTP 413. */
  maxUploadBytes: number;
  /** Maximum XML element nesting depth. Guards against pathological documents. */
  maxXmlDepth: number;
  /** Node HTTP server request timeout in milliseconds. */
  requestTimeoutMs: number;
  logLevel: string;
}

/**
 * Version of the decode/parse/normalize pipeline. It is stored on every import so an
 * operator can tell which parser produced a given set of rows (useful after parser fixes).
 */
export const PARSER_VERSION = '1.0.0';

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`Invalid configuration: ${name} must be an integer >= ${min}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readInt(env, 'PORT', 3000, 0),
    databaseUrl: env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally',
    maxUploadBytes: readInt(env, 'MAX_UPLOAD_BYTES', 10 * 1024 * 1024, 1),
    maxXmlDepth: readInt(env, 'MAX_XML_DEPTH', 64, 8),
    requestTimeoutMs: readInt(env, 'REQUEST_TIMEOUT_MS', 30_000, 1_000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
