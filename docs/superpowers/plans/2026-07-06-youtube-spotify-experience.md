# YouTube Spotify-Experience Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Papa Audio's YouTube integration into a full Spotify-like experience: playlist search + filter tabs, See-all pages with pagination, YT playlist pages, local playlists that accept YT tracks, likes/follows/saved-albums for YT entities, and a YT Music home feed.

**Architecture:** Parallel YT stores merged at render time (spec: `docs/superpowers/specs/2026-07-06-youtube-spotify-experience-design.md`). New electron-store keys (`ytLikedTracks`, `ytFollowedArtists`, `ytSavedAlbums`, `ytRecentAlbums`) never touch `state.library` or the library cache. Backend additions live in `youtube-search.js`; IPC in `main.js`; UI in `src/renderer.js` + `src/styles.css`.

**Tech Stack:** Electron 28 (Node 18 — no import attributes), youtubei.js **pinned ~14.0.0**, electron-store, mpv (playback via ytdl hook), node:test.

## Global Constraints

- youtubei.js stays at `~14.0.0`. Do NOT bump.
- No Web Audio / AudioContext — playback stays in mpv. YT tracks play by putting `https://www.youtube.com/watch?v=<id>` in `filePath`.
- All new IPC handlers return `{ ok: true, ... }` or `{ ok: false, error }` exactly like existing `yt-*` handlers (main.js:2110-2135).
- YT track identity = watch URL in `filePath`; YT artist identity = `channelId`; YT album identity = `browseId`; YT playlist identity = `playlistId`.
- Renderer style: vanilla JS, template literals, `esc()` for all interpolated text, 2-space indent.
- Tests: `npm test` (runs `node --test 'test/**/*.test.js'`). Mapper tests must not hit the network — use `_setClientForTest`.
- Work on branch `feature/youtube-spotify-experience` off `main`.

---

### Task 0: Branch

- [ ] **Step 1: Create feature branch**

```bash
cd /home/shaharyar/flac-player
git checkout -b feature/youtube-spotify-experience
```

---

### Task 1: Backend — playlist mapper, playlist search, richer song mapper

**Files:**
- Modify: `youtube-search.js`
- Test: `test/youtube-search.test.js`

**Interfaces:**
- Produces: `mapPlaylistItem(item)` → `{ playlistId, title, author, songCount, thumbnailUrl }`
- Produces: `mapMusicItem(item)` gains `albumBrowseId: string|null` and `channelId: string|null`
- Produces: `searchMusicFull(query)` result gains `playlists: []` (max 8)

- [ ] **Step 1: Write failing tests**

Append to `test/youtube-search.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `mapPlaylistItem is not a function` / `albumBrowseId` undefined.

- [ ] **Step 3: Implement**

In `youtube-search.js`:

a) In `mapMusicItem`, add two fields before `thumbnailUrl`:

```js
    albumBrowseId: item.album?.id || null,
    channelId: (Array.isArray(item.artists) && item.artists[0]?.channel_id) || item.author?.channel_id || null,
```

b) Add after `mapArtistItem`:

```js
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
```

c) In `searchMusicFull`, add the 4th parallel search and section:

```js
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
```

d) Export `mapPlaylistItem` in `module.exports`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add youtube-search.js test/youtube-search.test.js
git commit -m "feat: playlist search + album/channel ids on song mapper"
```

---

### Task 2: Backend — paged search with continuations

**Files:**
- Modify: `youtube-search.js`
- Test: `test/youtube-search.test.js`

**Interfaces:**
- Produces: `searchPage(kind, query, next)` → `{ items: [], hasMore: boolean }`
  - `kind` ∈ `'song' | 'album' | 'artist' | 'playlist' | 'video'`
  - `next: false` = fresh page 1; `next: true` = continuation of the previous call with same kind+query.
  - Continuation objects are NOT serializable over IPC, so the module keeps a session map internally; the renderer only ever sends `{ kind, query, next }`.

- [ ] **Step 1: Write failing tests**

Append to `test/youtube-search.test.js`:

```js
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
```

- [ ] **Step 2: Run tests — expect FAIL** (`searchPage is not a function`)

- [ ] **Step 3: Implement**

Add to `youtube-search.js` (below `searchMusicFull`):

```js
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
```

Export `searchPage`.

- [ ] **Step 4: Run tests — expect PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat: paged YT search with continuation sessions"`

---

### Task 3: Backend — getPlaylist

**Files:**
- Modify: `youtube-search.js`
- Test: `test/youtube-search.test.js`

**Interfaces:**
- Produces: `getPlaylist(playlistId)` → `{ playlistId, title, author, songCount, thumbnailUrl, tracks: [<mapMusicItem shape>] }`

- [ ] **Step 1: Write failing test**

```js
test('getPlaylist maps header and tracks', async () => {
  _setClientForTest(Promise.resolve({
    music: {
      getPlaylist: async (id) => ({
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
```

- [ ] **Step 2: Run tests — expect FAIL**
- [ ] **Step 3: Implement** (below `getAlbum`):

```js
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
```

Export `getPlaylist`.

- [ ] **Step 4: Run tests — expect PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat: YT playlist fetch"`

---

### Task 4: Backend — getHomeFeed

**Files:**
- Modify: `youtube-search.js`
- Test: `test/youtube-search.test.js`

**Interfaces:**
- Produces: `getHomeFeed()` → `{ sections: [{ title, kind: 'songs'|'albums', items }] }` (max 3 sections; songs max 8, albums max 12). Album items are album-card shaped (`browseId`, …); song items are song shaped (`videoId`, …). Sections that don't map cleanly are skipped — this function must never throw on odd shapes.

- [ ] **Step 1: Write failing test**

```js
test('getHomeFeed maps song and album sections, skips junk', async () => {
  const albumFeedItem = {
    id: 'MPREb_feed1', title: 'OK Computer',
    author: { name: 'Radiohead' }, year: '1997',
    thumbnail: { contents: [{ url: 'https://i.ytimg.com/okc.jpg', width: 226 }] },
  }
  _setClientForTest(Promise.resolve({
    music: {
      getHomeFeed: async () => ({
        sections: [
          { header: { title: 'Quick picks' }, contents: [songItem] },
          { header: { title: 'Recommended albums' }, contents: [albumFeedItem] },
          { header: { title: 'Weird shelf' }, contents: [{}] },
          { contents: [songItem] }, // no title — skipped
        ],
      }),
    },
  }))
  const { getHomeFeed } = require('../youtube-search')
  const { sections } = await getHomeFeed()
  assert.strictEqual(sections.length, 2)
  assert.strictEqual(sections[0].title, 'Quick picks')
  assert.strictEqual(sections[0].kind, 'songs')
  assert.strictEqual(sections[0].items[0].videoId, 'dQw4w9WgXcQ')
  assert.strictEqual(sections[1].kind, 'albums')
  assert.strictEqual(sections[1].items[0].browseId, 'MPREb_feed1')
  _setClientForTest(null)
})
```

