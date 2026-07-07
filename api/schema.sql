-- ユーザー
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
  name TEXT,
  affiliation TEXT,
  line_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- セミナー
CREATE TABLE IF NOT EXISTS seminars (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL,
  location TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'online',  -- 'online' | 'offline'
  price INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 20,
  enrolled_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'published' | 'closed'
  thumbnail_url TEXT,
  zoom_url TEXT,
  enrollment_start TEXT,
  enrollment_end TEXT,
  coupon_code TEXT,
  coupon_discount_type TEXT,  -- 'fixed' | 'percent'
  coupon_discount_value INTEGER,
  archive_video_url TEXT,
  archive_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 申込
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  seminar_id TEXT NOT NULL REFERENCES seminars(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'cancelled'
  stripe_session_id TEXT,
  amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(seminar_id, user_id)
);

-- アーカイブ動画
CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,
  seminar_id TEXT REFERENCES seminars(id),
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'published'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- アーカイブ購入
CREATE TABLE IF NOT EXISTS archive_purchases (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES archives(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid'
  stripe_session_id TEXT,
  amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(archive_id, user_id)
);
