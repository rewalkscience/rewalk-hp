import { sendMarketingBroadcast, type MarketingBroadcastResult, type MarketingRecipient } from './resend-marketing'

const TRANSACTIONAL_USAGE_KEY = 'email:resend:transactional-usage:v1'
const RESEND_EMAIL_URL = 'https://api.resend.com/emails'
const MAX_QUEUE_ATTEMPTS = 8
const PROCESSING_STALE_MS = 20 * 60 * 1000
const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const EMAIL_REDACTION_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
export const TRANSACTIONAL_DAILY_LIMIT = 100
export const TRANSACTIONAL_RESERVE_THRESHOLD = 85

export type { MarketingBroadcastResult, MarketingRecipient }

export type TransactionalMessage = {
  to: string
  subject: string
  text: string
  html: string
  kind?: string
  expiresAt?: string | null
  idempotencyKey?: string
}

export type TransactionalSendResult = {
  status: 'sent' | 'queued' | 'dead'
  idempotencyKey: string
  providerMessageId?: string
}

export type MarketingMessage = {
  subject: string
  text: string
  html: string
  name?: string
}

export type TransactionalUsage = {
  provider: 'resend'
  used: number | null
  limit: number
  reserveThreshold: number
  reserveReached: boolean
  raw: string | null
  updatedAt: string
}

export type EmailQueueStatus = {
  configured: boolean
  counts: Record<'pending' | 'processing' | 'sent' | 'dead', number>
  recentDead: Array<{ id: string; kind: string; attempts: number; lastError: string | null; createdAt: number }>
}

type EmailServiceEnv = {
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
  REPLY_TO_EMAIL: string
  EMAIL_QUEUE_SECRET: string
  DB: D1Database
  SESSIONS: KVNamespace
}

type EncryptedPayload = {
  to: string
  subject: string
  text: string
  html: string
}

type EmailJobRow = {
  id: string
  idempotency_key: string
  kind: string
  encrypted_payload: string
  status: 'pending' | 'processing' | 'sent' | 'dead'
  attempts: number
  max_attempts: number
  next_attempt_at: number
  expires_at: number | null
  last_error: string | null
  created_at: number
}

type ResendAttempt = {
  ok: boolean
  status: number
  errorName: string | null
  errorMessage: string | null
  retryAfterSeconds: number | null
  providerMessageId?: string
}

export interface EmailService {
  sendTransactional(message: TransactionalMessage): Promise<TransactionalSendResult>
  sendMarketing(recipients: MarketingRecipient[], message: MarketingMessage): Promise<MarketingBroadcastResult>
  getTransactionalUsage(): Promise<TransactionalUsage | null>
}

function parseDailyUsage(raw: string | null): number | null {
  if (!raw) return null
  const match = raw.match(/\d+/)
  return match ? Number(match[0]) : null
}

function redactError(value: string | null | undefined): string {
  return String(value || 'unknown_error').replace(EMAIL_REDACTION_PATTERN, '[email]').slice(0, 500)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function queueCryptoKey(secret: string, usages: Array<'encrypt' | 'decrypt'>): Promise<CryptoKey> {
  if (!secret) throw new Error('EMAIL_QUEUE_SECRET is not configured')
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`rewalk-email-queue-v1:${secret}`))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, usages)
}

