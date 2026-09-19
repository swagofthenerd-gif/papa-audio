'use strict'
// The explorer's batch bar: Replace acts only on albums the shelf marked as
// upgrades over MY copy and carries each library id; Download takes everything;
// the bar disappears with an empty selection. The real shop module is loaded
// into a mini-DOM and driven through its own click delegate.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const SHOP = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')

test('the batch bar markup is built from the selection and gates Replace on upgrades', () => {
  const at = SHOP.indexOf('function shPaintBatchBar()')
  assert.ok(at > -1)
  const body = SHOP.slice(at, SHOP.indexOf('function shClearSelection()', at))
  assert.match(body, /picked\.filter\(a => a\.upgrade && a\.matchedLibId\)/, 'Replace candidates are the marked upgrades only')
  assert.match(body, /replaceLibId: String\(a\.matchedLibId\)/, 'each Replace item carries its library id for verification')
  assert.match(body, /if \(!picked\.length\) \{ if \(bar\) bar\.remove\(\); return \}/, 'no selection, no bar')
  assert.match(body, /data-batch="replace" \$\{upgrades\.length \? '' : 'disabled'\}/, 'Replace is disabled with no upgrade in the selection')
})

test('a tick never opens the card, and toggles the selection', () => {
  const at = SHOP.indexOf("const cb = e.target.closest('.slsh-pick-cb')")
  assert.ok(at > -1)
  const body = SHOP.slice(at, at + 700)
  assert.match(body, /e\.stopPropagation\(\)/)
  assert.match(body, /if \(cb\.checked\) shSelected\.add\(a\.folderPath\); else shSelected\.delete\(a\.folderPath\)/)
  assert.match(body, /shPaintBatchBar\(\)/)
})
