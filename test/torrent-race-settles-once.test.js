'use strict'
// A dying torrent announces itself TWICE.
//
// torrent-stream.js, by design, both emits 'error' and rejects the promise its
// start() returned — the event for listeners, the rejection for the caller that
// awaited it. _startTorrentStream wires BOTH to the race's `fail`. So one dead
// swarm counted as two failures; with two contenders `failed >= started` came
// true on the first lane's death and the race told the viewer the play had
// failed while the second swarm was still connecting normally.
//
// The race function is lifted out of main.js and run against fake streamers, so
// this tests the arithmetic that actually ships rather than a regex over it.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function liftRace() {
  const start = MAIN.indexOf('\nfunction _startTorrentRace(')
  assert.ok(start > -1, '_startTorrentRace must still be a top-level function in main.js')
  const end = MAIN.indexOf('\nfunction _startTorrentStream(', start)
  assert.ok(end > start, '_startTorrentStream must still follow it')
  return MAIN.slice(start, end)
}

// A stand-in for a torrent lane. `_startTorrentStream` is replaced wholesale:
// what is under test is the race's accounting, and the real one needs a
// WebTorrent client, a settings store and a live filesystem.
function harness() {
  const lanes = []
  const ctx = {
    HEDGE_AFTER_MS: 10000,
    setTimeout: () => 0,
    clearTimeout: () => {},
    _videoSession: {},
    _startTorrentStream(result, opts) {
      const lane = new EventEmitter()
      lane.result = result
      lane.opts = opts
      lane.stopped = false
      lane.stop = () => { lane.stopped = true }
      // Both halves of a real failure, in the order torrent-stream.js produces
      // them: the event first, then the rejected start promise.
      lane.dieTwice = err => { opts.fail(err); opts.fail(err) }
      lane.dieOnce = err => { opts.fail(err) }
      lane.becomeReady = url => opts.onReady(url, lane)
      lanes.push(lane)
      return lane
    },
  }
  vm.createContext(ctx)
  vm.runInContext(liftRace(), ctx)
  return { ctx, lanes }
}

const torrent = n => ({ kind: 'torrent', magnet: 'magnet:?xt=urn:btih:' + String(n).repeat(40).slice(0, 40) })

test('one lane announcing its death twice does not fail the race', () => {
  const { ctx, lanes } = harness()
  let failedWith = null
  let readyUrl = null
  ctx._startTorrentRace(torrent(1), [torrent(2)], {
    current: () => true,
    fail: e => { failedWith = e },
    onReady: url => { readyUrl = url },
  })
  assert.equal(lanes.length, 1, 'the race opens with the lead contender only')

  lanes[0].dieTwice(new Error('no peers'))
  assert.equal(lanes.length, 2, 'a dead lead opens the next contender immediately')
  assert.equal(failedWith, null, 'the race must not be over: contender two is still alive')

  lanes[1].becomeReady('http://127.0.0.1:1/f.mkv')
  assert.equal(readyUrl, 'http://127.0.0.1:1/f.mkv')
  assert.equal(failedWith, null)
})

test('the race still fails when every contender genuinely dies', () => {
  const { ctx, lanes } = harness()
  let failedWith = null
  ctx._startTorrentRace(torrent(1), [torrent(2)], {
    current: () => true,
    fail: e => { failedWith = e },
    onReady: () => {},
  })
  lanes[0].dieTwice(new Error('first is dead'))
  assert.equal(failedWith, null)
  lanes[1].dieTwice(new Error('second is dead'))
  assert.ok(failedWith, 'with no contender left the race has to say so')
  assert.match(String(failedWith.message), /second is dead/)
})

// Characterisation, not a guard on the settle-once change: what holds this is
// the `if (winner) return` that was already there. Written down because it is
// the property the accounting exists to protect, and nothing asserted it.
test('a lane that already produced a URL cannot later be counted as a failure', () => {
  const { ctx, lanes } = harness()
  let failedWith = null
  let readyUrl = null
  ctx._startTorrentRace(torrent(1), [torrent(2)], {
    current: () => true,
    fail: e => { failedWith = e },
    onReady: url => { readyUrl = url },
  })
  lanes[0].becomeReady('http://127.0.0.1:1/f.mkv')
  assert.equal(readyUrl, 'http://127.0.0.1:1/f.mkv')
  // The winning swarm drops after it has already served bytes.
  lanes[0].dieOnce(new Error('swarm went away'))
  assert.equal(failedWith, null, 'a won race is not undone by the winner reporting later trouble')
})

test('a single contender that announces twice fails exactly once', () => {
  const { ctx, lanes } = harness()
  const calls = []
  ctx._startTorrentRace(torrent(1), [], {
    current: () => true,
    fail: e => calls.push(e),
    onReady: () => {},
  })
  lanes[0].dieTwice(new Error('alone and dead'))
  assert.equal(calls.length, 1, 'the viewer is told once, not twice')
})
