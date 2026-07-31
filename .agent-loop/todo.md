# Todo

## Active Slice
- 完了。Reviewer PASS。

## Queue
- 明日: Resend Topics/Webhook、同意履歴、配信監査ログ、SES移行条件を構造レビューする。

## Done
- 現状のメール経路、LINE Harness OpenAPI、既存R2アップロード経路を監査した。
- Resend Transactional / Marketingを分離し、EmailService factoryを切替点にした。
- Transactional使用量をレスポンスヘッダーからKVへ記録するようにした。
- Marketing受信設定、新規登録の任意opt-in、マイページ停止、配信前Segment除外を実装した。
- LINE一斉配信へJPEG/PNG・1MB以下の画像アップロードと画像→本文配信を追加した。
- D1 migration、フロント、API Workerを本番反映した。
- TypeScript、JavaScript構文、明示configのWorker dry-run、実配信なしの本番疎通を通した。
