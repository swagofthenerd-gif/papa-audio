'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'local-store.js'), 'utf8')

// A localStorage that can be told to misbehave the way real ones do.
function load(opts = {}) {
  const data = new Map(Object.entries(opts.data || {}))
  const logged = []
  const storage = {
    getItem: k => {
      if (opts.throwOnRead) throw new Error('SecurityError: storage disabled')
      return data.has(k) ? data.get(k) : null
    },
    setItem: (k, v) => {
      if (opts.throwOnWrite) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e }
      data.set(k, v)
    },
    removeItem: k => { data.delete(k) },
  }
  // Loaded in this realm, not a vm context: values built inside a vm are
  // instances of that realm's Array and Object, and deepStrictEqual compares
  // prototypes. The module only touches `window` and `console`, so both can be
  // passed in.
  const win = { localStorage: storage }
  const fakeConsole = { error: (...a) => logged.push(a.join(' ')) }
  new Function('window', 'console', SRC)(win, fakeConsole)
  return { L: win.PapaLocal, data, logged }
}

// ── The shapes JSON.parse accepts that callers cannot use ────────────────────

test('readArray always returns an array', () => {
  // JSON.parse succeeds for "null", "{}" and "5" — none of which have .filter.
  // A bare parse guards against a syntax error and nothing else.
  for (const stored of ['null', '{}', '5', '"a string"', 'true', '[]']) {
    const { L } = load({ data: { k: stored } })
    assert.ok(Array.isArray(L.readArray('k')), `readArray on ${stored}`)
  }
})

test('readObject always returns a plain object, and rejects arrays', () => {
  for (const stored of ['null', '[]', '[1,2]', '5', '"s"', 'true']) {
    const { L } = load({ data: { k: stored } })
    const v = L.readObject('k')
    assert.strictEqual(typeof v, 'object')
    assert.ok(!Array.isArray(v), `readObject on ${stored} must not be an array`)
    assert.deepStrictEqual(v, {})
  }
})

test('valid data comes back untouched', () => {
  const { L } = load({ data: { arr: '[1,2,3]', obj: '{"a":1}' } })
  assert.deepStrictEqual(L.readArray('arr'), [1, 2, 3])
  assert.deepStrictEqual(L.readObject('obj'), { a: 1 })
})

test('a missing key is the default, not an error', () => {
  const { L, logged } = load()
  assert.deepStrictEqual(L.readArray('nope'), [])
  assert.deepStrictEqual(L.readObject('nope'), {})
  assert.deepStrictEqual(logged, [], 'absence is normal and must not be noisy')
})

test('malformed JSON is reported and falls back', () => {
  // The silence is what made the keyboard-unbinding bug so hard to see.
  const { L, logged } = load({ data: { k: '{not json' } })
  assert.deepStrictEqual(L.readArray('k'), [])
  assert.strictEqual(logged.length, 1)
  assert.match(logged[0], /k is not valid JSON/)
})

test('a wrong-shaped value is reported too', () => {
  const { L, logged } = load({ data: { k: '{"a":1}' } })
  assert.deepStrictEqual(L.readArray('k'), [])
  assert.match(logged[0], /should be an array, found an object/)
})

test('one bad member does not discard the whole list', () => {
  const { L } = load({ data: { k: '["a", 5, "b", null, "c"]' } })
  const kept = L.readArray('k', x => typeof x === 'string' && x)
  assert.deepStrictEqual(kept, ['a', 'b', 'c'])
})

test('a validator that throws rejects only that member', () => {
  const { L } = load({ data: { k: '[{"a":1},null,{"a":2}]' } })
  const kept = L.readArray('k', x => x.a > 0)   // throws on null
  assert.deepStrictEqual(kept, [{ a: 1 }, { a: 2 }])
})

// ── Storage that is not available at all ─────────────────────────────────────

test('storage disabled entirely reads as the default rather than throwing', () => {
  // Private windows and blocked site data both throw on access, and this module
  // is called from the top level of renderer.js.
  const { L } = load({ throwOnRead: true })
  assert.doesNotThrow(() => L.readArray('k'))
  assert.deepStrictEqual(L.readArray('k'), [])
  assert.deepStrictEqual(L.readObject('k'), {})
})

test('a failed write is reported and returns false, not thrown', () => {
  const { L, logged } = load({ throwOnWrite: true })
  assert.strictEqual(L.write('k', [1]), false)
  assert.match(logged[0], /could not save k/)
})

test('a successful write round-trips', () => {
  const { L } = load()
  assert.strictEqual(L.write('k', { a: [1, 2] }), true)
  assert.deepStrictEqual(L.readObject('k'), { a: [1, 2] })
})

// ── Raw text access, for video-store's corruption quarantine ─────────────────

test('readRaw hands back the stored text verbatim, corrupt or not', () => {
  const { L } = load({ data: { k: '{not json' } })
  assert.strictEqual(L.readRaw('k'), '{not json')
  assert.strictEqual(L.readRaw('missing'), null)
})

test('readRaw with storage disabled is null, not a throw', () => {
  const { L } = load({ throwOnRead: true })
  assert.strictEqual(L.readRaw('k'), null)
})

test('writeRaw stores text without JSON encoding', () => {
  const { L, data } = load()
  assert.strictEqual(L.writeRaw('k', '{truncated blob'), true)
  // Byte-for-byte: no stringify wrapping, so a quarantined blob stays
  // exactly what was on disk.
  assert.strictEqual(data.get('k'), '{truncated blob')
})

test('a failed writeRaw is reported and returns false, not thrown', () => {
  const { L, logged } = load({ throwOnWrite: true })
  assert.strictEqual(L.writeRaw('k', 'text'), false)
  assert.match(logged[0], /could not save k/)
})

// ── push, which replaces read-push-slice-write at four call sites ────────────

test('push appends and caps, keeping the newest', () => {
  const { L } = load({ data: { k: '[1,2,3]' } })
  const out = L.push('k', 4, 3)
  assert.deepStrictEqual(out, [2, 3, 4])
  assert.deepStrictEqual(L.readArray('k'), [2, 3, 4])
})

test('push onto a corrupt key starts a fresh list rather than throwing', () => {
  const { L } = load({ data: { k: 'garbage' } })
  assert.deepStrictEqual(L.push('k', 'first', 10), ['first'])
})

test('push with no cap keeps everything', () => {
  const { L } = load({ data: { k: '[1]' } })
  assert.deepStrictEqual(L.push('k', 2), [1, 2])
})
