'use strict'
// The seven channels the Settings → Soulseek panel is built on.
//
// The panel is written against these answers, so the shapes here are a
// contract, not an implementation detail: a key quietly renamed or dropped
// shows up as a blank row or an undefined in a sentence, which is precisely the
// class of silent failure this whole piece of work exists to remove.
//
// Every test RUNS the real handler out of main.js. Nothing here touches the
// real daemon, the real slskd.yml, the real store or the user's account.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const nodePath = require('node:path')

const { runHandler, MAIN_PATH } = require('./helpers/lift-ipc.js')

// The real helpers the handlers delegate to, run alongside them. Without these
// the sandbox hands the handler a recording stub and the test ends up asserting
// against a Proxy instead of against the code.
const SHARE_HELPERS = ['_slskShareSelection', '_slskShareDirs', '_slskShareCandidates',
  '_slskShareLive', '_slskUploadLimit', '_slskSpeedLimitKiB', '_slskNumberOrNull',
  '_slskUploadLimitText',
  // The refusal predicate that decides what may go out, and the two helpers it
  // is built from. As recording stubs they answer "refuse everything".
  '_slskRealPath', '_slskRefusalOpts', '_slskShareRefusal']
const slskShare = require('../src/slsk-share.js')

const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')

const MUSIC = [
  '/mnt/data/MUSIC',
  '/mnt/windows/Music',
  '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}',
]
const DOWNLOADS = '/mnt/data/MUSIC/Downloads'

// A store that only remembers, plus the few real things the handlers lean on.
function env(seed, extra) {
  const data = Object.assign({}, seed)
  const wrote = []
  return Object.assign({
    _wrote: wrote,
    store: {
      data,
      get: (k, d) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d),
      set: (k, v) => { data[k] = v },
    },
    slskShare,
    path: nodePath,
    fs: {
      existsSync: (p) => p !== '/mnt/elsewhere/Gone',
      // This pretend machine has no symlinks: every path is already real.
      realpathSync: (p) => p,
    },
    app: { getPath: () => '/home/shaharyar' },
    SLSKD_DIR: '/home/shaharyar/.config/papa-audio/slskd',
    _downloadDir: () => DOWNLOADS,
    _slskEnabled: () => true,
    writeSlskdConfig(opts) { wrote.push(opts) },
    slskdProc: null,
    slskdReady: false,
    _data: data,
  }, extra || {})
}

// ── slsk-share-folders-get ──────────────────────────────────────────────────

