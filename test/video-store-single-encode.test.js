'use strict'
// App #45: video-store.json is single-encoded (a native object), not a JSON
// string inside JSON, while the renderer's bridge contract stays string-based.
// The migration and the two bridge shape helpers live inside main.js at module
// scope; they are extracted by source-slicing (the pattern main-guards uses) and
// exercised against a REAL SideStore in a temp dir, because the whole point is
// what actually lands on disk.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SideStore } = require('../side-store')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function extract(name, fromMarker, toMarker) {
  const start = MAIN.indexOf(fromMarker)
  const end = MAIN.indexOf(toMarker, start + fromMarker.length)
  assert.ok(start > -1 && end > start, `could not slice ${name}`)
  return MAIN.slice(start, end)
}

// The migration function, plus the two bridge helpers, compiled together so they
// can be driven directly. fs is injected; nothing else in the slices is needed.
function loadHelpers() {
  const migration = extract('migration',
    'function _migrateVideoStoreSingleEncode(side) {',
    '\ntry {')
  const readText = extract('read helper',
    'function _videoStoreReadText(value) {',
    'function _videoStoreWriteValue(text) {')
  const writeValue = extract('write helper',
    'function _videoStoreWriteValue(text) {',
    'ipcMain.handle(\'video-store-read\'')
  const src = migration + '\n' + readText + '\n' + writeValue +
    '\nreturn { _migrateVideoStoreSingleEncode, _videoStoreReadText, _videoStoreWriteValue }'
  // eslint-disable-next-line no-new-func
  return new Function('fs', src)(fs)
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-vs-'))
  const side = new SideStore({ dir, name: 'video-store', fallback: null })
  return { dir, side }
}

const BLOB = { items: { 'movie:27205': { id: '27205', position: 12, watched: false } }, watchlist: [], skip: {}, prefs: {} }

test('a double-encoded string value is migrated to a native object', async () => {
  const { side } = tempStore()
  const { _migrateVideoStoreSingleEncode } = loadHelpers()
  // The old shape: the renderer's blob is JSON.stringify'd, and that STRING is
  // what the SideStore held (which it then JSON.stringifies again to disk).
  side.set(JSON.stringify(BLOB))
  await side.flush()

  const changed = _migrateVideoStoreSingleEncode(side)
  assert.strictEqual(changed, true, 'a double-encoded value is migrated')
  await side.flush()

  // The in-memory value is now the object itself.
  assert.deepStrictEqual(side.get(), BLOB)
  // And the file is single-encoded: parse once → the object (no inner string).
  const onDisk = JSON.parse(fs.readFileSync(side.file, 'utf8'))
  assert.deepStrictEqual(onDisk, BLOB, 'the file holds the object, not a quoted string')
})

test('the migration keeps a one-time .pre-single-encode backup of the original', async () => {
  const { side } = tempStore()
  const { _migrateVideoStoreSingleEncode } = loadHelpers()
  side.set(JSON.stringify(BLOB))
  await side.flush()
  const original = fs.readFileSync(side.file, 'utf8')

  _migrateVideoStoreSingleEncode(side)
  await side.flush()

  const bak = `${side.file}.pre-single-encode`
  assert.ok(fs.existsSync(bak), 'a backup is written beside the file')
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), original,
    'the backup is the untouched original (double-encoded)')
})

test('the migration is idempotent — a second run is a no-op and does not clobber the backup', async () => {
  const { side } = tempStore()
  const { _migrateVideoStoreSingleEncode } = loadHelpers()
  side.set(JSON.stringify(BLOB))
  await side.flush()

  assert.strictEqual(_migrateVideoStoreSingleEncode(side), true)
  await side.flush()
  const bak = `${side.file}.pre-single-encode`
  const bakAfterFirst = fs.readFileSync(bak, 'utf8')

  // Second run: the value is already an object, so nothing changes.
  assert.strictEqual(_migrateVideoStoreSingleEncode(side), false, 'no-op the second time')
  await side.flush()
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), bakAfterFirst,
    'the original backup is preserved, not overwritten with migrated data')
  assert.deepStrictEqual(side.get(), BLOB)
})

test('a native-object value (fresh install) needs no migration', async () => {
  const { side } = tempStore()
  const { _migrateVideoStoreSingleEncode } = loadHelpers()
  side.set(BLOB) // already single-encoded
  await side.flush()
  assert.strictEqual(_migrateVideoStoreSingleEncode(side), false)
})

test('an unparseable string is left untouched (nothing is lost)', async () => {
  const { side } = tempStore()
  const { _migrateVideoStoreSingleEncode } = loadHelpers()
  side.set('not json at all')
  await side.flush()
  assert.strictEqual(_migrateVideoStoreSingleEncode(side), false)
  assert.strictEqual(side.get(), 'not json at all')
})

// ── The bridge string contract survives single-encoding ──────────────────────

test('read returns a JSON string the renderer can parse back to the blob', () => {
  const { _videoStoreReadText } = loadHelpers()
  // After migration the store holds an object; read must still hand back text.
  const text = _videoStoreReadText(BLOB)
  assert.strictEqual(typeof text, 'string')
  assert.deepStrictEqual(JSON.parse(text), BLOB)
})

test('read passes a legacy string through unchanged, and null stays null', () => {
  const { _videoStoreReadText } = loadHelpers()
  assert.strictEqual(_videoStoreReadText(JSON.stringify(BLOB)), JSON.stringify(BLOB))
  assert.strictEqual(_videoStoreReadText(null), null)
})

test('write parses the renderer text and stores the OBJECT', () => {
  const { _videoStoreWriteValue } = loadHelpers()
  const stored = _videoStoreWriteValue(JSON.stringify(BLOB))
  assert.deepStrictEqual(stored, BLOB, 'stored natively, not as a string')
  assert.strictEqual(typeof stored, 'object')
})

test('write keeps unparseable text verbatim rather than dropping it', () => {
  const { _videoStoreWriteValue } = loadHelpers()
  assert.strictEqual(_videoStoreWriteValue('garbage'), 'garbage')
})

test('write→read round-trips exactly, so the renderer sees no change', () => {
  const { _videoStoreWriteValue, _videoStoreReadText } = loadHelpers()
  const incoming = JSON.stringify(BLOB)
  const stored = _videoStoreWriteValue(incoming)  // object, stored natively
  const outgoing = _videoStoreReadText(stored)    // back to a string
  assert.deepStrictEqual(JSON.parse(outgoing), JSON.parse(incoming))
})
