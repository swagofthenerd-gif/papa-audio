'use strict'
// YouTube search via youtubei.js (InnerTube). Search only — playback goes
// through mpv's yt-dlp hook, downloads through youtube-download.js.

const fs = require('fs')
const path = require('path')

let _clientPromise = null
let _cacheDir = null
let _cookie = null

// Called once from main.js with an app-data path — keeps this module electron-free.
function setCacheDir(dir) { _cacheDir = dir }

// Cookie-based auth: OAuth TV tokens are rejected (HTTP 400) by every YouTube
// Music InnerTube endpoint, so personalization must come from browser cookies.
// Passing null reverts to an anonymous client.
function setCookie(cookie) {
  _cookie = cookie || null
  _clientPromise = null
}

function _client() {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { Innertube, UniversalCache } = await import('youtubei.js')
      // No player needed: we never decipher stream URLs here.
      const cache = _cacheDir ? new UniversalCache(true, _cacheDir) : undefined
      return Innertube.create({ retrieve_player: false, cache, cookie: _cookie || undefined })
    })()
      .catch(e => { _clientPromise = null; throw e })
  }
  return _clientPromise
}

function _setClientForTest(p) { _clientPromise = p }

function _text(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v.text === 'string') return v.text
  return String(v)
}

function _thumbUrl(t) {
  const list = Array.isArray(t) ? t : (Array.isArray(t?.contents) ? t.contents : [])
  if (!list.length) return null
  // Order varies by endpoint (search: smallest-first, browse: largest-first) — pick by width
  const best = list.reduce((a, b) => ((b?.width || 0) > (a?.width || 0) ? b : a), list[0])
  const url = best?.url || null
  // YT Music often only returns 60px art; googleusercontent accepts size params
  return url ? url.replace(/=w60-h60/, '=w226-h226') : null
}

function mapMusicItem(item) {
  if (!item?.id) return null
  return {
    videoId: item.id,
    title: _text(item.title),
    artist: Array.isArray(item.artists)
      ? item.artists.map(a => a?.name).filter(Boolean).join(', ')
      : _text(item.author?.name),
    album: item.album?.name || null,
    duration: item.duration?.seconds || 0,
    albumBrowseId: item.album?.id || null,
    channelId: (Array.isArray(item.artists) && item.artists[0]?.channel_id) || item.author?.channel_id || null,
    thumbnailUrl: _thumbUrl(item.thumbnail || item.thumbnails),
  }
}

function mapVideoItem(item) {
  if (!item?.id) return null
  return {
    videoId: item.id,
    title: _text(item.title),
    artist: _text(item.author?.name),
    album: null,
    duration: item.duration?.seconds || 0,
    channelId: item.author?.id || null,
    thumbnailUrl: _thumbUrl(item.thumbnails || item.thumbnail),
    viewCount: _text(item.short_view_count) || null,
  }
}

function mapAlbumItem(item) {
  if (!item?.id) return null
  return {
    browseId: item.id,
    title: _text(item.title),
    artist: _text(item.author?.name) || (Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean).join(', ') : ''),
    year: _text(item.year || item.subtitle) || '',
    thumbnailUrl: _thumbUrl(item.thumbnail || item.thumbnails),
  }
}

function mapArtistItem(item) {
  if (!item?.id) return null
  return {
    channelId: item.id,
    name: _text(item.name || item.title),
    subtitle: _text(item.subtitle) || '',
    thumbnailUrl: _thumbUrl(item.thumbnail || item.thumbnails),
  }
}

function mapPlaylistItem(item) {
  if (!item?.id) return null
  return {
    playlistId: item.id,
    title: _text(item.title),
    author: _text(item.author?.name)
      || (Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean).join(', ') : ''),
    songCount: _text(item.song_count || item.video_count) || '',
    thumbnailUrl: _thumbUrl(item.thumbnail || item.thumbnails),
  }
}

const _searchCache = new Map()
const CACHE_TTL = 5 * 60 * 1000

function _cached(key, fetchFn) {
  const entry = _searchCache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.items
  return null
}

function _cacheSet(key, items) {
  _searchCache.set(key, { items, ts: Date.now() })
  if (_searchCache.size > 100) {
    const cutoff = Date.now() - CACHE_TTL
    for (const [k, v] of _searchCache) if (v.ts < cutoff) _searchCache.delete(k)
  }
}

function clearSearchCache() { _searchCache.clear() }

const MAX_RESULTS = 25

async function searchMusic(query) {
  const key = 'music:' + query.toLowerCase()
  const cached = _cached(key)
  if (cached) return cached
  const yt = await _client()
  const res = await yt.music.search(query, { type: 'song' })
  const raw = res?.songs?.contents
    || (Array.isArray(res?.contents) ? res.contents.flatMap(s => s?.contents || []) : [])
  const items = raw.map(mapMusicItem).filter(Boolean).slice(0, MAX_RESULTS)
  _cacheSet(key, items)
  return items
}

