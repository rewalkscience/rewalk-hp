/* 管理画面のモバイル用ドロワーナビ。
   全admin-*.htmlはサイドバー(.side)が10ファイルにベタ書きされているため、
   HTML側は<link>と<script>の2行追加だけで済むよう、トップバーとオーバーレイはJSで生成する。 */
(function () {
  function init() {
    var shell = document.querySelector('.shell')
    var side = document.querySelector('.side')
    if (!shell || !side || document.querySelector('.admin-topbar')) return

    var title = ''
    var h1 = document.querySelector('.main h1')
    if (h1) title = h1.textContent.trim()
    if (!title) title = (document.title || '').split('|')[0].trim()

    var bar = document.createElement('div')
    bar.className = 'admin-topbar'
    bar.innerHTML =
      '<button type="button" class="admin-topbar-toggle" aria-label="メニューを開く" aria-expanded="false">' +
      '<span></span><span></span><span></span></button>' +
      '<img class="admin-topbar-logo" src="assets/logo/rewalk-logo-mark.png" alt="">' +
      '<span class="admin-topbar-title"></span>'
    bar.querySelector('.admin-topbar-title').textContent = title
    document.body.insertBefore(bar, shell)

    var overlay = document.createElement('div')
    overlay.className = 'admin-nav-overlay'
    document.body.appendChild(overlay)

    var toggle = bar.querySelector('.admin-topbar-toggle')

    function setOpen(open) {
      document.body.classList.toggle('admin-nav-open', open)
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      toggle.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く')
    }

    toggle.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('admin-nav-open'))
    })
    overlay.addEventListener('click', function () { setOpen(false) })
    side.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false)
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false)
    })
    // PC幅に戻したときに開きっぱなしにしない
    window.addEventListener('resize', function () {
      if (window.innerWidth > 1080) setOpen(false)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
