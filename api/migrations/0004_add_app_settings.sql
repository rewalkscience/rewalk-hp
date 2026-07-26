-- サイト全体の設定値を保存する汎用キーバリューテーブル（LINEウェルカムメッセージなど、セミナーに紐付かない設定用）
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
