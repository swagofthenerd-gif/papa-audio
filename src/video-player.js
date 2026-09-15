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

  // For the stats panel's download rate. One decimal at MB scale because that
  // is where a torrent's health actually reads; below that the digits are noise.
  function fmtBytes(n) {
    n = Math.max(0, Number(n) || 0)
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return Math.round(n) + ' B'
  }

  // Seek-bar thumbnail cache (roadmap #28). A pure, testable bucket cache: the
  // preview frame does not need to be per-second, so a hovered position is
  // snapped to a 10-second bucket and the frame for that bucket is remembered
  // for the session. A hover that stays inside a bucket, or comes back to one
  // already seen, costs no IPC and no ffmpeg. Capped so a long scrub across a
  // three-hour film cannot grow the map without bound — oldest bucket evicted
  // first, insertion order being Map's own iteration order.
  const THUMB_BUCKET_SEC = 10
  const THUMB_CACHE_CAP = 100

  function thumbBucketOf(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0))
    return Math.floor(n / THUMB_BUCKET_SEC)
  }

  function makeThumbCache(cap) {
    const limit = Number(cap) > 0 ? Math.floor(cap) : THUMB_CACHE_CAP
    const map = new Map()
    return {
      // The path known for a position's bucket, or undefined if never fetched.
      // A cached null means "asked, none available yet" — a real answer, not a
      // miss — so callers distinguish it from undefined with `has`.
      get (sec) { return map.get(thumbBucketOf(sec)) },
      has (sec) { return map.has(thumbBucketOf(sec)) },
      set (sec, path) {
        const key = thumbBucketOf(sec)
        // Re-insert so a refreshed bucket counts as most-recent for eviction.
        if (map.has(key)) map.delete(key)
        map.set(key, path)
        while (map.size > limit) map.delete(map.keys().next().value)
        return path
      },
      clear () { map.clear() },
      size () { return map.size },
    }
  }

  // ── Mini-player geometry (pure, testable) ─────────────────────────────────
  // The mini player is a card whose top is a reserved video region the native
  // mpv window is placed onto, and whose bottom is the control bar. Everything
  // below is a pure function of a viewport and a chosen corner+size, so the same
  // maths the live code uses can be unit-tested without a DOM.
  //
  // The two size steps match the CSS custom properties and main.js's MINI_W/H:
  // the video region is 320×180 (compact) or 480×270 (large), and the bar is a
  // fixed 46px tall beneath it.
  const MINI = {
    inset: 24,            // gap from the viewport edge on a snapped corner
    handleH: 26,          // top drag-handle strip (must match --vmini-handle-h)
    barH: 46,             // control-bar height (must match --vmini-bar-h)
    sizes: {
      compact: { w: 320, h: 180 },
      large:   { w: 480, h: 270 },
    },
    corners: ['tl', 'tr', 'bl', 'br'],
    minW: 240, maxW: 720,  // free-size bounds for the corner grip
    // The bottom snap corners must clear the music player bar so the mini card
    // never covers its controls. Measured in CSS px; the caller passes the live
    // --player-h so it tracks the responsive clamp.
  }

  // A size is a named step ('compact' | 'large') or, since the corner grip
  // (V1), any width in px between MINI.minW and MINI.maxW; the height follows
  // 16:9. Anything else degrades to compact rather than to NaN.
  function miniVideoDims(size) {
    if (typeof size === 'number' && Number.isFinite(size)) {
      const w = Math.round(Math.max(MINI.minW, Math.min(MINI.maxW, size)))
      return { w: w, h: Math.round(w * 9 / 16) }
    }
    return MINI.sizes[size] || MINI.sizes.compact
  }

  // The full card size for a size step: the drag-handle strip on top, then the
  // video, then the control bar. The handle and bar heights are fixed; only the
  // video region changes between the two size steps.
  function miniCardSize(size) {
    const v = miniVideoDims(size)
    return { w: v.w, h: MINI.handleH + v.h + MINI.barH }
  }

  // Top-left page position of the CARD for a corner, clamped so the card is
  // always fully on screen. `playerH` is the music bar's reserved height at the
  // bottom, so the bottom corners sit above it rather than over its controls.
  // `topInset` is the app title bar's height: the top corners sit below it,
  // not behind it (the bar is a drag region that would swallow the handle).
  function miniCardTopLeft(corner, size, viewport, playerH, topInset) {
    const c = miniCardSize(size)
    const vw = Math.max(c.w, Number(viewport && viewport.width) || 0)
    const vh = Math.max(c.h, Number(viewport && viewport.height) || 0)
    const inset = MINI.inset
    const bottomGap = inset + Math.max(0, Number(playerH) || 0)
    const left = inset
    const right = Math.max(inset, vw - c.w - inset)
    const top = inset + Math.max(0, Number(topInset) || 0)
    const bottom = Math.max(top, vh - c.h - bottomGap)
    switch (corner) {
      case 'tl': return { x: left,  y: top }
      case 'tr': return { x: right, y: top }
      case 'bl': return { x: left,  y: bottom }
      case 'br':
      default:   return { x: right, y: bottom }
    }
  }

  // The VIDEO region's page rectangle for a corner+size — this is what gets sent
  // to main as the mpv rect. The drag-handle strip sits on the card's top edge,
  // so the video (and the native mpv window over it) is offset DOWN by the handle
  // height — the mpv window must never cover the handle, or it would be
  // undraggable again. The bar hangs below the video.
  function miniVideoRect(corner, size, viewport, playerH, topInset) {
    const tl = miniCardTopLeft(corner, size, viewport, playerH, topInset)
    const v = miniVideoDims(size)
    return { x: Math.round(tl.x), y: Math.round(tl.y + MINI.handleH), width: v.w, height: v.h }
  }

  // Which corner a freely-dragged card is closest to. The card's centre is
  // compared against the four corner anchor centres; nearest wins, so a release
  // anywhere lands in a predictable spot.
  function nearestCorner(cardRect, size, viewport, playerH, topInset) {
    const cx = (Number(cardRect && cardRect.x) || 0) + miniCardSize(size).w / 2
    const cy = (Number(cardRect && cardRect.y) || 0) + miniCardSize(size).h / 2
    let best = 'br'
    let bestD = Infinity
    for (const corner of MINI.corners) {
      const tl = miniCardTopLeft(corner, size, viewport, playerH, topInset)
      const ax = tl.x + miniCardSize(size).w / 2
      const ay = tl.y + miniCardSize(size).h / 2
      const d = (ax - cx) * (ax - cx) + (ay - cy) * (ay - cy)
      if (d < bestD) { bestD = d; best = corner }
    }
    return best
  }

  // Convert a page (CSS px, content-relative) rectangle to absolute SCREEN
  // pixels. This mirrors the maths main.js applies (zoom factor, then the window
  // content origin) and is here as a pure function so the conversion is covered
  // by tests. The live path does NOT use this — main owns the real conversion,
  // reading the true zoom and content bounds — but the numbers must agree.
  function pageRectToScreen(rect, winX, winY, zoom) {
    let z = Number(zoom)
    if (!Number.isFinite(z) || z <= 0) z = 1
    return {
      x: Math.round((Number(winX) || 0) + (Number(rect && rect.x) || 0) * z),
      y: Math.round((Number(winY) || 0) + (Number(rect && rect.y) || 0) * z),
      width: Math.round((Number(rect && rect.width) || 0) * z),
      height: Math.round((Number(rect && rect.height) || 0) * z),
    }
  }

  // Validate a persisted {corner, size} blob before trusting it. A corrupt or
  // partial store must never place the card off screen or at a nonsense size, so
  // anything unrecognised falls back to the bottom-right / compact default.
  function sanitizeMiniPos(raw) {
    const corner = raw && MINI.corners.indexOf(raw.corner) !== -1 ? raw.corner : 'br'
    let size = 'compact'
    if (raw && MINI.sizes[raw.size]) size = raw.size
    else if (raw && typeof raw.size === 'number' && raw.size >= MINI.minW && raw.size <= MINI.maxW) size = Math.round(raw.size)
    return { corner, size }
  }

  // Clamped 0..1 fraction of a pointer's x within a track. Extracted so the mini
  // seek bar and its tests share one definition. left/width are the track's
  // bounding box in the same coordinate space as clientX.
  function seekFractionAt(clientX, trackLeft, trackWidth) {
    const w = Number(trackWidth) || 0
    if (w <= 0) return 0
    return Math.max(0, Math.min(1, ((Number(clientX) || 0) - (Number(trackLeft) || 0)) / w))
  }

  function create(opts) {
    opts = opts || {}
    const doc = opts.document || (typeof document !== 'undefined' ? document : null)
    const api = opts.api || (typeof window !== 'undefined' ? window.api : null)
    const keymap = opts.keymap || (typeof window !== 'undefined' ? window.PapaVideoKeymap : null)
    const skipModel = opts.skipModel || (typeof window !== 'undefined' ? window.PapaSkipModel : null)
    const onExit = opts.onExit || function () {}
    const onNext = opts.onNext || null
    // A brief message to the app's toast stack, for things the deck does that
    // finish out of view — a screenshot saved to disk (§48), say. Optional and
    // guarded everywhere it is called, so the deck works in a test harness with
    // no toast host.
    const onToast = opts.onToast || function () {}
    // localStorage through the app's validated reader. Injectable for tests,
    // and optional everywhere it is touched: persistence is a convenience and
    // must never be able to stop playback.
    const local = opts.local || (typeof window !== 'undefined' ? window.PapaLocal : null)
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
    // True while mpv is in corner PiP mode (roadmap #27) rather than merely
    // surface-hidden, so restore() knows to bring it back out of the corner.
    let pipActive = false
    // Mini-player card position + size. Read once from PapaLocal and written on
    // every deliberate change (a corner snap, a size toggle). Persistence is a
    // convenience — a read failure just uses the default bottom-right/compact.
    let miniPos = { corner: 'br', size: 'compact' }
    try {
      if (local && typeof local.readObject === 'function') {
        miniPos = sanitizeMiniPos(local.readObject('papa-vmini-pos'))
      }
    } catch (_) { /* storage is a convenience, never a blocker */ }
    // The card's current top-left in page px while dragging, so a mid-drag rect
    // send and the snap-on-release share one source of truth.
    let miniDragTL = null
    // V1 motion: release physics, corner resize and the theatre↔card flight
    // come from the pure module; the deck only feeds samples and paints.
    const motion = (typeof PapaMiniMotion !== 'undefined' && PapaMiniMotion) ||
      (typeof require === 'function' ? (function () { try { return require('./mini-motion') } catch (_) { return null } })() : null)
    let miniSettleRaf = 0        // the spring animation frame, 0 when idle
    let miniFlight = null        // the running theatre↔card animation, if any
    function lessMotion() {
      try { return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (_) { return false }
    }
    // True when the picture lives in the page (the smooth player), which is
    // the only case where the card can fly or its picture can be hovered.
    function pictureInPage() {
      return !!(api && typeof api.videoRenderPath === 'function' && api.videoRenderPath() === 'web')
    }
    let miniRectTimer = 0        // throttle handle for live rect updates
    let miniDragging = false     // true while the card or its seek is being dragged
    let upNextTimer = null
    let upNextLeft = 0
    let upNextInfo = null
    let upNextDismissed = false
    let upNextHover = false
    let media = null   // { title, sub, next, onPrev?, onPrefChange? }

    // total ⇄ remaining on the duration readout. Read once at creation, written
    // on every toggle. Compared with indexOf rather than equality because the
    // store JSON-encodes strings — the raw text is '"remaining"', quotes and all.
    let timeMode = 'total'
    try {
      if (local && typeof local.readRaw === 'function' &&
          String(local.readRaw('papaVtTimeMode') || '').indexOf('remaining') !== -1) {
        timeMode = 'remaining'
      }
    } catch (_) { /* storage is a convenience, never a blocker */ }

    // Whether the Up Next countdown advances on its own. Default on — the
    // point of episodic viewing is not having to press anything — but a viewer
    // who wants to choose each time can turn it off, and the card then shows
    // "Play now" with no ticking ring. Stored as a JSON boolean, so anything
    // but an explicit 'false' leaves the default in place.
    let autoNext = true
    try {
      if (local && typeof local.readRaw === 'function' &&
          String(local.readRaw('papaVtAutoNext') || '').indexOf('false') !== -1) {
        autoNext = false
      }
    } catch (_) { /* storage is a convenience, never a blocker */ }

    // "Still watching?" guard. Each time the countdown advances an episode with
    // no sign of a viewer, this climbs; any real activity zeroes it. Once three
    // episodes have auto-advanced untouched, the next countdown holds at three
    // seconds and asks, rather than playing on into an empty room. noteActivity
    // is the single signal for "a person is here" — it is called on every wake
    // source and on every deliberate menu action.
    const STILL_WATCHING_AFTER = 3
    let autoAdvances = 0
    let stillAsking = false

    // Overlay controls window (roadmap #26): controls drawn ON the picture via a
    // transparent always-on-top child window, instead of the held rows below the
    // stage. Feature-detected — the toggle only appears when main exposes the
    // config channel — and read once on creation so the settings row can show its
    // current state. Default OFF (the held-rows deck is the proven fallback);
    // main owns the actual window and honours this same config key at play time.
    let overlayControls = false
    if (api && api.videoConfigGet) {
      try {
        Promise.resolve(api.videoConfigGet()).then(function (cfg) {
          overlayControls = !!(cfg && cfg.overlayControls)
        }).catch(function () {})
      } catch (_) { /* config is a convenience, never a blocker */ }
    }

    // ── Stage geometry ──────────────────────────────────────────────────────
    // main positions the mpv window onto this rectangle. It has to be re-sent
    // on any resize, or the video and its frame drift apart.
    // How much shorter the video is being drawn than its stage, so a menu can
    // sit in the space. The picture is a native window composited ABOVE the
    // page, so HTML cannot be drawn over it — an Audio or Subtitles menu opening
    // upward from the deck had its top 130 pixels swallowed by the video, which
    // is what "the video overlaps the settings" was. Giving the menu the room
    // beats hiding the picture to read it.
    let stageInset = 0

    function reportBounds() {
      const stage = $('vt-stage')
      if (!stage || !api || !api.videoSurfaceBounds) return Promise.resolve(false)
      const r = stage.getBoundingClientRect()
      // Never shrink the picture to nothing: a menu taller than the stage keeps
      // a strip of video rather than blanking it, and the menu overlaps that
      // strip, which is still better than no picture at all.
      const height = Math.max(120, Math.round(r.height) - Math.round(stageInset))
      if (r.width < 2 || height < 2) return Promise.resolve(false)
      return api.videoSurfaceBounds({
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: height,
      }).then(function () { return true }).catch(function () { return false })
    }

    // Called when a menu opens or closes. The inset is measured from the menu's
    // own position rather than assumed, because the menus differ in height and
    // the settings one grows as options are added.
    function setStageInset(px) {
      const next = Math.max(0, Math.round(px || 0))
      if (next === stageInset) return
      stageInset = next
      reportBounds()
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

      // Neither the pointer nor held arrow keys may be fought by the stream:
      // while a keyboard target is pending the bar shows where the seek will
      // land, not where playback still is.
      if (!dragging && kbTarget == null) paintSeek(pos, dur)

      const posEl = $('vt-pos'); if (posEl) posEl.textContent = fmtTime(pos)
      const durEl = $('vt-dur')
      if (durEl) {
        durEl.textContent = timeMode === 'remaining'
          ? '−' + fmtTime(Math.max(0, dur - pos))
          : fmtTime(dur)
      }

      const mute = $('vt-mute')
      if (mute) {
        mute.innerHTML = state.muted || state.volume === 0 ? ICON.mute : ICON.vol
        mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute')
      }
      const vol = $('vt-vol')
      if (vol) {
        const pct = Math.round(state.volume || 0)
        // The slider runs 0–130, so a screen reader reading the raw value calls
        // out "84" with no unit. aria-valuetext gives it the percent the number
        // actually is, and says when the level is into mpv's amplified range.
        vol.setAttribute('aria-valuetext', pct + '%' + (pct > 100 ? ' (boosted)' : '') +
          (state.muted ? ', muted' : ''))
        if (doc.activeElement !== vol) vol.value = String(pct)
      }

      const speed = $('vt-speed')
      if (speed) {
        speed.textContent = (Number(state.speed) || 1) + '×'
        speed.classList.toggle('on', Number(state.speed) !== 1)
      }

      const subs = $('vt-subs')
      if (subs) subs.classList.toggle('on', state.tracks && state.tracks.sub != null)

      paintBadges()
      syncChapterButton()
      paintMini()
      // Segments are set before the first state tick, when the duration is
      // still 0 and the marks cannot be positioned. Repaint whenever the
      // duration changes, or they would never appear at all.
      if (dur !== lastMarkDuration) { lastMarkDuration = dur; paintMarks() }
      syncChapterTicks()
      paintSkip(pos)
      paintUpNext(pos, dur)
      // Once state is flowing the file's tracks exist, so the remembered
      // language can be applied. A once-only latch inside, not a repaint.
      applyLangPrefs()
    }

    // What can actually be jumped to, drawn as the ranges mpv reports rather
    // than as one bar growing from the left.
    //
    // The single bar was wrong twice over. It added an absolute timestamp to
    // the position — mpv's demuxer-cache-time, not a duration — so it read past
    // the end of the film and sat permanently full. And even corrected, a
    // demuxer window only says how far ahead mpv has read: it says nothing
    // about whether the bytes for somewhere else exist. On a torrent they
    // usually do not, which is why a full-looking bar still bought a wait on
    // every seek. Ranges answer the question the bar is actually asked.
    function paintBuffered(pos, dur) {
      const buf = $('vt-seek-buffer')
      if (!buf || !(dur > 0)) return
      const ranges = (state && Array.isArray(state.seekable)) ? state.seekable : []
      if (!ranges.length) {
        // No ranges reported yet: fall back to the window ahead of the playhead,
        // which is at least true, rather than to nothing.
        const ahead = Math.min(dur, pos + (Number(state && state.buffered) || 0))
        buf.innerHTML = '<i style="left:0;width:' + Math.min(100, (ahead / dur) * 100) + '%"></i>'
        return
      }
      buf.innerHTML = ranges.map(function (r) {
        const from = Math.max(0, Math.min(dur, r.start))
        const to = Math.max(from, Math.min(dur, r.end))
        return '<i style="left:' + ((from / dur) * 100) + '%;width:' + (((to - from) / dur) * 100) + '%"></i>'
      }).join('')
    }

    function paintSeek(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0
      const fill = $('vt-seek-fill'); if (fill) fill.style.width = pct + '%'
      const knob = $('vt-seek-knob'); if (knob) knob.style.left = pct + '%'
      paintBuffered(pos, dur)
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
      const ovPlay = $('vmini-ov-play')
      if (ovPlay) { ovPlay.innerHTML = state.paused ? ICON.play : ICON.pause; ovPlay.setAttribute('aria-label', state.paused ? 'Play' : 'Pause') }
      const play = $('vmini-play')
      if (play) {
        play.innerHTML = state.paused ? ICON.play : ICON.pause
        play.setAttribute('aria-label', state.paused ? 'Play' : 'Pause')
      }
      // The seek bar is driven by the same position feed the theatre uses, so
      // the two never disagree. Left frozen while the user scrubs the mini bar.
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0
      if (!miniDragging) {
        const fill = $('vmini-fill'); if (fill) fill.style.width = pct + '%'
        const knob = $('vmini-knob'); if (knob) knob.style.left = pct + '%'
      }
      const seek = $('vmini-seek')
      if (seek) {
        seek.setAttribute('aria-valuemax', String(Math.round(dur)))
        seek.setAttribute('aria-valuenow', String(Math.round(pos)))
        seek.setAttribute('aria-valuetext', fmtTime(pos) + ' of ' + fmtTime(dur))
      }
      // Time remaining, matching the theatre's remaining/total toggle so a
      // glance answers "how much is left" the same way in both places.
      const time = $('vmini-time')
      if (time) {
        time.textContent = timeMode === 'remaining'
          ? '−' + fmtTime(Math.max(0, dur - pos))
          : fmtTime(pos)
      }
      const mute = $('vmini-mute')
      if (mute) {
        mute.innerHTML = state.muted || state.volume === 0 ? ICON.mute : ICON.vol
        mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute')
      }
      // The next-episode button can only do something when there is a next; a
      // control that does nothing is worse than no control (same rule as the
      // theatre's Next). media.hasNext is set by the renderer.
      const next = $('vmini-next')
      if (next) next.hidden = !onNext || (media && media.hasNext === false)
    }

    // ── Mini-player positioning + drag ────────────────────────────────────────
    // The card and the mpv rect are computed together: the card is placed at a
    // page position (via transform), and the VIDEO region of that same card is
    // handed to main as the mpv rectangle. Because main converts a page rect the
    // same way #vt-stage's does (zoom + content origin), the picture lands
    // exactly inside the reserved region — frame and video move as one.
    function miniViewport() {
      const de = doc && doc.documentElement
      return {
        width: (de && de.clientWidth) || 0,
        height: (de && de.clientHeight) || 0,
      }
    }
    // The music bar's reserved height, read from the live CSS var so the bottom
    // corners always clear it. Falls back to a sane constant if unreadable.
    function miniPlayerH() {
      try {
        if (typeof window !== 'undefined' && window.getComputedStyle && doc) {
          const v = window.getComputedStyle(doc.documentElement)
            .getPropertyValue('--player-h')
          const n = parseFloat(v)
          if (Number.isFinite(n)) return n
        }
      } catch (_) {}
      return 130
    }

    // The title bar's height, measured (0 when hidden, as in fullscreen).
    function miniTopInset() {
      try {
        const tb = doc && doc.querySelector && doc.querySelector('.titlebar')
        if (tb && typeof tb.getBoundingClientRect === 'function') return Math.round(tb.getBoundingClientRect().height) || 0
      } catch (_) {}
      return 0
    }
    // The card's anchored top-left for the current (or a given) corner+size.
    function miniAnchor(corner, size) {
      return miniCardTopLeft(corner, size, miniViewport(), miniPlayerH(), miniTopInset())
    }
    // The video region's page rectangle for the current (or a given) corner+size.
    function miniRectFor(corner, size) {
      return miniVideoRect(corner, size, miniViewport(), miniPlayerH(), miniTopInset())
    }

    // Place the card at a page top-left and send main the matching video rect.
    // A null top-left means "use the persisted corner". While dragging, tl is
    // the live pointer position and the send is throttled by the caller.
    function placeMiniCard(tl, sendRect) {
      const mini = $('vmini')
      if (!mini) return null
      mini.classList.toggle('vmini-large', miniPos.size === 'large')
      // The size is written as custom properties so a free width from the
      // corner grip and the two named steps go through one path.
      const dims = miniVideoDims(miniPos.size)
      if (mini.style && typeof mini.style.setProperty === 'function') {
        mini.style.setProperty('--vmini-w', dims.w + 'px')
        mini.style.setProperty('--vmini-h', dims.h + 'px')
      }
      // The corner grip sits opposite the anchored corner; CSS reads this.
      if (mini.dataset) mini.dataset.corner = miniPos.corner
      let rect
      if (tl) {
        mini.style.transform = 'translate(' + Math.round(tl.x) + 'px,' + Math.round(tl.y) + 'px)'
        // The mpv rect follows the card's live top-left, offset DOWN by the drag
        // handle so the picture sits below the handle strip (same offset the pure
        // miniVideoRect applies), not over it — otherwise the handle would be
        // buried under the native window and undraggable again.
        const v = miniVideoDims(miniPos.size)
        rect = { x: Math.round(tl.x), y: Math.round(tl.y + MINI.handleH), width: v.w, height: v.h }
      } else {
        const anchor = miniAnchor(miniPos.corner, miniPos.size)
        mini.style.transform = 'translate(' + Math.round(anchor.x) + 'px,' + Math.round(anchor.y) + 'px)'
        rect = miniRectFor(miniPos.corner, miniPos.size)
      }
      if (sendRect !== false && pipActive && api && api.videoMiniMode) {
        api.videoMiniMode({ on: true, rect: rect }).catch(function () {})
      }
      return rect
    }

    // Persist the chosen corner + size so the card reopens where it was left.
    function saveMiniPos() {
      try {
        if (local && typeof local.write === 'function') local.write('papa-vmini-pos', miniPos)
      } catch (_) { /* a lost preference must never stop playback */ }
    }

    // Drag is bound to two surfaces: the dedicated handle strip across the top of
    // the card, and the bar's free space (a bar press that is not on a button or
    // the seek still drags). The picture region can't be a drag surface — it is
    // the native mpv window and the page never sees pointer events over it — which
    // is exactly why the handle exists. The handler is written once here and bound
    // to each surface, so the two paths can never drift apart.
    function nowMs() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
    }
    // Where the card is right now if a spring is moving it, else null. Stops
    // the spring either way.
    let settleTL = null
    function stopSettle() {
      const live = settleTL
      if (miniSettleRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(miniSettleRaf)
      miniSettleRaf = 0
      settleTL = null
      return live
    }
    // Animate the card from `from` to its anchored corner on the spring. The
    // final frame goes through placeMiniCard(null, true) so the persisted
    // anchor, the CSS position and the picture rect all agree at rest. Under
    // mpv the native window follows at the drag throttle; in the page the
    // picture is inside the card and simply comes along.
    function settleTo(from, v) {
      stopSettle()
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
      if (!motion || !raf || lessMotion()) { placeMiniCard(null, true); return }
      const to = miniAnchor(miniPos.corner, miniPos.size)
      const sp = motion.spring(from, to, v)
      let last = nowMs()
      settleTL = { x: from.x, y: from.y }
      mini_setSettling(true)
      const frame = function () {
        const t = nowMs()
        const p = sp.step(t - last); last = t
        if (p.done) { miniSettleRaf = 0; settleTL = null; mini_setSettling(false); placeMiniCard(null, true); return }
        settleTL = { x: p.x, y: p.y }
        placeMiniCard(settleTL, false)
        sendLiveRect(settleTL)
        miniSettleRaf = raf(frame)
      }
      miniSettleRaf = raf(frame)
    }
    function mini_setSettling(on) {
      const mini = $('vmini')
      if (mini) mini.classList.toggle('vmini-settling', !!on)
    }
    // The native mpv window follows a moving card, throttled so a sweep is not
    // one setBounds per pixel. A no-op when the picture is in the page.
    function sendLiveRect(tl) {
      if (!pipActive || !api || !api.videoMiniMode || pictureInPage()) return
      if (miniRectTimer) return
      miniRectTimer = setTimeout(function () {
        miniRectTimer = 0
        const cur = miniDragTL || settleTL || tl
        if (!cur || !pipActive) return
        const v = miniVideoDims(miniPos.size)
        api.videoMiniMode({ on: true, rect: {
          x: Math.round(cur.x), y: Math.round(cur.y + MINI.handleH), width: v.w, height: v.h,
        } }).catch(function () {})
      }, 50)
    }

    // The corner grip (V1): dragging it resizes the picture freely between
    // MINI.minW and MINI.maxW, the card growing away from its anchored corner
    // so it never leaves the screen. The width persists like the corner.
    function bindMiniResize() {
      const grip = $('vmini-resize')
      const mini = $('vmini')
      if (!grip || !mini || !motion) return
      let pid = null, sx = 0, sy = 0, startW = 0
      grip.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return
        pid = e.pointerId; sx = e.clientX; sy = e.clientY
        startW = miniVideoDims(miniPos.size).w
        stopSettle()
        try { mini.focus({ preventScroll: true }) } catch (_) {}
        miniDragging = true
        mini.classList.add('vmini-resizing')
        try { grip.setPointerCapture(e.pointerId) } catch (_) {}
        if (typeof e.preventDefault === 'function') e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
      })
      grip.addEventListener('pointermove', function (e) {
        if (pid !== e.pointerId) return
        const vp = miniViewport()
        const cap = Math.max(MINI.minW, Math.min(MINI.maxW, vp.width - 2 * MINI.inset, vp.height - miniPlayerH() - 2 * MINI.inset - MINI.handleH - MINI.barH) * 16 / 9)
        miniPos.size = motion.resizedWidth(startW, e.clientX - sx, e.clientY - sy, miniPos.corner, cap)
        placeMiniCard(null, false)
        sendLiveRect(null)
      })
      const done = function (e) {
        if (pid !== e.pointerId) return
        pid = null
        miniDragging = false
        mini.classList.remove('vmini-resizing')
        try { grip.releasePointerCapture(e.pointerId) } catch (_) {}
        if (miniRectTimer) { clearTimeout(miniRectTimer); miniRectTimer = 0 }
        saveMiniPos()
        placeMiniCard(null, true)
        paintMini()
      }
      grip.addEventListener('pointerup', done)
      grip.addEventListener('pointercancel', done)
    }

    function bindMiniDrag() {
      const handle = $('vmini-handle')
      const bar = $('vmini-bar')
      const mini = $('vmini')
      if (!mini || (!handle && !bar)) return
      let startX = 0, startY = 0, baseTL = null, pointerId = null, captureEl = null
      let samples = []   // recent pointer positions, for the release velocity
      let pressAt = 0, moved = false, pressEl = null

      const onDown = function (el) {
        return function (e) {
          // Only a bare left-press starts a drag. On the bar a press on a control
          // (play, seek, size…) must do its own thing, not drag; the handle has no
          // controls so nothing to exclude there.
          if (e.button !== 0) return
          if (e.target && typeof e.target.closest === 'function' &&
              e.target.closest('button, .vmini-seek')) return
          pointerId = e.pointerId
          captureEl = el
          miniDragging = true
          mini.classList.add('vmini-dragging')
          // A press on the card gives it the keyboard (preventDefault below
          // would otherwise stop the focus change a press normally makes).
          try { mini.focus({ preventScroll: true }) } catch (_) {}
          startX = e.clientX; startY = e.clientY
          // Grabbing a card mid-settle picks it up where it is, not where it
          // was going.
          const live = stopSettle()
          baseTL = live || miniAnchor(miniPos.corner, miniPos.size)
          miniDragTL = { x: baseTL.x, y: baseTL.y }
          samples = [{ t: nowMs(), x: e.clientX, y: e.clientY }]
          pressAt = nowMs(); moved = false; pressEl = el
          try { el.setPointerCapture(e.pointerId) } catch (_) {}
          if (typeof e.preventDefault === 'function') e.preventDefault()
        }
      }
      const onMove = function (e) {
        if (!miniDragging || e.pointerId !== pointerId || !baseTL) return
        const vp = miniViewport()
        const cs = miniCardSize(miniPos.size)
        // Keep the whole card on screen while dragging.
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) moved = true
        if (!moved) return   // a press that has not moved is not a drag yet
        const x = Math.max(0, Math.min(vp.width - cs.w, baseTL.x + (e.clientX - startX)))
        const y = Math.max(miniTopInset(), Math.min(vp.height - cs.h, baseTL.y + (e.clientY - startY)))
        miniDragTL = { x: x, y: y }
        samples.push({ t: nowMs(), x: e.clientX, y: e.clientY })
        if (samples.length > 16) samples.shift()
        placeMiniCard(miniDragTL, false)   // move the card now
        sendLiveRect(miniDragTL)
      }
      const endDrag = function (e) {
        if (!miniDragging || (pointerId != null && e.pointerId !== pointerId)) return
        miniDragging = false
        mini.classList.remove('vmini-dragging')
        try { if (captureEl) captureEl.releasePointerCapture(e.pointerId) } catch (_) {}
        if (miniRectTimer) { clearTimeout(miniRectTimer); miniRectTimer = 0 }
        // A press on the picture that never moved is a tap: play/pause, as a
        // click on the theatre's picture does (V4). The handle and bar stay
        // pure drag surfaces.
        if (!moved && pressEl && pressEl.id === 'vmini-video' && nowMs() - pressAt < 400 && state) {
          miniDragTL = null; pointerId = null; captureEl = null; samples = []
          togglePlay()
          return
        }
        if (!moved) { miniDragTL = null; pointerId = null; captureEl = null; samples = []; return }
        // The corner a flick was heading for, not just the one nearest the
        // drop: the release velocity projects the drop point forward first.
        // Then the card settles there on a spring that continues the hand's
        // motion (V1). Without the motion module, or for a viewer who asked
        // for less motion, it snaps as before.
        if (miniDragTL) {
          const from = { x: miniDragTL.x, y: miniDragTL.y }
          const v = motion ? motion.velocity(samples, nowMs()) : { vx: 0, vy: 0 }
          const aim = motion ? motion.projectedPoint(from, v) : from
          miniPos.corner = nearestCorner(aim, miniPos.size, miniViewport(), miniPlayerH(), miniTopInset())
          saveMiniPos()
          miniDragTL = null
          pointerId = null
          captureEl = null
          samples = []
          settleTo(from, v)
          return
        }
        pointerId = null
        captureEl = null
        placeMiniCard(null, true)
      }

      // pointercancel is not a release (V101). The browser fires it when it
      // takes the gesture away — a touch that became a scroll, capture lost
      // to a window switch, a palm on the trackpad. It used to share endDrag,
      // so an unmoved cancel toggled playback as if it were a tap, and a moved
      // one flung the card from stale coordinates as if the hand had let go.
      // A cancelled gesture is one that never happened: playback untouched,
      // corner unchanged, capture released, the card eased back to where it
      // started.
      const cancelDrag = function (e) {
        if (!miniDragging || (pointerId != null && e.pointerId !== pointerId)) return
        miniDragging = false
        mini.classList.remove('vmini-dragging')
        try { if (captureEl) captureEl.releasePointerCapture(e.pointerId) } catch (_) {}
        if (miniRectTimer) { clearTimeout(miniRectTimer); miniRectTimer = 0 }
        const from = miniDragTL && moved ? { x: miniDragTL.x, y: miniDragTL.y } : null
        miniDragTL = null; pointerId = null; captureEl = null; samples = []; moved = false
        if (from) settleTo(from, { vx: 0, vy: 0 })
        else placeMiniCard(null, true)
      }

      // The picture region joins the drag surfaces (V1): with the smooth
      // player the <video> lives inside it and receives the pointer, so the
      // whole card drags. Under mpv the native window still eats the events
      // here, exactly as before — binding costs nothing.
      for (const el of [handle, bar, $('vmini-video')]) {
        if (!el) continue
        el.addEventListener('pointerdown', onDown(el))
        el.addEventListener('pointermove', onMove)
        el.addEventListener('pointerup', endDrag)
        el.addEventListener('pointercancel', cancelDrag)
        // Capture lost without a cancel (a native window steals the pointer,
        // the tab is hidden mid-drag): the same abort, never a release.
        el.addEventListener('lostpointercapture', cancelDrag)
      }
    }

    // Compact ⇄ large. The picture and card both change size, and the rect is
    // re-sent so the native window resizes with them. Persisted like the corner.
    function toggleMiniSize() {
      stopSettle()
      // From a free width, the button goes to whichever step is the change.
      if (typeof miniPos.size === 'number') miniPos.size = miniPos.size < 400 ? 'large' : 'compact'
      else miniPos.size = miniPos.size === 'large' ? 'compact' : 'large'
      saveMiniPos()
      placeMiniCard(null, true)
      paintMini()
    }

    // A clickable seek on the mini bar, sharing the theatre's seek verbs. The
    // fraction maths is the exported pure one so the bar and its tests agree.
    function bindMiniSeek() {
      const seek = $('vmini-seek')
      if (!seek) return
      const trackOf = function () { return seek.querySelector('.vmini-seek-track') || seek }
      const fracAt = function (clientX) {
        const t = trackOf()
        const r = t.getBoundingClientRect()
        return seekFractionAt(clientX, r.left, r.width)
      }
      let pid = null
      const paint = function (f) {
        const fill = $('vmini-fill'); if (fill) fill.style.width = (f * 100) + '%'
        const knob = $('vmini-knob'); if (knob) knob.style.left = (f * 100) + '%'
      }
      seek.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return
        const dur = Number(state && state.duration) || 0
        if (!dur) return
        pid = e.pointerId
        miniDragging = true      // freeze the state-driven repaint while scrubbing
        try { seek.setPointerCapture(e.pointerId) } catch (_) {}
        const f = fracAt(e.clientX); paint(f)
        if (typeof e.preventDefault === 'function') e.preventDefault()
      })
      seek.addEventListener('pointermove', function (e) {
        if (pid !== e.pointerId) return
        const dur = Number(state && state.duration) || 0
        if (!dur) return
        const f = fracAt(e.clientX); paint(f); scrubSeek(dur * f)
      })
      const done = function (e) {
        if (pid !== e.pointerId) return
        pid = null
        miniDragging = false
        try { seek.releasePointerCapture(e.pointerId) } catch (_) {}
        const dur = Number(state && state.duration) || 0
        if (dur) { scrubEnd(); seekTo(dur * fracAt(e.clientX)) }
      }
      seek.addEventListener('pointerup', done)
      seek.addEventListener('pointercancel', function () { pid = null; miniDragging = false; scrubEnd() })
      seek.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { seekBy(-10); e.preventDefault(); e.stopPropagation() }
        if (e.key === 'ArrowRight') { seekBy(10); e.preventDefault(); e.stopPropagation() }
      })
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

    // Chapter tick marks on the track, so a scene boundary can be aimed at
    // rather than guessed. The state stream only carries the chapter COUNT;
    // the start times come from api.videoChapters(), the same call the chapters
    // menu makes — so the fetch is keyed on count-and-duration and re-done only
    // when that signature changes, not four times a second.
    let lastChapterSig = ''
    function syncChapterTicks() {
      const box = $('vt-seek-chapters')
      if (!box) return
      const dur = Number(state && state.duration) || 0
      const n = (state && Array.isArray(state.chapters)) ? state.chapters.length : 0
      const sig = n + '@' + Math.round(dur)
      if (sig === lastChapterSig) return
      lastChapterSig = sig
      if (!dur || n < 2 || !api || !api.videoChapters) { box.innerHTML = ''; return }
      api.videoChapters().then(function (res) {
        const list = (res && res.ok && Array.isArray(res.chapters)) ? res.chapters : []
        box.innerHTML = list.map(function (c) {
          const start = Number(c.start) || 0
          // A tick at either edge marks nothing: chapter one starts where the
          // bar does, and one at the very end sits under the bar's rounding.
          if (start < 1 || start >= dur - 1) return ''
          return '<i class="vt-seek-tick" style="left:' + ((start / dur) * 100) + '%"></i>'
        }).join('')
      }).catch(function () {})
    }

    // ── Skip ────────────────────────────────────────────────────────────────
    // `hidden` on the strip now means invisible, not gone: the row keeps its
    // fixed height (see the .vt-strip CSS) because collapsing it resized the
    // stage, and the stage is the rectangle the native mpv window is positioned
    // onto — every skip offer made the picture visibly jump mid-watch. Only
    // fullscreen idle actually removes the row, and entering or leaving idle is
    // the one resize that is allowed.
    function syncStrip() {
      const strip = $('vt-strip')
      if (!strip) return
      const skip = $('vt-skip')
      const up = $('vt-upnext')
      strip.hidden = (!skip || skip.hidden) && (!up || up.hidden)
      syncHeld()
    }

    // The no-jump contract, refined: a row that has appeared once this
    // playback keeps its space when its content goes (vt-held: invisible, not
    // gone), so the picture never moves mid-watch — but a playback that never
    // needed the row never pays for it with a dead black band. The one resize
    // this allows is the row's first appearance.
    function syncHeld() {
      const pack = $('vt-pack')
      const strip = $('vt-strip')
      if (pack && !pack.hidden) pack.classList.add('vt-held')
      if (strip && !strip.hidden) strip.classList.add('vt-held')
    }

    function releaseHeld() {
      $('vt-pack')?.classList.remove('vt-held')
      $('vt-strip')?.classList.remove('vt-held')
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
          // Hidden and emptied like every other dismissal, or the strip row
          // keeps holding space for an offer that is no longer there.
          if (autoSkipTimer) {
            cancelAutoSkip()
            box.hidden = true
            box.innerHTML = ''
            syncStrip()
            return
          }
          doSkip(btn.segment)
        })
      }
    }

    function startAutoSkip(segment) {
      cancelAutoSkip()
      autoSkipUntil = 4
      autoSkipTimer = setInterval(function () {
        // Wall clock is not film clock: paused, the viewer is going nowhere,
        // so the countdown holds where it is until playback resumes.
        if (state && state.paused) return
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
      // No next episode means no card. Without this it appeared on films and on
      // the last episode of a season too, offering "Next episode" with a
      // countdown that led nowhere.
      if (!upNextInfo || !upNextTrigger(pos, dur) || upNextDismissed) {
        if (!box.hidden) { box.hidden = true; box.innerHTML = ''; stopUpNext(); syncStrip() }
        return
      }
      if (!box.hidden) return   // already showing; the countdown owns it now
      box.hidden = false
      // A freshly shown card has not asked anything yet.
      stillAsking = false
      syncStrip()
      const n = upNextInfo || {}
      const still = n.still
        ? '<img class="vt-upnext-still" src="' + escapeHtml(n.still) + '" alt="" ' +
          'onerror="this.style.visibility=\'hidden\'">'
        : '<div class="vt-upnext-still"></div>'
      // Whether this card counts down on its own at all. Off when the viewer
      // has turned auto-play off (#18), and the card is then a plain "Play now"
      // with no ring; still on for the still-watching case (#20), where the
      // ring appears but freezes at three seconds behind the prompt.
      const counts = autoNext
      box.innerHTML = still +
        '<div class="vt-upnext-body">' +
          '<div class="vt-upnext-kicker">Up next</div>' +
          '<div class="vt-upnext-title">' + escapeHtml(n.title || 'Next episode') + '</div>' +
          (n.subtitle ? '<div class="vt-upnext-sub">' + escapeHtml(n.subtitle) + '</div>' : '') +
          '<div class="vt-upnext-actions">' +
            '<button type="button" class="vt-upnext-go" id="vt-upnext-go">Play now</button>' +
            (counts ? '<button type="button" id="vt-upnext-stay">Watch credits</button>' : '') +
          '</div>' +
        '</div>' +
        (counts
          ? '<div class="vt-ring" id="vt-upnext-ring">' +
              '<svg viewBox="0 0 34 34"><circle class="bg" cx="17" cy="17" r="14"></circle>' +
              '<circle class="fg" cx="17" cy="17" r="14" id="vt-ring-fg"></circle></svg>' +
              '<div class="vt-ring-num" id="vt-ring-num">' + UPNEXT_SECONDS + '</div>' +
            '</div>'
          : '')
      $('vt-upnext-go')?.addEventListener('click', function () { stopUpNext(); autoAdvances = 0; onNext() })
      $('vt-upnext-stay')?.addEventListener('click', function () {
        // Dismissed for this file only — it must not reappear thirty seconds
        // later having been explicitly declined.
        upNextDismissed = true
        stopUpNext()
        box.hidden = true
        box.innerHTML = ''
        syncStrip()
      })
      // With auto-play off the card just waits: no interval, so it never
      // advances by itself and "Play now" is the only way on.
      if (counts) startUpNext()
    }

    // Swaps the card's actions for the "Still watching?" question. Done in
    // place rather than by re-rendering the whole card, so the countdown ring
    // it is frozen behind is left exactly where it stopped.
    function showStillWatching(box) {
      stillAsking = true
      const actions = box.querySelector('.vt-upnext-actions')
      if (!actions) return
      actions.innerHTML =
        '<span class="vt-still-q">Still watching?</span>' +
        '<button type="button" class="vt-upnext-go" id="vt-upnext-continue">Continue</button>'
      box.querySelector('#vt-upnext-continue')?.addEventListener('click', function () {
        // Answering the question is itself the proof a person is here, so the
        // count clears and the countdown that was held resumes toward the next
        // episode. noteActivity does the clearing; resuming is just unfreezing.
        noteActivity()
        stillAsking = false
        startUpNext()
      })
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
        // Pausing during the credits means "I am staying here for now" — the
        // next episode must never start itself over a paused frame. Hovering
        // the card means the same thing said with the pointer: the user is
        // reading it, deciding — and a card that advances while being read is
        // a card that cannot be declined. Resumes the moment the pointer leaves.
        if ((state && state.paused) || upNextHover) return
        // Enough episodes have played to an empty room: hold at three seconds
        // and ask, rather than starting yet another one. The interval keeps
        // running but goes no lower, so answering Continue can resume it from
        // exactly here. Any real activity clears autoAdvances and this branch
        // is never reached.
        if (autoAdvances >= STILL_WATCHING_AFTER && upNextLeft <= 3) {
          if (!stillAsking) { showStillWatching($('vt-upnext')) }
          return
        }
        upNextLeft--
        const num = $('vt-ring-num')
        if (num) num.textContent = String(Math.max(0, upNextLeft))
        const fg = $('vt-ring-fg')
        if (fg) fg.setAttribute('stroke-dashoffset',
          String(circumference * (1 - Math.max(0, upNextLeft) / UPNEXT_SECONDS)))
        if (upNextLeft <= 0) {
          stopUpNext()
          // This advance was unattended: count it, so three in a row raise the
          // prompt on the next card. A deliberate Play now or any activity
          // resets the count elsewhere.
          autoAdvances++
          if (onNext) onNext()
        }
      }, 1000)
    }

    function stopUpNext() {
      if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null }
    }

    // ── Season pack episodes ────────────────────────────────────────────────
    // The pack streaming right now already contains these, so choosing one is
    // a file change on a live torrent rather than a fresh search.
    let packFiles = []

    function setPack(files, onSelect, onContext) {
      packFiles = Array.isArray(files) ? files : []
      const box = $('vt-pack')
      const list = $('vt-pack-list')
      if (!box || !list) return
      if (packFiles.length < 2) { box.hidden = true; list.innerHTML = ''; syncHeld(); return }
      box.hidden = false
      syncHeld()
      const label = $('vt-pack-label')
      if (label) label.textContent = packFiles.length + ' episodes'
      // A complete-series batch carries several seasons, each numbered from 01
      // again — without the group dividers the strip reads as one long row of
      // repeating numbers. The shared prefix ("Tokyo Revengers ") says nothing
      // inside this pack, so it is stripped and only what differs is shown.
      const groups = []
      packFiles.forEach(function (f) {
        const g = f.group || ''
        if (groups.indexOf(g) === -1) groups.push(g)
      })
      const many = groups.length > 1
      let common = ''
      if (many) {
        common = groups.reduce(function (a, b) {
          let i = 0
          while (i < a.length && i < b.length && a[i] === b[i]) i++
          return a.slice(0, i)
        })
      }
      const groupTag = function (g) {
        const short = (g || '').slice(common.length).trim()
        return short || 'Season 1'
      }
      let lastGroup = null
      list.innerHTML = packFiles.map(function (f, i) {
        // An unnumbered file still needs a handle; its position is the least
        // wrong thing to show.
        const name = f.episode != null ? String(f.episode) : String(i + 1)
        let head = ''
        if (many && (f.group || '') !== lastGroup) {
          lastGroup = f.group || ''
          head = '<span class="vt-pack-group">' + escapeHtml(groupTag(lastGroup)) + '</span>'
        }
        return head + '<button class="vt-ep' + (f.current ? ' current' : '') + '"' +
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
        // Right-click an episode to keep it offline (#44). The renderer decides
        // whether it is downloaded enough to save and toasts the outcome.
        if (onContext) {
          b.addEventListener('contextmenu', function (ev) {
            ev.preventDefault()
            onContext(Number(b.dataset.file))
          })
        }
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
    // While a scrub is in flight the picture should follow the pointer, not sit
    // frozen until release. A keyframe (fast) seek lands on the nearest cached
    // keyframe — cheap enough to fire repeatedly and, on a torrent, avoids
    // waiting on bytes an exact seek would demand. The exact landing seek runs
    // on pointerup. Throttled so a fast sweep is not one mpv command per pixel.
    const SCRUB_SEEK_MS = 100
    let scrubLastAt = 0
    let scrubTimer = null
    let scrubPending = null
    function scrubSeek(sec) {
      scrubPending = sec
      const nowMs = (typeof Date !== 'undefined' ? Date.now() : 0)
      const since = nowMs - scrubLastAt
      const fire = function () {
        scrubLastAt = (typeof Date !== 'undefined' ? Date.now() : 0)
        send('seek', { seconds: scrubPending, mode: 'absolute+keyframes' })
      }
      if (since >= SCRUB_SEEK_MS) { fire(); return }
      if (scrubTimer) return
      scrubTimer = setTimeout(function () { scrubTimer = null; fire() }, SCRUB_SEEK_MS - since)
    }
    function scrubEnd() {
      if (scrubTimer) { clearTimeout(scrubTimer); scrubTimer = null }
      scrubPending = null
    }

    // §48: grab a frame. main writes the file and hands back its path; the deck
    // only knows the screenshot happened once that path comes back, so the toast
    // is raised here rather than optimistically. A failed grab says so instead
    // of leaving the viewer wondering whether it saved.
    function takeScreenshot() {
      send('screenshot').then(function (res) {
        if (res && res.ok && res.value && res.value.path) {
          onToast('Screenshot saved to ' + res.value.path)
        } else {
          onToast('Could not save the screenshot')
        }
      })
    }

    // Wheel → one step of intent, or none (V103). The old code read only the
    // sign of deltaY, so a zero delta stepped volume UP, a purely horizontal
    // swipe changed volume, and a high-resolution trackpad — which reports
    // dozens of tiny events per flick — produced a dozen 5-point jumps. Now:
    // a single event of at least one notch is one step (a mouse detent is
    // unchanged at 5 points); smaller deltas accumulate until they add up to a
    // notch; the accumulator resets when the direction flips or after a short
    // pause; horizontal-dominant and zero deltas are ignored outright.
    const WHEEL_NOTCH_PX = 40
    const WHEEL_IDLE_MS = 150
    let wheelAcc = 0
    let wheelAt = 0
    function wheelDirection(e) {
      const mode = Number(e && e.deltaMode) || 0
      let dy = Number(e && e.deltaY) || 0
      const dx = Number(e && e.deltaX) || 0
      if (!dy || Math.abs(dx) > Math.abs(dy)) return 0
      if (mode === 1) dy *= 16            // lines → px
      else if (mode === 2) dy = Math.sign(dy) * WHEEL_NOTCH_PX   // pages → one notch
      const now = nowMs()
      if (now - wheelAt > WHEEL_IDLE_MS || Math.sign(wheelAcc) !== Math.sign(dy)) wheelAcc = 0
      wheelAt = now
      if (Math.abs(dy) >= WHEEL_NOTCH_PX) { wheelAcc = 0; return dy > 0 ? -1 : 1 }
      wheelAcc += dy
      if (Math.abs(wheelAcc) < WHEEL_NOTCH_PX) return 0
      wheelAcc -= Math.sign(wheelAcc) * WHEEL_NOTCH_PX
      return dy > 0 ? -1 : 1
    }

    function setVolume(v) {
      // The page's <video> stops at 100 %; only mpv has the 130 % headroom.
      if (pictureInPage()) v = Math.min(100, Number(v) || 0)
      const next = Math.max(0, Math.min(130, Math.round(v)))
      send('volume', { value: next })
      if (state) state.volume = next
    }

    // A wheel or keyboard volume change happens with the eyes on the picture,
    // not on the deck — so the new level is flashed as an mpv OSD message,
    // which is the one piece of text that CAN be drawn over the native window,
    // because mpv draws it itself. Defensive: an api without videoOsd, or one
    // whose stub returns no promise, must cost nothing.
    function flashVolume() { osd('Volume ' + Math.round(Number(state && state.volume) || 0) + '%', 800) }

    // A line of on-screen text. mpv draws its own; with the picture in the
    // page the deck draws it on the stage (V4).
    let osdTimer = null
    function osd(text, ms) {
      if (pictureInPage()) {
        const el = $('vt-osd')
        if (!el) return
        el.textContent = text
        el.classList.add('on')
        clearTimeout(osdTimer)
        osdTimer = setTimeout(function () { el.classList.remove('on') }, ms || 800)
        return
      }
      if (!api || !api.videoOsd) return
      try {
        const p = api.videoOsd(text, ms || 800)
        if (p && typeof p.catch === 'function') p.catch(function () {})
      } catch (_) { /* the OSD is decoration, never a blocker */ }
    }
    // The YouTube-style burst on a click: the icon of what just happened,
    // blooming out of the centre of the picture and fading.
    function burst(icon) {
      const el = $('vt-burst')
      if (!el) return
      el.innerHTML = icon
      el.classList.remove('on')
      void el.offsetWidth
      el.classList.add('on')
    }

    function toggleTimeMode() {
      timeMode = timeMode === 'total' ? 'remaining' : 'total'
      try {
        if (local && typeof local.write === 'function') local.write('papaVtTimeMode', timeMode)
      } catch (_) { /* a failed save keeps the toggle for this session only */ }
      render()
    }

    // #18: persisted the same way the time-mode toggle is, under its own key.
    // A failed write keeps the choice for this session only — storage is a
    // convenience, never a blocker.
    function toggleAutoNext() {
      autoNext = !autoNext
      try {
        if (local && typeof local.write === 'function') local.write('papaVtAutoNext', autoNext)
      } catch (_) { /* the session still honours the choice */ }
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
      // The stats poll lives exactly as long as its panel. Stopped here, in the
      // one place every dismissal funnels through — outside click, Escape,
      // minimise, close — so it can never keep polling a closed panel.
      stopStats()
      setStageInset(0)
      // The question is answered, so the idle clock can run again.
      if (typeof noteActivity === 'function') noteActivity()
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
      // Measured after placing it, since the clamps above can move it.
      const placed = m.getBoundingClientRect()
      const stage = $('vt-stage')
      if (stage) {
        const st = stage.getBoundingClientRect()
        const covered = st.bottom - placed.top
        // Only when the menu actually reaches into the picture, and only by as
        // much as it reaches, so a menu that already clears the video costs the
        // viewer nothing.
        setStageInset(covered > 0 && placed.right > st.left && placed.left < st.right ? covered + 8 : 0)
      }
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

    // ── Language memory ─────────────────────────────────────────────────────
    // The show remembers what it was listened to and read in. prefs.audioLang
    // and prefs.subLang arrive with media.prefs; when the file's tracks first
    // turn up they are matched against those, and picking a track by hand
    // reports its language back through media.onPrefChange so the renderer can
    // store it per show. Codes are compared exactly as mpv reports them
    // ('eng', 'jpn'), which is also how they were stored — so a plain
    // case-insensitive match is the whole comparison. Everything here is a
    // no-op when the callback, the codes or the tracks are missing: memory is
    // a convenience and must never be able to stop playback.
    let langApplied = false
    let langChosen = { sub: false, audio: false }

    function notePrefChange(change) {
      if (!media || typeof media.onPrefChange !== 'function') return
      try { media.onPrefChange(change) } catch (_) { /* never let memory stop playback */ }
    }

    function sameLang(a, b) {
      return String(a || '').toLowerCase() === String(b || '').toLowerCase()
    }

    function applyLangPrefs() {
      if (langApplied || !state) return
      // Marked applied before the fetch resolves, so a second state tick
      // cannot start a second lookup; an explicit pick made while the lookup
      // is in flight is honoured by the langChosen check inside it.
      langApplied = true
      // The remembered subtitle look is applied the same beat the language is —
      // once the file is playing and a subtitle track exists to style. Only when
      // it differs from mpv's defaults, so a viewer who never touched the style
      // spends no commands on it (roadmap #30).
      if (subStyle.size !== 'M' || subStyle.color !== 'white' ||
          subStyle.background !== 'none' || subStyle.position !== 'low') {
        applySubStyle()
      }
      // A remembered subtitle delay is applied once the file is playing, the
      // same beat the remembered language is. It seeds the local accumulator
      // too, so the CC menu's readout and further nudges start from the stored
      // value rather than from zero. Guarded so a missing pref costs nothing.
      if (typeof prefs.subDelayMs === 'number' && prefs.subDelayMs !== 0) {
        delayMs.subDelay = prefs.subDelayMs
        send('subDelay', { value: prefs.subDelayMs })
      }
      const wantAudio = !langChosen.audio && prefs.audioLang
      const wantSub = !langChosen.sub && prefs.subLang
      if ((!wantAudio && !wantSub) || !api || !api.videoTracks) return
      api.videoTracks().then(function (res) {
        const all = (res && res.ok && Array.isArray(res.tracks)) ? res.tracks : []
        ;[['audio', wantAudio], ['sub', wantSub]].forEach(function (pair) {
          const type = pair[0], want = pair[1]
          if (!want || langChosen[type]) return
          const hit = all.find(function (t) { return t && t.type === type && t.lang && sameLang(t.lang, want) })
          if (!hit) return
          send('track', { type: type, id: hit.id })
          if (state && state.tracks) state.tracks[type] = hit.id
        })
      }).catch(function () {})
    }

    async function openTrackMenu(type) {
      const res = api && api.videoTracks ? await api.videoTracks().catch(function () { return null }) : null
      const all = (res && res.ok && Array.isArray(res.tracks)) ? res.tracks : []
      tracks[type] = all.filter(function (t) { return t.type === type })
      const current = state && state.tracks ? state.tracks[type] : null
      const list = tracks[type]

      // Subtitle files already inside the torrent. A pack routinely ships .srt
      // files next to the video, and they are the subtitles most likely to
      // actually match the release — but mpv only sees the one file it was
      // handed. Both APIs are optional: without them the menu is what it was.
      let torrentSubs = []
      if (type === 'sub' && api && api.videoSubsInTorrent) {
        const found = await api.videoSubsInTorrent().catch(function () { return null })
        if (found && found.ok && Array.isArray(found.subs)) torrentSubs = found.subs
      }

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
          '<div class="vt-menu-row">Delay<span class="vt-menu-val" id="vt-subdelay">' +
            delayMs.subDelay + ' ms</span>' +
          '<button class="vt-chip" data-delay="-50">&minus;50</button>' +
          '<button class="vt-chip" data-delay="50">+50</button></div>'
        if (torrentSubs.length) {
          html += '<div class="vt-menu-sep"></div>' +
            '<div class="vt-menu-head">In this torrent</div>' +
            torrentSubs.map(function (s, i) {
              return '<button class="vt-menu-item" role="menuitem" data-subfile="' + i + '">' +
                '<span class="vt-menu-tick"></span>' +
                '<span class="vt-menu-label">' + escapeHtml(s.name || ('Subtitle ' + (i + 1))) + '</span>' +
              '</button>'
            }).join('')
        }
        html += '<div class="vt-menu-sep"></div>' +
          // Size, colour, background and vertical position, one tap away in a
          // submenu so the CC menu itself stays a track list (roadmap #30).
          '<button class="vt-menu-item" role="menuitem" data-subact="style">' +
            '<span class="vt-menu-tick"></span>' +
            '<span class="vt-menu-label">Style…</span>' +
          '</button>' +
          '<button class="vt-menu-item" role="menuitem" data-subact="open">' +
            '<span class="vt-menu-tick"></span>' +
            '<span class="vt-menu-label">Add from file…</span>' +
          '</button>'
        // Online search needs both the API and something to search for; the
        // renderer supplies the title identity on open(). Absent either, the
        // menu simply doesn't offer what it cannot do.
        if (api && api.videoSubSearch && media && media.subMeta) {
          html += '<button class="vt-menu-item" role="menuitem" data-subact="online">' +
            '<span class="vt-menu-tick"></span>' +
            '<span class="vt-menu-label">Search online…</span>' +
          '</button>'
        }
      } else {
        html += '<div class="vt-menu-sep"></div>' +
          '<div class="vt-menu-row">Delay<span class="vt-menu-val" id="vt-auddelay">0 ms</span>' +
          '<button class="vt-chip" data-adelay="-50">&minus;50</button>' +
          '<button class="vt-chip" data-adelay="50">+50</button></div>'
      }

      openMenu(type === 'sub' ? 'vt-subs' : 'vt-audio', html, function (m) {
        const items = Array.prototype.slice.call(m.querySelectorAll('.vt-menu-item'))
        // Only the leading items are track picks. The torrent-subtitle rows and
        // "Add from file…" share the class for their styling and keyboard focus,
        // but binding them as track picks would read past the end of `list` and
        // send a null track — silently switching subtitles Off.
        const trackCount = (type === 'sub' ? 1 : 0) + list.length
        items.slice(0, trackCount).forEach(function (el, i) {
          el.addEventListener('click', function () {
            const offset = type === 'sub' ? 1 : 0
            const picked = (type === 'sub' && i === 0) ? null : list[i - offset]
            const id = picked ? picked.id : null
            send('track', { type: type, id: id })
            // An explicit pick — including Off — outranks the remembered
            // language for the rest of this file, and a pick that carries a
            // language code becomes the remembered language.
            langChosen[type] = true
            if (picked && picked.lang) {
              notePrefChange(type === 'sub' ? { subLang: picked.lang } : { audioLang: picked.lang })
            }
            if (state && state.tracks) state.tracks[type] = id
            closeMenu()
            render()
          })
        })
        bindDelay(m, '[data-delay]', 'delay', 'subDelay', 'vt-subdelay')
        bindDelay(m, '[data-adelay]', 'adelay', 'audioDelay', 'vt-auddelay')
        // A torrent subtitle is not on disk yet: videoSubServe extracts it and
        // answers with a real path, and only then can mpv be told to load it.
        m.querySelectorAll('[data-subfile]').forEach(function (b) {
          b.addEventListener('click', function () {
            const s = torrentSubs[Number(b.dataset.subfile)]
            closeMenu()
            if (!s || !api || !api.videoSubServe) return
            api.videoSubServe({ index: s.index }).then(function (r) {
              if (r && r.ok && r.path) send('subAdd', { path: r.path })
            }).catch(function () {})
          })
        })
        m.querySelectorAll('[data-subact]').forEach(function (b) {
          b.addEventListener('click', function () {
            const act = b.dataset.subact
            closeMenu()
            if (act === 'style') { openSubStyleMenu(); return }
            if (act === 'online') { openOnlineSubsMenu(); return }
            if (api && api.videoSubOpen) api.videoSubOpen().catch(function () {})
          })
        })
      })
    }

    // The online-subtitle picker: one search against the identity the renderer
    // supplied, results listed newest-downloads-first as the service ranks
    // them. Missing API key is a first-class answer, not an error — the
    // service requires one and the row says where to put it.
    async function openOnlineSubsMenu() {
      if (!api || !api.videoSubSearch || !media || !media.subMeta) return
      openMenu('vt-subs', '<div class="vt-menu-head">Online subtitles</div>' +
        '<div class="vt-menu-row">Searching…</div>', function () {})
      const res = await api.videoSubSearch(media.subMeta).catch(function () { return null })
      let html = '<div class="vt-menu-head">Online subtitles</div>'
      const results = res && res.ok && Array.isArray(res.results) ? res.results : []
      if (res && res.needsKey) {
        html += '<div class="vt-menu-row">Needs an OpenSubtitles API key — add one in Settings → Video.</div>'
      } else if (!results.length) {
        html += '<div class="vt-menu-row">Nothing found for this title.</div>'
      } else {
        html += results.slice(0, 8).map(function (r, i) {
          const label = [(r.language || '??').toUpperCase(), r.release || ('Result ' + (i + 1))].join(' · ')
          const note = r.downloadCount ? (r.downloadCount + ' downloads') : ''
          return '<button class="vt-menu-item" role="menuitem" data-online-sub="' + i + '">' +
            '<span class="vt-menu-tick"></span>' +
            '<span class="vt-menu-label">' + escapeHtml(label) + '</span>' +
            (note ? '<span class="vt-menu-note">' + escapeHtml(note) + '</span>' : '') +
          '</button>'
        }).join('')
      }
      openMenu('vt-subs', html, function (m) {
        m.querySelectorAll('[data-online-sub]').forEach(function (b) {
          b.addEventListener('click', function () {
            const r = results[Number(b.dataset.onlineSub)]
            closeMenu()
            if (!r || !api.videoSubDownload) return
            api.videoSubDownload({ fileId: r.fileId }).then(function (d) {
              if (d && d.ok && d.path) send('subAdd', { path: d.path })
            }).catch(function () {})
          })
        })
      })
    }

    // The subtitle-style submenu (roadmap #30): the four choices a viewer
    // actually reaches for — size, colour, background box and vertical position
    // — each a labelled row of chips that light the current pick. Every change
    // applies to mpv at once (through the same subStyle verb the settings rows
    // use) and is persisted app-wide, so the look carries to the next film. The
    // menu stays open after a pick so several can be tried in one sitting.
    function openSubStyleMenu() {
      const row = function (label, dataKey, options, current) {
        return '<div class="vt-menu-row">' + escapeHtml(label) +
          options.map(function (o) {
            return '<button class="vt-chip' + (o.value === current ? ' on' : '') + '" ' +
              'data-' + dataKey + '="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</button>'
          }).join('') + '</div>'
      }
      const html = '<div class="vt-menu-head">Subtitle style</div>' +
        row('Size', 'substyle-size',
          [{ value: 'S', label: 'S' }, { value: 'M', label: 'M' },
           { value: 'L', label: 'L' }, { value: 'XL', label: 'XL' }], subStyle.size) +
        row('Colour', 'substyle-color',
          [{ value: 'white', label: 'White' }, { value: 'yellow', label: 'Yellow' },
           { value: 'cyan', label: 'Cyan' }], subStyle.color) +
        row('Background', 'substyle-bg',
          [{ value: 'none', label: 'None' }, { value: 'soft', label: 'Soft' },
           { value: 'solid', label: 'Solid' }], subStyle.background) +
        row('Position', 'substyle-pos',
          [{ value: 'low', label: 'Low' }, { value: 'mid', label: 'Mid' }], subStyle.position)

      openMenu('vt-subs', html, function (m) {
        // One handler per control. Each writes the named state, persists, pushes
        // the mapped mpv value, then relights its own row's chips in place.
        const wire = function (attr, field, apply) {
          m.querySelectorAll('[data-' + attr + ']').forEach(function (b) {
            b.addEventListener('click', function () {
              subStyle[field] = b.dataset[attr.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase() })]
              persistSubStyle()
              apply()
              m.querySelectorAll('[data-' + attr + ']').forEach(function (o) {
                o.classList.toggle('on', o.dataset[attr.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase() })] === subStyle[field])
              })
            })
          })
        }
        wire('substyle-size', 'size', function () { sendSubStyle({ scale: subScaleValue() }) })
        wire('substyle-color', 'color', function () { sendSubStyle({ color: SUB_COLORS[subStyle.color] || '#FFFFFF' }) })
        wire('substyle-bg', 'background', function () { sendSubStyle({ backColor: subBackValue() }) })
        wire('substyle-pos', 'position', function () { sendSubStyle({ pos: SUB_POS[subStyle.position] || 100 }) })
      })
    }

    // Torrent releases desync constantly; nudging is the fix and it has to be
    // reachable while watching, not buried in settings.
    let delayMs = { subDelay: 0, audioDelay: 0 }

    // ── Subtitle styling (roadmap #30) ────────────────────────────────────────
    // Size, colour, background box and vertical position, each a named choice
    // mapped to the mpv value the `subStyle` verb sets (SUB_STYLE_PROPS in
    // video-engine.js). Persisted app-wide — a viewer's caption preference is
    // theirs, not a property of one release — so unlike the per-show delay these
    // survive across every film. Read once at creation from PapaLocal under one
    // key; a missing or broken store leaves the defaults, since styling is a
    // convenience and must never block playback.
    const SUB_SIZES = { S: 0.8, M: 1, L: 1.3, XL: 1.6 }
    const SUB_COLORS = { white: '#FFFFFF', yellow: '#FFFF00', cyan: '#00FFFF' }
    const SUB_BACKS = { none: '#00000000', soft: '#80000000', solid: '#FF000000' }
    // mpv sub-pos runs 0 (top) to 100 (bottom); low sits at the default bottom,
    // mid lifts the line clear of a burned-in credit or a busy lower third.
    const SUB_POS = { low: 100, mid: 85 }

    let subStyle = { size: 'M', color: 'white', background: 'none', position: 'low' }
    try {
      if (local && typeof local.read === 'function') {
        const saved = local.read('papaVtSubStyle')
        if (saved && typeof saved === 'object') {
          if (SUB_SIZES[saved.size]) subStyle.size = saved.size
          if (SUB_COLORS[saved.color]) subStyle.color = saved.color
          if (SUB_BACKS[saved.background]) subStyle.background = saved.background
          if (SUB_POS[saved.position]) subStyle.position = saved.position
        }
      }
    } catch (_) { /* styling is a convenience, never a blocker */ }

    // Legacy aliases the settings-menu rows and their tests still read: the
    // numeric scale and the on/off backing box, derived from the named state so
    // there is one source of truth rather than two that drift.
    function subScaleValue() { return SUB_SIZES[subStyle.size] || 1 }
    function subBackValue() { return SUB_BACKS[subStyle.background] || '#00000000' }

    function persistSubStyle() {
      try {
        if (local && typeof local.write === 'function') local.write('papaVtSubStyle', subStyle)
      } catch (_) { /* the session still honours the choice */ }
    }

    // Push one or more style keys to mpv. Everything routes through the proven
    // `subStyle` control verb (its keys are members of SUB_STYLE_PROPS); when the
    // Wave-4 videoSubStyle passthrough is also exposed it is called in addition,
    // feature-detected, so a backend that maps friendly names itself stays in
    // step. Neither call is allowed to throw into the caller.
    function sendSubStyle(patch) {
      send('subStyle', patch)
      if (api && typeof api.videoSubStyle === 'function') {
        try {
          const p = api.videoSubStyle({
            size: subStyle.size, color: subStyle.color,
            background: subStyle.background, position: subStyle.position,
          })
          if (p && typeof p.catch === 'function') p.catch(function () {})
        } catch (_) { /* the passthrough is optional decoration */ }
      }
    }

    // Applies the whole remembered look to the file now playing. Called once the
    // file is up (from applyLangPrefs, the same beat the language is applied), so
    // a viewer's caption preference is in force from the first subtitle on.
    function applySubStyle() {
      sendSubStyle({
        scale: subScaleValue(),
        color: SUB_COLORS[subStyle.color] || '#FFFFFF',
        backColor: subBackValue(),
        pos: SUB_POS[subStyle.position] || 100,
      })
    }

    function bindDelay(menu, selector, dataKey, verb, valueId) {
      menu.querySelectorAll(selector).forEach(function (b) {
        b.addEventListener('click', function () {
          delayMs[verb] += Number(b.dataset[dataKey])
          // Milliseconds, under the same `value` key every other single-argument
          // verb uses. This sent `seconds` while main read `ms`, so both delay
          // controls did nothing — and the contract test could not see it,
          // because the verb here is a variable rather than a literal.
          send(verb, { value: delayMs[verb] })
          const el = doc.getElementById(valueId)
          if (el) el.textContent = delayMs[verb] + ' ms'
          // Subtitle desync is a property of the release, so it is worth
          // remembering per show: the next episode of the same encode is
          // desynced by the same amount. Reported the same way audioLang and
          // subLang are — through media.onPrefChange, which the renderer keys
          // to the show — and read back as prefs.subDelayMs on the next open.
          // Audio delay is not remembered: it is nudged to match a specific
          // file's tracks, not the show's. A no-op without the callback.
          if (verb === 'subDelay') notePrefChange({ subDelayMs: delayMs[verb] })
        })
      })
    }

    // Chapters. mpv's own controller offered chapter navigation, and turning it
    // off when embedded took that away with nothing in its place — the one
    // capability genuinely lost rather than replaced. Films and long episodes
    // carry them, so this is how you jump to a scene without scrubbing.
    async function openChapterMenu() {
      const res = api && api.videoChapters ? await api.videoChapters().catch(function () { return null }) : null
      const list = (res && res.ok && Array.isArray(res.chapters)) ? res.chapters : []
      const pos = Number(state && state.position) || 0
      // The chapter you are in is the last one that has already started.
      let currentIndex = -1
      for (let i = 0; i < list.length; i++) {
        if (Number(list[i].start) <= pos + 0.25) currentIndex = i
      }
      let html = '<div class="vt-menu-head">Chapters</div>'
      if (!list.length) {
        html += '<div class="vt-menu-row">This file has no chapters</div>'
      } else {
        html += list.map(function (c, i) {
          return menuItem(c.title || ('Chapter ' + (i + 1)), i === currentIndex, fmtTime(Number(c.start) || 0))
        }).join('')
      }
      openMenu('vt-chapters', html, function (m) {
        m.querySelectorAll('.vt-menu-item').forEach(function (el, i) {
          el.addEventListener('click', function () {
            const c = list[i]
            if (c) seekTo(Number(c.start) || 0)
            closeMenu()
          })
        })
      })
    }

    // The button only earns its place when the file actually has chapters, so
    // it is shown from the state stream rather than always.
    function syncChapterButton() {
      const btn = $('vt-chapters')
      if (!btn) return
      const n = (state && Array.isArray(state.chapters)) ? state.chapters.length : 0
      btn.hidden = n < 2
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

    // ── Stats ───────────────────────────────────────────────────────────────
    // What the player actually knows, in one small panel: the state stream's
    // numbers always, and the torrent's health — download rate, peers, how much
    // of the file exists — when main exposes api.videoStreamStats. The torrent
    // rows are polled every two seconds only while the panel is open; the state
    // rows ride the same poll rather than the 4/s stream, because a stats panel
    // that flickers faster than it can be read is worse than a slow one.
    let statsTimer = null

    function stopStats() {
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
    }

    function paintStats() {
      const put = function (id, text) { const n = $(id); if (n) n.textContent = text }
      const dur = Number(state && state.duration) || 0
      const pos = Number(state && state.position) || 0
      put('vt-stat-pos', fmtTime(pos) + ' / ' + fmtTime(dur))
      put('vt-stat-speed', (Number(state && state.speed) || 1) + '×')
      put('vt-stat-vol', Math.round(Number(state && state.volume) || 0) + '%' +
        (state && state.muted ? ' (muted)' : ''))
      const tr = (state && state.tracks) || {}
      put('vt-stat-tracks', 'audio ' + (tr.audio != null ? tr.audio : '–') +
        ' · sub ' + (tr.sub != null ? tr.sub : 'off'))
      if (!api || !api.videoStreamStats) return
      let p = null
      try { p = api.videoStreamStats() } catch (_) { return }
      if (!p || typeof p.then !== 'function') return
      p.then(function (res) {
        if (!res || !res.ok) return
        put('vt-stat-down', fmtBytes(res.down) + '/s')
        put('vt-stat-peers', String(res.peers != null ? res.peers : '–'))
        put('vt-stat-progress',
          Math.round(Math.max(0, Math.min(1, Number(res.progress) || 0)) * 100) + '%')
      }).catch(function () {})
    }

    function statsRow(label, id) {
      return '<div class="vt-menu-row">' + label +
        '<span class="vt-menu-val" id="' + id + '"></span></div>'
    }

    function toggleStatsMenu() {
      // A live poll means the panel is open; the chip is a toggle, not a stack.
      if (statsTimer) { closeMenu(); return }
      let html = '<div class="vt-menu-head">Stats</div>' +
        statsRow('Position', 'vt-stat-pos') +
        statsRow('Speed', 'vt-stat-speed') +
        statsRow('Volume', 'vt-stat-vol') +
        statsRow('Tracks', 'vt-stat-tracks')
      if (api && api.videoStreamStats) {
        html += '<div class="vt-menu-sep"></div>' +
          '<div class="vt-menu-head">Stream</div>' +
          statsRow('Download', 'vt-stat-down') +
          statsRow('Peers', 'vt-stat-peers') +
          statsRow('Fetched', 'vt-stat-progress')
      }
      openMenu('vt-stats', html, function () {
        paintStats()
        statsTimer = setInterval(paintStats, 2000)
      })
    }

    function openSettingsMenu() {
      const html = '<div class="vt-menu-head">Picture &amp; sound</div>' +
        '<div class="vt-menu-row">Zoom to fill' +
          '<button class="vt-chip" data-zoom="fill">Fill</button>' +
          '<button class="vt-chip" data-zoom="reset">Reset</button></div>' +
        // "Night mode" said nothing about what it does; the row levels a
        // cinema mix so quiet dialogue is audible without the next explosion
        // waking the house, and that is what people are looking for it under.
        '<div class="vt-menu-row">Louder dialogue (night mode)' +
          '<button class="vt-chip" data-af="night">On</button>' +
          '<button class="vt-chip" data-af="off">Off</button></div>' +
        // Releases are routinely encoded with the wrong aspect flag, and
        // anamorphic sources land stretched. mpv can override it and the
        // engine already could; nothing offered it.
        '<div class="vt-menu-row">Aspect' +
          '<button class="vt-chip" data-aspect="-1">Auto</button>' +
          '<button class="vt-chip" data-aspect="1.7778">16:9</button>' +
          '<button class="vt-chip" data-aspect="1.3333">4:3</button>' +
          '<button class="vt-chip" data-aspect="2.35">2.35</button></div>' +
        '<div class="vt-menu-sep"></div>' +
        '<div class="vt-menu-head">Subtitles</div>' +
        // Three fixed sizes rather than a nudge-by-a-tenth pair: people reach
        // for "bigger" or "smaller", not for a precise scale, and a labelled
        // S/M/L reads at a glance which one is on. Each is an absolute scale,
        // so the current one lights up regardless of how it was reached.
        '<div class="vt-menu-row">Size' +
          '<button class="vt-chip' + (subScaleValue() <= 0.85 ? ' on' : '') + '" data-subsize="0.8">S</button>' +
          '<button class="vt-chip' + (subScaleValue() > 0.85 && subScaleValue() < 1.15 ? ' on' : '') + '" data-subsize="1">M</button>' +
          '<button class="vt-chip' + (subScaleValue() >= 1.15 ? ' on' : '') + '" data-subsize="1.3">L</button></div>' +
        // A translucent box behind the text, for a bright scene that washes out
        // plain captions. backColor is an mpv ARGB string: semi-opaque black on,
        // fully transparent off.
        '<div class="vt-menu-row">Background' +
          '<button class="vt-chip' + (subStyle.background !== 'none' ? ' on' : '') + '" data-subback="1">On</button>' +
          '<button class="vt-chip' + (subStyle.background === 'none' ? ' on' : '') + '" data-subback="0">Off</button></div>' +
        menuItem('Add a subtitle file…') +
        '<div class="vt-menu-sep"></div>' +
        '<div class="vt-menu-head">Playback</div>' +
        // #18: when on, the Up Next card counts down and rolls into the next
        // episode; when off, the card still appears but waits on Play now.
        menuItem('Play next episode automatically', autoNext) +
        // #26: controls painted on the picture (a transparent overlay window)
        // instead of the held rows below it. Only offered when main exposes the
        // config channel; a live toggle so it can be tried and backed out of.
        // The note flags that it takes effect on the next play — the overlay is
        // built when playback starts, so flipping it mid-film does not retrofit
        // the running window.
        ((api && api.videoConfigGet && api.videoConfigSet)
          ? menuItem('Controls on the picture (overlay)', overlayControls, 'applies next play')
          : '') +
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
        m.querySelectorAll('[data-aspect]').forEach(function (b) {
          b.addEventListener('click', function () {
            send('aspect', { value: Number(b.dataset.aspect) })
          })
        })
        // Burned-in styling cannot be changed, but for a real subtitle track
        // the size and a backing box are the two things people actually reach
        // for. Both go through the one `subStyle` verb the engine exposes:
        // `scale` is a number, `backColor` an mpv ARGB string.
        m.querySelectorAll('[data-subsize]').forEach(function (b) {
          b.addEventListener('click', function () {
            const scale = Number(b.dataset.subsize)
            // Map the numeric scale back onto a named size so the one persisted
            // style stays in step with this quick S/M/L row (roadmap #30).
            subStyle.size = scale <= 0.85 ? 'S' : scale >= 1.45 ? 'XL' : scale >= 1.15 ? 'L' : 'M'
            persistSubStyle()
            send('subStyle', { scale: scale })
            // Relight the row without closing the menu, so a second size can be
            // tried straight away.
            m.querySelectorAll('[data-subsize]').forEach(function (o) {
              o.classList.toggle('on', Number(o.dataset.subsize) === scale)
            })
          })
        })
        m.querySelectorAll('[data-subback]').forEach(function (b) {
          b.addEventListener('click', function () {
            const on = b.dataset.subback === '1'
            // On keeps whatever box the full menu last chose (soft/solid), so the
            // two surfaces agree; a fresh On defaults to the soft box.
            subStyle.background = on ? (subStyle.background !== 'none' ? subStyle.background : 'soft') : 'none'
            persistSubStyle()
            send('subStyle', { backColor: subBackValue() })
            m.querySelectorAll('[data-subback]').forEach(function (o) {
              o.classList.toggle('on', (o.dataset.subback === '1') === on)
            })
          })
        })
        // The menu items in DOM order: Add-a-subtitle, Play-next-automatically,
        // then the OPTIONAL overlay row (#26, only when main exposes the config
        // channel), then Take-screenshot. Indices are computed so the overlay
        // row's presence never shifts a handler onto the wrong item.
        const items = m.querySelectorAll('.vt-menu-item')
        const hasOverlayRow = !!(api && api.videoConfigGet && api.videoConfigSet)
        const addSub = items[0]
        if (addSub) {
          addSub.addEventListener('click', function () {
            closeMenu()
            if (api && api.videoSubOpen) api.videoSubOpen().catch(function () {})
          })
        }
        const auto = items[1]
        if (auto) {
          auto.addEventListener('click', function () {
            toggleAutoNext()
            // Relight the tick in place so the change is visible without
            // reopening the menu.
            auto.classList.toggle('on', autoNext)
            const tick = auto.querySelector('.vt-menu-tick')
            if (tick) tick.innerHTML = autoNext ? ICON.tick : ''
          })
        }
        // #26: flip the overlay-controls config and relight the tick. main reads
        // the same key when the next play spins the overlay window up.
        const overlay = hasOverlayRow ? items[2] : null
        if (overlay) {
          overlay.addEventListener('click', function () {
            overlayControls = !overlayControls
            if (api && api.videoConfigSet) {
              api.videoConfigSet({ overlayControls: overlayControls }).catch(function () {})
            }
            overlay.classList.toggle('on', overlayControls)
            const tick = overlay.querySelector('.vt-menu-tick')
            if (tick) tick.innerHTML = overlayControls ? ICON.tick : ''
          })
        }
        const shot = items[hasOverlayRow ? 3 : 2]
        if (shot) shot.addEventListener('click', function () { takeScreenshot(); closeMenu() })
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
      if (!root || root.classList.contains('hidden')) {
        // Minimised (V1): the card answers the theatre's keys only while it
        // has focus (a click on it gives it focus; Escape gives it back).
        // Space, m and f are the music player's keys everywhere else, and a
        // key must never fire twice — the renderer's handler stands down
        // while the focus is on the card, exactly as it does for the theatre.
        if (!minimised || !state || isTypingTarget(e.target)) return
        const mini = $('vmini')
        const active = doc.activeElement
        const onCard = !!(mini && active && typeof mini.contains === 'function' && mini.contains(active))
        if (!onCard) return
        const hit = keymap.resolve(e, { isInput: false })
        if (!hit) return
        const ok = ['playPause', 'seek', 'mute', 'fullscreen', 'volume', 'next', 'exit']
        if (ok.indexOf(hit.action) === -1) return
        if (hit.action === 'exit') { if (active && typeof active.blur === 'function') active.blur() }
        else if (hit.action === 'fullscreen') restore()
        else if (hit.action === 'playPause') togglePlay()
        else if (hit.action === 'mute') send('mute', { value: !(state && state.muted) })
        else if (hit.action === 'seek') kbSeek(hit.arg)
        else if (hit.action === 'volume') { setVolume((Number(state && state.volume) || 0) + hit.arg) }
        else if (hit.action === 'next') { if (onNext) onNext() }
        e.preventDefault()
        return
      }
      if (isTypingTarget(e.target)) return
      const hit = keymap.resolve(e, { isInput: isTypingTarget(e.target) })
      if (!hit) return
      const dur = Number(state && state.duration) || 0
      switch (hit.action) {
        case 'playPause': togglePlay(); break
        // Through the accumulator, not a blind relative jump: held arrows show
        // the landing time in the seek bubble and commit one seek on release.
        case 'seek': kbSeek(hit.arg); break
        case 'seekTo': if (dur) seekTo(dur * hit.arg); break
        case 'volume':
          setVolume((Number(state && state.volume) || 0) + hit.arg)
          flashVolume()
          break
        case 'mute': send('mute', { value: !(state && state.muted) }); break
        case 'speed': bumpSpeed(hit.arg); break
        case 'frameStep': send('frameStep', { frames: hit.arg }); break
        case 'fullscreen': toggleFullscreen(); break
        case 'subtitles': openTrackMenu('sub'); break
        case 'audioTrack': openTrackMenu('audio'); break
        case 'stats': toggleStatsMenu(); break
        case 'next': if (onNext) onNext(); break
        case 'prev': if (media && typeof media.onPrev === 'function') media.onPrev(); break
        case 'skip': {
          const seg = skipModel && skipModel.activeSegment(segments, Number(state && state.position) || 0)
          if (seg) doSkip(seg)
          break
        }
        case 'screenshot': takeScreenshot(); break
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
        // The app titlebar has no business on screen in fullscreen, and the
        // theatre is seated below it, so it has to be taken out of the layout
        // and the theatre moved up to fill the space it leaves.
        if (doc.body) doc.body.classList.toggle('video-fullscreen', isFullscreen)
        const btn = $('vt-full')
        if (btn) btn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Fullscreen')
        // Leaving fullscreen must put the chrome back unconditionally, or the
        // deck stays hidden in a window where nothing will ever hide it again.
        if (isFullscreen) noteActivity()
        else stopIdle()
        // The layout has changed, so the stage rectangle has too.
        scheduleBounds()
      }).catch(function () {})
    }

    // ── Idle chrome ─────────────────────────────────────────────────────────
    // In fullscreen the deck and the episode list step aside after five still
    // seconds and come back the moment anything happens.
    //
    // They are hidden with display:none rather than faded out, because the
    // stage is a reserved rectangle rather than a backdrop: the video is a
    // native window positioned onto whatever #vt-stage measures, so chrome that
    // merely turns invisible still holds its grid row and the picture still
    // stops short of the screen edge. Removing the rows is what actually gives
    // the film the whole screen -- and it is safe to remove any one of them
    // only because every row is placed explicitly (see the note on .vtheatre).
    //
    // The wake-up sources are deliberately wider than the document's own
    // events. mpv's window sits above the page and swallows the pointer, so
    // moving the mouse across the picture -- the most natural thing to do to
    // bring the controls back -- produces no DOM event whatsoever. That path
    // arrives through noteActivity() instead, relayed from the engine.
    const IDLE_MS = 5000
    let idleTimer = null
    let isIdle = false

    function _applyIdle(next) {
      if (next === isIdle) return
      isIdle = next
      const root = $('vtheatre')
      if (root) root.classList.toggle('idle', isIdle)
      // Hiding or restoring the deck changes the height of the stage, and the
      // stage is the rectangle mpv is positioned onto. Without this the chrome
      // disappears and the picture keeps the old, smaller frame.
      scheduleBounds()
    }

    function _idleEligible() {
      if (!isFullscreen) return false
      // A menu is an open question; taking the controls away mid-answer would
      // dismiss it in the user's face.
      const m = $('vt-menu')
      if (m && !m.classList.contains('hidden')) return false
      // Dragging the seek bar is continuous input even when the pointer is
      // momentarily still.
      return !dragging
    }

    function noteActivity() {
      // A person is here, so the "playing to an empty room" count starts over.
      // This is the reset half of the #20 contract: three untouched
      // auto-advances trigger the prompt, and any activity at all clears them.
      autoAdvances = 0
      _applyIdle(false)
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      if (!_idleEligible()) return
      idleTimer = setTimeout(function () {
        idleTimer = null
        if (_idleEligible()) _applyIdle(true)
      }, IDLE_MS)
    }

    function stopIdle() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      _applyIdle(false)
    }

    function bindIdle() {
      const wake = function () { noteActivity() }
      // Capture phase: a click on a deck button must still count as presence
      // even though the handler on the button stops the event going further.
      ;['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart'].forEach(function (ev) {
        doc.addEventListener(ev, wake, true)
      })
    }

    // ── Seek interaction ────────────────────────────────────────────────────
    // Keyboard seeking used to be a blind relative jump per keypress: holding
    // an arrow fired ten seeks into a torrent that could satisfy none of them,
    // with no indication of where playback would land. Held keys now accumulate
    // one target, shown live in the same bubble the pointer gets, and the seek
    // is sent once, a beat after the last press.
    let kbTarget = null
    let kbTimer = null
    // Repeated arrow presses still batch into one seek, but the first press now
    // commits after 150ms rather than 300ms — the batching window was the
    // largest input latency on keyboard seeking, and 150ms still catches a
    // normal key-repeat cadence.
    const KB_COMMIT_MS = 150

    // ── Seek-bar hover thumbnails (Player #5) ─────────────────────────────────
    // The bubble already shows the landing time on hover and keyboard seek. When
    // a preview frame is available for that position it goes above the time; when
    // it is not — no API, a direct-URL play with no thumbnailer, or a frame still
    // being generated — the bubble is exactly the time-only bubble it always was.
    //
    // Requests are throttled to ~4/s (the same rate the state stream and the
    // torrent progress emit at): a pointer sweeping the track fires a request per
    // pixel otherwise, and each is an IPC round-trip that may spawn an ffmpeg.
    // The trailing edge always fires, so the frame under where the pointer
    // stopped is the one asked for.
    // Debounced to ~200ms (roadmap #28): a pointer sweeping the track fires a
    // request per pixel otherwise, and each is an IPC round-trip that may spawn
    // an ffmpeg. The trailing edge always fires, so the frame under where the
    // pointer stopped is the one asked for.
    const THUMB_THROTTLE_MS = 200
    let thumbLastAt = 0
    let thumbTimer = null
    let thumbPendingPos = null
    // The bucket whose frame is currently painted, so an unchanged hover does not
    // rebuild the <img> src every emit and flicker the picture.
    let thumbShownKey = null
    // Per-position-bucket cache, session-scoped, capped (roadmap #28). Rebuilt
    // per file in open() so one film's frames never show under another's.
    let thumbCache = makeThumbCache(THUMB_CACHE_CAP)

    // The bubble's inner structure is built lazily the first time a thumb is
    // shown, so a bubble that only ever shows time keeps its plain-text shape and
    // the existing tests that read textContent keep working. Returns the time
    // span the caller writes into, or null when the bubble is plain text.
    function bubbleParts(bubble) {
      if (!bubble) return null
      if (bubble.__vtThumbImg) {
        return { img: bubble.__vtThumbImg, time: bubble.__vtThumbTime }
      }
      return null
    }

    // Put a frame in the bubble, or clear it back to time-only. path is a
    // filesystem path from main; it is shown via a file:// URL. A null/empty path
    // hides the image and leaves the time alone.
    function paintBubbleThumb(bubble, pathOrNull) {
      if (!bubble) return
      // Build the img+time scaffold once. Until a frame ever arrives the bubble
      // stays a plain text node, which is what the time-only path and the
      // pre-existing tests expect.
      if (!bubble.__vtThumbImg && pathOrNull) {
        const time = bubble.textContent
        bubble.textContent = ''
        const img = doc.createElement ? doc.createElement('img') : null
        const span = doc.createElement ? doc.createElement('span') : null
        if (!img || !span) return
        img.className = 'vt-seek-thumb'
        img.alt = ''
        span.className = 'vt-seek-bubble-time'
        span.textContent = time
        bubble.classList && bubble.classList.add('has-thumb')
        if (bubble.appendChild) { bubble.appendChild(img); bubble.appendChild(span) }
        bubble.__vtThumbImg = img
        bubble.__vtThumbTime = span
      }
      const parts = bubbleParts(bubble)
      if (!parts) return
      if (pathOrNull) {
        // file:// so Chromium loads it off disk; the path is main's, not user
        // input, but encode it so a space or bracket in the cache path is valid.
        const url = 'file://' + String(pathOrNull).split('/').map(encodeURIComponent).join('/')
        if (parts.img.getAttribute('src') !== url) parts.img.setAttribute('src', url)
        parts.img.hidden = false
        bubble.classList && bubble.classList.add('has-thumb')
      } else {
        parts.img.hidden = true
        bubble.classList && bubble.classList.remove('has-thumb')
      }
    }

    // Write the time into the bubble whether or not it has grown a thumb slot.
    function setBubbleTime(bubble, text) {
      if (!bubble) return
      const parts = bubbleParts(bubble)
      if (parts) parts.time.textContent = text
      else bubble.textContent = text
    }

    // The thumbnail backend, feature-detected. The prompt's Wave-4 contract is
    // videoThumbAt({sec}) → {path|null}; the pre-existing handler is
    // videoThumb({position}) → {ok,path}. Prefer the new name, fall back to the
    // old, and return null when neither is exposed (an older preload, a
    // direct-URL play with no thumbnailer, a test harness that stubs neither) —
    // in which case the bubble stays the time-only bubble it always was.
    function thumbBackend() {
      if (api && typeof api.videoThumbAt === 'function') {
        return function (sec) {
          return api.videoThumbAt({ sec: sec }).then(function (res) {
            // {path|null}; tolerate an {ok,path} shape too so either backend fits.
            if (!res) return null
            return res.path != null ? res.path : (res.ok ? (res.path || null) : null)
          })
        }
      }
      if (api && typeof api.videoThumb === 'function') {
        return function (sec) {
          return api.videoThumb({ position: sec }).then(function (res) {
            return res && res.ok ? (res.path || null) : null
          })
        }
      }
      return null
    }

    // Ask for the frame at a position, debounced and bucket-cached. Guarded on a
    // backend being present at all, so the deck runs unchanged where neither
    // thumbnail API is exposed. Never blocks the hover time text: the time is
    // painted by the caller before this is even called.
    function requestThumb(bubble, positionSec) {
      if (!bubble) return
      const fetchThumb = thumbBackend()
      if (!fetchThumb) return
      thumbPendingPos = positionSec
      // A bucket already in the cache is painted straight away — no IPC, no
      // ffmpeg — including a cached null (asked, none yet), which correctly
      // leaves the previous frame alone. Only a genuinely unseen bucket falls
      // through to a network request.
      if (thumbCache.has(positionSec)) {
        const cached = thumbCache.get(positionSec)
        if (cached && cached !== thumbShownKey) { thumbShownKey = cached; paintBubbleThumb(bubble, cached) }
        return
      }
      const fire = function () {
        thumbLastAt = (typeof Date !== 'undefined' ? Date.now() : 0)
        const pos = thumbPendingPos
        fetchThumb(pos).then(function (p) {
          // Cache the answer for the bucket even when null, so a still-generating
          // frame is not re-requested on every pass through the same ten seconds.
          thumbCache.set(pos, p || null)
          // The bubble was hidden (pointer left) while this was in flight: drop
          // the answer rather than painting into a bubble nobody is looking at.
          if (thumbPendingPos == null) return
          // A null answer leaves whatever frame is already up in place — the
          // previous bucket's frame is a better preview than none while the new
          // one generates. A path repaints only when it names a new frame.
          if (p && p !== thumbShownKey) { thumbShownKey = p; paintBubbleThumb(bubble, p) }
        }).catch(function () { /* a hover must never surface an error */ })
      }
      const nowMs = (typeof Date !== 'undefined' ? Date.now() : 0)
      const since = nowMs - thumbLastAt
      if (since >= THUMB_THROTTLE_MS) { fire(); return }
      if (thumbTimer) return
      thumbTimer = setTimeout(function () { thumbTimer = null; fire() }, THUMB_THROTTLE_MS - since)
    }

    // Reset the thumb state when the bubble is hidden, so the next hover starts
    // clean rather than flashing the last frame from the previous hover.
    function clearThumbState(bubble) {
      thumbPendingPos = null
      thumbShownKey = null
      if (thumbTimer) { clearTimeout(thumbTimer); thumbTimer = null }
      if (bubble) paintBubbleThumb(bubble, null)
    }

    function kbSeek(delta) {
      const dur = Number(state && state.duration) || 0
      // No duration means no bar to aim on; the blind jump is all there is.
      if (!dur) { seekBy(delta); return }
      const from = kbTarget != null ? kbTarget : (Number(state && state.position) || 0)
      kbTarget = Math.max(0, Math.min(dur, from + delta))
      const bubble = $('vt-seek-bubble')
      if (bubble) {
        bubble.hidden = false
        setBubbleTime(bubble, fmtTime(kbTarget))
        bubble.style.left = ((kbTarget / dur) * 100) + '%'
        // Keyboard seek gets the same preview the pointer does.
        requestThumb(bubble, kbTarget)
      }
      paintSeek(kbTarget, dur)
      clearTimeout(kbTimer)
      kbTimer = setTimeout(function () {
        kbTimer = null
        const target = kbTarget
        kbTarget = null
        if (bubble) { bubble.hidden = true; clearThumbState(bubble) }
        if (target != null) seekTo(target)
      }, KB_COMMIT_MS)
    }

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
        const at = dur * f
        bubble.hidden = false
        setBubbleTime(bubble, fmtTime(at))
        bubble.style.left = (f * 100) + '%'
        // A preview frame for where the pointer is, throttled inside requestThumb.
        requestThumb(bubble, at)
        if (dragging) {
          // The fill moves instantly (local paint); the picture follows via a
          // throttled keyframe seek so the drag feels live instead of frozen
          // until release.
          paintSeek(at, dur)
          scrubSeek(at)
        }
      })
      seek.addEventListener('pointerleave', function () {
        if (bubble) { bubble.hidden = true; clearThumbState(bubble) }
      })

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
        // Cancel any pending keyframe scrub, then land exactly where released.
        scrubEnd()
        const dur = Number(state && state.duration) || 0
        if (dur) seekTo(dur * seekFraction(e.clientX))
      })
      seek.addEventListener('pointercancel', function () { dragging = false; scrubEnd() })

      // A slider must be operable from the keyboard, not only the pointer.
      seek.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { kbSeek(-10); e.preventDefault(); e.stopPropagation() }
        if (e.key === 'ArrowRight') { kbSeek(10); e.preventDefault(); e.stopPropagation() }
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
      // The same real stop the mini player has, now in the deck too: it was
      // only reachable after minimising, so finishing a film meant leaving the
      // theatre first just to stop it.
      $('vt-stop')?.addEventListener('click', close)
      $('vmini-open')?.addEventListener('click', restore)
      $('vmini-stop')?.addEventListener('click', close)
      $('vmini-play')?.addEventListener('click', togglePlay)
      $('vmini-next')?.addEventListener('click', function () { if (onNext) onNext() })
      $('vmini-mute')?.addEventListener('click', function () { send('mute', { value: !(state && state.muted) }) })
      $('vmini-size')?.addEventListener('click', toggleMiniSize)
      // Clicking the mini time flips it to remaining and back, same as the deck.
      $('vmini-time')?.addEventListener('click', toggleTimeMode)
      // Double-clicking the picture restores the theatre. The click lands on the
      // native mpv window (see the fullscreen relay below), but a double-click on
      // the reserved region itself — when the picture is not covering it — is
      // handled here as a reliable page-side path too.
      $('vmini-video')?.addEventListener('dblclick', restore)
      // The hover chrome over the picture (only visible with the picture in
      // the page; under mpv the native window covers it).
      $('vmini-ov-play')?.addEventListener('click', togglePlay)
      $('vmini-ov-open')?.addEventListener('click', restore)
      $('vmini-ov-close')?.addEventListener('click', close)
      bindMiniDrag()
      bindMiniResize()
      bindMiniSeek()
      $('vt-next')?.addEventListener('click', function () { if (onNext) onNext() })
      $('vt-prev')?.addEventListener('click', function () {
        if (media && typeof media.onPrev === 'function') media.onPrev()
      })
      $('vt-mute')?.addEventListener('click', function () { send('mute', { value: !(state && state.muted) }) })
      $('vt-vol')?.addEventListener('input', function (e) { setVolume(Number(e.target.value)) })
      // Clicking the duration flips it to time-remaining and back — the glance
      // that answers "how much is left tonight" without doing the arithmetic.
      $('vt-dur')?.addEventListener('click', toggleTimeMode)
      $('vt-subs')?.addEventListener('click', function () { openTrackMenu('sub') })
      $('vt-audio')?.addEventListener('click', function () { openTrackMenu('audio') })
      $('vt-chapters')?.addEventListener('click', openChapterMenu)
      $('vt-speed')?.addEventListener('click', openSpeedMenu)
      $('vt-stats')?.addEventListener('click', toggleStatsMenu)
      $('vt-shot')?.addEventListener('click', takeScreenshot)
      $('vt-settings')?.addEventListener('click', openSettingsMenu)
      $('vt-full')?.addEventListener('click', toggleFullscreen)
      // The wheel works anywhere over the deck, not only on the 88px slider:
      // volume is the thing people reach for mid-scene, and the pointer is
      // rarely parked on the one control that takes it.
      $('vt-deck')?.addEventListener('wheel', function (e) {
        if (typeof e.preventDefault === 'function') e.preventDefault()
        const dir = wheelDirection(e)
        if (!dir) return
        setVolume((Number(state && state.volume) || 0) + dir * 5)
        flashVolume()
        render()
      })
      // The picture itself (V4): with the smooth player the <video> lives in
      // the page and takes the pointer, so the stage handles what mpv's own
      // window used to — click to play/pause (with a burst), double-click for
      // fullscreen (the second click undoes the first's toggle, as YouTube's
      // does), wheel for volume, Shift+wheel to seek. Under mpv the native
      // window swallows these and relays them itself; nothing fires here.
      const stageEl = $('vt-stage')
      if (stageEl) {
        const onPicture = function (e) {
          const t = e.target
          if (!t || typeof t.closest !== 'function') return true
          return !t.closest('button, .vt-upnext, .vt-pack, .vt-skip, .vt-menu, .vt-stage-msg, .vt-strip')
        }
        stageEl.addEventListener('click', function (e) {
          if (!onPicture(e) || !state) return
          togglePlay()
          burst(state.paused ? ICON.play : ICON.pause)
          noteActivity()
        })
        stageEl.addEventListener('dblclick', function (e) {
          if (!onPicture(e)) return
          if (typeof e.preventDefault === 'function') e.preventDefault()
          toggleFullscreen()
        })
        stageEl.addEventListener('wheel', function (e) {
          if (!onPicture(e) || !state) return
          if (typeof e.preventDefault === 'function') e.preventDefault()
          const dir = wheelDirection(e)
          if (!dir) return
          if (e.shiftKey) { seekBy(dir * 10); osd((dir > 0 ? '+' : '−') + '10 s', 600); return }
          setVolume((Number(state && state.volume) || 0) + dir * 5)
          flashVolume()
          render()
        }, { passive: false })
      }
      // Hovering the Up Next card holds its countdown; leaving resumes it.
      // Bound on the box, which survives every innerHTML repaint of the card.
      $('vt-upnext')?.addEventListener('pointerenter', function () { upNextHover = true })
      $('vt-upnext')?.addEventListener('pointerleave', function () { upNextHover = false })
      bindSeek()
      bindIdle()
      doc.addEventListener('keydown', onKey)
      // A click anywhere outside an open menu closes it.
      doc.addEventListener('pointerdown', function (e) {
        const m = $('vt-menu')
        if (m && !m.classList.contains('hidden') && !m.contains(e.target) && !e.target.closest('.vt-chip, .vt-icon')) closeMenu()
      })
      if (typeof window !== 'undefined') window.addEventListener('resize', scheduleBounds)
      // While minimised, a window resize or move must re-anchor the card to its
      // corner (and re-send the rect) so it never drifts off screen or over the
      // music bar. Skipped mid-drag so a resize event does not fight the pointer.
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', function () {
          if (minimised && !miniDragging) placeMiniCard(null, true)
        })
      }
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
      // Previous mirrors it: the renderer passes media.onPrev only when there
      // is an episode before this one, so absence means hide, not disable.
      const prev = $('vt-prev'); if (prev) prev.hidden = typeof media.onPrev !== 'function'
      segments = []
      prefs = media.prefs || {}
      // A new file means a fresh chance to apply the remembered language, and
      // no pick has been made in it yet.
      langApplied = false
      langChosen = { sub: false, audio: false }
      lastSkipShown = null
      upNextDismissed = false
      upNextHover = false
      // The still-watching prompt belongs to whatever card was on screen; a
      // new file starts without it. The autoAdvances count is deliberately NOT
      // reset here — an auto-advance re-opens the player through this very path,
      // and zeroing it would mean the "playing to an empty room" streak could
      // never reach three. Only real activity (noteActivity) or a deliberate
      // Play now clears it.
      stillAsking = false
      // A new file has its own chapters and its own seek target.
      lastChapterSig = ''
      const ticks = $('vt-seek-chapters'); if (ticks) ticks.innerHTML = ''
      kbTarget = null
      clearTimeout(kbTimer)
      // A new file's frames are its own: drop the previous film's cached buckets
      // so a hover never shows a frame from what was playing before (roadmap #28).
      thumbCache.clear()
      thumbShownKey = null
      cancelAutoSkip()
      stopUpNext()
      clearPack()
      const upBox = $('vt-upnext')
      if (upBox) { upBox.hidden = true; upBox.innerHTML = '' }
      syncStrip()
      delayMs = { subDelay: 0, audioDelay: 0 }
      // Subtitle style is a viewer preference, not a property of the release, so
      // it deliberately survives across files (roadmap #30) — it is re-applied
      // to the new file by applyLangPrefs once its tracks turn up, not reset here.
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
      // Measured before the theatre goes, for the picture's flight (V1).
      const stageRect = flightStageRect()
      if (root) root.classList.add('hidden')
      const mini = $('vmini')
      if (mini) { mini.classList.remove('hidden'); mini.classList.remove('vmini-landed') }
      minimised = true
      // PiP (roadmap #27): when leaving the theatre with video still playing,
      // shrink mpv into a corner so the picture rides along while browsing,
      // instead of just blanking it. The .vmini bar below drives it. Feature-
      // detected; if the corner mode is unavailable we fall back to the old
      // hide-the-surface behavior so audio still keeps playing.
      const playing = state && !state.paused
      let miniModeOn = false
      if (playing && api && api.videoMiniMode) {
        miniModeOn = true
        pipActive = true
        // Place the card at its persisted corner and hand main the matching
        // video rectangle in one call, so the picture lands inside the card's
        // reserved region rather than at a default corner of its own.
        placeMiniCard(null, true)
        // With the picture in the page it flies from the stage into the card
        // (V1) instead of appearing there; the handle and bar fade in after.
        flyCard(stageRect, false)
      } else {
        // The video surface is a native child window: hiding the HTML behind it
        // does not hide it, and it would sit over the app while the user tried
        // to browse. Audio keeps playing. The card still shows its controls, so
        // position it even though there is no picture to place.
        pipActive = false
        placeMiniCard(null, false)
        setSurfaceVisible(false)
      }
      // pipActive was set inside each branch above (before placeMiniCard, which
      // reads it to decide whether to send the rect); miniModeOn just mirrors it.
      void miniModeOn
      // The state subscription stays open: the mini player shows the same
      // position and play state, and returning must not have to rebuild it.
      render()
    }

    function restore() {
      stopSettle()
      const mini = $('vmini')
      const root = $('vtheatre')
      if (root) root.classList.remove('hidden')
      minimised = false
      render()
      // Bring mpv back from the corner (roadmap #27) if it went there; otherwise
      // just re-show the surface. Either way the stage needs its size back first,
      // so wait two frames before placing the surface on it.
      const wasPip = pipActive
      pipActive = false
      // Only a real flight keeps the card on screen past this point; under
      // mpv (or with less motion asked for) it goes now, as it always did.
      const willFly = wasPip && canFly()
      if (!willFly && mini) mini.classList.add('hidden')
      const land = function () {
        if (mini) mini.classList.add('hidden')
        if (wasPip && api && api.videoMiniMode) api.videoMiniMode({ on: false }).catch(function () {})
        setSurfaceVisible(true)
      }
      ready().then(function () {
        // With the picture in the page, the card flies back onto the stage
        // first (V1) and the picture is re-seated on landing; the theatre is
        // already laid out beneath so the stage rect is real.
        const flight = wasPip ? flyCard(flightStageRect(), true) : null
        if (flight) flight.then(land, land)
        else land()
      })
    }

    // The stage's page rectangle for the flight, or null when it cannot be
    // measured (hidden, no layout, a test document).
    function flightStageRect() {
      const stage = $('vt-stage')
      if (!stage || typeof stage.getBoundingClientRect !== 'function') return null
      const r = stage.getBoundingClientRect()
      if (!r || r.width < 2 || r.height < 2) return null
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }

    // Fly the card between the stage and its corner (V1). Forward: it starts
    // scaled over the stage and shrinks into the corner. Reverse: it grows
    // from the corner to cover the stage. Resolves when the flight lands;
    // returns null (nothing to await) when the flight cannot or should not
    // run — no stage rect, the picture is in a native window, less motion
    // asked for, or no Web Animations.
    function canFly() {
      const mini = $('vmini')
      return !!(mini && motion && pictureInPage() && !lessMotion() && typeof mini.animate === 'function')
    }
    function flyCard(stageRect, reverse) {
      const mini = $('vmini')
      if (!stageRect || !canFly()) return null
      if (miniFlight) { try { miniFlight.cancel() } catch (_) {} miniFlight = null }
      // What flies is a SNAPSHOT of the picture in a lightweight ghost, not the
      // card: scaling a layer with a live <video> inside stalls the compositor
      // for ~100 ms on the first frame (measured), while a bitmap flies at
      // full frame rate. The real card is hidden for the flight, the video
      // playing on inside it, and is revealed on landing.
      const dims = miniVideoDims(miniPos.size)
      const anchor = miniAnchor(miniPos.corner, miniPos.size)
      const ghost = makeGhost(dims)
      if (!ghost) return null
      const kf = motion.flipKeyframes(stageRect, { x: anchor.x, y: anchor.y + MINI.handleH }, dims, 0)
      // Transform only: animating the corner radius alongside the shadow
      // pushed the flight onto the main thread at ~60 ms a frame (measured).
      const frames = [
        { transform: motion.transformOf(kf.start) },
        { transform: motion.transformOf(kf.end) },
      ]
      if (reverse) frames.reverse()
      const dur = reverse ? 300 : 380
      mini.classList.add('vmini-flying')
      doc.body.appendChild(ghost)
      const anim = ghost.animate(frames, { duration: dur, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' })
      miniFlight = anim
      return new Promise(function (resolve) {
        const end = function () {
          if (miniFlight === anim) miniFlight = null
          mini.classList.remove('vmini-flying')
          if (!reverse) mini.classList.add('vmini-landed')
          try { ghost.remove() } catch (_) {}
          resolve()
        }
        anim.onfinish = end
        anim.oncancel = end
      })
    }

    // The ghost: a fixed box the size of the card's video region holding one
    // frame of the picture, letterboxed the way the picture is. Null when a
    // frame cannot be taken (no picture yet, a test document).
    function makeGhost(dims) {
      const video = doc.querySelector && doc.querySelector('.vt-web-video')
      if (!video || !doc.createElement || typeof doc.body === 'undefined') return null
      const box = doc.createElement('div')
      box.className = 'vmini-ghost'
      box.style.width = dims.w + 'px'
      box.style.height = dims.h + 'px'
      const c = doc.createElement('canvas')
      c.width = dims.w; c.height = dims.h
      try {
        const ctx = c.getContext('2d')
        const vw = video.videoWidth || dims.w, vh = video.videoHeight || dims.h
        const s = Math.min(dims.w / vw, dims.h / vh)
        const w = Math.round(vw * s), h = Math.round(vh * s)
        ctx.drawImage(video, Math.round((dims.w - w) / 2), Math.round((dims.h - h) / 2), w, h)
      } catch (_) { /* a blank ghost still flies */ }
      box.appendChild(c)
      return box
    }

    function setSurfaceVisible(on) {
      if (api && api.videoSurfaceVisible) api.videoSurfaceVisible(!!on).catch(function () {})
    }

    // Stopping for real: tears everything down and tells the caller.
    //
    // onExit fires while the state is still readable: the renderer's exit
    // handler persists the final watch position by reading _state(), so
    // nulling first silently threw the position away on every Stop. The guard
    // keeps an exit handler that finds its way back into close() from running
    // the teardown twice, and the finally nulls exactly once even if the
    // handler throws.
    let closing = false
    function close() {
      if (closing) return
      closing = true
      stopSettle()
      if (miniFlight) { try { miniFlight.cancel() } catch (_) {} miniFlight = null }
      cancelAutoSkip()
      stopUpNext()
      stopIdle()
      closeMenu()
      // The held rows belong to this playback; the next one starts flat.
      releaseHeld()
      if (isFullscreen) toggleFullscreen(false)
      const root = $('vtheatre')
      if (root) root.classList.add('hidden')
      const mini = $('vmini')
      if (mini) mini.classList.add('hidden')
      minimised = false
      // If we were in corner PiP (roadmap #27), leave it before tearing down so
      // mpv is not left shrunk into a corner for the next playback.
      if (pipActive && api && api.videoMiniMode) api.videoMiniMode({ on: false }).catch(function () {})
      pipActive = false
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      // Only on a real stop: minimising keeps playing, so the music bar stays
      // out of the way until the video is actually finished with.
      setVideoActive(false)
      setSurfaceVisible(false)
      try { onExit() } finally {
        state = null
        segments = []
        closing = false
      }
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
      // Relayed from mpv when the picture is single-clicked, same reason.
      togglePlay: togglePlay,
      // Relayed from mpv: the pointer moved over the picture, which the page
      // itself cannot see because the video window takes the event.
      noteActivity: noteActivity,
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

  return { create: create, fmtTime: fmtTime, SPEEDS: SPEEDS, ICON: ICON,
    thumbBucketOf: thumbBucketOf, makeThumbCache: makeThumbCache,
    THUMB_BUCKET_SEC: THUMB_BUCKET_SEC, THUMB_CACHE_CAP: THUMB_CACHE_CAP,
    // Mini-player geometry, exported for tests and the renderer's own use.
    MINI: MINI, miniVideoDims: miniVideoDims, miniCardSize: miniCardSize,
    miniCardTopLeft: miniCardTopLeft, miniVideoRect: miniVideoRect,
    nearestCorner: nearestCorner, pageRectToScreen: pageRectToScreen,
    sanitizeMiniPos: sanitizeMiniPos, seekFractionAt: seekFractionAt }
})
