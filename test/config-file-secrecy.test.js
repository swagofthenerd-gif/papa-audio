'use strict'
// config.json holds the YouTube cookie, the API keys and the debrid token. It
// was measured at mode 666 — world readable — because conf's default
// configFileMode is 0o666 and its every set() rewrites the file through a temp
// file plus rename, so the one-off startup chmod never survived the next
// settings write.
//
// These run the REAL writer (conf, which electron-store extends and passes its
// options straight through to) with the options main.js actually constructs
// its store with, and the real sweep function lifted out of main.js.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// The options object main.js hands to `new Store(...)`, as source text.
function storeOptionsSource() {
  const at = MAIN.indexOf('const store = new Store(')
  assert.ok(at > 0, 'main.js must construct its store')
  const open = MAIN.indexOf('(', at)
  const end = MAIN.indexOf(')', open)
  const inner = MAIN.slice(open + 1, end).trim()
  return inner === '' ? '{}' : inner
}

test('the store is constructed with a private file mode', () => {
  const opts = vm.runInNewContext('(' + storeOptionsSource() + ')')
  assert.strictEqual(opts.configFileMode, 0o600,
    'config.json carries the debrid token and the API keys; it must not be world readable')
})

// The behavioural half: the options main.js uses, applied to the real writer,
// across the rewrite that used to undo the chmod.
test('a settings write leaves config.json readable only by its owner', () => {
  const Conf = require('conf')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-conf-'))
  try {
    const opts = vm.runInNewContext('(' + storeOptionsSource() + ')')
    const conf = new Conf(Object.assign({}, opts, { cwd, configName: 'config' }))
    conf.set('debridToken', 'not-a-real-token')
    conf.set('ytCookie', 'not-a-real-cookie')
    const mode = fs.statSync(conf.path).mode & 0o777
    assert.strictEqual(mode.toString(8), '600',
      'after a set() the config must still be owner-only, not ' + mode.toString(8))
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

// ── The orphaned temp files ────────────────────────────────────────────────
// atomically writes config.json.tmp-<10 digits><6 hex> beside the real file and
// renames it in. A kill between the two leaves a full copy of the config —
// secrets included — behind for good. This profile had 15 of them.
function liftSweep() {
  const start = MAIN.indexOf('const CONFIG_TMP_RE')
  assert.ok(start > 0, 'main.js must define the config temp sweep')
  const end = MAIN.indexOf('\nfunction sweepOrphanConfigTmp', start)
  const bodyEnd = MAIN.indexOf('\n}\n', end)
  assert.ok(bodyEnd > end, 'the sweep has no closing brace')
  const src = MAIN.slice(start, bodyEnd + 2)
  const ctx = { fs, path, Date, Math, Number }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return vm.runInContext('sweepOrphanConfigTmp', ctx)
}

test('the sweep removes only old config temp files', () => {
  const sweep = liftSweep()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-userdata-'))
  try {
    const old = path.join(dir, 'config.json.tmp-1758300000abcdef')
    const fresh = path.join(dir, 'config.json.tmp-1758399999fedcba')
    const real = path.join(dir, 'config.json')
    const other = path.join(dir, 'dead-magnets.json')
    const lookalike = path.join(dir, 'config.json.tmp-backup')
    const subdir = path.join(dir, 'config.json.tmp-1758300001aaaaaa')
    for (const f of [old, fresh, real, other, lookalike]) fs.writeFileSync(f, 'x'.repeat(2048))
    fs.mkdirSync(subdir)

    const hourAgo = Date.now() - 2 * 60 * 60 * 1000
    fs.utimesSync(old, hourAgo / 1000, hourAgo / 1000)
    fs.utimesSync(subdir, hourAgo / 1000, hourAgo / 1000)

    const out = sweep(dir)

    assert.strictEqual(fs.existsSync(old), false, 'the stale temp copy goes')
    assert.strictEqual(out.removed, 1, 'exactly one file swept')
    assert.ok(out.bytes >= 2048, 'the reclaimed size is reported')
    assert.strictEqual(fs.existsSync(fresh), true,
      'a temp file young enough for a live write to own is left alone')
    assert.strictEqual(fs.existsSync(real), true, 'the real config is never touched')
    assert.strictEqual(fs.existsSync(other), true, 'nothing else in the profile is touched')
    assert.strictEqual(fs.existsSync(lookalike), true,
      'only the exact temp name shape is ours to delete')
    assert.strictEqual(fs.existsSync(subdir), true, 'a directory is never unlinked')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the sweep on a directory that is not there is harmless', () => {
  const sweep = liftSweep()
  const out = sweep(path.join(os.tmpdir(), 'papa-nope-' + process.pid))
  assert.strictEqual(out.removed, 0)
  assert.strictEqual(out.bytes, 0)
})

test('startup runs the config temp sweep', () => {
  assert.match(MAIN, /sweepOrphanConfigTmp\(userDir\)/,
    'the sweep must actually be called at startup, against the real profile directory')
})
