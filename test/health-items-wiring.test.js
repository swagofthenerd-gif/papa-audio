'use strict'
// R9: the Manage → Health page shows real albums, not hex ids.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

test('album findings render as named, clickable rows that open the album', () => {
  const at = RENDERER.indexOf('var findings = H.assessLibrary(state.library, extras)')
  assert.ok(at !== -1)
  const page = RENDERER.slice(at, at + 4000)
  assert.match(page, /f\.items\s*\?\s*f\.items\.slice\(0, 6\)\.map/)
  assert.match(page, /data-album-open="' \+ esc\(it\.id\) \+ '"/)
  assert.match(page, /esc\(it\.label\)/)
  assert.match(page, /esc\(it\.path\)/)
  assert.match(page, /addEventListener\('click', function \(\) \{ navigate\('album', b\.dataset\.albumOpen\) \}\)/)
  assert.match(CSS, /\.mg-health-item\s*\{/)
})
