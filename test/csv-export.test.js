// The stats CSV export used to concatenate raw field values with commas, so any
// artist or title containing a comma silently shifted every later column. These
// pin RFC 4180 quoting against the real function, extracted from renderer.js
// (which cannot be require()d -- it is a browser script sharing one global).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const start = src.indexOf('function jsonToCsv(data) {')
assert.ok(start > -1, 'jsonToCsv must exist')
// The helper is the first nested function; pull it out and evaluate it alone.
const qStart = src.indexOf('function q(v) {', start)
const qEnd = src.indexOf('\n  }', qStart) + 4
const q = new Function(src.slice(qStart, qEnd) + '; return q')()

test('plain values are left alone', () => {
  assert.equal(q('Radiohead'), 'Radiohead')
  assert.equal(q(42), '42')
})

test('null and undefined become empty, not the string "null"', () => {
  assert.equal(q(null), '')
  assert.equal(q(undefined), '')
})

test('a comma in a band name no longer shifts every later column', () => {
  assert.equal(q('Crosby, Stills & Nash'), '"Crosby, Stills & Nash"')
})

test('embedded quotes are doubled, per RFC 4180', () => {
  assert.equal(q('The "Chirping" Crickets'), '"The ""Chirping"" Crickets"')
})

test('newlines are quoted so one record stays one record', () => {
  assert.equal(q('line1\nline2'), '"line1\nline2"')
  assert.equal(q('line1\r\nline2'), '"line1\r\nline2"')
})

test('zero is exported, not swallowed as falsy', () => {
  assert.equal(q(0), '0')
})

test('every variable CSV field routes through the quoter', () => {
  const body = src.slice(start, src.indexOf('\n}', start))
  for (const field of ['data.topArtists[i].name', 'data.topGenres[j].name', 'p.artist', 'p.title']) {
    assert.ok(body.includes('q(' + field + ')'), field + ' must be quoted')
  }
})
