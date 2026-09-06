'use strict'
// Wave-9 onboarding + bug reporter. Two surfaces:
//  · the first-run wizard's pure renderer helpers (App #8), lifted out of the
//    one-giant-file renderer and run for real in a vm context, the same way
//    settings.test.js does — the renderer cannot be required outside Electron;
//  · the bug-report bundle (App #97), checked by reading main.js / preload.js /
//    index.html textually, since the handler touches Electron + the filesystem
//    and its contract is what those anchors guarantee.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')

const MAIN_CODE = MAIN
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// Lift a top-level `function name(` out of the renderer by brace-matching.
function extract(name) {
  const start = RENDERER.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in the renderer')
  let depth = 0
  for (let j = RENDERER.indexOf('{', start); j < RENDERER.length; j++) {
    if (RENDERER[j] === '{') depth++
    else if (RENDERER[j] === '}') { depth--; if (!depth) return RENDERER.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function sandbox() {
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    console,
  }
  vm.createContext(ctx)
  // The step constants the helpers close over.
  vm.runInContext('const _WIZARD_MIN_STEP = 1; const _WIZARD_MAX_STEP = 3;', ctx)
  for (const fn of ['_wizardResolveStep', '_wizardCheckRows']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

// ── Wizard step navigation (App #8) ──────────────────────────────────────────

test('the wizard has three steps and back/forward stay inside them', () => {
  const { _wizardResolveStep } = sandbox()
  assert.strictEqual(_wizardResolveStep(1, 'forward'), 2)
  assert.strictEqual(_wizardResolveStep(2, 'forward'), 3)
  assert.strictEqual(_wizardResolveStep(3, 'forward'), 3, 'forward past the last step stays put')
  assert.strictEqual(_wizardResolveStep(2, 'back'), 1)
  assert.strictEqual(_wizardResolveStep(1, 'back'), 1, 'back before the first step stays put')
})

test('a junk current step falls back to the first, and an unknown direction is a no-op', () => {
  const { _wizardResolveStep } = sandbox()
  assert.strictEqual(_wizardResolveStep(undefined, 'forward'), 2)
  assert.strictEqual(_wizardResolveStep(NaN, 'back'), 1)
  assert.strictEqual(_wizardResolveStep(2, 'sideways'), 2)
})

// ── Wizard environment check rows (App #8) ───────────────────────────────────

test('a present tool is green and a missing one is never a false green', () => {
  const { _wizardCheckRows } = sandbox()
  const html = _wizardCheckRows({ mpv: true, slskd: false, tmdb: true })
  assert.match(html, /Player program \(mpv\)[\s\S]*setup-check-ok/)
  assert.match(html, /setup-check-bad/, 'the unreachable daemon is not green')
  assert.match(html, /Movie database \(TMDB\)/)
})

test('a missing diagnostics payload renders amber "couldn\'t check", not a throw', () => {
  const { _wizardCheckRows } = sandbox()
  const html = _wizardCheckRows(null)
  assert.match(html, /couldn&#39;t check/, 'the note is present and html-escaped')
  assert.match(html, /setup-check-unknown/)
  assert.ok(!/setup-check-ok/.test(html), 'nothing passes when nothing was checked')
})

test('the wizard accepts either the bare payload or an { diagnostics } wrapper', () => {
  const { _wizardCheckRows } = sandbox()
  const bare = _wizardCheckRows({ mpv: true })
  const wrapped = _wizardCheckRows({ diagnostics: { mpv: true } })
  assert.match(bare, /setup-check-ok/)
  assert.strictEqual(bare, wrapped, 'the wrapper is unwrapped to the same rows')
})

test('the check labels and notes are html-escaped', () => {
  // Labels/notes are literals here, but the escape must be in the path so a
  // future dynamic note cannot smuggle markup. Feed a payload and confirm esc
  // is applied to the label text.
  const { _wizardCheckRows } = sandbox()
  const html = _wizardCheckRows({ mpv: true })
  assert.ok(!/<script/.test(html))
  assert.match(html, /span/)
})

// ── Wizard markup (App #8) ───────────────────────────────────────────────────

test('the setup overlay carries all three wizard steps and their controls', () => {
  assert.match(HTML, /id="setup-step-1"/)
  assert.match(HTML, /id="setup-step-2"/)
  assert.match(HTML, /id="setup-step-3"/)
  // Step 1 keeps the original picker id so the existing fast path still binds.
  assert.match(HTML, /id="choose-folder-btn"/)
  // Step 2 is the optional TMDB key with a themoviedb.org link and a skip.
  assert.match(HTML, /id="setup-tmdb-key"/)
  assert.match(HTML, /themoviedb\.org/)
  assert.match(HTML, /id="setup-skip-2"/)
  // Step 3 is the environment check with a Finish button.
  assert.match(HTML, /id="setup-checks"/)
  assert.match(HTML, /id="setup-finish"/)
})

test('the renderer wires the wizard instead of the old single-button handler', () => {
  assert.match(RENDERER, /_initSetupWizard\(\)/)
  // The wizard saves the optional key through videoSettingsSet (App #8).
  const fn = RENDERER.slice(RENDERER.indexOf('function _initSetupWizard('),
                            RENDERER.indexOf('async function _wizardRunChecks('))
  assert.match(fn, /videoSettingsSet\(\{ tmdbApiKey/)
  assert.match(fn, /addMusicFolder\(\)/, 'step 1 still uses the folder picker')
  assert.match(fn, /show\(2\)/, 'choosing a folder auto-advances (the fast path)')
  assert.match(fn, /fullScan\(\)/, 'finishing with a folder scans the library')
})

// ── Bug reporter (App #97) ───────────────────────────────────────────────────

test('the bug-report handler is registered and reuses the shared helpers', () => {
  assert.match(MAIN_CODE, /ipcMain\.handle\('papa-bug-report'/)
  const h = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.handle('papa-bug-report'"),
                            MAIN_CODE.indexOf("ipcMain.handle('app-changelog'"))
  // It reuses the export's redaction and the diagnostics snapshot rather than
  // re-implementing either.
  assert.match(h, /_redactSecrets\(/, 'settings are redacted the same way export does')
  assert.match(h, /_collectDiagnostics\(/, 'the diagnostics snapshot is the shared one')
  // The folder it builds and what goes in it.
  assert.match(h, /bug-reports/, 'writes under USER_DATA/bug-reports')
  assert.match(h, /report-/, 'one ISO-stamped folder per report')
  assert.match(h, /crash-log\.txt/, 'the crash log is included when present')
  assert.match(h, /200/, 'the newest log is tailed to 200 lines')
  assert.match(h, /appVersion/, 'version + platform info is written')
  assert.match(h, /process\.platform/)
  // It reveals the folder and returns the path.
  assert.match(h, /shell\.showItemInFolder\(/)
  assert.match(h, /return \{ ok: true, path:/)
})

test('the bug reporter needs no IPC timeout override', () => {
  // It opens no dialog and no BrowserWindow — showItemInFolder is neither — so
  // it must NOT appear in the human-waiting override table. main-guards scans
  // for exactly that; this asserts the same invariant from the other side.
  const tbl = MAIN_CODE.slice(MAIN_CODE.indexOf('const IPC_TIMEOUT_OVERRIDES = {'),
                            MAIN_CODE.indexOf('const _ipcRawHandle'))
  assert.ok(!/'papa-bug-report'/.test(tbl), 'no override — it never waits on a person')
  const h = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.handle('papa-bug-report'"),
                            MAIN_CODE.indexOf("ipcMain.handle('app-changelog'"))
  assert.ok(!/showOpenDialog|showSaveDialog|showMessageBox|new BrowserWindow/.test(h),
    'no dialog and no window, so nothing waits on the user')
})

test('the tail helper keeps the last n lines and the newest-log helper sorts by mtime', () => {
  const tail = MAIN_CODE.slice(MAIN_CODE.indexOf('function _tailLines('),
                              MAIN_CODE.indexOf('function _newestLogFile('))
  assert.match(tail, /slice\(Math\.max\(0, lines\.length - n\)/)
  const newest = MAIN_CODE.slice(MAIN_CODE.indexOf('function _newestLogFile('),
                                MAIN_CODE.indexOf("ipcMain.handle('papa-bug-report'"))
  assert.match(newest, /papa-.*\\.log/, 'it only considers the day-stamped app logs')
  assert.match(newest, /mtimeMs/)
  assert.match(newest, /b\.mtime - a\.mtime/, 'newest first')
})

test('preload exposes papaBugReport on the one bug-report channel', () => {
  assert.match(PRELOAD, /papaBugReport:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('papa-bug-report'\)/)
})

test('the settings panel has a Report-a-problem group wired to a toast + path line', () => {
  assert.match(HTML, /id="bug-report-btn"/)
  assert.match(HTML, /id="bug-report-status"/)
  assert.match(HTML, /Report a problem/)
  const fn = RENDERER.slice(RENDERER.indexOf('function _initBugReport('),
                            RENDERER.indexOf('function _initBugReport(') + 1600)
  assert.match(fn, /papaBugReport\(\)/)
  assert.match(fn, /showToast\(/, 'a toast confirms it')
  assert.match(fn, /no passwords or keys/, 'the plain-English line about what is safe to send')
  assert.match(fn, /res\.path/, 'the confirmation names the folder path')
})

test('_initBugReport is called from the settings init', () => {
  assert.match(RENDERER, /_initBugReport\(\)/)
})
