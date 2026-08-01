# Agent Loop

## Goal
LINE画像付き一斉配信を1回の原子的な配信へ直し、停止中の重複本文を安全に整理する。あわせて申込者の参加形式表示とトップページ文言を更新する。

## Acceptance Checks
- 全会員向けメールは `/emails` の人数分ループではなく、Resend Broadcast を1回作成・送信する。
- Segment 同期で既存連絡先の配信停止状態を上書きしない。
- 同期失敗時は一斉配信を開始せず、受付開始通知の送信済み日時も更新しない。
- Marketing メールに Resend の配信停止リンクを含める。
- 個別通知メールは従来どおり Transactional で送る。
- LINE 一斉配信でLINE仕様準拠（JPEG/PNG・1MB以下）の画像をアップロード・プレビュー・解除できる。
- 画像指定時は画像と本文を1つのFlex Broadcastで送信し、月間枠を1回分だけ消費する。
- 毎回固有の対象タグで送信先を固定し、成功件数一致後だけ配信済みタグを付ける。
- LINE失敗時は一時タグ・下書きを削除し、未送信状態へ戻す。
- 申込者一覧で対面／オンラインを確認できる。
- トップページの不要なアーカイブ説明文が表示されない。
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
Implementing LINE atomic broadcast and admin display fixes

## Stop Conditions
- Reviewer marks PASS.
- Same blocker repeats for three loops and needs user input.
- Required credential, approval, or external service is missing.
