# Agent Loop

## Goal
Rewalk の緊急メール運用を Resend Transactional と Marketing Broadcast へ安全に分離する。あわせて管理画面の LINE 一斉配信で、既存のテキスト配信を維持したまま画像をアップロードして画像＋本文を送信できるようにする。

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

## Roles
- Planner: writes Todo, design, acceptance checks, and next slice.
- Implementer: writes code for the active slice.
- Reviewer: runs checks, records PASS/FAIL, and writes redlines.

## Current Status
Reviewer PASS / Deployed

## Stop Conditions
- Reviewer marks PASS.
- Same blocker repeats for three loops and needs user input.
- Required credential, approval, or external service is missing.
