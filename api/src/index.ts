import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { hashPassword, verifyPassword, createJWT, verifyJWT } from './auth'

type Bindings = {
  DB: D1Database
  SESSIONS: KVNamespace
  JWT_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  FRONTEND_URL: string
}

type Variables = {
  userId: string
  userRole: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('*', cors({
  origin: (origin) => origin,
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
  c.set('userId', payload.sub as string)
  c.set('userRole', payload.role as string)
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

// ─── 認証 ────────────────────────────────────────────────────────

// 会員登録
app.post('/api/auth/register', async (c) => {
  const { email, password, name } = await c.req.json()
  if (!email || !password) return c.json({ error: 'メールとパスワードは必須です' }, 400)
  if (password.length < 8) return c.json({ error: 'パスワードは8文字以上にしてください' }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: 'このメールアドレスは既に登録されています' }, 409)

  const id = newId()
  const passwordHash = await hashPassword(password)
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)'
  ).bind(id, email, passwordHash, name || null).run()

  const token = await createJWT({ sub: id, role: 'user' }, c.env.JWT_SECRET)
  await c.env.SESSIONS.put(`session:${token}`, id, { expirationTtl: 60 * 60 * 24 * 30 })

  return c.json({ token, user: { id, email, name, role: 'user' } })
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
    'SELECT id, email, name, role, created_at FROM users WHERE id = ?'
  ).bind(c.get('userId')).first()
  if (!user) return c.json({ error: 'ユーザーが見つかりません' }, 404)
  return c.json(user)
})

// ─── セミナー（公開） ─────────────────────────────────────────────

// 一覧（公開済みのみ）
app.get('/api/seminars', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, date, location, format, price, capacity, enrolled_count, thumbnail_url
     FROM seminars WHERE status = 'published' ORDER BY date ASC`
  ).all()
  return c.json(results)
})

// 詳細
app.get('/api/seminars/:id', async (c) => {
  const seminar = await c.env.DB.prepare(
    `SELECT id, title, description, date, location, format, price, capacity, enrolled_count, thumbnail_url, status
     FROM seminars WHERE id = ?`
  ).bind(c.req.param('id')).first()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)
  return c.json(seminar)
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
  const { title, description, date, location, format, price, capacity, thumbnail_url, zoom_url, status } = body
  if (!title || !date || !location) return c.json({ error: 'タイトル・日時・場所は必須です' }, 400)

  const id = newId()
  await c.env.DB.prepare(
    `INSERT INTO seminars (id, title, description, date, location, format, price, capacity, thumbnail_url, zoom_url, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, title, description || null, date, location, format || 'online',
    price || 0, capacity || 20, thumbnail_url || null, zoom_url || null, status || 'draft').run()

  return c.json({ id }, 201)
})

// セミナー更新
app.put('/api/admin/seminars/:id', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json()
  const { title, description, date, location, format, price, capacity, thumbnail_url, zoom_url, status } = body
  const id = c.req.param('id')

  await c.env.DB.prepare(
    `UPDATE seminars SET title=?, description=?, date=?, location=?, format=?, price=?,
     capacity=?, thumbnail_url=?, zoom_url=?, status=?, updated_at=datetime('now') WHERE id=?`
  ).bind(title, description || null, date, location, format, price, capacity,
    thumbnail_url || null, zoom_url || null, status, id).run()

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
    `SELECT e.*, s.title, s.date, s.location, s.format FROM enrollments e
     JOIN seminars s ON e.seminar_id = s.id
     WHERE e.user_id = ? ORDER BY s.date DESC`
  ).bind(c.get('userId')).all()
  return c.json(results)
})

// ─── Stripe決済 ───────────────────────────────────────────────────

