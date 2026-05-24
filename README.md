# Rewalk HP Mockup

Rewalk のWebサイト / セミナーEC基盤の確認用モックアップです。

## Preview

Vercel ではルートURLが `mockup/index.html` に向くように `vercel.json` で設定しています。

## Main Pages

- `mockup/index.html`: セミナー親ページ
- `mockup/science.html`: Rewalk Science 事業紹介ページ
- `mockup/seminars.html`: セミナー一覧
- `mockup/seminar-detail.html`: セミナー詳細
- `mockup/seminar-apply.html`: 申込フォーム / LINEクーポン
- `mockup/mypage.html`: マイページ / 検索
- `mockup/admin-dashboard.html`: 管理画面
- `mockup/admin-coupons.html`: クーポン管理

## Notes

- これは静的HTMLモックです。
- 決済、認証、DB、LINE連携は未実装です。
- 本実装では Supabase / Stripe / Resend / LINE Harness 候補を使う想定です。
