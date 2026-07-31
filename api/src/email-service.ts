import { sendMarketingBroadcast, type MarketingBroadcastResult, type MarketingRecipient } from './resend-marketing'

const TRANSACTIONAL_USAGE_KEY = 'email:resend:transactional-usage:v1'
export const TRANSACTIONAL_DAILY_LIMIT = 100
export const TRANSACTIONAL_RESERVE_THRESHOLD = 85

export type { MarketingBroadcastResult, MarketingRecipient }

export type TransactionalMessage = {
  to: string
  subject: string
  text: string
  html: string
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
  raw: string | null
  updatedAt: string
}

type EmailServiceEnv = {
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
  REPLY_TO_EMAIL: string
  SESSIONS: KVNamespace
}

export interface EmailService {
  sendTransactional(message: TransactionalMessage): Promise<boolean>
  sendMarketing(recipients: MarketingRecipient[], message: MarketingMessage): Promise<MarketingBroadcastResult>
  getTransactionalUsage(): Promise<TransactionalUsage | null>
}

function parseDailyUsage(raw: string | null): number | null {
  if (!raw) return null
  const match = raw.match(/\d+/)
  return match ? Number(match[0]) : null
}

class ResendEmailService implements EmailService {
  constructor(private readonly env: EmailServiceEnv) {}

  async sendTransactional(message: TransactionalMessage): Promise<boolean> {
    if (!this.env.RESEND_API_KEY) return false
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rewalk-api/1.0',
      },
      body: JSON.stringify({
        from: this.env.RESEND_FROM_EMAIL || 'Rewalk <no-reply@rewalk-science.com>',
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        reply_to: this.env.REPLY_TO_EMAIL || 'rewalk.science@gmail.com',
      }),
    })

    const raw = response.headers.get('x-resend-daily-quota')
    if (raw) {
      const usage: TransactionalUsage = {
        provider: 'resend',
        used: parseDailyUsage(raw),
        limit: TRANSACTIONAL_DAILY_LIMIT,
        reserveThreshold: TRANSACTIONAL_RESERVE_THRESHOLD,
        raw,
        updatedAt: new Date().toISOString(),
      }
      await this.env.SESSIONS.put(TRANSACTIONAL_USAGE_KEY, JSON.stringify(usage)).catch(() => undefined)
    }

    return response.ok
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

// Provider切替点。将来SESへ移行する場合は、このfactoryの返却実装を差し替える。
export function createEmailService(env: EmailServiceEnv): EmailService {
  return new ResendEmailService(env)
}
