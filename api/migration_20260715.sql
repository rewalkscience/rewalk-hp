-- 2026-07-15 機能追加マイグレーション
-- 複数開催日・複数アーカイブ動画・配布資料・カルーセル表示順・複数日リマインド対応
ALTER TABLE seminars ADD COLUMN session_dates TEXT;
ALTER TABLE seminars ADD COLUMN archive_videos TEXT;
ALTER TABLE seminars ADD COLUMN materials TEXT;
ALTER TABLE seminars ADD COLUMN display_order INTEGER;
ALTER TABLE enrollments ADD COLUMN reminder_sent_dates TEXT;