async function searchAll(query) {
  const key = 'all:' + query.toLowerCase()
  const cached = _cached(key)
  if (cached) return cached
  const yt = await _client()
  const res = await yt.search(query, { type: 'video' })
  const raw = res?.videos || res?.results || []
  const items = raw.map(mapVideoItem).filter(Boolean).slice(0, MAX_RESULTS)
  _cacheSet(key, items)
  return items
}

async function searchMusicFull(query) {
  const key = 'full:' + query.toLowerCase()
  const cached = _cached(key)
  if (cached) return cached
  const yt = await _client()
  const [songRes, albumRes, artistRes, plRes] = await Promise.all([
    yt.music.search(query, { type: 'song' }),
    yt.music.search(query, { type: 'album' }),
    yt.music.search(query, { type: 'artist' }),
    yt.music.search(query, { type: 'playlist' }),
  ])
  const raw = (res, key) => res?.[key]?.contents
    || (Array.isArray(res?.contents) ? res.contents.flatMap(s => s?.contents || []) : [])
  const items = {
    songs: raw(songRes, 'songs').map(mapMusicItem).filter(Boolean).slice(0, 10),
    albums: raw(albumRes, 'albums').map(mapAlbumItem).filter(Boolean).slice(0, 12),
    artists: raw(artistRes, 'artists').map(mapArtistItem).filter(Boolean).slice(0, 8),
    playlists: raw(plRes, 'playlists').map(mapPlaylistItem).filter(Boolean).slice(0, 8),
  }
  _cacheSet(key, items)
  return items
}

const PAGE_MAPPERS = {
  song: mapMusicItem, album: mapAlbumItem, artist: mapArtistItem,
  playlist: mapPlaylistItem, video: mapVideoItem,
}
const PAGE_KEYS = { song: 'songs', album: 'albums', artist: 'artists', playlist: 'playlists' }

// Continuation objects aren't IPC-serializable — keep the last result per
// (kind, query) here and let the renderer just ask for "next".
const _pageSessions = new Map()

function _extractPageItems(res, kind) {
  if (kind === 'video') return res?.videos || res?.results || []
  const sec = res?.[PAGE_KEYS[kind]]?.contents
  if (Array.isArray(sec)) return sec
  const c = res?.contents
  if (Array.isArray(c)) {
    // Continuation pages come back as a flat item list or as shelves
    return c.flatMap(s => (Array.isArray(s?.contents) ? s.contents : (s?.id ? [s] : [])))
  }
  // Music continuations wrap the list: contents is a MusicShelfContinuation
  if (Array.isArray(c?.contents)) return c.contents
  if (Array.isArray(res?.results)) return res.results
  return []
}

async function searchPage(kind, query, next) {
  if (!PAGE_MAPPERS[kind]) throw new Error(`unknown kind: ${kind}`)
  const cacheKey = 'page:' + kind + ':' + query.toLowerCase()
  if (!next) {
    const cached = _cached(cacheKey)
    if (cached) return cached
  }
  const yt = await _client()
  const key = `${kind}::${query}`
  let res
  const prev = next ? _pageSessions.get(key) : null
  if (prev && typeof prev.getContinuation === 'function') {
    res = await prev.getContinuation()
  } else if (kind === 'video') {
    res = await yt.search(query, { type: 'video' })
  } else {
    res = await yt.music.search(query, { type: kind })
  }
  _pageSessions.set(key, res)
  if (_pageSessions.size > 40) _pageSessions.delete(_pageSessions.keys().next().value)
  const items = _extractPageItems(res, kind).map(PAGE_MAPPERS[kind]).filter(Boolean)
  const hasMore = !!(res?.has_continuation && typeof res.getContinuation === 'function')
  const result = { items, hasMore }
  if (!next) _cacheSet(cacheKey, result)
  return result
}

async function getAlbum(browseId) {
  const yt = await _client()
  const al = await yt.music.getAlbum(browseId)
  const h = al?.header || {}
  // subtitle is "Album • 2001" — take the year segment
  const year = (_text(h.subtitle).match(/\b(\d{4})\b/) || [])[1] || ''
  return {
    browseId,
    title: _text(h.title),
    artist: _text(h.strapline_text_one) || _text(h.author?.name) || '',
    year,
    summary: _text(h.second_subtitle) || '',
    thumbnailUrl: _thumbUrl(h.thumbnail || h.thumbnails),
    tracks: (al?.contents || []).filter(t => t?.id).map((t, i) => ({
      videoId: t.id,
      title: _text(t.title),
      duration: t.duration?.seconds || 0,
      index: parseInt(_text(t.index), 10) || i + 1,
    })),
  }
}

async function getPlaylist(playlistId) {
  const yt = await _client()
  const pl = await yt.music.getPlaylist(playlistId)
  const h = pl?.header || {}
  const rawItems = pl?.items || pl?.contents || []
  const tracks = rawItems.filter(t => t?.id).map(mapMusicItem).filter(Boolean)
  return {
    playlistId,
    title: _text(h.title),
    author: _text(h.author?.name) || _text(h.strapline_text_one) || '',
    songCount: tracks.length,
    thumbnailUrl: _thumbUrl(h.thumbnail || h.thumbnails),
    tracks,
  }
}

