-- Masari bot — D1 schema (all money amounts are integer SYP)
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  name TEXT DEFAULT '',
  username TEXT DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0,
  referrer_id INTEGER,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- A task = ONE service card with a slot counter. slots_done counts APPROVED claims.
-- client_id NULL means the platform (admin) itself funds the task.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER,
  client_id INTEGER,
  title TEXT NOT NULL,
  instructions TEXT DEFAULT '',
  proof_type TEXT NOT NULL DEFAULT 'any',       -- photo | text | link | any
  price INTEGER NOT NULL DEFAULT 0,             -- what the client pays per execution
  pay INTEGER NOT NULL DEFAULT 0,               -- what the worker earns per approved execution
  slots_total INTEGER NOT NULL DEFAULT 1,
  slots_done INTEGER NOT NULL DEFAULT 0,
  reviewer TEXT NOT NULL DEFAULT 'admin',       -- admin | client
  status TEXT NOT NULL DEFAULT 'open',          -- open | closed
  deadline TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  worker_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',       -- claimed | submitted | approved | rejected
  proof_text TEXT DEFAULT '',
  proof_file TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER DEFAULT 0,
  reviewed_at INTEGER DEFAULT 0,
  UNIQUE(task_id, worker_id)
);

-- Raw service requests from clients, converted by admin into tasks.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',           -- new | converted | rejected
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  note TEXT DEFAULT '',                          -- txid / sender number, from the user
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  credited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  details TEXT DEFAULT '',                       -- where to send (address / number)
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- deposit | withdraw | earn | referral | escrow | refund | adjust
  amount INTEGER NOT NULL DEFAULT 0,             -- signed
  ref TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS forced_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_ref TEXT NOT NULL,                        -- @username or numeric chat id
  title TEXT DEFAULT '',
  link TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ref TEXT DEFAULT '',                           -- optional task/claim reference
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',           -- open | answered | closed
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Conversation state for multi-step wizards (one row per user).
CREATE TABLE IF NOT EXISTS ustate (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}'
);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('ref_worker_pct', '5'),
  ('ref_client_pct', '10'),
  ('min_withdraw', '25000'),
  ('auto_approve_days', '3'),
  ('welcome_text', 'أهلا فيك بـ مصاري 💸\nنفّذ مهام واجمع مصاريك، أو اطلب خدمة وخلي التنفيذ علينا.'),
  ('deposit_methods', '[]');
