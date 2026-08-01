# Design

## Repo Context
Cloudflare Worker（Hono/D1/KV/R2）と静的管理画面。Resend と LINE OSS CRM Harness は Worker から呼び出す。

## Architecture Notes
- Transactional は既存 `sendEmail()` と `/emails` を維持する。
- Marketing は専用モジュールに API 呼び出し、Segment 確保、連絡先同期、Broadcast 作成を分離する。
- Segment ID は KV にキャッシュし、未作成時は名前検索後に作成する。
- Segment にいない会員だけ追加する。既存連絡先はメールアドレスで Segment 追加し、配信停止状態を更新しない。
- 429/5xx のみ限定再試行し、同期失敗時は Broadcast を作らない。
- LINE画像は既存R2 Bucketを再利用し、LINE仕様（JPEG/PNG・preview 1MB以下）専用のアップロードAPIで検証する。
- Harness は1 Broadcast 1メッセージ仕様のため、画像をhero、本文をbody、先頭URLをfooter buttonに持つ1 Flexへ統合する。
- 毎回固有の一時タグで対象を固定し、500件以下は同期`/send`で処理する。HTTPだけでなく`successCount === targetCount`を成功条件にする。
- 成功後だけ恒久的な配信済みタグを付け、一時タグは成功・失敗とも削除する。
- LINE月間枠は公式quota APIで事前監査する。本件は上限200、使用137、対象138のため再送には75件分の追加枠が必要。
- メール送信は `EmailService` interface とfactoryを切替点にし、Resend固有処理をindex.tsから隔離する。
- ResendのTransactional使用量はレスポンスヘッダーからKVへ記録する。85通は重要通知のための予約目安とし、Marketing Broadcastには適用しない。
- Marketing配信希望はusersに保持し、配信前に専用Segmentから停止会員を除外する。

## Transactional retry queue

- `email_jobs` はメタデータとAES-GCM暗号文だけを保存し、宛先・件名・本文・URLは平文保存しない。
- `EMAIL_QUEUE_SECRET` を暗号鍵の素材にし、JWT署名鍵とは分離する。
- 初回送信と再送で同一 `Idempotency-Key` を使う。Resendの重複防止期間は24時間。
- retryable: network、429、409 concurrent、5xx。permanent: その他4xx。
- `daily_quota_exceeded` は24時間後、それ以外は指数バックオフ。`Retry-After` があれば優先する。
- Cronはstale processingをpendingへ戻し、due jobを条件付きUPDATEでclaimしてから送る。
- トークンメールは`expires_at`を保持し、期限後は送らずdeadへ移す。
- Marketing Broadcastはこのキューの対象外。

## Constraints
- Resend Topics/Webhookを含む詳細な同意同期は明日に回し、本日は単一Segmentとローカル受信設定で応急処置する。
- テスト中は実配信を行わない。
