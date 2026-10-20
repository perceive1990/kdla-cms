'use strict';
const config = require('./src/config');
const { getDb } = require('./src/db');
const { createApp } = require('./src/app');
const { runMigrations } = require('./src/migrations');
const { ensureBootstrapAdmin } = require('./scripts/lib');

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

async function main() {
  const db = getDb();
  await db.init();
  await runMigrations(db);
  await ensureBootstrapAdmin(db);
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`${config.appName} listening on port ${config.port} (db: ${config.dbDriver}, env: ${config.isProd ? 'production' : 'development'})`);
  });
  // App Service sends SIGTERM before restarting; finish requests in progress first.
  const stop = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start:', err && err.message ? err.message : err);
  process.exit(1);
});
