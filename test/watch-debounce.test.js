'use strict'
const test = require('node:test')
const assert = require('node:assert')
const wd = require('../src/watch-debounce')

test('pathInside recognises a child and the directory itself', () => {
  assert.strictEqual(wd.pathInside('/music/rock/a.flac', '/music'), true)
  assert.strictEqual(wd.pathInside('/music', '/music'), true)
})

test('pathInside guards the prefix-sibling false positive', () => {
  // "/music" must not swallow "/musicXL".
  assert.strictEqual(wd.pathInside('/musicXL/a.flac', '/music'), false)
})

test('pathInside tolerates a trailing separator on the parent', () => {
  assert.strictEqual(wd.pathInside('/music/dl/x.flac', '/music/'), true)
})

test('downloadsInsideWatched is true only when a root contains the download dir', () => {
  assert.strictEqual(
    wd.downloadsInsideWatched('/music/Downloads', ['/other', '/music']), true)
  assert.strictEqual(
    wd.downloadsInsideWatched('/elsewhere/Downloads', ['/music']), false)
  assert.strictEqual(wd.downloadsInsideWatched('/music/Downloads', null), false)
})

test('chooseDebounce uses the short window for ordinary edits', () => {
  assert.strictEqual(
    wd.chooseDebounce({ activeDownloads: false, downloadsInsideWatchedRoot: false }),
    wd.NORMAL_DEBOUNCE_MS)
  // A download active but landing OUTSIDE the watched roots is still ordinary.
  assert.strictEqual(
    wd.chooseDebounce({ activeDownloads: true, downloadsInsideWatchedRoot: false }),
    wd.NORMAL_DEBOUNCE_MS)
})

test('chooseDebounce hardens only when downloading AND downloads are inside a root', () => {
  assert.strictEqual(
    wd.chooseDebounce({ activeDownloads: true, downloadsInsideWatchedRoot: true }),
    wd.DOWNLOAD_DEBOUNCE_MS)
  assert.strictEqual(wd.DOWNLOAD_DEBOUNCE_MS, 30000, 'the hard window is 30 s per the spec')
})

test('chooseMaxWait matches the same conditions', () => {
  assert.strictEqual(
    wd.chooseMaxWait({ activeDownloads: false, downloadsInsideWatchedRoot: false }),
    wd.NORMAL_MAX_WAIT_MS)
  assert.strictEqual(
    wd.chooseMaxWait({ activeDownloads: true, downloadsInsideWatchedRoot: true }),
    wd.DOWNLOAD_MAX_WAIT_MS)
  assert.ok(wd.DOWNLOAD_MAX_WAIT_MS > wd.DOWNLOAD_DEBOUNCE_MS,
    'the ceiling must exceed the debounce or it could never elapse')
})

test('shouldRunNow forces a scan once the first event passes the ceiling', () => {
  const first = 1_000_000
  assert.strictEqual(
    wd.shouldRunNow({ firstEventAt: first, now: first + 5000, maxWaitMs: 30000 }),
    false, 'still within the ceiling → keep deferring')
  assert.strictEqual(
    wd.shouldRunNow({ firstEventAt: first, now: first + 30000, maxWaitMs: 30000 }),
    true, 'at the ceiling → run now')
  assert.strictEqual(
    wd.shouldRunNow({ firstEventAt: first, now: first + 40000, maxWaitMs: 30000 }),
    true, 'past the ceiling → run now')
})

test('shouldRunNow never forces when no burst is in progress', () => {
  assert.strictEqual(wd.shouldRunNow({ firstEventAt: 0, now: 9e12, maxWaitMs: 1 }), false)
})

test('a download burst inside a root defers far longer before the ceiling forces it', () => {
  // 40 s into a download storm inside a watched root, the NORMAL ceiling would
  // have already forced a scan; the hardened ceiling has not.
  const cond = { activeDownloads: true, downloadsInsideWatchedRoot: true }
  const first = 500_000
  const now = first + 40000
  const normalWould = wd.shouldRunNow({ firstEventAt: first, now, maxWaitMs: wd.NORMAL_MAX_WAIT_MS })
  const hardenedWould = wd.shouldRunNow({ firstEventAt: first, now, maxWaitMs: wd.chooseMaxWait(cond) })
  assert.strictEqual(normalWould, true)
  assert.strictEqual(hardenedWould, false, 'the hard ceiling holds off through the storm')
})
