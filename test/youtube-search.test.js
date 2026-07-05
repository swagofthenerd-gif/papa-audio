'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { mapMusicItem, mapVideoItem, searchMusic, searchAll, _setClientForTest } = require('../youtube-search')

// Fixture shaped like a youtubei.js MusicResponsiveListItem (song)
const songItem = {
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  artists: [{ name: 'Rick Astley' }],
  album: { name: 'Whenever You Need Somebody' },
  duration: { seconds: 213, text: '3:33' },
  thumbnail: { contents: [{ url: 'https://i.ytimg.com/small.jpg', width: 60 }, { url: 'https://i.ytimg.com/big.jpg', width: 226 }] },
}

// Fixture shaped like a youtubei.js Video node (regular search)
const videoItem = {
  id: 'abc123XYZ_-',
  title: { text: 'Fred again.. | Boiler Room: London' },
  author: { name: 'Boiler Room' },
  duration: { seconds: 3722 },
  thumbnails: [{ url: 'https://i.ytimg.com/vid.jpg' }],
  short_view_count: { text: '12M views' },
}

test('mapMusicItem maps a song', () => {
  const r = mapMusicItem(songItem)
  assert.strictEqual(r.videoId, 'dQw4w9WgXcQ')
  assert.strictEqual(r.title, 'Never Gonna Give You Up')
  assert.strictEqual(r.artist, 'Rick Astley')
  assert.strictEqual(r.album, 'Whenever You Need Somebody')
  assert.strictEqual(r.duration, 213)
  assert.strictEqual(r.thumbnailUrl, 'https://i.ytimg.com/big.jpg')
})

test('mapMusicItem joins multiple artists', () => {
  const r = mapMusicItem({ ...songItem, artists: [{ name: 'A' }, { name: 'B' }] })
  assert.strictEqual(r.artist, 'A, B')
})

test('mapMusicItem returns null without an id', () => {
  assert.strictEqual(mapMusicItem({ title: 'x' }), null)
  assert.strictEqual(mapMusicItem(null), null)
})

test('mapVideoItem maps a video with Text-object title', () => {
  const r = mapVideoItem(videoItem)
  assert.strictEqual(r.videoId, 'abc123XYZ_-')
  assert.strictEqual(r.title, 'Fred again.. | Boiler Room: London')
  assert.strictEqual(r.artist, 'Boiler Room')
  assert.strictEqual(r.album, null)
  assert.strictEqual(r.duration, 3722)
  assert.strictEqual(r.thumbnailUrl, 'https://i.ytimg.com/vid.jpg')
  assert.strictEqual(r.viewCount, '12M views')
})

test('searchMusic maps songs from music.search', async () => {
  _setClientForTest(Promise.resolve({
    music: { search: async () => ({ songs: { contents: [songItem, { noId: true }] } }) },
  }))
  const out = await searchMusic('rick astley')
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].videoId, 'dQw4w9WgXcQ')
})

test('searchAll maps videos from search', async () => {
  _setClientForTest(Promise.resolve({
    search: async () => ({ videos: [videoItem] }),
  }))
  const out = await searchAll('boiler room')
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].videoId, 'abc123XYZ_-')
})
