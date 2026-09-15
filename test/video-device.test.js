'use strict'
// On-device viewing (2026-09-14): the rewatch cache's eviction policy, the
// warm-on-open lifecycle, the background download manager, and the On-device
// tab — the wiring that makes "press Play, picture now" and "watch with no
// internet" real.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { evictPlan, fileNameFor, GB } = require('../src/video-cache')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

// ── The eviction policy, behaviourally ──────────────────────────────────────
test('the cache evicts least-recently-watched first, and only enough to fit the newcomer', () => {
  const e = (key, size, used) => ({ key, path: '/c/' + key, sizeBytes: size, savedAt: 1, lastUsedAt: used })
  const entries = [e('a', 4 * GB, 30), e('b', 4 * GB, 10), e('c', 4 * GB, 20)]
  // 12 GB held, 15 GB cap, 4 GB arriving: one eviction, the stalest (b).
  const plan = evictPlan(entries, 15 * GB, 4 * GB)
  assert.strictEqual(plan.ok, true)
  assert.deepStrictEqual(plan.evict.map(x => x.key), ['b'])
  // Plenty of room: nothing goes.
  assert.deepStrictEqual(evictPlan(entries, 40 * GB, 4 * GB).evict, [])
  // A file bigger than the whole cache is refused without touching anything.
  const huge = evictPlan(entries, 15 * GB, 16 * GB)
  assert.strictEqual(huge.ok, false)
  assert.deepStrictEqual(huge.evict, [])
  // Cache off (0 GB): everything is evicted and the newcomer is refused.
  const off = evictPlan(entries, 0, 4 * GB)
  assert.strictEqual(off.ok, false)
  assert.strictEqual(off.evict.length, 3)
})

test('cache file names are safe and keep the source extension', () => {
  assert.strictEqual(fileNameFor('anime:21:null:3', 'One.Piece.S01E03.mkv'), 'anime_21_null_3.mkv')
  assert.strictEqual(fileNameFor('movie:603', 'weird name!!.MP4'), 'movie_603.mp4')
  assert.strictEqual(fileNameFor('movie:603', null), 'movie_603.mkv')
})