- [ ] **Step 2: Run tests — expect FAIL**
- [ ] **Step 3: Implement**:

```js
// Album ids on YT Music start with MPREb; watch ids are 11 chars.
function _looksLikeAlbumId(id) { return typeof id === 'string' && /^MPRE/i.test(id) }

async function getHomeFeed() {
  const yt = await _client()
  const feed = await yt.music.getHomeFeed()
  const sections = []
  for (const sec of (feed?.sections || [])) {
    if (sections.length >= 3) break
    const title = _text(sec?.header?.title) || _text(sec?.title)
    const contents = Array.isArray(sec?.contents) ? sec.contents : []
    if (!title || !contents.length) continue
    const albums = contents.filter(c => _looksLikeAlbumId(c?.id)).map(mapAlbumItem).filter(Boolean)
    const songs = contents.filter(c => c?.id && !_looksLikeAlbumId(c.id)).map(mapMusicItem).filter(Boolean)
    if (albums.length >= songs.length && albums.length) {
      sections.push({ title, kind: 'albums', items: albums.slice(0, 12) })
    } else if (songs.length) {
      sections.push({ title, kind: 'songs', items: songs.slice(0, 8) })
    }
  }
  return { sections }
}
```

Export `getHomeFeed`.

- [ ] **Step 4: Run tests — expect PASS**
- [ ] **Step 5: Commit** — `git commit -am "feat: YT Music home feed mapping"`

---

### Task 5: IPC handlers, YT store keys, preload API

**Files:**
- Modify: `main.js` (after the existing `yt-artist` handler, main.js:~2135, and after the playlists store block, main.js:~753)
- Modify: `preload.js` (yt block at :128)

**Interfaces:**
- Produces IPC: `yt-search-page {kind,query,next}` → `{ok,items,hasMore}`; `yt-playlist {playlistId}` → `{ok,playlist}`; `yt-home` → `{ok,sections}`
- Produces store IPC (mirrors existing liked/followed pattern): `get-yt-liked`/`save-yt-liked`, `get-yt-followed`/`save-yt-followed`, `get-yt-saved-albums`/`save-yt-saved-albums`, `get-yt-recent`/`save-yt-recent`
- Produces preload: `ytSearchPage(p)`, `ytPlaylist(p)`, `ytHome()`, `getYtLiked()`, `saveYtLiked(arr)`, `getYtFollowed()`, `saveYtFollowed(arr)`, `getYtSavedAlbums()`, `saveYtSavedAlbums(arr)`, `getYtRecent()`, `saveYtRecent(arr)`

- [ ] **Step 1: Add IPC handlers in main.js** (after `yt-artist` handler):

```js
ipcMain.handle('yt-search-page', async (_, { kind, query, next }) => {
  try {
    const { items, hasMore } = await ytSearch.searchPage(kind, query, !!next)
    return { ok: true, items, hasMore }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-playlist', async (_, { playlistId }) => {
  try { return { ok: true, playlist: await ytSearch.getPlaylist(playlistId) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-home', async () => {
  try { return { ok: true, ...(await ytSearch.getHomeFeed()) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})
```

- [ ] **Step 2: Add store handlers in main.js** (after the Playlists store block):

```js
// ── YouTube saves (parallel stores — never merged into the library cache) ────
ipcMain.handle('get-yt-liked', () => store.get('ytLikedTracks', []))
ipcMain.on('save-yt-liked', (_, arr) => store.set('ytLikedTracks', arr))
ipcMain.handle('get-yt-followed', () => store.get('ytFollowedArtists', []))
ipcMain.on('save-yt-followed', (_, arr) => store.set('ytFollowedArtists', arr))
ipcMain.handle('get-yt-saved-albums', () => store.get('ytSavedAlbums', []))
ipcMain.on('save-yt-saved-albums', (_, arr) => store.set('ytSavedAlbums', arr))
ipcMain.handle('get-yt-recent', () => store.get('ytRecentAlbums', []))
ipcMain.on('save-yt-recent', (_, arr) => store.set('ytRecentAlbums', arr))
```

- [ ] **Step 3: Add preload API** (in the yt block, preload.js:128):

```js
  ytSearchPage:       (p) => ipcRenderer.invoke('yt-search-page', p),
  ytPlaylist:         (p) => ipcRenderer.invoke('yt-playlist', p),
  ytHome:             ()  => ipcRenderer.invoke('yt-home'),
  getYtLiked:         ()  => ipcRenderer.invoke('get-yt-liked'),
  saveYtLiked:        (a) => ipcRenderer.send('save-yt-liked', a),
  getYtFollowed:      ()  => ipcRenderer.invoke('get-yt-followed'),
  saveYtFollowed:     (a) => ipcRenderer.send('save-yt-followed', a),
  getYtSavedAlbums:   ()  => ipcRenderer.invoke('get-yt-saved-albums'),
  saveYtSavedAlbums:  (a) => ipcRenderer.send('save-yt-saved-albums', a),
  getYtRecent:        ()  => ipcRenderer.invoke('get-yt-recent'),
  saveYtRecent:       (a) => ipcRenderer.send('save-yt-recent', a),
```

- [ ] **Step 4: Smoke test** — `npm test` still green; launch app (`npm start`), in DevTools console run `await window.api.ytHome()` and `await window.api.ytSearchPage({kind:'song',query:'radiohead',next:false})` — both return `{ok:true,...}` with items.

- [ ] **Step 5: Commit** — `git commit -am "feat: IPC + preload for YT paging, playlists, home feed, saves"`

---

### Task 6: Renderer — YT state, helpers, http-aware artImg

**Files:**
- Modify: `src/renderer.js`

**Interfaces:**
- Produces state: `state.ytLiked: []`, `state.ytFollowed: []`, `state.ytSavedAlbums: []`, `state.ytRecent: []`
- Produces helpers (used by every later task):
  - `watchUrl(videoId)` → string
  - `isYtLiked(videoId)` → bool; `toggleYtLike(track)` → bool (track = song-mapper shape)
  - `isYtFollowed(channelId)` → bool; `toggleYtFollow({channelId,name,thumbnailUrl})` → bool
  - `isYtAlbumSaved(browseId)` → bool; `toggleYtSaveAlbum(album)` → bool (album = full `getAlbum()` result)
  - `recordYtRecent(queueItem)` — dedup by `albumId`, cap 20, persist
