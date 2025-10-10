// db.js (or wherever you create the Pool)
const { Pool } = require('pg');

// Decide whether to enable SSL based on env vars
// - Set DB_SSL=true (or 1) to force SSL
// - Or set PGSSLMODE=require (or verify-*) to force SSL
const shouldEnableSSL = (() => {
  const v = String(process.env.DB_SSL || '').toLowerCase();
  const m = String(process.env.PGSSLMODE || '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (['require', 'verify-ca', 'verify-full'].includes(m)) return true;
  return false;
})();

// Support connection string if provided
const connectionString = process.env.DATABASE_URL || process.env.DB_URL;

// prefer DB_* but fall back to PG* if present
const baseConfig = connectionString
  ? { connectionString }
  : {
      host: process.env.DB_HOST || process.env.PGHOST,
      port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
      user: process.env.DB_USER || process.env.PGUSER,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      database: process.env.DB_NAME || process.env.PGDATABASE,
    };

const pool = new Pool({
  ...baseConfig,
  ssl: shouldEnableSSL ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
