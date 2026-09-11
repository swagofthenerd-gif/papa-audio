'use strict'
// R19: an anime row during an outage says what the status means and whose
// problem it is — not "AniList request failed (403)".
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('the outage line is worded per status', () => {
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(fn('_anilistOutageText') + '\nthis.t = _anilistOutageText', ctx)
  assert.match(ctx.t('AniList request failed (403)'), /refusing requests right now \(403\).*their side/)
  assert.match(ctx.t('HTTP 429'), /refusing requests right now \(429\)/)
  assert.match(ctx.t('AniList request failed (502)'), /having trouble \(502\).*their servers/)
  assert.match(ctx.t('fetch failed'), /could not be reached/)
  assert.match(ctx.t(''), /temporarily down/)
  assert.match(fn('_rowOutage'), /const note = _anilistOutageText\(message\)/)
})
