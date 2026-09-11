'use strict'
// Journey-aware cross-jumps (roadmap J6). "Other sources", "Find soundtrack",
// an artist link on a Soulseek result — every one of these carries you to a
// different surface of the app and used to leave you there with only the
// generic Back arrow. Now the page you jumped FROM is named in a return
// strip ("← Back to your Soulseek search “camel” · 420 sources") whenever
// the jump crossed a surface boundary. Same-surface moves (search → album)
// keep the plain Back arrow: the strip is for when the app changed subject.
//
// Pure: which pages belong to which surface, when a return strip is due,
// and how a history entry is worded. The renderer captures the counts at
// the moment of leaving (entry.crumb) and paints the strip.

var _PapaJourney = (function () {
  var SURFACE = {
    home: 'music', library: 'music', artists: 'music', album: 'music', artist: 'music',
    search: 'music', playlists: 'music', playlist: 'music', smartlist: 'music', liked: 'music',
    explore: 'music', stats: 'music', wrapped: 'music', 'yt-album': 'music', 'yt-artist': 'music',
    'yt-see-all': 'music', 'yt-playlist': 'music',
    video: 'video', browse: 'video', person: 'video', 'video-detail': 'video', shelf: 'video',
    diary: 'video', calendar: 'video',
    soulseek: 'soulseek', downloads: 'downloads', manage: 'manage', trail: 'trail',
  }

  function surfaceOf(page) { return SURFACE[page] || page || '' }

  // The return strip is due when the page just left sits on another surface
  // than the page now showing, and the left page is worth returning to (it
  // has a crumb label — front pages like Home never do).
  function shouldShow(prev, current) {
    if (!prev || !prev.crumb || !prev.crumb.label) return false
    if (!current || !current.page) return false
    return surfaceOf(prev.page) !== surfaceOf(current.page)
  }

  // Wording for a history entry, from a snapshot the renderer took when the
  // page was left: { kind, title, query, count, unit }.
  //   kind ∈ search | soulseek | video-search | library-search | detail | page
  function label(snap) {
    if (!snap) return ''
    var n = Number(snap.count)
    var count = (isFinite(n) && n > 0) ? ' · ' + n + ' ' + (snap.unit || 'result') + (n === 1 ? '' : 's') : ''
    switch (snap.kind) {
      case 'search': return 'your search “' + snap.query + '”' + count
      case 'soulseek': return 'your Soulseek search “' + snap.query + '”' + count
      case 'video-search': return 'your Movies & TV search “' + snap.query + '”' + count
      case 'library-search': return 'the Library, searching “' + snap.query + '”' + count
      case 'detail': return snap.title || ''
      case 'page': return snap.title || ''
      default: return snap.title || ''
    }
  }

  return { SURFACE: SURFACE, surfaceOf: surfaceOf, shouldShow: shouldShow, label: label }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaJourney
if (typeof window !== 'undefined') window.PapaJourney = _PapaJourney
