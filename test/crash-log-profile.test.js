'use strict'
// The crash log hardcoded ~/.config/papa-audio, so it ignored PAPA_USER_DATA
// entirely. Every throwaway twin profile's renderer kill therefore appended to
// the REAL profile's crash-log.txt — 69 entries of it — drowning the genuine
// crashes the file exists to record.
//
// This runs the real _appendCrashLog, alongside the real USER_DATA definition
// it is supposed to honour, in a temp profile.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function slice(from, to) {
  const a = MAIN.indexOf(from)
  assert.ok(a > 0, 'not found in main.js: ' + from)
  const b = MAIN.indexOf(to, a)
  assert.ok(b > a, 'not found after it: ' + to)
  return MAIN.slice(a, b)
}

// The real USER_DATA line and the real crash logger, run together.
function runCrashLog({ userDataEnv, home }) {
  const env = userDataEnv ? { PAPA_USER_DATA: userDataEnv } : {}
  const ctx = {
    fs, path,
    process: { env },
    app: { getPath: k => (k === 'home' ? home : home) },
    console: { log() {}, error() {}, warn() {} },
    Date, String, Math, JSON, Error,
    _crashTrail: ['library-scan'],
    CRASH_LOG_MAX_BYTES: 64 * 1024,
  }
  vm.createContext(ctx)
  // USER_DATA first — it is a const declared below the handlers in main.js,
  // but it is read at call time, not install time.
  vm.runInContext(slice('const USER_DATA = process.env.PAPA_USER_DATA',
    '\napp.setPath('), ctx)
  vm.runInContext(slice('function _crashLogDir() {', '\n// Under Node 18+'), ctx)
  return vm.runInContext('_appendCrashLog', ctx)
}

test('a crash in a throwaway profile is logged in that profile', () => {
  const twin = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-twin-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-home-'))
  fs.mkdirSync(path.join(home, '.config', 'papa-audio'), { recursive: true })
  try {
    const append = runCrashLog({ userDataEnv: twin, home })
    append('the window crashed (killed)', new Error('renderer went away'))

    const twinLog = path.join(twin, 'crash-log.txt')
    const realLog = path.join(home, '.config', 'papa-audio', 'crash-log.txt')
    assert.strictEqual(fs.existsSync(twinLog), true,
      'the crash belongs to the profile that crashed')
    assert.match(fs.readFileSync(twinLog, 'utf8'), /renderer went away/)
    assert.strictEqual(fs.existsSync(realLog), false,
      "a twin must never append to the real profile's crash log")
  } finally {
    fs.rmSync(twin, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('without the override it still goes to the normal profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-home-'))
  try {
    const append = runCrashLog({ userDataEnv: null, home })
    append('the app hit an unexpected error', new Error('boom'))
    const realLog = path.join(home, '.config', 'papa-audio', 'crash-log.txt')
    assert.strictEqual(fs.existsSync(realLog), true)
    assert.match(fs.readFileSync(realLog, 'utf8'), /boom/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
