# Review

## Commands Run
- `npx tsc --noEmit`
- 変更HTMLのinline scriptを `new Function` で構文検査
- `git diff --check`
- `npx wrangler deploy --config wrangler.toml --dry-run`
- 本番D1 `PRAGMA table_info(users)` と件数/既定値検証
- 本番公開GET、認証必須ルート401、フロント文言反映の非送信疎通

## Result
PASS

## Findings
- Resend Marketingは無料枠で1,000 contactsまで送信数無制限。Transactional 100通/日とは別枠。
- 85通予約制御はTransactional使用量監視として保持し、低優先メールはMarketingへ分離するためD1翌日キューを消費しない。
- LINE画像は公式仕様に合わせJPEG/PNG、同一preview URL利用のため1MB以下に修正した。
- Harnessは1 Broadcast 1メッセージのため、画像と本文を2 draft作成後に同一条件へ順次キュー投入する。
- 本番D1は176/176名がmarketing_opt_in=1、NULLなし。
- 実配信を避けたため、Resend API keyのContacts/Broadcast権限は最初の管理画面配信時に最終確認される。権限エラー時はBroadcastを開始せず画面へエラーを返す。

## Redlines For Planner
- 明日はTopics/WebhookによるResend側unsubscribeとD1設定の双方向同期を設計する。
- LINE Harnessが複数messageを1 jobで原子的に扱えるようになったら、2 Broadcast方式を置き換える。
