# YouTube Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search YouTube (Music-first) from Papa Audio's unified search page, stream results instantly through mpv, download them via yt-dlp in native format, and expose all of it to the AI agent.

**Architecture:** Two new main-process modules — `youtube-search.js` (wraps `youtubei.js` InnerTube client, pure mappers) and `youtube-download.js` (spawns `yt-dlp`, parses progress). IPC handlers in `main.js`, API surface in `preload.js`. Streaming needs no new audio path: mpv plays YouTube URLs via its built-in yt-dlp hook; renderer just stops prefixing `file://` for http(s) paths. UI is a new YouTube group in `renderSearch()` plus a YouTube section on the downloads page. Agent gets 3 new tools.

**Tech Stack:** Electron 28, Node built-in test runner (`node --test`), `youtubei.js` (new dep), `yt-dlp` (system binary, already installed), mpv 0.41.

**Spec:** `docs/superpowers/specs/2026-07-06-youtube-integration-design.md`

## Global Constraints

- Project root: `/home/shaharyar/flac-player/`
- **Never reintroduce Web Audio / AudioContext** — playback stays in mpv.
- Downloads keep **native codec** (`.opus`/`.m4a`) — no `--audio-format` transcode flag, ever.
- Download dir logic (same as `slsk-get-download-dir`, main.js:2063): `store.get('slskConfig', {}).downloadDir || store.get('musicFolders', [])[0] || path.join(app.getPath('home'), 'Music')`
- Tests: `node --test test/<file>.test.js` — style: `'use strict'`, `require('node:test')`, `require('node:assert')` (see `test/volume-map.test.js`).
- Main window variable in main.js is `mainWindow`; events sent as `mainWindow?.webContents.send(channel, data)`.
- Renderer play flow: `state.queue` (array of track objects), `state.queueIndex`, `playCurrentTrack()` (renderer.js:2359), `playNext()` (renderer.js:2505), prefetch via `updateNextPrefetch()` (renderer.js:2353).
- Track object shape: `{ id?, title, artist?, albumArtist, albumName, albumId, artPath, filePath, duration }`.
- `esc()` and `fmtDur()` helpers exist in renderer.js (:2960, :2963).
- After any download completes, call `_scheduleLibRescan()` (renderer.js:4424 — rescans at 15/45/120 s).
- Commit after every task. No `!!`-style shortcuts; follow existing code style (2-space indent, no semicolon-consistency changes — this codebase omits semicolons in renderer/main; match surrounding style).

---

### Task 1: `youtube-search.js` — search module with pure mappers

**Files:**
- Create: `youtube-search.js`
- Create: `test/youtube-search.test.js`
- Modify: `package.json` (dependency added by npm)

**Interfaces:**
- Produces: `searchMusic(query) -> Promise<Array<Result>>`, `searchAll(query) -> Promise<Array<Result>>`, `mapMusicItem(item) -> Result|null`, `mapVideoItem(item) -> Result|null`, `_setClientForTest(fakePromise)`.
- `Result = { videoId: string, title: string, artist: string, album: string|null, duration: number (seconds), thumbnailUrl: string|null, viewCount?: string|null }`

- [ ] **Step 1: Install youtubei.js**

```bash
cd /home/shaharyar/flac-player && npm install youtubei.js
```

Expected: `package.json` gains `"youtubei.js"` in dependencies, no errors.

- [ ] **Step 2: Write the failing test**

Create `test/youtube-search.test.js`:

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/shaharyar/flac-player && node --test test/youtube-search.test.js`
Expected: FAIL — `Cannot find module '../youtube-search'`

- [ ] **Step 4: Implement `youtube-search.js`**

```js
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
  return list[list.length - 1]?.url || list[0]?.url || null
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
```

Note: `youtubei.js` is ESM-only in recent versions — hence the `await import()` inside the async initializer. If `npm ls youtubei.js` shows a version < 10, plain `require` also works, but keep the dynamic import; it handles both.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/youtube-search.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Live smoke test (network)**

```bash
node -e "require('./youtube-search').searchMusic('daft punk around the world').then(r => console.log(r.slice(0,3)))"
```

Expected: 3 song objects with real videoIds, artists containing "Daft Punk", thumbnail URLs. If the shape assumptions in `searchMusic` are wrong for the installed youtubei.js version (empty array despite YouTube being reachable), inspect the actual response with `console.dir(res, { depth: 3 })` and fix the extraction path in `searchMusic`/`searchAll` — the mappers stay as-is, only the `raw` extraction line should change.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json youtube-search.js test/youtube-search.test.js
git commit -m "feat: YouTube search module via youtubei.js"
```

---

### Task 2: `youtube-download.js` — yt-dlp wrapper

**Files:**
- Create: `youtube-download.js`
- Create: `test/youtube-download.test.js`

