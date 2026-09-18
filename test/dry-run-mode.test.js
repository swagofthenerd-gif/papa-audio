'use strict'
// Dry-run mode (PAPA_DRY_RUN=1).
//
// On 2026-09-18 a QA agent stubbed window.api in the renderer to keep a test
// twin from touching the real world. contextBridge objects are frozen, so the
// assignment did nothing, the stubs were never installed, and a single hero-Play
// click sent twelve addMagnet calls to the user's real RealDebrid account. They
// were all rejected. That is luck, not a safety mechanism.
//
// The refusal now lives in the main process, where the renderer cannot reach
// around it. These tests run the REAL handler source out of main.js (see
// test/helpers/lift-ipc.js) with the predicate true and false, and assert on
// what the body actually reached — not on how main.js reads.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const vm = require('vm')
const { runHandler, GATED_CHANNELS, MAIN_PATH } = require('./helpers/lift-ipc')
const { createDebrid, DebridError } = require('../src/debrid')

const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')

// Arguments shaped like the ones the renderer really sends, so a live run walks
// into the body rather than bouncing off an input check.
const ARGS = {
  'video-play': { result: { kind: 'torrent', magnet: 'magnet:?xt=urn:btih:1' } },
  'video-switch-stream': { result: { kind: 'torrent', magnet: 'magnet:?xt=urn:btih:1' } },
  'video-warm': { magnet: 'magnet:?xt=urn:btih:1', titleKey: 'k' },
  'video-download-start': { result: { kind: 'torrent', magnet: 'magnet:?xt=urn:btih:1' }, meta: { key: 'k' } },
  'video-keep-file': { index: 0, show: { title: 'Show' } },
  'video-debrid-pick': { magnets: ['magnet:?xt=urn:btih:1'], titleKey: 'k' },
  'video-predownload': { index: 0 },
  'video-cache-delete': { key: 'k' },
  'video-keep-delete': { id: 'k' },
  'slsk-enqueue-downloads': { items: [{ username: 'u', filename: 'f.flac' }] },
  'slsk-retry-transfer': { username: 'u', id: '1', filename: 'f.flac', size: 1 },
  'slsk-cancel-transfer': { username: 'u', id: '1' },
  'slsk-respread-backlog': {},
  'slsk-configure': { username: 'u', password: 'p' },
  'slsk-set-download-dir': {},
  'slsk-share-mode-set': { mode: 'none' },
  'yt-download': { videoId: 'v', title: 't', artist: 'a' },
  'library-trash-paths': { paths: ['/mnt/data/MUSIC/x/a.flac'] },
  'library-empty-trash': { names: ['a'], payloads: ['/x'] },
  'library-move-path': { from: '/mnt/data/MUSIC/a', to: '/mnt/data/MUSIC/b' },
  'library-write-tags': { files: [{ filePath: '/mnt/data/MUSIC/a.flac' }] },
  'tag-write-batch': { edits: [{ filePath: '/mnt/data/MUSIC/a.flac' }] },
  'library-set-artwork': { albumId: 'a1', sourcePath: '/a.jpg' },
  'papa-import-all': { path: '/x.json' },
}

// The one effectful call each handler must reach when the dry run is OFF, and
// must never reach when it is ON. These are the calls that spend money, move
// bytes or change the user's disk — the exact things the twin must not do.
const EFFECT = {
  'video-play': '_videoTeardown',
  'video-switch-stream': 'videoEngine',
  'video-warm': '_debridPlayable',
  'video-download-start': '_videoDownloads.has',
  'video-debrid-pick': '_debridConfigured',
  'video-predownload': '_videoSession.streamer.predownloadFile',
  'video-cache-delete': 'fs.unlinkSync',
  'video-keep-delete': 'fs.promises.rm',
  'slsk-enqueue-downloads': 'dlSched.addItems',
  'slsk-retry-transfer': 'slskdFetch',
  'slsk-cancel-transfer': 'slskdFetch',
  'slsk-respread-backlog': 'slskdFetch',
  'slsk-configure': 'writeSlskdConfig',
  'slsk-set-download-dir': 'dialog.showOpenDialog',
  'slsk-share-mode-set': 'writeSlskdConfig',
  'yt-download': '_ytDownloads.set',
  'library-trash-paths': 'shell.trashItem',
  'library-empty-trash': 'trashRootsAll',
  'library-move-path': 'libRoots',
  'library-write-tags': 'writeTagsOne',
  'tag-write-batch': 'flacTags.writeBatch',
  'library-set-artwork': 'spawn',
  'papa-import-all': 'fs.readFileSync',
}

