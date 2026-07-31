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
- Harness は1 Broadcast 1メッセージ仕様のため、画像指定時は image Broadcast と text Broadcast を同じ条件で順にキュー投入する。
- image の `messageContent` は既存シナリオと同じ `{ originalContentUrl, previewImageUrl }` の JSON 文字列を使う。
- 全キュー投入成功後だけ配信済みタグを付ける。
- メール送信は `EmailService` interface とfactoryを切替点にし、Resend固有処理をindex.tsから隔離する。
- ResendのTransactional使用量はレスポンスヘッダーからKVへ記録する。85通は重要通知のための予約目安とし、Marketing Broadcastには適用しない。
- Marketing配信希望はusersに保持し、配信前に専用Segmentから停止会員を除外する。

## Constraints
- Resend Topics/Webhookを含む詳細な同意同期は明日に回し、本日は単一Segmentとローカル受信設定で応急処置する。
- テスト中は実配信を行わない。