test('the folder list hands over every row the panel has to draw', async () => {
  const globals = env({
    slskShareMode: 'downloads',
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const { result } = await runHandler('slsk-share-folders-get', { globals, alsoLift: SHARE_HELPERS })

  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(Array.from(result.selected), [DOWNLOADS])
  assert.strictEqual(result.migrated, true, 'this store had never been migrated')
  assert.strictEqual(typeof result.text, 'string')

  const rows = Array.from(result.candidates)
  assert.strictEqual(rows.length, 4, 'three music folders and the download folder')
  for (const row of rows) {
    for (const key of ['path', 'label', 'source', 'selected', 'missing', 'coveredBy']) {
      assert.ok(key in row, 'every row needs ' + key + ': ' + JSON.stringify(row))
    }
    assert.ok(['music', 'download', 'custom'].includes(row.source), row.source)
  }

  const downloads = rows.find(r => r.path === DOWNLOADS)
  assert.strictEqual(downloads.source, 'download')
  assert.strictEqual(downloads.selected, true, 'the folder he shares today is the ticked one')
  assert.strictEqual(downloads.label, 'Downloads', 'the label is the folder name, not the path')

  const music = rows.find(r => r.path === '/mnt/data/MUSIC')
  assert.strictEqual(music.source, 'music')
  assert.strictEqual(music.selected, false, 'and his library is NOT shared today')
})

test('a folder he picked by hand keeps its row, marked as his own', async () => {
  const globals = env({
    slskShareFolders: ['/mnt/other/Bootlegs'],
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const { result } = await runHandler('slsk-share-folders-get', { globals, alsoLift: SHARE_HELPERS })
  const row = Array.from(result.candidates).find(r => r.path === '/mnt/other/Bootlegs')
  assert.ok(row, 'nothing else in the app knows about it, so this list has to')
  assert.strictEqual(row.source, 'custom')
  assert.strictEqual(row.selected, true)
  assert.strictEqual(result.migrated, false, 'an already-migrated store is not migrated twice')
})

test('a folder that is gone is marked missing rather than quietly dropped', async () => {
  const globals = env({
    slskShareFolders: ['/mnt/elsewhere/Gone'],
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const { result } = await runHandler('slsk-share-folders-get', { globals, alsoLift: SHARE_HELPERS })
  const row = Array.from(result.candidates).find(r => r.path === '/mnt/elsewhere/Gone')
  assert.strictEqual(row.missing, true, 'the row is what says "can\'t find this folder any more"')
  assert.strictEqual(row.selected, true, 'it keeps its tick — an unmounted drive comes back')
})

test('a ticked folder inside another ticked folder is told which one covers it', async () => {
  const globals = env({
    slskShareFolders: [
      '/mnt/windows/Music',
      '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}',
    ],
    musicFolders: MUSIC,
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const { result } = await runHandler('slsk-share-folders-get', { globals, alsoLift: SHARE_HELPERS })
  const rows = Array.from(result.candidates)
  const child = rows.find(r => r.path.includes('Aerosmith'))
  const parent = rows.find(r => r.path === '/mnt/windows/Music')
  assert.strictEqual(child.coveredBy, '/mnt/windows/Music',
    'the row says which folder it is already inside, by name')
  assert.strictEqual(parent.coveredBy, null, 'and the parent is covered by nothing')
})

// ── slsk-share-folders-set ──────────────────────────────────────────────────

test('applying a choice stores it, writes the config and says what goes out', async () => {
  const globals = env({ musicFolders: MUSIC, slskConfig: { downloadDir: DOWNLOADS } })
  const { result } = await runHandler('slsk-share-folders-set', {
    args: { folders: [DOWNLOADS, '/mnt/windows/Music/'] }, globals, alsoLift: SHARE_HELPERS,
  })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(Array.from(result.folders), [DOWNLOADS, '/mnt/windows/Music'],
    'the trailing slash is one spelling of the same folder, not a second folder')
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders),
    [DOWNLOADS, '/mnt/windows/Music'])
  assert.strictEqual(globals._wrote.length, 1, 'slskd.yml is rewritten exactly once')
  assert.strictEqual(typeof result.text, 'string')
  assert.strictEqual(result.restarted, false, 'nothing was running to restart')
})

test('the same folder ticked twice is one folder, not two', async () => {
  // Two spellings reach the handler whenever a hand-picked folder is also a
  // music folder. Writing it twice makes slskd index the same files twice.
  const globals = env({ musicFolders: MUSIC, slskConfig: { downloadDir: DOWNLOADS } })
  const { result } = await runHandler('slsk-share-folders-set', {
    args: { folders: [DOWNLOADS, DOWNLOADS + '/', '/mnt/data/MUSIC/./Downloads'] },
    globals, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(result.folders), [DOWNLOADS])
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders), [DOWNLOADS])
})

test('a relative or empty path is never written into the share list', async () => {
  const globals = env({ musicFolders: MUSIC, slskConfig: { downloadDir: DOWNLOADS } })
  const { result } = await runHandler('slsk-share-folders-set', {
    args: { folders: ['', '  ', 'Music', '../etc', DOWNLOADS] },
    globals, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(result.folders), [DOWNLOADS],
    'only absolute paths reach slskd.yml')
})

test('unticking everything is allowed, and says what it costs', async () => {
  const globals = env({ musicFolders: MUSIC, slskConfig: { downloadDir: DOWNLOADS } })
  const { result } = await runHandler('slsk-share-folders-set', {
    args: { folders: [] }, globals, alsoLift: SHARE_HELPERS,
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.folders.length, 0)
  assert.match(result.text, /not sharing anything/i)
  assert.match(result.text, /share nothing back/i,
    'and it says why that will cost him downloads')
})

// ── slsk-share-folder-pick ──────────────────────────────────────────────────

test('the folder chooser refuses the home folder and says what it would have done', async () => {
  const globals = env({}, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/home/shaharyar'] }) },
    app: { getPath: () => '/home/shaharyar' },
    SLSKD_DIR: '/home/shaharyar/.config/papa-audio/slskd',
  })
  const { result } = await runHandler('slsk-share-folder-pick', { globals, alsoLift: SHARE_HELPERS })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.refused, true)
  assert.strictEqual(result.reason, 'home')
  assert.match(result.error, /everything on this computer on Soulseek/)
})

test('the folder chooser refuses a whole drive', async () => {
  const globals = env({}, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/mnt'] }) },
    app: { getPath: () => '/home/shaharyar' },
    SLSKD_DIR: '/home/shaharyar/.config/papa-audio/slskd',
  })
  const { result } = await runHandler('slsk-share-folder-pick', { globals, alsoLift: SHARE_HELPERS })
  assert.strictEqual(result.reason, 'drive')
  assert.match(result.error, /whole drive/)
})

test('a real music folder is accepted, and nothing is written yet', async () => {
  const globals = env({}, {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/mnt/data/MUSIC/'] }) },
    app: { getPath: () => '/home/shaharyar' },
    SLSKD_DIR: '/home/shaharyar/.config/papa-audio/slskd',
  })
  const { result } = await runHandler('slsk-share-folder-pick', { globals, alsoLift: SHARE_HELPERS })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.path, '/mnt/data/MUSIC', 'one spelling, trailing slash removed')
  assert.strictEqual(globals._wrote.length, 0,
    'picking is not applying — nothing reaches the daemon until he presses Apply')
  assert.strictEqual(globals._data.slskShareFolders, undefined,
    'and nothing is stored either')
})

test('cancelling the chooser is not a refusal and not an error', async () => {
  const globals = env({}, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    app: { getPath: () => '/home/shaharyar' },
  })
  const { result } = await runHandler('slsk-share-folder-pick', { globals, alsoLift: SHARE_HELPERS })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.cancelled, true)
  assert.strictEqual(result.refused, undefined, 'no scolding sentence for a change of mind')
})

// ── slsk-enabled-get / set ──────────────────────────────────────────────────

test('the switch reports what it is and when it comes back', async () => {
  const globals = env({}, { _slskEnabled: () => false, _slskOffUntil: () => 1758000000000 })
  const { result } = await runHandler('slsk-enabled-get', { globals })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.enabled, false)
  assert.strictEqual(result.offUntil, 1758000000000)
  assert.strictEqual(result.running, false)
  assert.strictEqual(result.connected, false)
})

