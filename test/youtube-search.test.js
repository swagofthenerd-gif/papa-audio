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

// ── Spotify-style entity search ──────────────────────────────────────────────

const albumItem = {
  item_type: 'album',
  id: 'MPREb_7ltM34kr0mH',
  title: 'Discovery',
  author: { name: 'Daft Punk', channel_id: 'UCRr1x' },
  year: '2001',
  thumbnail: { contents: [{ url: 'https://x/big.jpg', width: 544 }, { url: 'https://x/small.jpg', width: 60 }] },
}

const artistItem = {
  item_type: 'artist',
  id: 'UCRr1xG_2WIDs18a6cIiCxeA',
  name: 'Daft Punk',
  subtitle: { text: 'Artist • 121M monthly audience' },
  thumbnail: { contents: [{ url: 'https://x/artist.jpg', width: 226 }] },
}

test('mapAlbumItem maps browseId, artist, year, largest thumb', () => {
  const { mapAlbumItem } = require('../youtube-search')
  const r = mapAlbumItem(albumItem)
  assert.strictEqual(r.browseId, 'MPREb_7ltM34kr0mH')
  assert.strictEqual(r.title, 'Discovery')
  assert.strictEqual(r.artist, 'Daft Punk')
  assert.strictEqual(r.year, '2001')
  assert.strictEqual(r.thumbnailUrl, 'https://x/big.jpg')
  assert.strictEqual(mapAlbumItem({}), null)
})

test('mapArtistItem maps channelId, name, subtitle', () => {
  const { mapArtistItem } = require('../youtube-search')
  const r = mapArtistItem(artistItem)
  assert.strictEqual(r.channelId, 'UCRr1xG_2WIDs18a6cIiCxeA')
  assert.strictEqual(r.name, 'Daft Punk')
  assert.strictEqual(r.subtitle, 'Artist • 121M monthly audience')
  assert.strictEqual(r.thumbnailUrl, 'https://x/artist.jpg')
  assert.strictEqual(mapArtistItem(null), null)
})

test('searchMusicFull returns songs, albums, artists', async () => {
  const { searchMusicFull } = require('../youtube-search')
  _setClientForTest(Promise.resolve({
    music: {
      search: async (q, opts) => {
        if (opts.type === 'song') return { songs: { contents: [songItem] } }
        if (opts.type === 'album') return { albums: { contents: [albumItem] } }
        if (opts.type === 'artist') return { artists: { contents: [artistItem] } }
        return {}
      },
    },
  }))
  const out = await searchMusicFull('daft punk')
  assert.strictEqual(out.songs[0].videoId, 'dQw4w9WgXcQ')
  assert.strictEqual(out.albums[0].browseId, 'MPREb_7ltM34kr0mH')
  assert.strictEqual(out.artists[0].channelId, 'UCRr1xG_2WIDs18a6cIiCxeA')
})

test('getAlbum maps header and tracks', async () => {
  const { getAlbum } = require('../youtube-search')
  _setClientForTest(Promise.resolve({
    music: {
      getAlbum: async () => ({
        header: {
          title: { text: 'Discovery' },
          subtitle: { text: 'Album • 2001' },
          strapline_text_one: { text: 'Daft Punk' },
          second_subtitle: { text: '14 songs • 1 hour, 1 minute' },
          thumbnail: { contents: [{ url: 'https://x/544.jpg', width: 544 }, { url: 'https://x/60.jpg', width: 60 }] },
        },
        contents: [
          { id: 'FGBhQbmPwH8', title: 'One More Time', duration: { text: '5:21', seconds: 321 }, index: { text: '1' } },
          { noId: true },
        ],
      }),
    },
  }))
  const r = await getAlbum('MPREb_x')
  assert.strictEqual(r.title, 'Discovery')
  assert.strictEqual(r.artist, 'Daft Punk')
  assert.strictEqual(r.year, '2001')
  assert.strictEqual(r.summary, '14 songs • 1 hour, 1 minute')
  assert.strictEqual(r.thumbnailUrl, 'https://x/544.jpg')
  assert.strictEqual(r.tracks.length, 1)
  assert.deepStrictEqual(r.tracks[0], { videoId: 'FGBhQbmPwH8', title: 'One More Time', duration: 321, index: 1 })
})

test('getArtist maps header, top songs, albums and singles carousels', async () => {
  const { getArtist } = require('../youtube-search')
  _setClientForTest(Promise.resolve({
    music: {
      getArtist: async () => ({
        header: { title: { text: 'Daft Punk' }, thumbnail: { contents: [{ url: 'https://x/1080.jpg', width: 1080 }] } },
        sections: [
          { title: { text: 'Top songs' }, contents: [{ id: 'Rgrt_8mXrK8', title: 'Get Lucky' }] },
          { header: { title: { text: 'Albums' } }, contents: [{ id: 'MPREb_a', title: 'RAM', year: '2013', thumbnail: [{ url: 'https://x/a.jpg', width: 226 }] }] },
          { header: { title: { text: 'Singles & EPs' } }, contents: [{ id: 'MPREb_s', title: 'Single X', year: '1997', thumbnail: [{ url: 'https://x/s.jpg', width: 226 }] }] },
        ],
      }),
    },
  }))
  const r = await getArtist('UCx')
  assert.strictEqual(r.name, 'Daft Punk')
  assert.strictEqual(r.thumbnailUrl, 'https://x/1080.jpg')
  assert.strictEqual(r.topSongs[0].videoId, 'Rgrt_8mXrK8')
  assert.strictEqual(r.topSongs[0].artist, 'Daft Punk')
  assert.strictEqual(r.albums[0].browseId, 'MPREb_a')
  assert.strictEqual(r.albums[0].year, '2013')
  assert.strictEqual(r.singles[0].browseId, 'MPREb_s')
})

