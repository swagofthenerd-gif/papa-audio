'use strict'
// R5 wiring: every number on the Downloads page is painted from the one
// reconciled model, and the cards are patched live rather than frozen.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('dl-numbers.js loads after dl-state.js and before the renderer', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('dl-state.js') < order.indexOf('dl-numbers.js') && order.indexOf('dl-numbers.js') < order.indexOf('renderer.js'))
})

test('the poll merges held files through the model and builds the model once per tick', () => {
  const poll = fn('_pollAndRenderDownloadsInner')
  assert.match(poll, /files = window\.PapaDlNumbers \? window\.PapaDlNumbers\.mergeHeld\(files, sched\.files\) : files/)
  assert.doesNotMatch(poll, /new Set\(files\.map\(f => f\.filename\)\)/, 'the drop-if-known merge is gone')
  assert.match(poll, /_dlModel = window\.PapaDlNumbers \? window\.PapaDlNumbers\.reconcile\(files, _dlSchedStats\) : null/)
  assert.match(poll, /window\.PapaDlNumbers\.navBadge\(_dlModel, todayDone\)/)
  assert.match(poll, /_dlPaintDashboard\(\)/, 'cards are patched on every poll')
})

test('cards, strip, tab badges and scheduler line all read the model', () => {
  assert.match(fn('renderDownloads'), /var dashHTML = _dlDashboardHtml\(\)/)
  assert.doesNotMatch(fn('renderDownloads'), /Active<\/div>/, 'the ambiguous "Active" card is gone')
  assert.match(fn('_dlDashboardHtml'), /N\.dashboardCards\(model\)/)
  assert.match(fn('_dlStripHtml'), /N\.queueStrip\(model\)/)
  assert.match(fn('_renderActiveTab'), /var html = model \? _dlStripHtml\(model\) : ''/)
  assert.match(fn('_updateActiveDlInPlace'), /_dlPaintStrip\(_dlModel\)/)
  assert.match(fn('_updateDlTabCounts'), /N\.tabCounts\(_dlModel \|\| N\.reconcile\(files, _dlSchedStats\)\)/)
  assert.match(fn('_dlPaintSchedulerStats'), /N\.schedulerLine\(N\.reconcile\(\[\], _dlSchedStats\)\)/)
  assert.doesNotMatch(fn('_dlPaintSchedulerStats'), /' active across '/, 'the scheduler line no longer says "active"')
})

test('the Soulseek results header is the named-unit summary line', () => {
  const row = fn('renderSoulseekRow')
  assert.match(row, /SF\.summaryLine\(\{[\s\S]*?merged: _slskMergedMode,[\s\S]*?sources: ordered\.length,[\s\S]*?lossless: flacGroups\.length,/)
  assert.doesNotMatch(row, /lossless source\$\{flacGroups\.length !== 1/, 'the old hand-built summary is gone')
})