test('turning it off persists the choice before anything else can consult it', async () => {
  const globals = env({}, { _slskGoOff: async () => 'disconnected' })
  const { result } = await runHandler('slsk-enabled-set', { args: { enabled: false }, globals })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.enabled, false)
  assert.strictEqual(result.offUntil, null)
  assert.strictEqual(result.method, 'disconnected')
  // Persisted, not just in memory: the health supervisor, the launch gate and
  // the other six paths all read the store, and a relaunch reads nothing else.
  assert.strictEqual(globals._data.slskdEnabled, false)
  assert.strictEqual(globals._data.slskdOffUntil, null)
})

test('"back on in an hour" is stored as a time, so it survives a quit', async () => {
  const before = Date.now()
  const globals = env({}, { _slskGoOff: async () => 'disconnected' })
  const { result } = await runHandler('slsk-enabled-set', {
    args: { enabled: false, forMinutes: 60 }, globals,
  })
  assert.ok(result.offUntil >= before + 60 * 60000)
  assert.ok(result.offUntil <= Date.now() + 60 * 60000)
  assert.strictEqual(globals._data.slskdOffUntil, result.offUntil,
    'a timer alone would be forgotten the moment he quits')
})

test('turning it back on clears the timer as well as the flag', async () => {
  const globals = env({ slskdEnabled: false, slskdOffUntil: 1758000000000 },
    { _slskGoOn: async () => 'reconnected' })
  const { result } = await runHandler('slsk-enabled-set', { args: { enabled: true }, globals })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.enabled, true)
  assert.strictEqual(result.offUntil, null)
  assert.strictEqual(result.method, 'reconnected')
  assert.strictEqual(result.restarted, false, 'a reconnect is about a second, not a restart')
  assert.strictEqual(globals._data.slskdEnabled, true)
  assert.strictEqual(globals._data.slskdOffUntil, null)
})

test('a cold start is reported as a restart, because it is minutes not seconds', async () => {
  const globals = env({ slskdEnabled: false }, { _slskGoOn: async () => 'started' })
  const { result } = await runHandler('slsk-enabled-set', { args: { enabled: true }, globals })
  assert.strictEqual(result.method, 'started')
  assert.strictEqual(result.restarted, true)
})

test('a daemon that will not come back on says so instead of showing a tick', async () => {
  const globals = env({}, { _slskGoOn: async () => { throw new Error('spawn failed') } })
  const { result } = await runHandler('slsk-enabled-set', { args: { enabled: true }, globals })
  assert.strictEqual(result.ok, false)
  assert.match(result.error, /spawn failed/)
})

// ── slsk-upload-limit-get / set ─────────────────────────────────────────────

test('the upload limit reads back as numbers and a sentence', async () => {
  const globals = env({}, { _slskUploadLimit: () => ({ slots: 4, mbps: 0 }),
    _slskUploadLimitText: () => 'Right now: 4 people at a time, no speed limit.' })
  const { result } = await runHandler('slsk-upload-limit-get', { globals })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.slots, 4)
  assert.strictEqual(result.mbps, 0)
  assert.match(result.text, /^Right now: /)
})

