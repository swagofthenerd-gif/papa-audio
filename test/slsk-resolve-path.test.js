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
  const helper = M.indexOf('function slskCandidatePaths')
  const body = M.slice(helper, M.indexOf('\n}', M.indexOf('return out.filter', helper)))
  // Every occurrence of the distinctive tail2 line must be inside the helper.
  const all = [...M.matchAll(/tail2\.length \? path\.join/g)].map(m => m.index)
  for (const at of all) {
    assert.ok(at > helper && at < helper + body.length + 200,
      'candidate building must live only in slskCandidatePaths')
  }
  assert.ok(all.length >= 2, 'sanity: the helper builds both tail2 candidates')
})