- Modifies: `artImg()` renders `http(s)` art URLs directly (no `file://` prefix)

- [ ] **Step 1: State + load.** Add to the `state` object (near line 33): `ytLiked: [], ytFollowed: [], ytSavedAlbums: [], ytRecent: [],`. In the init `Promise.all` (line ~185), add the four fetches and assignments following the existing pattern:

```js
  // added to the Promise.all array:
  window.api.getYtLiked(), window.api.getYtFollowed(),
  window.api.getYtSavedAlbums(), window.api.getYtRecent(),
```
```js
  // added to the destructure + assignments:
  state.ytLiked       = ytLiked || []
  state.ytFollowed    = ytFollowed || []
  state.ytSavedAlbums = ytSavedAlbums || []
  state.ytRecent      = ytRecent || []
```

- [ ] **Step 2: Helpers.** Add near `_ytQueueItem` (line ~1125):

```js
function watchUrl(videoId) { return `https://www.youtube.com/watch?v=${videoId}` }
function isHttpPath(p) { return /^https?:\/\//.test(p || '') }

function isYtLiked(videoId) { return state.ytLiked.some(t => t.videoId === videoId) }
function toggleYtLike(track) {
  const i = state.ytLiked.findIndex(t => t.videoId === track.videoId)
  let liked
  if (i >= 0) { state.ytLiked.splice(i, 1); liked = false }
  else {
    state.ytLiked.unshift({
      videoId: track.videoId, title: track.title, artist: track.artist,
      album: track.album || null, duration: track.duration || 0,
      thumbnailUrl: track.thumbnailUrl || null,
      albumBrowseId: track.albumBrowseId || null, channelId: track.channelId || null,
      likedAt: Date.now(),
    })
    liked = true
  }
  window.api.saveYtLiked(state.ytLiked)
  return liked
}

function isYtFollowed(channelId) { return state.ytFollowed.some(a => a.channelId === channelId) }
function toggleYtFollow(artist) {
  const i = state.ytFollowed.findIndex(a => a.channelId === artist.channelId)
  let following
  if (i >= 0) { state.ytFollowed.splice(i, 1); following = false }
  else {
    state.ytFollowed.unshift({
      channelId: artist.channelId, name: artist.name,
      thumbnailUrl: artist.thumbnailUrl || null, followedAt: Date.now(),
    })
    following = true
  }
  window.api.saveYtFollowed(state.ytFollowed)
  return following
}

function isYtAlbumSaved(browseId) { return state.ytSavedAlbums.some(a => a.browseId === browseId) }
function toggleYtSaveAlbum(album) {
  const i = state.ytSavedAlbums.findIndex(a => a.browseId === album.browseId)
  let saved
  if (i >= 0) { state.ytSavedAlbums.splice(i, 1); saved = false }
  else { state.ytSavedAlbums.unshift({ ...album, savedAt: Date.now() }); saved = true }
  window.api.saveYtSavedAlbums(state.ytSavedAlbums)
  return saved
}

function recordYtRecent(qItem) {
  if (!qItem || !isHttpPath(qItem.filePath)) return
  state.ytRecent = [
    { albumId: qItem.albumId, name: qItem.albumName, artist: qItem.artist,
      artUrl: qItem.artPath, filePath: qItem.filePath, title: qItem.title, playedAt: Date.now() },
    ...state.ytRecent.filter(x => x.albumId !== qItem.albumId),
  ].slice(0, 20)
  window.api.saveYtRecent(state.ytRecent)
}
```

- [ ] **Step 3: artImg http support.** Replace the body of `artImg` (src/renderer.js, `function artImg`):

```js
function artImg(artPath, imgClass, fallbackClass) {
  const musicNote = `<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
  if (artPath) {
    const src = /^https?:\/\//.test(artPath) ? artPath : `file://${artPath}`
    return `<img class="${imgClass}" src="${src}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="${fallbackClass}" style="display:none">${musicNote}</div>`
  }
  return `<div class="${fallbackClass}">${musicNote}</div>`
}
```

- [ ] **Step 4: recordYtRecent hook.** In `playCurrentTrack()` (grep `function playCurrentTrack`), right after the current track is resolved from the queue (the first line reading `state.queue[state.queueIndex]`), add:

```js
  if (isHttpPath(track.filePath)) recordYtRecent(track)
```

(Use the local variable name the function already uses for the current track.)

- [ ] **Step 5: Verify.** `npm start`, DevTools: `toggleYtLike({videoId:'x',title:'t',artist:'a'})` → true, `isYtLiked('x')` → true, toggle again → false. Restart app; state persists across restart when left liked.

- [ ] **Step 6: Commit** — `git commit -am "feat: YT save stores, helpers, http-aware artwork"`

---

### Task 7: Renderer — search: Playlists tab/section, See-all buttons, like button, unified context menu

**Files:**
- Modify: `src/renderer.js` (renderSearch ~:909, `_ytSongRows` ~:1161, `renderYtResults` ~:1245, `bindYtEvents` ~:1310)

**Interfaces:**
- Consumes: `searchMusicFull` playlists section (Task 1), helpers (Task 6)
- Produces: `_ytPlaylistCard(p)`, `ytRowContextMenu(r)` (used by Tasks 8, 9, 12), updated `bindYtEvents(results, rootEl?)` and `_ytSongRows(songs)` with a like button. Navigation targets `yt-playlist` and `yt-see-all` (pages created in Tasks 8/9 — clicking before then is a no-op via the navigate fallthrough, acceptable mid-branch).

- [ ] **Step 1: Tabs.** In `renderSearch` change `const tabs = ['All', 'Songs', 'Albums', 'Artists']` to:

```js
  const tabs = ['All', 'Songs', 'Albums', 'Artists', 'Playlists']
```

In the tab-click handler inside `renderSearch`, update the yt-section visibility list from `['Songs', 'Albums', 'Artists']` to `['Songs', 'Albums', 'Artists', 'Playlists']`.

- [ ] **Step 2: Like button in `_ytSongRows`.** In the actions div, add the like button between the queue and download buttons:

```js
        <button class="yt-btn yt-like${isYtLiked(r.videoId) ? ' liked' : ''}" data-i="${i}" title="${isYtLiked(r.videoId) ? 'Unlike' : 'Like'}">${isYtLiked(r.videoId) ? '♥' : '♡'}</button>
