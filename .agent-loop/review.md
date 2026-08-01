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
- LINE Flex生成の8 assertionとLINE公式validation API
- API Worker version `81b0a591-4254-4364-bc13-b60dee000a45`、フロント version `6b6814f8-4c53-40e1-8c83-98ea8e282b90`
- 本番アーカイブ文言削除、LINE管理APIの未認証401
- 本番D1の実効参加形式件数（online 191 / onsite 1）と表示マッピング

## Result
FAIL

## Findings
- blocker: 画像138件は成功、本文2件はsuccess=0のsendingで停止。LINE公式API実測は月間上限200・使用137で、本文138件を追加できない。
- 新しい重複本文1件を削除し、元の1件をdraftへ戻してCron再試行を停止した。
- 画像＋本文の単一Flexはpure logic 7 assertionとLINE公式validation API 200を通過した。
- 今後の画像付き配信は1 Broadcastに統合し、成功件数が対象件数と一致した場合だけ配信済み記録を付ける。
- Harness v0.15で同期完了を確認できない501件以上は、半端な成功を防ぐため送信前に停止する。
- アーカイブ欄の不要説明文は本番から削除済み。
- 申込者一覧は参加形式を独立列で表示し、対面／オンライン／未設定を識別できる。
- blocker解消: Transactional失敗を暗号化D1へ保存し、10分Cronで自動再送する。
- 429/5xx/networkのみ自動再送し、恒久4xx・期限切れ・最大試行超過はdead-letterへ送る。
- Resendの24時間冪等性期限に合わせ、通信結果不明のnetwork retryは23時間以内で停止する。
- claimは条件付きUPDATE、20分stale lock回復、冪等キー再利用でCron競合と二重送信を抑止する。
- パスワード再設定・メール変更・セミナー期限メールは、リンク/用途期限を越えて再送しない。
- queueの宛先・件名・本文はAES-GCM暗号化し、エラー表示ではメールアドレスを伏せる。
- Resend Marketingは無料枠で1,000 contactsまで送信数無制限。Transactional 100通/日とは別枠。
- 85通予約制御はTransactional使用量監視として保持し、低優先メールはMarketingへ分離するためD1翌日キューを消費しない。
- LINE画像は公式仕様に合わせJPEG/PNG、同一preview URL利用のため1MB以下に修正した。
- Harnessには画像と本文をFlex 1件として渡し、LINE月間枠を二重消費しない。
- 本番D1は176/176名がmarketing_opt_in=1、NULLなし。
- 実メール送信は監査で発生させていない。最初の実障害時は管理者status APIとD1 statusで追跡できる。

## Redlines For Planner
- 明日はTopics/WebhookによるResend側unsubscribeとD1設定の双方向同期を設計する。
- LINE Harnessを501件以上でも同期結果確認または安全な完了Webhookを扱える版へ更新する。