**Interfaces:**
- Produces: `parseProgress(line) -> number|null` (percent), `sanitizeFilename(s) -> string`, `buildArgs({ videoId, base, outDir }) -> string[]`, `downloadAudio({ videoId, title, artist, outDir, onProgress, spawnFn }) -> Promise<{ ok, error? }>`
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `test/youtube-download.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { parseProgress, sanitizeFilename, buildArgs, downloadAudio } = require('../youtube-download')

test('parseProgress reads yt-dlp percent lines', () => {
  assert.strictEqual(parseProgress('[download]  42.3% of 3.52MiB at 1.2MiB/s ETA 00:02'), 42.3)
  assert.strictEqual(parseProgress('[download] 100% of 3.52MiB in 00:03'), 100)
  assert.strictEqual(parseProgress('[ExtractAudio] Destination: /x/y.opus'), null)
  assert.strictEqual(parseProgress(''), null)
})

test('sanitizeFilename strips path separators and control chars', () => {
  assert.strictEqual(sanitizeFilename('AC/DC: Back in Black'), 'AC_DC: Back in Black')
  assert.strictEqual(sanitizeFilename('a b\nc'), 'a bc')
  assert.strictEqual(sanitizeFilename('  spaced  '), 'spaced')
})

test('buildArgs keeps native codec (no --audio-format) and guards dash ids', () => {
  const args = buildArgs({ videoId: '-abc123', base: 'Artist - Title', outDir: '/dl' })
  assert.ok(args.includes('-x'))
  assert.ok(args.includes('bestaudio'))
  assert.ok(!args.includes('--audio-format'))
  assert.ok(args.includes('--embed-metadata'))
  assert.ok(args.includes('--embed-thumbnail'))
  assert.ok(args.includes('/dl/Artist - Title.%(ext)s'))
  // '--' must come right before the video id so a leading dash isn't a flag
  assert.strictEqual(args[args.length - 2], '--')
  assert.strictEqual(args[args.length - 1], '-abc123')
})

function fakeSpawn(exitCode, stdoutLines, stderrText) {
  return () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => {
      for (const l of stdoutLines) proc.stdout.emit('data', Buffer.from(l + '\n'))
      if (stderrText) proc.stderr.emit('data', Buffer.from(stderrText))
      proc.emit('close', exitCode)
    })
    return proc
  }
}

test('downloadAudio resolves ok and reports progress', async () => {
  const seen = []
  const r = await downloadAudio({
    videoId: 'x', title: 'T', artist: 'A', outDir: '/tmp',
    onProgress: p => seen.push(p),
    spawnFn: fakeSpawn(0, ['[download]  50.0% of 1MiB', '[download] 100% of 1MiB']),
  })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(seen, [50, 100])
})

test('downloadAudio reports failure with stderr tail', async () => {
  const r = await downloadAudio({
    videoId: 'x', title: 'T', artist: 'A', outDir: '/tmp',
    onProgress: () => {},
    spawnFn: fakeSpawn(1, [], 'ERROR: Video unavailable'),
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /Video unavailable/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/youtube-download.test.js`
Expected: FAIL — `Cannot find module '../youtube-download'`

- [ ] **Step 3: Implement `youtube-download.js`**

