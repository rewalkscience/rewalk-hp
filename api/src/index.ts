import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { hashPassword, verifyPassword, createJWT, verifyJWT, verifyStripeSignature, hashToken } from './auth'

type Bindings = {
  DB: D1Database
  SESSIONS: KVNamespace
  THUMBNAILS: R2Bucket
  THUMBNAILS_PUBLIC_URL: string
  JWT_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  FRONTEND_URL: string
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
  REPLY_TO_EMAIL: string
  LINE_HARNESS_API_URL: string
  LINE_HARNESS_API_KEY: string
  LINE_HARNESS: Fetcher
}

type Variables = {
  userId: string
  userRole: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ALLOWED_ORIGINS = [
  'https://rewalk-hp.pages.dev',
  'https://rewalk-science.com',
  'https://www.rewalk-science.com',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
]

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return undefined
    if (ALLOWED_ORIGINS.includes(origin)) return origin
    // Cloudflare Pages のプレビューURL（*.rewalk-hp.pages.dev）を許可
    if (/^https:\/\/[a-z0-9-]+\.rewalk-hp\.pages\.dev$/.test(origin)) return origin
    return undefined
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

// ─── 認証ミドルウェア ───────────────────────────────────────────
const authMiddleware = async (c: any, next: any) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
    || getCookie(c.req.raw, 'session')
  if (!token) return c.json({ error: '認証が必要です' }, 401)
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!payload) return c.json({ error: 'セッションが無効です' }, 401)
  const session = await c.env.SESSIONS.get(`session:${token}`)
  if (!session) return c.json({ error: 'セッションが切れました' }, 401)
  // roleはDBから取得（role変更を即時反映するため、トークン内のroleは信用しない）
  const row = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?')
    .bind(payload.sub).first() as { role: string } | null
  if (!row) return c.json({ error: 'ユーザーが見つかりません' }, 401)
  c.set('userId', payload.sub as string)
  c.set('userRole', row.role)
  await next()
}

const adminMiddleware = async (c: any, next: any) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: '管理者権限が必要です' }, 403)
  await next()
}

function getCookie(req: Request, name: string): string | undefined {
  const cookie = req.headers.get('Cookie') || ''
  return cookie.split(';').find(s => s.trim().startsWith(`${name}=`))?.split('=')[1]?.trim()
}

function newId(): string {
  return crypto.randomUUID()
}

// ─── メール送信（Resend） ───────────────────────────────────────
const RW_LINE_URL = 'https://rewalk-official-line.rewalk-science.workers.dev/auth/line?ref=hp'

// text/plainのみだとcharset未指定のメールクライアントで短い文字列（氏名など）が
// 文字化けすることがあるため、明示的にUTF-8を宣言したHTML版を必ず併送する。
function rwEmailHtml(bodyText: string, cta?: { label: string; url: string }, imageUrl?: string): string {
  const escaped = bodyText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  const ctaHtml = cta
    ? `<p style="text-align:center;margin:28px 0;"><a href="${cta.url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;font-size:14px;">${cta.label}</a></p>`
    : ''
  const imageHtml = imageUrl
    ? `<img src="${imageUrl}" alt="" width="480" style="display:block;width:100%;max-width:480px;height:auto;">`
    : ''
  return `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f6f4;font-family:'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:12px;overflow:hidden;" cellpadding="0" cellspacing="0">
${imageHtml ? `<tr><td>${imageHtml}</td></tr>` : ''}
<tr><td style="padding:32px 28px;font-size:15px;line-height:1.8;">
${escaped}
${ctaHtml}
<hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
<p style="text-align:center;margin:0 0 16px;font-size:13px;color:#555;">お得なクーポン・最新セミナー情報はLINE公式アカウントで配信中</p>
<p style="text-align:center;margin:0;"><a href="${RW_LINE_URL}" style="display:inline-block;background:#06c755;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:bold;font-size:14px;">Rewalk公式LINEを友だち追加</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`
}

async function sendEmail(env: Bindings, to: string, subject: string, text: string, cta?: { label: string; url: string }, imageUrl?: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'Rewalk <no-reply@rewalk-science.com>',
      to,
      subject,
      text,
      html: rwEmailHtml(text, cta, imageUrl),
      // 送信元はno-reply（受信不可）のため、「本メールに返信」と案内している問い合わせが
      // 実際に届くよう返信先を運営メールに固定する。
      reply_to: env.REPLY_TO_EMAIL || 'rewalk.science@gmail.com',
    }),
  })
  return res.ok
}

// 管理画面のdatetime-local入力（タイムゾーン情報なし）はJST入力想定。
// Workersランタイムはローカルタイムゾーンが常にUTCのため、明示的に+09:00を付与してから解釈する。
function parseJstDate(s: string | null | undefined): number | null {
  if (!s) return null
  const hasTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(s)
  return new Date(hasTz ? s : `${s}+09:00`).getTime()
}