// Checkoutセッション作成
app.post('/api/seminars/:id/checkout', authMiddleware, async (c) => {
  const seminarId = c.req.param('id')
  const userId = c.get('userId')

  const seminar = await c.env.DB.prepare(
    'SELECT * FROM seminars WHERE id = ? AND status = ?'
  ).bind(seminarId, 'published').first<any>()
  if (!seminar) return c.json({ error: 'セミナーが見つかりません' }, 404)

  if (seminar.enrolled_count >= seminar.capacity) return c.json({ error: '満席です' }, 400)

  const existing = await c.env.DB.prepare(
    'SELECT id, status FROM enrollments WHERE seminar_id = ? AND user_id = ?'
  ).bind(seminarId, userId).first<any>()
  if (existing?.status === 'paid') return c.json({ error: '既に申込済みです' }, 409)

  const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<any>()

  const enrollmentId = existing?.id || newId()
  if (!existing) {
    await c.env.DB.prepare(
      'INSERT INTO enrollments (id, seminar_id, user_id, status) VALUES (?, ?, ?, ?)'
    ).bind(enrollmentId, seminarId, userId, 'pending').run()
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
      'line_items[0][price_data][unit_amount]': String(seminar.price),
      'line_items[0][quantity]': '1',
      'metadata[enrollment_id]': enrollmentId,
      'metadata[seminar_id]': seminarId,
      'metadata[user_id]': userId,
      'success_url': `${c.env.FRONTEND_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${c.env.FRONTEND_URL}/seminar-detail.html?id=${seminarId}`,
    }),
  })

  const session = await stripeRes.json() as any
  if (!stripeRes.ok) return c.json({ error: '決済の準備に失敗しました' }, 500)

  await c.env.DB.prepare(
    'UPDATE enrollments SET stripe_session_id = ? WHERE id = ?'
  ).bind(session.id, enrollmentId).run()

  return c.json({ url: session.url })
})

// Stripe Webhook
app.post('/api/webhook/stripe', async (c) => {
  const sig = c.req.header('stripe-signature') || ''
  const body = await c.req.text()

  // Webhook署名検証（簡易版）
  // 本番では stripe-signature を HMAC-SHA256 で検証する
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
      await c.env.DB.prepare(
        `UPDATE enrollments SET status = 'paid', amount = ? WHERE id = ?`
      ).bind(session.amount_total, enrollment_id).run()
      await c.env.DB.prepare(
        `UPDATE seminars SET enrolled_count = enrolled_count + 1 WHERE id = ?`
      ).bind(seminar_id).run()
    }
  }

  return c.json({ ok: true })
})

// ─── アーカイブ ───────────────────────────────────────────────────

// 公開アーカイブ一覧
app.get('/api/archives', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, price, seminar_id, created_at FROM archives WHERE status = 'published' ORDER BY created_at DESC`
  ).all()
  return c.json(results)
})

// アーカイブ詳細（購入済みなら動画URLも返す）
app.get('/api/archives/:id', authMiddleware, async (c) => {
  const archive = await c.env.DB.prepare(
    'SELECT * FROM archives WHERE id = ? AND status = ?'
  ).bind(c.req.param('id'), 'published').first<any>()
  if (!archive) return c.json({ error: 'アーカイブが見つかりません' }, 404)

  const purchased = await c.env.DB.prepare(
    'SELECT id FROM archive_purchases WHERE archive_id = ? AND user_id = ?'
  ).bind(c.req.param('id'), c.get('userId')).first()

  return c.json({ ...archive, video_url: purchased ? archive.video_url : null, purchased: !!purchased })
})

// アーカイブCRUD（管理者）
app.post('/api/admin/archives', authMiddleware, adminMiddleware, async (c) => {
  const { title, description, video_url, price, seminar_id, status } = await c.req.json()
  if (!title || !video_url) return c.json({ error: 'タイトルと動画URLは必須です' }, 400)
  const id = newId()
  await c.env.DB.prepare(
    'INSERT INTO archives (id, title, description, video_url, price, seminar_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, title, description || null, video_url, price || 0, seminar_id || null, status || 'draft').run()
  return c.json({ id }, 201)
})

app.put('/api/admin/archives/:id', authMiddleware, adminMiddleware, async (c) => {
  const { title, description, video_url, price, status } = await c.req.json()
  await c.env.DB.prepare(
    `UPDATE archives SET title=?, description=?, video_url=?, price=?, status=?, updated_at=datetime('now') WHERE id=?`
  ).bind(title, description || null, video_url, price, status, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.delete('/api/admin/archives/:id', authMiddleware, adminMiddleware, async (c) => {
  await c.env.DB.prepare('DELETE FROM archives WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ─── ユーザー管理（管理者） ────────────────────────────────────────

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC'
  ).all()
  return c.json(results)
})

export default app