```js
'use strict'
// Downloads YouTube audio via yt-dlp in the NATIVE codec (.opus/.m4a).
// No transcode: -x without --audio-format only remuxes out of the container.
const { spawn } = require('child_process')
const path = require('path')

function parseProgress(line) {
  const m = /^\[download\]\s+([\d.]+)%/.exec(line.trim())
  return m ? parseFloat(m[1]) : null
}

function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[ -]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
}

function buildArgs({ videoId, base, outDir }) {
  return [
    '-f', 'bestaudio',
    '-x',
    '--embed-metadata',
    '--embed-thumbnail',
    '--no-playlist',
    '--newline',
    '-o', path.join(outDir, `${base}.%(ext)s`),
    '--', videoId,
  ]
}

function downloadAudio({ videoId, title, artist, outDir, onProgress, spawnFn = spawn }) {
  const base = sanitizeFilename(artist ? `${artist} - ${title}` : title) || videoId
  const args = buildArgs({ videoId, base, outDir })
  return new Promise(resolve => {
    let stderrTail = ''
    let proc
    try {
      proc = spawnFn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: `yt-dlp spawn failed: ${e.message}` })
      return
    }
    let buf = ''
    proc.stdout.on('data', d => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const pct = parseProgress(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (pct != null) onProgress(pct)
      }
    })
    proc.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-500) })
    proc.on('error', e => resolve({ ok: false, error: `yt-dlp error: ${e.message}` }))
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: stderrTail.trim() || `yt-dlp exited ${code}` })
    })
  })
}

module.exports = { parseProgress, sanitizeFilename, buildArgs, downloadAudio }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/youtube-download.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Live smoke test (network, writes a real file)**

```bash
node -e "require('./youtube-download').downloadAudio({ videoId: 'dQw4w9WgXcQ', title: 'smoke-test', artist: 'papa', outDir: '/tmp', onProgress: p => process.stdout.write(p + '% ') }).then(console.log)"
ls -la /tmp/papa\ -\ smoke-test.* && ffprobe -hide_banner /tmp/papa\ -\ smoke-test.* 2>&1 | grep -E 'Audio|title' ; rm -f /tmp/papa\ -\ smoke-test.*
```

Expected: progress prints climb to 100, `{ ok: true }`, file is `.opus` or `.m4a`, ffprobe shows an audio stream (opus/aac) and embedded title metadata.

- [ ] **Step 6: Commit**

```bash
git add youtube-download.js test/youtube-download.test.js
git commit -m "feat: YouTube download module via yt-dlp (native codec)"
```

---

### Task 3: IPC handlers + preload API

**Files:**
- Modify: `main.js` (requires at top ~line 1-30; handlers near the slsk block ~line 2085)
- Modify: `preload.js` (API object + allowed events list at :148-156)

**Interfaces:**
- Consumes: `searchMusic`/`searchAll` from `youtube-search.js` (Task 1), `downloadAudio` from `youtube-download.js` (Task 2).
- Produces IPC (renderer-facing, all used by Tasks 5-7):
  - `window.api.ytMusicSearch({ query })` → `{ ok, results?, error? }`
  - `window.api.ytSearch({ query })` → `{ ok, results?, error? }`
  - `window.api.ytDownload({ videoId, title, artist })` → `{ ok, id }` (returns immediately; progress via events)
  - `window.api.ytGetDownloads()` → `Array<{ id, videoId, title, artist, percent, state: 'downloading'|'completed'|'failed', error? }>`
  - Event `yt-dl-progress` → same download object on every change.

- [ ] **Step 1: Add requires and handlers to `main.js`**

Near the other module requires at the top of main.js:

```js
const ytSearch = require('./youtube-search')
const ytDownload = require('./youtube-download')
```

After the `slsk-show-in-folder` handler (end of the slsk block, ~line 2085):

```js
// ── YouTube ────────────────────────────────────────────────────────────────
function _downloadDir() {
  const cfg = store.get('slskConfig', {})
  const folders = store.get('musicFolders', [])
  return cfg.downloadDir || folders[0] || path.join(app.getPath('home'), 'Music')
}

