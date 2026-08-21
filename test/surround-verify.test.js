const test = require('node:test')
const assert = require('node:assert')
const { classify, isSurround, verdict, auditAlbum } = require('../src/surround-verify')

test('channel counts classify correctly', () => {
  assert.equal(classify(6), '5.1'); assert.equal(classify(8), '7.1')
  assert.equal(classify(2), 'stereo'); assert.equal(classify(1), 'mono')
  assert.equal(classify(0), 'unknown')
})

test('the case that matters: promised 5.1, delivered stereo', () => {
  const v = verdict('5.1', 2)
  assert.equal(v.ok, false)
  assert.equal(v.severity, 'mismatch')
  assert.match(v.message, /Labelled 5\.1 but arrived as stereo/)
})

test('promised and delivered surround is confirmed', () => {
  const v = verdict('5.1', 6)
  assert.equal(v.ok, true)
  assert.equal(v.severity, 'confirmed')
})

test('unlabelled surround is surfaced rather than ignored', () => {
  const v = verdict(null, 6)
  assert.equal(v.ok, true)
  assert.equal(v.severity, 'bonus')
})

test('an unreadable file is not called a failure', () => {
  assert.equal(verdict('5.1', 0).ok, null)
  assert.equal(verdict('5.1', 0).severity, 'unknown')
})

test('an album is surround only if EVERY track is', () => {
  const good = auditAlbum([{ channels: 6 }, { channels: 6 }, { channels: 6 }])
  assert.equal(good.ok, true)
  assert.equal(good.surround, 3)

  // The silent failure this exists to catch.
  const mixed = auditAlbum([
    { name: '01.flac', channels: 6 },
    { name: '02.flac', channels: 2 },
    { name: '03.flac', channels: 6 },
  ])
  assert.equal(mixed.ok, false)
  assert.equal(mixed.mixed, true)
  assert.equal(mixed.surround, 2)
  assert.deepEqual(mixed.offenders, [{ name: '02.flac', channels: 2 }])
})

test('an album with nothing readable reports unknown, not failure', () => {
  assert.equal(auditAlbum([{ channels: 0 }]).ok, null)
  assert.equal(auditAlbum([]).ok, null)
})

test('4.0 and above count as surround', () => {
  assert.ok(isSurround(4)); assert.ok(isSurround(6)); assert.ok(isSurround(8))
  assert.ok(!isSurround(2)); assert.ok(!isSurround(1))
})

test('5.1 is prioritised and verified end to end', () => {
  const fs = require('fs'), path = require('path')
  const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

  const html = R('src/index.html')
  assert.ok(html.indexOf('surround-verify.js') < html.indexOf('renderer.js'),
    'surround-verify.js must load before renderer.js')

  const main = R('main.js')
  assert.ok(main.includes("ipcMain.handle('verify-surround'"), 'per-file verify handler')
  assert.ok(main.includes("ipcMain.handle('verify-surround-folder'"), 'album verify handler')
  assert.ok(main.includes('function probeChannels'), 'must read real channel counts')
  assert.ok(main.includes("'stream=channels'"), 'must ask ffprobe for channels')

  const pre = R('preload.js')
  assert.ok(pre.includes('verifySurround') && pre.includes('verifySurroundFolder'))

  const r = R('src/renderer.js')
  assert.ok(r.includes('Surround first, always'), 'search must rank surround first')
  assert.ok(r.includes('_verifySurroundWhenDone'), 'downloads must be verified')
  assert.ok(r.includes('anchorSur && SF2 && !SF2.groupSurround(o)'),
    'alternates must match the anchor surround status')
})

test('the personal library can be filtered and sorted by surround', () => {
  const fs = require('fs'), path = require('path')
  const r = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
  assert.ok(r.includes('libSurround'), 'library needs surround filter state')
  assert.ok(r.includes('lib-surround-filter'), 'library needs the filter control')
  assert.ok(r.includes("state.libSort === 'channels'"), 'library needs a channel sort')
  assert.ok(r.includes("case 'atmos':  return !!a.atmos"), 'Atmos must be its own option')
  // Reset must clear it too, or a hidden filter makes the library look empty.
  assert.ok(/lib-reset-filters[\s\S]{0,220}libSurround = ''/.test(r),
    'Reset must clear the surround filter')
})
