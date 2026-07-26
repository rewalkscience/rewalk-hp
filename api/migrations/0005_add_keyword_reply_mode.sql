-- 合言葉への返信を「テンプレ自動生成」か「カスタム自由入力」で選べるようにするモード列
ALTER TABLE seminars ADD COLUMN line_keyword_reply_mode TEXT;

-- 既存データの振り分け：返信文言が入っているものはカスタム扱い、空はテンプレ扱い
UPDATE seminars
SET line_keyword_reply_mode = CASE
  WHEN line_keyword_reply IS NOT NULL AND line_keyword_reply != '' THEN 'custom'
  ELSE 'template'
END;