ipcMain.handle('yt-music-search', async (_, { query }) => {
  try { return { ok: true, results: await ytSearch.searchMusic(query) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-search', async (_, { query }) => {
  try { return { ok: true, results: await ytSearch.searchAll(query) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

const _ytDownloads = new Map()

function _ytEmit(dl) {
  mainWindow?.webContents.send('yt-dl-progress', { ...dl })
}

ipcMain.handle('yt-download', (_, { videoId, title, artist }) => {
  const id = `yt_${videoId}_${Date.now()}`
  const dl = { id, videoId, title, artist, percent: 0, state: 'downloading', error: null }
  _ytDownloads.set(id, dl)
  _ytEmit(dl)
  ytDownload.downloadAudio({
    videoId, title, artist,
    outDir: _downloadDir(),
    onProgress: pct => {
      if (pct - dl.percent >= 1 || pct === 100) { dl.percent = pct; _ytEmit(dl) }
    },
  }).then(res => {
    dl.percent = res.ok ? 100 : dl.percent
    dl.state = res.ok ? 'completed' : 'failed'
    dl.error = res.ok ? null : res.error
    _ytEmit(dl)
  })
  return { ok: true, id }
})

ipcMain.handle('yt-get-downloads', () => [..._ytDownloads.values()])
```

Note: `_downloadDir` duplicates the expression inside the existing `slsk-get-download-dir` handler (main.js:2063). Refactor that handler to call `_downloadDir()` too, so the logic lives once.

- [ ] **Step 2: Expose in `preload.js`**

In the API object, after the Soulseek block:

```js
  // YouTube
  ytMusicSearch:  (p) => ipcRenderer.invoke('yt-music-search', p),
  ytSearch:       (p) => ipcRenderer.invoke('yt-search', p),
  ytDownload:     (p) => ipcRenderer.invoke('yt-download', p),
  ytGetDownloads: ()  => ipcRenderer.invoke('yt-get-downloads'),
```

In the `allowed` events array (preload.js:149-154), add `'yt-dl-progress'`:

```js
      'torrent-progress', 'torrent-done', 'torrent-started', 'do-lib-rescan',
      'yt-dl-progress',
```

- [ ] **Step 3: Verify the app boots and IPC works**

```bash
npm start
```

In the app's DevTools console:

```js
await window.api.ytMusicSearch({ query: 'daft punk' })
```

Expected: `{ ok: true, results: [...] }` with song objects. Quit the app.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat: YouTube search/download IPC handlers and preload API"
```

---

### Task 4: Streaming plumbing — mpv, shim, renderer play path

**Files:**
- Modify: `mpv-engine.js:50-63` (`_args`)
- Modify: `src/player-shim.js:52` (`_pathOf`)
- Modify: `src/renderer.js:2359-2400` (`playCurrentTrack`), `~2432` (`updateNowPlaying` art), listener block near `:3947`
- Test: `test/mpv-engine.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: any queue item whose `filePath` starts with `http` streams via mpv. Later tasks (5, 7) rely on exactly this: `{ filePath: 'https://www.youtube.com/watch?v=<id>', title, albumArtist, albumName, albumId: 'yt_<id>', artPath: <thumbnail url or null>, duration }`.

- [ ] **Step 1: Write the failing test for mpv args**

Append to `test/mpv-engine.test.js`:

```js
test('args enable audio-only ytdl format for URL streaming', () => {
  const args = new MpvEngine({})._args('/tmp/x.sock')
  assert.ok(args.includes('--ytdl-format=bestaudio'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mpv-engine.test.js`
Expected: FAIL on the new test only.

- [ ] **Step 3: Add the mpv arg**

In `mpv-engine.js` `_args()`, add to the base array after `'--volume-max=130',`:

```js
      '--ytdl-format=bestaudio',
```

(mpv's ytdl hook is enabled by default for URL inputs; this only pins it to audio-only so it never pulls video streams.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mpv-engine.test.js`
Expected: PASS (all, including the new one).

- [ ] **Step 5: URL passthrough in the shim**

In `src/player-shim.js`, replace `_pathOf`:

```js
  _pathOf(src) {
    const s = String(src)
    if (/^https?:\/\//.test(s)) return s
    return decodeURI(s.replace(/^file:\/\//, ''))
  }
```

- [ ] **Step 6: URL-aware `playCurrentTrack` and now-playing art**

In `src/renderer.js` `playCurrentTrack()` (:2359), replace these two lines:

```js
  audio.src = `file://${track.filePath}`
```
with
```js
  const isStream = /^https?:\/\//.test(track.filePath)
  audio.src = isStream ? track.filePath : `file://${track.filePath}`
```
and
```js
    extractAlbumColor(track.artPath || null)
```
with
```js
    extractAlbumColor(/^https?:\/\//.test(track.artPath || '') ? null : (track.artPath || null))
```

In `updateNowPlaying()` (~:2432), the art element builds `const newSrc = \`file://${track.artPath}\``. Replace with:

```js
      const newSrc = /^https?:\/\//.test(track.artPath) ? track.artPath : `file://${track.artPath}`
```

Also check `fetchLyrics`/`notifyTrack`/`savePlaybackState` calls in `playCurrentTrack` — they only pass strings through; no changes needed.

- [ ] **Step 7: Stream-failure auto-advance**

Near the other `audio.addEventListener(...)` calls (renderer.js ~:3947), add:

```js
  audio.addEventListener('error', () => {
    const t = state.queue[state.queueIndex]
    if (!t || !/^https?:\/\//.test(t.filePath)) return
    const titleEl = document.getElementById('np-title')
    if (titleEl) {
      const orig = titleEl.textContent
      titleEl.textContent = 'Stream unavailable — skipping'
      setTimeout(() => { titleEl.textContent = orig }, 2500)
    }
    if (state.queue.length > 1) playNext()
  })
```

(The shim dispatches `'error'` when mpv reports `end-file` with reason `error` — mpv-engine.js:179, player-shim.js:45-47. Local-file failures keep their existing "File not available" path in the `play().catch()`.)

- [ ] **Step 8: Manual streaming test**

```bash
npm start
```

DevTools console:

```js
state.queue = [{ filePath: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'YT stream test', albumArtist: 'Rick Astley', albumName: 'YouTube', albumId: 'yt_test', artPath: null, duration: 213 }]
state.queueIndex = 0; playCurrentTrack()
```

Expected: audio starts within ~2-4 s, seek bar works, pause/play works. Then test failure: repeat with `filePath: 'https://www.youtube.com/watch?v=00000000000'` and a second local track in the queue — expect "Stream unavailable — skipping" and advance.

- [ ] **Step 9: Commit**

```bash
git add mpv-engine.js src/player-shim.js src/renderer.js test/mpv-engine.test.js
git commit -m "feat: stream http(s) URLs through mpv ytdl hook"
```

---

### Task 5: Unified search UI — YouTube group

**Files:**
- Modify: `src/renderer.js` — `renderSearch()` (:906-1077) + new functions `runYtSearch`, `renderYtResults`, `bindYtEvents`, `_ytQueueItem` placed right after `renderSearch`
- Modify: `src/styles.css` — append `.yt-*` styles at end of file

**Interfaces:**
- Consumes: `window.api.ytMusicSearch`, `window.api.ytSearch` (Task 3); URL streaming queue items (Task 4); existing `esc`, `fmtDur`, `playCurrentTrack`, `updateNextPrefetch`, `renderQueuePanel`, `_scheduleLibRescan`, `window.api.ctxMenuShow`.
- Produces: `_ytQueueItem(r) -> track object` — also used by agent tools in Task 7. Module-level state: `const ytSearchState = { scope: 'music', cache: new Map(), lastQuery: null }`.

- [ ] **Step 1: Insert the YouTube section into `renderSearch`**

In `renderSearch()` immediately BEFORE the `// Online quality search section` comment (renderer.js:1024), add:

```js
  // YouTube section (async — filled by runYtSearch)
  html += `<div class="search-section" data-section="YouTube" id="yt-section">
    <div class="section-header">
      <span class="section-title">YouTube</span>
      <div class="yt-scope-tabs">
        <button class="yt-scope${ytSearchState.scope === 'music' ? ' active' : ''}" data-scope="music">Music</button>
        <button class="yt-scope${ytSearchState.scope === 'all' ? ' active' : ''}" data-scope="all">All of YouTube</button>
      </div>
    </div>
    <div id="yt-results"><div class="yt-status">Searching YouTube…</div></div>
  </div>`
```

And at the END of `renderSearch` (after `bindSlskSearchEvents(query)` wiring, before the closing `}`), add:

```js
  runYtSearch(query, ytSearchState.scope)
```

- [ ] **Step 2: Add the YouTube search/render functions**

After `renderSearch`'s closing brace (renderer.js ~:1078), add:

```js
// ── YouTube search section ──────────────────────────────────────────────────
const ytSearchState = { scope: 'music', cache: new Map(), lastQuery: null }

function _ytQueueItem(r) {
  return {
    filePath: `https://www.youtube.com/watch?v=${r.videoId}`,
    title: r.title,
    artist: r.artist,
    albumArtist: r.artist,
    albumName: r.album || 'YouTube',
    albumId: `yt_${r.videoId}`,
    artPath: r.thumbnailUrl || null,
    duration: r.duration || 0,
  }
}

async function runYtSearch(query, scope) {
  ytSearchState.scope = scope
  ytSearchState.lastQuery = query
  const box = document.getElementById('yt-results')
  if (!box) return
  const cacheKey = `${scope}::${query}`
  if (ytSearchState.cache.has(cacheKey)) {
    renderYtResults(ytSearchState.cache.get(cacheKey), query)
    return
  }
  box.innerHTML = `<div class="yt-status">Searching YouTube…</div>`
  const call = scope === 'music' ? window.api.ytMusicSearch : window.api.ytSearch
  const res = await call({ query }).catch(e => ({ ok: false, error: String(e) }))
  // Stale response guard — user typed a new query or switched scope meanwhile
  if (ytSearchState.lastQuery !== query || ytSearchState.scope !== scope) return
  if (!res.ok) {
    const cur = document.getElementById('yt-results')
    if (cur) cur.innerHTML = `<div class="yt-status yt-error">YouTube search failed: ${esc(res.error || 'unknown error')}</div>`
    return
  }
  ytSearchState.cache.set(cacheKey, res.results)
  renderYtResults(res.results, query)
}

function renderYtResults(results, query) {
  const box = document.getElementById('yt-results')
  if (!box) return
  if (!results.length) {
    box.innerHTML = `<div class="yt-status">Nothing on YouTube for "${esc(query)}"</div>`
    return
  }
  box.innerHTML = `<div class="yt-list">${results.map((r, i) => `
    <div class="yt-row" data-i="${i}">
      ${r.thumbnailUrl
        ? `<img class="yt-thumb" src="${esc(r.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="yt-thumb yt-thumb-empty"></div>`}
      <div class="yt-info">
        <div class="yt-title">${esc(r.title)} <span class="yt-badge">YT</span></div>
        <div class="yt-sub">${esc(r.artist)}${r.album ? ' · ' + esc(r.album) : ''}${r.viewCount ? ' · ' + esc(r.viewCount) : ''}</div>
      </div>
      <span class="yt-dur">${r.duration ? fmtDur(r.duration) : ''}</span>
      <div class="yt-actions">
        <button class="yt-btn yt-play" data-i="${i}" title="Stream now">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="yt-btn yt-queue" data-i="${i}" title="Add to queue">+</button>
        <button class="yt-btn yt-dl" data-i="${i}" title="Download">
          <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
      </div>
    </div>`).join('')}</div>`
  bindYtEvents(results)
}

function bindYtEvents(results) {
  const box = document.getElementById('yt-results')
  if (!box) return
  box.querySelectorAll('.yt-play').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    state.queue = [_ytQueueItem(r)]
    state.queueIndex = 0
    playCurrentTrack()
  }))
  box.querySelectorAll('.yt-queue').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    state.queue.push(_ytQueueItem(r))
    updateNextPrefetch()
    if (state.queuePanelOpen) renderQueuePanel()
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = '+' }, 1200)
  }))
  box.querySelectorAll('.yt-dl').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    btn.disabled = true
    btn.innerHTML = '…'
    await window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
  }))
  box.querySelectorAll('.yt-row').forEach(row => row.addEventListener('contextmenu', async e => {
    e.preventDefault()
    const r = results[parseInt(row.dataset.i)]
    const action = await window.api.ctxMenuShow([
      { id: 'play', label: 'Play now' },
      { id: 'queue', label: 'Add to queue' },
      { id: 'download', label: 'Download' },
    ])
    if (action === 'play') { state.queue = [_ytQueueItem(r)]; state.queueIndex = 0; playCurrentTrack() }
    else if (action === 'queue') { state.queue.push(_ytQueueItem(r)); updateNextPrefetch() }
    else if (action === 'download') window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
  }))
}
```

Then wire the scope tabs — inside `renderSearch`, next to the existing search-tab wiring (renderer.js ~:1048), add:

```js
  document.querySelectorAll('.yt-scope').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.yt-scope').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      runYtSearch(query, tab.dataset.scope)
    })
  })