async function encryptPayload(secret: string, payload: EncryptedPayload): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await queueCryptoKey(secret, ['encrypt'])
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`
}

async function decryptPayload(secret: string, envelope: string): Promise<EncryptedPayload> {
  const [version, ivValue, ciphertextValue] = envelope.split('.')
  if (version !== 'v1' || !ivValue || !ciphertextValue) throw new Error('Unsupported encrypted payload')
  const key = await queueCryptoKey(secret, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivValue) },
    key,
    base64ToBytes(ciphertextValue),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as EncryptedPayload
}

export function isRetryableResendFailure(status: number, errorName: string | null): boolean {
  if (status === 0 || status === 429 || status >= 500) return true
  return status === 409 && errorName === 'concurrent_idempotent_requests'
}

export function retryDelayMs(attempt: number, errorName: string | null, retryAfterSeconds: number | null): number {
  if (errorName === 'daily_quota_exceeded' || errorName === 'monthly_quota_exceeded') return 24 * 60 * 60 * 1000
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds, 24 * 60 * 60) * 1000
  }
  const schedule = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000]
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)]
}

async function persistUsage(env: EmailServiceEnv, response: Response): Promise<void> {
  const raw = response.headers.get('x-resend-daily-quota')
  if (!raw) return
  const used = parseDailyUsage(raw)
  const usage: TransactionalUsage = {
    provider: 'resend',
    used,
    limit: TRANSACTIONAL_DAILY_LIMIT,
    reserveThreshold: TRANSACTIONAL_RESERVE_THRESHOLD,
    reserveReached: used !== null && used >= TRANSACTIONAL_RESERVE_THRESHOLD,
    raw,
    updatedAt: new Date().toISOString(),
  }
  await env.SESSIONS.put(TRANSACTIONAL_USAGE_KEY, JSON.stringify(usage)).catch(() => undefined)
}

async function sendResendOnce(
  env: EmailServiceEnv,
  payload: EncryptedPayload,
  idempotencyKey: string,
): Promise<ResendAttempt> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, status: 401, errorName: 'missing_api_key', errorMessage: 'RESEND_API_KEY is not configured', retryAfterSeconds: null }
  }
  try {
    const response = await fetch(RESEND_EMAIL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rewalk-api/1.0',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || 'Rewalk <no-reply@rewalk-science.com>',
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        reply_to: env.REPLY_TO_EMAIL || 'rewalk.science@gmail.com',
      }),
    })
    await persistUsage(env, response)
    const body: { id?: string; name?: string; message?: string } = await response
      .json<{ id?: string; name?: string; message?: string }>()
      .catch(() => ({}))
    const retryAfter = Number(response.headers.get('Retry-After'))
    return {
      ok: response.ok,
      status: response.status,
      errorName: body.name || null,
      errorMessage: body.message || null,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      providerMessageId: body.id,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      errorName: 'network_error',
      errorMessage: error instanceof Error ? error.message : 'network_error',
      retryAfterSeconds: null,
    }
  }
}

async function storeFailedJob(
  env: EmailServiceEnv,
  message: TransactionalMessage,
  idempotencyKey: string,
  attempt: ResendAttempt,
): Promise<'queued' | 'dead'> {
  const now = Date.now()
  const expiresAt = message.expiresAt ? new Date(message.expiresAt).getTime() : null
  const retryable = isRetryableResendFailure(attempt.status, attempt.errorName)
  const delay = retryDelayMs(1, attempt.errorName, attempt.retryAfterSeconds)
  const nextAttemptAt = now + delay
  const status = retryable && (!expiresAt || nextAttemptAt < expiresAt) ? 'pending' : 'dead'
  const encrypted = await encryptPayload(env.EMAIL_QUEUE_SECRET, {
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
  const lastError = redactError(`${attempt.errorName || `http_${attempt.status}`}: ${attempt.errorMessage || 'send failed'}`)

  await env.DB.prepare(
    `INSERT INTO email_jobs
       (id, idempotency_key, kind, encrypted_payload, status, attempts, max_attempts, next_attempt_at, expires_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`
  ).bind(
    crypto.randomUUID(), idempotencyKey, (message.kind || 'transactional').slice(0, 80), encrypted, status,
    MAX_QUEUE_ATTEMPTS, nextAttemptAt, expiresAt, lastError, now, now,
  ).run()
  return status === 'pending' ? 'queued' : 'dead'
}

class ResendEmailService implements EmailService {
  constructor(private readonly env: EmailServiceEnv) {}

  async sendTransactional(message: TransactionalMessage): Promise<TransactionalSendResult> {
    const idempotencyKey = (message.idempotencyKey || crypto.randomUUID()).slice(0, 256)
    const payload = { to: message.to, subject: message.subject, text: message.text, html: message.html }
    const attempt = await sendResendOnce(this.env, payload, idempotencyKey)
    if (attempt.ok) {
      return { status: 'sent', idempotencyKey, providerMessageId: attempt.providerMessageId }
    }
    try {
      const status = await storeFailedJob(this.env, message, idempotencyKey, attempt)
      return { status, idempotencyKey }
    } catch (queueError) {
      console.error('Transactional email failed and could not be queued:', redactError(queueError instanceof Error ? queueError.message : String(queueError)))
      return { status: 'dead', idempotencyKey }
    }
  }

  sendMarketing(recipients: MarketingRecipient[], message: MarketingMessage): Promise<MarketingBroadcastResult> {
    return sendMarketingBroadcast(this.env, recipients, message)
  }

  async getTransactionalUsage(): Promise<TransactionalUsage | null> {
    const raw = await this.env.SESSIONS.get(TRANSACTIONAL_USAGE_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as TransactionalUsage
    } catch {
      return null
    }
  }
}

export async function processTransactionalEmailQueue(env: EmailServiceEnv, limit = 25): Promise<{ sent: number; deferred: number; dead: number }> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE email_jobs SET status='pending', locked_at=NULL, updated_at=?
     WHERE status='processing' AND locked_at IS NOT NULL AND locked_at < ?`
  ).bind(now, now - PROCESSING_STALE_MS).run()
  await env.DB.prepare(
    `UPDATE email_jobs SET status='dead', last_error='expired_before_send', updated_at=?
     WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).bind(now, now).run()
  await env.DB.prepare(
    `UPDATE email_jobs SET status='dead', last_error=COALESCE(last_error, 'max_attempts_exceeded'), updated_at=?
     WHERE status='pending' AND attempts >= max_attempts`
  ).bind(now).run()
  await env.DB.prepare(`DELETE FROM email_jobs WHERE status='sent' AND sent_at < ?`).bind(now - SENT_RETENTION_MS).run()
  await env.DB.prepare(`DELETE FROM email_jobs WHERE status='dead' AND updated_at < ?`).bind(now - DEAD_RETENTION_MS).run()

  const { results } = await env.DB.prepare(
    `SELECT id, idempotency_key, kind, encrypted_payload, status, attempts, max_attempts,
            next_attempt_at, expires_at, last_error, created_at
     FROM email_jobs
     WHERE status='pending' AND next_attempt_at <= ? AND attempts < max_attempts
     ORDER BY next_attempt_at ASC LIMIT ?`
  ).bind(now, Math.max(1, Math.min(limit, 100))).all<EmailJobRow>()

  let sent = 0
  let deferred = 0
  let dead = 0
  for (const job of results) {
    const claimTime = Date.now()
    const claim = await env.DB.prepare(
      `UPDATE email_jobs SET status='processing', attempts=attempts+1, locked_at=?, updated_at=?
       WHERE id=? AND status='pending'`
    ).bind(claimTime, claimTime, job.id).run()
    if (claim.meta.changes === 0) continue
    const attempts = job.attempts + 1

    let payload: EncryptedPayload
    try {
      payload = await decryptPayload(env.EMAIL_QUEUE_SECRET, job.encrypted_payload)
    } catch (error) {
      await env.DB.prepare(
        `UPDATE email_jobs SET status='dead', locked_at=NULL, last_error=?, updated_at=? WHERE id=?`
      ).bind(redactError(`decrypt_error: ${error instanceof Error ? error.message : error}`), Date.now(), job.id).run()
      dead++
      continue
    }

    const attempt = await sendResendOnce(env, payload, job.idempotency_key)
    if (attempt.ok) {
      await env.DB.prepare(
        `UPDATE email_jobs SET status='sent', locked_at=NULL, provider_message_id=?, last_error=NULL, sent_at=?, updated_at=? WHERE id=?`
      ).bind(attempt.providerMessageId || null, Date.now(), Date.now(), job.id).run()
      sent++
      await new Promise(resolve => setTimeout(resolve, 250))
      continue
    }

    const retryable = isRetryableResendFailure(attempt.status, attempt.errorName)
    const nextAttemptAt = Date.now() + retryDelayMs(attempts, attempt.errorName, attempt.retryAfterSeconds)
    const expiredBeforeNext = job.expires_at !== null && nextAttemptAt >= job.expires_at
    // A network disconnect can occur after Resend accepted the message. Its idempotency key
    // expires after 24h, so ambiguous retries must stop before that safety window closes.
    const ambiguousWindowExpired = attempt.errorName === 'network_error'
      && nextAttemptAt >= job.created_at + 23 * 60 * 60 * 1000
    const shouldDead = !retryable || attempts >= job.max_attempts || expiredBeforeNext || ambiguousWindowExpired
    const lastError = redactError(`${attempt.errorName || `http_${attempt.status}`}: ${attempt.errorMessage || 'send failed'}`)
    await env.DB.prepare(
      `UPDATE email_jobs SET status=?, locked_at=NULL, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?`
    ).bind(shouldDead ? 'dead' : 'pending', nextAttemptAt, lastError, Date.now(), job.id).run()
    if (shouldDead) dead++
    else deferred++
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  return { sent, deferred, dead }
}

export async function getEmailQueueStatus(env: EmailServiceEnv): Promise<EmailQueueStatus> {
  const counts: EmailQueueStatus['counts'] = { pending: 0, processing: 0, sent: 0, dead: 0 }
  const grouped = await env.DB.prepare(`SELECT status, COUNT(*) AS count FROM email_jobs GROUP BY status`).all<{ status: keyof typeof counts; count: number }>()
  for (const row of grouped.results) if (row.status in counts) counts[row.status] = Number(row.count) || 0
  const recent = await env.DB.prepare(
    `SELECT id, kind, attempts, last_error, created_at FROM email_jobs WHERE status='dead' ORDER BY updated_at DESC LIMIT 20`
  ).all<{ id: string; kind: string; attempts: number; last_error: string | null; created_at: number }>()
  return {
    configured: Boolean(env.EMAIL_QUEUE_SECRET),
    counts,
    recentDead: recent.results.map(row => ({
      id: row.id,
      kind: row.kind,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
    })),
  }
}

export async function retryDeadEmailJob(env: EmailServiceEnv, id: string): Promise<boolean> {
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE email_jobs SET status='pending', attempts=0, next_attempt_at=?, locked_at=NULL, last_error=NULL, updated_at=?
     WHERE id=? AND status='dead' AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(now, now, id, now).run()
  return result.meta.changes > 0
}

// Provider切替点。将来SESへ移行する場合は、このfactoryの返却実装を差し替える。
export function createEmailService(env: EmailServiceEnv): EmailService {
  return new ResendEmailService(env)
}
