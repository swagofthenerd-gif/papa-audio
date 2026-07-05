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
  // Last entry is the largest in youtubei.js thumbnail arrays
  const url = list[list.length - 1]?.url || list[0]?.url || null
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

module.exports = { searchMusic, searchAll, mapMusicItem, mapVideoItem, _setClientForTest }