// JSON文字列カラム（session_dates / archive_videos / materials 等）を安全に配列化
function parseJsonArray(v: any): any[] {
  if (!v) return []
  if (Array.isArray(v)) return v
  try {
    const a = JSON.parse(v)
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

// セミナーの全開催日（date + session_dates）を返す
function allSeminarDates(s: any): string[] {
  return [s.date, ...parseJsonArray(s.session_dates)].filter(Boolean)
}

// 複数開催日セミナーの「最終開催日」時刻。開催予定/過去の振り分けに使う
function lastSeminarTime(s: any): number {
  const times = allSeminarDates(s).map((d) => parseJstDate(d) ?? 0)
  return times.length ? Math.max(...times) : 0
}

// {label, url} の配列入力をJSON文字列に正規化（アーカイブ動画・配布資料の保存用）
function normalizeLinkList(v: any): string | null {
  const arr = parseJsonArray(v)
    .map((x: any) => ({
      label: typeof x?.label === 'string' ? x.label.trim() : '',
      url: typeof x?.url === 'string' ? x.url.trim() : '',
    }))
    .filter((x) => x.url)
  return arr.length ? JSON.stringify(arr) : null
}

// 追加開催日の配列入力をJSON文字列に正規化
function normalizeDateList(v: any): string | null {
  const arr = parseJsonArray(v).map((d: any) => String(d).trim()).filter(Boolean)
  return arr.length ? JSON.stringify(arr) : null
}

// クーポンコードを検証し、割引後価格を返す（一致しなければnull）
function applyCoupon(seminar: any, code: string | null | undefined): number | null {
  if (!code || !seminar.coupon_code) return null
  if (String(code).trim().toLowerCase() !== String(seminar.coupon_code).trim().toLowerCase()) return null
  const price = seminar.price
  let discounted = price
  if (seminar.coupon_discount_type === 'percent') {
    discounted = Math.round(price * (1 - seminar.coupon_discount_value / 100))
  } else if (seminar.coupon_discount_type === 'fixed') {
    discounted = price - seminar.coupon_discount_value
  }
  return Math.max(0, Math.min(price, discounted))
}

// 申込確定時に参加案内（会場/Zoom URL）を即時案内（Resend経由メール送信）
async function sendEnrollmentConfirmation(
  env: Bindings,
  email: string,
  name: string | null,
  seminar: any,
  participationType: string | null
): Promise<void> {
  const when = rwFormatDateForEmail(seminar.date)
  // 複数開催日のセミナーは全日程を「第◯回」形式で列挙する
  const dates = allSeminarDates(seminar)
  const whenLines = dates.length > 1
    ? dates.map((d, i) => `第${i + 1}回 ${rwFormatDateForEmail(d)}`).join('\n　　　　　')
    : when
  const detailUrl = `${env.FRONTEND_URL}/seminar-detail.html?id=${seminar.id}`

  // 参加方法の案内（開催形式・ハイブリッド時は選択した参加方法で出し分け）
  let accessLines: string
  const effectiveMode = seminar.format === 'hybrid' ? participationType : seminar.format
  if (effectiveMode === 'offline' || effectiveMode === 'onsite') {
    accessLines = `【会場】\n${seminar.location}\n\n${when}になりましたら、会場までお越しください。`
  } else if (effectiveMode === 'online') {
    accessLines = seminar.zoom_url
      ? `【ご参加方法】\n${when}になりましたら、以下のURLよりご参加ください。\n${seminar.zoom_url}`
      : '【ご参加方法】\n参加用URLは開催が近づき次第、あらためてご案内いたします。'
  } else {
    // format='hybrid' で participation_type 未設定など、想定外の状態のフォールバック
    accessLines = seminar.zoom_url
      ? `【会場】\n${seminar.location}\n\n【オンライン参加の方】\n${seminar.zoom_url}`
      : `【会場】\n${seminar.location}`
  }

  const greeting = name ? `${name} 様` : 'お申込みありがとうございます。'

  await sendEmail(
    env,
    email,
    `【Rewalk Science】「${seminar.title}」お申込み受付完了のご案内`,
    `${greeting}

この度は「${seminar.title}」にお申込みいただき、誠にありがとうございます。
下記の内容でお申込みを受け付けいたしました。

■セミナー名：${seminar.title}
■開催日時：${whenLines}
■セミナー詳細ページ：${detailUrl}

${accessLines}

当日皆様にお会いできることを楽しみにしております。
ご不明な点がございましたら、本メールに返信の上お問い合わせください。

──────────────────────
Rewalk Science
${detailUrl}
──────────────────────`
  )
}

// 開催3日前リマインドメール
async function sendReminderEmail(
  env: Bindings,
  email: string,
  name: string | null,
  seminar: any,
  participationType: string | null
): Promise<void> {
  const when = rwFormatDateForEmail(seminar.date)
  const detailUrl = `${env.FRONTEND_URL}/seminar-detail.html?id=${seminar.id}`

  let accessLines: string
  const effectiveMode = seminar.format === 'hybrid' ? participationType : seminar.format
  if (effectiveMode === 'offline' || effectiveMode === 'onsite') {
    accessLines = `【会場】\n${seminar.location}`
  } else if (effectiveMode === 'online') {
    accessLines = seminar.zoom_url ? `【ご参加方法】\n${seminar.zoom_url}` : '【ご参加方法】\n参加用URLは別途ご案内いたします。'
  } else {
    accessLines = seminar.zoom_url
      ? `【会場】\n${seminar.location}\n\n【オンライン参加の方】\n${seminar.zoom_url}`
      : `【会場】\n${seminar.location}`
  }

  const greeting = name ? `${name} 様` : 'いつもお世話になっております。'

  await sendEmail(
    env,
    email,
    `【Rewalk Science】「${seminar.title}」開催3日前のご案内`,
    `${greeting}

「${seminar.title}」の開催が近づいてまいりましたので、ご案内いたします。

■セミナー名：${seminar.title}
■開催日時：${when}
■セミナー詳細ページ：${detailUrl}

${accessLines}

当日皆様にお会いできることを楽しみにしております。

──────────────────────
Rewalk Science
${detailUrl}
──────────────────────`
  )
}

function rwFormatDateForEmail(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── 認証 ────────────────────────────────────────────────────────

// 会員登録
app.post('/api/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
  const password = body.password
  const name = body.name ? String(body.name).trim().slice(0, 100) : null
  const affiliation = body.affiliation ? String(body.affiliation).trim().slice(0, 200) : null

  if (!email || !password) return c.json({ error: 'メールとパスワードは必須です' }, 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
  if (email.length > 254) return c.json({ error: 'メールアドレスが長すぎます' }, 400)
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: 'パスワードは8〜128文字にしてください' }, 400)
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: 'このメールアドレスは既に登録されています' }, 409)

  const id = newId()
  const passwordHash = await hashPassword(password)
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, affiliation) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, email, passwordHash, name || null, affiliation || null).run()

  const token = await createJWT({ sub: id, role: 'user' }, c.env.JWT_SECRET)
  await c.env.SESSIONS.put(`session:${token}`, id, { expirationTtl: 60 * 60 * 24 * 30 })

  await sendEmail(
    c.env,
    email,
    'Rewalkへのご登録ありがとうございます',
    `${name || ''}様\n\nRewalkへの会員登録が完了しました。\nセミナーの申込・アーカイブ動画の視聴などがマイページからご利用いただけます。\n\n${c.env.FRONTEND_URL}/mypage.html\n\n最新のセミナー情報は随時お届けします。`,
    { label: 'マイページへ', url: `${c.env.FRONTEND_URL}/mypage.html` }
  )

  return c.json({ token, user: { id, email, name, affiliation, role: 'user' } })
})

