'use strict'
// 20 fast Nexts over YouTube-backed tracks used to resolve every skipped track
// (43 yt-dlp resolves) and the audible title lagged 4.5 s. Only the newest load
// after a short settle may resolve; an older one answers superseded. The real
// handler and its generation counter are lifted together into one sandbox so
// two loads share the counter the way they do in main.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift() {
  const start = MAIN.indexOf('let _playerLoadGen = 0')
  assert.ok(start > -1, 'the load generation counter must exist')
  const end = MAIN.indexOf('\n})\n', MAIN.indexOf("ipcMain.handle('player-load'", start)) + 4
  const resolved = []
  let handler = null
  const sandbox = {
    setTimeout, console,
    ipcMain: { handle: (_, fn) => { handler = fn } },
    extractVideoId: p => (/youtube|watch\?v=/.test(p) ? 'vid' : null),
    _resolvePlayerPath: async p => { resolved.push(p); return p },
    applyLoudnessGain: async () => {},
    wrap: fn => async () => { await fn(); return { ok: true } },
    player: { load: async () => {} },
  }
  vm.runInNewContext(MAIN.slice(start, end), sandbox)
  assert.ok(handler, 'handler captured')
  return { load: (p) => handler({}, { path: p, play: true }), resolved }
}

test('a YouTube load superseded during the settle never reaches the resolver', async () => {
  const h = lift()
  const [ra, rb] = await Promise.all([h.load('https://youtube.com/watch?v=a'), h.load('https://youtube.com/watch?v=b')])
  assert.deepEqual(ra, { ok: false, superseded: true })   // vm realm: not strict-equal by prototype
  assert.strictEqual(rb.ok, true)
  assert.deepStrictEqual(h.resolved, ['https://youtube.com/watch?v=b'], 'only the newest track is resolved')
})

test('a local file loads at once, no settle', async () => {
  const h = lift()
  const t0 = Date.now()
  const r = await h.load('/mnt/data/MUSIC/a.flac')
  assert.strictEqual(r.ok, true)
  assert.ok(Date.now() - t0 < 150, 'local loads must not wait')
  assert.deepStrictEqual(h.resolved, ['/mnt/data/MUSIC/a.flac'])
})
