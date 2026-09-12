'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// The normalizer is a pure function of a response object, so it is extracted and
// run for real — the whole point is what shape it guarantees, and a static match
// could not catch a wrong field name.
function loadNormalizer() {
  const start = MAIN.indexOf('function normalizeSearchResponse(resp)')
  const end = MAIN.indexOf('function normalizeSearchResponses(')
  const one = MAIN.slice(start, end)
  const two = MAIN.slice(end, MAIN.indexOf('\n}', end) + 2)
  // eslint-disable-next-line no-new-func
  return new Function(one + '\n' + two + '\n; return { normalizeSearchResponse, normalizeSearchResponses }')()
}

const { normalizeSearchResponse, normalizeSearchResponses } = loadNormalizer()

test('hasFreeUploadSlot is guaranteed a boolean from whichever field slskd set', () => {
  // The boolean form slskd sends now.
  assert.equal(normalizeSearchResponse({ hasFreeUploadSlot: true }).hasFreeUploadSlot, true)
  assert.equal(normalizeSearchResponse({ hasFreeUploadSlot: false }).hasFreeUploadSlot, false)
  // The legacy numeric form: freeUploadSlots > 0 means yes.
  assert.equal(normalizeSearchResponse({ freeUploadSlots: 2 }).hasFreeUploadSlot, true)
  assert.equal(normalizeSearchResponse({ freeUploadSlots: 0 }).hasFreeUploadSlot, false)
  // Neither present: a definite false, not undefined.
  assert.equal(normalizeSearchResponse({}).hasFreeUploadSlot, false)
})

test('queueLength and uploadSpeed are always numbers', () => {
  const r = normalizeSearchResponse({})
  assert.strictEqual(r.queueLength, 0)
  assert.strictEqual(r.uploadSpeed, 0)
  const r2 = normalizeSearchResponse({ queueLength: '17', uploadSpeed: '2048' })
  assert.strictEqual(r2.queueLength, 17)
  assert.strictEqual(r2.uploadSpeed, 2048)
})

test('quality fields are surfaced on files when present, absent otherwise', () => {
  const r = normalizeSearchResponse({
    files: [
      { filename: 'a.flac', size: 1, bitRate: 1000, bitDepth: 24, sampleRate: 96000 },
      { filename: 'b.mp3', size: 2 },
    ],
  })
  assert.deepEqual(
    { bitRate: r.files[0].bitRate, bitDepth: r.files[0].bitDepth, sampleRate: r.files[0].sampleRate },
    { bitRate: 1000, bitDepth: 24, sampleRate: 96000 })
  assert.equal('bitRate' in r.files[1], false, 'a file without a bitrate is not stamped with 0')
  assert.equal('bitDepth' in r.files[1], false)
})

test('existing fields the renderer already reads are left untouched', () => {
  const r = normalizeSearchResponse({
    username: 'alice', token: 42, lockedFileCount: 3,
    files: [{ filename: 'x\\y\\z.flac', size: 555 }],
  })
  assert.equal(r.username, 'alice')
  assert.equal(r.token, 42)
  assert.equal(r.lockedFileCount, 3)
  assert.equal(r.files[0].filename, 'x\\y\\z.flac', 'filenames are not rewritten')
  assert.equal(r.files[0].size, 555)
})

test('normalizeSearchResponses maps a whole list and tolerates empties', () => {
  assert.deepEqual(normalizeSearchResponses(null), [])
  assert.deepEqual(normalizeSearchResponses([]), [])
  const out = normalizeSearchResponses([{ hasFreeUploadSlot: true, files: [] }])
  assert.equal(out.length, 1)
  assert.equal(out[0].hasFreeUploadSlot, true)
})

// ── the new Soulseek IPC surface is wired ────────────────────────────────────

test('the new channels are declared in main, preload and the timeout table', () => {
  const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  for (const ch of ['slsk-wishlist-run', 'slsk-unbench-peers', 'slsk-friend-diffs', 'slsk-respread-backlog']) {
    assert.ok(MAIN.includes(`ipcMain.handle('${ch}'`), 'main missing handler ' + ch)
  }
  for (const m of ['slskWishlistRun', 'slskUnbenchPeers', 'slskFriendDiffs', 'slskRespreadBacklog', 'onSlskWishlistHit']) {
    assert.ok(PRELOAD.includes(m), 'preload missing ' + m)
  }
  // slsk-wishlist-run runs a long sequential sweep, so it must be exempted from
  // the 60 s default rather than being killed mid-sweep.
  assert.match(MAIN, /'slsk-wishlist-run': \d{6,}/, 'wishlist sweep needs a generous budget')
})

test('the search core is factored so the hunter shares it', () => {
  assert.match(MAIN, /async function slskRunSearch\(/, 'the core must be a named function')
  // App #53 inserted a serve-then-revalidate layer (slskServeSearch) between the
  // handler and the core: it serves persisted results instantly, then falls
  // through to the same slskRunSearch core the hunter shares.
  assert.match(MAIN, /ipcMain\.handle\('slsk-search', \(_, args\) => \{[\s\S]{0,400}return slskServeSearch\(args\)/,
    'the handler is a thin wrapper over the serve layer')
  assert.match(MAIN, /function slskServeSearch[\s\S]{0,800}slskRunSearch\(args\)/,
    'the serve layer falls through to the shared core')
  // The hunter's search calls the core with noCache, so the 5-min cache never
  // serves it a stale empty.
  const sweep = MAIN.slice(MAIN.indexOf('async function slskWishlistSweep'),
                           MAIN.indexOf('ipcMain.handle(\'slsk-wishlist-run\''))
  assert.match(sweep, /slskRunSearch\(\{ query, timeoutMs: \d+, noCache: true/,
    'the sweep must pass noCache so it never reads a stale cached result')
})
