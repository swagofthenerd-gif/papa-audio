'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SideStore } = require('../side-store')

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'papa-side-'))
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms))

function store(extra = {}) {
  const dir = tmpdir()
  const errors = []
  const s = new SideStore({ dir, name: 'playback-state', debounceMs: 10, maxDelayMs: 60, onError: e => errors.push(e), ...extra })
  return { s, dir, errors }
}

test('a missing file reads as the fallback, not a crash', () => {
  const { s } = store({ fallback: { position: 0 } })
  assert.deepStrictEqual(s.get(), { position: 0 })
})

test('a value survives a write and a fresh reader', async () => {
  const { s, dir } = store()
  s.set({ filePath: '/music/a.flac', position: 85.2 })
  await s.flush()
  const reader = new SideStore({ dir, name: 'playback-state' })
  assert.deepStrictEqual(reader.get(), { filePath: '/music/a.flac', position: 85.2 })
})

test('the file is read once, not on every get', () => {
  const { s } = store()
  s.set({ a: 1 })
  for (let i = 0; i < 50; i++) s.get()
  assert.strictEqual(s.stats.loads, 1)
})

test('a burst of writes becomes one write', async () => {
  // This is the point: save-playback-state was called repeatedly during
  // playback and each call rewrote the whole 2.5 MB config synchronously.
  const { s } = store()
  for (let i = 0; i < 100; i++) s.set({ position: i })
  await s.flush()
  assert.strictEqual(s.stats.writes, 1, `expected one write, got ${s.stats.writes}`)
  assert.ok(s.stats.coalesced >= 99)
  assert.deepStrictEqual(s.get(), { position: 99 })
})

test('a steady stream of writes cannot postpone the write forever', async () => {
  // A debounce with no ceiling can be deferred indefinitely — the same bug the
  // catalogue records for the library watcher's debounce.
  const { s } = store({ debounceMs: 15, maxDelayMs: 50 })
  const started = Date.now()
  let ticks = 0
  while (Date.now() - started < 200) {
    s.set({ position: ++ticks })
    await settle(5)
  }
  assert.ok(s.stats.writes >= 1, 'a continuous stream still has to reach the disk')
  await s.flush()
  assert.deepStrictEqual(s.get(), { position: ticks })
})

test('the write is atomic, so a reader never sees a half-written file', async () => {
  const { s, dir } = store()
  s.set({ big: 'x'.repeat(200000) })
  await s.flush()
  // The temp file must be gone, and the real file must parse.
  assert.strictEqual(fs.existsSync(path.join(dir, 'playback-state.json.tmp')), false)
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'playback-state.json'), 'utf8')))
})

test('a value that changes mid-write still lands', async () => {
  const { s } = store()
  s.set({ position: 1 })
  const first = s._write()          // start a write
  s.set({ position: 2 })            // change it while that write is in flight
  await first
  await s.flush()
  const reader = new SideStore({ dir: s.dir, name: 'playback-state' })
  assert.deepStrictEqual(reader.get(), { position: 2 }, 'the newest value must win')
})

test('a corrupt file is reported and falls back, rather than crashing or being silently replaced', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'library-cache.json'), '{ this is not json')
  const errors = []
  const s = new SideStore({ dir, name: 'library-cache', fallback: [], onError: e => errors.push(e) })
  assert.deepStrictEqual(s.get(), [])
  assert.strictEqual(errors.length, 1)
  assert.match(errors[0].message, /unreadable/)
})

test('a write failure is reported and does not throw at the caller', async () => {
  const { s, errors } = store({ dir: path.join(tmpdir(), 'x') })
  // Make the directory unwritable by putting a file where the directory goes.
  fs.writeFileSync(s.dir, 'not a directory')
  s.set({ position: 1 })
  await s.flush()
  // The load also complains here (the path's parent is a file, so ENOTDIR), and
  // that is correct: only a missing file is unremarkable. What matters is that
  // the write failure was reported and nothing was thrown at the caller.
  assert.ok(errors.some(e => /write failed/.test(e.message)),
    `expected a write failure, got: ${errors.map(e => e.message).join(' | ')}`)
  // And the in-memory value is still correct, so the app is not confused too.
  assert.deepStrictEqual(s.get(), { position: 1 })
})

test('update() reads and writes the value in one step', async () => {
  const { s } = store({ fallback: [] })
  s.update(v => [...v, 'a'])
  s.update(v => [...v, 'b'])
  await s.flush()
  assert.deepStrictEqual(s.get(), ['a', 'b'])
})

test('flushSync writes a pending value on the way out', () => {
  // will-quit and the signal handler cannot await, and a position saved a
  // moment before quitting is exactly the value worth not losing.
  const { s, dir } = store()
  s.set({ filePath: '/music/a.flac', position: 85.2 })
  assert.strictEqual(s.flushSync(), true)
  const reader = new SideStore({ dir, name: 'playback-state' })
  assert.deepStrictEqual(reader.get(), { filePath: '/music/a.flac', position: 85.2 })
})

test('flushSync with nothing pending does nothing', async () => {
  const { s } = store()
  s.set({ position: 1 })
  await s.flush()
  assert.strictEqual(s.flushSync(), false)
})

test('flushSync leaves no temp file behind', () => {
  const { s, dir } = store()
  s.set({ position: 7 })
  s.flushSync()
  assert.strictEqual(fs.existsSync(path.join(dir, 'playback-state.json.tmp')), false)
})

// ── Migration out of the shared config ───────────────────────────────────────

test('a legacy value is adopted when this store has no file yet', async () => {
  const { s } = store()
  assert.strictEqual(s.adoptIfEmpty({ filePath: '/music/old.flac', position: 12 }), true)
  await s.flush()
  assert.deepStrictEqual(s.get(), { filePath: '/music/old.flac', position: 12 })
})

test('a legacy value can never overwrite what the app has already written', async () => {
  const { s, dir } = store()
  s.set({ position: 99 })
  await s.flush()
  const second = new SideStore({ dir, name: 'playback-state' })
  assert.strictEqual(second.adoptIfEmpty({ position: 1 }), false,
    'a stale config value must not resurrect over newer data on a second run')
  assert.deepStrictEqual(second.get(), { position: 99 })
})

test('nothing to adopt is not an adoption', () => {
  const { s } = store()
  assert.strictEqual(s.adoptIfEmpty(undefined), false)
  assert.strictEqual(s.adoptIfEmpty(null), false)
  assert.strictEqual(s.fileExists(), false)
})

test('a store needs somewhere to live', () => {
  assert.throws(() => new SideStore({}), /needs a dir and a name/)
  assert.throws(() => new SideStore({ dir: '/tmp' }), /needs a dir and a name/)
})
