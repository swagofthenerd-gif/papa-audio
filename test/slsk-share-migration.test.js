'use strict'
// The upgrade must not change one byte of what anybody shares.
//
// slskShareMode used to decide FOR you which single folder went out. It is now
// read exactly once, by a migration, and turned into a ticked folder list. If
// that migration got any row of its table wrong, somebody's machine would
// quietly start handing strangers a different folder than it did yesterday —
// and the first he would know about it is a stranger downloading something he
// never meant to share.
//
// So this file does not check that the migration "looks right". It runs the
// REAL writeSlskdConfig out of main.js, with a fake store and a fake disk, and
// compares the generated YAML text.
//
// Nothing here touches the real slskd.yml, the real daemon or the real store.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const nodePath = require('node:path')

const { liftFns } = require('./helpers/lift-main-fn.js')
const slskShare = require('../src/slsk-share.js')

// His actual machine, as of the day this was written: three music folders, the
// download folder inside the first one, and slskShareMode: 'downloads'.
const MUSIC = [
  '/mnt/data/MUSIC',
  '/mnt/windows/Music',
  '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}',
]
const DOWNLOADS = '/mnt/data/MUSIC/Downloads'

const SLSKD_DIR = nodePath.join(os.tmpdir(), 'papa-test-slskd')
const SLSKD_CFG = nodePath.join(SLSKD_DIR, 'slskd.yml')

// A store that only remembers, so what the migration writes can be inspected.
function fakeStore(seed) {
  const data = Object.assign({}, seed)
  return {
    data,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
    },
    set(key, value) { data[key] = value },
    delete(key) { delete data[key] },
  }
}

// Lift the real config writer and everything it leans on. `existing` is the set
// of folders this pretend machine actually has, so the missing-folder path can
// be exercised without unmounting anything.
function writer(seed, { existing = new Set([...MUSIC, DOWNLOADS]) } = {}) {
  const store = fakeStore(seed)
  const written = []
  const logged = []
  const { fns } = liftFns(
    ['writeSlskdConfig', '_slskShareSelection', '_slskShareDirs',
      '_slskUploadLimit', '_slskSpeedLimitKiB', '_slskNumberOrNull'],
    {
      store,
      slskShare,
      path: nodePath,
      SLSKD_DIR,
      SLSKD_CFG,
      SLSKD_PORT: 5030,
      _downloadDir: () => DOWNLOADS,
      _mintSlskdApiCreds: () => ({ username: 'papa', password: 'fixed-for-the-test' }),
      fs: {
        mkdirSync() {},
        existsSync: (p) => existing.has(p),
        writeFileSync(_p, text) { written.push(text) },
      },
      console: {
        log(m) { logged.push(String(m)) },
        warn(m) { logged.push(String(m)) },
        error(m) { logged.push(String(m)) },
      },
    },
    ['SLSK_UPLOAD_SLOTS_MIN', 'SLSK_UPLOAD_SLOTS_MAX', 'SLSK_UPLOAD_SLOTS_DEFAULT',
      'SLSK_UPLOAD_MBPS_MAX'])
  return {
    store,
    logged,
    write(opts) {
      fns.writeSlskdConfig(Object.assign({ username: 'u', password: 'p' }, opts))
      return written[written.length - 1]
    },
  }
}

// The `shares:` block on its own — the part that decides what strangers can
// see. It ends at the next top-level key, whatever that key happens to be, so
// adding a block after it cannot make this comparison quietly stop looking at
// the same text.
function sharesBlock(yml) {
  const from = yml.indexOf('\nshares:')
  assert.ok(from > -1, 'the generated config must still have a shares block')
  const rest = yml.slice(from + 1)
  const next = rest.search(/\n[a-z_]+:/)
  assert.ok(next > -1, 'and another top-level key after it')
  return '\n' + rest.slice(0, next)
}

// Just the directory lines — the folders themselves, not the filter list.
function shareDirLines(yml) {
  const block = sharesBlock(yml)
  const from = block.indexOf('  directories:')
  const to = block.indexOf('  filters:')
  return block.slice(from, to).split('\n').filter(l => l.startsWith('    - '))
}