// ── The rewatch cache's wiring ──────────────────────────────────────────────
// Caching happens WHILE watching, not at the end: the stream store and the
// cache are routinely on different disks (the stream cache setting points at
// the big drive), so a teardown-time copy of a 20 GB film was never going to
// finish. The background copy is the real path; the teardown rename is the
// same-disk last chance for a watch stopped just as the file completed.
test('a completed file is copied into the cache in the background, while it is still being watched', () => {
  const fn = MAIN.slice(MAIN.indexOf('function _maybeCacheCurrentFile('), MAIN.indexOf('function _maybeCacheFinishedFile()'))
  assert.ok(/info\.downloaded < info\.total\) return/.test(fn), 'only complete files')
  assert.ok(/fs\.promises\.copyFile\(info\.path, part\)/.test(fn), 'a copy: the cache may be on another disk')
  assert.ok(/\.part/.test(fn) && /fs\.promises\.rename\(part, dest\)/.test(fn), 'never a truncated file posing as cached')
  assert.ok(/s\.cacheSaved \|\| s\.cacheSaving/.test(fn), 'once only, and never twice at once')
  assert.ok(/_videoCacheIndexAdd\(/.test(fn))
  // It rides the same tick the pack chain does, before the pack-only guard,
  // so a single-file film reaches it too.
  const tick = MAIN.slice(MAIN.indexOf('function _maybeChainPackDownloads()'), MAIN.indexOf('function _startTorrentRace'))
  assert.ok(tick.indexOf('_maybeCacheCurrentFile(streamer)') < tick.indexOf('if (files.length < 2) return'))
  assert.ok(/videoCache\.evictPlan\(/.test(MAIN.slice(MAIN.indexOf('function _videoCacheIndexAdd('), MAIN.indexOf('function _currentFileInfo('))))
  // The play handler stashes the identity the renderer sent.
  assert.ok(/_videoSession\.cacheKey = typeof result\.cacheKey === 'string'/.test(MAIN))
  assert.ok(MAIN.includes("'videoKeepQuotaGB', 'videoCacheGB', 'debridProvider'"), 'the size knob saves')
})

test('teardown still catches a file that finished at the last moment, same-disk only', () => {
  const td = MAIN.slice(MAIN.indexOf('function _videoTeardown()'), MAIN.indexOf('function _wireVideoEngine'))
  assert.ok(/^\s*_maybeCacheFinishedFile\(\)/m.test(td), 'cache first')
  assert.ok(td.indexOf('_maybeCacheFinishedFile()') < td.indexOf('_videoSession.cacheKey = null'))
  const fn = MAIN.slice(MAIN.indexOf('function _maybeCacheFinishedFile()'), MAIN.indexOf('function _videoTeardown()'))
  assert.ok(/fs\.renameSync\(info\.path, dest\)/.test(fn), 'a rename, not a copy — teardown must not block')
  assert.ok(/s\.cacheSaved \|\| s\.cacheSaving/.test(fn), 'not again if the background copy already did it')
  assert.ok(/warmAdopted && s\.warmAdopted\.dir/.test(fn), 'an adopted warm store is ours to move from')
})

test('the cache read side touches the watch clock and self-heals missing files', () => {
  const get = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-cache-get'"), MAIN.indexOf("ipcMain.handle('video-cache-list'"))
  assert.ok(/e\.lastUsedAt = Date\.now\(\)/.test(get))
  assert.ok(/if \(!fs\.existsSync\(e\.path\)\)/.test(get))
})

test('the renderer rides the watch identity on every play and swaps the default pick for a saved copy', () => {
  assert.ok(/cacheKey: _watchKey\(_videoDetail\.type, d\.id, _videoState\.season, _videoState\.episode\)/.test(RENDERER))
  const at = RENDERER.indexOf('const cacheProbe =')
  assert.ok(at > -1)
  const probe = RENDERER.slice(at, at + 1200)
  assert.ok(/!opts\.manual && result\.cacheKey/.test(probe), 'a hand-picked source row is never overridden')
  assert.ok(/kind: 'cached', url: hit\.path, magnet: null, alternates: null/.test(probe))
})

// ── Warm-on-open ────────────────────────────────────────────────────────────
test('warming joins one swarm, head only, never while something plays, and is swept on a timer', () => {
  const warm = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-warm'"), MAIN.indexOf("ipcMain.handle('video-warm-cancel'"))
  assert.ok(/if \(_videoSession\.streamer\) return \{ ok: true, skipped: 'playing' \}/.test(warm))
  assert.ok(/if \(_warm\.magnet === magnet\) return \{ ok: true, skipped: 'already' \}/.test(warm))
  assert.ok(/WARM_HEAD_BYTES/.test(warm) && /_warm\.timer = setTimeout\(_warmSweep, WARM_TTL_MS\)/.test(warm))
  assert.ok(/const WARM_HEAD_BYTES = 8 \* 1024 \* 1024/.test(MAIN), 'eight megabytes of head, no more')
})

test('playing the warmed title adopts its torrent; teardown sweeps what was adopted', () => {
  assert.ok(/_warm\.magnet === result\.magnet && _warm\.torrent\) \{\n      _videoSession\.warmAdopted = \{ infoHash: _warm\.torrent\.infoHash, dir: _warm\.dir \}/.test(MAIN))
  const td = MAIN.slice(MAIN.indexOf('function _videoTeardown()'), MAIN.indexOf('function _wireVideoEngine'))
  assert.ok(/warmAdopted/.test(td) && /destroyStore: true/.test(td))
})

test('the page warms its top source after the list lands, skips titles already saved, and cancels on leaving', () => {
  // The source WARMED must be the source PLAYED: warming a different one
  // leaves the relay useless at the moment it is needed.
  assert.ok(/const warmPick = streams\.length \? _pickForPlay\(streams\) : null/.test(RENDERER))
  assert.ok(/window\.api\.videoWarm\(\{ magnet: warmPick\.magnet, titleKey:/.test(RENDERER))
  const hook = RENDERER.slice(RENDERER.indexOf('// Warm the top source'), RENDERER.indexOf('if (_autoPlayTicket === _videoDetailTicket'))
  assert.ok(/videoCacheGet/.test(hook) && /if \(res && res\.ok && res\.hit\) return/.test(hook))
  assert.ok(/state\.currentPage === 'video-detail' && page !== 'video-detail'[\s\S]{0,200}videoWarmCancel/.test(RENDERER))
})

// ── Downloads and the On-device tab ─────────────────────────────────────────
test('downloads run through their own streamer, two at a time, and finish into the keep library under its quota', () => {
  const dl = MAIN.slice(MAIN.indexOf('const VIDEO_DOWNLOAD_MAX'), MAIN.indexOf("ipcMain.handle('video-download-cancel'"))
  assert.ok(/const VIDEO_DOWNLOAD_MAX = 2/.test(dl))
  assert.ok(/_videoDownloads\.size >= VIDEO_DOWNLOAD_MAX/.test(dl))
  assert.ok(/videoKeep\.quotaCheck\(index, _videoSettings\(\)\.videoKeepQuotaGB, info\.total\)/.test(dl))
  assert.ok(/season: result\.season \?\? null,\s*\n\s*episode: result\.episode \?\? null/.test(dl), 'a pack downloads the asked-for episode')
  assert.ok(/_recordDeadMagnet\(result\)/.test(dl), 'a dead download teaches the ranking')
  assert.ok(/sideStores\.videoKeepIndex\.set\(index\)/.test(dl))
})

test('the Download button downloads what Play would pick, for the selected episode', () => {
  assert.ok(/id="vdet-download"/.test(RENDERER))
  const pick = RENDERER.slice(RENDERER.indexOf('function _downloadCurrentPick()'), RENDERER.indexOf('function _downloadStream('))
  assert.ok(/_downloadStream\(_autoPickStream\(_videoStreams\)\)/.test(pick))
  const fn = RENDERER.slice(RENDERER.indexOf('function _downloadStream('), RENDERER.indexOf('function _deviceCardHtml'))
  assert.ok(/episode: isEpisode \? _videoState\.episode : null/.test(fn))
  assert.ok(/videoDownloadStart/.test(fn))
})

// Every source is downloadable, not only the one Play would choose
// (2026-09-14): a different quality, group or language belongs on disk when
// the viewer says so.
test('every torrent source row carries its own Download, keyed so two qualities are two downloads', () => {
  const row = RENDERER.slice(RENDERER.indexOf('function _videoStreamRow('), RENDERER.indexOf('// ── Folder management'))
  assert.ok(/s\.kind === 'torrent' && s\.magnet/.test(row), 'a direct-HTTP row gets no dead button')
  assert.ok(/class="video-source-dl" data-dl-idx="' \+ i \+ '"/.test(row))
  const bind = RENDERER.slice(RENDERER.indexOf('function _renderVideoSourceRows('), RENDERER.indexOf('function _wireVideoSortChips'))
  assert.ok(/video-source-dl'\)\.forEach/.test(bind), 'bound on every repaint, so a re-sort keeps them live')
  assert.ok(/_downloadStream\(_videoStreams\[Number\(btn\.dataset\.dlIdx\)\]\)/.test(bind))
  assert.ok(/ev\.stopPropagation\(\)/.test(bind), 'downloading must not also start playing')
  const fn = RENDERER.slice(RENDERER.indexOf('function _downloadStream('), RENDERER.indexOf('function _deviceCardHtml'))
  assert.ok(/\+ '\|' \+ _sourceKey\(pick\)/.test(fn), 'the download id carries the source, not just the episode')
})

test('the On-device tab lists downloads, keeps and the cache; cards open their title or play their file', () => {
  assert.ok(/\{ key: 'device', label: 'On device' \}/.test(RENDERER))
  assert.ok(/if \(_videoTab === 'device'\) \{[\s\S]{0,300}_renderDeviceTab\(rows, ticket\)/.test(RENDERER))
  const dev = RENDERER.slice(RENDERER.indexOf('async function _renderDeviceTab'), RENDERER.indexOf('function _bindDeviceCards'))
  assert.ok(/videoDownloadList/.test(dev) && /videoKeepList/.test(dev) && /videoCacheList/.test(dev))
  assert.ok(/Downloading now/.test(dev) && /Downloaded/.test(dev) && /Ready to rewatch/.test(dev))
  // A section with nothing in it is not drawn, and the storage meters lead.
  assert.ok(/if \(downloads\.length\)/.test(dev) && /if \(keeps\.length\)/.test(dev) && /if \(cached\.length\)/.test(dev))
  assert.ok(dev.indexOf('_deviceStorageHtml(') < dev.indexOf('Downloading now'))
  const bind = RENDERER.slice(RENDERER.indexOf('function _bindDeviceCards'), RENDERER.indexOf('function _playDeviceFile'))
  assert.ok(/navigate\('video-detail', card\.dataset\.deviceOpen\)/.test(bind))
  for (const api of ['videoDownloadStart', 'videoDownloadCancel', 'videoDownloadList', 'videoCacheGet', 'videoCacheList', 'videoCacheDelete', 'videoWarm', 'videoWarmCancel', 'onVideoDownloadEvent']) {
    assert.ok(PRELOAD.includes(api), api + ' exposed')
  }
})

// "The downloads need to be detailed and properly show all the info"
// (2026-09-14). Behavioural: the fact line and the grouping are built by pure
// functions, so they are run rather than grepped.
test('a download card states percent, size, speed, time left and peers; a saved one states size and age', () => {
  const vm = require('node:vm')
  const src = RENDERER.slice(RENDERER.indexOf('function _deviceFactsHtml('), RENDERER.indexOf('function _deviceCardHtml('))
  const ctx = {
    esc: x => String(x == null ? '' : x),
    _fmtBytes: n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB',
    _vDurText: sec => Math.round(sec / 60) + 'm',
    _etaLabel: null,   // replaced below by the real one
    _agoLabel: ms => Math.round(ms / 3600000) + 'h ago',
    Date, Number, Math, String,
  }
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(RENDERER.indexOf('function _etaLabel('), RENDERER.indexOf('// The episode line, when this is one:')), ctx)
  vm.runInContext(src, ctx)
  // A wait under a minute must never round to "0m left" — that reads as done.
  assert.strictEqual(ctx._etaLabel(20), 'less than a minute left')
  assert.strictEqual(ctx._etaLabel(250), '4m left')
  const line = ctx._deviceFactsHtml({ bytes: 5e8, total: 1e9, speedBps: 2e6, eta: 250, peers: 12, status: 'downloading' }, 'download')
  for (const part of ['50%', '500 MB of 1.0 GB', '2 MB/s', '4m left', '12 peers']) {
    assert.ok(line.includes(part), 'missing ' + part + ' in: ' + line)
  }
  // One peer is not "1 peers"; a stalled download does not invent a time left.
  assert.ok(ctx._deviceFactsHtml({ bytes: 0, total: 1e9, speedBps: 0, eta: null, peers: 1, status: 'downloading' }, 'download').includes('1 peer'))
  assert.ok(!/left/.test(ctx._deviceFactsHtml({ bytes: 0, total: 1e9, speedBps: 0, eta: null, peers: 0, status: 'downloading' }, 'download')))
  assert.ok(ctx._deviceFactsHtml({ status: 'saving', total: 0, bytes: 0 }, 'download').includes('Saving'))
  const saved = ctx._deviceFactsHtml({ sizeBytes: 2e9, keptAt: Date.now() - 7200000 }, 'keep')
  assert.ok(saved.includes('2.0 GB') && saved.includes('2h ago'))
  assert.strictEqual(ctx._deviceEpisodeLabel({ season: 2, episode: 7 }), 'Season 2 · Episode 7')
  assert.strictEqual(ctx._deviceEpisodeLabel({ episode: 7 }), 'Episode 7', 'anime numbers straight through')
  assert.strictEqual(ctx._deviceEpisodeLabel({}), '')
})

test('downloaded episodes group under their show in episode order, newest show first', () => {
  const vm = require('node:vm')
  const src = RENDERER.slice(RENDERER.indexOf('function _groupDeviceEntries('), RENDERER.indexOf('function _deviceSectionHtml('))
  const ctx = { Map, Number, String, Math }
  vm.createContext(ctx); vm.runInContext(src, ctx)
  const groups = ctx._groupDeviceEntries([
    { show: 'One Piece', season: null, episode: 3, sizeBytes: 100, keptAt: 10 },
    { show: 'One Piece', season: null, episode: 1, sizeBytes: 100, keptAt: 20 },
    { show: 'Sintel', title: 'Sintel', sizeBytes: 50, keptAt: 90 },
  ])
  // Array.from: values built inside the vm carry that realm's prototypes, and
  // deepStrictEqual compares those too.
  assert.deepStrictEqual(Array.from(groups).map(g => g.show), ['Sintel', 'One Piece'], 'most recently saved show leads')
  const op = Array.from(groups).find(g => g.show === 'One Piece')
  assert.deepStrictEqual(Array.from(op.items).map(i => i.episode), [1, 3], 'episodes in order, not arrival order')
  assert.strictEqual(op.bytes, 200, 'the group states its own size')
})

test('main reports speed, peers and a time left that stays null when there is no speed', () => {
  const vm = require('node:vm')
  const src = MAIN.slice(MAIN.indexOf('function _downloadStats('), MAIN.indexOf('function _downloadSnapshot('))
  const ctx = { Number, Math }
  vm.createContext(ctx); vm.runInContext(src, ctx)
  const d = (speed) => ({ meta: { title: 'T', quality: '1080p', episode: 4 }, bytes: 400, total: 1000,
    status: 'downloading', streamer: { stats: () => ({ speedBps: speed, peers: 9 }) } })
  const moving = ctx._downloadRow('x', d(100))
  assert.strictEqual(moving.eta, 6, '600 bytes left at 100/s')
  assert.strictEqual(moving.peers, 9)
  assert.strictEqual(moving.quality, '1080p')
  assert.strictEqual(moving.episode, 4)
  assert.strictEqual(ctx._downloadRow('x', d(0)).eta, null, 'no speed, no invented estimate')
})

// ── The play path actually runs ─────────────────────────────────────────────
// Found live 2026-09-14 ("the episodes are not playing"): the rewatch-cache
// identity block read `d` above its own `const d = …`, so every single play
// threw a ReferenceError before reaching videoPlay. A regex pin would not
// have caught it — the code looked right — so this EXECUTES the function and
// insists the play actually happens. Revert the fix and this goes red.
test('playing an episode reaches videoPlay, carrying the episode and its cache identity', async () => {
  const vm = require('node:vm')
  const src = RENDERER.slice(RENDERER.indexOf('function _videoPlayResult('),
    RENDERER.indexOf('// An empty state that echoes what was typed'))
  const played = []
  const ctx = {
    console,
    _initVideoUI() {}, _applyHandoff() {}, _handoff: null,
    audio: null, state: { queue: [] },
    _videoDetail: { type: 'anime', id: 21, d: { id: 21, title: 'One Piece', poster: 'p.jpg' } },
    _videoState: { season: null, episode: 7, sub: true },
    _videoStreams: [],
    _watchKey: (t, id, s, e) => t + ':' + id + ':' + s + ':' + e,
    _sourceKey: x => (x && (x.magnet || x.url)) || '',
    _releaseGroupOf: () => null,
    _vStore: () => null,
    _nextEpisodeOf: () => null, _prevEpisodeOf: () => null,
    _playPrevEpisode() {}, _handleVideoEvent() {}, _armStartWatch() {},
    showSnackbar() {}, showToast() {},
    _player: { open() {}, ready: () => Promise.resolve() },
    _watch: null, _playing: null,
    Promise, Object, Number, String, Boolean, Array, JSON, Date,
    window: {
      PapaTasteStore: null,
      api: {
        videoCacheGet: () => Promise.resolve({ ok: true, hit: null }),
        videoPlay: (arg) => { played.push(arg.result); return Promise.resolve({ ok: true }) },
      },
    },
  }
  ctx.window.api.videoTrackMemoryGet = undefined
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  ctx._videoPlayResult({ kind: 'torrent', magnet: 'magnet:?xt=urn:btih:abc', title: 'ep' }, {})
  // The ready() and cache probe are promises; let them settle.
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(played.length, 1, 'videoPlay must be reached — a throw here is a dead Play button')
  assert.strictEqual(played[0].episode, 7, 'the selected episode travels with the play')
  assert.strictEqual(played[0].cacheKey, 'anime:21:null:7')
  assert.strictEqual(played[0].cacheMeta.title, 'One Piece')
})
