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
  'video-cache-sweep-watched': { keys: ['k'] },
  'video-keep-delete': { id: 'k' },
  'slsk-enqueue-downloads': { items: [{ username: 'u', filename: 'f.flac' }] },
  'slsk-retry-transfer': { username: 'u', id: '1', filename: 'f.flac', size: 1 },
  'slsk-cancel-transfer': { username: 'u', id: '1' },
  'slsk-respread-backlog': {},
  'slsk-configure': { username: 'u', password: 'p' },
  'slsk-set-download-dir': {},
  'slsk-share-mode-set': { mode: 'none' },
  'slsk-download': { username: 'u', filename: 'f.flac', size: 1 },
  'slsk-chat-send': { username: 'u', message: 'hello' },
  'slsk-wishlist-run': {},
  'slsk-setup': {},
  'yt-download': { videoId: 'v', title: 't', artist: 'a' },
  'library-trash-paths': { paths: ['/mnt/data/MUSIC/x/a.flac'] },
  'library-restore-trashed': { paths: ['/mnt/data/MUSIC/x/a.flac'] },
  'library-empty-trash': { names: ['a'], payloads: ['/x'] },
  'library-move-path': { from: '/mnt/data/MUSIC/a', to: '/mnt/data/MUSIC/b' },
  'library-write-tags': { files: [{ filePath: '/mnt/data/MUSIC/a.flac' }] },
  'tag-write-batch': { edits: [{ filePath: '/mnt/data/MUSIC/a.flac' }] },
  'library-set-artwork': { albumId: 'a1', sourcePath: '/a.jpg' },
  'papa-import-all': { path: '/x.json' },
  'slsk-verify-rip': { username: 'u', folderPath: 'p', files: [{ name: 'a.flac', size: 1e6, length: 300 }] },
  'slsk-share-folders-set': { folders: ['/mnt/data/MUSIC/Downloads'] },
  'slsk-enabled-set': { enabled: false },
  'slsk-upload-limit-set': { slots: 4, mbps: 0 },
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
  // The delete itself needs a real, eligible entry, which a stub sandbox cannot
  // produce — so the marker here is the cache read the live path makes and the
  // refusal never reaches. What actually gets deleted is pinned by
  // test/cache-sweep-watched.test.js against real entries.
  'video-cache-sweep-watched': '_videoCacheEntries',
  'video-keep-delete': 'fs.promises.rm',
  'slsk-enqueue-downloads': 'dlSched.addItems',
  'slsk-retry-transfer': 'slskdFetch',
  'slsk-cancel-transfer': 'slskdFetch',
  'slsk-respread-backlog': 'slskdFetch',
  'slsk-configure': 'writeSlskdConfig',
  'slsk-set-download-dir': 'dialog.showOpenDialog',
  'slsk-share-mode-set': 'writeSlskdConfig',
  'slsk-download': 'slskdFetch',
  'slsk-chat-send': 'slskdFetch',
  'slsk-wishlist-run': 'slskWishlistSweep',
  'slsk-setup': 'downloadSlskd',
  'yt-download': '_ytDownloads.set',
  'library-trash-paths': 'shell.trashItem',
  'library-restore-trashed': 'findTrashedEntry',
  'library-empty-trash': 'trashRootsAll',
  'library-move-path': 'libRoots',
  'library-write-tags': 'writeTagsOne',
  'tag-write-batch': 'flacTags.writeBatch',
  'library-set-artwork': 'spawn',
  'papa-import-all': 'fs.readFileSync',
  'slsk-verify-rip': 'slskdFetch',
  'slsk-share-folders-set': 'writeSlskdConfig',
  // Turning it off disconnects or stops the daemon his real account is signed
  // in through. _slskGoOff is the one call that does it.
  'slsk-enabled-set': '_slskGoOff',
  'slsk-upload-limit-set': 'writeSlskdConfig',
}

// Module-level constants a handler body does ARITHMETIC on. Everything else the
// sandbox leaves as a recording stub, but a stub cannot be coerced to a number:
// `Date.now() + stub` throws on the primitive conversion, and the live run then
// dies before it reaches the effectful call this file is watching for. Values
// are read out of main.js rather than retyped, so a changed constant cannot
// leave the sandbox describing a version of the handler that no longer exists.
function mainConstant(name) {
  const m = MAIN.match(new RegExp('^const ' + name + ' = ([\\d *]+)$', 'm'))
  assert.ok(m, name + ' is no longer a numeric constant in main.js')
  return m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1)
}

