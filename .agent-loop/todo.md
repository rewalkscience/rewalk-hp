# Todo

## Active Slice
- 完了。次のスライス待ち。

## Queue
- Resend Topics/Webhook、同意履歴、SES移行条件の構造レビューは別スライス。

## Done
- 現状のメール経路、LINE Harness OpenAPI、既存R2アップロード経路を監査した。
- Resend Transactional / Marketingを分離し、EmailService factoryを切替点にした。
- Transactional使用量をレスポンスヘッダーからKVへ記録するようにした。
- Marketing受信設定、新規登録の任意opt-in、マイページ停止、配信前Segment除外を実装した。
- LINE一斉配信へJPEG/PNG・1MB以下の画像アップロードと画像→本文配信を追加した。
- D1 migration、フロント、API Workerを本番反映した。
- TypeScript、JavaScript構文、明示configのWorker dry-run、実配信なしの本番疎通を通した。
- Transactional全経路へ安定した冪等キーと用途別期限を設定した。
- D1暗号化再送キュー、自動再送、stale lock回復、dead-letter、管理者status/retry APIを実装した。
- 本番0007 migration、EMAIL_QUEUE_SECRET、API Worker version `fdfd4ed4-5a6f-46e5-8589-d6a0742555d6`を反映した。
