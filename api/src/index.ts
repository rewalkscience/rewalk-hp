import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { hashPassword, verifyPassword, createJWT, verifyJWT, verifyStripeSignature } from './auth'

type Bindings = {
  DB: D1Database
  SESSIONS: KVNamespace
  JWT_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  FRONTEND_URL: string
  RESEND_API_KEY: string
  RESEND_FROM_EMAIL: string
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
async function sendEmail(env: Bindings, to: string, subject: string, text: string): Promise<boolean> {
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
■開催日時：${when}
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

function rwFormatDateForEmail(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── 認証 ────────────────────────────────────────────────────────

// 会員登録
app.post('/api/auth/register', async (c) => {
  const { email, password, name, affiliation } = await c.req.json()
  if (!email || !password) return c.json({ error: 'メールとパスワードは必須です' }, 400)
  if (password.length < 8) return c.json({ error: 'パスワードは8文字以上にしてください' }, 400)

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
    `${name || ''}様\n\nRewalkへの会員登録が完了しました。\nセミナーの申込・アーカイブ動画の視聴などがマイページからご利用いただけます。\n\n${c.env.FRONTEND_URL}/mypage.html\n\n最新のセミナー情報は随時お届けします。`
  )

  return c.json({ token, user: { id, email, name, affiliation, role: 'user' } })
})

// ログイン
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  if (!email || !password) return c.json({ error: 'メールとパスワードを入力してください' }, 400)

  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, name, role FROM users WHERE email = ?'
  ).bind(email).first<{ id: string; email: string; password_hash: string; name: string; role: string }>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401)
  }

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
    'SELECT id, email, name, affiliation, role, created_at FROM users WHERE id = ?'
  ).bind(c.get('userId')).first()
  if (!user) return c.json({ error: 'ユーザーが見つかりません' }, 404)
  return c.json(user)
})

// ─── セミナー（公開） ─────────────────────────────────────────────

// 一覧（公開済みのみ）
app.get('/api/seminars', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, date, location, format, price, capacity, enrolled_count, thumbnail_url,
       enrollment_start, enrollment_end
     FROM seminars WHERE status = 'published' ORDER BY date ASC`
  ).all()
  return c.json(results)
})

// 過去の開催セミナー（終了分・公開情報のみ）
app.get('/api/seminars-past', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, date, format, thumbnail_url FROM seminars WHERE status = 'closed' ORDER BY date DESC LIMIT 12`
  ).all()
  return c.json(results)
})

// 詳細
app.get('/api/seminars/:id', async (c) => {
  const seminar = await c.env.DB.prepare(
    `SELECT id, title, description, date, location, format, price, capacity, enrolled_count, thumbnail_url, status,
       enrollment_start, enrollment_end
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
    `SELECT title, archive_video_url, archive_expires_at FROM seminars WHERE id = ?`
  ).bind(seminarId).first<any>()
  if (!seminar || !seminar.archive_video_url) return c.json({ error: 'アーカイブ動画は未公開です' }, 404)

  if (seminar.archive_expires_at && parseJstDate(seminar.archive_expires_at)! < Date.now()) {
    return c.json({ error: '視聴可能期間が終了しました' }, 403)
  }

  return c.json({ title: seminar.title, video_url: seminar.archive_video_url, expires_at: seminar.archive_expires_at })
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
  const { title, description, date, location, format, price, capacity, thumbnail_url, zoom_url, status,
    enrollment_start, enrollment_end, archive_video_url, archive_expires_at,
    coupon_code, coupon_discount_type, coupon_discount_value } = body
  if (!title || !date || !location) return c.json({ error: 'タイトル・日時・場所は必須です' }, 400)

  const id = newId()
  await c.env.DB.prepare(
    `INSERT INTO seminars (id, title, description, date, location, format, price, capacity, thumbnail_url, zoom_url, status,
       enrollment_start, enrollment_end, coupon_code, coupon_discount_type, coupon_discount_value, archive_video_url, archive_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, title, description || null, date, location, format || 'online',
    price || 0, capacity || 20, thumbnail_url || null, zoom_url || null, status || 'draft',
    enrollment_start || null, enrollment_end || null,
    coupon_code || null, coupon_discount_type || null, coupon_discount_value || null,
    archive_video_url || null, archive_expires_at || null).run()

  return c.json({ id }, 201)
})

// セミナー更新
app.put('/api/admin/seminars/:id', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json()
  const { title, description, date, location, format, price, capacity, thumbnail_url, zoom_url, status,
    enrollment_start, enrollment_end, archive_video_url, archive_expires_at,
    coupon_code, coupon_discount_type, coupon_discount_value } = body
  const id = c.req.param('id')

  await c.env.DB.prepare(
    `UPDATE seminars SET title=?, description=?, date=?, location=?, format=?, price=?,
     capacity=?, thumbnail_url=?, zoom_url=?, status=?,
     enrollment_start=?, enrollment_end=?, coupon_code=?, coupon_discount_type=?, coupon_discount_value=?,
     archive_video_url=?, archive_expires_at=?,
     updated_at=datetime('now') WHERE id=?`
  ).bind(title, description || null, date, location, format, price, capacity,
    thumbnail_url || null, zoom_url || null, status,
    enrollment_start || null, enrollment_end || null,
    coupon_code || null, coupon_discount_type || null, coupon_discount_value || null,
    archive_video_url || null, archive_expires_at || null, id).run()

  return c.json({ ok: true })
})