const GLOBALS = {
  'slsk-verify-rip': { RIP_DEADLINE_MS: mainConstant('RIP_DEADLINE_MS') },
}

function isRefusal(r) {
  return !!r && r.ok === false && r.dryRun === true &&
    typeof r.error === 'string' && r.error.startsWith('Dry run — ')
}

// ── Every gated handler refuses, and reaches nothing ────────────────────────

for (const channel of GATED_CHANNELS) {
  test(`${channel} refuses in a dry run and touches nothing`, async () => {
    const run = await runHandler(channel, { dryRun: true, args: ARGS[channel], globals: GLOBALS[channel] })
    assert.ok(isRefusal(run.result),
      `${channel} answered ${JSON.stringify(run.result)} instead of a dry-run refusal`)
    // The refusal is exactly {ok, error, dryRun}. One handler adds `reason`,
    // because its own contract is {ok, reason} and the dossier reads reason on
    // every other exit it has; when it is there it must repeat `error`
    // verbatim, never say something different.
    const keys = Object.keys(run.result).sort()
    if (keys.includes('reason')) {
      assert.deepStrictEqual(keys, ['dryRun', 'error', 'ok', 'reason'])
      assert.strictEqual(run.result.reason, run.result.error)
    } else {
      assert.deepStrictEqual(keys, ['dryRun', 'error', 'ok'])
    }
    assert.strictEqual(run.error, null, `${channel} threw: ${run.error && run.error.message}`)
    // The point of the whole exercise: the body did not run. Not one call.
    assert.deepStrictEqual(run.calls, [],
      `${channel} reached ${run.calls.join(', ')} despite the dry run`)
  })
}

// ── With the dry run off, the same handlers do their work ───────────────────

