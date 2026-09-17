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
// The renderer is a browser script with no exports, so _diagRowsHtml is lifted
// out of its real source and run against the real esc(). The previous version
// of this file kept a private copy of the normaliser and asserted on THAT, so
// both polarity mutations to the shipped renderer stayed green — the test could
// not see the screen it was named after. Every assertion below reads rendered
// HTML produced by the shipped bytes.
function liftDiag() {
  let code = ''
  for (const n of ['esc', '_diagRowsHtml']) {
    const start = R.indexOf('function ' + n + '(')
    assert.ok(start > -1, n + ' must still exist in renderer.js')
    const end = R.indexOf('\nfunction ', start + 1)
    code += R.slice(start, end === -1 ? undefined : end) + '\n'
  }
  return new Function(code + 'return _diagRowsHtml')()
}
const _diagRowsHtml = liftDiag()

// The dot class is the whole point of the screen: ok / bad / unknown, in order.
function dots(html) {
  return [...String(html).matchAll(/mcs-diag-dot mcs-diag-(\w+)/g)].map(m => m[1])
}

test('a plain boolean check is a check, not an unknown', () => {
  // main sends the four core checks as bare booleans. Reading only { ok } on an
  // object rendered every one of them amber, so the one screen a person opens
  // to find out what is wrong claimed nothing had been checked.
  const html = _diagRowsHtml({ checks: { slskd: true, tmdb: false, mpv: true, storeBridge: true } })
  assert.deepStrictEqual(dots(html), ['ok', 'bad', 'ok', 'ok'])
})

test("a source's healthy flag is a check too", () => {
  const html = _diagRowsHtml({
    checks: { slskd: true, tmdb: true, mpv: true, storeBridge: true },
    sources: [{ name: 'nyaa', healthy: true }, { name: 'yts', healthy: false }],
  })
  assert.deepStrictEqual(dots(html).slice(4), ['ok', 'bad'],
    'a healthy source must not render as an outage')
  assert.match(html, /nyaa/)
  assert.match(html, /yts/)
})

test('storage is read under the key main actually sends', () => {
  const [, , , storage] = dots(_diagRowsHtml({ checks: { storeBridge: true } }))
  assert.strictEqual(storage, 'ok', 'storeBridge is where main puts it')
  const [, , , newer] = dots(_diagRowsHtml({ checks: { storage: false, storeBridge: true } }))
  assert.strictEqual(newer, 'bad', 'and an explicit storage key wins when present')
})

test('an { ok } check is still honoured, and a detail is shown with it', () => {
  const html = _diagRowsHtml({ checks: { slskd: { ok: false, detail: 'connection refused' } } })
  assert.strictEqual(dots(html)[0], 'bad')
  assert.match(html, /connection refused/)
})

test('a check that was never reported stays unknown — never a false green', () => {
  assert.deepStrictEqual(dots(_diagRowsHtml({ checks: {} })), ['unknown', 'unknown', 'unknown', 'unknown'])
  assert.deepStrictEqual(dots(_diagRowsHtml({ checks: { slskd: 'yes' } }))[0], 'unknown',
    'a string is not a verdict')
})

test('a malformed payload is one honest line, not a throw', () => {
  assert.match(_diagRowsHtml(null), /not available/)
  assert.match(_diagRowsHtml('broken'), /not available/)
  assert.deepStrictEqual(dots(_diagRowsHtml(null)), [], 'and invents no rows')
})

test('a source name is escaped, so a payload cannot inject markup', () => {
  const html = _diagRowsHtml({ checks: {}, sources: [{ name: '<img src=x>', healthy: true }] })
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})