function _carousel(sections, name) {
  const sec = (sections || []).find(s => (_text(s?.header?.title) || _text(s?.title)) === name)
  return (sec?.contents || []).map(mapAlbumItem).filter(Boolean)
}

async function getArtist(channelId) {
  const yt = await _client()
  const ar = await yt.music.getArtist(channelId)
  const h = ar?.header || {}
  const name = _text(h.title)
  const topSec = (ar?.sections || []).find(s => /top songs/i.test(_text(s?.title) || _text(s?.header?.title)))
  const topSongs = (topSec?.contents || [])
    .map(mapMusicItem).filter(Boolean).slice(0, 10)
    // Top-songs shelf items often lack artist info — fill from the page
    .map(s => ({ ...s, artist: s.artist || name }))
  return {
    channelId,
    name,
    thumbnailUrl: _thumbUrl(h.thumbnail || h.thumbnails),
    topSongs,
    albums: _carousel(ar?.sections, 'Albums'),
    singles: _carousel(ar?.sections, 'Singles & EPs'),
  }
}

// Album ids on YT Music start with MPREb; playlist/mix ids with VL/PL/RDCLAK;
// watch ids are 11 chars.
function _looksLikeAlbumId(id) { return typeof id === 'string' && /^MPRE/i.test(id) }
function _looksLikePlaylistId(id) { return typeof id === 'string' && /^(VL|PL|RDCLAK)/.test(id) }

const HOME_FEED_MAX_SECTIONS = 8

async function getHomeFeed() {
  const yt = await _client()
  const feed = await yt.music.getHomeFeed()
  const sections = []
  for (const sec of (feed?.sections || [])) {
    if (sections.length >= HOME_FEED_MAX_SECTIONS) break
    const title = _text(sec?.header?.title) || _text(sec?.title)
    const contents = Array.isArray(sec?.contents) ? sec.contents : []
    if (!title || !contents.length) continue
    const albums = contents.filter(c => _looksLikeAlbumId(c?.id)).map(mapAlbumItem).filter(Boolean)
    const playlists = contents.filter(c => _looksLikePlaylistId(c?.id)).map(mapPlaylistItem).filter(Boolean)
    const songs = contents.filter(c => c?.id && !_looksLikeAlbumId(c.id) && !_looksLikePlaylistId(c.id))
      .map(mapMusicItem).filter(Boolean)
    const best = [
      { kind: 'albums', items: albums, cap: 12 },
      { kind: 'playlists', items: playlists, cap: 12 },
      { kind: 'songs', items: songs, cap: 12 },
    ].sort((a, b) => b.items.length - a.items.length)[0]
    if (best.items.length) sections.push({ title, kind: best.kind, items: best.items.slice(0, best.cap) })
  }
  return { sections }
}

// ── Radio (up-next) ─────────────────────────────────────────────────────────
function _parseClock(t) {
  const parts = String(t || '').split(':').map(n => parseInt(n, 10))
  if (!parts.length || parts.some(isNaN)) return 0
  return parts.reduce((s, n) => s * 60 + n, 0)
}

function mapUpNextItem(item) {
  const vid = item?.video_id || item?.id
  if (!vid) return null
  return {
    videoId: vid,
    title: _text(item.title),
    artist: _text(item.author?.name)
      || (typeof item.author === 'string' ? item.author : '')
      || (Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean).join(', ') : ''),
    album: null,
    duration: item.duration?.seconds || _parseClock(item.duration?.text || item.duration),
    thumbnailUrl: _thumbUrl(item.thumbnail || item.thumbnails),
  }
}

const RADIO_MAX_TRACKS = 30

async function getRadio(videoId) {
  const yt = await _client()
  const panel = await yt.music.getUpNext(videoId, true)
  return (panel?.contents || [])
    .map(mapUpNextItem)
    .filter(Boolean)
    .filter(t => t.videoId !== videoId)
    .slice(0, RADIO_MAX_TRACKS)
}

async function findVideoId(artist, title) {
  const results = await searchMusic(`${artist || ''} ${title || ''}`.trim())
  return results[0]?.videoId || null
}

// ── Auth status ──────────────────────────────────────────────────────────────
function isSignedIn() { return !!_cookie }

// Leftover OAuth credentials from the abandoned device-flow approach break all
// YT Music requests with HTTP 400 — purge them if present.
function purgeStaleOauth() {
  if (!_cacheDir) return
  try { fs.rmSync(path.join(_cacheDir, 'youtubei_oauth_credentials'), { force: true }) } catch {}
}

// lyrics.js needs the shared (possibly signed-in) Innertube instance
function _clientForLyrics() { return _client() }

module.exports = {
  searchMusic, searchAll, searchMusicFull, searchPage, getAlbum, getArtist, getPlaylist, getHomeFeed,
  _clientForLyrics,
  getRadio, findVideoId, mapUpNextItem,
  setCacheDir, setCookie, isSignedIn, purgeStaleOauth, clearSearchCache,
  mapMusicItem, mapVideoItem, mapAlbumItem, mapArtistItem, mapPlaylistItem, _setClientForTest,
}