// ── Playlist mapping + playlist search (Spotify-experience expansion) ───────

// Fixture shaped like a youtubei.js MusicResponsiveListItem (playlist)
const playlistItem = {
  id: 'VLPLabc123',
  title: 'Deep Focus',
  author: { name: 'YouTube Music' },
  song_count: '100 songs',
  thumbnail: { contents: [{ url: 'https://i.ytimg.com/pl.jpg', width: 226 }] },
}

test('mapPlaylistItem maps playlist search results', () => {
  const { mapPlaylistItem } = require('../youtube-search')
  const r = mapPlaylistItem(playlistItem)
  assert.strictEqual(r.playlistId, 'VLPLabc123')
  assert.strictEqual(r.title, 'Deep Focus')
  assert.strictEqual(r.author, 'YouTube Music')
  assert.strictEqual(r.songCount, '100 songs')
  assert.strictEqual(r.thumbnailUrl, 'https://i.ytimg.com/pl.jpg')
})

test('mapPlaylistItem returns null without id', () => {
  const { mapPlaylistItem } = require('../youtube-search')
  assert.strictEqual(mapPlaylistItem({ title: 'x' }), null)
})

test('mapMusicItem carries albumBrowseId and channelId when present', () => {
  const r = mapMusicItem({
    ...songItem,
    album: { id: 'MPREb_album1', name: 'Whenever You Need Somebody' },
    artists: [{ name: 'Rick Astley', channel_id: 'UCrick' }],
  })
  assert.strictEqual(r.albumBrowseId, 'MPREb_album1')
  assert.strictEqual(r.channelId, 'UCrick')
})

test('mapMusicItem albumBrowseId/channelId default to null', () => {
  const r = mapMusicItem(songItem)
  assert.strictEqual(r.albumBrowseId, null)
  assert.strictEqual(r.channelId, null)
})

test('searchMusicFull includes playlists section', async () => {
  const calls = []
  _setClientForTest(Promise.resolve({
    music: {
      search: async (q, opts) => {
        calls.push(opts.type)
        if (opts.type === 'playlist') return { playlists: { contents: [playlistItem] } }
        if (opts.type === 'song') return { songs: { contents: [songItem] } }
        return { contents: [] }
      },
    },
  }))
  const { searchMusicFull } = require('../youtube-search')
  const res = await searchMusicFull('focus')
  assert.ok(calls.includes('playlist'))
  assert.strictEqual(res.playlists.length, 1)
  assert.strictEqual(res.playlists[0].playlistId, 'VLPLabc123')
  _setClientForTest(null)
})

// ── Paged search with continuations ─────────────────────────────────────────

test('searchPage returns first page and continuation flag', async () => {
  const page2 = { contents: [{ ...songItem, id: 'second00001' }], has_continuation: false }
  const page1 = {
    songs: { contents: [songItem] },
    has_continuation: true,
    getContinuation: async () => page2,
  }
  _setClientForTest(Promise.resolve({ music: { search: async () => page1 } }))
  const { searchPage } = require('../youtube-search')

  const p1 = await searchPage('song', 'rick', false)
  assert.strictEqual(p1.items.length, 1)
  assert.strictEqual(p1.items[0].videoId, 'dQw4w9WgXcQ')
  assert.strictEqual(p1.hasMore, true)

  const p2 = await searchPage('song', 'rick', true)
  assert.strictEqual(p2.items[0].videoId, 'second00001')
  assert.strictEqual(p2.hasMore, false)
  _setClientForTest(null)
})

test('searchPage video kind uses main search', async () => {
  let usedMain = false
  _setClientForTest(Promise.resolve({
    search: async () => { usedMain = true; return { videos: [videoItem], has_continuation: false } },
    music: { search: async () => { throw new Error('wrong endpoint') } },
  }))
  const { searchPage } = require('../youtube-search')
  const p = await searchPage('video', 'boiler room', false)
  assert.ok(usedMain)
  assert.strictEqual(p.items.length, 1)
  assert.strictEqual(p.hasMore, false)
  _setClientForTest(null)
})

test('searchPage rejects unknown kind', async () => {
  const { searchPage } = require('../youtube-search')
  await assert.rejects(() => searchPage('podcast', 'x', false), /unknown kind/)
})

// ── Playlist page fetch ──────────────────────────────────────────────────────

test('getPlaylist maps header and tracks', async () => {
  _setClientForTest(Promise.resolve({
    music: {
      getPlaylist: async () => ({
        header: {
          title: 'Deep Focus',
          author: { name: 'YouTube Music' },
          thumbnail: { contents: [{ url: 'https://i.ytimg.com/pl.jpg', width: 544 }] },
        },
        items: [songItem, { no_id: true }],
      }),
    },
  }))
  const { getPlaylist } = require('../youtube-search')
  const pl = await getPlaylist('VLPLabc123')
  assert.strictEqual(pl.playlistId, 'VLPLabc123')
  assert.strictEqual(pl.title, 'Deep Focus')
  assert.strictEqual(pl.author, 'YouTube Music')
  assert.strictEqual(pl.songCount, 1)
  assert.strictEqual(pl.tracks.length, 1)
  assert.strictEqual(pl.tracks[0].videoId, 'dQw4w9WgXcQ')
  _setClientForTest(null)
})
