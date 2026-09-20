'use strict'
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-share')

// The folders actually on this machine, brackets, braces and spaces included.
const MUSIC = [
  '/mnt/data/MUSIC',
  '/mnt/windows/Music',
  '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}'
]
const DOWNLOADS = '/mnt/data/MUSIC/Downloads'

// ---------------------------------------------------------------------------
// The migration off the old three-way setting.
// ---------------------------------------------------------------------------

test('the old three-way mode migrates exactly as the table says', () => {
  assert.deepEqual(S.fromLegacyMode('library', MUSIC, DOWNLOADS),
    ['/mnt/data/MUSIC'], 'library means the FIRST music folder, not all of them')
  assert.deepEqual(S.fromLegacyMode('library', [], DOWNLOADS),
    [DOWNLOADS], 'no music folders yet: the download folder stands in')
  assert.deepEqual(S.fromLegacyMode('library', [], ''),
    [], 'nothing to fall back on')
  assert.deepEqual(S.fromLegacyMode('downloads', MUSIC, DOWNLOADS),
    [DOWNLOADS], "this machine's setting: the download folder, and only it")
  assert.deepEqual(S.fromLegacyMode('downloads', MUSIC, ''), [])
  assert.deepEqual(S.fromLegacyMode('off', MUSIC, DOWNLOADS),
    [], 'off shared nothing and still shares nothing')
  assert.deepEqual(S.fromLegacyMode('nonsense', MUSIC, DOWNLOADS),
    ['/mnt/data/MUSIC'], 'an unrecognised mode falls back to the old default')
  assert.deepEqual(S.fromLegacyMode(undefined, MUSIC, DOWNLOADS),
    ['/mnt/data/MUSIC'], 'so does a missing one')
})

// This is the test that proves nobody's setting changed meaning. `legacy` is
// a copy of the shareDirs() that shipped before folder ticking existed; if the
// new code ever hands the daemon a different list for the same old setting,
// somebody's machine starts sharing something they never agreed to.
test('the migration invariant: every legacy mode shares exactly what it shared before', () => {
  function legacy(mode, musicFolders, downloadDir) {
    const MODES = ['library', 'downloads', 'off']
    const m = MODES.indexOf(mode) >= 0 ? mode : 'library'
    if (m === 'off') return []
    if (m === 'downloads') return downloadDir ? [downloadDir] : []
    const first = (musicFolders || []).filter(Boolean)[0]
    if (first) return [first]
    return downloadDir ? [downloadDir] : []
  }

  const inputs = [
    { music: MUSIC, dl: DOWNLOADS },          // this machine, today
    { music: [], dl: DOWNLOADS },             // no library set up yet
    { music: MUSIC, dl: '' },                 // no download folder
    { music: [], dl: '' },                    // a brand new install
    { music: ['', null, '/mnt/data/MUSIC'], dl: DOWNLOADS }, // a blank row
    { music: ['/srv/one', '/srv/two'], dl: '/srv/one/dl' }
  ]

  for (const mode of ['library', 'downloads', 'off', 'nonsense', undefined]) {
    for (const { music, dl } of inputs) {
      const before = legacy(mode, music, dl)
      const after = S.shareDirs(S.fromLegacyMode(mode, music, dl), music, dl)
      assert.deepEqual(after, before,
        `mode ${String(mode)} with ${music.length} music folders and dl "${dl}"`)
    }
  }
})

test('an unmigrated store still produces the old file', () => {
  // shareDirs is handed the raw stored value on the first run after an
  // upgrade. A mode string is not a selection: route it through the migration
  // rather than reading "downloads" as a folder called downloads.
  assert.deepEqual(S.shareDirs('downloads', MUSIC, DOWNLOADS), [DOWNLOADS])
  assert.deepEqual(S.shareDirs('library', MUSIC, DOWNLOADS), ['/mnt/data/MUSIC'])
  assert.deepEqual(S.shareDirs('off', MUSIC, DOWNLOADS), [])
  assert.deepEqual(S.shareDirs(undefined, MUSIC, DOWNLOADS), ['/mnt/data/MUSIC'])
})

// ---------------------------------------------------------------------------
// The widened selection.
// ---------------------------------------------------------------------------

test('a selection of many folders shares many folders', () => {
  assert.deepEqual(
    S.shareDirs(['/mnt/data/MUSIC', '/mnt/windows/Music'], MUSIC, DOWNLOADS),
    ['/mnt/data/MUSIC', '/mnt/windows/Music'],
    'the one-folder ceiling is gone')
  assert.deepEqual(S.shareDirs([], MUSIC, DOWNLOADS), [],
    'an empty selection shares nothing — it is not a missing selection')
})

test('a ticked folder inside a ticked folder is only sent once', () => {
  const picked = [MUSIC[1], MUSIC[2]]
  assert.deepEqual(S.shareDirs(picked, MUSIC, DOWNLOADS), ['/mnt/windows/Music'],
    'the parent already covers the Aerosmith folder inside it')

  const { dirs, covered } = S.collapse(picked)
  assert.deepEqual(dirs, ['/mnt/windows/Music'])
  assert.deepEqual(covered, [{ path: MUSIC[2], coveredBy: '/mnt/windows/Music' }],
    'the child is reported, not silently dropped, so its row can say why')
})

