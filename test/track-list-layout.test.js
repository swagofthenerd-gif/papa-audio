'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

const columnsOf = template => template.trim().split(/\s+(?![^(]*\))/).length

function rowTemplate() {
  const m = /\.track-list \.track-row:not\(\.pl-track-row\),\s*\n\.liked-track-row \{\s*\n\s*grid-template-columns:([^;]+);/.exec(CSS)
  assert.ok(m, 'the track row still has a grid template')
  return m[1]
}
function headerTemplate() {
  const m = /\.track-list-header \{\s*\n\s*display: grid;\s*\n\s*grid-template-columns: ([^;]+);/.exec(CSS)
  assert.ok(m, 'the header still has a grid template')
  return m[1]
}

// The row emits seven children into what was a five-column grid, with nothing
// placed explicitly — so the ⋮ button fell to an implicit second row under the
// track number, and hovering pushed the duration down there too. Every row of
// every album grew taller under the pointer.
test('the track row has a column for every child it emits', () => {
  const children = ['track-num', 'track-info', 'track-plays', 'track-like-btn', 'hover-actions', 'track-dur', 'track-more-btn']
  const row = R.slice(R.indexOf('<div class="track-row '))
  const markup = row.slice(0, 1800)
  for (const c of children) {
    assert.ok(markup.includes(c), `the row still emits ${c}`)
  }
  assert.strictEqual(columnsOf(rowTemplate()), children.length,
    'one column per child, or the last ones wrap onto a second line')
})

test('every child is placed by name, so a hidden one does not shift the rest', () => {
  // .hover-actions is display:none until hover. With implicit placement that
  // shifted everything after it by one column the moment the cursor arrived.
  for (const [cls, col] of [['track-num', 1], ['track-info', 2], ['track-plays', 3],
                            ['track-like-btn', 4], ['hover-actions', 5], ['track-dur', 6], ['track-more-btn', 7]]) {
    const re = new RegExp(`>\\s*\\.${cls}[^{]*\\{[^}]*grid-column:\\s*${col}`)
    assert.match(CSS, re, `${cls} must be pinned to column ${col}`)
  }
})

test('the header uses the same template as the rows it labels', () => {
  assert.strictEqual(headerTemplate().trim(), rowTemplate().trim(),
    'a different template is why "Duration" sat over the play-count column and "#" was four pixels off the numbers')
})

test('the Duration label sits over the duration column, not the third one', () => {
  assert.match(CSS, /\.track-list-header > \*:nth-child\(3\) \{ grid-column:6/,
    'the third label belongs over column 6, where the durations actually are')
})

// The "waveform" was Math.random(), re-rolled once a second, drawn full width
// above the seek bar with a progress fill, a time tooltip and click-to-seek —
// everything needed to convince a listener it was the shape of their track.
test('there is no random waveform pretending to be the track', () => {
  assert.doesNotMatch(R, /Math\.random\(\) \* h \* 0\.8/, 'the random bar heights are gone')
  assert.doesNotMatch(R, /drawWaveform/, 'and so is the drawing loop')
  assert.doesNotMatch(R, /_waveformTimer/, 'and the interval that re-rolled it every second')
  assert.doesNotMatch(R, /waveform-canvas/, 'and the canvas it drew into')
})

// Clicking the album title opens a dialog that writes tags to the files. It had
// no styling at all: no cursor, no underline, no hover.
test('the hero fields that rewrite tags on disk look interactive', () => {
  assert.ok(R.includes('clickable-meta'), 'the hero still uses the class')
  assert.match(CSS, /\.clickable-meta \{/, 'and it is styled at all, which it was not')
  const block = CSS.slice(CSS.indexOf('.clickable-meta {'))
  assert.match(block.slice(0, 400), /cursor:/, 'it has a cursor')
  assert.match(CSS, /\.clickable-meta:hover[\s\S]{0,200}border-bottom-color/, 'and a hover state')
})