```

- [ ] **Step 3: Playlist card + section.** Add next to `_ytAlbumCard`:

```js
function _ytPlaylistCard(p) {
  const hue = _cardHue((p.author || '') + (p.title || ''))
  return `<div class="album-card yt-playlist-card" data-playlist="${esc(p.playlistId)}">
    <div class="album-card-art-wrap">
      ${p.thumbnailUrl
        ? `<img class="album-card-art" src="${esc(p.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-card-art-fallback" ${p.thumbnailUrl ? 'style="display:none"' : `style="background:linear-gradient(135deg,hsl(${hue},55%,22%) 0%,hsl(${(hue+40)%360},45%,14%) 100%)"`}>
        <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
      </div>
      <span class="yt-badge yt-card-badge">YT</span>
    </div>
    <div class="album-card-name">${esc(p.title)}</div>
    <div class="album-card-meta">Playlist${p.author ? ' · ' + esc(p.author) : ''}${p.songCount ? ' · ' + esc(p.songCount) : ''}</div>
  </div>`
}
```

In `renderYtResults` (music scope), destructure `playlists = []` too, include it in the empty check, and add after the albums section:

```js
  if (playlists.length) {
    html += `<div class="yt-sub" data-sub="Playlists">
      <div class="yt-sub-header">Playlists <button class="yt-see-all" data-kind="playlist">See all</button></div>
      <div class="album-grid">${playlists.map(_ytPlaylistCard).join('')}</div>
    </div>`
  }
```

- [ ] **Step 4: See-all buttons.** Change the three existing sub-headers to include the button, e.g. songs:

```js
      <div class="yt-sub-header">Songs <button class="yt-see-all" data-kind="song">See all</button></div>
```

(albums → `data-kind="album"`, artists → `data-kind="artist"`.) For the "All of YouTube" flat list branch in `renderYtResults`, wrap with a header too:

```js
    box.innerHTML = `<div class="yt-sub" data-sub="Songs">
      <div class="yt-sub-header">Videos <button class="yt-see-all" data-kind="video">See all</button></div>
      ${_ytSongRows(results)}</div>`
```

In `_bindYtEntityEvents` (and after the flat-list branch renders), bind:

```js
  box.querySelectorAll('.yt-see-all').forEach(btn => btn.addEventListener('click', () => {
    navigate('yt-see-all', `${btn.dataset.kind}::${ytSearchState.lastQuery}`)
  }))
  box.querySelectorAll('.yt-playlist-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-playlist', card.dataset.playlist)
  }))
```

- [ ] **Step 5: Unified context menu.** Add near `bindYtEvents`:

```js
async function ytRowContextMenu(r) {
  const liked = isYtLiked(r.videoId)
  const items = [
    { label: 'Play now', action: 'play' },
    { label: 'Play next', action: 'playnext' },
    { label: 'Add to queue', action: 'queue' },
    { label: liked ? 'Unlike' : 'Like', action: 'like' },
    { label: 'Add to playlist…', action: 'addpl' },
  ]
  if (r.albumBrowseId) items.push({ label: 'Go to album', action: 'goalbum' })
  if (r.channelId) items.push({ label: 'Go to artist', action: 'goartist' })
  items.push({ label: 'Download', action: 'download' })
  const action = await window.api.ctxMenuShow(items)
  if (action === 'play') { state.queue = [_ytQueueItem(r)]; state.queueIndex = 0; playCurrentTrack() }
  else if (action === 'playnext') { state.queue.splice(state.queueIndex + 1, 0, _ytQueueItem(r)); updateNextPrefetch() }
  else if (action === 'queue') { state.queue.push(_ytQueueItem(r)); updateNextPrefetch() }
  else if (action === 'like') toggleYtLike(r)
  else if (action === 'addpl') showAddToPlaylistModal([_ytQueueItem(r)])
  else if (action === 'goalbum') navigate('yt-album', r.albumBrowseId)
  else if (action === 'goartist') navigate('yt-artist', r.channelId)
  else if (action === 'download') window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
  return action
}
```

- [ ] **Step 6: Generalize `bindYtEvents`.** Change signature to `function bindYtEvents(results, rootEl)` with `const box = rootEl || document.getElementById('yt-results')`. Replace the old inline contextmenu block with:

```js
  box.querySelectorAll('.yt-row').forEach(row => row.addEventListener('contextmenu', async e => {
    e.preventDefault()
    const r = results[parseInt(row.dataset.i)]
    const action = await ytRowContextMenu(r)
    if (action === 'like') renderLikeButtons(box, results)
  }))
```

Add the like-button handler inside `bindYtEvents` plus a tiny refresher:

```js
  box.querySelectorAll('.yt-like').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    const liked = toggleYtLike(r)
    btn.classList.toggle('liked', liked)
    btn.textContent = liked ? '♥' : '♡'
    btn.title = liked ? 'Unlike' : 'Like'
  }))
```

```js
function renderLikeButtons(box, results) {
  box.querySelectorAll('.yt-like').forEach(btn => {
    const r = results[parseInt(btn.dataset.i)]
    if (!r) return
    const liked = isYtLiked(r.videoId)
    btn.classList.toggle('liked', liked)
    btn.textContent = liked ? '♥' : '♡'
  })
}
```

Also make row click = play (Spotify behavior): in `bindYtEvents` add:

```js
  box.querySelectorAll('.yt-row').forEach(row => row.addEventListener('click', () => {
    const r = results[parseInt(row.dataset.i)]
    state.queue = [_ytQueueItem(r)]
    state.queueIndex = 0
    playCurrentTrack()
  }))
```

(The action buttons already `stopPropagation()`.)

- [ ] **Step 7: `_ytQueueItem` carries ids.** Extend `_ytQueueItem(r)` with `albumBrowseId: r.albumBrowseId || null, channelId: r.channelId || null, videoId: r.videoId,` so likes/menus work from queue items later.

- [ ] **Step 8: Verify manually.** `npm start` → search "radiohead": five tabs render, Playlists section shows cards, ♥ toggles and persists, right-click menu shows all entries, Play next inserts after current, See all buttons exist (navigation lands on blank page until Task 8 — OK).

- [ ] **Step 9: Commit** — `git commit -am "feat: search playlists section, like buttons, unified YT context menu"`

---

### Task 8: Renderer — yt-see-all page with Load more

**Files:**
- Modify: `src/renderer.js` (navigate dispatch ~:334-341, new function near renderYtAlbum)

**Interfaces:**
- Consumes: `window.api.ytSearchPage`, `_ytSongRows`, `bindYtEvents(results, rootEl)`, `_ytAlbumCard`, `_ytArtistCard`, `_ytPlaylistCard`
- Produces: page `yt-see-all` with navId `"<kind>::<query>"`

- [ ] **Step 1: Dispatch.** Add to the navigate chain (after the `yt-artist` line):

```js
  else if (page === 'yt-see-all')  renderYtSeeAll(navId)
  else if (page === 'yt-playlist') renderYtPlaylist(navId)
```

(`renderYtPlaylist` is Task 9; define a stub `function renderYtPlaylist() {}` in this task and replace it in Task 9 — or land Task 9 before manual testing of playlist cards.)

- [ ] **Step 2: Implement page.**

```js
const YT_KIND_LABEL = { song: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists', video: 'Videos' }

async function renderYtSeeAll(navId) {
  const sep = navId.indexOf('::')
  const kind = navId.slice(0, sep)
  const query = navId.slice(sep + 2)
  const items = []
  let hasMore = false

  setContent(`<div class="page">
    <div class="section-header"><span class="section-title">${YT_KIND_LABEL[kind] || 'Results'} · “${esc(query)}” <span class="yt-badge">YT</span></span></div>
    <div id="yt-seeall-body"><div class="yt-status">Loading…</div></div>
    <div id="yt-seeall-more"></div>
  </div>`)

  async function loadPage(next) {
    const res = await window.api.ytSearchPage({ kind, query, next }).catch(e => ({ ok: false, error: String(e) }))
    if (state.currentPage !== 'yt-see-all') return
    const body = document.getElementById('yt-seeall-body')
    const moreBox = document.getElementById('yt-seeall-more')
    if (!body) return
    if (!res.ok) {
      const note = `<div class="yt-status yt-error">Couldn't load${next ? ' more' : ''}: ${esc(res.error || 'unknown')} <button class="yt-retry" id="yt-seeall-retry">Retry</button></div>`
      if (next) { moreBox.innerHTML = note } else { body.innerHTML = note }
      document.getElementById('yt-seeall-retry')?.addEventListener('click', () => loadPage(next))
      return
    }
    items.push(...res.items)
    hasMore = res.hasMore
    renderBody()
  }

  function renderBody() {
    const body = document.getElementById('yt-seeall-body')
    const moreBox = document.getElementById('yt-seeall-more')
    if (!body) return
    if (!items.length) { body.innerHTML = `<div class="yt-status">Nothing found.</div>`; moreBox.innerHTML = ''; return }
    if (kind === 'song' || kind === 'video') {
      body.innerHTML = _ytSongRows(items)
      bindYtEvents(items, body)
    } else {
      const card = kind === 'album' ? _ytAlbumCard : kind === 'artist' ? _ytArtistCard : _ytPlaylistCard
      body.innerHTML = `<div class="${kind === 'artist' ? 'artist-grid yt-artist-grid' : 'album-grid'}">${items.map(card).join('')}</div>`
      body.querySelectorAll('.yt-album-card').forEach(c => c.addEventListener('click', () => navigate('yt-album', c.dataset.browse)))
      body.querySelectorAll('.yt-artist-card').forEach(c => c.addEventListener('click', () => navigate('yt-artist', c.dataset.channel)))
      body.querySelectorAll('.yt-playlist-card').forEach(c => c.addEventListener('click', () => navigate('yt-playlist', c.dataset.playlist)))
    }
    moreBox.innerHTML = hasMore ? `<button class="yt-load-more" id="yt-load-more">Load more</button>` : ''
    document.getElementById('yt-load-more')?.addEventListener('click', () => {
      document.getElementById('yt-load-more').textContent = 'Loading…'
      loadPage(true)
    })
  }

  await loadPage(false)
}
```

- [ ] **Step 3: Verify manually.** Search → See all on each section (Songs/Albums/Artists/Playlists, and Videos under All-of-YouTube scope). Load more appends and re-binds; row actions (play/queue/like/download/context) work on page 2+ items; back button returns to search.

- [ ] **Step 4: Commit** — `git commit -am "feat: YT see-all pages with pagination"`

---

### Task 9: Renderer — yt-playlist page

**Files:**
- Modify: `src/renderer.js` (replace Task 8's stub; place after `renderYtAlbum`)

**Interfaces:**
- Consumes: `window.api.ytPlaylist`, `_ytSongRows`, `bindYtEvents`, `showAddToPlaylistModal`, `_ytQueueItem`
- Produces: page `yt-playlist` (navId = playlistId); helper `_ytPlTrackToQueueItem(pl, t)`

- [ ] **Step 1: Implement.**

```js
function _ytPlTrackToQueueItem(pl, t) {
  return {
    filePath: watchUrl(t.videoId),
    videoId: t.videoId,
    title: t.title,
    artist: t.artist,
    albumArtist: t.artist,
    albumName: t.album || pl.title,
    albumId: `yt_${t.videoId}`,
    artPath: t.thumbnailUrl || pl.thumbnailUrl || null,
    duration: t.duration || 0,
    albumBrowseId: t.albumBrowseId || null,
    channelId: t.channelId || null,
  }
}