// What the OLD code shared, for each value slskShareMode could hold on this
// machine. WRITTEN OUT BY HAND ON PURPOSE. Deriving it from slskShare instead
// would make the whole invariant circular: the migration and the expectation
// would go through the same function and move together, so breaking the
// migration table would break both sides and nothing would go red.
//
//   'library'   -> the FIRST music folder only, never all three
//   'downloads' -> the download folder
//   'off'       -> nothing
//   anything else, or absent -> the same as 'library' (the old DEFAULT)
const LEGACY_SHARED = {
  library: ['/mnt/data/MUSIC'],
  downloads: ['/mnt/data/MUSIC/Downloads'],
  off: [],
  'not-a-mode': ['/mnt/data/MUSIC'],
  absent: ['/mnt/data/MUSIC'],
}

// The "before" side of the invariant, in the emitter's own shape.
function legacySharesBlock(mode) {
  const dirs = LEGACY_SHARED[mode === undefined ? 'absent' : mode]
  assert.ok(dirs, 'every legacy mode under test needs a hand-written expectation')
  return [
    '',
    'shares:',
    '  directories:' + (dirs.length ? '' : ' []'),
    ...dirs.map(d => `    - ${JSON.stringify(d)}`),
    '  filters:',
    '    - \\.jpg$',
    '    - \\.png$',
    '    - \\.log$',
    '    - \\.cue$',
    '    - \\.txt$',
  ].join('\n')
}

const LEGACY_MODES = ['library', 'downloads', 'off', 'not-a-mode', undefined]

// ── The invariant ───────────────────────────────────────────────────────────

test('every legacy setting shares exactly the folders it shared before', () => {
  for (const mode of LEGACY_MODES) {
    const seed = { musicFolders: MUSIC, slskConfig: { downloadDir: DOWNLOADS } }
    if (mode !== undefined) seed.slskShareMode = mode
    const w = writer(seed)
    const after = sharesBlock(w.write({ downloadDir: DOWNLOADS }))
    assert.strictEqual(after, legacySharesBlock(mode),
      `the shares block changed for slskShareMode ${JSON.stringify(mode)}`)
  }
})

