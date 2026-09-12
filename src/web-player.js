'use strict'
// The smooth player's in-page engine (video plan V1). A <video> element that
// the page owns — composited, draggable by the picture, animatable — fed by
// the main-process stream server (web-stream.js). It speaks the SAME
// language the theatre controller (video-player.js) already speaks to mpv:
// the state stream, the control verbs, the tracks and chapters calls. The
// controller is handed a proxy of window.api that routes each call to this
// engine while a web session is active and to mpv otherwise, so the theatre,
// the mini card, the Up Next card and every menu work unchanged.
//
// Playback goes through Media Source Extensions: the page fetches the
// server's fragmented MP4 and appends it to a SourceBuffer, which keeps what
// it has been given. The timeline is the film's own (the server says which
// second a response starts at, and that becomes the timestamp offset), so a
// seek into anything already appended is a currentTime change — instant,
// no network — and a seek elsewhere fetches `?t=` again, which the server
// answers from its disk cache when it has converted that span before.
// Browsers that refuse the MIME string fall back to a plain <video src>
// with the old restart-at-`?t=` behaviour (`offset` carries the start).
//
// Pure-ish: everything DOM is behind `document`/`api` injection for tests.
;(function () {
  var TICK_MS = 250

  function create(opts) {
    opts = opts || {}
    var doc = opts.document || (typeof document !== 'undefined' ? document : null)
    var api = opts.api || (typeof window !== 'undefined' ? window.api : null)
    var onEvent = opts.onEvent || function () {}
    var listeners = []
    var session = null      // { id, streamUrl, duration, subtitles[], audios[], plan, mime }
    var video = null
    var offset = 0          // plain-src mode only: the second the stream started at
    var mse = null          // { ms, sb, url, abort, queue, appending, offset, gen, fetching }
    var MediaSourceCtor = opts.MediaSource || (typeof MediaSource !== 'undefined' ? MediaSource : null)
    var fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null)
    var URLApi = opts.URL || (typeof URL !== 'undefined' ? URL : null)
    var AbortCtor = opts.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null)
    // The browser holds roughly 150 MB of video (Chromium's SourceBuffer
    // limit): four minutes of 1080p, forty seconds of 4K at 28 Mbit/s. So
    // the look-ahead is a ceiling that tightens itself the first time an
    // append is refused, the queue between the reader and the buffer is
    // capped in bytes, and only a little is kept behind the playhead — the
    // disk cache on the server makes any seek-back a file read anyway.
    var BACK_KEEP_SEC = 5      // when the browser is full, keep only this much behind the playhead
    var AHEAD_PAUSE_SEC = 90   // stop pulling from the server this far ahead of the playhead (ceiling)
    var AHEAD_MIN_SEC = 10     // the look-ahead never tightens below this
    var QUEUE_MAX_BYTES = 16 * 1048576   // bytes read but not yet appended
    var tickTimer = null
    var mounted = null      // 'stage' | 'mini' | null
    var state = _empty()
    var tracks = { sub: null, audio: null, burn: null }
    var speed = 1
    var coverage = []       // server-converted ranges, polled while a session is live
    // Never a black frame with no words (V4): the position is watched while
    // unpaused; frozen for STUCK_MS it reports which side is stuck.
    var STUCK_MS = 12000
    var watch = null        // { pos, movedAt, hadFrame, warned }
    var coverageTimer = null
    var subEl = null

    function _empty() {
      return { position: 0, duration: 0, paused: true, volume: 100, muted: false, speed: 1, buffered: 0, seekable: [], eof: false,
        video: { width: null, height: null, codec: null }, audio: { layout: 'unknown', channels: 0, codec: null }, tracks: { sub: null, audio: null }, chapters: [] }
    }

    function active() { return !!session }

    function _emit() {
      var s = _snapshot()
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](s) } catch (_) {} }
    }

    function _pos() { return (mse ? 0 : offset) + ((video && video.currentTime) || 0) }
    function _snapshot() {
      if (!video || !session) return _empty()
      var pos = _pos()
      var bufEnd = 0
      try {
        // The buffered range the playhead is in (MSE keeps several).
        var base = mse ? 0 : offset
        for (var i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) - 0.5 <= video.currentTime && video.currentTime <= video.buffered.end(i)) { bufEnd = base + video.buffered.end(i); break }
        }
      } catch (_) {}
      var layout = session.plan && session.plan.audio ? (session.plan.audio.channels >= 6 ? 'surround' : session.plan.audio.channels === 2 ? 'stereo' : 'unknown') : 'unknown'
      return {
        position: pos, duration: session.duration || video.duration || 0, paused: !!video.paused, volume: Math.round((video.volume || 0) * 100), muted: !!video.muted,
        speed: speed, buffered: Math.max(0, bufEnd - pos), seekable: _seekableRanges(), eof: !!video.ended,
        video: { width: video.videoWidth || (session.plan && session.plan.video && session.plan.video.width) || null, height: video.videoHeight || null, codec: session.plan && session.plan.video ? (session.plan.video.copy ? session.plan.video.codec : 'h264') : null },
        audio: { layout: layout, channels: session.plan && session.plan.audio ? session.plan.audio.channels : 0, codec: session.plan && session.plan.audio ? (session.plan.audio.copy ? session.plan.audio.codec : 'opus') : null },
        tracks: { sub: tracks.sub, audio: tracks.audio }, chapters: session.chapters || [],
        web: true, badges: session.plan ? session.plan.badges : [],
      }
    }

    // What the seek bar paints as ready: the browser's own buffer (film
    // seconds) plus what the server has converted to disk. Both are places a
    // seek lands without a converter start.
    function _seekableRanges() {
      var out = []
      try {
        var base = mse ? 0 : offset
        for (var i = 0; i < video.buffered.length; i++) out.push({ start: base + video.buffered.start(i), end: base + video.buffered.end(i) })
      } catch (_) {}
      for (var j = 0; j < coverage.length; j++) out.push({ start: coverage[j][0], end: coverage[j][1] })
      out.sort(function (a, b) { return a.start - b.start })
      var merged = []
      for (var k = 0; k < out.length; k++) {
        var last = merged[merged.length - 1]
        if (last && out[k].start <= last.end + 0.5) last.end = Math.max(last.end, out[k].end)
        else merged.push({ start: out[k].start, end: out[k].end })
      }
      return merged
    }
    function _pollCoverage() {
      if (!session || !session.coverageUrl || !fetchFn) return
      fetchFn(session.coverageUrl).then(function (r) { return r.json() }).then(function (j) {
        if (session && j && Array.isArray(j.ranges)) coverage = j.ranges
      }).catch(function () {})
    }

    function _ensureVideo() {
      if (video || !doc) return video
      video = doc.createElement('video')
      video.id = 'vt-web-video'
      video.className = 'vt-web-video'
      video.playsInline = true
      video.preload = 'auto'
      video.setAttribute('aria-hidden', 'true')
      video.addEventListener('playing', function () { if (watch) watch.hadFrame = true; onEvent({ kind: 'playing', web: true }); _emit() })
      video.addEventListener('pause', _emit)
      video.addEventListener('play', _emit)
      video.addEventListener('ended', function () { onEvent({ kind: 'ended', web: true }); _emit() })
      // 'waiting' fires on every seek inside the buffer and on sub-second
      // hiccups; the stage only hears about a wait that lasts. 'canplay'
      // says the wait is over even when the film is paused (no 'playing'
      // comes then), so the words never outlive the wait.
      var waitTimer = null
      video.addEventListener('waiting', function () {
        clearTimeout(waitTimer)
        waitTimer = setTimeout(function () { waitTimer = null; if (video && video.readyState < 3) onEvent({ kind: 'buffering', web: true }) }, 400)
      })
      video.addEventListener('canplay', function () { clearTimeout(waitTimer); waitTimer = null; onEvent({ kind: 'ready', web: true }) })
      video.addEventListener('error', function () {
        var e = video.error
        onEvent({ kind: 'error', web: true, message: 'The smooth player could not play this stream' + (e && e.message ? ' (' + e.message + ')' : '') })
      })
      video.addEventListener('loadedmetadata', _emit)
      video.addEventListener('volumechange', _emit)
      return video
    }

    // Where the picture lives: the theatre stage or the mini card's picture
    // region. Reparenting a <video> keeps it playing.
    function mount(where) {
      var v = _ensureVideo()
      if (!v || !doc) return
      var host = doc.getElementById(where === 'mini' ? 'vmini-video' : 'vt-stage')
      if (!host) return
      if (v.parentNode !== host) host.appendChild(v)
      mounted = where
      v.classList.toggle('vt-web-video-mini', where === 'mini')
    }

    function _src(t, extra) {
      var u = session.streamUrl + '?t=' + Math.max(0, Math.floor(t || 0))
      // A plain <video src> needs a stream whose clock starts at 0: ask for a
      // fresh run rather than a cached span whose fragments carry later times.
      if (!mse) u += '&fresh=1'
      if (tracks.audio != null) u += '&a=' + encodeURIComponent(tracks.audio)
      var burn = extra && extra.burn != null ? extra.burn : tracks.burn
      if (burn != null) u += '&burn=' + encodeURIComponent(burn)
      return u
    }

    // Can this session go through Media Source Extensions?
    function _mseUsable() {
      if (!MediaSourceCtor || !fetchFn || !URLApi || !session) return false
      var mime = session.mime || (session.plan && session.plan.mime)
      if (!mime) return false
      try { return !!MediaSourceCtor.isTypeSupported(mime) } catch (_) { return false }
    }

    // Start (or restart at `t`) the stream.
    function _load(t, autoplay) {
      var v = _ensureVideo()
      if (!v || !session) return
      if (_mseUsable()) { _mseStart(t, autoplay); return }
      _mseTeardown()
      offset = Math.max(0, t || 0)
      v.src = _src(offset)
      v.load()
      _syncSubtitles()
      if (autoplay !== false) { var p = v.play(); if (p && p.catch) p.catch(function () {}) }
      _emit()
    }

    // ── Media Source Extensions ─────────────────────────────────────────
    function _mseTeardown() {
      if (!mse) return
      _mseAbortFetch()
      try { if (mse.ms.readyState === 'open') mse.ms.endOfStream() } catch (_) {}
      try { if (mse.url && URLApi.revokeObjectURL) URLApi.revokeObjectURL(mse.url) } catch (_) {}
      mse = null
    }
    function _mseAbortFetch() {
      if (!mse) return
      mse.gen++
      if (mse.abort) { try { mse.abort.abort() } catch (_) {} mse.abort = null }
      mse.queue = []
      mse.queuedBytes = 0
      mse.resume = null
      mse.fetching = false
      // abort() also resets the segment parser: a fetch may have stopped
      // mid-fragment, and the next response begins with a fresh init
      // segment that must not land inside a half-parsed one.
      try { if (mse.sb && mse.ms.readyState === 'open') mse.sb.abort() } catch (_) {}
    }
    // The element has hit a media error (a bad append leaves MSE dead for
    // good): rebuild the media source at `t` and carry on.
    var REBUILD_MAX = 3        // media errors survived per session before the stream is given up
    var rebuilds = 0
    function _mseRebuild(t, playing) {
      // A stream the browser cannot decode fails on every rebuild: three in
      // a session and the engine stops (a thousand refetches of the same
      // second was the alternative, seen live on an AV1 + burned-subtitle
      // run). The deck hears one error, with the browser's own words.
      rebuilds++
      if (rebuilds > REBUILD_MAX) {
        var err = video && video.error
        try { console.warn('[web-player] giving up after ' + REBUILD_MAX + ' media errors' + (err ? ': ' + err.message : '')) } catch (_) {}
        _mseAbortFetch()
        if (mse) mse.dead = true
        onEvent({ kind: 'error', web: true, message: 'The smooth player could not play this stream' + (err && err.message ? ' (' + err.message + ')' : '') })
        return
      }
      try { console.warn('[web-player] rebuilding the media source after a media error at ' + Math.round(t) + 's') } catch (_) {}
      _mseTeardown()
      try { video.removeAttribute('src'); video.load() } catch (_) {}
      _mseStart(t, playing)
    }
    // Open the media source once per session; every later seek reuses the
    // SourceBuffer so what it holds stays.
    function _mseStart(t, autoplay) {
      var v = video
      var start = Math.max(0, t || 0)
      offset = 0
      if (!mse) {
        var ms = new MediaSourceCtor()
        mse = { ms: ms, sb: null, url: null, abort: null, queue: [], queuedBytes: 0, appending: false, offset: 0, gen: 0, fetching: false, pending: null, aheadCap: AHEAD_PAUSE_SEC, quotaHits: 0, lastRefetchAt: 0 }
        mse.url = URLApi.createObjectURL(ms)
        v.src = mse.url
        ms.addEventListener('sourceopen', function () {
          if (!mse || mse.ms !== ms) return
          // Chromium can fire sourceopen again on the same MediaSource; a
          // second SourceBuffer would throw and must not read as a refusal.
          if (mse.sb) return
          try {
            mse.sb = ms.addSourceBuffer(session.mime || session.plan.mime)
            mse.sb.mode = 'segments'
            mse.sb.addEventListener('updateend', _mseDrain)
            mse.sb.addEventListener('error', function () { onEvent({ kind: 'error', web: true, message: 'The smooth player could not append the stream' }) })
            if (session.duration) { try { ms.duration = session.duration } catch (_) {} }
          } catch (e) {
            // The browser refused this MIME after all: plain src, old behaviour.
            try { console.warn('[web-player] MSE refused ' + (session.mime || ''), e && e.message) } catch (_) {}
            _mseTeardown(); MediaSourceCtor = null; _load(start, autoplay); return
          }
          if (mse.pending) { var p = mse.pending; mse.pending = null; _mseFetch(p.t) }
        })
        _syncSubtitles()
        mse.pending = { t: start }
      } else {
        _mseFetch(start)
      }
      try { v.currentTime = start } catch (_) {}
      // play() before the first bytes can settle as paused; the first append
      // that makes the element ready plays again if that was the intent.
      mse.wantPlay = autoplay !== false
      if (autoplay !== false) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}) }
      _emit()
    }
    // Fetch the stream from second `t` and append it. The server's
    // X-Papa-Start header is the second its response starts at (a cached
    // run may start earlier than asked); that is the timestamp offset.
    function _mseFetch(t) {
      if (!mse || !mse.sb) return
      _mseAbortFetch()
      var gen = mse.gen
      var ctrl = AbortCtor ? new AbortCtor() : null
      mse.abort = ctrl
      mse.fetching = true
      var u = _src(t)
      fetchFn(u, ctrl ? { signal: ctrl.signal } : undefined).then(function (res) {
        if (!mse || mse.gen !== gen) return
        var startHdr = Number(res.headers && res.headers.get ? res.headers.get('X-Papa-Start') : NaN)
        mse.offset = isFinite(startHdr) ? startHdr : t
        // A span that begins behind the playhead (the server starts at the
        // keyframe before the asked second) overwrites the pictures the
        // decoder is standing on; Chromium then sits at readyState 2 with
        // seconds buffered ahead (seen live at 4K after a quota cut). A
        // seek to the same second after the first append re-arms it.
        mse.nudge = !video.paused && mse.offset < (video.currentTime || 0) - 0.05 && t >= (video.currentTime || 0) - 0.05
        // A new span begins: reset the parser (abort) so the offset can be
        // set — it is refused while a segment is half-parsed — and so the
        // response's own init segment starts clean.
        try { if (mse.ms.readyState === 'open') mse.sb.abort() } catch (_) {}
        try { mse.sb.timestampOffset = mse.offset } catch (e) { try { console.warn('[web-player] timestampOffset refused', e && e.message) } catch (_) {} }
        var reader = res.body.getReader()
        var got = 0
        var pump = function () {
          if (!mse || mse.gen !== gen) { try { reader.cancel() } catch (_) {} return }
          // Backpressure: far enough ahead, wait for the playhead.
          // Far enough ahead of the playhead: let the server run on to its
          // cache while the page waits (paused or not, the cap is the cap).
          if (_bufferedAheadOf(video.currentTime) >= mse.aheadCap || mse.queuedBytes > QUEUE_MAX_BYTES) {
            // Wait: the drain wakes the reader as soon as an append makes
            // room; the timer covers the playhead moving past the look-ahead.
            mse.resume = pump
            setTimeout(function () { if (mse && mse.gen === gen && mse.resume === pump) { mse.resume = null; pump() } }, 500)
            return
          }
          reader.read().then(function (r) {
            if (!mse || mse.gen !== gen) return
            if (r.done) {
              mse.fetching = false
              // A response that carried nothing is a converter that died at
              // once. Three in a row and the engine stops asking: a storm of
              // converter starts helps nobody, and the deck gets an error.
              if (got === 0) { mse.failures = (mse.failures || 0) + 1; if (mse.failures >= 3) { mse.dead = true; onEvent({ kind: 'error', web: true, message: 'The converter keeps failing on this file' }) } }
              else mse.failures = 0
              _mseDrain(); return
            }
            got += r.value ? r.value.length || 0 : 0
            mse.queue.push(r.value)
            mse.queuedBytes += (r.value && (r.value.byteLength || r.value.length)) || 0
            _mseDrain()
            pump()
          }).catch(function () { if (mse && mse.gen === gen) mse.fetching = false })
        }
        pump()
      }).catch(function () { if (mse && mse.gen === gen) mse.fetching = false })
    }
    // Seconds of buffer ahead of `cur`, walking across ranges that touch
    // (gaps under half a second): one span, not the first piece of it.
    function _bufferedAheadOf(cur) {
      try {
        var b = video.buffered
        var end = null
        for (var i = 0; i < b.length; i++) {
          if (end == null) { if (b.start(i) - 0.5 <= cur && cur <= b.end(i)) end = b.end(i) }
          else if (b.start(i) <= end + 0.5) end = Math.max(end, b.end(i))
        }
        return end == null ? 0 : end - cur
      } catch (_) {}
      return 0
    }
    // Append queued chunks one at a time. Out of room: drop what is far
    // behind the playhead and try again.
    function _mseDrain() {
      if (!mse || !mse.sb || mse.sb.updating) return
      if (!mse.queue.length) {
        // The stream ended and everything is appended: tell the element,
        // unless the server cut the run short (a size cap), in which case
        // the next fetch continues from where the data stops.
        if (!mse.fetching && mse.endPending) { mse.endPending = false }
        return
      }
      var chunk = mse.queue[0]
      if (video.error) {
        // Dead element: nothing appends any more. Start over where we are.
        var was = !video.paused, at = video.currentTime || (mse.offset || 0)
        _mseRebuild(at, was)
        return
      }
      try {
        mse.sb.appendBuffer(chunk)
        mse.queue.shift()
        mse.queuedBytes = Math.max(0, mse.queuedBytes - ((chunk && (chunk.byteLength || chunk.length)) || 0))
        if (mse.nudge) { mse.nudge = false; try { video.currentTime = video.currentTime } catch (_) {} }
        if (mse.resume && mse.queuedBytes <= QUEUE_MAX_BYTES && _bufferedAheadOf(video.currentTime) < mse.aheadCap) { var go = mse.resume; mse.resume = null; go() }
        if (mse.wantPlay && video.paused && video.readyState >= 2) { mse.wantPlay = false; var pp = video.play(); if (pp && pp.catch) pp.catch(function () {}) }
      } catch (e) {
        if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)))) {
          // The browser is full. Free what is behind the playhead first (the
          // server's disk cache makes a seek-back a file read, so little
          // needs keeping); only when nothing is behind does the look-ahead
          // tighten, to half of what the browser held when it refused. Each
          // remove() ends with updateend, which drains again; a remove is
          // only issued when it frees something, so a full buffer that
          // cannot shrink waits instead of spinning (the 4K quota storm:
          // 14,000 refused appends a second).
          mse.quotaHits++
          var cur = video.currentTime || 0
          var ahead = _bufferedAheadOf(cur)
          var first = null, last = null
          try { if (video.buffered.length) { first = video.buffered.start(0); last = video.buffered.end(video.buffered.length - 1) } } catch (_) {}
          try {
            if (first != null && first < cur - BACK_KEEP_SEC - 0.5) { mse.sb.remove(0, cur - BACK_KEEP_SEC); return }
            mse.aheadCap = Math.max(AHEAD_MIN_SEC, Math.min(mse.aheadCap, Math.floor(ahead / 2)))
            if (last != null && last > cur + mse.aheadCap + 1) {
              // Cut beyond the look-ahead and stop reading: the stream is
              // sequential, so anything more it delivered would land past
              // the cut and fill the browser again. The starvation check
              // fetches from the edge when the playhead nears it (a cache
              // hit on the server). abort() must come before remove():
              // the parser cannot be aborted while a removal runs.
              var edge = cur + mse.aheadCap
              _mseAbortFetch()
              mse.sb.remove(edge, Infinity)
              return
            }
          } catch (_) {}
          setTimeout(_mseDrain, 500)
        } else {
          // Any other refusal is not going to succeed on retry: drop this
          // fetch rather than spin, and let the starvation check refetch.
          try { console.warn('[web-player] append refused', e && e.name, e && e.message) } catch (_) {}
          _mseAbortFetch()
        }
      }
    }
    // Is second `t` already in the SourceBuffer (with a little slack)?
    function _mseHas(t) {
      try {
        for (var i = 0; i < video.buffered.length; i++) { if (t >= video.buffered.start(i) - 0.25 && t <= video.buffered.end(i) - 0.1) return true }
      } catch (_) {}
      return false
    }
    // When a run ends short of the film's end (a capped run), keep going:
    // called from the tick when the playhead nears the end of what it has
    // and nothing is being fetched.
    function _mseContinueIfStarved() {
      if (!mse || !mse.sb || mse.dead || seekTimer || !video || video.paused) return
      var cur = video.currentTime
      var ahead = _bufferedAheadOf(cur)
      var end = session.duration || video.duration || 0
      if (end && cur + ahead >= end - 0.5) return
      if (mse.fetching) {
        // A hole: the browser evicted a stretch right after the playhead
        // while the fetch ran on ahead of it, so the picture sits at the
        // edge with data further on and nothing arriving for the gap. The
        // signature is a later buffered range; the cure is a fetch at the
        // edge (a cache hit on the server, so no new converter).
        if (ahead < 5 && watch && Date.now() - watch.movedAt > 3000 && _rangeStartAfter(cur + ahead + 0.5) != null &&
            Date.now() - mse.lastRefetchAt > 5000) {
          mse.lastRefetchAt = Date.now()
          _mseFetch(cur + ahead)
        }
        return
      }
      if (ahead < 5) _mseFetch(cur + ahead)
    }
    function _rangeStartAfter(t) {
      try {
        for (var i = 0; i < video.buffered.length; i++) { if (video.buffered.start(i) > t) return video.buffered.start(i) }
      } catch (_) {}
      return null
    }

    // ── Stuck watchdog ─────────────────────────────────────────────────
    function _watchReset(now) { watch = { pos: -1, movedAt: now, hadFrame: false, warned: false } }
    // Seconds the converter has on disk ahead of `pos` (0 when it has not
    // reached this position at all).
    function _coveredAheadOf(pos) {
      var best = 0
      for (var i = 0; i < coverage.length; i++) {
        var r = coverage[i]
        if (r[0] - 0.5 <= pos && pos <= r[1]) best = Math.max(best, r[1] - pos)
      }
      return best
    }
    function _watchdog(now) {
      if (!watch || !video || !session) return
      var pos = _pos()
      if (pos !== watch.pos) {
        watch.pos = pos
        watch.movedAt = now
        if (watch.warned) { watch.warned = false; onEvent({ kind: 'unstuck', web: true }) }
        return
      }
      if (video.paused || video.ended || watch.warned) return
      var waited = now - watch.movedAt
      if (waited < STUCK_MS) return
      watch.warned = true
      onEvent({ kind: 'stuck', web: true, phase: watch.hadFrame ? 'play' : 'start', waited: waited / 1000, converted: _coveredAheadOf(pos) })
    }

    function _syncSubtitles() {
      var v = video
      if (!v || !session) return
      Array.prototype.slice.call(v.querySelectorAll('track')).forEach(function (t) { try { v.removeChild(t) } catch (_) {} })
      ;(session.subtitles || []).forEach(function (s) {
        var tr = doc.createElement('track')
        tr.kind = 'subtitles'
        tr.label = s.title || s.lang || ('Subtitle ' + s.index)
        tr.srclang = s.lang || ''
        tr.src = s.url
        tr.dataset.index = String(s.index)
        v.appendChild(tr)
      })
      _applySubTrack()
    }

    function _refreshSubTrack() {
      var v = video
      if (!v || !session) return
      var els = v.querySelectorAll('track')
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        if (!el.dataset || Number(el.dataset.index) !== Number(tracks.sub)) continue
        var base = String(el.src || '').split('?')[0]
        if (base) el.src = base + '?v=' + Date.now()
      }
      _applySubTrack()
    }

    function _applySubTrack() {
      var v = video
      if (!v || !v.textTracks) return
      for (var i = 0; i < v.textTracks.length; i++) {
        var tt = v.textTracks[i]
        var el = v.querySelectorAll('track')[i]
        var idx = el && el.dataset ? Number(el.dataset.index) : null
        tt.mode = (tracks.sub != null && idx === Number(tracks.sub)) ? 'showing' : 'disabled'
      }
    }

    function open(sess, startAt) {
      session = sess
      rebuilds = 0
      tracks = { sub: null, audio: sess.plan && sess.plan.audio ? sess.plan.audio.index : null, burn: null }
      speed = 1
      coverage = []
      clearInterval(coverageTimer)
      coverageTimer = setInterval(_pollCoverage, 2000)
      if (coverageTimer && typeof coverageTimer.unref === 'function') coverageTimer.unref()
      mount('stage')
      _watchReset(Date.now())
      _load(startAt || 0, true)
      clearInterval(tickTimer)
      var ticks = 0
      tickTimer = setInterval(function () {
        if (!session) return
        _mseContinueIfStarved()
        _watchdog(Date.now())
        // A streamed source's subtitles grow with the conversion: re-fetch
        // the showing track every 15 s so new cues appear.
        if (mse && tracks.sub != null && (++ticks % 60) === 0) _refreshSubTrack()
        _emit()
      }, TICK_MS)
      // In Node (tests) a live interval keeps the process up; the browser
      // returns a number and ignores this.
      if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref()
    }

    function close() {
      clearInterval(tickTimer); tickTimer = null
      clearInterval(coverageTimer); coverageTimer = null
      clearTimeout(seekTimer); seekTimer = null
      coverage = []
      watch = null
      _mseTeardown()
      if (video) {
        try { video.pause() } catch (_) {}
        video.removeAttribute('src')
        try { video.load() } catch (_) {}
        if (video.parentNode) video.parentNode.removeChild(video)
      }
      session = null
      mounted = null
      offset = 0
      _emit()
    }

    // The verbs the controller sends (video-control's vocabulary).
    function control(verb, args) {
      args = args || {}
      var v = video
      if (!v || !session) return Promise.resolve({ ok: false })
      switch (verb) {
        case 'play': { var p = v.play(); if (p && p.catch) p.catch(function () {}); break }
        case 'pause': if (args.paused === false) { var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}) } else { if (mse) mse.wantPlay = false; v.pause() } break
        case 'seek': {
          var target = args.mode === 'relative' ? _pos() + (Number(args.seconds) || 0) : (Number(args.seconds) || 0)
          seekTo(target, { preview: /keyframes/.test(String(args.mode || '')) }); break
        }
        case 'volume': { var vol = Number(args.value != null ? args.value : args.volume); if (isFinite(vol)) v.volume = Math.max(0, Math.min(1, vol / 100)); break }
        case 'mute': v.muted = !!(args.value != null ? args.value : args.muted); break
        case 'speed': { var sp = Number(args.value != null ? args.value : args.speed); if (isFinite(sp) && sp > 0) { speed = sp; v.playbackRate = sp } break }
        case 'track':
          if (args.type === 'sub') {
            var id = args.id == null || args.id === 'no' ? null : args.id
            var burnable = (session.burnable || []).some(function (b) { return b.index === Number(id) })
            var wasBurn = tracks.burn
            tracks.sub = id
            // A styled or image subtitle (ASS, PGS) can only be drawn into the
            // picture: a different stream, so the source starts over here.
            tracks.burn = burnable ? Number(id) : null
            if (tracks.burn !== wasBurn) { var atB = _pos(); var playingB = !v.paused; _mseTeardown(); _load(atB, playingB) }
            _applySubTrack()
          }
          else if (args.type === 'audio') {
            if (tracks.audio !== args.id) {
              tracks.audio = args.id
              // A different audio track is a different stream: what is
              // buffered no longer applies, so the source starts over.
              var at = _pos(); var playing = !v.paused
              _mseTeardown(); _load(at, playing)
            }
          }
          break
        case 'frameStep': v.pause(); v.currentTime = Math.max(0, v.currentTime + (Number(args.frames != null ? args.frames : args.dir) || 1) / 24); break
        case 'screenshot': return _screenshot()
        case 'stop': close(); break
        default: return Promise.resolve({ ok: false, unsupported: verb })
      }
      _emit()
      return Promise.resolve({ ok: true })
    }

    // Already appended: instant. Otherwise fetch from there (the server
    // answers from its cache when it has that span). Plain-src mode keeps
    // the old restart. A scrub preview (`preview`) only ever moves inside
    // what is appended: a converter start per pointer move was the lag.
    // Fetches for real seeks are coalesced (SEEK_SETTLE_MS) so a run of
    // arrow presses becomes one converter start, not ten.
    var SEEK_SETTLE_MS = 180
    var seekTimer = null
    function _mseFetchSoon(t) {
      clearTimeout(seekTimer)
      seekTimer = setTimeout(function () { seekTimer = null; if (mse && session) _mseFetch(t) }, SEEK_SETTLE_MS)
      if (seekTimer && typeof seekTimer.unref === 'function') seekTimer.unref()
    }
    function seekTo(target, opts) {
      var v = video
      if (!v || !session) return
      var t = Math.max(0, Math.min(Number(target) || 0, session.duration || Infinity))
      var preview = !!(opts && opts.preview)
      if (mse) {
        if (_mseHas(t)) { clearTimeout(seekTimer); seekTimer = null; v.currentTime = t; _emit(); return }
        if (preview) return
        _mseFetchSoon(t)
        try { v.currentTime = t } catch (_) {}
        _emit()
        return
      }
      if (preview) return
      var local = t - offset
      var inBuffer = false
      try {
        for (var i = 0; i < v.buffered.length; i++) { if (local >= v.buffered.start(i) - 0.5 && local <= v.buffered.end(i)) { inBuffer = true; break } }
      } catch (_) {}
      if (inBuffer && local >= 0) v.currentTime = local
      else _load(t, !v.paused)
    }

    // A frame of the picture as a PNG, saved by main next to mpv's own
    // screenshots. The <video> is drawn onto a canvas at its native size.
    function _screenshot() {
      var v = video
      if (!v || !doc || !api || typeof api.videoSaveFrame !== 'function') return Promise.resolve({ ok: false })
      try {
        var c = doc.createElement('canvas')
        c.width = v.videoWidth || 1920; c.height = v.videoHeight || 1080
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
        var dataUrl = c.toDataURL('image/png')
        return api.videoSaveFrame({ dataUrl: dataUrl, position: _pos() }).then(function (r) {
          return r && r.ok && r.path ? { ok: true, value: { path: r.path } } : { ok: false }
        }).catch(function () { return { ok: false } })
      } catch (_) { return Promise.resolve({ ok: false }) }
    }

    // The tracks list in the shape the controller expects from videoTracks():
    // { id, type, lang, title, selected }. Styled and image subtitles are
    // offered too; picking one burns it into the picture.
    function trackList() {
      if (!session) return []
      var out = []
      ;(session.audios || []).forEach(function (a) { out.push({ id: a.index, type: 'audio', lang: a.lang || '', title: (a.title || (a.channels >= 6 ? a.channels === 8 ? '7.1' : '5.1' : a.channels === 2 ? 'Stereo' : '') ) + (a.codec ? ' · ' + a.codec.toUpperCase() : ''), selected: tracks.audio === a.index }) })
      ;(session.subtitles || []).forEach(function (s) { out.push({ id: s.index, type: 'sub', lang: s.lang || '', title: s.title || s.lang || 'Subtitles', selected: tracks.sub === s.index }) })
      ;(session.burnable || []).forEach(function (s) { out.push({ id: s.index, type: 'sub', lang: s.lang || '', title: (s.title || s.lang || 'Subtitles') + (s.styled ? ' · styled' : ' · image') + ' (drawn in)', selected: tracks.sub === s.index, burn: true }) })
      return out
    }

    // The proxy the controller is created with. Each call goes to this
    // engine while a web session is active, otherwise to the real API.
    function wrapApi(real) {
      var eng = this
      var proxy = Object.create(null)
      for (var k in real) proxy[k] = real[k]
      proxy.videoControl = function (verb, args) { return active() ? control(verb, args) : real.videoControl(verb, args) }
      proxy.onVideoState = function (cb) {
        listeners.push(cb)
        var offNative = real.onVideoState ? real.onVideoState(function (s) { if (!active()) cb(s) }) : null
        return function () { listeners = listeners.filter(function (f) { return f !== cb }); if (offNative) offNative() }
      }
      proxy.videoTracks = function () { return active() ? Promise.resolve({ ok: true, tracks: trackList() }) : real.videoTracks() }
      proxy.videoChapters = function () { return active() ? Promise.resolve({ ok: true, chapters: (session && session.chapters) || [] }) : real.videoChapters() }
      proxy.videoSurfaceBounds = function (rect) { return active() ? Promise.resolve({ ok: true }) : real.videoSurfaceBounds(rect) }
      proxy.videoSurfaceVisible = function (on) { return active() ? Promise.resolve({ ok: true }) : real.videoSurfaceVisible(on) }
      proxy.videoMiniMode = function (p) {
        if (!active()) return real.videoMiniMode(p)
        mount(p && p.on ? 'mini' : 'stage')
        return Promise.resolve({ ok: true })
      }
      proxy.videoOsd = function (text, ms) { return active() ? Promise.resolve({ ok: true }) : real.videoOsd(text, ms) }
      // Hover thumbnails come from main's own thumbnailer on the source file,
      // which does not need mpv: the real call serves both players.
      proxy.videoThumbAt = function (p) { return real.videoThumbAt(p) }
      proxy.videoThumb = function (p) { return real.videoThumb(p) }
      proxy.videoStreamStats = function () {
        if (!active()) return real.videoStreamStats()
        var q = null
        try { q = video && video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null } catch (_) {}
        return Promise.resolve({ ok: true, web: true, dropped: q ? q.droppedVideoFrames : 0, decoded: q ? q.totalVideoFrames : 0, plan: session ? session.plan : null })
      }
      proxy.videoStop = function () { if (active()) close(); return real.videoStop() }
      // Lets the deck know whether the picture is in the page (it can fly and
      // be hovered) or in mpv's native window (it cannot).
      proxy.videoRenderPath = function () { return active() ? 'web' : 'native' }
      void eng
      return proxy
    }

    return { create: create, open: open, close: close, active: active, control: control, seekTo: seekTo, mount: mount, trackList: trackList, wrapApi: wrapApi, state: _snapshot, _video: function () { return video }, _session: function () { return session }, _mse: function () { return mse }, _pollCoverageNow: _pollCoverage, _watchdogNow: _watchdog, _starveNow: _mseContinueIfStarved }
  }

  var api = { create: create, TICK_MS: TICK_MS }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.PapaWebPlayer = api
})()
