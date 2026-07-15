// Rewalk API 共通クライアント
const API_BASE = 'https://rewalk-api.rewalk-science.workers.dev/api'

function rwToken() { return localStorage.getItem('rw_token') }
function rwUser() {
  try { return JSON.parse(localStorage.getItem('rw_user') || 'null') } catch { return null }
}
function rwIsAdmin() { return localStorage.getItem('rw_role') === 'admin' }

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  const token = rwToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers })
  let data = null
  try { data = await res.json() } catch { /* 空レスポンス */ }
  if (res.status === 401) {
    // セッション切れ → ログインへ（公開ページでは呼び出し側が制御）
    if (opts.redirectOn401 !== false) {
      rwClearSession()
      location.href = 'auth-login.html'
      return new Promise(() => {}) // 遷移中は解決しない
    }
  }
  if (!res.ok) throw new Error((data && data.error) || `エラーが発生しました (${res.status})`)
  return data
}

function rwClearSession() {
  localStorage.removeItem('rw_token')
  localStorage.removeItem('rw_role')
  localStorage.removeItem('rw_user')
}

async function rwLogout() {
  try { await apiFetch('/auth/logout', { method: 'POST', redirectOn401: false }) } catch { /* noop */ }
  rwClearSession()
  location.href = 'index.html'
}

// ログイン必須ページ用ガード
function requireAuth() {
  if (!rwToken()) { location.href = 'auth-login.html'; return false }
  return true
}

// 管理者専用ページ用ガード
function requireAdmin() {
  if (!rwToken()) { location.href = 'auth-login.html'; return false }
  if (!rwIsAdmin()) { location.href = 'mypage.html'; return false }
  return true
}

// 表示ユーティリティ
function rwFormatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function rwFormatPrice(n) {
  return n === 0 ? '無料' : `¥${Number(n).toLocaleString()}`
}
function rwStripHtml(html) {
  const div = document.createElement('div')
  div.innerHTML = html || ''
  return div.textContent || ''
}
function rwEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// JSON文字列カラム（session_dates / archive_videos / materials）を安全に配列化
function rwJsonArray(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  try {
    const a = JSON.parse(v)
    return Array.isArray(a) ? a : []
  } catch { return [] }
}
// セミナーの全開催日（date + session_dates）。複数開催セットに対応
function rwSeminarDates(s) {
  return [s.date, ...rwJsonArray(s.session_dates)].filter(Boolean)
}
// タイムゾーンなしの日時文字列をJSTとして解釈（Workers側parseJstDateと同じ規約）
function rwParseJst(d) {
  if (!d) return NaN
  const hasTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(d)
  return new Date(hasTz ? d : `${d}+09:00`).getTime()
}
// 最終開催日の時刻。複数開催セットは最終日が過ぎるまで「開催予定」扱い
function rwLastSeminarTime(s) {
  const times = rwSeminarDates(s).map(rwParseJst).filter(t => !isNaN(t))
  return times.length ? Math.max(...times) : NaN
}
// 開催日の表示文字列。複数日程は「第1回 〜」形式で改行区切り
function rwFormatSeminarDates(s, separator = ' / ') {
  const dates = rwSeminarDates(s)
  if (dates.length <= 1) return rwFormatDate(s.date)
  return dates.map((d, i) => `第${i + 1}回 ${rwFormatDate(d)}`).join(separator)
}
// 残席表示: 定員0(未設定)は非表示、残り20名未満で「残り◯名」、それ以外は「定員◯名」
function rwSeatsLabel(s) {
  const cap = Number(s.capacity) || 0
  if (cap <= 0) return ''
  const remaining = Math.max(0, cap - (s.enrolled_count ?? 0))
  if (remaining <= 0) return '満席'
  return remaining < 20 ? `残り${remaining}名` : `定員${cap}名`
}
