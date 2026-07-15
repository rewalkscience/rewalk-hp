-- ユーザー
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
  name TEXT,
  affiliation TEXT,
  line_user_id TEXT,
  password_reset_token TEXT,  -- パスワード再設定トークンのハッシュ値
  password_reset_expires_at TEXT,  -- トークンの有効期限
  pending_email TEXT,  -- 変更先メールアドレス（確認待ち）
  email_change_token TEXT,  -- メールアドレス変更確認トークンのハッシュ値
  email_change_expires_at TEXT,  -- 変更トークンの有効期限
  profession TEXT,  -- 職種（申込フォームで収集）
  experience_years TEXT,  -- 経験年数（申込フォームで収集）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- セミナー
CREATE TABLE IF NOT EXISTS seminars (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL,
  session_dates TEXT,  -- 追加開催日のJSON配列（セットセミナー用。dateが第1回、以降はここに）
  location TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'online',  -- 'online' | 'offline'
  price INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 20,  -- 0 = 定員無制限
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
  archive_videos TEXT,  -- 追加アーカイブ動画のJSON配列 [{label, url}]（archive_video_urlがメイン）
  materials TEXT,  -- 配布資料のJSON配列 [{label, url}]（Googleドライブリンク等。申込者のみ閲覧可）
  archive_expires_at TEXT,
  display_order INTEGER,  -- トップページカルーセルの表示順（NULLは末尾・開催日順）
  external_apply_url TEXT,  -- 設定時は申込ボタンがこのURL（Peatix/Xpert等）へ直接リンクし、内部決済フローをバイパスする
  enrollment_notify_scheduled_at TEXT,  -- 管理者が「受付開始お知らせ」を予約した日時
  enrollment_notify_sent_at TEXT,  -- 受付開始お知らせメールを実際に送信した日時（重複送信防止）
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
  participation_type TEXT,  -- 'onsite' | 'online'（format='hybrid'のみ使用）
  reminder_sent_at TEXT,  -- 開催3日前リマインドメールの送信済み時刻
  reminder_sent_dates TEXT,  -- リマインド送信済みの開催日JSON配列（複数開催日対応）
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
