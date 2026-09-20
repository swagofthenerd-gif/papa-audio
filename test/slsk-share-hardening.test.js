'use strict'
// What he shares with strangers must not change unless he presses something,
// and must never include a folder he did not choose.
//
// Three adversarial passes over the new sharing code found thirteen ways that
// promise was still breakable. This file is one test per hole, and every one of
// them RUNS the fixed code — the handler out of main.js, the pure predicate,
// the renderer's painter — rather than checking that some string is still
// present in a file. A string search stays green through any change that keeps
// the string, which is exactly how a guard ends up present and never reached.
//
// Nothing here touches the real daemon, the real slskd.yml, the real store or
// anything under ~/.config/papa-audio. The symlink test builds its links in a
// fresh temporary directory and takes them away again.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const nodePath = require('node:path')
const vm = require('node:vm')

const { runHandler, callSource, MAIN_PATH } = require('./helpers/lift-ipc.js')
const { liftFns } = require('./helpers/lift-main-fn.js')
const slskShare = require('../src/slsk-share.js')

const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')
const PRELOAD = fs.readFileSync(nodePath.join(__dirname, '..', 'preload.js'), 'utf8')
const HTML = fs.readFileSync(nodePath.join(__dirname, '..', 'src', 'index.html'), 'utf8')
const RENDERER = fs.readFileSync(nodePath.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// His actual machine: three music folders, the download folder inside the
// first, and exactly one folder going out.
const MUSIC = [
  '/mnt/data/MUSIC',
  '/mnt/windows/Music',
  '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}',
]
const DOWNLOADS = '/mnt/data/MUSIC/Downloads'
const HOME = '/home/shaharyar'
const SLSKD_DIR = HOME + '/.config/papa-audio/slskd'

// Everything the share handlers delegate to, run for real alongside them.
const SHARE_HELPERS = ['_slskShareSelection', '_slskShareDirs', '_slskShareCandidates',
  '_slskShareLive', '_slskUnshareFolder', '_slskRealPath', '_slskRefusalOpts',
  '_slskShareRefusal', '_slskMusicFolderRefusal', '_refuseMusicFolder',
  '_slskUploadLimit',
  '_slskSpeedLimitKiB', '_slskNumberOrNull', '_slskUploadLimitText']

// A store that only remembers, plus the real path handling the handlers lean
// on. `present` is the set of folders this pretend machine actually has.
function env(seed, extra) {
  const data = Object.assign({}, seed)
  const wrote = []
  const boxes = []
  const present = (extra && extra._present) || null
  return Object.assign({
    _wrote: wrote,
    _boxes: boxes,
    _data: data,
    store: {
      data,
      get: (k, d) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d),
      set: (k, v) => { data[k] = v },
    },
    slskShare,
    path: nodePath,
    fs: {
      existsSync: (p) => (present ? present.has(p) : true),
      statSync: () => ({ isDirectory: () => true }),
      // No symlinks on this pretend machine: every path is already real.
      realpathSync: (p) => p,
    },
    app: { getPath: () => HOME },
    SLSKD_DIR,
    dialog: {
      showMessageBox: (_w, opts) => { boxes.push(opts) },
    },
    _downloadDir: () => (data.slskConfig && data.slskConfig.downloadDir) || DOWNLOADS,
    _slskEnabled: () => true,
    writeSlskdConfig(opts) { wrote.push(opts) },
    setupLibraryWatcher() {},
    slskdProc: null,
    slskdReady: false,
  }, extra || {})
}

function started(calls) {
  return calls.some(c => String(c).startsWith('startSlskd'))
}

// ── A1. A folder he removes from his library stops being shared ─────────────
// The old three-way mode was DYNAMIC: it named "the first music folder", so
// removing that folder changed what went out by itself. The ticked list is a
// snapshot of paths, so without a prune here a folder he deliberately took out
// of his library stays on Soulseek for good.

test('removing a music folder takes it off the share list too', async () => {
  const globals = env({
    musicFolders: MUSIC.slice(),
    slskShareFolders: [DOWNLOADS, '/mnt/windows/Music'],
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const { result } = await runHandler('remove-music-folder', {
    args: '/mnt/windows/Music', globals, alsoLift: SHARE_HELPERS,
  })
  assert.ok(!Array.from(result).includes('/mnt/windows/Music'),
    'it is out of the library')
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders), [DOWNLOADS],
    'and out of what strangers can browse')
  assert.strictEqual(globals._wrote.length, 1,
    'what goes out changed, so slskd.yml is rewritten')
})

