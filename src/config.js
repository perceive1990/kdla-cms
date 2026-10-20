'use strict';
require('dotenv').config({ quiet: true });

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const config = {
  isProd,
  port: num(env.PORT, 3000),
  orgName: env.ORG_NAME || 'KDLA',
  orgFullName: env.ORG_FULL_NAME || 'Kitwe District Land Alliance',
  appName: env.APP_NAME || 'KDLA Case Management System',
  orgAddress: env.ORG_ADDRESS || 'Kitwe, Zambia',
  orgContact: env.ORG_CONTACT || '',
  displayTimeZone: env.DISPLAY_TIMEZONE || 'Africa/Lusaka',

  sessionSecret: env.SESSION_SECRET || (isProd ? null : 'dev-only-secret-change-me'),
  // Log out after this many minutes without activity, and always after sessionMaxHours.
  sessionIdleMinutes: num(env.SESSION_IDLE_MINUTES, 60),
  sessionMaxHours: num(env.SESSION_MAX_HOURS, 12),

  // Login protection: lock an account for lockMinutes after loginMaxFailures wrong passwords.
  loginMaxFailures: num(env.LOGIN_MAX_FAILURES, 5),
  lockMinutes: num(env.LOCK_MINUTES, 15),
  // Two-step verification policy: "none" (optional for everyone), "admins" or "all".
  require2fa: ['none', 'admins', 'all'].includes(env.REQUIRE_2FA) ? env.REQUIRE_2FA : 'none',

  // Audit trail entries are deleted automatically after this many days (0 = keep forever).
  auditRetentionDays: num(env.AUDIT_RETENTION_DAYS, 1095),

  // "cosmos" for Azure, "memory" for local development and tests.
  dbDriver: (env.DB_DRIVER || (env.COSMOS_ENDPOINT || env.COSMOS_CONNECTION_STRING ? 'cosmos' : 'memory')).toLowerCase(),
  memoryDbFile: env.MEMORY_DB_FILE || '',

  cosmos: {
    connectionString: env.COSMOS_CONNECTION_STRING || '',
    endpoint: env.COSMOS_ENDPOINT || '',
    key: env.COSMOS_KEY || '',
    database: env.COSMOS_DATABASE || 'kdla-cms',
    // Shared database throughput. 1000 RU/s is the whole Cosmos DB free tier allowance.
    // Set to 0 for a serverless account (throughput must then be omitted).
    throughput: num(env.COSMOS_THROUGHPUT, 1000),
  },

  storage: {
    blobConnectionString: env.AZURE_STORAGE_CONNECTION_STRING || '',
    blobContainer: env.AZURE_STORAGE_CONTAINER || 'case-files',
    uploadDir: env.UPLOAD_DIR || (env.WEBSITE_SITE_NAME ? '/home/data/uploads' : './data/uploads'),
    maxFileMb: num(env.MAX_UPLOAD_MB, 10),
  },

  bootstrapAdmin: {
    username: env.ADMIN_USERNAME || '',
    password: env.ADMIN_PASSWORD || '',
  },

  pageSize: num(env.PAGE_SIZE, 25),

  // JSON REST API at /api/v1 for other systems, scripts, Power BI and mobile apps.
  api: {
    enabled: env.API_ENABLED !== 'false',
    // Tokens from POST /api/v1/auth/login expire after this many hours.
    tokenHours: num(env.API_TOKEN_HOURS, 12),
    // Longest life a staff member can give a personal access token (Account > API access).
    personalTokenMaxDays: num(env.API_PERSONAL_TOKEN_MAX_DAYS, 365),
    // Requests per minute for each token, so one script cannot use up the database allowance.
    rateLimitPerMinute: num(env.API_RATE_LIMIT, 240),
    // Web sites allowed to call the API from a browser (comma separated), e.g. https://dashboard.example.org
    corsOrigins: String(env.API_CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  },
};

if (!config.sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production. Add it under App Service > Settings > Environment variables.');
}
if (isProd && config.sessionSecret.length < 32) {
  console.warn('Warning: SESSION_SECRET should be at least 32 random characters.');
}
// Guard against losing data: the in-memory database is wiped on every restart.
if (isProd && config.dbDriver === 'memory' && env.ALLOW_MEMORY_DB !== 'true') {
  throw new Error('No database configured. Set COSMOS_CONNECTION_STRING (and DB_DRIVER=cosmos) in production.');
}

module.exports = config;
