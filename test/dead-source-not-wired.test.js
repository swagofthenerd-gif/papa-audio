'use strict'
// A dead source is not free — the aggregation waits for it.
//
// SolidTorrents' API now redirects to bitsearch.to, which answers HTTP 429 with
// Cloudflare error 1015 (a rate-limit ban); the .eu mirror answers a 308 loop and
// takes 14 s to do it. Measured against the live hosts, 2026-09-23:
//
//     movie  0 results in 11.7 s
//     tv     0 results in 17.6 s
//     anime  0 results in 11.6 s
//
// and -1 (never answered) in all four searches logged from the running app.
// Because resolveStream waits for every backend to settle, that cost the whole
// search its budget for nothing — 20.0 s with it against 13.2 s without, on a
// search whose five results were all in after 10 s. Worse, it crowded the network
// enough to push AnimeTosho (13.3 s, consistently) past the 20 s deadline, so a
// source that was dead was killing one that worked.
//
// The provider and its own tests are kept. This only asserts it is not wired into
// a lineup while it cannot answer.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function backendsBody() {
  const at = MAIN.indexOf('function _videoBackends(')
  assert.ok(at > -1, '_videoBackends must still exist')
  let depth = 0
  for (let i = MAIN.indexOf('{', at); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++
    else if (MAIN[i] === '}') { depth--; if (depth === 0) return MAIN.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces')
}

test('solidtorrents is not in any backend lineup', () => {
  const body = backendsBody()
  assert.ok(!/solidtorrents\(\)/.test(body),
    'it answers 0 results in 11-17s for every content type, and the search waits for it')
})

test('the live sources are all still wired', () => {
  const body = backendsBody()
  for (const name of ['nyaa()', 'animetosho()', 'apibay()', 'knaben()', 'eztv()', 'yts()', 'movieTv()']) {
    assert.ok(body.includes(name), name + ' must still serve its lineup')
  }
})

test('anime keeps four independent sources', () => {
  const body = backendsBody()
  const line = body.split('\n').find(l => l.includes("type === 'anime'"))
  assert.ok(line, 'the anime lineup must still be there')
  for (const name of ['nyaa()', 'animetosho()', 'apibay()', 'knaben()']) {
    assert.ok(line.includes(name), 'anime lost ' + name)
  }
})

test('the removal records why, so it is not reinstated by guesswork', () => {
  const at = MAIN.indexOf('function _videoBackends(')
  const preamble = MAIN.slice(Math.max(0, at - 1800), at)
  assert.match(preamble, /1015/, 'the Cloudflare ban code is the evidence')
  assert.match(preamble, /bitsearch/i, 'and where to look if it is ever revived')
})

// The provider itself must survive, so reviving it is a config change and not a
// rewrite — and so its own tests keep running.
test('the provider module is still present and loadable', () => {
  const m = require('../providers/solidtorrents.js')
  assert.strictEqual(typeof m.createSolidTorrentsProvider, 'function')
})