```

**Check `ctxMenuShow`'s item format before using it** — read the `ctx-menu-show` handler in main.js and one existing call site in renderer.js; if items use a different shape (e.g. `{ label, action }` or plain strings), match that shape.

- [ ] **Step 3: Add styles**

Append to `src/styles.css`:

```css
/* ── YouTube search section ── */
.yt-scope-tabs { display: flex; gap: 6px; margin-left: auto; }
.yt-scope {
  background: rgba(255,255,255,.07); border: none; color: var(--text2);
  padding: 4px 12px; border-radius: 14px; font-size: 12px; cursor: pointer;
}
.yt-scope.active { background: #fff; color: #000; font-weight: 600; }
.yt-status { color: var(--text3); font-size: 13px; padding: 12px 0; }
.yt-error { color: #e05c5c; }
.yt-list { display: flex; flex-direction: column; }
.yt-row {
  display: flex; align-items: center; gap: 12px; padding: 6px 8px;
  border-radius: 6px;
}
.yt-row:hover { background: rgba(255,255,255,.06); }
.yt-thumb { width: 44px; height: 44px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.yt-thumb-empty { background: rgba(255,255,255,.08); }
.yt-info { flex: 1; min-width: 0; }
.yt-title { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yt-badge {
  background: #f00; color: #fff; font-size: 9px; font-weight: 700;
  padding: 1px 4px; border-radius: 3px; vertical-align: 2px;
}
.yt-sub { font-size: 12px; color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yt-dur { font-size: 12px; color: var(--text3); }
.yt-actions { display: flex; gap: 6px; }
.yt-btn {
  background: rgba(255,255,255,.09); border: none; color: var(--text1);
  width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
  display: flex; align-items: center; justify-content: center; opacity: .85;
}
.yt-btn svg { width: 14px; height: 14px; fill: currentColor; }
.yt-btn:hover { background: rgba(255,255,255,.18); }
.yt-btn:disabled { opacity: .4; cursor: default; }
```

(Buttons always visible at `opacity: .85` — house rule, CLAUDE.md #5. `var(--text1/2/3)` — verify these variable names exist in styles.css `:root`; if the project uses different names like `--text` / `--muted`, use those.)

- [ ] **Step 4: Manual test**

```bash
npm start
```

Search for something in your library AND something not in it. Expected:
- YouTube group appears below local results with Music/All tabs
- Music tab: clean song rows with art, artist, album, duration
- "All of YouTube" tab: videos, channels as artist, view counts
- Play button streams instantly; + queues; download button fires yt-dlp (check `/mnt/data/MUSIC/Downloads/` afterwards)
- Right-click shows native context menu with the 3 actions
- Kill your network → YouTube group shows error text, library results unaffected

- [ ] **Step 5: Commit**

```bash
git add src/renderer.js src/styles.css
git commit -m "feat: unified search with YouTube group (music + full-YT tabs)"
```

---

### Task 6: Downloads page — YouTube section + rescan wiring

**Files:**
- Modify: `src/renderer.js` — global event wiring near the other `window.api.on(...)` startup listeners (search for `window.api.on('do-lib-rescan'` ~:6814); `renderDownloads()` (:5443)

**Interfaces:**
- Consumes: `yt-dl-progress` event + `ytGetDownloads()` (Task 3), `_scheduleLibRescan()` (:4424), `notifyDownloadComplete` (preload :65).
- Produces: `state.ytDownloads` — a `Map<id, dl>` on the renderer `state` object, kept live app-wide.

- [ ] **Step 1: Global progress listener**

Where `state` is initialized, add `ytDownloads: new Map(),` to the state object literal.

Next to the existing `window.api.on('do-lib-rescan', ...)` wiring (~:6814), add:

```js
  window.api.on('yt-dl-progress', dl => {
    const prev = state.ytDownloads.get(dl.id)
    state.ytDownloads.set(dl.id, dl)
    if (dl.state === 'completed' && prev?.state !== 'completed') {
      _scheduleLibRescan()
      window.api.notifyDownloadComplete({ title: dl.title, artist: dl.artist })
    }
    const box = document.getElementById('yt-dl-list')
    if (box) _renderYtDownloadRows(box)
  })
```

**Check `notifyDownloadComplete`'s expected payload** — find where `notify-download-complete` is handled in main.js and match its field names; adjust `{ title, artist }` if it expects something else.

- [ ] **Step 2: Section on the downloads page**

In `renderDownloads()` (:5443), the page sets HTML via `setContent(...)`. Right after the `dl2-tabs` div in that template, insert a static container:

```html
    <div id="yt-dl-section" style="display:none">
      <div class="section-header" style="margin:16px 0 8px"><span class="section-title">YouTube</span></div>
      <div id="yt-dl-list"></div>
    </div>
```

Then after `setContent(...)` in `renderDownloads`, add:

```js
  const ytBox = document.getElementById('yt-dl-list')
  if (ytBox) _renderYtDownloadRows(ytBox)
```

And add the row renderer near `renderDownloads`:

```js
function _renderYtDownloadRows(box) {
  const items = [...state.ytDownloads.values()].reverse()
  const section = document.getElementById('yt-dl-section')
  if (section) section.style.display = items.length ? '' : 'none'
  box.innerHTML = items.map(d => `
    <div class="yt-row">
      <div class="yt-info">
        <div class="yt-title">${esc(d.title)} <span class="yt-badge">YT</span></div>
        <div class="yt-sub">${esc(d.artist || '')}</div>
      </div>
      ${d.state === 'downloading'
        ? `<div class="yt-dl-bar"><div class="yt-dl-fill" style="width:${d.percent}%"></div></div><span class="yt-dur">${Math.round(d.percent)}%</span>`
        : d.state === 'completed'
          ? `<span class="yt-dl-done">✓ Done</span>`
          : `<span class="yt-error" title="${esc(d.error || '')}">✗ Failed</span>`}
    </div>`).join('')
}
```

Styles (append to `src/styles.css`):

```css
.yt-dl-bar { width: 140px; height: 4px; background: rgba(255,255,255,.12); border-radius: 2px; overflow: hidden; }
.yt-dl-fill { height: 100%; background: #1db954; transition: width .3s; }
.yt-dl-done { color: #1db954; font-size: 12px; }
```

On app start (where other startup fetches happen), hydrate past downloads from main:

```js
  window.api.ytGetDownloads().then(list => { for (const d of list) state.ytDownloads.set(d.id, d) }).catch(() => {})
```

- [ ] **Step 3: Manual test**

```bash
npm start
```

Download a track from the YouTube search section, open Downloads page. Expected: YouTube section appears with a live progress bar → "✓ Done"; the file lands in the download dir; library rescan picks it up within ~2 min (or click rescan). Force a failure (disconnect network mid-download) → "✗ Failed" with error tooltip.

- [ ] **Step 4: Commit**

```bash
git add src/renderer.js src/styles.css
git commit -m "feat: YouTube downloads on downloads page with live progress"
```

---

### Task 7: Agent tools

**Files:**
- Modify: `main.js` — `AGENT_TOOLS` array (:1431, append at end), `_buildAgentSystem()` (:1310)
- Modify: `src/renderer.js` — `_executeTool` switch (:3124)

**Interfaces:**
- Consumes: `window.api.ytMusicSearch` / `ytSearch` / `ytDownload` (Task 3), `_ytQueueItem` + streaming queue items (Tasks 4-5), `playCurrentTrack`.
- Produces: agent tools `youtube_search`, `youtube_play`, `youtube_download` (21 tools total).

- [ ] **Step 1: Tool definitions in `AGENT_TOOLS`**

Append to the `AGENT_TOOLS` array in main.js:

```js
  {
    name: 'youtube_search',
    description: 'Search YouTube for music. Returns top matches with videoId, title, artist, duration. scope "music" searches the YouTube Music catalog (clean song results); scope "all" searches all of YouTube (live sets, bootlegs, mixes). Pass ONLY the artist/song/album name as query.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Artist, song, or album name ONLY' }, scope: { type: 'string', enum: ['music', 'all'], description: 'Default "music"' } }, required: ['query'] },
  },
  {
    name: 'youtube_play',
    description: 'Search YouTube Music and instantly STREAM the best match — nothing is saved to disk. Use when a track is not in the local library and the user wants to hear it NOW. Pass ONLY the artist/song name.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Song and/or artist name ONLY' } }, required: ['query'] },
  },
  {
    name: 'youtube_download',
    description: 'Search YouTube Music and download the best match as an audio file into the music library (native quality, ~256kbps lossy). Prefer auto_download (Soulseek, lossless) for keeps; use this when Soulseek has nothing or the user explicitly asks for YouTube.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Song and/or artist name ONLY' } }, required: ['query'] },
  },
