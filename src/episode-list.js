'use strict'
// The television episode list (video plan V2.1): rows with a still, the
// title, the air date, the synopsis, a watched tick, a progress bar and an
// "up next" highlight, instead of a wall of numbered buttons. Pure builders
// returning row models; the renderer turns them into HTML. Tested in
// test/episode-list.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaEpisodeList = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function _n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0 }

  // "2024-03-15" → "15 Mar 2024"; a date in the future → "Airs 15 Mar 2024".
  function dateLabel(iso, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
    if (!m) return ''
    const label = _n(m[3]) + ' ' + MONTHS[_n(m[2]) - 1] + ' ' + m[1]
    const t = Date.UTC(_n(m[1]), _n(m[2]) - 1, _n(m[3]))
    return now != null && t > _n(now) ? 'Airs ' + label : label
  }

  function runtimeLabel(min) {
    const r = _n(min)
    if (r <= 0) return ''
    return r >= 60 ? Math.floor(r / 60) + 'h ' + String(r % 60).padStart(2, '0') + 'm' : r + 'm'
  }

  // `episodes` are TMDB-shaped ({episodeNumber, name, overview, still, airDate,
  // runtime}); `prog` is _epProgress' output ({items: {n: {watched, ratio,
  // position, duration}}, resume, next}); `current` is the selected episode.
  function rows(episodes, prog, current, now) {
    const list = Array.isArray(episodes) ? episodes : []
    const items = (prog && prog.items) || {}
    const upNext = prog && prog.resume ? prog.resume.episode : (prog && prog.next ? prog.next.episode : null)
    return list.map(function (ep) {
      const n = _n(ep && ep.episodeNumber)
      const rec = items[n] || null
      const watched = !!(rec && rec.watched)
      const pct = rec && !watched && rec.ratio > 0 ? Math.round(rec.ratio * 100) : 0
      const left = rec && !watched && rec.duration ? Math.max(0, _n(rec.duration) - _n(rec.position)) : 0
      const date = dateLabel(ep && ep.airDate, now)
      return {
        n: n,
        title: (ep && ep.name) || ('Episode ' + n),
        synopsis: (ep && ep.overview) || '',
        still: (ep && ep.still) || '',
        date: date,
        unaired: /^Airs /.test(date),
        runtime: runtimeLabel(ep && ep.runtime),
        watched: watched,
        pct: pct,
        left: left,
        current: n === _n(current),
        upNext: upNext != null && n === upNext,
      }
    })
  }

  return { rows, dateLabel, runtimeLabel }
})
