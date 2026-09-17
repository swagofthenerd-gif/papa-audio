'use strict'
// Checking which cached files still exist must not block the main thread.
//
// Both video list handlers used a synchronous fs.statSync per entry, on the
// thread that also drives mpv's IPC socket. Fine at five entries; a stall at a
// few hundred, and far worse on a network mount where one stat blocks for as
// long as the mount takes to answer. The On Device page re-renders on every
// download event, so it ran constantly.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { partitionAlive } = require('../src/alive-files')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

const file = () => ({ isFile: () => true })
const dir = () => ({ isFile: () => false })

test('present files are alive, missing ones are not, order preserved', async () => {
  const entries = [{ path: '/a' }, { path: '/gone' }, { path: '/b' }]
  const stat = async p => (p === '/gone' ? Promise.reject(new Error('ENOENT')) : file())
  const { alive, missing } = await partitionAlive(entries, { stat })
  assert.deepStrictEqual(alive.map(e => e.path), ['/a', '/b'], 'input order is kept')
  assert.deepStrictEqual(missing.map(e => e.path), ['/gone'])
})

test('a directory is not a file', async () => {
  const { alive } = await partitionAlive([{ path: '/d' }], { stat: async () => dir() })
  assert.deepStrictEqual(alive, [])
})

test('entries with no path, and junk input, are handled without throwing', async () => {
  const { alive, missing } = await partitionAlive([null, {}, { path: '' }], { stat: async () => file() })
  assert.deepStrictEqual(alive, [])
  assert.strictEqual(missing.length, 3)
  for (const bad of [null, undefined, 'nope', 42]) {
    const r = await partitionAlive(bad, { stat: async () => file() })
    assert.deepStrictEqual(r.alive, [], String(bad))
  }
})

test('the stats really are issued in parallel, not one after another', async () => {
  // The whole point. Serialised, 40 entries x 20 ms is 800 ms of blocked main
  // thread; in parallel it is one 20 ms wait.
  let inFlight = 0
  let peak = 0
  const stat = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5))
    inFlight--
    return file()
  }
  const entries = Array.from({ length: 40 }, (_, i) => ({ path: '/f' + i }))
  const started = Date.now()
  await partitionAlive(entries, { stat })
  const took = Date.now() - started
  assert.ok(peak > 1, 'all forty stats must be in flight together, saw peak ' + peak)
  assert.ok(took < 40 * 5 * 0.5, 'serialised would take ~200ms, took ' + took + 'ms')
})

test('one slow entry does not hold up the answer for the rest', async () => {
  const stat = async p => {
    if (p === '/slow') await new Promise(r => setTimeout(r, 30))
    return file()
  }
  const started = Date.now()
  const { alive } = await partitionAlive(
    [{ path: '/slow' }, { path: '/a' }, { path: '/b' }], { stat })
  assert.strictEqual(alive.length, 3)
  assert.ok(Date.now() - started < 90, 'the slow one is waited for once, not per entry')
})

test('neither video list handler stats synchronously any more', () => {
  // The guard. A statSync creeping back into these handlers puts the block
  // straight back on the thread that drives playback.
  for (const h of ['video-keep-list', 'video-cache-list']) {
    const at = MAIN.indexOf(`ipcMain.handle('${h}'`)
    assert.ok(at > -1, h + ' must still exist')
    const body = MAIN.slice(at, MAIN.indexOf('\n})', at))
    assert.doesNotMatch(body, /statSync/, h + ' must not stat synchronously')
    assert.match(body, /partitionAlive/, h + ' must use the parallel helper')
  }
})