```

- [ ] **Step 2: System prompt update in `_buildAgentSystem`**

In the `## Full capabilities` block, add after the DOWNLOADS line:

```
YOUTUBE: youtube_search (find on YouTube), youtube_play (stream instantly, nothing saved), youtube_download (save lossy audio file)
```

In `## Decision rules`, replace the line:

```
- "play X" → ALWAYS try play_from_library first. Pass ONLY the artist name, album name, or song title as the query — never pass the full user sentence. Example: user says "play some pink floyd songs" → query: "pink floyd". Only use auto_download if play_from_library explicitly returns "not found".
```

with:

```
- "play X" → ALWAYS try play_from_library first. Pass ONLY the artist name, album name, or song title as the query — never pass the full user sentence. Example: user says "play some pink floyd songs" → query: "pink floyd". If play_from_library returns "not found", use youtube_play to stream it instantly, then auto_download in the background if the user wants to keep it.
- Fallback order for playing music: 1) local library, 2) youtube_play (instant stream), 3) auto_download from Soulseek (lossless, for keeps).
- "download X" → auto_download first (lossless). If Soulseek finds nothing, youtube_download as last resort.
```

- [ ] **Step 3: Tool execution in renderer `_executeTool`**

Add cases to the switch (renderer.js :3124, alongside the existing cases):

