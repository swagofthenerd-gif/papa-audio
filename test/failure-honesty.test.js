'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SideStore } = require('../side-store')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// ── A corrupt store must not be quietly replaced by an empty one ────────────
// The fallback was adopted in memory and the very next write replaced the
// unreadable file with it, so a half-written play-history.json became an empty
// one and two thousand plays were gone with only a console line to show for it.
test('an unreadable store is moved aside instead of being overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-ss-'))
  const original = '[{"a":1},{"b":2},{trunc'
  fs.writeFileSync(path.join(dir, 'playHistory.json'), original)
  const errors = []
  const s = new SideStore({ dir, name: 'playHistory', fallback: [], onError: e => errors.push(e.message) })

  assert.deepStrictEqual(s.get(), [], 'the app still starts, from the fallback')
  s.set([{ c: 3 }])

  const kept = fs.readdirSync(dir).filter(n => n.includes('.corrupt-'))
  assert.strictEqual(kept.length, 1, 'the unreadable file was kept')
  assert.strictEqual(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), original,
    'and kept intact, so what survived in it can still be recovered')
  assert.match(errors[0] || '', /kept at/, 'and the error says where it went')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a store that simply does not exist yet is not treated as corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-ss-'))
  const errors = []
  const s = new SideStore({ dir, name: 'fresh', fallback: [], onError: e => errors.push(e.message) })
  assert.deepStrictEqual(s.get(), [])
  s.set([1])
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.includes('.corrupt-')), [])
  assert.deepStrictEqual(errors, [], 'a first run is not an error')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── The Soulseek token call must be able to time out ────────────────────────
// A daemon that accepts the connection but never answers hung this await
// forever. The 60 s health check awaits it inside a try, so the failure counter
// never advanced and the 3-strikes auto-restart — which exists for exactly that
// fault — never fired. Soulseek stayed dead until the app was restarted.
test('the slskd token request carries a deadline, like every other slskd call', () => {
  const fn = MAIN.slice(MAIN.indexOf('slskdAcquireToken'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /AbortSignal\.timeout\(/,
    'a token call with no deadline can wedge the watchdog that would have healed it')
})

// ── Diagnostics must read the shape main actually sends ─────────────────────
// main reports the core checks as plain booleans and each source as
// { name, healthy }. The renderer read only { ok } on an object, so every core
// row rendered amber "unknown" and every source rendered red — the one screen a
// person opens to find out what is wrong was inventing an outage.
test('diagnostics understands booleans and healthy flags, not just { ok }', () => {
  const fn = R.slice(R.indexOf('function _diagRowsHtml'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.match(body, /typeof check === 'boolean'/, 'a boolean check is a check')
  assert.match(body, /'healthy' in check/, "a source's healthy flag is a check too")
  assert.match(body, /c\.storeBridge/, 'and the key main actually sends for storage')
})

test('the normaliser maps every shape main can send to a definite state', () => {
  // Mirrors the renderer's norm(); asserted here because the renderer is not
  // loadable outside Electron.
  const norm = check => {
    if (typeof check === 'boolean') return { ok: check }
    if (check && typeof check === 'object') {
      return 'ok' in check ? check : ('healthy' in check ? { ok: check.healthy !== false, detail: check.detail } : check)
    }
    return null
  }
  assert.deepStrictEqual(norm(true), { ok: true })
  assert.deepStrictEqual(norm(false), { ok: false })
  assert.strictEqual(norm({ name: 'nyaa', healthy: true }).ok, true)
  assert.strictEqual(norm({ name: 'nyaa', healthy: false }).ok, false)
  assert.strictEqual(norm({ ok: true }).ok, true)
  assert.strictEqual(norm(undefined), null, 'genuinely absent stays unknown')
})