for (const channel of GATED_CHANNELS) {
  test(`${channel} is untouched when the dry run is off`, async () => {
    const run = await runHandler(channel, { dryRun: false, args: ARGS[channel], globals: GLOBALS[channel] })
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

// ── video-pack-select: half gated, on purpose ──────────────────────────────

// Switching episode has two paths. The local one re-points a torrent streamer
// that is already running — no network, nothing new on disk — and a QA twin has
// to be able to click through a pack. The other resolves the episode through
// RealDebrid. Only the second is refused.
function packSession(extra) {
  return { _videoSession: Object.assign({ token: 7, streamer: null, debrid: null }, extra) }
}

test('video-pack-select refuses the RealDebrid path in a dry run', async () => {
  const globals = packSession({ debrid: { magnet: 'magnet:?xt=urn:btih:1', want: null } })
  const dry = await runHandler('video-pack-select', { dryRun: true, args: { index: 2 }, globals })
  assert.ok(isRefusal(dry.result), JSON.stringify(dry.result))
  assert.ok(!dry.calls.some(c => c.startsWith('debrid')),
    'the dry run reached the debrid client: ' + dry.calls.join(', '))

  const live = await runHandler('video-pack-select', { dryRun: false, args: { index: 2 }, globals })
  assert.ok(!isRefusal(live.result))
  assert.ok(live.calls.includes('debrid'),
    'the live path stopped asking RealDebrid: ' + live.calls.join(', '))
})

test('video-pack-select still switches episode on a running local stream', async () => {
  const globals = packSession({ streamer: { selectFile: () => 'http://127.0.0.1:1/f.mkv', files: () => [] } })
  const run = await runHandler('video-pack-select', { dryRun: true, args: { index: 2 }, globals })
  assert.ok(!isRefusal(run.result),
    'a dry run must not block a local episode switch: ' + JSON.stringify(run.result))
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
    const run = await runHandler(channel, { dryRun: off, args: ARGS[channel], globals: GLOBALS[channel] })
    assert.ok(!isRefusal(run.result),
      `${channel} refused with PAPA_DRY_RUN unset: ${JSON.stringify(run.result)}`)
  }
})

// ── The refusal wording is for a person, not a log ──────────────────────────

test('every refusal says in plain words what did not happen', async () => {
  for (const channel of GATED_CHANNELS) {
    const run = await runHandler(channel, { dryRun: true, args: ARGS[channel], globals: GLOBALS[channel] })
    assert.match(run.result.error, /^Dry run — .+ was not performed$/,
      `${channel}: ${run.result.error}`)
  }
})

test('the startup line says, in plain words, what will not happen', () => {
  // The banner moved out of the top of the file: printed there it ran before
  // console.log was patched, so it reached neither the daily log nor anything
  // greppable. It now lives in _emitStartupBanner(), right after the logger is
  // installed. Where it actually LANDS — stderr, and the daily log via the early
  // buffer — is proved behaviourally in test/startup-banner-log.test.js.
  const at = MAIN.indexOf('function _emitStartupBanner()')
  assert.ok(at > -1, '_emitStartupBanner not found in main.js')
  const banner = MAIN.slice(at, at + 700)
  assert.match(banner, /\[papa\] DRY RUN: nothing will be downloaded, resolved, trashed, /)
  assert.match(banner, /written to tags, or sent to RealDebrid\/slskd/)
  assert.match(banner, /dryRun=\$\{DRY_RUN\}/, 'the first line must carry dryRun')
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

// ── ...and the pill cannot silently fail to appear ───────────────────────────
// The check above reads the renderer as text, which cannot see whether the pill
// actually renders. On the lead's twin getAppInfo().dryRun was true and
// document.getElementById('dry-run-pill') was null: _paintDryRunPill returned
// early because `.titlebar-left` was missing. A safety indicator that can
// silently not appear is a defect in the safety feature, so the real function is
// lifted and run against a DOM with and without the titlebar host.

// Minimal DOM: only what _paintDryRunPill touches.
function domStub({ titlebar }) {
  const created = []
  const bodyClasses = new Set()
  const host = titlebar ? { children: [], appendChild(c) { this.children.push(c) } } : null
  const body = {
    children: [],
    appendChild(c) { this.children.push(c) },
    classList: { add: c => bodyClasses.add(c), contains: c => bodyClasses.has(c) },
  }
  return {
    host, body, bodyClasses,
    document: {
      body,
      getElementById: id => created.find(e => e.id === id) || null,
      querySelector: sel => (sel === '.titlebar-left' ? host : null),
      createElement: () => {
        const el = { id: '', className: '', textContent: '', title: '', style: { cssText: '' } }
        created.push(el)
        return el
      },
    },
  }
}

// Lift the REAL function and compile it in a context whose only global is the
// stub document, so the test exercises the shipped body rather than a copy.
function liftPaintPill(dom) {
  const R = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const start = R.indexOf('function _paintDryRunPill()')
  assert.ok(start > -1, '_paintDryRunPill not found in the renderer')
  let depth = 0
  let end = -1
  for (let j = R.indexOf('{', start); j < R.length; j++) {
    if (R[j] === '{') depth++
    else if (R[j] === '}') { depth--; if (!depth) { end = j + 1; break } }
  }
  assert.ok(end > -1, 'unbalanced braces in _paintDryRunPill')
  const ctx = { console, document: dom.document }
  vm.createContext(ctx)
  vm.runInContext(R.slice(start, end), ctx)
  return ctx._paintDryRunPill
}

test('the DRY RUN pill renders inside the titlebar when the titlebar is there', () => {
  const dom = domStub({ titlebar: true })
  liftPaintPill(dom)()

  assert.strictEqual(dom.host.children.length, 1, 'the pill goes in the titlebar')
  assert.strictEqual(dom.host.children[0].textContent, 'DRY RUN')
  assert.strictEqual(dom.host.children[0].id, 'dry-run-pill')
  assert.strictEqual(dom.body.children.length, 0, 'and not also on body')
  assert.ok(dom.bodyClasses.has('is-dry-run'), 'body must carry is-dry-run')
})

test('the DRY RUN pill still renders when .titlebar-left is missing', () => {
  const dom = domStub({ titlebar: false })
  liftPaintPill(dom)()

  assert.strictEqual(dom.body.children.length, 1,
    'with no titlebar the pill must fall back to document.body, not vanish')
  const pill = dom.body.children[0]
  assert.strictEqual(pill.id, 'dry-run-pill')
  assert.strictEqual(pill.textContent, 'DRY RUN')
  assert.match(pill.style.cssText, /position:fixed/, 'the fallback must be fixed-position')
  assert.match(pill.style.cssText, /z-index:\s*9\d\d+/, 'and sit above the deck')
  assert.ok(dom.bodyClasses.has('is-dry-run'),
    'the body class must be set regardless of the host')
})

test('_paintDryRunPill is idempotent — a second call adds no second pill', () => {
  for (const titlebar of [true, false]) {
    const dom = domStub({ titlebar })
    const paint = liftPaintPill(dom)
    paint(); paint()
    const where = titlebar ? dom.host.children : dom.body.children
    assert.strictEqual(where.length, 1, `two calls, one pill (titlebar=${titlebar})`)
  }
})