```js
    case 'youtube_search': {
      const scope = input.scope === 'all' ? 'all' : 'music'
      const call = scope === 'all' ? window.api.ytSearch : window.api.ytMusicSearch
      const res = await call({ query: input.query })
      if (!res.ok) return `YouTube search failed: ${res.error}`
      if (!res.results.length) return `Nothing found on YouTube for "${input.query}"`
      return 'Top YouTube results:\n' + res.results.slice(0, 5).map((r, i) =>
        `${i + 1}. ${r.title} — ${r.artist} (${r.duration ? fmtDur(r.duration) : '?'}) [videoId: ${r.videoId}]`).join('\n')
    }

    case 'youtube_play': {
      const res = await window.api.ytMusicSearch({ query: input.query })
      if (!res.ok) return `YouTube search failed: ${res.error}`
      const r = res.results[0]
      if (!r) return `Nothing found on YouTube for "${input.query}"`
      state.queue = [_ytQueueItem(r)]
      state.queueIndex = 0
      playCurrentTrack()
      return `Streaming "${r.title}" by ${r.artist} from YouTube`
    }

    case 'youtube_download': {
      const res = await window.api.ytMusicSearch({ query: input.query })
      if (!res.ok) return `YouTube search failed: ${res.error}`
      const r = res.results[0]
      if (!r) return `Nothing found on YouTube for "${input.query}"`
      await window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
      return `Downloading "${r.title}" by ${r.artist} from YouTube (check Downloads page)`
    }
```