// ログイン試行のブルートフォース対策（メールアドレス単位でロック）
const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_LOCK_SECONDS = 60 * 15

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
  const password = body.password
  if (!email || !password) return c.json({ error: 'メールとパスワードを入力してください' }, 400)
  if (typeof password !== 'string' || password.length > 128) {
    return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401)
  }

  const attemptKey = `loginattempt:${email}`
  const attempts = Number(await c.env.SESSIONS.get(attemptKey)) || 0
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    return c.json({ error: 'ログイン試行回数が上限を超えました。しばらくしてから再度お試しください' }, 429)
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, name, role FROM users WHERE email = ?'
  ).bind(email).first<{ id: string; email: string; password_hash: string; name: string; role: string }>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await c.env.SESSIONS.put(attemptKey, String(attempts + 1), { expirationTtl: LOGIN_LOCK_SECONDS })
    return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401)
  }

  if (attempts > 0) await c.env.SESSIONS.delete(attemptKey)

  const token = await createJWT({ sub: user.id, role: user.role }, c.env.JWT_SECRET)
  await c.env.SESSIONS.put(`session:${token}`, user.id, { expirationTtl: 60 * 60 * 24 * 30 })

  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// ログアウト
app.post('/api/auth/logout', authMiddleware, async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (token) await c.env.SESSIONS.delete(`session:${token}`)
  return c.json({ ok: true })
})

// 自分の情報
app.get('/api/auth/me', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id, email, name, affiliation, profession, experience_years, role, created_at FROM users WHERE id = ?'
  ).bind(c.get('userId')).first()
  if (!user) return c.json({ error: 'ユーザーが見つかりません' }, 404)
  return c.json(user)
})

// パスワード再設定メールの送信依頼
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

app.post('/api/auth/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const email = String(body.email || '').trim().toLowerCase()
  const genericMessage = 'このメールアドレスが登録されている場合、パスワード再設定用のメールをお送りしました'
  if (!email) return c.json({ error: 'メールアドレスを入力してください' }, 400)

  const user = await c.env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first<{ id: string; name: string }>()
  if (user) {
    const rawToken = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')
    const tokenHash = await hashToken(rawToken)
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString()
    await c.env.DB.prepare(
      'UPDATE users SET password_reset_token = ?, password_reset_expires_at = ? WHERE id = ?'
    ).bind(tokenHash, expiresAt, user.id).run()

    const resetUrl = `${c.env.FRONTEND_URL}/auth-reset-password.html?token=${rawToken}`
    await sendEmail(
      c.env, email, 'Rewalk パスワード再設定のご案内',
      `${user.name || ''}様\n\nパスワード再設定のご依頼を受け付けました。\n下記リンクより30分以内に新しいパスワードを設定してください。\n\nこのご依頼に心当たりがない場合は、本メールを破棄してください。`,
      { label: 'パスワードを再設定する', url: resetUrl }
    )
  }
  return c.json({ ok: true, message: genericMessage })
})

// パスワード再設定の実行
app.post('/api/auth/reset-password', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const token = String(body.token || '')
  const password = body.password
  if (!token || !password) return c.json({ error: 'トークンとパスワードが必要です' }, 400)
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: 'パスワードは8〜128文字にしてください' }, 400)
  }

  const tokenHash = await hashToken(token)
  const user = await c.env.DB.prepare(
    'SELECT id, password_reset_expires_at FROM users WHERE password_reset_token = ?'
  ).bind(tokenHash).first<{ id: string; password_reset_expires_at: string }>()

  if (!user || !user.password_reset_expires_at || new Date(user.password_reset_expires_at).getTime() < Date.now()) {
    return c.json({ error: 'リンクの有効期限が切れています。もう一度パスワード再設定をお申し込みください' }, 400)
  }

  const passwordHash = await hashPassword(password)
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = ?'
  ).bind(passwordHash, user.id).run()

  return c.json({ ok: true })
})

// プロフィール更新（氏名・所属）
app.put('/api/my/profile', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = body.name ? String(body.name).trim().slice(0, 100) : null
  const affiliation = body.affiliation ? String(body.affiliation).trim().slice(0, 200) : null
  await c.env.DB.prepare(
    'UPDATE users SET name = ?, affiliation = ? WHERE id = ?'
  ).bind(name, affiliation, c.get('userId')).run()
  return c.json({ ok: true })
})

// メールアドレス変更の申請（新アドレス宛の確認メールで確定する二段階方式）
app.put('/api/my/email', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const newEmail = String(body.newEmail || '').trim().toLowerCase()
  const password = body.password
  if (!newEmail || !password) return c.json({ error: '新しいメールアドレスと現在のパスワードを入力してください' }, 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
  if (newEmail.length > 254) return c.json({ error: 'メールアドレスが長すぎます' }, 400)

  const user = await c.env.DB.prepare('SELECT email, password_hash, name FROM users WHERE id = ?')
    .bind(c.get('userId')).first<{ email: string; password_hash: string; name: string }>()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: '現在のパスワードが正しくありません' }, 401)
  }
  if (newEmail === user.email) return c.json({ error: '現在のメールアドレスと同じです' }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(newEmail).first()
  if (existing) return c.json({ error: 'このメールアドレスは既に使用されています' }, 409)

  const rawToken = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')
  const tokenHash = await hashToken(rawToken)
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString()
  await c.env.DB.prepare(
    'UPDATE users SET pending_email = ?, email_change_token = ?, email_change_expires_at = ? WHERE id = ?'
  ).bind(newEmail, tokenHash, expiresAt, c.get('userId')).run()

  const confirmUrl = `${c.env.FRONTEND_URL}/auth-confirm-email.html?token=${rawToken}`
  await sendEmail(
    c.env, newEmail, 'Rewalk メールアドレス変更の確認',
    `${user.name || ''}様\n\nメールアドレス変更のご依頼を受け付けました。\n下記ボタンより30分以内に変更を確定してください。\n\nこのご依頼に心当たりがない場合は、本メールを破棄してください。`,
    { label: 'メールアドレスの変更を確定する', url: confirmUrl }
  )
  return c.json({ ok: true })
})

// メールアドレス変更の確定（確認メールのリンクから）
app.post('/api/auth/confirm-email-change', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const token = String(body.token || '')
  if (!token) return c.json({ error: 'トークンが必要です' }, 400)

  const tokenHash = await hashToken(token)
  const user = await c.env.DB.prepare(
    'SELECT id, pending_email, email_change_expires_at FROM users WHERE email_change_token = ?'
  ).bind(tokenHash).first<{ id: string; pending_email: string; email_change_expires_at: string }>()

  if (!user || !user.pending_email || !user.email_change_expires_at
    || new Date(user.email_change_expires_at).getTime() < Date.now()) {
    return c.json({ error: 'リンクの有効期限が切れています。もう一度メールアドレス変更をお申し込みください' }, 400)
  }

  // 確定直前に同じアドレスで別ユーザーが登録した場合を弾く
  const conflict = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(user.pending_email).first()
  if (conflict) return c.json({ error: 'このメールアドレスは既に使用されています。別のアドレスでやり直してください' }, 409)

  await c.env.DB.prepare(
    'UPDATE users SET email = pending_email, pending_email = NULL, email_change_token = NULL, email_change_expires_at = NULL WHERE id = ?'
  ).bind(user.id).run()
  return c.json({ ok: true })
})

