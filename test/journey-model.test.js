'use strict'
// J6: when a jump crosses a surface, the page just left is named in a return strip.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const J = require('../src/journey-model')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('surfaces: music pages, video pages, soulseek, downloads, manage, trail', () => {
  assert.equal(J.surfaceOf('album'), 'music')
  assert.equal(J.surfaceOf('video-detail'), 'video')
  assert.equal(J.surfaceOf('soulseek'), 'soulseek')
  assert.equal(J.surfaceOf('unknown-page'), 'unknown-page')
})

test('the strip is due only across surfaces, and only for a page worth returning to', () => {
  const slsk = { page: 'soulseek', navId: null, crumb: { label: 'your Soulseek search “camel” · 420 sources' } }
  assert.equal(J.shouldShow(slsk, { page: 'artist' }), true, 'Soulseek result → artist page')
  assert.equal(J.shouldShow({ page: 'video-detail', crumb: { label: 'Tokyo Revengers' } }, { page: 'search' }), true, 'Find soundtrack')
  assert.equal(J.shouldShow({ page: 'search', crumb: { label: 'your search “camel”' } }, { page: 'album' }), false, 'same surface: the Back arrow suffices')
  assert.equal(J.shouldShow({ page: 'home', crumb: null }, { page: 'video' }), false, 'Home is never a destination worth a strip')
  assert.equal(J.shouldShow(null, { page: 'video' }), false)
})

test('labels: query and count for results pages, title for detail pages, units pluralised', () => {
  assert.equal(J.label({ kind: 'soulseek', query: 'camel', count: 420, unit: 'source' }), 'your Soulseek search “camel” · 420 sources')
  assert.equal(J.label({ kind: 'search', query: 'camel', count: 1, unit: 'local result' }), 'your search “camel” · 1 local result')
  assert.equal(J.label({ kind: 'video-search', query: 'reacher', count: 0 }), 'your Movies & TV search “reacher”')
  assert.equal(J.label({ kind: 'detail', title: 'Mirage' }), 'Mirage')
  assert.equal(J.label(null), '')
})

test('renderer: the label is captured when a page is left, the strip repaints on every navigate, and one click goes Back', () => {
  assert.match(fn('_pushNavHistory'), /entry\.crumb = _crumbFor\(entry\)/)
  const crumb = fn('_crumbFor')
  for (const k of ["case 'search'", "case 'soulseek'", "case 'video'", "case 'library'", "case 'album'", "case 'video-detail'"]) assert.match(crumb, new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(CODE, /updateNavBtns\(\)\s*_journeyCrumbUpdate\(\)/)
  assert.match(fn('_journeyCrumbUpdate'), /J\.shouldShow\(prev, \{ page: state\.currentPage \}\)/)
  assert.match(fn('_journeyCrumbUpdate'), /addEventListener\('click', function \(\) \{ navigateBack\(\) \}\)/)
  assert.match(HTML, /<div class="journey-crumb" id="journey-crumb" hidden><\/div>/)
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('journey-model.js') < order.indexOf('renderer.js'))
})
