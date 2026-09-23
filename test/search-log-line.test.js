'use strict'
// Why a search came back thin has to be answerable from the log.
//
// "Sources are back but fewer are showing." The same query, run against the same
// indexers from outside the app, gave five results where he was seeing three, and
// every filter between the indexers and the screen accounted for nothing: the
// name check hid 0, the quality preference hides nothing by design, there is no
// cap, and his mirror list is the default. The difference was inside the session,
// where nothing was written down.
//
// So each search now records what it asked and what each source gave.

const test = require('node:test')
const assert = require('node:assert')
const P = require('../providers/index.js')

const entry = (h, title) => ({ kind: 'torrent', infoHash: h.repeat(40).slice(0, 40), title, quality: '1080p', seeds: 3 })
const named = (name, fn) => Object.defineProperty(fn, 'name', { value: name })

async function sweepOf(backends) {
  P._resetSourceHealth()
  const seen = []
  await P.resolveStream({ type: 'anime', title: 'X', episode: 1 }, backends,
    { timeoutMs: 300, onSweep: s => seen.push(s) })
  return seen[0]
}

test('the sweep reports how many entries each source returned', async () => {
  const s = await sweepOf([
    named('rich', async () => [entry('a', 'A - 01'), entry('b', 'B - 01'), entry('c', 'C - 01')]),
    named('thin', async () => [entry('d', 'D - 01')]),
    named('empty', async () => []),
  ])
  assert.deepStrictEqual(s.counts, { rich: 3, thin: 1, empty: 0 },
    'three, one and none are three different stories and must read differently')
})

test('a source that threw is distinguishable from one that answered with nothing', async () => {
  const s = await sweepOf([
    named('empty', async () => []),
    named('broken', async () => { throw new Error('mirror down') }),
  ])
  assert.strictEqual(s.counts.empty, 0, 'answered, had nothing')
  assert.strictEqual(s.counts.broken, -1, 'never answered — a different fault entirely')
})

test('a source that times out reads as never having answered', async () => {
  const s = await sweepOf([named('silent', () => new Promise(() => {}))])
  assert.strictEqual(s.counts.silent, -1)
})

test('counts are additive — the existing sweep contract is unchanged', async () => {
  const s = await sweepOf([
    named('empty', async () => []),
    named('finds', async () => [entry('e', 'E - 01')]),
  ])
  assert.deepStrictEqual(s.results, { empty: false, finds: true }, 'results still boolean')
  assert.strictEqual(s.allZero, false, 'allZero still means the search found nothing anywhere')
})

test('the raw count is what a source returned, before cross-source dedupe', async () => {
  const same = entry('f', 'Shared - 01')
  const s = await sweepOf([
    named('one', async () => [same]),
    named('two', async () => [same]),
  ])
  assert.deepStrictEqual(s.counts, { one: 1, two: 1 },
    'both answered with one — that the two were the same torrent is a separate fact')
})

// The consumer side: main must actually write the line, and must not write a
// debrid URL or a magnet into it.
test('the search log line names the titles and the counts, and no secrets', () => {
  const fs = require('fs')
  const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const at = MAIN.indexOf("ipcMain.handle('video-streams'")
  assert.ok(at > -1)
  let depth = 0
  let body = ''
  for (let i = MAIN.indexOf('{', at); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++
    else if (MAIN[i] === '}') { depth--; if (depth === 0) { body = MAIN.slice(at, i + 1); break } }
  }
  assert.match(body, /\[papa-video\] search/, 'the line is written')
  assert.match(body, /_lastSweepCounts/, 'and carries the per-source counts')
  assert.match(body, /shown=/, 'and what survived to the screen')
  assert.ok(!/magnet/.test(body.slice(body.indexOf('[papa-video] search'), body.indexOf('[papa-video] search') + 900)),
    'a magnet must never reach the log')
})
