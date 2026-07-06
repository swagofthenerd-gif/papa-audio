'use strict'
// YouTube search via youtubei.js (InnerTube). Search only — playback goes
// through mpv's yt-dlp hook, downloads through youtube-download.js.

let _clientPromise = null

function _client() {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { Innertube } = await import('youtubei.js')
      // No player needed: we never decipher stream URLs here.
      return Innertube.create({ retrieve_player: false })
    })()
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

const MAX_RESULTS = 25

async function searchMusic(query) {
  const yt = await _client()
  const res = await yt.music.search(query, { type: 'song' })
  const raw = res?.songs?.contents
    || (Array.isArray(res?.contents) ? res.contents.flatMap(s => s?.contents || []) : [])
  return raw.map(mapMusicItem).filter(Boolean).slice(0, MAX_RESULTS)
}

async function searchAll(query) {
  const yt = await _client()
  const res = await yt.search(query, { type: 'video' })
  const raw = res?.videos || res?.results || []
  return raw.map(mapVideoItem).filter(Boolean).slice(0, MAX_RESULTS)
}

async function searchMusicFull(query) {
  const yt = await _client()
  const [songRes, albumRes, artistRes, plRes] = await Promise.all([
    yt.music.search(query, { type: 'song' }),
    yt.music.search(query, { type: 'album' }),
    yt.music.search(query, { type: 'artist' }),
    yt.music.search(query, { type: 'playlist' }),
  ])
  const raw = (res, key) => res?.[key]?.contents
    || (Array.isArray(res?.contents) ? res.contents.flatMap(s => s?.contents || []) : [])
  return {
    songs: raw(songRes, 'songs').map(mapMusicItem).filter(Boolean).slice(0, 10),
    albums: raw(albumRes, 'albums').map(mapAlbumItem).filter(Boolean).slice(0, 12),
    artists: raw(artistRes, 'artists').map(mapArtistItem).filter(Boolean).slice(0, 8),
    playlists: raw(plRes, 'playlists').map(mapPlaylistItem).filter(Boolean).slice(0, 8),
  }
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
  if (Array.isArray(res?.contents)) {
    // Continuation pages come back as a flat item list or as shelves
    return res.contents.flatMap(s => (Array.isArray(s?.contents) ? s.contents : (s?.id ? [s] : [])))
  }
  if (Array.isArray(res?.results)) return res.results
  return []
}

async function searchPage(kind, query, next) {
  if (!PAGE_MAPPERS[kind]) throw new Error(`unknown kind: ${kind}`)
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
  return { items, hasMore }
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

module.exports = {
  searchMusic, searchAll, searchMusicFull, searchPage, getAlbum, getArtist, getPlaylist,
  mapMusicItem, mapVideoItem, mapAlbumItem, mapArtistItem, mapPlaylistItem, _setClientForTest,
}
