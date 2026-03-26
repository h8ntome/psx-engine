import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'portfolio.db'));

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

export default db;
