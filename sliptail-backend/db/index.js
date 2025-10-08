// db.js (or wherever you create the Pool)
const { Pool } = require('pg');

// prefer DB_* but fall back to PG* if present
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST,
  port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  user: process.env.DB_USER || process.env.PGUSER,
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
  database: process.env.DB_NAME || process.env.PGDATABASE,

  // RDS/Lightsail typically need SSL
  ssl: {
    rejectUnauthorized: false, // skip CA validation; easy + works with RDS
  },
});

module.exports = pool;
