# Agent Loop

## Goal
Rewalk の重要なTransactionalメールが一時障害・429・日次上限で失敗した場合に、暗号化D1キューへ安全に退避し、重複送信を防ぎながらCronで自動再送する。

## Acceptance Checks
- 全会員向けメールは `/emails` の人数分ループではなく、Resend Broadcast を1回作成・送信する。
- Segment 同期で既存連絡先の配信停止状態を上書きしない。
- 同期失敗時は一斉配信を開始せず、受付開始通知の送信済み日時も更新しない。
- Marketing メールに Resend の配信停止リンクを含める。
- 個別通知メールは従来どおり Transactional で送る。
- LINE 一斉配信でLINE仕様準拠（JPEG/PNG・1MB以下）の画像をアップロード・プレビュー・解除できる。
- 画像指定時は画像→本文、未指定時は本文のみを同じ対象条件へキュー投入する。
- 全LINEキュー投入成功後だけ配信済みタグを付ける。
- 型検査、Worker dry-run、差分監査を通し、検証で実配信しない。
- Resendへの全Transactional送信に24時間有効なIdempotency-Keyを付ける。
- 一時障害・429はpending、永続4xxはdeadとして監査可能に記録する。
- キュー本文・宛先・トークンURLは専用secretを用いたAES-GCMで暗号化し、平文でD1に保存しない。
- password reset / email changeは30分の有効期限を越えて送信しない。
- processingのstale lockを回収し、Cron重複起動でも同じjobを二重処理しない。
- 成功はsent、上限回数または期限超過はdeadへ遷移する。
- 管理者APIからpending/dead件数と失敗理由を個人情報なしで確認できる。

## Roles
- Planner: writes Todo, design, acceptance checks, and next slice.
- Implementer: writes code for the active slice.
- Reviewer: runs checks, records PASS/FAIL, and writes redlines.

## Current Status
Planning transactional retry queue

## Stop Conditions
- Reviewer marks PASS.
- Same blocker repeats for three loops and needs user input.
- Required credential, approval, or external service is missing.