async function renderYtPlaylist(playlistId) {
  setContent(`<div class="page"><div class="yt-status">Loading playlist from YouTube…</div></div>`)
  const res = await window.api.ytPlaylist({ playlistId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-playlist') return
  if (!res.ok) {
    setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load playlist: ${esc(res.error || 'unknown error')}</div></div>`)
    return
  }
  const pl = res.playlist
  const colors = ['#5038a0','#a04038','#2d7a4a','#3850a0','#a07038','#6b38a0','#1a5a7a','#7a1a4a']
  const color = colors[Math.abs(_cardHue(pl.title + pl.author)) % colors.length]
  const totalDur = pl.tracks.reduce((s, t) => s + (t.duration || 0), 0)

  setContent(`
    <div class="album-hero" style="background: linear-gradient(${color}cc, var(--bg) 100%)">
      <img class="album-hero-art" src="${esc(pl.thumbnailUrl || '')}" alt="" ${!pl.thumbnailUrl ? 'style="display:none"' : ''} onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="album-hero-art-fallback" ${pl.thumbnailUrl ? 'style="display:none"' : ''}><svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Playlist <span class="yt-badge">YT</span></div>
        <div class="album-hero-title">${esc(pl.title)}</div>
        <div class="album-hero-meta">
          ${pl.author ? `<span>${esc(pl.author)}</span> &bull;` : ''}
          ${pl.tracks.length} song${pl.tracks.length !== 1 ? 's' : ''}${totalDur ? `, ${fmtTime(totalDur)}` : ''}
        </div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="yt-pl-play-btn" title="Play all" ${!pl.tracks.length ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn" id="yt-pl-shuffle-btn" title="Shuffle">
        <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
      </button>
      <button class="ctrl-btn" id="yt-pl-queue-btn" title="Add all to queue">+</button>
      <button class="ctrl-btn" id="yt-pl-dl-btn" title="Download all">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      </button>
      <button class="ctrl-btn" id="yt-pl-save-btn" title="Save to your playlists">
        <svg viewBox="0 0 24 24"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm18-4.5V22l-4-2-4 2V11.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5z"/></svg>
      </button>
      <span class="yt-album-dl-note" id="yt-pl-note"></span>
    </div>
    <div class="track-list">
      <div class="track-list-header"><span>#</span><span>Title</span><span style="text-align:right">Duration</span></div>
      <div id="yt-pl-tracks">${_ytSongRows(pl.tracks)}</div>
    </div>`)

  const toQueue = t => _ytPlTrackToQueueItem(pl, t)
  document.getElementById('yt-pl-play-btn')?.addEventListener('click', () => {
    state.queue = pl.tracks.map(toQueue); state.queueIndex = 0; playCurrentTrack()
  })
  document.getElementById('yt-pl-shuffle-btn')?.addEventListener('click', () => {
    state.queue = pl.tracks.map(toQueue).sort(() => Math.random() - 0.5)
    state.queueIndex = 0; playCurrentTrack()
  })
  document.getElementById('yt-pl-queue-btn')?.addEventListener('click', () => {
    state.queue.push(...pl.tracks.map(toQueue)); updateNextPrefetch()
    const note = document.getElementById('yt-pl-note')
    if (note) { note.textContent = `Added ${pl.tracks.length} to queue`; setTimeout(() => { note.textContent = '' }, 2000) }
  })
  document.getElementById('yt-pl-dl-btn')?.addEventListener('click', () => {
    for (const t of pl.tracks) window.api.ytDownload({ videoId: t.videoId, title: t.title, artist: t.artist, subdir: sanitizePathSegment(pl.title) })
    const note = document.getElementById('yt-pl-note')
    if (note) note.textContent = `Downloading ${pl.tracks.length} tracks…`
  })
  document.getElementById('yt-pl-save-btn')?.addEventListener('click', () => {
    const local = {
      id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: pl.title, tracks: pl.tracks.map(toQueue), createdAt: Date.now(),
    }
    state.playlists.unshift(local)
    window.api.savePlaylist(local)
    navigate('playlist', local.id)
  })
  const tracksEl = document.getElementById('yt-pl-tracks')
  if (tracksEl) bindYtEvents(pl.tracks, tracksEl)
}
```

If no `sanitizePathSegment` helper exists in renderer.js, add: `function sanitizePathSegment(s) { return String(s || '').replace(/[\/\\:*?"<>|]/g, '_').trim() }`

Note: `bindYtEvents` sets single-track play on row click; the hero Play-all covers whole-playlist playback. That matches the search-row behavior and keeps this task consistent — playlist "play from here" ordering is a nice-to-have, skip (YAGNI).

- [ ] **Step 2: Verify manually.** Open a playlist card from search → hero renders, Play all streams, Shuffle works, +queue adds N, Download all queues serialized downloads into a playlist-named subdir, Save creates a local playlist and navigates to it (rows show art + YT badge after Task 10).

- [ ] **Step 3: Commit** — `git commit -am "feat: YT playlist page with save-as-local-playlist"`

---

### Task 10: Renderer — local playlists accept YT tracks cleanly

**Files:**
- Modify: `src/renderer.js` (`renderPlaylist` ~:1789, `showAddToPlaylistModal` ~:2199, `_plCollage`)

**Interfaces:**
- Consumes: `isHttpPath` (Task 6)

- [ ] **Step 1: `showAddToPlaylistModal` slim mapping.** In the `slim` map, preserve YT identity fields — add to the object:

```js
    videoId: t.videoId || null, albumBrowseId: t.albumBrowseId || null, channelId: t.channelId || null,
```

- [ ] **Step 2: Playlist rows show YT badge + art.** In `renderPlaylist`'s `trackRows` template, after the title interpolation add:

```js
${isHttpPath(t.filePath) ? ' <span class="yt-badge">YT</span>' : ''}
```

If the playlist row renders art via `artImg(t.artPath, …)` it now works for http URLs (Task 6). If the row template prefixes `file://` manually anywhere, switch that spot to `artImg`.

- [ ] **Step 3: Recommendations skip YT rows.** In `renderPlaylist`, compute recs from local tracks only:

```js
  const localTracks = tracks.filter(t => !isHttpPath(t.filePath))
```

and use `localTracks` (instead of `tracks`) when building `plArtists` and `plGenres`. Keep `plPaths` built from ALL tracks so recs never duplicate a YT entry.

- [ ] **Step 4: `_plCollage` http art.** In `_plCollage` (grep it), wherever art src is built as `file://` + path, use the same pattern as `artImg`: `const src = isHttpPath(p) ? p : 'file://' + p`.

- [ ] **Step 5: Verify manually.** Right-click a YT search row → Add to playlist… → existing playlist. Open the playlist: row shows thumb + YT badge, plays via mpv, reorder/remove work, collage shows the thumbnail, recommendations still appear and contain no YT rows.

- [ ] **Step 6: Commit** — `git commit -am "feat: local playlists render and play YT tracks"`

---

### Task 11: Renderer — Liked Songs merge

**Files:**
- Modify: `src/renderer.js` (`renderLikedSongs`, grep `function renderLikedSongs`)

**Interfaces:**
- Consumes: `state.ytLiked`, `toggleYtLike`, `_ytQueueItem`, `ytRowContextMenu`

- [ ] **Step 1: Merge YT liked into the page.** In `renderLikedSongs`:

a) Count both in the hero: `const totalCount = tracks.length + state.ytLiked.length` — use `totalCount` in the meta line and for the empty-state check and play-button `disabled`.

b) After the local `trackRows`, build:

```js
  const ytRows = state.ytLiked.map((t, i) => `
    <div class="track-row yt-row yt-liked-row" data-i="${i}">
      ${t.thumbnailUrl
        ? `<img class="yt-thumb" src="${esc(t.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="yt-thumb yt-thumb-empty"></div>`}
      <div class="track-info">
        <div class="track-title">${esc(t.title)} <span class="yt-badge">YT</span></div>
        <div class="track-artist">${esc(t.artist)}</div>
      </div>
      <button class="track-like-btn liked" data-yt-unlike="${i}" title="Unlike">♥</button>
      <span class="track-dur">${t.duration ? fmtDur(t.duration) : ''}</span>
    </div>`).join('')
```

c) In `setContent`, after the local rows block append:

```js
      ${state.ytLiked.length ? `
        <div class="yt-sub-header" style="margin-top:20px">From YouTube</div>
        <div id="yt-liked-list">${ytRows}</div>` : ''}
```

d) Bind after setContent:

```js
  const ytList = document.getElementById('yt-liked-list')
  if (ytList) {
    ytList.querySelectorAll('.yt-liked-row').forEach(row => {
      row.addEventListener('click', () => {
        const i = parseInt(row.dataset.i)
        state.queue = state.ytLiked.slice(i).map(t => _ytQueueItem({ ...t, album: t.album }))
        state.queueIndex = 0
        playCurrentTrack()
      })
      row.addEventListener('contextmenu', async e => {
        e.preventDefault()
        const t = state.ytLiked[parseInt(row.dataset.i)]
        const action = await ytRowContextMenu(t)
        if (action === 'like') renderLikedSongs()
      })
    })
    ytList.querySelectorAll('[data-yt-unlike]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation()
      toggleYtLike(state.ytLiked[parseInt(btn.dataset.ytUnlike)])
      renderLikedSongs()
    }))
  }
```

e) The hero Play button should play local liked then YT liked: where the play handler builds its queue from local liked tracks, append `...state.ytLiked.map(t => _ytQueueItem(t))`.

