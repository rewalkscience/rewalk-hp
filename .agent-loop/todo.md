# Todo

## Active Slice
- 重複本文の新しい1件を削除し、元の1件をdraftへ戻してCronを停止する。
- 画像＋本文を単一Flex、固有対象タグ、同期成功確認へ変更する。
- LINE validation、型、dry-run、失敗時ロールバックを監査する。
- 参加者一覧の参加形式表示はUI案の承認後に実装する。
- トップページの不要なアーカイブ説明文を削除する。
- API／フロントをデプロイし、commit・pushする。

## Queue
- Resend Topics/Webhook、同意履歴、SES移行条件の構造レビューは別スライス。

## Done
- LINE障害の重複本文1件と未使用追跡リンクを削除し、元本文1件をdraftへ戻してCron再試行を停止した。
- 画像＋本文を単一Flex、固有対象タグ、同期成功件数確認、失敗時cleanupへ変更した。
- LINE公式validation、TypeScript、HTML内JavaScript、Worker dry-run、本番認証境界を検証した。
- トップページのアーカイブ説明文を削除し、API／フロントを本番反映した。
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
