'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

// main.js needs Electron, so these are static checks — the same approach
// test/preload-sandbox.test.js already uses. They are all guards against a
// specific regression, not style rules.
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// Strip comments so a pattern quoted in an explanation does not count as code.
const CODE = MAIN
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(l => !/^\s*\/\//.test(l))
  .join('\n')

// ── The store split ──────────────────────────────────────────────────────────

const HOT_KEYS = ['libraryCache', 'playbackState', 'sessionState', 'recentlyPlayed', 'slskSchedulerState', 'playHistory']

test('the hot keys are never read or written through the shared config', () => {
  // electron-store rewrites and fsyncs the WHOLE file on every set. Mixing one
  // legacy read back in is worse than never having split it: reads and writes
  // would then disagree about where the value lives.
  const strays = []
  for (const key of HOT_KEYS) {
    const re = new RegExp(`store\\.(get|set|delete)\\(\\s*'${key}'`, 'g')
    for (const m of CODE.matchAll(re)) {
      strays.push(`${key}: store.${m[1]}(...) at offset ${m.index}`)
    }
  }
  assert.deepStrictEqual(strays, [], 'these must go through sideStores instead')
})

test('every hot key has a side store, and every side store is used', () => {
  for (const key of HOT_KEYS) {
    assert.match(CODE, new RegExp(`${key}: new SideStore\\(`), `${key} needs a side store`)
    assert.match(CODE, new RegExp(`sideStores\\.${key}\\.`), `${key}'s side store is never used`)
  }
})

test('both exit paths flush the side stores and the log buffer', () => {
  // A coalesced write that never lands is a value silently lost. There are two
  // ways out — the signal handler and will-quit — and app.exit() skips handlers.
  assert.strictEqual((CODE.match(/flushSideStores\(\)/g) || []).length, 3,
    'one definition plus both exit paths')
  assert.strictEqual((CODE.match(/flushLogSync\(\)/g) || []).length, 3)
  const signal = CODE.slice(CODE.indexOf('function shutdownFromSignal'), CODE.indexOf('for (const sig of'))
  assert.match(signal, /flushSideStores\(\)/, 'the signal path must flush too')
  assert.match(signal, /flushLogSync\(\)/)
})

// ── No synchronous work on the thread that drives mpv ────────────────────────

test('nothing shells out synchronously any more', () => {
  // execSync and execFileSync block the one process that pumps mpv's IPC, the
  // window and every handler.
  assert.doesNotMatch(CODE, /\bexecSync\s*\(/, 'execSync blocks the main thread')
  assert.doesNotMatch(CODE, /\bexecFileSync\s*\(/, 'execFileSync blocks the main thread')
})

test('every shell-out has a timeout', () => {
  // A hung unzip used to freeze the app with no way out, because execSync was
  // called with no timeout at all.
  assert.match(CODE, /function run\(cmd, args, timeout\)/)
  assert.match(CODE, /timeout: timeout \|\| \d+/, 'run() must always pass a timeout')
})

test('the whole-tree walk is asynchronous and yields', () => {
  assert.doesNotMatch(CODE, /function dirSize\(/, 'the synchronous walk is gone')
  assert.match(CODE, /async function dirSizeAsync\(/)
  assert.match(CODE, /setImmediate/, 'it has to yield, or it still blocks playback')
  // Every call site must await it. A bare call returns a promise, and adding a
  // promise to a byte total gives NaN — a storage report that reads as garbage
  // rather than as a failure.
  const calls = [...CODE.matchAll(/dirSizeAsync\(/g)]
    .filter(m => !/function\s+$/.test(CODE.slice(Math.max(0, m.index - 20), m.index)))
  assert.ok(calls.length >= 5, `expected the call sites to still be there, found ${calls.length}`)
  for (const m of calls) {
    const before = CODE.slice(Math.max(0, m.index - 24), m.index)
    assert.match(before, /await\s+$/, `dirSizeAsync must be awaited: ...${before}dirSizeAsync(`)
  }
})

test('the command file is watched, not polled five times a second', () => {
  assert.doesNotMatch(CODE, /setInterval\(pollCmd/, 'the 200 ms poll is gone')
  assert.match(CODE, /fs\.watch\(CMD_PATH/)
  // And the backstop poll must be slow, because fs.watch is not reliable
  // everywhere — but 200 ms was never a backstop, it was the mechanism.
  const m = CODE.match(/setInterval\(readCmd,\s*(\d+)\)/)
  assert.ok(m, 'keep a backstop poll: fs.watch never fires on some filesystems')
  assert.ok(Number(m[1]) >= 2000, `the backstop must be slow, got ${m[1]}ms`)
})

test('log lines are buffered, not appended synchronously one at a time', () => {
  // A burst — a failing loop, repeated 429s, a bad scan — became a burst of
  // blocking disk I/O on the main thread.
  assert.match(CODE, /fs\.promises\.appendFile/, 'the timed flush is the async one')
  // The only synchronous append left is the one on the way out, where the
  // process is exiting and there is no later chance to write.
  const syncAppends = [...CODE.matchAll(/fs\.appendFileSync/g)]
  assert.strictEqual(syncAppends.length, 1, 'exactly one, in flushLogSync')
  const around = CODE.slice(syncAppends[0].index - 400, syncAppends[0].index)
  assert.match(around, /function flushLogSync/)
})

test('the log has a size cap as well as an age cap', () => {
  // Pruning by age alone lets one bad day fill the disk.
  assert.match(CODE, /LOG_MAX_BYTES/)
  assert.match(CODE, /st\.size > LOG_MAX_BYTES/)
})

test('the console patch is installed at module load, not inside whenReady', () => {
  // Everything logged during early startup used to land before the patch
  // existed, and was therefore never written anywhere.
  const patchAt = CODE.indexOf('console.error = (...args)')
  const readyAt = CODE.indexOf('app.whenReady()')
  assert.ok(patchAt > 0 && readyAt > 0)
  assert.ok(patchAt < readyAt, 'the patch must come first, or startup logging is lost')
})

test('ffprobe is not run synchronously inside the scan path', () => {
  // Item 49: once per probed file, on the thread that drives mpv.
  const fn = CODE.slice(CODE.indexOf('function ffprobeAudio'), CODE.indexOf('async function parseTrackFile'))
  assert.doesNotMatch(fn, /Sync\s*\(/)
  assert.match(CODE, /await ffprobeAudio\(/, 'the caller is already async')
})
