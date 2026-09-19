'use strict'
// Pure shaping of MusicBrainz and Discogs replies for the peer library. main.js
// does the HTTP; these functions decide what the UI gets to see.

function pickArtistTags(json) {
  const list = Array.isArray(json && json.artists) ? json.artists : []
  if (!list.length) return []
  const top = list.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0]
  return (top.tags || [])
    .filter(t => t && t.name && (Number(t.count) || 0) > 0)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, 8)
    .map(t => String(t.name).toLowerCase())
}

function pickDiscogsMaster(json) {
  const r = (Array.isArray(json && json.results) ? json.results : []).find(x => x && x.type === 'master' && x.id)
  if (!r) return null
  return { id: r.id, url: 'https://www.discogs.com' + String(r.uri || ('/master/' + r.id)) }
}

function discogsSummary(json) {
  const c = (json && json.community && json.community.rating) || {}
  return {
    rating: c.average != null ? Math.round(Number(c.average) * 10) / 10 : null,
    count: Number(c.count) || 0,
    genres: Array.isArray(json && json.genres) ? json.genres : [],
    styles: Array.isArray(json && json.styles) ? json.styles : [],
  }
}

module.exports = { pickArtistTags, pickDiscogsMaster, discogsSummary }