function isRefusal(r) {
  return !!r && r.ok === false && r.dryRun === true &&
    typeof r.error === 'string' && r.error.startsWith('Dry run — ')
}

// ── Every gated handler refuses, and reaches nothing ────────────────────────

for (const channel of GATED_CHANNELS) {
  test(`${channel} refuses in a dry run and touches nothing`, async () => {
    const run = await runHandler(channel, { dryRun: true, args: ARGS[channel] })
    assert.ok(isRefusal(run.result),
      `${channel} answered ${JSON.stringify(run.result)} instead of a dry-run refusal`)
    assert.deepStrictEqual(Object.keys(run.result).sort(), ['dryRun', 'error', 'ok'])
    assert.strictEqual(run.error, null, `${channel} threw: ${run.error && run.error.message}`)
    // The point of the whole exercise: the body did not run. Not one call.
    assert.deepStrictEqual(run.calls, [],
      `${channel} reached ${run.calls.join(', ')} despite the dry run`)
  })
}

// ── With the dry run off, the same handlers do their work ───────────────────

for (const channel of GATED_CHANNELS) {
  test(`${channel} is untouched when the dry run is off`, async () => {
    const run = await runHandler(channel, { dryRun: false, args: ARGS[channel] })
    assert.ok(!isRefusal(run.result),
      `${channel} refused even though the dry run is off`)
    const want = EFFECT[channel]
    if (!want) return
    assert.ok(run.calls.includes(want),
      `${channel} never reached ${want}; it reached ${run.calls.join(', ') || 'nothing'}`)
  })
}

// video-keep-file has no entry in EFFECT because its live path cannot be
// reached at all: the body declares `const index` after using the destructured
// `index` parameter, so every call throws on the temporal dead zone. That is a
// pre-existing bug on this branch, not something the gate introduced — asserted
// here only so the omission above is on the record rather than an oversight.
test('video-keep-file: the gate is the only thing standing in front of a body that already throws', async () => {
  const dry = await runHandler('video-keep-file', { dryRun: true, args: ARGS['video-keep-file'] })
  assert.ok(isRefusal(dry.result))
  assert.deepStrictEqual(dry.calls, [])
  const live = await runHandler('video-keep-file', { dryRun: false, args: ARGS['video-keep-file'] })
  assert.ok(!isRefusal(live.result))
})

// ── Nothing changes when the variable is absent ─────────────────────────────

// The real predicate line, lifted from main.js and run against a fake env, so
// this is the production expression being tested and not a copy of it.
function predicateUnder(env) {
  const line = MAIN.match(/^const DRY_RUN = .*$/m)
  assert.ok(line, 'main.js no longer declares DRY_RUN on one line')
  const ctx = vm.createContext({ process: { env } })
  vm.runInContext(line[0] + '; DRY_RUN', ctx)
  return vm.runInContext('DRY_RUN', ctx)
}

test('the dry run is off unless PAPA_DRY_RUN is exactly "1"', () => {
  assert.strictEqual(predicateUnder({}), false)
  assert.strictEqual(predicateUnder({ PAPA_DRY_RUN: '' }), false)
  assert.strictEqual(predicateUnder({ PAPA_DRY_RUN: '0' }), false)
  assert.strictEqual(predicateUnder({ PAPA_DRY_RUN: 'true' }), false)
  assert.strictEqual(predicateUnder({ PAPA_DRY_RUN: 1 }), false)
  assert.strictEqual(predicateUnder({ PAPA_DRY_RUN: '1' }), true)
})

test('with the variable unset, no handler anywhere produces a refusal', async () => {
  const off = predicateUnder({})
  for (const channel of GATED_CHANNELS) {
    const run = await runHandler(channel, { dryRun: off, args: ARGS[channel] })
    assert.ok(!isRefusal(run.result),
      `${channel} refused with PAPA_DRY_RUN unset: ${JSON.stringify(run.result)}`)
  }
})

// ── The refusal wording is for a person, not a log ──────────────────────────

test('every refusal says in plain words what did not happen', async () => {
  for (const channel of GATED_CHANNELS) {
    const run = await runHandler(channel, { dryRun: true, args: ARGS[channel] })
    assert.match(run.result.error, /^Dry run — .+ was not performed$/,
      `${channel}: ${run.result.error}`)
  }
})

test('the startup line says, in plain words, what will not happen', () => {
  const at = MAIN.indexOf('const DRY_RUN =')
  const banner = MAIN.slice(at, at + 400)
  assert.match(banner, /\[papa\] DRY RUN: nothing will be downloaded, resolved, trashed, /)
  assert.match(banner, /written to tags, or sent to RealDebrid\/slskd/)
})

