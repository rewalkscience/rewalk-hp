# Review

## Commands Run
- `npx tsc --noEmit`
- 変更HTMLのinline scriptを `new Function` で構文検査
- `git diff --check`
- `npx wrangler deploy --config wrangler.toml --dry-run`
- 本番D1 `PRAGMA table_info(users)` と件数/既定値検証
- 本番公開GET、認証必須ルート401、フロント文言反映の非送信疎通
- 再送判定・遅延時間の8 assertion
- 隔離D1への0007適用、索引・列・二重claim防止検証
- `EMAIL_QUEUE_SECRET`、migration履歴、空キュー、本番公開GETの再確認

## Result
PASS

## Findings
- blocker解消: Transactional失敗を暗号化D1へ保存し、10分Cronで自動再送する。
- 429/5xx/networkのみ自動再送し、恒久4xx・期限切れ・最大試行超過はdead-letterへ送る。
- Resendの24時間冪等性期限に合わせ、通信結果不明のnetwork retryは23時間以内で停止する。
- claimは条件付きUPDATE、20分stale lock回復、冪等キー再利用でCron競合と二重送信を抑止する。
- パスワード再設定・メール変更・セミナー期限メールは、リンク/用途期限を越えて再送しない。
- queueの宛先・件名・本文はAES-GCM暗号化し、エラー表示ではメールアドレスを伏せる。
- Resend Marketingは無料枠で1,000 contactsまで送信数無制限。Transactional 100通/日とは別枠。
- 85通予約制御はTransactional使用量監視として保持し、低優先メールはMarketingへ分離するためD1翌日キューを消費しない。
- LINE画像は公式仕様に合わせJPEG/PNG、同一preview URL利用のため1MB以下に修正した。
- Harnessは1 Broadcast 1メッセージのため、画像と本文を2 draft作成後に同一条件へ順次キュー投入する。
- 本番D1は176/176名がmarketing_opt_in=1、NULLなし。
- 実メール送信は監査で発生させていない。最初の実障害時は管理者status APIとD1 statusで追跡できる。

## Redlines For Planner
- 明日はTopics/WebhookによるResend側unsubscribeとD1設定の双方向同期を設計する。
- LINE Harnessが複数messageを1 jobで原子的に扱えるようになったら、2 Broadcast方式を置き換える。
