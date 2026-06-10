# Rewalk HP モダン化デザイン仕様（2026-06）

対象: `C:\Users\tamun\Documents\client-project\Rewalk_HP\mockup\` 配下のHTML。
方針: 現在のネイビー×ブルーの方向性を踏襲しつつ、より洗練・モダンに。各ページのインラインCSSを直接書き換える（外部CSS化はしない）。構造(HTML)は必要最小限の変更に留める。

## 1. デザイントークン（:root を全ページこの値に統一）

```css
:root {
  --navy: #163A6D;
  --blue: #2563EB;
  --blue-deep: #1D4ED8;
  --ink: #0F172A;
  --muted: #64748B;
  --line: #E2E8F0;
  --line-soft: #EDF2F9;
  --pale: #F1F5FB;
  --white: #FFFFFF;
  --dark: #0B1F3D;
  --accent: #38BDF8;          /* さりげない差し色。多用しない */
  --radius-card: 16px;
  --radius-ui: 10px;
  --shadow-card: 0 1px 2px rgba(15,23,42,.05), 0 12px 32px -12px rgba(22,58,109,.18);
  --shadow-pop: 0 24px 64px -16px rgba(11,31,61,.35);
}
```
※ ページ独自の色（クーポンの --green:#128C7E 等）は維持してよい。

## 2. タイポグラフィ
- 全ページ `<head>` に追加（既存になければ）:
  ```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
  ```
- font-weight 900 の乱用をやめる: 見出しh1/h2は 700〜800、ナビ・ラベル・ボタンは 600〜700。900はヒーローの大見出しのみ可。
- 見出しに `letter-spacing: -0.015em`、英字eyebrowは `letter-spacing: .12em; font-weight:700; font-size:12px`。
- body に `font-feature-settings: "palt"` と `-webkit-font-smoothing: antialiased`。

## 3. 形状・影
- カード: `border-radius: var(--radius-card)`、`border:1px solid var(--line-soft)`、`box-shadow: var(--shadow-card)`。
- ボタン・入力: `border-radius: var(--radius-ui)`。主要CTAは `background: linear-gradient(135deg, var(--blue), var(--blue-deep))` + hoverで `transform: translateY(-1px)` + 影強化。
- 旧来の `border-radius:6px/8px` と巨大すぎる影 `0 24px 70px rgba(0,0,0,.08)` は上記に置換。

## 4. インタラクション
- `a, button, .card` 等に `transition: all .2s ease`（transform/box-shadow/color中心）。
- カードhover: `transform: translateY(-3px)` + 影をやや強める。
- 入力focus: `border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); outline: none`。

## 5. ナビゲーション（公開ページ共通）
- sticky + `background: rgba(255,255,255,.85); backdrop-filter: blur(16px) saturate(1.4)`。
- モバイル(≤768px): ハンバーガーボタンを追加し、タップでメニュー開閉（CSS + 最小限のインラインJS。checkbox hack でも可）。リンクを縮めて横並びのままにしない。
- ナビの最後に主要CTA（例: 「セミナーを探す」or「ログイン」）をピル型ボタンで置けるページは置く。

## 6. ヒーロー・セクション
- ダーク系ヒーローは `background: radial-gradient(120% 140% at 80% 0%, #16407c 0%, var(--dark) 55%)` のような奥行きあるグラデへ。上に `1px` の薄いハイライト線や、控えめなドットグリッド装飾は可（やりすぎない）。
- セクション余白を広めに: 縦 96px 前後（モバイル 64px）。

## 7. メタ情報（全ページ必須）
- `<meta name="description" content="...">`（ページ内容に即した日本語60〜90字）
- OGP: `og:title` `og:description` `og:type`（website）`og:site_name`（Rewalk）。og:image は `assets/logo/rewalk-logo-horizontal.png` を相対指定でよい。
- `<html lang="ja">` 確認。

## 8. 機能面の修正
- フォームのダミー個人情報（`value="田村 翔太郎"` 等）→ `placeholder` に変更。
- ボタン要素に `type` 属性、画像に意味のある `alt`。
- リンク先は既存の `xxx.html` 形式を維持（Vercel cleanUrls が処理する）。リンク切れを作らない。
- 管理画面テーブルは `<thead><tbody>` で構造化、`th` に `scope`。

## 9. 管理画面（admin-*）
- サイドバー: `--dark` 背景は維持。active項目は `background: rgba(56,189,248,.16); color:#fff; border-left:3px solid var(--accent)` 風に。
- 数値カードの数字は `font-family: Inter` で `font-weight: 700`。
- 公開ページほど装飾しない。密度と読みやすさ優先。

## 10. やらないこと
- 配色の方向転換（ネイビー×ブルー維持）
- 絵文字の使用（既存の「▶」等の記号はOK、カラー絵文字はNG）
- 外部JSライブラリの追加
- ページ構成・文言の変更（メタ情報以外）