test('setting the upload limit stores it, rewrites the config and claims no restart', async () => {
  const globals = env({}, {
    _slskUploadLimit: () => ({ slots: 6, mbps: 1 }),
    _slskUploadLimitText: () => 'Right now: 6 people at a time, 1.0 MB/s all together.',
  })
  const { result } = await runHandler('slsk-upload-limit-set', {
    args: { slots: 6, mbps: 1 }, globals,
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.slots, 6)
  assert.strictEqual(result.mbps, 1)
  // Measured against slskd 0.26.0.0: it watches its own config file and picked
  // the new numbers up within seconds, with no restart. If a future daemon
  // stops doing that, this is the assertion that has to change and the copy
  // with it — not a silent half-measure.
  assert.strictEqual(result.applied, 'live')
  assert.deepStrictEqual(Object.assign({}, globals._data.slskUploadLimit), { slots: 6, mbps: 1 })
  assert.strictEqual(globals._wrote.length, 1, 'slskd.yml is rewritten exactly once')
})

// ── The plumbing around them ────────────────────────────────────────────────

test('every new channel that changes something is deadline-exempt', () => {
  // A deadline on a folder chooser cancels the user, and a deadline on Apply
  // kills a legitimate multi-minute share rescan.
  const table = MAIN.slice(MAIN.indexOf('const IPC_TIMEOUT_OVERRIDES = {'),
    MAIN.indexOf('const _ipcRawHandle'))
  for (const ch of ['slsk-share-folders-set', 'slsk-share-folder-pick',
    'slsk-enabled-set', 'slsk-upload-limit-set']) {
    assert.ok(new RegExp("'" + ch + "': 0").test(table), ch + ' needs a 0 entry')
  }
})

test('every new channel is reachable from the renderer', () => {
  // A handler with no preload binding is a handler nothing can call, and the
  // panel is built entirely out of these seven names.
  const PRE = fs.readFileSync(nodePath.join(__dirname, '..', 'preload.js'), 'utf8')
  const pairs = [
    ['slskShareFoldersGet', 'slsk-share-folders-get'],
    ['slskShareFoldersSet', 'slsk-share-folders-set'],
    ['slskShareFolderPick', 'slsk-share-folder-pick'],
    ['slskEnabledGet', 'slsk-enabled-get'],
    ['slskEnabledSet', 'slsk-enabled-set'],
    ['slskUploadLimitGet', 'slsk-upload-limit-get'],
    ['slskUploadLimitSet', 'slsk-upload-limit-set'],
  ]
  for (const [name, channel] of pairs) {
    assert.ok(PRE.includes(name + ':'), 'preload.js is missing ' + name)
    assert.ok(new RegExp("invoke\\('" + channel + "'").test(PRE),
      name + ' must invoke ' + channel)
    assert.ok(MAIN.includes("ipcMain.handle('" + channel + "'"),
      'main.js is missing a handler for ' + channel)
  }
})

test('a shared folder becomes readable and gains no power to delete or move', () => {
  // "Show in folder" has to work on a file in a folder he shares by hand. It
  // must NOT become a library root: that would hand it delete and move rights
  // and make it visible to the phone over the LAN bridge.
  const roots = MAIN.slice(MAIN.indexOf('function papaRoots()'),
    MAIN.indexOf('function pathIsOurs('))
  assert.match(roots, /slskShareFolders/)
  const libRoots = MAIN.slice(MAIN.indexOf('function libRoots()'),
    MAIN.indexOf('function libDeletableRoots()'))
  assert.ok(!libRoots.includes('slskShareFolders'),
    'a shared folder is not a library root')
  const deletable = MAIN.slice(MAIN.indexOf('function libDeletableRoots()'),
    MAIN.indexOf('function papaRoots()'))
  assert.ok(!deletable.includes('slskShareFolders'),
    'and nothing in it may be deleted because it is shared')
})

test('papaRoots stays side-effect free, so a guard never creates a folder', () => {
  // _slskShareSelection() writes to the store and _downloadDir() creates
  // directories. A permission check that does either is a permission check that
  // changes the machine it is asked about.
  const roots = MAIN.slice(MAIN.indexOf('function papaRoots()'),
    MAIN.indexOf('function pathIsOurs('))
  assert.ok(!roots.includes('_slskShareSelection'),
    'read the stored list directly; do not run the migration from inside a guard')
  assert.ok(!roots.includes('mkdirSync'))
})
