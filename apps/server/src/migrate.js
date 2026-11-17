'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(__dirname, '../../../.env') });

async function main() {
  const dbName = process.env.DB_NAME || 'digitalbotsclients';
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error('DB_NAME may contain only letters, numbers and underscores.');
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    charset: 'utf8mb4'
  };
  if (!config.user) throw new Error('DB_USER is missing. Copy .env.example to .env and configure MySQL.');
  const connection = await mysql.createConnection(config);
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.changeUser({ database: dbName });
    await connection.query(`CREATE TABLE IF NOT EXISTS _migrations (
      name VARCHAR(190) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      const [[existing]] = await connection.query('SELECT name FROM _migrations WHERE name = ?', [file]);
      if (existing) {
        console.log(`Already applied: ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`Applying: ${file}`);
      await connection.query(sql);
      await connection.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
      console.log(`Applied: ${file}`);
    }
    console.log(`Database ready: ${dbName}`);
  } finally {
    await connection.end();
  }
}
main().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