// パスワード変更（ログイン中）
app.put('/api/my/password', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const currentPassword = body.currentPassword
  const newPassword = body.newPassword
  if (!currentPassword || !newPassword) return c.json({ error: '現在のパスワードと新しいパスワードを入力してください' }, 400)
  if (newPassword.length < 8 || newPassword.length > 128) {
    return c.json({ error: '新しいパスワードは8〜128文字にしてください' }, 400)
  }

  const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(c.get('userId')).first<{ password_hash: string }>()
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    return c.json({ error: '現在のパスワードが正しくありません' }, 401)
  }

  const passwordHash = await hashPassword(newPassword)
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, c.get('userId')).run()
  return c.json({ ok: true })
})

// ─── セミナー（公開） ─────────────────────────────────────────────

// 一覧（公開済み・開催日が未来のもの。開催日基準で自動的に「過去」へ振り分ける）
app.get('/api/seminars', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, date, session_dates, location, format, price, capacity, enrolled_count, thumbnail_url,
       enrollment_start, enrollment_end, external_apply_url, display_order
     FROM seminars WHERE status != 'draft' ORDER BY date ASC`
  ).all()
  const now = Date.now()
  // 複数開催日セミナーは最終開催日が過ぎるまで「開催予定」に留める
  const upcoming = (results as any[]).filter(s => lastSeminarTime(s) >= now)
  return c.json(upcoming)
})

// 過去の開催セミナー（公開済み・開催日が過去のもの）
app.get('/api/seminars-past', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, date, session_dates, format, thumbnail_url, archive_video_url, archive_expires_at
     FROM seminars WHERE status != 'draft' ORDER BY date DESC`
  ).all()
  const now = Date.now()
  const past = (results as any[]).filter(s => lastSeminarTime(s) < now).slice(0, 12)
  return c.json(past)
})

// 詳細
app.get('/api/seminars/:id', async (c) => {
  const seminar = await c.env.DB.prepare(
    `SELECT id, title, description, date, session_dates, location, format, price, capacity, enrolled_count, thumbnail_url, status,
       enrollment_start, enrollment_end, archive_video_url, archive_expires_at, external_apply_url
     FROM seminars WHERE id = ?`
  ).bind(c.req.param('id')).first()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)
  return c.json(seminar)
})

// アーカイブ視聴情報（申込済み・支払済みのユーザーのみ、期限内のみ動画URLを返す）
app.get('/api/seminars/:id/archive', authMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const userId = c.get('userId')

  const enrollment = await c.env.DB.prepare(
    `SELECT id FROM enrollments WHERE seminar_id = ? AND user_id = ? AND status = 'paid'`
  ).bind(seminarId, userId).first()
  if (!enrollment) return c.json({ error: 'このセミナーへの申込が確認できません' }, 403)

  const seminar = await c.env.DB.prepare(
    `SELECT title, archive_video_url, archive_videos, materials, archive_expires_at FROM seminars WHERE id = ?`
  ).bind(seminarId).first<any>()
  if (!seminar || !seminar.archive_video_url) return c.json({ error: 'アーカイブ動画は未公開です' }, 404)

  if (seminar.archive_expires_at && parseJstDate(seminar.archive_expires_at)! < Date.now()) {
    return c.json({ error: '視聴可能期間が終了しました' }, 403)
  }

  // 動画は「メインURL＋追加分（archive_videos JSON）」をまとめて返す。video_urlは後方互換
  const videos = [
    { label: null, url: seminar.archive_video_url },
    ...parseJsonArray(seminar.archive_videos).filter((v: any) => v && v.url),
  ]
  const materials = parseJsonArray(seminar.materials).filter((m: any) => m && m.url)
  return c.json({
    title: seminar.title,
    video_url: seminar.archive_video_url,
    videos,
    materials,
    expires_at: seminar.archive_expires_at,
  })
})

// サムネイル画像アップロード（管理者専用。R2に保存し公開URLを返す）
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024

app.post('/api/admin/upload-thumbnail', authMiddleware, adminMiddleware, async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file') as any
  if (!file || typeof file === 'string') return c.json({ error: '画像ファイルが見つかりません' }, 400)

  const ext = ALLOWED_IMAGE_TYPES[file.type]
  if (!ext) return c.json({ error: 'png/jpeg/webp/gif形式の画像のみアップロードできます' }, 400)
  if (file.size > MAX_THUMBNAIL_BYTES) return c.json({ error: '画像サイズは5MB以下にしてください' }, 400)

  const key = `seminars/${crypto.randomUUID()}.${ext}`
  await c.env.THUMBNAILS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })

  return c.json({ url: `${c.env.THUMBNAILS_PUBLIC_URL}/${key}` })
})

// ─── セミナー（管理者専用CRUD） ───────────────────────────────────

// 全セミナー一覧（下書き含む）
app.get('/api/admin/seminars', authMiddleware, adminMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM seminars ORDER BY date DESC`
  ).all()
  return c.json(results)
})

// セミナー作成
app.post('/api/admin/seminars', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json()
  const { title, description, date, session_dates, location, format, price, capacity, thumbnail_url, zoom_url, status,
    enrollment_start, enrollment_end, archive_video_url, archive_videos, materials, archive_expires_at,
    coupon_code, coupon_discount_type, coupon_discount_value, external_apply_url } = body
  if (!title || !date) return c.json({ error: 'タイトル・日時は必須です' }, 400)
  if ((format === 'offline' || format === 'hybrid') && !location) return c.json({ error: '会場（対面・ハイブリッドの場合は必須）を入力してください' }, 400)

  const id = newId()
  await c.env.DB.prepare(
    `INSERT INTO seminars (id, title, description, date, session_dates, location, format, price, capacity, thumbnail_url, zoom_url, status,
       enrollment_start, enrollment_end, coupon_code, coupon_discount_type, coupon_discount_value, archive_video_url, archive_videos, materials, archive_expires_at, external_apply_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, title, description || null, date, normalizeDateList(session_dates), location || '', format || 'online',
    price || 0, capacity || 0, thumbnail_url || null, zoom_url || null, status || 'draft',
    enrollment_start || null, enrollment_end || null,
    coupon_code || null, coupon_discount_type || null, coupon_discount_value || null,
    archive_video_url || null, normalizeLinkList(archive_videos), normalizeLinkList(materials),
    archive_expires_at || null, external_apply_url || null).run()

  return c.json({ id }, 201)
})

