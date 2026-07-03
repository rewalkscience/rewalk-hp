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
