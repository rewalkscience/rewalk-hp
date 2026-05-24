# Rewalk HP Mockup

## ページ構成

| ファイル | 役割 |
|---|---|
| `index.html` | セミナー親ページ。最も近い開催、開催予定、過去開催、アーカイブ動画への導線。 |
| `seminars.html` | セミナー一覧ページ。絞り込み付きの一覧。 |
| `seminar-detail.html` | セミナー詳細ページ。本文内画像と申込CTAの表示確認。 |
| `seminar-apply.html` | セミナー申込フォーム。Stripe Checkout への直前画面。 |
| `payment-success.html` | 決済完了ページ。申込完了後の案内。 |
| `payment-cancel.html` | 決済キャンセルページ。再申込導線。 |
| `archive.html` | アーカイブ動画一覧。 |
| `archive-detail.html` | アーカイブ動画詳細・購入導線。 |
| `mypage-video.html` | 購入済み動画視聴ページ。 |
| `science.html` | Rewalk Science 事業紹介LP。事業の魅力、Evidence x Practice、提供内容、選ばれる理由。 |
| `admin-seminar-edit.html` | セミナー管理画面。GUI型リッチエディタ、画像最大3枚、プレビュー。 |
| `admin-dashboard.html` | 管理ダッシュボード。 |
| `admin-seminars.html` | 管理画面のセミナー一覧。 |
| `admin-enrollments.html` | 管理画面の申込者一覧。 |
| `admin-videos.html` | 管理画面の動画管理。 |
| `admin-users.html` | 管理画面の会員一覧。 |
| `admin-coupons.html` | 管理画面のクーポン管理。LINE配布用コード、対象セミナー、割引額、期限、利用上限を管理。 |
| `auth-login.html` | ログイン画面。セミナー申込・マイページ導線。 |
| `auth-register.html` | 新規登録画面。氏名・所属・職種を登録。 |
| `mypage.html` | マイページ。申込済みセミナー、購入済み動画、プロフィール導線、マイページ内検索。 |

## ロゴ

ユーザー作成のPNGを正式ロゴ素材として使用する。

| ファイル | 用途 |
|---|---|
| `assets/logo/rewalk-logo-horizontal.png` | トップバー、横長表示 |
| `assets/logo/rewalk-logo-mark.png` | 管理画面、favicon候補 |
| `assets/logo/rewalk-logo-vertical.png` | 事業紹介ページのヒーロー内ブランド表示 |

`assets/logo/_unused-generated-svg/` には、途中で作成した未使用SVG案を退避している。正式ロゴとしては使用しない。
`assets/_references/` には、初期検討用の生成ボードを退避している。ページからは参照していない。

## デザイン方針

- セミナー系ページは実務導線優先。余計なキャッチコピーや事業説明を置かない。
- Rewalk Science 事業紹介ページはLPとして、画像を多く使い、セクションごとに背景パターンを変える。
- 事業紹介ページでは、主要セクションごとに同じ画像を流用しない。
- 医療専門職向け。過度な装飾、紫系グラデーション、汎用SaaSっぽいカード乱用は避ける。

## 実装時の注意

- セミナー本文は Markdown ではなく `body_content` の構造化JSONとして保存する。
- 管理画面では見出し、太字、箇条書き、リンク、画像挿入をGUI型リッチエディタで扱う。
- 本文内画像は1セミナー最大3枚。画像実体は `seminar_images` で管理する。
- 画像は本番ではSupabase Storageへ移す想定。
- LINE経由の割引は、初期運用では公式LINEで配布したクーポンコードを申込フォームで入力する方式にする。
- クーポンはサーバー側で有効期限、対象セミナー、利用上限、重複利用を検証してからStripe Checkout金額に反映する。
- 現在のモック画像は方向確認用。実写素材が提供されたら差し替える。

## 現時点の未確認

- 本番で使用可能な講義風景・臨床風景素材の有無
- セミナー頻度、定員、価格帯
- アーカイブ動画本数、視聴期間
- Peatixからの参加者データ移行要否
- Stripe / LINE / ドメインの準備状況
