'use strict'
// YarrList directory — fetches and parses the YarrList streaming-site listing
// pages into `{ name, url, category }` entries. CommonJS only; no runtime deps
// beyond the global `fetch`. Every I/O path accepts an injectable `fetchFn` so
// tests run without the network.
//
// The pages are plain HTML lists of `<a href="...">Name</a>` links. No DOM
// library is used — anchors are extracted with a regex and hrefs are validated
// with the WHATWG URL parser.

const MOVIES_TV_URL = 'https://yarrlist.net/movies-and-tv-shows'
const ANIME_URL = 'https://yarrlist.net/anime-list'

const ANCHOR_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/gi
const HREF_RE = /href\s*=\s*["']([^"']*)["']/i
const TAG_RE = /<[^>]*>/g
const WS_RE = /\s+/g

function _isYarrlist(hostname) {
  return /(^|\.)yarrlist\.[a-z]{2,}$/i.test(hostname)
}

// Parse an HTML string into a list of `{ name, url, category }` sites.
// Absolute http(s) links are kept; `yarrlist.*` domains and `#`/empty anchors
// are dropped, and results are de-duplicated by hostname (first wins).
function parseSites(html, category) {
  if (typeof html !== 'string' || html.length === 0) return []
  const seen = new Set()
  const sites = []
  ANCHOR_RE.lastIndex = 0
  let m
  while ((m = ANCHOR_RE.exec(html))) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1)
    const hrefMatch = HREF_RE.exec(openTag)
    if (!hrefMatch) continue
    const href = hrefMatch[1].trim()
    if (!href || href.startsWith('#')) continue
    let parsed
    try {
      parsed = new URL(href)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    if (_isYarrlist(parsed.hostname)) continue
    if (seen.has(parsed.hostname)) continue
    seen.add(parsed.hostname)
    const name = m[1].replace(TAG_RE, '').replace(WS_RE, ' ').trim()
    sites.push({ name, url: href, category })
  }
  return sites
}

function createYarrlistDirectory({ fetchFn } = {}) {
  const fetcher = fetchFn || fetch

  async function _fetchHtml(url) {
    const res = await fetcher(url)
    if (!res || !res.ok) return ''
    return typeof res.text === 'function' ? await res.text() : ''
  }

  return {
    async refresh() {
      const [moviesTvHtml, animeHtml] = await Promise.all([
        _fetchHtml(MOVIES_TV_URL),
        _fetchHtml(ANIME_URL),
      ])
      return {
        moviesTv: parseSites(moviesTvHtml, 'movies-tv'),
        anime: parseSites(animeHtml, 'anime'),
        fetchedAt: Date.now(),
      }
    },
  }
}

module.exports = {
  parseSites,
  createYarrlistDirectory,
  MOVIES_TV_URL,
  ANIME_URL,
}