- [ ] **Step 2: Verify manually.** Like 2 YT songs from search; open Liked Songs: count includes them, "From YouTube" section renders, click plays from that row onward, unlike removes instantly, hero play covers both groups.

- [ ] **Step 3: Commit** — `git commit -am "feat: liked songs page merges YT likes"`

---

### Task 12: Renderer — library merge (saved albums + followed artists), save/follow buttons, snapshot-fast album open

**Files:**
- Modify: `src/renderer.js` (`renderLibrary` grep `function renderLibrary`, `renderArtists` ~:565, `renderYtAlbum` ~:1370, `renderYtArtist` ~:1454)

**Interfaces:**
- Consumes: `state.ytSavedAlbums`, `state.ytFollowed`, toggles (Task 6)
- Produces: saved YT albums appear as pseudo-album cards `{ id: 'yt_<browseId>', isYt: true, artPath: thumbnailUrl, addedAt: savedAt }` **only inside renderLibrary's local array — never pushed into `state.library`**

- [ ] **Step 1: Save button on yt-album page.** In `renderYtAlbum`'s `album-controls` block add after the download button:

```js
      <button class="ctrl-btn yt-album-save-btn${isYtAlbumSaved(al.browseId) ? ' saved' : ''}" id="yt-album-save-btn" title="${isYtAlbumSaved(al.browseId) ? 'Remove from library' : 'Save to library'}">${isYtAlbumSaved(al.browseId) ? '♥' : '♡'}</button>
```

