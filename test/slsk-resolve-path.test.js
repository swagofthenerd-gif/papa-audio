// slskd never reports where a download landed, so the app guesses among
// candidate layouts. The last-resort candidate was the bare BASENAME in the
// download root, which means a remote "01.flac" matched any loose "01.flac"
// sitting there. That answer is handed straight to Play and "Show in folder",
// so it would play an unrelated song and never download the requested one.
//
// The candidate list also existed as two verbatim copies, in slsk-resolve-file
// and slsk-verify-file, free to drift apart.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const M = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
const start = M.indexOf('function slskGenericBaseName')
assert.ok(start > -1, 'the guard must exist')
const src = M.slice(start, M.indexOf('\nfunction slskCandidatePaths'))
const isGeneric = new Function('return ' + src.slice(src.indexOf('function slskGenericBaseName')))()

test('track-number style names are treated as collision-prone', () => {
  for (const n of ['01.flac', '1.mp3', '03.flac', 'Track 03.mp3', 'track01.flac',
                   'CD1.flac', 'disc 2.flac', 't05.wav', '007.flac']) {
    assert.equal(isGeneric(n), true, n + ' should be generic')
  }
})

test('distinctive names still get the last-resort match', () => {
  for (const n of ['Bohemian Rhapsody.flac', '01 - Lone Digger.flac',
                   'Time (Dolby Atmos Mix).flac', 'Aja - Deacon Blues.flac']) {
    assert.equal(isGeneric(n), false, n + ' should NOT be generic')
  }
})

test('very short names are generic regardless of shape', () => {
  // Deliberately conservative: "Aja" is a real album, but a 3-character stem in
  // a shared download root is not distinctive enough to bet a playback action
  // on. Failing to resolve is the safe direction -- the app downloads the file
  // instead of playing something that merely shares a name. The seven
  // structured candidates still find legitimately-downloaded copies, because
  // slskd preserves the remote folder layout.
  assert.equal(isGeneric('a.flac'), true)
  assert.equal(isGeneric('ab.mp3'), true)
  assert.equal(isGeneric('aja.flac'), true)
})

test('the candidate list exists once, not once per handler', () => {
  // This used to grep for one distinctive line of the helper's body and check
  // it appeared nowhere else. That pinned the SPELLING of the implementation,
  // so refactoring the helper broke a test about duplication — and it would
  // equally have passed if a handler rebuilt the paths a slightly different
  // way. Assert the actual contract instead: every handler that needs a path
  // asks the helper for it, and nobody joins downloadDir themselves.
  const helperAt = M.indexOf('function slskCandidatePaths')
  assert.ok(helperAt > -1, 'slskCandidatePaths must still exist')
  const helperEnd = M.indexOf('\n}', helperAt)
  const helperBody = M.slice(helperAt, helperEnd)

  for (const handler of ['slsk-resolve-file', 'slsk-verify-file']) {
    // Anchored on the registration, not the bare name: the channel names also
    // appear in the IPC deadline table at the top of main.js, and indexOf found
    // that first.
    const at = M.indexOf(`ipcMain.handle('${handler}'`)
    assert.ok(at > -1, handler + ' must still be registered')
    const chunk = M.slice(at, at + 900)
    assert.match(chunk, /slskCandidatePaths\(/,
      handler + ' must resolve through the shared helper, not its own copy')
  }

  // And the joining itself happens only inside the helper. Anything outside it
  // that joins the download directory with spread segments is a second
  // implementation waiting to drift.
  const joins = [...M.matchAll(/path\.join\(\s*downloadDir\s*,\s*\.\.\./g)].map(m => m.index)
  assert.ok(joins.length > 0, 'sanity: the helper does join downloadDir')
  for (const at of joins) {
    assert.ok(at >= helperAt && at <= helperAt + helperBody.length,
      'candidate building must live only in slskCandidatePaths')
  }
})
