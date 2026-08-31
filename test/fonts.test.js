'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')

// The stylesheet used to @import Poppins from Google Fonts while the page's
// Content-Security-Policy allowed no https: in default-src. Chromium refused
// the request every single launch, silently, and the app ran on a fallback
// font for its whole life — measured at the time: "Poppins" rendered at exactly
// the width of monospace, meaning it had never once loaded.
test('no font is fetched from a host the page is not allowed to reach', () => {
  const csp = /content="([^"]*)"/.exec(/Content-Security-Policy[^>]*/.exec(HTML)[0])[1]
  assert.ok(!/https:/.test(csp.split(';')[0]),
    'default-src still has no https:, so a remote font would still be refused')
  assert.ok(!/@import\s+url\(['"]?https:/.test(CSS), 'a remote @import is refused, not degraded')
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(CSS))
})

test('every face the stylesheet declares is a file that exists', () => {
  const srcs = [...CSS.matchAll(/src:\s*url\('([^']+)'\)/g)].map(m => m[1])
  assert.ok(srcs.length >= 7, 'expected the bundled faces, found ' + srcs.length)
  for (const rel of srcs) {
    const file = path.join(ROOT, 'src', rel)
    assert.ok(fs.existsSync(file), rel + ' is declared but not present')
    const head = fs.readFileSync(file).subarray(0, 4).toString('latin1')
    assert.strictEqual(head, 'wOF2', rel + ' is not a woff2 file — a saved error page renders as nothing')
  }
})

// woff2-variations was the old format string and Chromium no longer accepts it;
// a face declaring it is parsed and then never used.
test('the variable faces use a format string browsers still accept', () => {
  assert.ok(!/woff2-variations/.test(CSS))
  const variable = [...CSS.matchAll(/font-family:\s*'(Newsreader|Archivo)'[\s\S]{0,200}?src:[^;]+;/g)]
  assert.strictEqual(variable.length, 2, 'both film faces must be declared')
  for (const m of variable) assert.match(m[0], /format\('woff2'\)/)
})

// Bundling is what makes the typography survive being offline, which a desktop
// player should.
// A Didone's hairlines fall below what the screen can render at card-title size
// on a near-black ground, and the word turns to mush. The face that replaced it
// carries an optical-size axis, so letterforms thicken as the size comes down.
test('the display face is one drawn for screens, not a poster Didone', () => {
  assert.ok(!/Bodoni/.test(CSS), 'Bodoni is a display face and was unreadable at card size')
  assert.match(CSS, /--cin-display:\s*'Newsreader'/)
})

// The smallest text on the page that has to be read rather than admired.
test('card titles are set in the sans, not the display serif', () => {
  const rule = CSS.slice(CSS.indexOf('.cinema .vcard-title {'))
  const body = rule.slice(0, rule.indexOf('}'))
  assert.match(body, /font-family:\s*var\(--cin-body\)/,
    'a serif at 14.5px on this ground is where legibility goes first')
})

test('the film faces cover the weights the design uses', () => {
  for (const fam of ['Newsreader', 'Archivo']) {
    const face = new RegExp("font-family:\\s*'" + fam + "'[\\s\\S]{0,200}?font-weight:\\s*400 700")
    assert.match(CSS, face, fam + ' must span 400-700 as one variable file')
  }
})