test('removing a folder that was never ticked rewrites nothing', async () => {
  // A config rewrite bounces the daemon and costs a multi-minute share rescan.
  // Doing that when not one byte of what goes out has changed is a punishment
  // for tidying his library.
  const globals = env({
    musicFolders: MUSIC.slice(),
    slskShareFolders: [DOWNLOADS],
    slskConfig: { downloadDir: DOWNLOADS },
  })
  await runHandler('remove-music-folder', {
    args: '/mnt/windows/Music', globals, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders), [DOWNLOADS])
  assert.strictEqual(globals._wrote.length, 0)
})

test('unsharing a removed folder bounces the daemon only when Soulseek is on', async () => {
  const seed = () => ({
    musicFolders: MUSIC.slice(),
    slskShareFolders: [DOWNLOADS, '/mnt/windows/Music'],
    slskConfig: { downloadDir: DOWNLOADS },
  })
  const off = env(seed(), { _slskEnabled: () => false, slskdReady: true })
  const r1 = await runHandler('remove-music-folder', {
    args: '/mnt/windows/Music', globals: off, alsoLift: SHARE_HELPERS,
  })
  assert.ok(!started(r1.calls), 'off means off, even when the share list changes')
  assert.strictEqual(off._wrote.length, 1, 'the choice is still written down')

  const on = env(seed(), { _slskEnabled: () => true, slskdReady: true })
  const r2 = await runHandler('remove-music-folder', {
    args: '/mnt/windows/Music', globals: on, alsoLift: SHARE_HELPERS,
  })
  assert.ok(started(r2.calls), 'with Soulseek on, the daemon re-reads the new list')
})

// ── A2. Moving the download folder takes its tick with it ───────────────────
// His stored mode is 'downloads', so his migrated selection is the download
// folder BY PATH. Without this he silently shares the folder he walked away
// from and silently stops sharing the one he chose.

test('moving the download folder moves its tick', async () => {
  const globals = env({
    musicFolders: MUSIC.slice(),
    slskShareFolders: [DOWNLOADS],
    slskConfig: { downloadDir: DOWNLOADS },
  }, {
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/mnt/data/MUSIC/New Downloads'] }),
    },
  })
  const { result } = await runHandler('slsk-set-download-dir', {
    args: {}, globals, alsoLift: SHARE_HELPERS,
  })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders),
    ['/mnt/data/MUSIC/New Downloads'],
    'the folder he shares is the one he just chose, not the one he left')
})

test('moving the download folder leaves an unticked one unticked', async () => {
  const globals = env({
    musicFolders: MUSIC.slice(),
    slskShareFolders: ['/mnt/windows/Music'],
    slskConfig: { downloadDir: DOWNLOADS },
  }, {
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/mnt/data/MUSIC/New Downloads'] }),
    },
  })
  await runHandler('slsk-set-download-dir', { args: {}, globals, alsoLift: SHARE_HELPERS })
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders), ['/mnt/windows/Music'],
    'moving a folder he was not sharing does not start sharing anything')
})

// ── A3. The dead three-way handlers are gone ────────────────────────────────

test('nothing can set the old sharing mode over IPC any more', () => {
  // callSource is the real registration finder the whole IPC harness runs on,
  // so this fails the moment a handler for either channel exists again.
  for (const channel of ['slsk-share-mode-get', 'slsk-share-mode-set']) {
    assert.throws(() => callSource(MAIN, channel), /no ipcMain\.handle/,
      channel + ' is registered again; it overwrites the whole ticked list')
  }
  assert.ok(!PRELOAD.includes('slskShareModeGet'), 'and the renderer cannot reach it')
  assert.ok(!PRELOAD.includes('slskShareModeSet'))
})

test('the share module no longer hands out the old mode vocabulary', () => {
  assert.strictEqual(slskShare.MODES, undefined, 'nothing needs the mode list')
  assert.strictEqual(slskShare.normalise, undefined, 'or the mode normaliser')
  assert.strictEqual(typeof slskShare.fromLegacyMode, 'function',
    'but the migration that reads the old key once is still there')
  assert.strictEqual(slskShare.DEFAULT, 'library',
    'and main still reads the old key\'s absent value by name')
})