and bind after setContent:

```js
  document.getElementById('yt-album-save-btn')?.addEventListener('click', () => {
    const saved = toggleYtSaveAlbum(al)
    const b = document.getElementById('yt-album-save-btn')
    if (b) { b.classList.toggle('saved', saved); b.textContent = saved ? '♥' : '♡'; b.title = saved ? 'Remove from library' : 'Save to library' }
  })
```

- [ ] **Step 2: Snapshot-fast open + background refresh.** Restructure `renderYtAlbum(browseId)`: extract the whole "render from `al`" part into an inner `function paint(al)`. Then:

```js
async function renderYtAlbum(browseId) {
  const snap = state.ytSavedAlbums.find(a => a.browseId === browseId)
  if (snap) paint(snap)
  else setContent(`<div class="page"><div class="yt-status">Loading album from YouTube…</div></div>`)
  const res = await window.api.ytAlbum({ browseId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-album') return
  if (!res.ok) {
    if (!snap) setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load album: ${esc(res.error || 'unknown error')}</div></div>`)
    return  // stale snapshot beats an error page
  }
  if (!snap || JSON.stringify({ ...snap, savedAt: 0 }) !== JSON.stringify({ ...res.album, savedAt: 0 })) paint(res.album)
  function paint(al) { /* existing body from setContent(hero…) through all event binding */ }
}
```

- [ ] **Step 3: Library grid merges saved YT albums.** In `renderLibrary`, where the albums array is assembled from `state.library` (before sorting), build a merged copy:

```js
  const ytAlbums = state.ytSavedAlbums.map(a => ({
    id: `yt_${a.browseId}`, isYt: true, browseId: a.browseId,
    name: a.title, artist: a.artist, year: a.year || '',
    artPath: a.thumbnailUrl || null, addedAt: a.savedAt || 0,
    tracks: a.tracks || [], genre: null,
  }))
  albums = albums.concat(ytAlbums)
