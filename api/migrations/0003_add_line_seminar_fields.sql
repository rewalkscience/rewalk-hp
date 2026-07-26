-- セミナーごとのLINE自動応答設定（初回登録者向けウェルカムメッセージ・合言葉クーポン）
ALTER TABLE seminars ADD COLUMN line_welcome_message TEXT;
ALTER TABLE seminars ADD COLUMN line_send_thumbnail INTEGER NOT NULL DEFAULT 1;
ALTER TABLE seminars ADD COLUMN line_keyword TEXT;
ALTER TABLE seminars ADD COLUMN line_keyword_reply TEXT;
ALTER TABLE seminars ADD COLUMN line_entry_route_id TEXT;
ALTER TABLE seminars ADD COLUMN line_scenario_id TEXT;
ALTER TABLE seminars ADD COLUMN line_auto_reply_id TEXT;
