'use strict'
// Roadmap W-T, main-process input validation: api.slskSearch({}) used to
// throw a raw TypeError out of main; the edge answers with a reason instead.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('slsk-search with no text answers { results: [], error } instead of throwing', () => {
  const at = MAIN.indexOf("ipcMain.handle('slsk-search'")
  const body = MAIN.slice(at, MAIN.indexOf('\n})', at))
  assert.match(body, /const q = args && args\.query/)
  assert.match(body, /if \(typeof q !== 'string' \|\| !q\.trim\(\)\) return Promise\.resolve\(\{ results: \[\], error: 'No search text' \}\)/)
  assert.match(body, /return slskServeSearch\(args\)/)
})