- [ ] **Step 4: Manual agent test**

```bash
npm start
```

In the chat sidebar (any provider) try:
- "play <something NOT in the library> right now" → expect youtube_play streams it
- "search youtube for boiler room fred again" → expect result list
- "download <obscure track> from youtube" → expect download starts

Expected: agent picks the right tool, one-sentence responses, playback/download actually happen.

- [ ] **Step 5: Full test suite + commit**

Run: `npm test`
Expected: all PASS.

```bash
git add main.js src/renderer.js
git commit -m "feat: agent YouTube tools (search, play, download)"
```

---

### Task 8: End-to-end verification pass

**Files:** none (verification only; fix regressions found)

- [ ] **Step 1: Full suite**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 2: Manual E2E checklist**

Run `npm start` and walk through:

1. Search a library artist → library results on top, YouTube group below, Soulseek at bottom — all three populate independently
2. YouTube Music tab → stream a song → gapless-queue a local track after it → transition works
3. "All of YouTube" tab → find a long DJ set → stream, seek to the middle
4. Download from YouTube → progress on Downloads page → file in `/mnt/data/MUSIC/Downloads/` with tags + art (`ffprobe` it) → appears in library after rescan
5. Agent: "play X" (not in library) → streams from YouTube
6. Failure modes: garbage query (empty YT group, no crash), network cut during search (per-group error only)

- [ ] **Step 3: Final commit if fixes were needed**

```bash
git add -A && git commit -m "fix: youtube integration polish from e2e pass"
```