test("this machine's own setting keeps meaning the one folder it means today", () => {
  const w = writer({
    slskShareMode: 'downloads',
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const yml = w.write({ downloadDir: DOWNLOADS })

  assert.strictEqual(sharesBlock(yml), legacySharesBlock('downloads'))
  assert.match(yml, /\n {4}- "\/mnt\/data\/MUSIC\/Downloads"\n/)
  assert.ok(!yml.includes('"/mnt/windows/Music"'),
    'his music folders are not shared today and must not start being shared')
  assert.deepStrictEqual(w.store.data.slskShareFolders, [DOWNLOADS],
    'and the ticked list he now sees is that same single folder')
})

test('the stored path reaches the YAML as the exact bytes it was stored as', () => {
  // The old shareDirs() handed the stored string to the YAML writer verbatim.
  // The new pipeline normalises first, so a stored path that came back from
  // normalisePath as a different string — even a merely re-joined one — would
  // mean a rewritten slskd.yml and a multi-minute share rescan for a change
  // nobody made. His real stored values, one at a time, through the real writer.
  for (const folder of [DOWNLOADS].concat(MUSIC)) {
    const w = writer({
      slskShareFolders: [folder],
      musicFolders: MUSIC,
      slskConfig: { downloadDir: DOWNLOADS },
    })
    assert.deepStrictEqual(shareDirLines(w.write({ downloadDir: DOWNLOADS })),
      ['    - ' + JSON.stringify(folder)],
      'the folder he shares must reach slskd.yml spelled exactly as it is stored')
    assert.deepStrictEqual(w.store.data.slskShareFolders, [folder],
      'and must not be rewritten in the store either')
  }
})

test('a stored path that is NOT in one spelling is still tidied up', () => {
  // The other half of the same rule: normalisation has to keep happening where
  // there is something to normalise, or '/a/b' and '/a/b/' become two folders
  // and slskd indexes the same music twice.
  const w = writer({
    slskShareFolders: [DOWNLOADS + '/', '/mnt/data/MUSIC/./Downloads'],
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  assert.deepStrictEqual(shareDirLines(w.write({ downloadDir: DOWNLOADS })),
    ['    - ' + JSON.stringify(DOWNLOADS)], 'two spellings, one folder')
})

test('the migration writes the list down and leaves the old key where it was', () => {
  const w = writer({
    slskShareMode: 'library',
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  w.write({ downloadDir: DOWNLOADS })

  assert.deepStrictEqual(w.store.data.slskShareFolders, ['/mnt/data/MUSIC'],
    "'library' was ever only the FIRST music folder, and stays that")
  assert.strictEqual(w.store.data.slskShareMode, 'library',
    'the old key is left untouched so an older build still works after a rollback')
})

test('writing the config a second time changes nothing, so the upgrade costs no rescan', () => {
  // The point of the whole invariant: the file the migration writes is the file
  // already on disk, so slskd has no reason to re-read 400 GB of music.
  const w = writer({
    slskShareMode: 'downloads',
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const first = w.write({ downloadDir: DOWNLOADS })
  assert.ok(Array.isArray(w.store.data.slskShareFolders), 'the migration has now run')
  const second = w.write({ downloadDir: DOWNLOADS })
  assert.strictEqual(second, first, 'the whole file, not just the shares block')
})

test('the shares block matches the one on this machine right now', () => {
  // The strongest check available: the text this code generates against the
  // text his running daemon is actually reading. Skipped anywhere that file
  // does not exist, so this suite still runs on a clean machine.
  const live = nodePath.join(os.homedir(), '.config', 'papa-audio', 'slskd', 'slskd.yml')
  if (!fs.existsSync(live)) return
  const onDisk = fs.readFileSync(live, 'utf8')
  if (!onDisk.includes('\nshares:')) return
  const w = writer({
    slskShareMode: 'downloads',
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  assert.strictEqual(sharesBlock(w.write({ downloadDir: DOWNLOADS })), sharesBlock(onDisk))
})

// ── The one place the text is allowed to differ ─────────────────────────────

test('a folder that is not on this machine is dropped, and says so out loud', () => {
  // The old code handed slskd a dead path. slskd shared nothing from it either
  // way, so WHAT GOES OUT is unchanged — but the file now says what is true,
  // and the dropped folder is named in the log rather than vanishing quietly.
  const w = writer(
    { slskShareFolders: ['/mnt/data/MUSIC', '/mnt/elsewhere/Gone'], musicFolders: MUSIC },
    { existing: new Set([...MUSIC, DOWNLOADS]) })
  const yml = w.write({ downloadDir: DOWNLOADS })

  assert.match(yml, /\n {4}- "\/mnt\/data\/MUSIC"\n/, 'the folder that is there still goes out')
  assert.ok(!yml.includes('/mnt/elsewhere/Gone'), 'the one that is not, does not')
  assert.ok(w.logged.some(m => m.includes('/mnt/elsewhere/Gone') && m.includes('not there any more')),
    'and it is named, because a folder silently not being shared is the bug')
})

test('a folder inside another ticked folder is only handed over once', () => {
  const w = writer({
    slskShareFolders: [
      '/mnt/windows/Music',
      '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}',
    ],
    musicFolders: MUSIC,
  })
  const dirs = shareDirLines(w.write({ downloadDir: DOWNLOADS }))
  assert.deepStrictEqual(dirs, ['    - "/mnt/windows/Music"'],
    'the parent already covers the child; sending both makes slskd index it twice')
})

// ── The upload limit lands in the file the daemon reads ─────────────────────

test('the upload block is written, and the speed key is absent when there is no cap', () => {
  const w = writer({ musicFolders: MUSIC, slskShareFolders: [DOWNLOADS] })
  const yml = w.write({ downloadDir: DOWNLOADS })
  assert.match(yml, /\ntransfers:\n {2}upload:\n {4}slots: 4\n/,
    'four slots ship by default, down from the ten slskd uses on its own')
  assert.ok(!yml.includes('speed_limit'),
    'no cap means the key is left out entirely, not written as a number that means something else')
})

test('a speed cap is written in the kibibytes the daemon expects', () => {
  const w = writer({
    musicFolders: MUSIC,
    slskShareFolders: [DOWNLOADS],
    slskUploadLimit: { slots: 6, mbps: 1 },
  })
  const yml = w.write({ downloadDir: DOWNLOADS })
  assert.match(yml, /\n {4}slots: 6\n {4}speed_limit: 977\n/,
    '1 MB/s is 1,000,000 bytes/s, which is 977 KiB/s')
})
