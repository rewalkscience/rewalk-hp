const RESEND_API_BASE = 'https://api.resend.com'
const SEGMENT_NAME = 'Rewalk Members'
const SEGMENT_CACHE_KEY = 'resend:marketing-segment-id:v1'
const REQUEST_INTERVAL_MS = 250
const MAX_RETRIES = 3

export type MarketingRecipient = {
  email: string
  name?: string | null
}

type MarketingEnv = {
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
  SESSIONS: KVNamespace
}

type ResendSegment = {
  id: string
  name: string
}

type ResendContact = {
  id: string
  email: string
}

type ResendList<T> = {
  data?: T[]
  has_more?: boolean
}

type ResendErrorBody = {
  message?: string
  name?: string
}

export type MarketingBroadcastResult = {
  broadcastId: string
  total: number
  added: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function resendRequest(env: MarketingEnv, path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const response = await fetch(`${RESEND_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'rewalk-api/1.0',
      ...(init.headers as Record<string, string> | undefined),
    },
  })

  if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * (2 ** attempt)
    await sleep(waitMs)
    return resendRequest(env, path, init, attempt + 1)
  }

  return response
}

async function parseError(response: Response, fallback: string): Promise<Error> {
  const body: ResendErrorBody = await response.json<ResendErrorBody>().catch(() => ({}))
  return new Error(body.message || body.name || `${fallback}（HTTP ${response.status}）`)
}

async function ensureSegment(env: MarketingEnv): Promise<string> {
  const cached = await env.SESSIONS.get(SEGMENT_CACHE_KEY)
  if (cached) return cached

  const listResponse = await resendRequest(env, '/segments?limit=100')
  if (!listResponse.ok) throw await parseError(listResponse, 'Resend Segment一覧の取得に失敗しました')
  const list = await listResponse.json<ResendList<ResendSegment>>()
  const existing = (list.data || []).find(segment => segment.name === SEGMENT_NAME)
  if (existing) {
    await env.SESSIONS.put(SEGMENT_CACHE_KEY, existing.id)
    return existing.id
  }

  const createResponse = await resendRequest(env, '/segments', {
    method: 'POST',
    body: JSON.stringify({ name: SEGMENT_NAME }),
  })
  if (!createResponse.ok) throw await parseError(createResponse, 'Resend Segmentの作成に失敗しました')
  const created = await createResponse.json<ResendSegment>()
  if (!created.id) throw new Error('Resend Segmentの作成結果にIDがありません')
  await env.SESSIONS.put(SEGMENT_CACHE_KEY, created.id)
  return created.id
}

async function listSegmentContacts(env: MarketingEnv, segmentId: string): Promise<Map<string, ResendContact>> {
  const contacts = new Map<string, ResendContact>()
  let after: string | undefined

  while (true) {
    const query = new URLSearchParams({ limit: '100' })
    if (after) query.set('after', after)
    const response = await resendRequest(env, `/segments/${encodeURIComponent(segmentId)}/contacts?${query}`)
    if (!response.ok) throw await parseError(response, 'Resend Segment連絡先の取得に失敗しました')
    const page = await response.json<ResendList<ResendContact>>()
    const items = page.data || []
    for (const contact of items) contacts.set(contact.email.trim().toLowerCase(), contact)
    if (!page.has_more || items.length === 0) break
    after = items[items.length - 1].id
  }

  return contacts
}

async function addRecipientToSegment(env: MarketingEnv, segmentId: string, recipient: MarketingRecipient): Promise<void> {
  await sleep(REQUEST_INTERVAL_MS)
  const createResponse = await resendRequest(env, '/contacts', {
    method: 'POST',
    body: JSON.stringify({
      email: recipient.email,
      first_name: recipient.name || undefined,
      unsubscribed: false,
      segments: [{ id: segmentId }],
    }),
  })
  if (createResponse.ok) return

  // 既存のContactは作り直さずSegmentへ追加する。配信停止状態を上書きしないための分岐。
  if (createResponse.status === 409 || createResponse.status === 422) {
    await sleep(REQUEST_INTERVAL_MS)
    const attachResponse = await resendRequest(
      env,
      `/contacts/${encodeURIComponent(recipient.email)}/segments/${encodeURIComponent(segmentId)}`,
      { method: 'POST' },
    )
    if (attachResponse.ok) return
    throw await parseError(attachResponse, `${recipient.email} のSegment追加に失敗しました`)
  }

  throw await parseError(createResponse, `${recipient.email} のContact作成に失敗しました`)
}

async function syncRecipients(env: MarketingEnv, segmentId: string, recipients: MarketingRecipient[]): Promise<number> {
  const existing = await listSegmentContacts(env, segmentId)
  const allowedEmails = new Set(recipients.map(recipient => recipient.email.trim().toLowerCase()).filter(Boolean))
  let added = 0

  // D1側で配信停止した会員や削除済み会員は、Broadcast前に専用Segmentから外す。
  // Resendのグローバル配信停止状態は変更しない。
  for (const [email] of existing) {
    if (allowedEmails.has(email)) continue
    await sleep(REQUEST_INTERVAL_MS)
    const removeResponse = await resendRequest(
      env,
      `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
      { method: 'DELETE' },
    )
    if (!removeResponse.ok && removeResponse.status !== 404) {
      throw await parseError(removeResponse, `${email} のSegment除外に失敗しました`)
    }
    existing.delete(email)
  }

  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase()
    if (!email || existing.has(email)) continue
    await addRecipientToSegment(env, segmentId, { ...recipient, email })
    existing.set(email, { id: email, email })
    added++
  }

  return added
}

export async function sendMarketingBroadcast(
  env: MarketingEnv,
  recipients: MarketingRecipient[],
  message: { subject: string; text: string; html: string; name?: string },
): Promise<MarketingBroadcastResult> {
  if (!env.RESEND_API_KEY) throw new Error('メール送信が未設定です（RESEND_API_KEY）')
  if (recipients.length === 0) throw new Error('配信対象の会員がいません')

  const segmentId = await ensureSegment(env)
  const added = await syncRecipients(env, segmentId, recipients)
  const response = await resendRequest(env, '/broadcasts', {
    method: 'POST',
    body: JSON.stringify({
      segment_id: segmentId,
      from: env.RESEND_FROM_EMAIL || 'Rewalk <no-reply@rewalk-science.com>',
      subject: message.subject,
      html: message.html,
      text: message.text,
      name: message.name,
      send: true,
    }),
  })
  if (!response.ok) throw await parseError(response, 'Resend Marketing配信の受付に失敗しました')
  const created = await response.json<{ id?: string }>()
  if (!created.id) throw new Error('Resend Marketing配信の受付結果にIDがありません')

  return { broadcastId: created.id, total: recipients.length, added }
}