// セミナー更新
app.put('/api/admin/seminars/:id', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json()
  const { title, description, date, session_dates, location, format, price, capacity, thumbnail_url, zoom_url, status,
    enrollment_start, enrollment_end, archive_video_url, archive_videos, materials, archive_expires_at,
    coupon_code, coupon_discount_type, coupon_discount_value, external_apply_url } = body
  const id = c.req.param('id')

  await c.env.DB.prepare(
    `UPDATE seminars SET title=?, description=?, date=?, session_dates=?, location=?, format=?, price=?,
     capacity=?, thumbnail_url=?, zoom_url=?, status=?,
     enrollment_start=?, enrollment_end=?, coupon_code=?, coupon_discount_type=?, coupon_discount_value=?,
     archive_video_url=?, archive_videos=?, materials=?, archive_expires_at=?, external_apply_url=?,
     updated_at=datetime('now') WHERE id=?`
  ).bind(title, description || null, date, normalizeDateList(session_dates), location || '', format, price, capacity || 0,
    thumbnail_url || null, zoom_url || null, status,
    enrollment_start || null, enrollment_end || null,
    coupon_code || null, coupon_discount_type || null, coupon_discount_value || null,
    archive_video_url || null, normalizeLinkList(archive_videos), normalizeLinkList(materials),
    archive_expires_at || null, external_apply_url || null, id).run()

  return c.json({ ok: true })
})

// トップページカルーセルの表示順を一括更新（管理者）
app.put('/api/admin/carousel-order', authMiddleware, adminMiddleware, async (c) => {
  const { orders } = await c.req.json()
  if (!Array.isArray(orders)) return c.json({ error: 'ordersは配列で指定してください' }, 400)
  for (const o of orders) {
    if (!o?.id) continue
    const order = Number.isFinite(Number(o.display_order)) ? Number(o.display_order) : null
    await c.env.DB.prepare('UPDATE seminars SET display_order = ? WHERE id = ?').bind(order, o.id).run()
  }
  return c.json({ ok: true })
})

// セミナー削除（?force=1で申込済みでも強制削除、?refund=1を併用すると事前にStripe返金）
app.delete('/api/admin/seminars/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param('id')
  const force = c.req.query('force') === '1'
  const refund = c.req.query('refund') === '1'

  const paidEnrollments = await c.env.DB.prepare(
    `SELECT id, stripe_session_id FROM enrollments WHERE seminar_id = ? AND status = 'paid'`
  ).bind(id).all<{ id: string; stripe_session_id: string | null }>()

  if (paidEnrollments.results.length > 0 && !force) {
    return c.json({ error: '申込済みユーザーがいるため削除できません', enrolled_count: paidEnrollments.results.length }, 400)
  }

  let refunded = 0
  let refundFailed = 0
  if (force && refund) {
    for (const e of paidEnrollments.results) {
      if (!e.stripe_session_id) continue // 無料枠など決済なしはスキップ
      try {
        const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${e.stripe_session_id}`, {
          headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` },
        })
        const session = await sessionRes.json() as any
        if (!sessionRes.ok || !session.payment_intent) { refundFailed++; continue }

        const refundRes = await fetch('https://api.stripe.com/v1/refunds', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ payment_intent: session.payment_intent }),
        })
        if (refundRes.ok) refunded++
        else refundFailed++
      } catch (err) {
        console.error('Refund failed for enrollment', e.id, err)
        refundFailed++
      }
    }
  }

  await c.env.DB.prepare('DELETE FROM enrollments WHERE seminar_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM seminars WHERE id = ?').bind(id).run()
  return c.json({ ok: true, refunded, refund_failed: refundFailed })
})

// ─── 申込 ─────────────────────────────────────────────────────────

// 申込一覧（管理者）
app.get('/api/admin/enrollments', authMiddleware, adminMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, s.title as seminar_title, u.email, u.name
     FROM enrollments e
     JOIN seminars s ON e.seminar_id = s.id
     JOIN users u ON e.user_id = u.id
     ORDER BY e.created_at DESC`
  ).all()
  return c.json(results)
})

// セミナー別申込一覧（管理者）
app.get('/api/admin/seminars/:id/enrollments', authMiddleware, adminMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, u.email, u.name FROM enrollments e
     JOIN users u ON e.user_id = u.id
     WHERE e.seminar_id = ? ORDER BY e.created_at DESC`
  ).bind(c.req.param('id')).all()
  return c.json(results)
})

