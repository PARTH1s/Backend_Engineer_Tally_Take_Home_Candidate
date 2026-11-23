import { loadConfig } from './config';
import { createPool } from './db/pool';
import { createApp } from './http/app';
import { createLogger } from './logger';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);

pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

const app = createApp({ pool, config, logger });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, maxUploadBytes: config.maxUploadBytes }, 'server listening');
});

// Bound slow clients: a request (headers + body) must complete within the timeout.
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = Math.min(config.requestTimeoutMs, 20_000);

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  // Do not hang forever on stuck connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
