'use strict'
// One unit, everywhere: MB/s, where 1 MB is 1,000,000 bytes.
//
// The app used to contradict itself about this in three places — a box labelled
// "Kbps" that stored kilobytes, under a hint that divided by 8192 as if it were
// kilobits. Every number the user types for Soulseek now goes through one
// conversion, at one edge, and this file is what holds that edge still.
//
// slskd's own speed_limit is in KIBIbytes per second (1024 bytes), which is not
// the same number, which is exactly why it is converted once here rather than
// guessed at each call site. Verified against the installed slskd 0.26.0.0:
// writing `transfers.upload.speed_limit: 977` showed up as speedLimit 977 in
// GET /api/v0/options.
//
// The real functions are lifted out of main.js and run. Nothing is touched.

const test = require('node:test')
const assert = require('node:assert')

const { liftFns } = require('./helpers/lift-main-fn.js')

function limits(stored) {
  const { fns } = liftFns(
    ['_slskUploadLimit', '_slskSpeedLimitKiB', '_slskUploadLimitText', '_slskNumberOrNull'], {
      store: { get: (_k, d) => (stored === undefined ? d : stored) },
    }, ['SLSK_UPLOAD_SLOTS_MIN', 'SLSK_UPLOAD_SLOTS_MAX', 'SLSK_UPLOAD_SLOTS_DEFAULT',
      'SLSK_UPLOAD_MBPS_MAX'])
  // The answer is built inside the vm context, so it belongs to a different
  // realm's Object and would never be reference-equal. Copied out once, here,
  // rather than every assertion having to remember.
  const limit = (patch) => Object.assign({}, fns._slskUploadLimit(patch))
  return { limit, kib: fns._slskSpeedLimitKiB, text: fns._slskUploadLimitText }
}

// ── The defaults ────────────────────────────────────────────────────────────

test('the shipped default is four slots and no speed cap', () => {
  const f = limits(undefined)
  assert.deepStrictEqual(f.limit(), { slots: 4, mbps: 0 })
})

test('no cap means no speed_limit key at all, not a limit of zero', () => {
  // A zero written into the file would mean nobody can take anything, which is
  // not what an empty box means. The key is omitted instead.
  const f = limits(null)
  assert.strictEqual(f.kib(0), 0)
})

// ── The conversion ──────────────────────────────────────────────────────────

test('1 MB/s is 977 kibibytes per second', () => {
  const f = limits(null)
  assert.strictEqual(f.kib(1), 977)
})

test('half a megabyte a second is 488', () => {
  const f = limits(null)
  assert.strictEqual(f.kib(0.5), 488)
})

test('a number that is not a number is read as no cap, never as a cap of zero', () => {
  const f = limits(null)
  for (const bad of [NaN, -1, -0.5, 'fast', null, undefined, Infinity]) {
    assert.strictEqual(f.kib(bad), 0, String(bad) + ' must mean no cap')
  }
})

test('a negative or unreadable speed is stored as no cap, not passed along', () => {
  // The conversion refuses these too, but it must never see them: what gets
  // WRITTEN DOWN is what the settings row reads back and what the next config
  // write uses, so a -1 surviving into the store would show up as a cap.
  const f = limits(null)
  for (const bad of [-1, -0.5, NaN, 'fast', Infinity, null, undefined, '']) {
    assert.strictEqual(f.limit({ mbps: bad }).mbps, 0, String(bad) + ' must be stored as no cap')
  }
})

test('a cap so small it rounds to nothing is still a cap of one, not of none', () => {
  // 0.0001 MB/s rounds to 0 KiB/s. Writing 0 would mean "no cap" to the caller
  // and "nobody may upload" to nobody at all — so the floor is 1.
  const f = limits(null)
  assert.strictEqual(f.kib(0.0001), 1)
})

// ── The slot count ──────────────────────────────────────────────────────────

test('slots are clamped to between one and twenty', () => {
  const f = limits(null)
  assert.strictEqual(f.limit({ slots: 0 }).slots, 1)
  assert.strictEqual(f.limit({ slots: -5 }).slots, 1)
  assert.strictEqual(f.limit({ slots: 21 }).slots, 20)
  assert.strictEqual(f.limit({ slots: 500 }).slots, 20)
  assert.strictEqual(f.limit({ slots: 7 }).slots, 7)
})

test('a slot count that is not a number falls back to the default rather than to zero', () => {
  // Zero slots would mean nobody can ever take anything from him — a silent
  // off switch he never asked for.
  const f = limits(null)
  for (const bad of [NaN, 'lots', null, undefined, {}]) {
    assert.strictEqual(f.limit({ slots: bad }).slots, 4, String(bad))
  }
})

test('a fractional slot count becomes a whole one', () => {
  const f = limits(null)
  assert.strictEqual(f.limit({ slots: 4.6 }).slots, 5)
})

test('changing one number leaves the other alone', () => {
  const f = limits({ slots: 9, mbps: 2 })
  assert.deepStrictEqual(f.limit({ mbps: 3 }), { slots: 9, mbps: 3 })
  assert.deepStrictEqual(f.limit({ slots: 2 }), { slots: 2, mbps: 2 })
})

// ── What he is told ─────────────────────────────────────────────────────────

test('the line under the boxes says the numbers back in plain words', () => {
  const f = limits(null)
  assert.strictEqual(f.text({ slots: 4, mbps: 0 }),
    'Right now: 4 people at a time, no speed limit.')
  assert.strictEqual(f.text({ slots: 1, mbps: 1.5 }),
    'Right now: 1 person at a time, 1.5 MB/s all together.')
})

test('the speed is shown to one decimal, in the one unit the app uses', () => {
  const f = limits(null)
  const text = f.text({ slots: 4, mbps: 2 })
  assert.match(text, /2\.0 MB\/s/)
  assert.ok(!/Kbps|kbps|KB\/s/.test(text), 'no box anywhere says Kbps after this')
})