// 自分の申込一覧
app.get('/api/my/enrollments', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, s.title, s.date, s.location, s.format, s.thumbnail_url FROM enrollments e
     JOIN seminars s ON e.seminar_id = s.id
     WHERE e.user_id = ? ORDER BY s.date DESC`
  ).bind(c.get('userId')).all()
  return c.json(results)
})

// 領収書表示用データ（支払済み申込・本人のみ）
app.get('/api/my/enrollments/:id/receipt', authMiddleware, async (c) => {
  const enrollment = await c.env.DB.prepare(
    `SELECT e.id, e.amount, e.created_at, s.title
     FROM enrollments e JOIN seminars s ON e.seminar_id = s.id
     WHERE e.id = ? AND e.user_id = ? AND e.status = 'paid'`
  ).bind(c.req.param('id'), c.get('userId')).first<any>()
  if (!enrollment) return c.json({ error: '対象の申込が見つかりません' }, 404)
  return c.json(enrollment)
})

// ─── Stripe決済 ───────────────────────────────────────────────────

// クーポンコード確認（申込画面での事前プレビュー用）
app.post('/api/seminars/:id/coupon-check', authMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const { coupon_code } = await c.req.json()

  const seminar = await c.env.DB.prepare(
    'SELECT price, coupon_code, coupon_discount_type, coupon_discount_value FROM seminars WHERE id = ? AND status = ?'
  ).bind(seminarId, 'published').first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)

  const discounted = applyCoupon(seminar, coupon_code)
  if (discounted === null) return c.json({ error: 'クーポンコードが無効です' }, 400)

  return c.json({ ok: true, price: seminar.price, discounted_price: discounted })
})

// Checkoutセッション作成
app.post('/api/seminars/:id/checkout', authMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const userId = c.get('userId')
  const { coupon_code, participation_type, profession, experience_years } = await c.req.json().catch(() => ({ coupon_code: null, participation_type: null, profession: null, experience_years: null }))

  const seminar = await c.env.DB.prepare(
    'SELECT * FROM seminars WHERE id = ? AND status = ?'
  ).bind(seminarId, 'published').first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)

  // 職種・経験年数（申込フォームで収集しusersに保存。未指定なら既存値を維持＝後方互換）
  const PROFESSIONS = ['理学療法士', '作業療法士', '言語聴覚士', '看護師', '介護職', '柔道整復師・鍼灸師', '学生', 'その他']
  const EXPERIENCE_YEARS = ['1〜3年', '4〜9年', '10〜19年', '20年以上', '学生']
  if (profession || experience_years) {
    if (profession && !PROFESSIONS.includes(profession)) return c.json({ error: '職種の選択が正しくありません' }, 400)
    if (experience_years && !EXPERIENCE_YEARS.includes(experience_years)) return c.json({ error: '経験年数の選択が正しくありません' }, 400)
    await c.env.DB.prepare(
      'UPDATE users SET profession = COALESCE(?, profession), experience_years = COALESCE(?, experience_years) WHERE id = ?'
    ).bind(profession || null, experience_years || null, userId).run()
  }

  let participationType: string | null = null
  if (seminar.format === 'hybrid') {
    if (participation_type !== 'online' && participation_type !== 'onsite') {
      return c.json({ error: '参加方法（オンライン／現地）を選択してください' }, 400)
    }
    participationType = participation_type
  }

  let price = seminar.price
  if (coupon_code) {
    const discounted = applyCoupon(seminar, coupon_code)
    if (discounted === null) return c.json({ error: 'クーポンコードが無効です' }, 400)
    price = discounted
  }

  const now = Date.now()
  if (seminar.enrollment_start && now < parseJstDate(seminar.enrollment_start)!) {
    return c.json({ error: 'まだ申込受付が開始していません' }, 400)
  }
  // 通常の申込受付終了後でも、アーカイブ動画が視聴期限内であればアーカイブ視聴目的の申込を許可する
  const archiveAvailable = !!seminar.archive_video_url
    && (!seminar.archive_expires_at || parseJstDate(seminar.archive_expires_at)! > now)
  if (seminar.enrollment_end && now > parseJstDate(seminar.enrollment_end)! && !archiveAvailable) {
    return c.json({ error: '申込受付は終了しました' }, 400)
  }

  // capacity 0（未入力）は定員無制限扱い
  if (seminar.capacity > 0 && seminar.enrolled_count >= seminar.capacity) return c.json({ error: '満席です' }, 400)

  const existing = await c.env.DB.prepare(
    'SELECT id, status FROM enrollments WHERE seminar_id = ? AND user_id = ?'
  ).bind(seminarId, userId).first<any>()
  if (existing?.status === 'paid') return c.json({ error: '既に申込済みです' }, 409)

  const user = await c.env.DB.prepare('SELECT email, name FROM users WHERE id = ?').bind(userId).first<any>()

  const enrollmentId = existing?.id || newId()
  if (!existing) {
    await c.env.DB.prepare(
      'INSERT INTO enrollments (id, seminar_id, user_id, status, participation_type) VALUES (?, ?, ?, ?, ?)'
    ).bind(enrollmentId, seminarId, userId, 'pending', participationType).run()
  } else if (participationType) {
    await c.env.DB.prepare(
      'UPDATE enrollments SET participation_type = ? WHERE id = ?'
    ).bind(participationType, enrollmentId).run()
  }

  // 無料セミナー（クーポン適用後を含む）は決済をスキップして申込確定
  if (price === 0) {
    const result = await c.env.DB.prepare(
      `UPDATE enrollments SET status = 'paid', amount = 0 WHERE id = ? AND status != 'paid'`
    ).bind(enrollmentId).run()
    if (result.meta.changes > 0) {
      await c.env.DB.prepare(
        `UPDATE seminars SET enrolled_count = enrolled_count + 1 WHERE id = ?`
      ).bind(seminarId).run()
      await sendEnrollmentConfirmation(c.env, user.email, user.name, seminar, participationType)
    }
    return c.json({ url: `${c.env.FRONTEND_URL}/payment-success.html?free=1` })
  }

  // Stripe Checkout セッション作成
  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'payment_method_types[]': 'card',
      'mode': 'payment',
      'customer_email': user.email,
      'line_items[0][price_data][currency]': 'jpy',
      'line_items[0][price_data][product_data][name]': seminar.title,
      'line_items[0][price_data][unit_amount]': String(price),
      'line_items[0][quantity]': '1',
      'metadata[enrollment_id]': enrollmentId,
      'metadata[seminar_id]': seminarId,
      'metadata[user_id]': userId,
      'success_url': `${c.env.FRONTEND_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${c.env.FRONTEND_URL}/seminar-detail.html?id=${seminarId}`,
    }),
  })

  const session = await stripeRes.json() as any
  if (!stripeRes.ok) {
    console.error('Stripe checkout session creation failed:', stripeRes.status, JSON.stringify(session))
    return c.json({ error: '決済の準備に失敗しました' }, 500)
  }

  await c.env.DB.prepare(
    'UPDATE enrollments SET stripe_session_id = ? WHERE id = ?'
  ).bind(session.id, enrollmentId).run()

  return c.json({ url: session.url })
})

// Stripe Webhook
app.post('/api/webhook/stripe', async (c) => {
  const sig = c.req.header('stripe-signature') || ''
  const body = await c.req.text()

  const valid = await verifyStripeSignature(body, sig, c.env.STRIPE_WEBHOOK_SECRET)
  if (!valid) return c.json({ error: 'Invalid signature' }, 400)

  let event: any
  try {
    event = JSON.parse(body)
  } catch {
    return c.json({ error: 'Invalid payload' }, 400)
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const { enrollment_id, seminar_id } = session.metadata || {}

    if (enrollment_id) {
      // 冪等: pending のときだけ paid に更新しカウントを増やす
      const result = await c.env.DB.prepare(
        `UPDATE enrollments SET status = 'paid', amount = ? WHERE id = ? AND status != 'paid'`
      ).bind(session.amount_total, enrollment_id).run()
      if (result.meta.changes > 0 && seminar_id) {
        await c.env.DB.prepare(
          `UPDATE seminars SET enrolled_count = enrolled_count + 1 WHERE id = ?`
        ).bind(seminar_id).run()

        const enrollment = await c.env.DB.prepare(
          `SELECT e.user_id, e.participation_type, s.id, s.title, s.date, s.session_dates, s.location, s.format, s.zoom_url
           FROM enrollments e JOIN seminars s ON e.seminar_id = s.id WHERE e.id = ?`
        ).bind(enrollment_id).first<any>()
        if (enrollment) {
          const user = await c.env.DB.prepare('SELECT email, name FROM users WHERE id = ?').bind(enrollment.user_id).first<any>()
          if (user) await sendEnrollmentConfirmation(c.env, user.email, user.name, enrollment, enrollment.participation_type)
        }
      }
    }

  }

  return c.json({ ok: true })
})

// ─── アーカイブ（セミナー申込者限定） ─────────────────────────────

// 自分が視聴可能なアーカイブ一覧（支払済み申込 かつ 動画URL設定済み かつ 期限内）
app.get('/api/my/archives', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.date, s.thumbnail_url, s.archive_video_url as video_url, s.archive_expires_at as expires_at
     FROM enrollments e
     JOIN seminars s ON e.seminar_id = s.id
     WHERE e.user_id = ? AND e.status = 'paid' AND s.archive_video_url IS NOT NULL
       AND (s.archive_expires_at IS NULL OR s.archive_expires_at > datetime('now'))
     ORDER BY s.date DESC`
  ).bind(c.get('userId')).all()
  return c.json(results)
})

