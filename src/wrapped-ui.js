// Year-end Wrapped (App #16) — extracted verbatim from renderer.js (roadmap
// item #62, structural split). A full year-in-review computed from the same
// stats/history stores the Stats page uses (state.playHistory, state.playCounts,
// state.library) plus the video diary/watch history — all through the tested
// pure aggregator in home-recap.js. Rich, palette-tinted cards; a "Copy as text"
// button puts a shareable summary on the clipboard (no image export by design).
//
// This lives apart from renderer.js so the ~30k-line renderer shrinks and the
// region loads as its own <script>. It reads several renderer globals; rather
// than reach for them implicitly, every one is threaded in through an explicit
// `deps` object passed to show(). renderer.js keeps a thin delegating stub so
// every existing call site (navigate('wrapped') → renderWrapped) keeps working.
//
// Published as window.PapaWrappedUI for the renderer; module.exports for tests.

;(function () {

  // renderWrapped, moved VERBATIM from renderer.js. The only change is that the
  // renderer globals it used to close over (esc, navigate, setContent,
  // showSnackbar, state) now arrive through `deps`.
  function renderWrapped(yearArg, deps) {
    var esc = deps.esc
    var navigate = deps.navigate
    var setContent = deps.setContent
    var showSnackbar = deps.showSnackbar
    var state = deps.state

    var year = parseInt(yearArg, 10)
    if (!isFinite(year)) year = new Date().getFullYear()

    var _rc = (typeof window !== 'undefined' && window.PapaHomeRecap) || null
    if (!_rc || !_rc.wrappedRecap) {
      setContent('<div class="page"><div class="empty-wrap"><h2>Wrapped unavailable</h2><p>The recap module did not load.</p></div></div>')
      return
    }

    // Resolvers over the library, keyed by filePath, so history rows written
    // before durations/genres were stored still contribute.
    var durByPath = {}, artistByPath = {}, albumByPath = {}, genreByPath = {}, titleByPath = {}
    state.library.forEach(function (a) {
      ;(a.tracks || []).forEach(function (t) {
        if (!t.filePath) return
        durByPath[t.filePath] = t.duration || 0
        artistByPath[t.filePath] = t.albumArtist || t.artist || a.artist || ''
        albumByPath[t.filePath] = a.name || t.albumName || ''
        genreByPath[t.filePath] = t.genre || a.genre || ''
        titleByPath[t.filePath] = t.title || ''
      })
    })

    var w = _rc.wrappedRecap(state.playHistory || [], {
      year: year,
      durationOf: function (fp) { return durByPath[fp] || 0 },
      artistOf: function (fp) { return artistByPath[fp] || '' },
      albumOf: function (fp) { return albumByPath[fp] || '' },
      genreOf: function (fp) { return genreByPath[fp] || '' },
      titleOf: function (fp) { return titleByPath[fp] || '' },
    })

    if (!w.has) {
      setContent('<div class="page">' +
        '<div class="wrapped-header"><button class="wrapped-back" id="wrapped-back">‹ Back</button></div>' +
        '<div class="empty-wrap"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>' +
        '<h2>No ' + year + ' Wrapped yet</h2><p>Play some music this year and your recap will appear here.</p></div></div>')
      document.getElementById('wrapped-back')?.addEventListener('click', function () { navigate('stats') })
      return
    }

    var artFor = function (name) {
      var al = state.library.find(function (a) { return a.artist === name || a.albumArtist === name })
      return al && al.artPath ? al.artPath : null
    }

    // A few palette hues so each hero card reads distinct.
    var tint = function (i) {
      var hues = [265, 200, 330, 150, 30, 190]
      var h = hues[i % hues.length]
      return 'linear-gradient(135deg,hsl(' + h + ',60%,32%),hsl(' + ((h + 40) % 360) + ',55%,18%))'
    }

    var bigCards = [
      { label: 'Tracks played', value: w.plays.toLocaleString() },
      { label: 'Hours listened', value: (w.hours || 0) + 'h' },
      { label: 'Longest session', value: w.longestSessionMins + ' min' },
      { label: 'New discoveries', value: w.discoveries.toLocaleString() },
    ]
    if (w.topGenre) bigCards.push({ label: 'Top genre', value: w.topGenre })
    if (w.biggestDay) bigCards.push({
      label: 'Biggest day',
      value: new Date(w.biggestDay.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      sub: w.biggestDay.plays + ' plays',
    })

    var heroHTML = '<div class="wrapped-hero-grid">' + bigCards.map(function (c, i) {
      return '<div class="wrapped-hero-card" style="background:' + tint(i) + '">' +
        '<div class="wrapped-hero-value">' + esc(c.value) + '</div>' +
        '<div class="wrapped-hero-label">' + esc(c.label) + '</div>' +
        (c.sub ? '<div class="wrapped-hero-sub">' + esc(c.sub) + '</div>' : '') +
        '</div>'
    }).join('') + '</div>'

    var rankList = function (title, rows, nameKey) {
      if (!rows || !rows.length) return ''
      return '<div class="wrapped-section"><h2>' + esc(title) + '</h2>' +
        rows.map(function (r, i) {
          var name = r[nameKey] || r.name || r.title || 'Unknown'
          var ap = nameKey === 'name' && title.indexOf('Artist') !== -1 ? artFor(name) : null
          var mins = Math.round((r.seconds || 0) / 60)
          return '<div class="wrapped-rank-row">' +
            '<span class="wrapped-rank-num">' + (i + 1) + '</span>' +
            (ap ? '<img class="wrapped-rank-art" src="' + esc('file://' + ap) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
            '<span class="wrapped-rank-name">' + esc(name) + '</span>' +
            '<span class="wrapped-rank-meta">' + (r.plays || 0) + ' play' + ((r.plays || 0) === 1 ? '' : 's') +
            (mins > 0 ? ' · ' + mins + ' min' : '') + '</span>' +
            '</div>'
        }).join('') + '</div>'
    }

    var topArtistsHTML = rankList('Top artists', w.topArtists, 'name')
    var topAlbumsHTML = rankList('Top albums', w.topAlbums, 'name')
    var topTracksHTML = (w.topTracks && w.topTracks.length)
      ? '<div class="wrapped-section"><h2>Top tracks</h2>' + w.topTracks.map(function (t, i) {
          return '<div class="wrapped-rank-row">' +
            '<span class="wrapped-rank-num">' + (i + 1) + '</span>' +
            '<span class="wrapped-rank-name">' + esc(t.title || t.filePath) +
            (t.artist ? ' <span style="color:var(--text3)">— ' + esc(t.artist) + '</span>' : '') + '</span>' +
            '<span class="wrapped-rank-meta">' + t.plays + ' play' + (t.plays === 1 ? '' : 's') + '</span>' +
            '</div>'
        }).join('') + '</div>'
      : ''

    setContent('<div class="page wrapped-page">' +
      '<div class="wrapped-header">' +
        '<button class="wrapped-back" id="wrapped-back">‹ Back</button>' +
        '<h1 class="wrapped-title">Your ' + year + ' Wrapped</h1>' +
        '<button class="wrapped-copy" id="wrapped-copy">Copy as text</button>' +
      '</div>' +
      heroHTML + topArtistsHTML + topAlbumsHTML + topTracksHTML +
      '</div>')

    document.getElementById('wrapped-back')?.addEventListener('click', function () { navigate('stats') })
    document.getElementById('wrapped-copy')?.addEventListener('click', function () {
      var text = _wrappedSummaryText(w)
      navigator.clipboard.writeText(text).then(function () {
        showSnackbar('Wrapped summary copied to clipboard')
      }).catch(function () { showSnackbar('Could not copy to clipboard') })
    })
  }

  // The shareable plain-text summary of a Wrapped result (App #16). Kept next to
  // renderWrapped so the clipboard text and the on-screen cards stay in step.
  // Pure — no renderer globals — so it needs no deps.
  function _wrappedSummaryText(w) {
    var lines = []
    lines.push('🎵 My ' + w.year + ' Papa Audio Wrapped')
    lines.push('')
    lines.push('• ' + w.plays.toLocaleString() + ' tracks played')
    if (w.hours > 0) lines.push('• ' + w.hours + ' hours of listening')
    if (w.longestSessionMins > 0) lines.push('• Longest session: ' + w.longestSessionMins + ' min')
    if (w.discoveries > 0) lines.push('• ' + w.discoveries + ' new discoveries')
    if (w.topGenre) lines.push('• Top genre: ' + w.topGenre)
    if (w.biggestDay) lines.push('• Biggest day: ' + w.biggestDay.date + ' (' + w.biggestDay.plays + ' plays)')
    if (w.topArtists && w.topArtists.length) {
      lines.push('')
      lines.push('Top artists:')
      w.topArtists.forEach(function (a, i) { lines.push('  ' + (i + 1) + '. ' + a.name + ' (' + a.plays + ' plays)') })
    }
    if (w.topTracks && w.topTracks.length) {
      lines.push('')
      lines.push('Top tracks:')
      w.topTracks.forEach(function (t, i) { lines.push('  ' + (i + 1) + '. ' + (t.title || t.filePath) + (t.artist ? ' — ' + t.artist : '')) })
    }
    return lines.join('\n')
  }

  var api = { renderWrapped: renderWrapped, _wrappedSummaryText: _wrappedSummaryText }

  if (typeof window !== 'undefined') window.PapaWrappedUI = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api

})()