test('a covered folder names the folder that is actually shared', () => {
  // /a is shared; /a/b and /a/b/c are both inside it. Naming /a/b would name a
  // folder that is not itself going to the daemon.
  const { dirs, covered } = S.collapse(['/a', '/a/b', '/a/b/c'])
  assert.deepEqual(dirs, ['/a'])
  assert.deepEqual(covered.map(c => c.coveredBy), ['/a', '/a'])
})

test('sibling folders that merely share a prefix are both shared', () => {
  assert.deepEqual(S.shareDirs(['/mnt/Music', '/mnt/Music2'], [], ''),
    ['/mnt/Music', '/mnt/Music2'], '/mnt/Music2 is not inside /mnt/Music')
})

test('the same folder spelled three ways is one folder', () => {
  assert.deepEqual(S.shareDirs(['/a', '/a/', '/a/../a'], [], ''), ['/a'])
  assert.deepEqual(S.shareDirs(['/a/b/', '', null, '/a/./b'], [], ''), ['/a/b'])
})

test('a folder that is no longer there is kept out of what the daemon is told', () => {
  const gone = MUSIC[2]
  const { present, missing } = S.filterMissing(
    [MUSIC[0], gone, DOWNLOADS], p => p !== gone)
  assert.deepEqual(present, [MUSIC[0], DOWNLOADS])
  assert.deepEqual(missing, [gone], 'the list needs it back to paint its row')
  assert.deepEqual(S.shareDirs(present, MUSIC, DOWNLOADS), [MUSIC[0]],
    'and the download folder lives inside /mnt/data/MUSIC, so the parent covers it')
})

test("this machine's download folder is inside its music folder", () => {
  // Ticking both is the likeliest thing he will do first. The daemon is told
  // /mnt/data/MUSIC once, not the same files twice under two names.
  const { dirs, covered } = S.collapse(['/mnt/data/MUSIC', DOWNLOADS])
  assert.deepEqual(dirs, ['/mnt/data/MUSIC'])
  assert.deepEqual(covered, [{ path: DOWNLOADS, coveredBy: '/mnt/data/MUSIC' }])
})

// ---------------------------------------------------------------------------
// The sentence under the list.
// ---------------------------------------------------------------------------

test('the sentence says which folders are exposed', () => {
  const one = S.describe([DOWNLOADS])
  assert.match(one, /this folder: \/mnt\/data\/MUSIC\/Downloads\./)
  assert.match(one, /Images, logs and text files stay hidden\./)

  const two = S.describe([DOWNLOADS, '/mnt/windows/Music'])
  assert.match(two, /these folders: \/mnt\/data\/MUSIC\/Downloads, \/mnt\/windows\/Music\./)
})

test('sharing nothing says so, and says what it costs', () => {
  const none = S.describe([])
  assert.match(none, /You're not sharing anything/)
  assert.match(none, /won't let you download from them if you share nothing back/)
  assert.equal(S.describe(undefined), none, 'no list reads the same as no folders')
})

// ── The gate that decides what strangers actually get ───────────────────────
// Three routes were found that could put an unjudged path into the stored
// selection: the download-folder chooser, the one-time migration reading the
// first music folder verbatim, and anything writing the store directly. A
// seeded selection of ["/", "/etc"] reached the daemon. Entry points should
// still refuse, but this is the gate that must hold.
test('the share read path refuses a dangerous folder even when one is stored', () => {
  const fs = require('fs')
  const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const body = MAIN.slice(MAIN.indexOf('function _slskShareDirs('),
                           MAIN.indexOf('function _slskShareLive('))
  assert.match(body, /_slskShareRefusal\(dir\)/,
    'every directory handed to the daemon is judged here, not only at entry')
  const refuseIdx = body.indexOf('_slskShareRefusal(dir)')
  const pushIdx = body.indexOf('out.push(dir)')
  assert.ok(refuseIdx > 0 && refuseIdx < pushIdx,
    'the refusal is checked before the directory can be added')
})

test('the download-folder chooser judges the folder it was given', () => {
  const fs = require('fs')
  const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = MAIN.indexOf("ipcMain.handle('slsk-set-download-dir'")
  const body = MAIN.slice(start, start + 2200)
  assert.match(body, /_slskShareRefusal\(downloadDir\)/, 'the chosen folder is judged')
  assert.ok(body.indexOf('_slskShareRefusal(downloadDir)') < body.indexOf("store.set('slskConfig'"),
    'and judged before anything is stored')
})

test('the transfers poll does not call out while Soulseek is off', () => {
  const fs = require('fs')
  const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = MAIN.indexOf("ipcMain.handle('slsk-get-transfers'")
  const body = MAIN.slice(start, start + 900)
  assert.match(body, /if \(!_slskEnabled\(\)\) return \{ off: true \}/,
    'off answers without touching the daemon')
  assert.ok(body.indexOf('_slskEnabled()') < body.indexOf('slskdFetch'),
    'and the gate comes before the request')
})