// アーカイブ動画URL・視聴期限を一括お知らせ（管理者・Resend経由メール送信）
app.post('/api/admin/seminars/:id/notify-archive', authMiddleware, adminMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const seminar = await c.env.DB.prepare(
    'SELECT title, archive_video_url FROM seminars WHERE id = ?'
  ).bind(seminarId).first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)
  if (!seminar.archive_video_url) return c.json({ error: '先にアーカイブ動画URLを設定してください' }, 400)
  if (!c.env.RESEND_API_KEY) return c.json({ error: 'メール送信が未設定です（RESEND_API_KEY）' }, 500)

  const { results: recipients } = await c.env.DB.prepare(
    `SELECT u.email, u.name FROM enrollments e JOIN users u ON e.user_id = u.id
     WHERE e.seminar_id = ? AND e.status = 'paid'`
  ).bind(seminarId).all<any>()

  if (recipients.length === 0) return c.json({ error: '申込者がいません' }, 400)

  const archiveUrl = `${c.env.FRONTEND_URL}/mypage-video.html`
  let sent = 0
  for (const r of recipients) {
    const ok = await sendEmail(
      c.env,
      r.email,
      `【Rewalk】「${seminar.title}」アーカイブ動画が視聴可能になりました`,
      `${r.name || ''}様\n\n「${seminar.title}」のアーカイブ動画が視聴可能になりました。\n下記のマイページからご視聴ください。\n\n${archiveUrl}\n\n※視聴可能期間が過ぎるとご覧いただけなくなりますのでご注意ください。`
    )
    if (ok) sent++
  }

  return c.json({ ok: true, sent, total: recipients.length })
})

// セミナー申込受付開始を全登録者へお知らせするメールを送信（管理者・Resend経由）
async function sendEnrollmentOpenEmails(env: Bindings, seminar: any): Promise<{ sent: number; total: number }> {
  const { results: recipients } = await env.DB.prepare(`SELECT email, name FROM users`).all<any>()
  if (recipients.length === 0) return { sent: 0, total: 0 }

  const detailUrl = `${env.FRONTEND_URL}/seminar-detail.html?id=${seminar.id}`
  const formatLabel = seminar.format === 'offline' ? '対面' : seminar.format === 'hybrid' ? 'ハイブリッド' : 'オンライン'
  const priceLabel = seminar.price > 0 ? `${Number(seminar.price).toLocaleString()}円` : '無料'
  const detailLines = [
    `【開催日時】${rwFormatDateForEmail(seminar.date)}`,
    `【形式】${formatLabel}${seminar.format !== 'online' ? `（${seminar.location}）` : ''}`,
    `【参加費】${priceLabel}`,
  ].join('\n')

  let sent = 0
  for (const r of recipients) {
    const ok = await sendEmail(
      env,
      r.email,
      `【Rewalk】「${seminar.title}」の申込受付を開始しました`,
      `${r.name || ''}様\n\n「${seminar.title}」の申込受付を開始しました。\n\n${detailLines}\n\n下記より詳細のご確認・お申込みができます。\n定員になり次第、受付を終了しますのでお早めにお申込みください。`,
      { label: '詳細を見る・申し込む', url: detailUrl },
      seminar.thumbnail_url || undefined
    )
    if (ok) sent++
  }
  await env.DB.prepare(`UPDATE seminars SET enrollment_notify_sent_at = datetime('now') WHERE id = ?`).bind(seminar.id).run()
  return { sent, total: recipients.length }
}

// 受付開始日時が到来したセミナーのうち、予約済みでまだ送信していないものを一斉送信（毎日のcronから呼ばれる）
async function sendScheduledEnrollmentOpenNotifications(env: Bindings): Promise<void> {
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT id, title, date, format, location, price, thumbnail_url, enrollment_start FROM seminars
     WHERE enrollment_notify_scheduled_at IS NOT NULL
       AND enrollment_notify_sent_at IS NULL
       AND enrollment_start IS NOT NULL`
  ).all<any>()

  for (const s of results) {
    const startTime = parseJstDate(s.enrollment_start)
    if (startTime === null || startTime > now) continue
    await sendEnrollmentOpenEmails(env, s)
  }
}

// セミナー申込受付開始のお知らせを予約（受付開始日時より前なら予約のみ、開始済みなら即時送信）
app.post('/api/admin/seminars/:id/notify-enrollment-open', authMiddleware, adminMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const seminar = await c.env.DB.prepare(
    'SELECT id, title, date, format, location, price, thumbnail_url, enrollment_start, enrollment_notify_sent_at FROM seminars WHERE id = ?'
  ).bind(seminarId).first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)
  if (seminar.enrollment_notify_sent_at) return c.json({ error: 'このセミナーの受付開始お知らせはすでに送信済みです' }, 400)
  if (!c.env.RESEND_API_KEY) return c.json({ error: 'メール送信が未設定です（RESEND_API_KEY）' }, 500)

  const startTime = parseJstDate(seminar.enrollment_start)
  if (startTime !== null && startTime > Date.now()) {
    await c.env.DB.prepare(
      `UPDATE seminars SET enrollment_notify_scheduled_at = datetime('now') WHERE id = ?`
    ).bind(seminarId).run()
    return c.json({ ok: true, scheduled: true })
  }

  const { sent, total } = await sendEnrollmentOpenEmails(c.env, seminar)
  if (total === 0) return c.json({ error: '登録者がいません' }, 400)
  return c.json({ ok: true, scheduled: false, sent, total })
})

// ─── ユーザー管理（管理者） ────────────────────────────────────────

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.created_at,
       (SELECT COUNT(*) FROM enrollments e WHERE e.user_id = u.id AND e.status = 'paid') as paid_enrollments
     FROM users u ORDER BY u.created_at DESC`
  ).all()
  return c.json(results)
})

