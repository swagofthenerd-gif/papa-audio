'use strict';
// The theatre control deck.
//
// mpv paints into its own frameless child window via --wid, and a native child
// window sits above the page's compositing layer — HTML drawn "over" the video
// is simply invisible behind it. So this deck never overlaps the stage: it
// reports the stage rectangle to main, which positions the mpv window onto it,
// and every control lives outside that rectangle.
//
// State arrives on the throttled `video-state` stream (~4/s). The deck is a
// pure function of that state apart from one exception: while the user is
// dragging the seek bar, incoming positions are ignored, or the knob would
// fight the pointer.
//
// UMD-wrapped like ttl-cache.js so it loads as a classic script.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoPlayer = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const ICON = {
    play:  '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>',
    vol:   '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12z"/></svg>',
    mute:  '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45A5 5 0 0 0 16.5 12zM19 12a7 7 0 0 1-1.1 3.74l1.500 1.5A8.9 8.9 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3zM12 4l-2.1 2.1L12 8.2z"/></svg>',
    tick:  '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  }

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

  function fmtTime(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0))
    const h = Math.floor(n / 3600)
    const m = Math.floor((n % 3600) / 60)
    const s = n % 60
    const pad = v => String(v).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  }

  function create(opts) {
    opts = opts || {}
    const doc = opts.document || (typeof document !== 'undefined' ? document : null)
    const api = opts.api || (typeof window !== 'undefined' ? window.api : null)
    const keymap = opts.keymap || (typeof window !== 'undefined' ? window.PapaVideoKeymap : null)
    const skipModel = opts.skipModel || (typeof window !== 'undefined' ? window.PapaSkipModel : null)
    const onExit = opts.onExit || function () {}
    const onNext = opts.onNext || null
    // The renderer persists progress from here rather than opening a second
    // subscription to the same throttled stream.
    const onState = opts.onState || null

    const $ = id => doc && doc.getElementById(id)

    let state = null
    let segments = []
    let prefs = {}
    let tracks = { sub: [], audio: [] }
    let dragging = false
    let unsubscribe = null
    let boundsTimer = null
    let autoSkipTimer = null
    let autoSkipUntil = 0
    let lastSkipShown = null
    let lastMarkDuration = -1
    let minimised = false
    let upNextTimer = null
    let upNextLeft = 0
    let upNextInfo = null
    let upNextDismissed = false
    let media = null   // { title, sub, next }

    // ── Stage geometry ──────────────────────────────────────────────────────
    // main positions the mpv window onto this rectangle. It has to be re-sent
    // on any resize, or the video and its frame drift apart.
    function reportBounds() {
      const stage = $('vt-stage')
      if (!stage || !api || !api.videoSurfaceBounds) return Promise.resolve(false)
      const r = stage.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return Promise.resolve(false)
      return api.videoSurfaceBounds({
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      }).then(function () { return true }).catch(function () { return false })
    }

    // Resolves once main has been told where the video belongs. The caller
    // must await this before starting playback: showing the mpv window before
    // its rectangle is known puts it on screen at its creation size, floating
    // over the app as a separate window — which is exactly the bug this
    // prevents. Layout is forced synchronously rather than waited for over two
    // animation frames, because the play call cannot be delayed by frames.
    function ready() {
      const stage = $('vt-stage')
      if (stage) void stage.offsetHeight   // force layout now
      return reportBounds()
    }
    function scheduleBounds() {
      clearTimeout(boundsTimer)
      boundsTimer = setTimeout(reportBounds, 60)
    }

    // ── Rendering ───────────────────────────────────────────────────────────
    function render() {
      if (!state) return
      const dur = Number(state.duration) || 0
      const pos = Number(state.position) || 0

      const play = $('vt-play')
      if (play) {
        play.innerHTML = state.paused ? ICON.play : ICON.pause
        play.setAttribute('aria-label', state.paused ? 'Play' : 'Pause')
      }

      if (!dragging) paintSeek(pos, dur)

      const posEl = $('vt-pos'); if (posEl) posEl.textContent = fmtTime(pos)
      const durEl = $('vt-dur'); if (durEl) durEl.textContent = fmtTime(dur)

      const mute = $('vt-mute')
      if (mute) {
        mute.innerHTML = state.muted || state.volume === 0 ? ICON.mute : ICON.vol
        mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute')
      }
      const vol = $('vt-vol')
      if (vol && doc.activeElement !== vol) vol.value = String(Math.round(state.volume || 0))

      const speed = $('vt-speed')
      if (speed) {
        speed.textContent = (Number(state.speed) || 1) + '×'
        speed.classList.toggle('on', Number(state.speed) !== 1)
      }

      const subs = $('vt-subs')
      if (subs) subs.classList.toggle('on', state.tracks && state.tracks.sub != null)

      paintBadges()
      paintMini()
      // Segments are set before the first state tick, when the duration is
      // still 0 and the marks cannot be positioned. Repaint whenever the
      // duration changes, or they would never appear at all.
      if (dur !== lastMarkDuration) { lastMarkDuration = dur; paintMarks() }
      paintSkip(pos)
      paintUpNext(pos, dur)
    }

    function paintSeek(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0
      const fill = $('vt-seek-fill'); if (fill) fill.style.width = pct + '%'
      const knob = $('vt-seek-knob'); if (knob) knob.style.left = pct + '%'
      const buf = $('vt-seek-buffer')
      if (buf && dur > 0) {
        const ahead = Math.min(dur, pos + (Number(state && state.buffered) || 0))
        buf.style.width = Math.min(100, (ahead / dur) * 100) + '%'
      }
      const seek = $('vt-seek')
      if (seek) {
        seek.setAttribute('aria-valuemax', String(Math.round(dur)))
        seek.setAttribute('aria-valuenow', String(Math.round(pos)))
        seek.setAttribute('aria-valuetext', fmtTime(pos) + ' of ' + fmtTime(dur))
      }
    }

    function paintMini() {
      const mini = $('vmini')
      if (!mini || mini.classList.contains('hidden') || !state) return
      const dur = Number(state.duration) || 0
      const pos = Number(state.position) || 0
      const play = $('vmini-play')
      if (play) {
        play.innerHTML = state.paused ? ICON.play : ICON.pause
        play.setAttribute('aria-label', state.paused ? 'Play' : 'Pause')
      }
      const fill = $('vmini-fill')
      if (fill) fill.style.width = (dur > 0 ? Math.min(100, (pos / dur) * 100) : 0) + '%'
      const time = $('vmini-time')
      if (time) time.textContent = fmtTime(pos)
    }

    // mpv reports every alias a codec has ever had, so the badge read
    // "H.264 / AVC / MPEG-4 AVC / MPEG-4 PART 10" — a line of text wider than
    // the title next to it. The first name is the one anybody uses.
    function shortCodec(codec) {
      const first = String(codec == null ? '' : codec).split('/')[0].trim()
      if (!first) return ''
      return first.length > 12 ? first.slice(0, 12).trim().toUpperCase() : first.toUpperCase()
    }

    function paintBadges() {
      const box = $('vt-badges')
      if (!box || !state) return
      const out = []
      const h = state.video && state.video.height
      if (h) out.push('<span class="vt-badge">' + (h >= 2000 ? '4K' : h + 'p') + '</span>')
      const layout = state.audio && state.audio.layout
      if (layout && layout !== 'unknown') {
        out.push('<span class="vt-badge' + (layout === '5.1' || layout === '7.1' ? ' vt-badge-hi' : '') + '">' + layout + '</span>')
      }
      const codec = shortCodec(state.video && state.video.codec)
      if (codec) out.push('<span class="vt-badge">' + codec + '</span>')
      box.innerHTML = out.join('')
    }

    function paintMarks() {
      const box = $('vt-seek-marks')
      const dur = Number(state && state.duration) || 0
      if (!box) return
      if (!dur || !segments.length) { box.innerHTML = ''; return }
      box.innerHTML = segments.map(function (seg) {
        const left = Math.max(0, (seg.start / dur) * 100)
        const width = Math.max(0.4, ((seg.end - seg.start) / dur) * 100)
        return '<div class="vt-seek-mark ' + (seg.kind === 'credits' ? 'credits' : '') +
          '" style="left:' + left + '%;width:' + width + '%"></div>'
      }).join('')
    }

    // ── Skip ────────────────────────────────────────────────────────────────
    // The strip only exists when something is in it, so it does not reserve
    // empty space under the video for the whole film.
    function syncStrip() {
      const strip = $('vt-strip')
      if (!strip) return
      const skip = $('vt-skip')
      const up = $('vt-upnext')
      strip.hidden = (!skip || skip.hidden) && (!up || up.hidden)
    }

    function paintSkip(pos) {
      const box = $('vt-skip')
      if (!box || !skipModel) return
      const btn = skipModel.buttonFor(segments, pos, prefs)
      if (!btn) {
        if (!box.hidden) { box.hidden = true; box.innerHTML = ''; syncStrip() }
        lastSkipShown = null
        cancelAutoSkip()
        return
      }
      // Re-render only when the offer changes, so the countdown is not reset
      // four times a second by the state stream.
      const sig = btn.segment.kind + ':' + btn.segment.start + ':' + btn.action
      if (sig === lastSkipShown) return
      lastSkipShown = sig
      box.hidden = false
      syncStrip()

      if (btn.action === 'auto') {
        // An automatic skip still shows for a beat with a visible cancel, so it
        // is never something that just happens to you.
        box.innerHTML = '<button type="button" id="vt-skip-btn">' + escapeHtml(btn.label) +
          ' <span class="vt-skip-count" id="vt-skip-count">4</span></button>'
        startAutoSkip(btn.segment)
      } else {
        box.innerHTML = '<button type="button" id="vt-skip-btn">' + escapeHtml(btn.label) + '</button>'
      }
      const b = $('vt-skip-btn')
      if (b) {
        b.addEventListener('click', function () {
          if (autoSkipTimer) { cancelAutoSkip(); box.hidden = true; return }
          doSkip(btn.segment)
        })
      }
    }

    function startAutoSkip(segment) {
      cancelAutoSkip()
      autoSkipUntil = 4
      autoSkipTimer = setInterval(function () {
        autoSkipUntil--
        const c = $('vt-skip-count')
        if (c) c.textContent = String(Math.max(0, autoSkipUntil))
        if (autoSkipUntil <= 0) { cancelAutoSkip(); doSkip(segment) }
      }, 1000)
    }

    function cancelAutoSkip() {
      if (autoSkipTimer) { clearInterval(autoSkipTimer); autoSkipTimer = null }
    }

    function doSkip(segment) {
      cancelAutoSkip()
      const box = $('vt-skip')
      if (box) { box.hidden = true; box.innerHTML = ''; syncStrip() }
      lastSkipShown = null
      // Credits at the very end means "this is over" — go to the next episode
      // rather than seeking to a black frame and sitting there.
      const dur = Number(state && state.duration) || 0
      if (segment.kind === 'credits' && dur && segment.end >= dur - 1 && onNext) return onNext()
      send('seek', { seconds: segment.end, mode: 'absolute' })
    }

    // ── Up Next ─────────────────────────────────────────────────────────────
    // Triggered by the credits segment when there is one, otherwise by the
    // tail of the file. Either way it fires while something is still on
    // screen, never after the picture has already gone black.
    const UPNEXT_SECONDS = 10

    function upNextTrigger(pos, dur) {
      if (!dur || !onNext) return false
      const credits = segments.find(function (s) { return s.kind === 'credits' && s.end >= dur - 2 })
      if (credits) return pos >= credits.start
      // No credits information: fall back to the last 45 seconds, which is
      // late enough not to interrupt a film that simply has a quiet ending.
      return pos >= dur - 45
    }

    function paintUpNext(pos, dur) {
      const box = $('vt-upnext')
      if (!box) return
      if (!upNextTrigger(pos, dur) || upNextDismissed) {
        if (!box.hidden) { box.hidden = true; box.innerHTML = ''; stopUpNext(); syncStrip() }
        return
      }
      if (!box.hidden) return   // already showing; the countdown owns it now
      box.hidden = false
      syncStrip()
      const n = upNextInfo || {}
      const still = n.still
        ? '<img class="vt-upnext-still" src="' + escapeHtml(n.still) + '" alt="" ' +
          'onerror="this.style.visibility=\'hidden\'">'
        : '<div class="vt-upnext-still"></div>'
      box.innerHTML = still +
        '<div class="vt-upnext-body">' +
          '<div class="vt-upnext-kicker">Up next</div>' +
          '<div class="vt-upnext-title">' + escapeHtml(n.title || 'Next episode') + '</div>' +
          (n.subtitle ? '<div class="vt-upnext-sub">' + escapeHtml(n.subtitle) + '</div>' : '') +
          '<div class="vt-upnext-actions">' +
            '<button type="button" class="vt-upnext-go" id="vt-upnext-go">Play now</button>' +
            '<button type="button" id="vt-upnext-stay">Watch credits</button>' +
          '</div>' +
        '</div>' +
        '<div class="vt-ring" id="vt-upnext-ring">' +
          '<svg viewBox="0 0 34 34"><circle class="bg" cx="17" cy="17" r="14"></circle>' +
          '<circle class="fg" cx="17" cy="17" r="14" id="vt-ring-fg"></circle></svg>' +
          '<div class="vt-ring-num" id="vt-ring-num">' + UPNEXT_SECONDS + '</div>' +
        '</div>'
      $('vt-upnext-go')?.addEventListener('click', function () { stopUpNext(); onNext() })
      $('vt-upnext-stay')?.addEventListener('click', function () {
        // Dismissed for this file only — it must not reappear thirty seconds
        // later having been explicitly declined.
        upNextDismissed = true
        stopUpNext()
        box.hidden = true
        box.innerHTML = ''
        syncStrip()
      })
      startUpNext()
    }

    function startUpNext() {
      stopUpNext()
      upNextLeft = UPNEXT_SECONDS
      const circumference = 2 * Math.PI * 14
      const ring = $('vt-ring-fg')
      if (ring) {
        ring.setAttribute('stroke-dasharray', String(circumference))
        ring.setAttribute('stroke-dashoffset', '0')
      }
      upNextTimer = setInterval(function () {
        upNextLeft--
        const num = $('vt-ring-num')
        if (num) num.textContent = String(Math.max(0, upNextLeft))
        const fg = $('vt-ring-fg')
        if (fg) fg.setAttribute('stroke-dashoffset',
          String(circumference * (1 - Math.max(0, upNextLeft) / UPNEXT_SECONDS)))
        if (upNextLeft <= 0) { stopUpNext(); if (onNext) onNext() }
      }, 1000)
    }

    function stopUpNext() {
      if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null }
    }

    // ── Season pack episodes ────────────────────────────────────────────────
    // The pack streaming right now already contains these, so choosing one is
    // a file change on a live torrent rather than a fresh search.
    let packFiles = []

    function setPack(files, onSelect) {
      packFiles = Array.isArray(files) ? files : []
      const box = $('vt-pack')
      const list = $('vt-pack-list')
      if (!box || !list) return
      if (packFiles.length < 2) { box.hidden = true; list.innerHTML = ''; return }
      box.hidden = false
      const label = $('vt-pack-label')
      if (label) label.textContent = packFiles.length + ' episodes'
      list.innerHTML = packFiles.map(function (f, i) {
        // An unnumbered file still needs a handle; its position is the least
        // wrong thing to show.
        const name = f.episode != null ? String(f.episode) : String(i + 1)
        return '<button class="vt-ep' + (f.current ? ' current' : '') + '"' +
          ' data-file="' + f.index + '"' +
          ' title="' + escapeHtml(f.name) + '"' +
          (f.current ? ' aria-current="true"' : '') +
          ' aria-label="Episode ' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>'
      }).join('')
      list.querySelectorAll('.vt-ep').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.classList.contains('current')) return
          if (onSelect) onSelect(Number(b.dataset.file))
        })
      })
      const cur = list.querySelector('.vt-ep.current')
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' })
    }

    function clearPack() {
      packFiles = []
      const box = $('vt-pack')
      const list = $('vt-pack-list')
      if (box) box.hidden = true
      if (list) list.innerHTML = ''
    }

    function setUpNext(info) {
      upNextInfo = info || null
      upNextDismissed = false
    }

    function escapeHtml(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    // ── Commands ────────────────────────────────────────────────────────────
    function send(verb, args) {
      if (!api || !api.videoControl) return Promise.resolve({ ok: false })
      return api.videoControl(verb, args || {}).catch(function () { return { ok: false } })
    }

    function togglePlay() { send(state && state.paused ? 'play' : 'pause') }
    function seekBy(sec) { send('seek', { seconds: sec, mode: 'relative' }) }
    function seekTo(sec) { send('seek', { seconds: sec, mode: 'absolute' }) }

    function setVolume(v) {
      const next = Math.max(0, Math.min(130, Math.round(v)))
      send('volume', { value: next })
      if (state) state.volume = next
    }

    function bumpSpeed(dir) {
      const cur = Number(state && state.speed) || 1
      let i = SPEEDS.indexOf(cur)
      if (i === -1) i = SPEEDS.indexOf(1)
      i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir))
      send('speed', { value: SPEEDS[i] })
    }

    // ── Menus ───────────────────────────────────────────────────────────────
    function closeMenu() {
      const m = $('vt-menu')
      if (m) { m.classList.add('hidden'); m.innerHTML = '' }
    }

    function openMenu(anchorId, html, bind) {
      const m = $('vt-menu')
      const anchor = $(anchorId)
      if (!m || !anchor) return
      m.innerHTML = html
      m.classList.remove('hidden')
      const r = anchor.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      // Clamped to the viewport so a menu near the right edge stays on screen.
      m.style.left = Math.max(8, Math.min(r.left, (doc.documentElement.clientWidth || 0) - mr.width - 8)) + 'px'
      m.style.top = Math.max(8, r.top - mr.height - 8) + 'px'
      if (bind) bind(m)
      const first = m.querySelector('.vt-menu-item')
      if (first) first.focus()
    }

    function menuItem(label, on, note) {
      return '<button class="vt-menu-item' + (on ? ' on' : '') + '" role="menuitem">' +
        '<span class="vt-menu-tick">' + (on ? ICON.tick : '') + '</span>' +
        '<span class="vt-menu-label">' + escapeHtml(label) + '</span>' +
        (note ? '<span class="vt-menu-note">' + escapeHtml(note) + '</span>' : '') +
      '</button>'
    }

    async function openTrackMenu(type) {
      const res = api && api.videoTracks ? await api.videoTracks().catch(function () { return null }) : null
      const all = (res && res.ok && Array.isArray(res.tracks)) ? res.tracks : []
      tracks[type] = all.filter(function (t) { return t.type === type })
      const current = state && state.tracks ? state.tracks[type] : null
      const list = tracks[type]

      let html = '<div class="vt-menu-head">' + (type === 'sub' ? 'Subtitles' : 'Audio') + '</div>'
      if (type === 'sub') html += menuItem('Off', current == null)
      if (!list.length) {
        html += '<div class="vt-menu-row">' + (type === 'sub'
          ? 'No subtitle tracks in this file'
          : 'One audio track only') + '</div>'
      }
      html += list.map(function (t) {
        const label = [t.lang, t.title].filter(Boolean).join(' · ') || ('Track ' + t.id)
        const note = [t.codec, t.forced ? 'forced' : null, t.external ? 'external' : null].filter(Boolean).join(' ')
        return menuItem(label, current === t.id, note)
      }).join('')

      if (type === 'sub') {
        html += '<div class="vt-menu-sep"></div>' +
          '<div class="vt-menu-row">Delay<span class="vt-menu-val" id="vt-subdelay">0 ms</span>' +
          '<button class="vt-chip" data-delay="-50">&minus;50</button>' +
          '<button class="vt-chip" data-delay="50">+50</button></div>'
      } else {
        html += '<div class="vt-menu-sep"></div>' +
          '<div class="vt-menu-row">Delay<span class="vt-menu-val" id="vt-auddelay">0 ms</span>' +
          '<button class="vt-chip" data-adelay="-50">&minus;50</button>' +
          '<button class="vt-chip" data-adelay="50">+50</button></div>'
      }

      openMenu(type === 'sub' ? 'vt-subs' : 'vt-audio', html, function (m) {
        const items = Array.prototype.slice.call(m.querySelectorAll('.vt-menu-item'))
        items.forEach(function (el, i) {
          el.addEventListener('click', function () {
            const offset = type === 'sub' ? 1 : 0
            const id = (type === 'sub' && i === 0) ? null : (list[i - offset] && list[i - offset].id)
            send('track', { type: type, id: id })
            if (state && state.tracks) state.tracks[type] = id
            closeMenu()
            render()
          })
        })
        bindDelay(m, '[data-delay]', 'delay', 'subDelay', 'vt-subdelay')
        bindDelay(m, '[data-adelay]', 'adelay', 'audioDelay', 'vt-auddelay')
      })
    }

    // Torrent releases desync constantly; nudging is the fix and it has to be
    // reachable while watching, not buried in settings.
    let delayMs = { subDelay: 0, audioDelay: 0 }
    function bindDelay(menu, selector, dataKey, verb, valueId) {
      menu.querySelectorAll(selector).forEach(function (b) {
        b.addEventListener('click', function () {
          delayMs[verb] += Number(b.dataset[dataKey])
          send(verb, { seconds: delayMs[verb] / 1000 })
          const el = doc.getElementById(valueId)
          if (el) el.textContent = delayMs[verb] + ' ms'
        })
      })
    }

    function openSpeedMenu() {
      const cur = Number(state && state.speed) || 1
      const html = '<div class="vt-menu-head">Playback speed</div>' +
        SPEEDS.map(function (v) { return menuItem(v + '×', v === cur) }).join('')
      openMenu('vt-speed', html, function (m) {
        m.querySelectorAll('.vt-menu-item').forEach(function (el, i) {
          el.addEventListener('click', function () { send('speed', { value: SPEEDS[i] }); closeMenu() })
        })
      })
    }

    function openSettingsMenu() {
      const html = '<div class="vt-menu-head">Picture &amp; sound</div>' +
        '<div class="vt-menu-row">Zoom to fill' +
          '<button class="vt-chip" data-zoom="fill">Fill</button>' +
          '<button class="vt-chip" data-zoom="reset">Reset</button></div>' +
        '<div class="vt-menu-row">Night mode' +
          '<button class="vt-chip" data-af="night">On</button>' +
          '<button class="vt-chip" data-af="off">Off</button></div>' +
        '<div class="vt-menu-sep"></div>' +
        menuItem('Take screenshot')
      openMenu('vt-settings', html, function (m) {
        m.querySelectorAll('[data-zoom]').forEach(function (b) {
          b.addEventListener('click', function () {
            send('zoom', { value: b.dataset.zoom === 'fill' ? 0.12 : 0 })
          })
        })
        // dynaudnorm evens out a film mixed for a cinema so quiet dialogue is
        // audible without the next explosion waking the house.
        m.querySelectorAll('[data-af]').forEach(function (b) {
          b.addEventListener('click', function () {
            send('audioFilter', { value: b.dataset.af === 'night' ? 'dynaudnorm' : '' })
          })
        })
        const shot = m.querySelector('.vt-menu-item')
        if (shot) shot.addEventListener('click', function () { send('screenshot'); closeMenu() })
      })
    }

    // ── Keyboard ────────────────────────────────────────────────────────────
    // True when the keystroke belongs to a text field. The keymap guards on
    // this but cannot work it out itself — it is handed an event, not a DOM.
    // Without it every shortcut fired while typing: m muted, n advanced an
    // episode, s skipped, and the character never reached the field.
    function isTypingTarget(target) {
      if (!target) return false
      const tag = String(target.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      return target.isContentEditable === true
    }

    function onKey(e) {
      if (!keymap) return
      // The handler lives on document for the life of the app, so it must do
      // nothing at all unless the theatre is actually open. Otherwise these
      // shortcuts apply to every screen in the app.
      const root = $('vtheatre')
      if (!root || root.classList.contains('hidden')) return
      if (isTypingTarget(e.target)) return
      const hit = keymap.resolve(e, { isInput: isTypingTarget(e.target) })
      if (!hit) return
      const dur = Number(state && state.duration) || 0
      switch (hit.action) {
        case 'playPause': togglePlay(); break
        case 'seek': seekBy(hit.arg); break
        case 'seekTo': if (dur) seekTo(dur * hit.arg); break
        case 'volume': setVolume((Number(state && state.volume) || 0) + hit.arg); break
        case 'mute': send('mute', { value: !(state && state.muted) }); break
        case 'speed': bumpSpeed(hit.arg); break
        case 'frameStep': send('frameStep', { frames: hit.arg }); break
        case 'fullscreen': toggleFullscreen(); break
        case 'subtitles': openTrackMenu('sub'); break
        case 'audioTrack': openTrackMenu('audio'); break
        case 'next': if (onNext) onNext(); break
        case 'skip': {
          const seg = skipModel && skipModel.activeSegment(segments, Number(state && state.position) || 0)
          if (seg) doSkip(seg)
          break
        }
        case 'exit':
          if (!$('vt-menu').classList.contains('hidden')) { closeMenu(); break }
          // Escape means "back out one level": leave fullscreen first, and only
          // close the theatre when there is nothing left to back out of.
          if (isFullscreen) { toggleFullscreen(false); break }
          // Escape backs out of the player, it does not stop playback.
          minimise()
          break
        default: return
      }
      e.preventDefault()
    }

    // Fullscreen expands the app: the stage grows to fill the screen while the
    // deck and the skip offer stay reachable. Fullscreening the video window
    // itself would cover them, which is the whole problem this avoids.
    let isFullscreen = false
    function toggleFullscreen(force) {
      if (!api || !api.videoFullscreen) return
      const want = typeof force === 'boolean' ? force : !isFullscreen
      api.videoFullscreen({ value: want }).then(function (res) {
        isFullscreen = !!(res && res.fullscreen)
        const root = $('vtheatre')
        if (root) root.classList.toggle('fullscreen', isFullscreen)
        const btn = $('vt-full')
        if (btn) btn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Fullscreen')
        // The layout has changed, so the stage rectangle has too.
        scheduleBounds()
      }).catch(function () {})
    }

    // ── Seek interaction ────────────────────────────────────────────────────
    function seekFraction(clientX) {
      const track = doc.querySelector('#vt-seek .vt-seek-track')
      if (!track) return 0
      const r = track.getBoundingClientRect()
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    }

    function bindSeek() {
      const seek = $('vt-seek')
      if (!seek) return
      const bubble = $('vt-seek-bubble')

      seek.addEventListener('pointermove', function (e) {
        const dur = Number(state && state.duration) || 0
        if (!dur || !bubble) return
        const f = seekFraction(e.clientX)
        bubble.hidden = false
        bubble.textContent = fmtTime(dur * f)
        bubble.style.left = (f * 100) + '%'
        if (dragging) paintSeek(dur * f, dur)
      })
      seek.addEventListener('pointerleave', function () { if (bubble) bubble.hidden = true })

      seek.addEventListener('pointerdown', function (e) {
        const dur = Number(state && state.duration) || 0
        if (!dur) return
        dragging = true
        seek.setPointerCapture?.(e.pointerId)
        paintSeek(dur * seekFraction(e.clientX), dur)
      })
      seek.addEventListener('pointerup', function (e) {
        if (!dragging) return
        dragging = false
        const dur = Number(state && state.duration) || 0
        if (dur) seekTo(dur * seekFraction(e.clientX))
      })
      seek.addEventListener('pointercancel', function () { dragging = false })

      // A slider must be operable from the keyboard, not only the pointer.
      seek.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { seekBy(-10); e.preventDefault(); e.stopPropagation() }
        if (e.key === 'ArrowRight') { seekBy(10); e.preventDefault(); e.stopPropagation() }
        if (e.key === 'Home') { seekTo(0); e.preventDefault(); e.stopPropagation() }
      })
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    function bind() {
      $('vt-play')?.addEventListener('click', togglePlay)
      $('vt-back10')?.addEventListener('click', function () { seekBy(-10) })
      $('vt-fwd10')?.addEventListener('click', function () { seekBy(10) })
      // Back leaves the player without stopping it. Stopping is the Stop
      // control on the mini player, so the destructive action is never the
      // one you hit reflexively on the way out.
      $('vt-back')?.addEventListener('click', minimise)
      $('vmini-open')?.addEventListener('click', restore)
      $('vmini-stop')?.addEventListener('click', close)
      $('vmini-play')?.addEventListener('click', togglePlay)
      $('vt-next')?.addEventListener('click', function () { if (onNext) onNext() })
      $('vt-mute')?.addEventListener('click', function () { send('mute', { value: !(state && state.muted) }) })
      $('vt-vol')?.addEventListener('input', function (e) { setVolume(Number(e.target.value)) })
      $('vt-subs')?.addEventListener('click', function () { openTrackMenu('sub') })
      $('vt-audio')?.addEventListener('click', function () { openTrackMenu('audio') })
      $('vt-speed')?.addEventListener('click', openSpeedMenu)
      $('vt-settings')?.addEventListener('click', openSettingsMenu)
      $('vt-full')?.addEventListener('click', toggleFullscreen)
      bindSeek()
      doc.addEventListener('keydown', onKey)
      // A click anywhere outside an open menu closes it.
      doc.addEventListener('pointerdown', function (e) {
        const m = $('vt-menu')
        if (m && !m.classList.contains('hidden') && !m.contains(e.target) && !e.target.closest('.vt-chip, .vt-icon')) closeMenu()
      })
      if (typeof window !== 'undefined') window.addEventListener('resize', scheduleBounds)
    }

    function open(info) {
      media = info || {}
      const root = $('vtheatre')
      if (!root) return
      root.classList.remove('hidden')
      const mini = $('vmini')
      if (mini) mini.classList.add('hidden')
      minimised = false
      const t = $('vt-title'); if (t) t.textContent = media.title || 'Video'
      const sub = $('vt-sub'); if (sub) sub.textContent = media.subtitle || ''
      // The mini player shows the same thing in one line.
      const mt = $('vmini-title')
      if (mt) mt.textContent = [media.title, media.subtitle].filter(Boolean).join(' · ') || 'Playing'
      // Hidden for a film, or for the last episode of the last season — a
      // control that cannot do anything is worse than no control.
      const next = $('vt-next'); if (next) next.hidden = !onNext || media.hasNext === false
      segments = []
      prefs = media.prefs || {}
      lastSkipShown = null
      upNextDismissed = false
      stopUpNext()
      clearPack()
      const upBox = $('vt-upnext')
      if (upBox) { upBox.hidden = true; upBox.innerHTML = '' }
      syncStrip()
      delayMs = { subDelay: 0, audioDelay: 0 }
      setVideoActive(true)
      setStageMessage('<div class="spin"></div><div>Starting…</div>')
      if (!unsubscribe && api && api.onVideoState) {
        unsubscribe = api.onVideoState(function (s) {
          state = s
          render()
          if (onState) { try { onState(s) } catch (_) { /* never let a listener stop playback */ } }
        })
      }
      // The stage rectangle is reported synchronously here so it is known even
      // if the caller does not await ready(); scheduleBounds re-sends after
      // any late layout settling.
      ready()
      scheduleBounds()
    }

    // Leaving the theatre is not the same as stopping. mpv plays in its own
    // window, so the theatre is only a control surface — hiding it lets the
    // app be browsed while something plays, which is the whole point of
    // minimising rather than closing.
    function minimise() {
      closeMenu()
      if (isFullscreen) toggleFullscreen(false)
      const root = $('vtheatre')
      if (root) root.classList.add('hidden')
      const mini = $('vmini')
      if (mini) mini.classList.remove('hidden')
      minimised = true
      // The video surface is a native child window: hiding the HTML behind it
      // does not hide it, and it would sit over the app while the user tried
      // to browse. Audio keeps playing.
      setSurfaceVisible(false)
      // The state subscription stays open: the mini player shows the same
      // position and play state, and returning must not have to rebuild it.
      render()
    }

    function restore() {
      const mini = $('vmini')
      if (mini) mini.classList.add('hidden')
      const root = $('vtheatre')
      if (root) root.classList.remove('hidden')
      minimised = false
      render()
      // Two frames so the stage has its size back before the surface is
      // placed on it, then show it again.
      ready().then(function () { setSurfaceVisible(true) })
    }

    function setSurfaceVisible(on) {
      if (api && api.videoSurfaceVisible) api.videoSurfaceVisible(!!on).catch(function () {})
    }

    // Stopping for real: tears everything down and tells the caller.
    function close() {
      cancelAutoSkip()
      stopUpNext()
      closeMenu()
      if (isFullscreen) toggleFullscreen(false)
      const root = $('vtheatre')
      if (root) root.classList.add('hidden')
      const mini = $('vmini')
      if (mini) mini.classList.add('hidden')
      minimised = false
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      state = null
      segments = []
      // Only on a real stop: minimising keeps playing, so the music bar stays
      // out of the way until the video is actually finished with.
      setVideoActive(false)
      setSurfaceVisible(false)
      onExit()
    }

    // Marks the app as having a video open, which collapses the music bar to a
    // small card in the opposite corner so it stops sitting across the episode
    // list. Guarded because the test harness has no body.
    function setVideoActive(on) {
      const body = doc && doc.body
      if (!body || !body.classList) return
      body.classList.toggle('video-active', !!on)
    }

    function setStageMessage(html) {
      const el = $('vt-stage-msg')
      if (el) el.innerHTML = html || ''
    }

    function setSegments(list) {
      segments = Array.isArray(list) ? list : []
      lastMarkDuration = -1
      paintMarks()
    }

    function setPrefs(p) { prefs = p || {} }

    return {
      create: null,
      bind: bind,
      open: open,
      close: close,
      render: render,
      setSegments: setSegments,
      setPrefs: setPrefs,
      // Triggered by the S key relayed from the video window, where the deck
      // cannot see the keypress.
      skipNow: function () {
        const seg = skipModel && skipModel.activeSegment(segments, Number(state && state.position) || 0)
        if (seg) doSkip(seg)
      },
      setUpNext: setUpNext,
      // Relayed from mpv when the picture is double-clicked: the click never
      // reaches the page, so the gesture has to arrive this way.
      toggleFullscreen: toggleFullscreen,
      setPack: setPack,
      minimise: minimise,
      restore: restore,
      isMinimised: function () { return minimised },
      clearPack: clearPack,
      setStageMessage: setStageMessage,
      reportBounds: reportBounds,
      ready: ready,
      // Exposed for tests and for the renderer's own event handling.
      _state: function () { return state },
      _setState: function (s) { state = s; render() },
      _segments: function () { return segments },
      fmtTime: fmtTime,
      SPEEDS: SPEEDS,
    }
  }

  return { create: create, fmtTime: fmtTime, SPEEDS: SPEEDS, ICON: ICON }
})