// セミナー削除
app.delete('/api/admin/seminars/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param('id')
  const enrolled = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM enrollments WHERE seminar_id = ? AND status = 'paid'`
  ).bind(id).first<{ cnt: number }>()
  if (enrolled && enrolled.cnt > 0) return c.json({ error: '申込済みユーザーがいるため削除できません' }, 400)

  await c.env.DB.prepare('DELETE FROM seminars WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
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
  const { coupon_code, participation_type } = await c.req.json().catch(() => ({ coupon_code: null, participation_type: null }))

  const seminar = await c.env.DB.prepare(
    'SELECT * FROM seminars WHERE id = ? AND status = ?'
  ).bind(seminarId, 'published').first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)

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
  if (seminar.enrollment_end && now > parseJstDate(seminar.enrollment_end)!) {
    return c.json({ error: '申込受付は終了しました' }, 400)
  }

  if (seminar.enrolled_count >= seminar.capacity) return c.json({ error: '満席です' }, 400)

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
          `SELECT e.user_id, e.participation_type, s.id, s.title, s.date, s.location, s.format, s.zoom_url
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

// セミナー申込受付開始を全登録者に一斉お知らせ（管理者・Resend経由メール送信）
app.post('/api/admin/seminars/:id/notify-enrollment-open', authMiddleware, adminMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const seminar = await c.env.DB.prepare(
    'SELECT title FROM seminars WHERE id = ?'
  ).bind(seminarId).first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)
  if (!c.env.RESEND_API_KEY) return c.json({ error: 'メール送信が未設定です（RESEND_API_KEY）' }, 500)

  const { results: recipients } = await c.env.DB.prepare(
    `SELECT email, name FROM users`
  ).all<any>()

  if (recipients.length === 0) return c.json({ error: '登録者がいません' }, 400)

  const detailUrl = `${c.env.FRONTEND_URL}/seminar-detail.html?id=${seminarId}`
  let sent = 0
  for (const r of recipients) {
    const ok = await sendEmail(
      c.env,
      r.email,
      `【Rewalk】「${seminar.title}」の申込受付を開始しました`,
      `${r.name || ''}様\n\n「${seminar.title}」の申込受付を開始しました。\n下記より詳細のご確認・お申込みができます。\n\n${detailUrl}\n\n定員になり次第、受付を終了しますのでお早めにお申込みください。`
    )
    if (ok) sent++
  }

  return c.json({ ok: true, sent, total: recipients.length })
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

  let sent = 0
  for (const r of recipients) {
    const ok = await sendEmail(c.env, r.email, subject, `${r.name || ''}様\n\n${body}`)
    if (ok) sent++
  }

  return c.json({ ok: true, sent, total: recipients.length })
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

export default app