```

(Adapt the variable name to whatever `renderLibrary` sorts/filters — insert BEFORE the sort so `added`/alphabetical modes place them naturally; `state.libGenre` filtering will naturally exclude them since `genre` is null, acceptable.)

Then in the album-card click binding path (grep `data-album` click → `navigate('album'`), branch first:

```js
    const id = card.dataset.album
    if (id.startsWith('yt_')) { navigate('yt-album', id.slice(3)); return }
```

If `albumCard(a)` renders a hover play button using library lookups, guard: for `a.isYt` skip the play button (`data-play`) or make its handler queue `a.tracks.map(t => _ytPlTrackToQueueItem({ title: a.name, thumbnailUrl: a.artPath }, t))`. Simplest compliant choice: include the play button and handle `yt_` ids in the play handler with that queue mapping.

- [ ] **Step 4: Artists view + home Following merge.** In `renderArtists`, after the local artist cards, append YT followed:

```js
  const ytCards = state.ytFollowed.map(a => `
    <div class="artist-card yt-artist-card" data-channel="${esc(a.channelId)}">
      <div class="artist-card-art">
        ${a.thumbnailUrl ? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      </div>
      <div class="artist-card-name">${esc(a.name)}</div>
      <div class="artist-card-meta">Artist · YT</div>
    </div>`).join('')
```

Append `ytCards` into the grid HTML and bind `.yt-artist-card` clicks → `navigate('yt-artist', card.dataset.channel)`. Do the same merge in `renderHome`'s "Following" row (grep `followingHTML`): concatenate YT followed cards after the local name cards, same click binding.

- [ ] **Step 5: Follow button on yt-artist page.** In `renderYtArtist`, inside `.artist-hero` after the meta line add:

```js
      <button class="follow-btn${isYtFollowed(channelId) ? ' following' : ''}" id="yt-follow-btn">${isYtFollowed(channelId) ? 'Following' : 'Follow'}</button>
```

Bind:

```js
  document.getElementById('yt-follow-btn')?.addEventListener('click', () => {
    const now = toggleYtFollow({ channelId, name: ar.name, thumbnailUrl: ar.thumbnailUrl })
    const btn = document.getElementById('yt-follow-btn')
    if (btn) { btn.classList.toggle('following', now); btn.textContent = now ? 'Following' : 'Follow' }
  })
```

- [ ] **Step 6: Verify manually.** Save an album → appears in library grid with YT badge art, click reopens instantly (no "Loading…" flash), unsave removes. Follow an artist → shows in library Artists view and home Following; unfollow removes. Restart app: all persist.

- [ ] **Step 7: Commit** — `git commit -am "feat: YT saves merge into library, follow + save buttons, snapshot album open"`

---

### Task 13: Renderer — home feed + YT recently played

**Files:**
- Modify: `src/renderer.js` (`renderHome` ~:476)

**Interfaces:**
- Consumes: `window.api.ytHome`, `state.ytRecent`, `_ytSongRows`, `bindYtEvents`, `_ytAlbumCard`

- [ ] **Step 1: YT recently played in home rows.** In `renderHome`, merge YT recent into the Recently Played row: after `recentAlbums` is built, append YT cards:

```js
  const ytRecentCards = state.ytRecent.slice(0, 4).map(r => `
    <div class="album-card yt-recent-card" data-yturl="${esc(r.filePath)}" data-ytalbum="${esc(r.albumId)}">
      <div class="album-card-art-wrap">
        ${r.artUrl ? `<img class="album-card-art" src="${esc(r.artUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
        <span class="yt-badge yt-card-badge">YT</span>
      </div>
      <div class="album-card-name">${esc(r.title || r.name)}</div>
      <div class="album-card-meta">${esc(r.artist || '')}</div>
    </div>`).join('')
```

Append `ytRecentCards` inside the Recently Played `scroll-row` (after the local cards). Bind clicks: replay the track —

```js
  document.querySelectorAll('.yt-recent-card').forEach(card => card.addEventListener('click', () => {
    const r = state.ytRecent.find(x => x.albumId === card.dataset.ytalbum)
    if (!r) return
    state.queue = [{ filePath: r.filePath, title: r.title || r.name, artist: r.artist, albumArtist: r.artist, albumName: r.name, albumId: r.albumId, artPath: r.artUrl, duration: 0 }]
    state.queueIndex = 0
    playCurrentTrack()
  }))
```

- [ ] **Step 2: Home feed block.** At the end of `renderHome`'s `setContent` HTML (inside the page container), add `<div id="yt-home"></div>`. After the existing event bindings, call `loadYtHome()`:

```js
let _ytHomeCache = null
async function loadYtHome() {
  const mount = () => document.getElementById('yt-home')
  if (!mount()) return
  if (!_ytHomeCache) {
    const res = await window.api.ytHome().catch(() => ({ ok: false }))
    if (!res.ok || !res.sections?.length) return  // offline / failed → silently omit
    _ytHomeCache = res.sections
  }
  const el = mount()
  if (!el || state.currentPage !== 'home') return
  el.innerHTML = _ytHomeCache.map((sec, si) => `
    <div class="section-header" style="margin-top:28px">
      <span class="section-title">${esc(sec.title)} <span class="yt-badge">YT</span></span>
    </div>
    ${sec.kind === 'songs'
      ? `<div class="yt-home-songs" data-si="${si}">${_ytSongRows(sec.items)}</div>`
      : `<div class="scroll-row">${sec.items.map(_ytAlbumCard).join('')}</div>`}
  `).join('')
  el.querySelectorAll('.yt-home-songs').forEach(box => {
    bindYtEvents(_ytHomeCache[parseInt(box.dataset.si)].items, box)
  })
  el.querySelectorAll('.yt-album-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-album', card.dataset.browse)
  }))
}
```

- [ ] **Step 3: Verify manually.** Home shows up to 3 YT sections below local content after a beat; quick picks rows play/queue/like/download; album cards open yt-album. Play a YT track from anywhere → it appears in Recently Played on next home visit. Kill network → home renders with no YT block and no errors.

- [ ] **Step 4: Commit** — `git commit -am "feat: YT Music home feed and recently played merge"`

---

### Task 14: CSS

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add styles** (append; match existing custom-property names `--text`, `--text2`, `--text3` — there is NO `--text1`):

```css
/* ── YouTube Spotify-experience additions ─────────────────────────────── */
.yt-see-all {
  margin-left: auto; background: none; border: none; color: var(--text3);
  font-size: 12px; font-weight: 600; letter-spacing: .3px; cursor: pointer;
}
.yt-see-all:hover { color: var(--text); text-decoration: underline; }
.yt-sub-header { display: flex; align-items: center; }

.yt-btn.yt-like { font-size: 14px; }
.yt-btn.yt-like.liked { color: #1db954; }

.yt-load-more {
  display: block; margin: 18px auto; padding: 8px 22px; border-radius: 18px;
  border: 1px solid var(--text3); background: transparent; color: var(--text);
  font-weight: 600; cursor: pointer;
}
.yt-load-more:hover { border-color: var(--text); }
.yt-retry {
  margin-left: 8px; background: none; border: 1px solid var(--text3);
  border-radius: 12px; color: var(--text2); padding: 2px 10px; cursor: pointer;
}

.yt-album-save-btn.saved { color: #1db954; }
.yt-liked-row .yt-thumb { width: 36px; height: 36px; border-radius: 4px; margin-right: 10px; }
.yt-home-songs { max-width: 720px; }
```

- [ ] **Step 2: Visual pass.** Launch, eyeball search/see-all/playlist/liked/home for spacing regressions at the default window size.

- [ ] **Step 3: Commit** — `git commit -am "style: YT experience CSS"`

---

### Task 15: Full verification + merge

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including all pre-existing mpv/volume/yt tests.

- [ ] **Step 2: Manual QA — click inventory** (from the spec; verify each):

1. Search "radiohead" (Music scope): 5 tabs filter correctly; Top Result unaffected; Songs rows: click=play, ▶, +✓, ♥ persist, ⬇, right-click full menu incl. Play next / Add to playlist / Go to album / Go to artist.
2. See all on Songs/Albums/Artists/Playlists + Videos (All-of-YouTube): Load more appends, actions work on appended items.
3. Playlist card → yt-playlist page: Play all / Shuffle / +Queue all / Download all / Save-to-your-playlists.
4. Local playlist with mixed local+YT: plays through both, badge+art correct, reorder/remove fine, recs exclude YT.
5. Liked Songs: merged count, From YouTube section, unlike, hero play covers both.
6. yt-album: Save toggle; saved album in library grid; instant snapshot open; hover-play on the yt card plays the album.
7. yt-artist: Follow toggle; shows in library Artists + home Following.
8. Home: YT sections render; offline start renders home cleanly without them; YT recently-played card replays.
9. Agent regression: "play something by <artist not in library>" still streams via youtube_play.

- [ ] **Step 3: Merge**

```bash
git checkout main
git merge --no-ff feature/youtube-spotify-experience -m "Merge feature/youtube-spotify-experience: filters, see-all, playlists, saves, home feed"
```
