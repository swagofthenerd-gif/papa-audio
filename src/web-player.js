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
// Seeking: inside the buffered range it is a currentTime change; outside it
// the stream restarts at the target second (`?t=`) and `offset` carries the
// start, so `position = offset + video.currentTime` stays true.
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
    var session = null      // { id, streamUrl, duration, subtitles[], audios[], plan }
    var video = null
    var offset = 0
    var tickTimer = null
    var mounted = null      // 'stage' | 'mini' | null
    var state = _empty()
    var tracks = { sub: null, audio: null }
    var speed = 1
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

    function _snapshot() {
      if (!video || !session) return _empty()
      var pos = offset + (video.currentTime || 0)
      var bufEnd = 0
      try { if (video.buffered && video.buffered.length) bufEnd = offset + video.buffered.end(video.buffered.length - 1) } catch (_) {}
      var layout = session.plan && session.plan.audio ? (session.plan.audio.channels >= 6 ? 'surround' : session.plan.audio.channels === 2 ? 'stereo' : 'unknown') : 'unknown'
      return {
        position: pos, duration: session.duration || video.duration || 0, paused: !!video.paused, volume: Math.round((video.volume || 0) * 100), muted: !!video.muted,
        speed: speed, buffered: Math.max(0, bufEnd - pos), seekable: [[0, session.duration || 0]], eof: !!video.ended,
        video: { width: video.videoWidth || (session.plan && session.plan.video && session.plan.video.width) || null, height: video.videoHeight || null, codec: session.plan && session.plan.video ? (session.plan.video.copy ? session.plan.video.codec : 'h264') : null },
        audio: { layout: layout, channels: session.plan && session.plan.audio ? session.plan.audio.channels : 0, codec: session.plan && session.plan.audio ? (session.plan.audio.copy ? session.plan.audio.codec : 'opus') : null },
        tracks: { sub: tracks.sub, audio: tracks.audio }, chapters: [],
        web: true, badges: session.plan ? session.plan.badges : [],
      }
    }

    function _ensureVideo() {
      if (video || !doc) return video
      video = doc.createElement('video')
      video.id = 'vt-web-video'
      video.className = 'vt-web-video'
      video.playsInline = true
      video.preload = 'auto'
      video.setAttribute('aria-hidden', 'true')
      video.addEventListener('playing', function () { onEvent({ kind: 'playing', web: true }); _emit() })
      video.addEventListener('pause', _emit)
      video.addEventListener('play', _emit)
      video.addEventListener('ended', function () { onEvent({ kind: 'ended', web: true }); _emit() })
      video.addEventListener('waiting', function () { onEvent({ kind: 'buffering', web: true }) })
      video.addEventListener('error', function () {
        var e = video.error
        onEvent({ kind: 'error', web: true, message: 'The smooth player could not play this stream' + (e && e.message ? ' (' + e.message + ')' : '') })
      })
      video.addEventListener('dblclick', function () { onEvent({ kind: 'restore', web: true }) })
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
      if (tracks.audio != null) u += '&a=' + encodeURIComponent(tracks.audio)
      if (extra && extra.burn != null) u += '&burn=' + encodeURIComponent(extra.burn)
      return u
    }

    // Start (or restart at `t`) the stream.
    function _load(t, autoplay) {
      var v = _ensureVideo()
      if (!v || !session) return
      offset = Math.max(0, t || 0)
      v.src = _src(offset)
      v.load()
      _syncSubtitles()
      if (autoplay !== false) { var p = v.play(); if (p && p.catch) p.catch(function () {}) }
      _emit()
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
      tracks = { sub: null, audio: sess.plan && sess.plan.audio ? sess.plan.audio.index : null }
      speed = 1
      mount('stage')
      _load(startAt || 0, true)
      clearInterval(tickTimer)
      tickTimer = setInterval(function () { if (session) _emit() }, TICK_MS)
      // In Node (tests) a live interval keeps the process up; the browser
      // returns a number and ignores this.
      if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref()
    }

    function close() {
      clearInterval(tickTimer); tickTimer = null
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
        case 'pause': if (args.paused === false) { var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}) } else v.pause(); break
        case 'seek': {
          var target = args.mode === 'relative' ? offset + v.currentTime + (Number(args.seconds) || 0) : (Number(args.seconds) || 0)
          seekTo(target); break
        }
        case 'volume': { var vol = Number(args.value != null ? args.value : args.volume); if (isFinite(vol)) v.volume = Math.max(0, Math.min(1, vol / 100)); break }
        case 'mute': v.muted = !!(args.value != null ? args.value : args.muted); break
        case 'speed': { var sp = Number(args.value != null ? args.value : args.speed); if (isFinite(sp) && sp > 0) { speed = sp; v.playbackRate = sp } break }
        case 'track':
          if (args.type === 'sub') { tracks.sub = args.id == null || args.id === 'no' ? null : args.id; _applySubTrack() }
          else if (args.type === 'audio') { if (tracks.audio !== args.id) { tracks.audio = args.id; _load(offset + v.currentTime, !v.paused) } }
          break
        case 'frameStep': v.pause(); v.currentTime = Math.max(0, v.currentTime + (Number(args.frames != null ? args.frames : args.dir) || 1) / 24); break
        case 'stop': close(); break
        default: return Promise.resolve({ ok: false, unsupported: verb })
      }
      _emit()
      return Promise.resolve({ ok: true })
    }

    // Inside the buffer: instant. Outside: restart the converter there.
    function seekTo(target) {
      var v = video
      if (!v || !session) return
      var t = Math.max(0, Math.min(Number(target) || 0, session.duration || Infinity))
      var local = t - offset
      var inBuffer = false
      try {
        for (var i = 0; i < v.buffered.length; i++) { if (local >= v.buffered.start(i) - 0.5 && local <= v.buffered.end(i)) { inBuffer = true; break } }
      } catch (_) {}
      if (inBuffer && local >= 0) v.currentTime = local
      else _load(t, !v.paused)
    }

    // The tracks list in the shape the controller expects from videoTracks():
    // { id, type, lang, title, selected }.
    function trackList() {
      if (!session) return []
      var out = []
      ;(session.audios || []).forEach(function (a) { out.push({ id: a.index, type: 'audio', lang: a.lang || '', title: (a.title || (a.channels >= 6 ? a.channels === 8 ? '7.1' : '5.1' : a.channels === 2 ? 'Stereo' : '') ) + (a.codec ? ' · ' + a.codec.toUpperCase() : ''), selected: tracks.audio === a.index }) })
      ;(session.subtitles || []).forEach(function (s) { out.push({ id: s.index, type: 'sub', lang: s.lang || '', title: s.title || s.lang || 'Subtitles', selected: tracks.sub === s.index }) })
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
      proxy.videoChapters = function () { return active() ? Promise.resolve({ ok: true, chapters: [] }) : real.videoChapters() }
      proxy.videoSurfaceBounds = function (rect) { return active() ? Promise.resolve({ ok: true }) : real.videoSurfaceBounds(rect) }
      proxy.videoSurfaceVisible = function (on) { return active() ? Promise.resolve({ ok: true }) : real.videoSurfaceVisible(on) }
      proxy.videoMiniMode = function (p) {
        if (!active()) return real.videoMiniMode(p)
        mount(p && p.on ? 'mini' : 'stage')
        return Promise.resolve({ ok: true })
      }
      proxy.videoOsd = function (text, ms) { return active() ? Promise.resolve({ ok: true }) : real.videoOsd(text, ms) }
      proxy.videoThumbAt = function (p) { return active() ? Promise.resolve(null) : real.videoThumbAt(p) }
      proxy.videoThumb = function (p) { return active() ? Promise.resolve(null) : real.videoThumb(p) }
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

    return { create: create, open: open, close: close, active: active, control: control, seekTo: seekTo, mount: mount, trackList: trackList, wrapApi: wrapApi, state: _snapshot, _video: function () { return video }, _session: function () { return session } }
  }

  var api = { create: create, TICK_MS: TICK_MS }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.PapaWebPlayer = api
})()
