const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'rahat.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  weight TEXT,
  kcal INTEGER,
  price INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'salads',
  is_dish_of_day INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  in_stock INTEGER NOT NULL DEFAULT 1,
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  table_number TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  commission_rate REAL NOT NULL,
  commission_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  dine_type TEXT NOT NULL DEFAULT 'dine_in',
  payment_method TEXT NOT NULL DEFAULT 'sbp',
  bank TEXT,
  yk_payment_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE TABLE IF NOT EXISTS waiter_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_number TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// migrate older databases created before these columns existed
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`).run();
  }
}
ensureColumn('menu_items', 'in_stock', `INTEGER NOT NULL DEFAULT 1`);
ensureColumn('menu_items', 'image_url', `TEXT`);
ensureColumn('orders', 'dine_type', `TEXT NOT NULL DEFAULT 'dine_in'`);
ensureColumn('orders', 'payment_method', `TEXT NOT NULL DEFAULT 'sbp'`);
ensureColumn('orders', 'yk_payment_id', `TEXT`);

// default commission rate, editable via /api/owner/settings
const existingRate = db.prepare(`SELECT value FROM settings WHERE key = 'commission_rate'`).get();
if (!existingRate) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('commission_rate', '0.04')`).run();
}

module.exports = db;
