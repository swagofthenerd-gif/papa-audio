'use strict'
// Stream-start honesty (video plan V4). Every failure between "click Play" and
// the first frame gets a specific sentence and a next action, in one place.
// The theatre, the mini card's toast and the detail page all read this; the
// raw strings come from mpv, ffmpeg, the torrent streamer, yt-dlp and the
// in-page engine. Pure; tested in test/start-honesty.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaStartHonesty = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  var SOURCE = 'Try another source from the list below.'
  var PURIST = 'Try another source below, or switch to Purist mode in Settings → Video.'
  var PICK = 'Pick another source from the list below.'

  // The table above is written for the moment between pressing Play and the
  // first frame, where a list of sources is on screen underneath. The same
  // table was being used for the catalogue too -- so a title that simply did
  // not come back from the titles service told people to "try another source
  // from the list below" on a page that has no source list anywhere on it.
  // A catalogue failure gets catalogue advice instead.
  var BROWSE = 'Try again, or go back.'
  var SOURCE_ADVICE = [SOURCE, PURIST, PICK]
  function adviceFor(next, context) {
    if (context !== 'catalog') return next
    for (var i = 0; i < SOURCE_ADVICE.length; i++) if (next === SOURCE_ADVICE[i]) return BROWSE
    return next
  }

  // The cases, most specific first. `test` is a regex on the raw message;
  // `text` the sentence; `next` what to do; `kind` a stable tag for callers.
  // Install commands come from install-hints so they match the OS (roadmap
  // 008); `next` may be a function of the platform for exactly that reason.
  var hints = (typeof PapaInstallHints !== 'undefined' && PapaInstallHints) ||
    (typeof require === 'function' ? (function () { try { return require('./install-hints') } catch (_) { return null } })() : null)
  function installNext(tool, platform) {
    return hints ? hints.next(tool, platform) : 'Install ' + tool + ' and try again.'
  }
  var CASES = [
    { kind: 'mpv-missing', test: /mpv socket not ready|spawn mpv/i,
      text: 'The mpv player could not start. It may not be installed.',
      next: function (platform) { return installNext('mpv', platform) } },
    { kind: 'ffmpeg-missing', test: /spawn ffprobe ENOENT|spawn ffmpeg ENOENT|ffprobe.*ENOENT|ffmpeg.*ENOENT/i,
      text: 'ffmpeg is not installed, so the smooth player cannot read this file.',
      next: function (platform) { return installNext('ffmpeg', platform) + ' — or switch to Purist mode in Settings → Video.' } },
    { kind: 'tmdb-key', test: /401|api key/i,
      text: 'TMDB API key missing or invalid.', next: 'Set it in Settings → Video.' },
    { kind: 'extractor', test: /yt-dlp|Could not load this trailer|unable to extract|Sign in to confirm|extractor|Video unavailable|HTTP Error 4\d\d.*youtube/i,
      text: 'The trailer could not be extracted from YouTube. This is usually a stale yt-dlp.', next: 'Update it and try again.' },
    { kind: 'unreadable', test: /ffprobe could not read the source/i,
      text: 'The file could not be read. It may be corrupt, still downloading, or not a video.', next: SOURCE },
    { kind: 'no-seeders', test: /Nobody is sharing/i, text: null, next: SOURCE },
    { kind: 'slow-start', test: /did not start within/i, text: null, next: SOURCE },
    { kind: 'converter-failing', test: /converter keeps failing/i,
      text: 'The converter keeps failing on this file.', next: PURIST },
    { kind: 'decode', test: /smooth player could not (play|append)/i,
      text: 'The smooth player could not decode this stream.', next: PURIST },
    { kind: 'mpv-exited', test: /mpv exited|Playback stopped unexpectedly/i,
      text: 'mpv quit unexpectedly.', next: 'Press play to start again from where you were.' },
    { kind: 'no-source', test: /no magnet link|no playable URL|No source selected/i,
      text: null, next: PICK },
    { kind: 'corrupt', test: /could not be played|corrupt|incomplete/i, text: null, next: SOURCE },
    { kind: 'timeout', test: /timed out|timeout|abort/i,
      text: 'The source timed out.', next: 'Check your connection and try again.' },
    { kind: 'offline', test: /fetch failed|ENOTFOUND|ECONNREFUSED|network/i,
      text: 'Could not reach the service.', next: 'Check your connection.' },
  ]

  // `platform` is process.platform or one of its spellings; omitted means
  // Linux, which is what every caller before roadmap 008 silently assumed.
  // `context` is 'playback' (the default, and what every caller meant before
  // the catalogue started sharing this table) or 'catalog' for a browsing or
  // detail-page failure, where there is no source list to point at.
  function explain(message, platform, context) {
    var msg = String(message || 'Something went wrong').trim()
    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i]
      if (c.test.test(msg)) {
        var next = typeof c.next === 'function' ? c.next(platform || 'linux') : c.next
        return { kind: c.kind, text: c.text || msg, next: adviceFor(next, context) }
      }
    }
    return { kind: 'unknown', text: msg, next: adviceFor(SOURCE, context) }
  }

  // One line for a toast or a stage: sentence, then the next step.
  function sentence(message, platform, context) {
    var e = explain(message, platform, context)
    if (!e.next) return e.text
    // A sentence that already ends gets a space; a raw fragment gets a dash.
    return e.text + (/[.!?]$/.test(e.text) ? ' ' : ' — ') + e.next
  }

  // The words for a picture that has not moved. `phase` is 'start' (no first
  // frame yet) or 'play' (froze after playing); `waited` seconds; `converted`
  // seconds the converter has produced ahead of the playhead, or null when
  // there is no converter (purist mode).
  function stuck(o) {
    o = o || {}
    var waited = Math.round(Number(o.waited) || 0)
    var conv = o.converted == null ? null : Math.round(Number(o.converted) || 0)
    var head = o.phase === 'start'
      ? 'Still no picture after ' + waited + ' s.'
      : 'The picture has been frozen for ' + waited + ' s.'
    var why
    if (conv == null) why = o.phase === 'start' ? 'Nothing has arrived from the source yet.' : 'The source has stopped sending data.'
    else if (conv <= 0) why = 'The converter has produced nothing yet — the source may be slow or stuck.'
    else why = 'The converter is ' + conv + ' s ahead, so the page is the slow part — the file may be too heavy to decode here.'
    return { text: head + ' ' + why, next: conv != null && conv > 0 ? 'Purist mode in Settings → Video plays it through mpv instead.' : SOURCE }
  }

  return { explain: explain, sentence: sentence, stuck: stuck, SOURCE: SOURCE, PURIST: PURIST, BROWSE: BROWSE }
})