// ── A4. A canonical path survives normalisation byte for byte ───────────────
// The old code handed the stored path to the YAML writer verbatim. The folder
// he shares today has to come out of normalisePath as the same string, or the
// upgrade rewrites slskd.yml and pays for a share rescan that changed nothing.

test('a path that is already in one spelling comes back as the same string', () => {
  // The canonical fast path is what makes this true by construction rather
  // than by the rebuild happening to land on the same characters. The half of
  // it that can actually go wrong — and that a test can see — is the
  // judgement of WHICH paths are already canonical, which is the next test.
  for (const p of [DOWNLOADS].concat(MUSIC)) {
    assert.strictEqual(slskShare.normalisePath(p), p)
  }
})

test('a path that needs work is still normalised, and only then', () => {
  assert.strictEqual(slskShare.normalisePath(DOWNLOADS + '/'), DOWNLOADS)
  assert.strictEqual(slskShare.normalisePath('/mnt/data//MUSIC/./Downloads'), DOWNLOADS)
  assert.strictEqual(slskShare.normalisePath('/mnt/data/MUSIC/x/../Downloads'), DOWNLOADS)
  assert.strictEqual(slskShare.normalisePath('/'), '/')
})

// ── B1. The guard is on the channel that commits, not only on the dialog ────

test('the channel that decides what goes out refuses a whole drive', async () => {
  const globals = env({ musicFolders: MUSIC.slice(), slskConfig: { downloadDir: DOWNLOADS } })
  const { result } = await runHandler('slsk-share-folders-set', {
    args: { folders: ['/', HOME, '/etc', SLSKD_DIR, DOWNLOADS] },
    globals, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(result.folders), [DOWNLOADS],
    'only the music folder survives')
  assert.deepStrictEqual(Array.from(globals._data.slskShareFolders), [DOWNLOADS],
    'and nothing else was ever stored')
  const reasons = Array.from(result.refused).map(r => r.reason).sort()
  assert.deepStrictEqual(reasons, ['drive', 'home', 'slskd', 'system'])
  for (const r of Array.from(result.refused)) {
    assert.match(r.error, /Pick (a music folder instead|the folder your music is actually in)\./,
      'every refusal says what to do instead')
  }
})

test('a folder he really shares still goes through untouched', async () => {
  const globals = env({ musicFolders: MUSIC.slice(), slskConfig: { downloadDir: DOWNLOADS } })
  const { result } = await runHandler('slsk-share-folders-set', {
    args: { folders: [DOWNLOADS, '/mnt/windows/Music'] },
    globals, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(result.folders), [DOWNLOADS, '/mnt/windows/Music'])
  assert.strictEqual(Array.from(result.refused).length, 0)
})

// ── B2. Symlinks ────────────────────────────────────────────────────────────
// pickRefusal is pure string work, so a link called "myhome" pointing at the
// home directory read as an ordinary music folder. Real links, in a fresh
// temporary directory, taken away again at the end. Nothing under
// ~/.config/papa-audio is touched, and the dotfolder link points at a dotfolder
// this test made itself.

async function withSymlinks(run) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'papa-slsk-symlink-'))
  try {
    fs.mkdirSync(nodePath.join(root, '.ssh'))
    fs.mkdirSync(nodePath.join(root, 'Albums'))
    const links = {
      myhome: os.homedir(),
      keys: nodePath.join(root, '.ssh'),
      root: '/',
      etc: '/etc',
      music: nodePath.join(root, 'Albums'),
    }
    for (const [name, target] of Object.entries(links)) {
      fs.symlinkSync(target, nodePath.join(root, name))
    }
    // Awaited, not returned: the links have to still be on disk while the
    // code under test resolves them.
    return await run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('a symlink is judged by where it actually points', () => {
  return withSymlinks(async root => {
    const opts = { home: os.homedir(), slskdDir: SLSKD_DIR }
    const real = p => fs.realpathSync(p)
    const at = name => nodePath.join(root, name)

    // Without a resolver the module is pure string work and all three pass —
    // which is the defect, stated as a test so the fix cannot be mistaken for
    // decoration.
    assert.strictEqual(slskShare.pickRefusal(at('myhome'), opts), null)
    assert.strictEqual(slskShare.pickRefusal(at('root'), opts), null)

    assert.strictEqual(slskShare.pickRefusal(at('myhome'), opts, real).reason, 'home')
    assert.strictEqual(slskShare.pickRefusal(at('keys'), opts, real).reason, 'personal')
    assert.strictEqual(slskShare.pickRefusal(at('root'), opts, real).reason, 'drive')
    assert.strictEqual(slskShare.pickRefusal(at('etc'), opts, real).reason, 'system')
    assert.strictEqual(slskShare.pickRefusal(at('music'), opts, real), null,
      'a link to an ordinary folder of music is still an ordinary folder of music')
  })
})

test('a symlink cannot get itself onto the share list', () => {
  return withSymlinks(async root => {
    const globals = env({ musicFolders: [], slskConfig: { downloadDir: DOWNLOADS } }, {
      // The real filesystem this time: this is the whole point of the test.
      fs: {
        existsSync: p => fs.existsSync(p),
        statSync: p => fs.statSync(p),
        realpathSync: p => fs.realpathSync(p),
      },
      app: { getPath: () => os.homedir() },
    })
    const { result } = await runHandler('slsk-share-folders-set', {
      args: { folders: [nodePath.join(root, 'myhome'), nodePath.join(root, 'music')] },
      globals, alsoLift: SHARE_HELPERS,
    })
    assert.deepStrictEqual(Array.from(result.folders), [nodePath.join(root, 'music')])
    assert.strictEqual(Array.from(result.refused)[0].reason, 'home')
  })
})

test('a folder that is not there is judged on its name and nothing blows up', () => {
  const real = p => fs.realpathSync(p)
  const gone = nodePath.join(os.tmpdir(), 'papa-no-such-folder-' + Date.now())
  assert.strictEqual(slskShare.pickRefusal(gone, { home: HOME }, real), null)
  assert.strictEqual(slskShare.pickRefusal('/etc/nope', { home: HOME }, real).reason, 'system')
})

// ── B3. The list of folders that are never music ────────────────────────────

test('the system folders are refused, whole and inside', () => {
  const opts = { home: HOME }
  for (const p of ['/root', '/etc', '/var', '/usr', '/boot', '/proc', '/sys', '/dev']) {
    assert.strictEqual(slskShare.pickRefusal(p, opts).reason, 'system', p)
    assert.strictEqual(slskShare.pickRefusal(p + '/anything', opts).reason, 'system',
      p + '/anything')
  }
  for (const p of ['/opt', '/srv', '/tmp']) {
    assert.strictEqual(slskShare.pickRefusal(p, opts).reason, 'system', p)
  }
  // Only the top of these: people really do keep music in /srv/music and on a
  // USB stick under /run/media.
  assert.strictEqual(slskShare.pickRefusal('/srv/music', opts), null)
  assert.strictEqual(slskShare.pickRefusal('/run/media/shaharyar/USB', opts), null)
  assert.strictEqual(slskShare.pickRefusal('/media/shaharyar/USB', opts), null)
})

test('somebody else\'s home folder is refused and his own is not', () => {
  const opts = { home: HOME }
  const other = slskShare.pickRefusal('/home/someone-else', opts)
  assert.strictEqual(other.reason, 'otherhome')
  assert.match(other.error, /somebody else's home folder/)
  assert.strictEqual(slskShare.pickRefusal(HOME, opts).reason, 'home',
    'his own whole home is still refused, in its own words')
  assert.strictEqual(slskShare.pickRefusal(HOME + '/Music', opts), null,
    'and a folder inside his home is fine')
})

// ── B4. Adding a music folder runs the same judgement ───────────────────────
// Every music folder becomes a tickable row in the share list, so an unguarded
// add is a second route to making / shareable.

test('the folder chooser will not take a whole drive as a music folder', async () => {
  const globals = env({ musicFolders: MUSIC.slice() }, {
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/'] }),
      showMessageBox: (_w, opts) => { globals._boxes.push(opts) },
    },
  })
  const { result } = await runHandler('add-music-folder', {
    args: {}, globals, alsoLift: SHARE_HELPERS,
  })
  assert.strictEqual(result, null, 'answered like a change of mind, so nothing scans')
  assert.deepStrictEqual(Array.from(globals._data.musicFolders), MUSIC,
    'the library is untouched')
  assert.strictEqual(globals._boxes.length, 1, 'and he is told why')
  assert.match(globals._boxes[0].message, /whole drive, not a music folder/)
  assert.doesNotMatch(globals._boxes[0].message, /Soulseek/,
    'adding a music folder is not sharing it, so the sentence must not say it is')
})

test('a folder dropped onto the window gets the same judgement', async () => {
  const globals = env({ musicFolders: MUSIC.slice() })
  const { result } = await runHandler('add-music-folder-path', {
    args: HOME + '/.ssh', globals, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(result), MUSIC)
  assert.deepStrictEqual(Array.from(globals._data.musicFolders), MUSIC)
  assert.strictEqual(globals._boxes.length, 1)
  assert.match(globals._boxes[0].message, /personal folder, not a music folder/)
})

test('an ordinary music folder is still added, by both routes', async () => {
  const picked = env({ musicFolders: [] }, {
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/mnt/data/MUSIC'] }),
      showMessageBox: () => assert.fail('nothing to refuse here'),
    },
  })
  const a = await runHandler('add-music-folder', { args: {}, globals: picked, alsoLift: SHARE_HELPERS })
  assert.deepStrictEqual(Array.from(a.result), ['/mnt/data/MUSIC'])

  const dropped = env({ musicFolders: [] })
  const b = await runHandler('add-music-folder-path', {
    args: '/mnt/windows/Music', globals: dropped, alsoLift: SHARE_HELPERS,
  })
  assert.deepStrictEqual(Array.from(b.result), ['/mnt/windows/Music'])
  assert.strictEqual(dropped._boxes.length, 0)
})

// ── B5. The upload speed has a ceiling on both sides ────────────────────────

test('a mistyped upload speed is clamped, not written as a cap that is no cap', () => {
  const { fns } = liftFns(['_slskUploadLimit', '_slskNumberOrNull'],
    { store: { get: (_k, d) => d, set() {} } },
    ['SLSK_UPLOAD_SLOTS_MIN', 'SLSK_UPLOAD_SLOTS_MAX', 'SLSK_UPLOAD_SLOTS_DEFAULT',
      'SLSK_UPLOAD_MBPS_MAX'])
  assert.strictEqual(fns._slskUploadLimit({ mbps: 100000 }).mbps, 100)
  assert.strictEqual(fns._slskUploadLimit({ mbps: 1e12 }).mbps, 100)
  assert.strictEqual(fns._slskUploadLimit({ mbps: 2.5 }).mbps, 2.5, 'a real number is kept')
  assert.strictEqual(fns._slskUploadLimit({ mbps: 0 }).mbps, 0, 'and empty still means no cap')
})

test('the box in Settings carries the same ceiling main enforces', () => {
  const ceiling = Number(/const SLSK_UPLOAD_MBPS_MAX = (\d+)/.exec(MAIN)[1])
  assert.strictEqual(ceiling, 100)
  const input = /<input[^>]*id="slsk-upload-mbps"[^>]*>/.exec(HTML)[0]
  assert.match(input, new RegExp('max="' + ceiling + '"'),
    'a box with no ceiling invites a number main will silently change')
  const slots = /<input[^>]*id="slsk-upload-slots"[^>]*>/.exec(HTML)[0]
  assert.match(slots, /max="20"/)
  assert.match(HTML, /At most 20 people and 100 MB\/s/,
    'and the hint says what the ceilings are, in his words')
})

// ── C1. "Off" is not an outage ──────────────────────────────────────────────

function paintStatus(status) {
  const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  const fn = (name) => {
    const at = CODE.indexOf('function ' + name + '(')
    assert.ok(at !== -1, name + ' must exist')
    const next = CODE.indexOf('\nfunction ', at + 1)
    return CODE.slice(at, next === -1 ? undefined : next)
  }
  const label = { textContent: '' }
  const dot = { style: { cssText: '' } }
  const el = { style: { color: '' }, childNodes: [label], querySelector: () => dot }
  const ctx = {
    slsk: { status: {}, lastQuery: '', searching: false, searched: true },
    state: { connectionStatus: { slskd: 'disconnected' } },
    document: { getElementById: (id) => (id === 'conn-slskd' ? el : null) },
    runSlskSearch() {},
  }
  vm.createContext(ctx)
  vm.runInContext(fn('_setSlskStatus') + '\n' + fn('_paintSlskConnDot') + '\n' +
    fn('_onSlskConnected'), ctx)
  ctx.__status = status
  vm.runInContext('_setSlskStatus(__status)', ctx)
  return { name: ctx.state.connectionStatus.slskd, label: label.textContent, dot: dot.style.cssText }
}

test('a Soulseek he switched off says so, and is not painted as a fault', () => {
  const off = paintStatus({ installed: true, running: true, connected: false, enabled: false })
  assert.strictEqual(off.name, 'off')
  assert.strictEqual(off.label, ' Soulseek off')
  assert.ok(!off.dot.includes('#e74c3c'), 'red is for something being wrong')

  // The push says it the other way round; both mean he did this on purpose.
  const pushed = paintStatus({ connected: false, off: true })
  assert.strictEqual(pushed.name, 'off')
  assert.strictEqual(pushed.label, ' Soulseek off')
})

test('a daemon that has actually fallen over is still painted as trouble', () => {
  const down = paintStatus({ installed: true, running: false, connected: false, enabled: true })
  assert.strictEqual(down.name, 'disconnected')
  assert.strictEqual(down.label, ' Soulseek offline')
  assert.ok(down.dot.includes('#e74c3c'))

  const starting = paintStatus({ installed: true, running: true, connected: false, enabled: true, starting: true })
  assert.strictEqual(starting.name, 'starting')
  assert.strictEqual(starting.label, ' Soulseek starting…')

  const up = paintStatus({ installed: true, running: true, connected: true, enabled: true })
  assert.strictEqual(up.name, 'connected')
  assert.strictEqual(up.label, ' Soulseek')
})

// ── C2. The download scheduler does not dispatch while Soulseek is off ──────
// Five handlers call dlTick() directly, bypassing dlStart()'s gate. The gate is
// on the tick itself, so all five are covered by one.

function runTick(enabled) {
  let reached = false
  const { fns } = liftFns(['dlTick'], {
    _slskEnabled: () => enabled,
    dlTicking: false,
    _dlTickStartedAt: 0,
    DL_TICK_DEADLINE_MS: 120000,
    dlConfig: () => { reached = true; throw new Error('stop here') },
    console: { log() {}, warn() {}, error() {} },
  })
  return fns.dlTick().then(() => reached, () => reached)
}

test('the download tick dispatches nothing while Soulseek is off', async () => {
  assert.strictEqual(await runTick(false), false,
    'it returns before it reads its own config, let alone talks to the daemon')
  assert.strictEqual(await runTick(true), true,
    'and with Soulseek on the same tick does its work')
})

test('a button that kicks the scheduler cannot dispatch while it is off', async () => {
  // slsk-unbench-peers is one of the five that call dlTick() by hand. With the
  // real dlTick lifted alongside it, this runs the whole path.
  const { calls } = await runHandler('slsk-unbench-peers', {
    args: {},
    globals: {
      _slskEnabled: () => false,
      dlState: { peerFailures: { bob: 5 } },
      dlSched: { peerBenched: () => true },
      dlTicking: false,
      _dlTickStartedAt: 0,
      DL_TICK_DEADLINE_MS: 120000,
      console: { log() {}, warn() {}, error() {} },
    },
    alsoLift: ['dlTick'],
  })
  assert.ok(!calls.some(c => String(c).startsWith('dlSnapshot')),
    'nothing is asked of the daemon he switched off')
})

// ── C3 / C4. The two handlers that POST a transfer ──────────────────────────

test('asking for a download while Soulseek is off gets a sentence, not a failure', async () => {
  const { result, calls } = await runHandler('slsk-download', {
    args: { username: 'bob', filename: 'a.flac', size: 1 },
    globals: { _slskEnabled: () => false },
    alsoLift: ['_SLSK_OFF_DOWNLOAD'],
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.off, true)
  assert.match(result.error, /^Soulseek is off\./)
  assert.ok(!calls.some(c => String(c).startsWith('slskdFetch')),
    'and nothing is sent to the daemon')
})

test('checking a rip while Soulseek is off says so in the shape the dossier reads', async () => {
  const { result, calls } = await runHandler('slsk-verify-rip', {
    args: { username: 'bob', folderPath: '/x', files: [{ filename: 'a.flac', size: 1 }] },
    globals: { _slskEnabled: () => false },
    alsoLift: ['_SLSK_OFF_REASON'],
  })
  assert.strictEqual(result.ok, false)
  // This handler's contract is {ok, reason}; `error` is not read on this path.
  assert.match(result.reason, /^Soulseek is off\./)
  assert.ok(!calls.some(c => String(c).startsWith('slskdFetch')))
})
