'use strict';
// MPRIS polish (App roadmap #20) — the pure half of the D-Bus media integration.
// main owns the live mpris-service object (D-Bus is not testable here); this holds
// the shape-and-policy decisions so they are testable without a session bus:
//   - the xesam/mpris metadata object (artUrl included, http vs file:// aware),
//   - the CanSeek / CanGoNext / CanGoPrevious capability flags, derived from the
//     now-playing payload instead of left at mpris-service's always-true default,
//   - the discontinuity test that decides when to raise the Seeked signal, so the
//     Plasma applet's scrubber tracks real seeks and not every position tick.
//
// The now-playing payload (src/renderer.js _syncExtensionNow) carries: title,
// artist, album, artPath, playing, position, duration, volume, shuffle, repeat,
// queueIndex, and a slim `queue` array. Everything below is derived from that.
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaMprisMetadata = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // A cover can be a local file path or, for streamed tracks, an http URL. Only a
  // local path needs the file:// scheme + URI-encoding; an http URL is already a
  // valid artUrl and prefixing it produced "file://https://…", which KDE's media
  // widget could not load. '' when there is no art, which mpris-service treats as
  // "no artwork" rather than a broken path.
  function artUrl(artPath) {
    if (!artPath) return ''
    if (/^https?:\/\//.test(String(artPath))) return String(artPath)
    return 'file://' + encodeURI(String(artPath)).replace(/#/g, '%23')
  }

  // The mpris:/xesam: metadata object for the current track. `objectPath` and
  // `trackId` are injected by main (they come off the live mpris-service object,
  // which owns the D-Bus object-path helper); everything else is derived from the
  // payload so the shape is asserted in tests without a bus.
  function buildMetadata(data, opts) {
    data = data || {}
    opts = opts || {}
    const trackId = opts.trackId ||
      (typeof opts.objectPath === 'function'
        ? opts.objectPath('track/' + (data.queueIndex == null ? 0 : data.queueIndex))
        : '/org/mpris/MediaPlayer2/track/' + (data.queueIndex == null ? 0 : data.queueIndex))
    return {
      'mpris:trackid': trackId,
      'mpris:length': Math.round((Number(data.duration) || 0) * 1e6),
      'mpris:artUrl': artUrl(data.artPath),
      'xesam:title': data.title || '',
      'xesam:album': data.album || '',
      'xesam:artist': [data.artist || ''],
    }
  }

  // The capability flags, derived from the payload rather than left at
  // mpris-service's always-true defaults, so a desktop applet greys out the
  // controls that genuinely cannot work right now:
  //   - CanSeek: only when the track has a known positive duration. A live stream
  //     with duration 0 is not seekable, and a scrubber that pretends otherwise
  //     jumps to nonsense.
  //   - CanGoNext: another entry after this one, OR a repeat mode that loops back
  //     (repeat 'all'), OR shuffle (which can always pick another track).
  //   - CanGoPrevious: an earlier entry, OR repeat 'all'/'one', OR simply that a
  //     track is loaded — MPRIS Previous conventionally restarts the current track
  //     when there is no earlier one, so with any track loaded it does something.
  function capabilities(data) {
    data = data || {}
    const queue = Array.isArray(data.queue) ? data.queue : []
    const idx = Number.isFinite(Number(data.queueIndex)) ? Number(data.queueIndex) : -1
    const hasTrack = !!(data.title) || idx >= 0
    const repeat = data.repeat
    const shuffle = !!data.shuffle
    const duration = Number(data.duration) || 0

    const hasNextEntry = idx >= 0 && idx < queue.length - 1
    const canGoNext = hasTrack && (hasNextEntry || repeat === 'all' || repeat === 'one' || shuffle)
    // Previous always does something when a track is loaded (restart), so it is
    // enabled whenever there is a current track.
    const canGoPrevious = hasTrack
    const canSeek = hasTrack && duration > 0

    return { canSeek, canGoNext, canGoPrevious }
  }

  // Should raising the Seeked signal happen for this position update? The
  // now-playing payload fires on every position tick (throttled ~150ms), so a
  // naive "position changed -> Seeked" would spam the bus and confuse the applet.
  // A seek is a DISCONTINUITY: the position jumped by more than normal playback
  // could have advanced between two updates. Given the previous (position, at) and
  // the new one, the expected forward drift is (now - at) seconds while playing;
  // anything beyond that plus a tolerance — or any backward jump — is a real seek.
  //
  // prev: { position (s), at (ms), playing } — the last reported position sample.
  // next: { position (s), at (ms) }          — the incoming one.
  // Returns true when the applet should be told the position was seeked.
  function isSeek(prev, next, toleranceSecs) {
    if (!prev || !next) return false
    const tol = Number.isFinite(toleranceSecs) ? toleranceSecs : 1.5
    const dtSecs = Math.max(0, (Number(next.at) - Number(prev.at)) / 1000)
    const expected = prev.playing ? dtSecs : 0
    const delta = Number(next.position) - Number(prev.position)
    // A backward jump beyond tolerance, or a forward jump well past what playback
    // could have covered, is a seek.
    if (delta < -tol) return true
    if (delta > expected + tol) return true
    return false
  }

  return { artUrl, buildMetadata, capabilities, isSeek }
})