// 全会員へ任意メールを一斉送信（管理者）
app.post('/api/admin/broadcast', authMiddleware, adminMiddleware, async (c) => {
  const { subject, body } = await c.req.json()
  if (!subject || !body) return c.json({ error: '件名と本文は必須です' }, 400)
  if (!c.env.RESEND_API_KEY) return c.json({ error: 'メール送信が未設定です（RESEND_API_KEY）' }, 500)

  const { results: recipients } = await c.env.DB.prepare(`SELECT email, name FROM users`).all<any>()
  if (recipients.length === 0) return c.json({ error: '会員がいません' }, 400)

  const signature = `

──────────────────────
Rewalk Science
${c.env.FRONTEND_URL}
──────────────────────`

  let sent = 0
  for (const r of recipients) {
    const ok = await sendEmail(c.env, r.email, subject, `${r.name || ''}様\n\n${body}${signature}`)
    if (ok) sent++
  }

  return c.json({ ok: true, sent, total: recipients.length })
})

// LINE公式アカウント登録者への一斉配信（管理者）
app.post('/api/admin/line-broadcast', authMiddleware, adminMiddleware, async (c) => {
  const { title, message } = await c.req.json()
  if (!title || !message) return c.json({ error: 'タイトルと本文は必須です' }, 400)
  if (!c.env.LINE_HARNESS_API_URL || !c.env.LINE_HARNESS_API_KEY) {
    return c.json({ error: 'LINE配信が未設定です（LINE_HARNESS_API_URL / LINE_HARNESS_API_KEY）' }, 500)
  }

  const headers = {
    Authorization: `Bearer ${c.env.LINE_HARNESS_API_KEY}`,
    'Content-Type': 'application/json',
  }

  const createRes = await c.env.LINE_HARNESS.fetch(`${c.env.LINE_HARNESS_API_URL}/api/broadcasts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, messageType: 'text', messageContent: message, targetType: 'all' }),
  })
  const created = await createRes.json() as any
  if (!createRes.ok || !created.data?.id) {
    return c.json({ error: created.error || 'LINE配信の作成に失敗しました' }, 502)
  }

  const sendRes = await c.env.LINE_HARNESS.fetch(`${c.env.LINE_HARNESS_API_URL}/api/broadcasts/${created.data.id}/send`, {
    method: 'POST',
    headers,
  })
  const sent = await sendRes.json() as any
  if (!sendRes.ok) {
    return c.json({ error: sent.error || 'LINE配信の送信に失敗しました' }, 502)
  }

  return c.json({ ok: true, totalCount: sent.data?.totalCount ?? 0, successCount: sent.data?.successCount ?? 0 })
})

// ユーザーrole変更（管理者）
app.put('/api/admin/users/:id/role', authMiddleware, adminMiddleware, async (c) => {
  const { role } = await c.req.json()
  if (role !== 'admin' && role !== 'user') return c.json({ error: 'roleはadminまたはuserです' }, 400)
  const targetId = c.req.param('id')
  if (targetId === c.get('userId') && role !== 'admin') {
    return c.json({ error: '自分自身の管理者権限は外せません' }, 400)
  }
  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, targetId).run()
  return c.json({ ok: true })
})

// 開催3日前リマインドメールの自動送信（Cron Triggerで毎日実行）
// 複数開催日（session_dates）のセミナーは各開催日ごとにリマインドを送る
async function sendReminders(env: Bindings): Promise<void> {
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT e.id as enrollment_id, e.participation_type, e.reminder_sent_at, e.reminder_sent_dates, u.email, u.name,
       s.id, s.title, s.date, s.session_dates, s.location, s.format, s.zoom_url
     FROM enrollments e
     JOIN users u ON u.id = e.user_id
     JOIN seminars s ON s.id = e.seminar_id
     WHERE e.status = 'paid'`
  ).all<any>()

  for (const row of results) {
    const sentDates: string[] = parseJsonArray(row.reminder_sent_dates).map(String)
    // 旧方式（reminder_sent_at）で送信済みの申込は、メイン開催日を送信済み扱いにする
    if (row.reminder_sent_at && !sentDates.includes(row.date)) sentDates.push(row.date)

    let changed = false
    for (const d of allSeminarDates(row)) {
      const seminarTime = parseJstDate(d)
      if (seminarTime === null) continue
      const daysUntil = (seminarTime - now) / 86400000
      // 開催3日前を過ぎたタイミングで（Cronが毎日実行されるため、2〜3日前の幅で捕捉）
      if (daysUntil > 3 || daysUntil < 2) continue
      if (sentDates.includes(d)) continue

      await sendReminderEmail(
        env,
        row.email,
        row.name,
        { id: row.id, title: row.title, date: d, location: row.location, format: row.format, zoom_url: row.zoom_url },
        row.participation_type
      )
      sentDates.push(d)
      changed = true
    }

    if (changed) {
      await env.DB.prepare(
        `UPDATE enrollments SET reminder_sent_dates = ?, reminder_sent_at = COALESCE(reminder_sent_at, datetime('now')) WHERE id = ?`
      ).bind(JSON.stringify(sentDates), row.enrollment_id).run()
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    // リマインドは毎朝06:00 JSTのcronのみ。受付開始お知らせは10分間隔のcronで日時到来を検知して即送信
    if (event.cron === '0 21 * * *') ctx.waitUntil(sendReminders(env))
    ctx.waitUntil(sendScheduledEnrollmentOpenNotifications(env))
  },
}
