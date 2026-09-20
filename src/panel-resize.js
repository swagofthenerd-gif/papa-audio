// One resizer for every side panel in the app.
//
// Before this file each panel that could be resized had grown its own copy of
// the same twenty lines (see the queue panel's old initResizableQueue), and
// every panel that had not grown a copy simply could not be resized. attach()
// is that behaviour once: a grab strip on the named edge, a width remembered
// under a key, a double-click that puts it back, and optionally a small
// chevron that folds the panel down to a slim rail and back.
//
// Everything that decides a number — clamping, what a drag delta means on a
// left versus a right edge, what a stored string is worth — is a pure function
// at the top of this file and is tested in node. attach() only wires.
;(function () {
  const COLLAPSED_W = 28
  const GRIP_W = 6
  // A panel may never eat the whole window; this much always stays behind it.
  const WINDOW_MARGIN = 120

  function clamp(px, min, max) {
    const n = Math.round(Number(px))
    const lo = Number(min)
    const hi = Number(max)
    if (!isFinite(n)) return lo
    if (!(hi >= lo)) return lo
    return Math.max(lo, Math.min(hi, n))
  }

  // The ceiling a panel may actually reach right now. `max` is the design
  // intent; the window is the hard fact, and a panel wider than its window is
  // a panel with no close button on screen.
  function effectiveMax(max, windowWidth) {
    const w = Number(windowWidth)
    if (!isFinite(w) || w <= 0) return Number(max)
    return Math.max(1, Math.min(Number(max), Math.round(w - WINDOW_MARGIN)))
  }

  // A left-edge panel is anchored to the right of the window, so dragging the
  // pointer LEFT (a negative delta) makes it wider. A right-edge panel is the
  // other way round.
  function nextWidth(opts) {
    const o = opts || {}
    const dx = Number(o.dx) || 0
    const signed = o.edge === 'left' ? -dx : dx
    return clamp(Number(o.startPx) + signed, o.min, effectiveMax(o.max, o.windowWidth))
  }

  function collapsedKey(key) { return String(key) + ':collapsed' }

  // What the panel should look like given whatever the two stored strings hold.
  // localStorage is hand-editable and survives a redesign that moves the min or
  // the max, so nothing here trusts what it reads: a width outside the range is
  // clamped back in, and anything unreadable falls back to the default.
  function readState(rawWidth, rawCollapsed, opts) {
    const o = opts || {}
    const min = Number(o.min)
    const max = Number(o.max)
    const def = clamp(o.defaultPx, min, max)
    const n = parseFloat(String(rawWidth == null ? '' : rawWidth))
    const width = isFinite(n) && n > 0 ? clamp(n, min, max) : def
    return { width, collapsed: String(rawCollapsed) === '1' }
  }

  function writeWidth(px) { return String(Math.round(Number(px) || 0)) }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function attach(opts) {
    const o = opts || {}
    const el = o.el
    if (!el || typeof document === 'undefined') return null
    if (el.dataset && el.dataset.papaPrOn === '1') return null
    const edge = o.edge === 'right' ? 'right' : 'left'
    const key = String(o.key || '')
    const min = Number(o.min) || 160
    const max = Number(o.max) || 720
    const defaultPx = Number(o.defaultPx) || min
    const cssVar = o.cssVar || null

    const read = (k) => { try { return localStorage.getItem(k) } catch (_) { return null } }
    const write = (k, v) => { try { localStorage.setItem(k, v) } catch (_) {} }

    const state = readState(read(key), read(collapsedKey(key)), { min, max, defaultPx })
    let width = state.width
    let collapsed = state.collapsed

    function paint() {
      const px = collapsed ? COLLAPSED_W : width
      if (cssVar) el.style.setProperty(cssVar, px + 'px')
      else el.style.width = px + 'px'
      el.classList.toggle('papa-pr-collapsed', collapsed)
      if (toggle) {
        // The chevron always points at what pressing it will do.
        toggle.textContent = (edge === 'left') === collapsed ? '‹' : '›'
        toggle.setAttribute('aria-expanded', String(!collapsed))
        toggle.title = collapsed ? 'Expand panel' : 'Collapse panel'
        toggle.setAttribute('aria-label', toggle.title)
      }
      grip.style.display = collapsed ? 'none' : ''
    }

    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'

    const grip = document.createElement('div')
    grip.className = 'papa-pr-grip papa-pr-grip-' + edge
    grip.setAttribute('aria-hidden', 'true')
    grip.style.width = GRIP_W + 'px'

    let toggle = null
    if (o.collapsible) {
      toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'papa-pr-toggle papa-pr-toggle-' + edge
      toggle.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        collapsed = !collapsed
        write(collapsedKey(key), collapsed ? '1' : '0')
        paint()
      })
      el.appendChild(toggle)
    }

    let id = null
    let startX = 0
    let startW = 0
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      id = e.pointerId
      startX = e.clientX
      startW = el.offsetWidth
      grip.classList.add('is-dragging')
      try { grip.setPointerCapture(e.pointerId) } catch (_) {}
    })
    grip.addEventListener('pointermove', (e) => {
      if (id !== e.pointerId) return
      width = nextWidth({
        startPx: startW, dx: e.clientX - startX, edge, min, max,
        windowWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
      })
      paint()
    })
    const end = (e) => {
      if (id !== e.pointerId) return
      id = null
      grip.classList.remove('is-dragging')
      try { grip.releasePointerCapture(e.pointerId) } catch (_) {}
      write(key, writeWidth(width))
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      width = clamp(defaultPx, min, max)
      write(key, writeWidth(width))
      paint()
    })
    el.appendChild(grip)
    if (el.dataset) el.dataset.papaPrOn = '1'
    paint()

    return {
      el,
      get width() { return width },
      get collapsed() { return collapsed },
      setCollapsed(v) { collapsed = !!v; write(collapsedKey(key), collapsed ? '1' : '0'); paint() },
      detach() {
        grip.remove()
        if (toggle) toggle.remove()
        el.classList.remove('papa-pr-collapsed')
        if (cssVar) el.style.removeProperty(cssVar)
        else el.style.width = ''
        if (el.dataset) delete el.dataset.papaPrOn
      },
    }
  }

  const api = {
    attach, clamp, nextWidth, readState, writeWidth, collapsedKey, effectiveMax,
    COLLAPSED_W, GRIP_W, WINDOW_MARGIN,
  }
  if (typeof window !== 'undefined') window.PapaPanelResize = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
