'use strict'
// One source row used to carry two different sizes for the same file, both
// labelled "GB" (Movies & TV audit N11).
//
// The row paints its own size stat from `sizeBytes` through the renderer's
// binary formatter (1024**3 to the gigabyte), and right beside it the label
// the provider built carried a DECIMAL gigabyte (1e9). A 4,000,000,000-byte
// release therefore read "3.7 GB" in the stat and "4.0 GB" in the label, on
// the same line, with no way to tell which was the file.
//
// Both halves are lifted from the shipped code — the provider's normaliser is
// required directly, the row painter's size expression out of renderer.js —
// and driven with one byte count. They must produce the same string.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')

const videoFormat = require(path.join(root, 'src', 'video-format.js'))
const { fmtSize } = require(path.join(root, 'providers', 'quality.js'))
const apibay = require(path.join(root, 'providers', 'apibay.js'))

// The renderer's Movies & TV size helper, taken from the shipped source and
// evaluated against the real PapaVideoFormat so the test cannot pass on a
// reimplementation of it.
function liftRendererSizeFormatter() {
  const open = RENDERER.indexOf('function _fmtVideoSize(bytes) {')
  assert.ok(open > -1, 'the renderer must still have one Movies & TV size formatter')
  let depth = 0
  let i = RENDERER.indexOf('{', open)
  const start = i
  do {
    if (RENDERER[i] === '{') depth++
    else if (RENDERER[i] === '}') depth--
    i++
  } while (depth > 0 && i < RENDERER.length)
  const body = RENDERER.slice(start + 1, i - 1)
  // `window` and `_fmtBytes` are the only free names in it.
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', '_fmtBytes', 'bytes', body)
  const fail = () => { throw new Error('the fallback must not be reached when PapaVideoFormat is present') }
  return (bytes) => fn({ PapaVideoFormat: videoFormat }, fail, bytes)
}

const rendererSize = liftRendererSizeFormatter()

// Four sizes that land in different units, including the one that made the
// binary/decimal split visible.
const CASES = [4e9, 1500000000, 734003200, 1024 * 1024 * 1024 * 12]

test('the source row and the provider label render one byte count identically', () => {
  for (const bytes of CASES) {
    assert.strictEqual(fmtSize(bytes), rendererSize(bytes),
      bytes + ' bytes must read the same in the label and in the row stat')
  }
})

test('and it is the binary convention the rest of the app uses', () => {
  // 4,000,000,000 bytes is 3.7 binary GB. A decimal formatter says "4.0 GB" —
  // that string appearing here is the bug this test exists for.
  assert.strictEqual(rendererSize(4e9), '3.7 GB')
  assert.strictEqual(fmtSize(4e9), '3.7 GB')
})

test('a real TPB result carries that same one string in its label', () => {
  const entry = apibay.normalizeResult({
    name: 'Dune Part Two 2024 2160p BluRay x265-GROUP',
    info_hash: 'a'.repeat(40),
    size: 4e9,
    seeders: 12,
  })
  assert.ok(entry, 'the fixture must normalise to a real entry')
  assert.ok(entry.label.includes(rendererSize(entry.sizeBytes || 4e9)),
    'the label must carry the same size string the row stat paints, got: ' + entry.label)
  assert.ok(!/\b4\.0 GB\b/.test(entry.label),
    'the decimal gigabyte is the defect: ' + entry.label)
})

test('an unknown size is omitted, never rendered as zero', () => {
  assert.strictEqual(fmtSize(0), null)
  assert.strictEqual(fmtSize(null), null)
  assert.strictEqual(fmtSize(undefined), null)
})