// ── The RealDebrid client itself ────────────────────────────────────────────
// Belt as well as braces: even a path nobody gated must not reach RD.

const MAGNET = 'magnet:?xt=urn:btih:abc'

// A RealDebrid that answers every request happily, and writes down what it was
// asked. If a single line appears in `seen` during a dry run, the twin just
// touched the user's real account.
function fakeRd(status = 'downloaded') {
  const seen = []
  return {
    seen,
    fetchFn: async (url, init) => {
      seen.push(((init && init.method) || 'GET') + ' ' + String(url).replace(/^.*rest\/1\.0/, ''))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'tid', status, links: ['l'], download: 'https://rd.example/y.mkv',
          files: [{ id: 1, path: '/Show/ep.mkv', bytes: 9e9, selected: 1 }],
        }),
      }
    },
  }
}

function client(rd, dryRun) {
  return createDebrid({
    token: () => 'tok', fetchFn: rd.fetchFn, dryRun,
    pollTimeoutMs: 20, pollIntervalMs: 1, sleep: async () => {},
  })
}

test('a dry-run debrid client sends no addMagnet, no selectFiles, no unrestrict', async () => {
  const rd = fakeRd()
  await assert.rejects(() => client(rd, true).resolveMagnet(MAGNET),
    e => e instanceof DebridError && e.code === 'DRY_RUN')
  assert.deepStrictEqual(rd.seen, [], 'a dry run reached RealDebrid: ' + rd.seen.join(', '))
})

test('a dry-run debrid client sends no deleteTorrent either', async () => {
  // The delete only happens on the give-up path — a magnet RD never finishes.
  // Live, that path issues a DELETE; in a dry run it never gets that far.
  const live = fakeRd('downloading')
  await client(live, false).resolveMagnet(MAGNET).catch(() => {})
  assert.ok(live.seen.some(s => s.startsWith('DELETE /torrents/delete/')),
    'the live give-up path stopped deleting: ' + live.seen.join(', '))

  const dry = fakeRd('downloading')
  await client(dry, true).resolveMagnet(MAGNET).catch(() => {})
  assert.deepStrictEqual(dry.seen, [])
})

test('a dry-run debrid client still answers read-only questions', async () => {
  const rd = fakeRd()
  const who = await client(rd, true).check()
  assert.strictEqual(who.configured, true)
  assert.deepStrictEqual(rd.seen, ['GET /user'],
    'the account check is a GET and must stay live so QA can see the surface')
})

test('without the flag the debrid client talks to RealDebrid exactly as before', async () => {
  const rd = fakeRd()
  const url = await client(rd, false).resolveMagnet(MAGNET)
  assert.strictEqual(url, 'https://rd.example/y.mkv')
  assert.deepStrictEqual(rd.seen, [
    'POST /torrents/addMagnet',
    'POST /torrents/selectFiles/tid',
    'GET /torrents/info/tid',
    'POST /unrestrict/link',
  ])
})

test('an omitted flag is the same as off', async () => {
  const rd = fakeRd()
  await createDebrid({ token: () => 'tok', fetchFn: rd.fetchFn, sleep: async () => {} })
    .resolveMagnet(MAGNET)
  assert.ok(rd.seen.includes('POST /torrents/addMagnet'))
})

test('the dry-run flag can be a function, so a late change is still seen', async () => {
  const rd = fakeRd()
  let on = false
  const c = client(rd, () => on)
  await c.resolveMagnet(MAGNET)
  assert.ok(rd.seen.length > 0)
  on = true
  rd.seen.length = 0
  await c.resolveMagnet('magnet:?xt=urn:btih:def').catch(() => {})
  assert.deepStrictEqual(rd.seen, [])
})

// ── The window has to say so ────────────────────────────────────────────────

test('main tells the renderer, and the renderer paints a pill that cannot be missed', () => {
  const info = MAIN.slice(MAIN.indexOf("ipcMain.handle('get-app-info'"),
    MAIN.indexOf("ipcMain.handle('get-app-info'") + 500)
  assert.match(info, /dryRun:\s*DRY_RUN/, 'get-app-info must carry the flag')

  const R = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.match(R, /if \(info && info\.dryRun\) _paintDryRunPill\(\)/)
  assert.match(R, /function _paintDryRunPill\(\)/)
  assert.match(R, /pill\.textContent = 'DRY RUN'/)

  const CSS = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  assert.match(CSS, /\.dry-run-pill\s*\{/)
})
