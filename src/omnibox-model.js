'use strict'
// The Omnibox (roadmap J5): one box that answers with everything the app can
// reach — the library, playlists, Movies & TV, pages, settings tabs, commands,
// and the shared search memory — grouped, ranked, and keyboard-navigable.
//
// Before: Ctrl+K only focused the music search bar (library + YouTube), and a
// separate command palette (Ctrl+Shift+P) knew fourteen commands and nothing
// else. Two boxes, two vocabularies, no memory.
//
// This module is the pure half: given the query and everything the renderer
// can supply, it decides the sections and their rows. The renderer paints the
// rows and performs the actions. Ranking reuses the one brain (smart-query).
//
// Row shape: { kind, id, label, sub, art, q, surface, key, page, tab, cmd }
//   kind ∈ recent | artist | album | track | playlist | video | page | tab |
//          command | search-music | search-video | search-slsk
// Named-global export like the other shared pure modules.

var _PapaOmnibox = (function () {
  var SQ = (typeof window !== 'undefined' && window.PapaSmartQuery)
    ? window.PapaSmartQuery
    : ((typeof module !== 'undefined' && module.exports) ? require('./smart-query') : null)
  var LI = (typeof window !== 'undefined' && window.PapaLibraryIndex)
    ? window.PapaLibraryIndex
    : ((typeof module !== 'undefined' && module.exports) ? require('./library-index') : null)

  // Where the app can go by name. `words` are the extra ways people say it.
  var PAGES = [
    { page: 'home',      label: 'Home',           words: 'start front' },
    { page: 'library',   label: 'Library',        words: 'albums collection music' },
    { page: 'artists',   label: 'Artists',        words: 'bands' },
    { page: 'playlists', label: 'Playlists',      words: 'lists' },
    { page: 'explore',   label: 'Explore',        words: 'discover moods genres' },
    { page: 'soulseek',  label: 'Soulseek',       words: 'slsk p2p peers download' },
    { page: 'video',     label: 'Movies & TV',    words: 'films series anime video watch' },
    { page: 'browse',    label: 'Browse films',   words: 'filter genre country decade' },
    { page: 'diary',     label: 'Diary',          words: 'watched log journal' },
    { page: 'search',    label: 'Search',         words: 'find' },
    { page: 'downloads', label: 'Downloads',      words: 'queue transfers' },
    { page: 'liked',     label: 'Liked Songs',    words: 'favourites hearts' },
    { page: 'manage',    label: 'Manage',         words: 'tools maintenance' },
    { page: 'stats',     label: 'Stats',          words: 'listening history numbers wrapped' },
  ]
  var MANAGE_TABS = [
    { tab: 'settings',   label: 'Settings',        words: 'preferences options api keys folders theme' },
    { tab: 'duplicates', label: 'Duplicates',      words: 'dupes copies' },
    { tab: 'health',     label: 'Library health',  words: 'broken missing tags problems' },
    { tab: 'genres',     label: 'Genre tools',     words: 'merge normalise tags' },
    { tab: 'storage',    label: 'Storage',         words: 'disk space size' },
    { tab: 'trash',      label: 'Recently Deleted', words: 'trash restore undo' },
    { tab: 'chat',       label: 'Assistant chat',  words: 'agent ai ask' },
    { tab: 'memory',     label: 'Assistant memory', words: 'agent notes' },
  ]
  var LIMITS = { recents: 3, artists: 3, tracks: 5, albums: 5, playlists: 4, video: 4, go: 4, commands: 4 }

  function _score(q, fields) {
    if (!SQ) return 0
    return SQ.scoreQuery(q, fields)
  }

  // Rank a list of named things by the shared scorer; keep hits only.
  function _rankNamed(q, list, fieldsOf, limit) {
    var scored = []
    for (var i = 0; i < list.length; i++) {
      var s = _score(q, fieldsOf(list[i]))
      if (s > 0) scored.push({ item: list[i], s: s })
    }
    scored.sort(function (a, b) { return b.s - a.s })
    return scored.slice(0, limit).map(function (x) { return x.item })
  }

  // The typed words ARE the name (or its first word(s)): "settings",
  // "movies & tv", "play". Whole-word prefix, not substring — "set" alone
  // should not leap over the library.
  function _exactName(q, label) {
    if (!SQ) return false
    var a = SQ.tokenize(q), b = SQ.tokenize(label)
    if (!a.length || a.length > b.length) return false
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  function _isCommandMode(q) { return /^\s*>/.test(q || '') }
  function _stripCommand(q) { return String(q || '').replace(/^\s*>\s*/, '') }

  // src: { index, commands, playlists, video, recents, pages?, tabs? }
  function buildSections(rawQ, src) {
    src = src || {}
    var q = String(rawQ == null ? '' : rawQ).trim()
    var sections = []
    var commands = Array.isArray(src.commands) ? src.commands : []
    var pages = Array.isArray(src.pages) ? src.pages : PAGES
    var tabs = Array.isArray(src.tabs) ? src.tabs : MANAGE_TABS

    if (_isCommandMode(q)) {
      var cq = _stripCommand(q)
      var cmds = cq ? _rankNamed(cq, commands, function (c) { return [c.label] }, 50) : commands
      sections.push({ key: 'commands', title: 'Commands', items: cmds.map(_commandRow) })
      return sections
    }

    if (!q) {
      var rec = src.recents || { own: [], elsewhere: [] }
      var recRows = (rec.own || []).concat(rec.elsewhere || []).slice(0, 8).map(_recentRow)
      if (recRows.length) sections.push({ key: 'recent', title: 'Recent searches', items: recRows })
      sections.push({ key: 'go', title: 'Go to', items: pages.slice(0, 8).map(_pageRow) })
      sections.push({ key: 'commands', title: 'Commands', items: commands.slice(0, 5).map(_commandRow).concat([
        { kind: 'hint', label: 'Type > for every command', sub: '' },
      ]) })
      return sections
    }

    // A place, tab or command named exactly what was typed comes first: the
    // library's typo tolerance would otherwise put "Getting Older" above the
    // Settings tab for "settings", and Enter would play a song.
    var goRows = _rankNamed(q, pages, function (p) { return [p.label, p.words || ''] }, LIMITS.go).map(_pageRow)
      .concat(_rankNamed(q, tabs, function (t) { return [t.label, t.words || ''] }, LIMITS.go).map(_tabRow))
      .slice(0, LIMITS.go)
    var cmdRows = _rankNamed(q, commands, function (c) { return [c.label] }, LIMITS.commands).map(_commandRow)
    var exactGo = goRows.filter(function (r) { return _exactName(q, r.label) })
    var exactCmd = cmdRows.filter(function (r) { return _exactName(q, r.label) })
    if (exactGo.length) { sections.push({ key: 'go', title: 'Go to', items: goRows }); goRows = null }
    if (exactCmd.length) { sections.push({ key: 'commands', title: 'Commands', items: cmdRows }); cmdRows = null }

    // Recents that match what has been typed.
    var recents = src.recents || { own: [], elsewhere: [] }
    var recMatch = (recents.own || []).concat(recents.elsewhere || []).slice(0, LIMITS.recents).map(_recentRow)
    if (recMatch.length) sections.push({ key: 'recent', title: 'Recent', items: recMatch })

    // Library, through the one brain.
    if (src.index && LI) {
      var res = LI.query(src.index, q, { limits: { tracks: LIMITS.tracks, albums: LIMITS.albums, artists: LIMITS.artists } })
      var lib = []
      ;(res.artists || []).forEach(function (a) { lib.push({ kind: 'artist', id: a.name, label: a.name, sub: a.albumCount + ' album' + (a.albumCount === 1 ? '' : 's'), art: a.artPath || null }) })
      ;(res.albums || []).forEach(function (a) { lib.push({ kind: 'album', id: a.id, label: a.name, sub: a.artist + (a.year ? ' · ' + a.year : ''), art: a.artPath || null }) })
      ;(res.tracks || []).forEach(function (t) { lib.push({ kind: 'track', id: t.filePath, albumId: t.albumId, label: t.title, sub: t.artist + (t.album ? ' · ' + t.album : ''), art: t.artPath || null }) })
      if (lib.length) sections.push({ key: 'library', title: res.corrected ? 'Library · showing “' + res.corrected.to + '”' : 'Library', items: lib, corrected: res.corrected || null })
    }

    // Playlists by name.
    var pls = Array.isArray(src.playlists) ? src.playlists : []
    var plHits = _rankNamed(q, pls, function (p) { return [p.name] }, LIMITS.playlists)
    if (plHits.length) sections.push({ key: 'playlists', title: 'Playlists', items: plHits.map(function (p) {
      return { kind: 'playlist', id: p.id, label: p.name, sub: p.type === 'smart' ? 'Smart playlist' : (p.count != null ? p.count + ' track' + (p.count === 1 ? '' : 's') : 'Playlist') }
    }) })

    // Movies & TV: supplied by the renderer's async fetch (null while loading).
    if (Array.isArray(src.video)) {
      var vids = src.video.slice(0, LIMITS.video).map(function (v) {
        var type = v.type || 'movie'
        return { kind: 'video', key: type + ':' + v.id, label: v.title || 'Untitled', sub: [type === 'tv' ? 'Series' : type === 'anime' ? 'Anime' : 'Film', v.year].filter(Boolean).join(' · '), art: v.poster || null }
      })
      if (vids.length) sections.push({ key: 'video', title: 'Movies & TV', items: vids })
    } else if (src.videoLoading) {
      sections.push({ key: 'video', title: 'Movies & TV', items: [{ kind: 'hint', label: 'Searching…', sub: '' }] })
    }

    // Places and commands by name (unless an exact one already led).
    if (goRows && goRows.length) sections.push({ key: 'go', title: 'Go to', items: goRows })
    if (cmdRows && cmdRows.length) sections.push({ key: 'commands', title: 'Commands', items: cmdRows })

    // Never blank: the query can always be taken somewhere.
    sections.push({ key: 'search', title: 'Search', items: [
      { kind: 'search-music', q: q, label: 'Search your library and the web for “' + q + '”', sub: 'Search page · library, YouTube, Soulseek' },
      { kind: 'search-video', q: q, label: 'Search Movies & TV for “' + q + '”', sub: 'Films, series, anime' },
      { kind: 'search-slsk',  q: q, label: 'Search Soulseek for “' + q + '”', sub: 'Peers on the network' },
    ] })
    return sections
  }

  function _recentRow(e) {
    return { kind: 'recent', q: e.q, surface: _firstSurface(e), label: e.q, sub: (e.fromLabel ? e.fromLabel : _surfaceLabel(_firstSurface(e))) + (e.opened && e.opened.length ? ' · → ' + e.opened[0].label : '') }
  }
  function _firstSurface(e) {
    if (e.from && e.from.length) return e.from[0]
    var s = e.surfaces ? Object.keys(e.surfaces) : []
    if (!s.length) return 'music'
    s.sort(function (a, b) { return e.surfaces[b] - e.surfaces[a] })
    return s[0]
  }
  function _surfaceLabel(s) { return { music: 'Search', library: 'Library', video: 'Movies & TV', soulseek: 'Soulseek' }[s] || s }
  function _pageRow(p) { return { kind: 'page', page: p.page, label: p.label, sub: 'Page' } }
  function _tabRow(t) { return { kind: 'tab', tab: t.tab, label: t.label, sub: 'Manage' } }
  function _commandRow(c) { return { kind: 'command', id: c.id, label: c.label, sub: c.keys ? 'Shortcut ' + c.keys : 'Command', cmd: c } }

  // Every actionable row in reading order, for ↑ ↓ Enter.
  function flatten(sections) {
    var out = []
    for (var i = 0; i < (sections || []).length; i++) {
      var items = sections[i].items || []
      for (var j = 0; j < items.length; j++) if (items[j].kind !== 'hint') out.push(items[j])
    }
    return out
  }

  return {
    PAGES: PAGES,
    MANAGE_TABS: MANAGE_TABS,
    LIMITS: LIMITS,
    buildSections: buildSections,
    flatten: flatten,
    isCommandMode: _isCommandMode,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaOmnibox
if (typeof window !== 'undefined') window.PapaOmnibox = _PapaOmnibox
