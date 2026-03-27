import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;
try {
  db = new Database(join(__dirname, 'portfolio.db'), { timeout: 5000 });

  db.pragma('journal_mode = WAL');

  db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT    NOT NULL,
    quantity      REAL    NOT NULL,
    buyPrice      REAL    NOT NULL,
    portfolioType TEXT    NOT NULL CHECK(portfolioType IN ('paper', 'real'))
  )
`);
} catch (err) {
  if (err.code === 'SQLITE_BUSY' || (err.message && err.message.includes('database is locked'))) {
    console.error('[PSX] Database is locked — another PSX Terminal process may be running.');
    console.error('[PSX] Kill the existing node process then retry.');
  } else {
    console.error(`[PSX] Failed to open database: ${err.message}`);
  }
  process.exit(1);
}

export default db;
