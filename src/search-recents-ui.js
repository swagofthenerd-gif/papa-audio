'use strict'
// The one recent-searches dropdown every search box shares (roadmap J2).
//
// Before: the music bar had its own dropdown (relative times, per-row ✕ that
// collapsed the whole list), the library box a second one (no times, no ✕),
// Movies & TV a strip of chips (no times, "clear all" only), Soulseek nothing.
// Same idea, four looks, three of them missing something.
//
// This widget paints ONE dropdown under any input from the shared memory
// (search-memory.js): this box's own recents first, then what was searched on
// other surfaces tagged with where. Every row shows when it happened and what
// was opened from it, has its own ✕ (which re-paints, never closes), and the
// whole list is keyboard-navigable (↑ ↓ Enter, Escape). Clicking a row hands
// the query to the box (`onPick`), which commits it however it commits.
//
// DOM-only glue, deliberately thin: all list logic lives in the pure store.
// Loaded before renderer.js; the renderer registers hideAll() with its
// navigation-dismiss registry once, so a dropdown never floats over the next
// page.
;(function () {
  var BLUR_GRACE_MS = 150
  var byId = Object.create(null) // surface → the currently attached widget

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  var CLOCK = '<svg class="recents-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2 5l-1.5 1.3A9 9 0 1 0 13 3zm-1 5v5l4 2 .7-1.2-3.2-1.9V8z"/></svg>'

  function rowHtml(e, i, group, SM) {
    var opened = SM.lastOpened(e)
    var meta = ''
    if (group === 'elsewhere') meta += '<span class="recents-from">' + esc(e.fromLabel) + '</span>'
    if (opened) meta += '<span class="recents-opened" title="Opened from this search">&rarr; ' + esc(opened.label) + '</span>'
    var when = SM.relativeTime(group === 'elsewhere' ? e.ts : (e.surfaces && e.surfaces[byIdSurface(e)] || e.ts))
    return '<div class="recents-row" role="option" data-idx="' + i + '" data-q="' + esc(e.q) + '">' +
      CLOCK +
      '<span class="recents-q">' + esc(e.q) + '</span>' +
      (meta ? '<span class="recents-meta">' + meta + '</span>' : '') +
      (when ? '<span class="recents-time">' + esc(when) + '</span>' : '') +
      '<button class="recents-del" data-q="' + esc(e.q) + '" title="Forget this search" aria-label="Forget this search">&#10005;</button>' +
    '</div>'
  }
  // Rows are painted for one surface at a time; the paint sets this so the
  // "own" group can show the time it was searched on THIS box.
  var _paintSurface = null
  function byIdSurface() { return _paintSurface }

  // opts: { input, container, surface, store, onPick(query, entry),
  //         filterWhileTyping, limit, elsewhereLimit, emptyOnly }
  function attach(opts) {
    var input = opts.input
    var container = opts.container
    var store = opts.store
    var SM = window.PapaSearchMemory
    if (!input || !container || !store || !SM) return null
    var surface = opts.surface || 'music'
    var limit = opts.limit || 8
    var elsewhereLimit = opts.elsewhereLimit != null ? opts.elsewhereLimit : 3
    var filterWhileTyping = !!opts.filterWhileTyping

    var open = false
    var active = -1
    var rows = []
    var blurTimer = null
    var insideMouse = false

    function currentFilter() {
      var v = (input.value || '').trim()
      if (!v) return ''
      return filterWhileTyping ? v : null // null = "do not show at all"
    }

    function paint() {
      var f = currentFilter()
      if (f === null) { hide(); return }
      _paintSurface = surface
      var r = store.recent(surface, { filter: f, limit: limit, elsewhereLimit: elsewhereLimit })
      if (!r.own.length && !r.elsewhere.length) { hide(); return }
      var html = ''
      var i = 0
      rows = []
      if (r.own.length) {
        html += '<div class="recents-head">' + (f ? 'Matching recent searches' : 'Recent searches') + '</div>'
        r.own.forEach(function (e) { html += rowHtml(e, i++, 'own', SM); rows.push(e) })
      }
      if (r.elsewhere.length) {
        html += '<div class="recents-head">Searched elsewhere</div>'
        r.elsewhere.forEach(function (e) { html += rowHtml(e, i++, 'elsewhere', SM); rows.push(e) })
      }
      if (r.own.length) {
        html += '<button class="recents-clear" type="button">Clear this box’s history</button>'
      }
      container.innerHTML = html
      container.hidden = false
      container.classList.add('open')
      container.setAttribute('role', 'listbox')
      open = true
      setActive(-1)
    }

    function hide() {
      if (!open && container.hidden) return
      open = false
      active = -1
      rows = []
      container.classList.remove('open')
      container.hidden = true
      container.innerHTML = ''
    }

    function setActive(idx) {
      var els = container.querySelectorAll('.recents-row')
      if (!els.length) { active = -1; return }
      if (idx < -1) idx = els.length - 1
      if (idx >= els.length) idx = -1
      active = idx
      for (var k = 0; k < els.length; k++) els[k].classList.toggle('active', k === active)
      if (active >= 0 && els[active].scrollIntoView) {
        try { els[active].scrollIntoView({ block: 'nearest' }) } catch (_) {}
      }
    }

    function pick(q, entry) {
      hide()
      try { opts.onPick(q, entry) } catch (e) { try { console.error('[papa][recents] onPick failed:', e && e.message) } catch (_) {} }
    }

    // ── Wiring ──────────────────────────────────────────────────────────────
    function onFocus() { clearTimeout(blurTimer); paint() }
    function onInput() { paint() }
    function onBlur() {
      clearTimeout(blurTimer)
      blurTimer = setTimeout(function () { if (!insideMouse) hide() }, BLUR_GRACE_MS)
    }
    function onKey(e) {
      if (!open) return
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); e.stopImmediatePropagation(); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); e.stopImmediatePropagation(); return }
      if (e.key === 'Enter' && active >= 0 && rows[active]) {
        e.preventDefault(); e.stopImmediatePropagation()
        input.value = rows[active].q
        pick(rows[active].q, rows[active])
        return
      }
      if (e.key === 'Escape') { hide() } // the box's own handler then clears the text
    }
    function onContainerMouseDown(e) {
      // mousedown, not click: the input's blur would tear the list down first.
      e.preventDefault()
      insideMouse = true
      setTimeout(function () { insideMouse = false }, 0)
      var del = e.target.closest && e.target.closest('.recents-del')
      if (del) {
        store.remove(del.dataset.q)
        paint() // re-paint in place — the verified bug was the whole list collapsing
        if (!open) input.focus()
        return
      }
      if (e.target.closest && e.target.closest('.recents-clear')) {
        store.clear(surface)
        paint()
        return
      }
      var row = e.target.closest && e.target.closest('.recents-row')
      if (row) {
        var idx = parseInt(row.dataset.idx, 10)
        var entry = rows[idx]
        input.value = row.dataset.q
        pick(row.dataset.q, entry)
      }
    }

    input.addEventListener('focus', onFocus)
    input.addEventListener('input', onInput)
    input.addEventListener('blur', onBlur)
    // Capture so the widget sees ↑ ↓ Enter before the box's own commit handler
    // and can claim them (stopImmediatePropagation) only when a row is active.
    input.addEventListener('keydown', onKey, true)
    container.addEventListener('mousedown', onContainerMouseDown)

    var widget = {
      surface: surface,
      show: paint,
      hide: hide,
      refresh: function () { if (open) paint() },
      isOpen: function () { return open },
      destroy: function () {
        hide()
        input.removeEventListener('focus', onFocus)
        input.removeEventListener('input', onInput)
        input.removeEventListener('blur', onBlur)
        input.removeEventListener('keydown', onKey, true)
        container.removeEventListener('mousedown', onContainerMouseDown)
        if (byId[surface] === widget) delete byId[surface]
      },
    }
    // A re-render that rebuilds the input attaches again; the stale widget
    // must not keep listening on a detached node.
    if (byId[surface] && byId[surface] !== widget) { try { byId[surface].destroy() } catch (_) {} }
    byId[surface] = widget
    return widget
  }

  function hideAll() {
    for (var s in byId) { try { byId[s].hide() } catch (_) {} }
  }

  function get(surface) { return byId[surface] || null }

  window.PapaSearchRecentsUI = { attach: attach, hideAll: hideAll, get: get, _esc: esc }
})()
