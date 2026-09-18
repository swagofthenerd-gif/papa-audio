'use strict'
// slskd answering 401 is not the daemon being down. It is up, it is replying,
// and it will not let us in — a wrong username or password.
//
// slsk-get-transfers threw on it. That handler is polled every couple of
// seconds, so one wrong password produced an endless run of
//
//   Error occurred in handler for 'slsk-get-transfers': slskd 401 on GET …
//
// and, on the page, "Can't reach the Soulseek daemon" — which sends someone to
// restart a daemon that is running perfectly well.
//
// The handler now answers the refusal instead of throwing, and the renderer
// says the true thing once. Other failures still throw, because a rejection is
// exactly how the renderer detects a daemon that really is unreachable.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { runHandler } = require('./helpers/lift-ipc')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function err (status) {
  const e = new Error('slskd ' + status + ' on GET /transfers/downloads')
  e.status = status
  return e
}

// ── main: the handler ───────────────────────────────────────────────────────

test('a 401 is answered, not thrown', async () => {
  const r = await runHandler('slsk-get-transfers', {
    globals: { slskdFetch: () => Promise.reject(err(401)) },
  })
  assert.ok(!r.error, 'the poll must not reject on a 401: ' + r.error)
  // Property by property: the handler runs in its own vm realm, so an object
  // literal from inside it is not deepStrictEqual to one built out here.
  assert.strictEqual(r.result.ok, false)
  assert.strictEqual(r.result.unauthorized, true)
  assert.match(r.result.error, /rejected the credentials/)
})

test('a daemon that is genuinely unreachable still rejects', async () => {
  // The renderer detects this by the promise rejecting; swallowing it is the
  // older bug this handler already carries a comment about.
  for (const boom of [Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), err(500)]) {
    const r = await runHandler('slsk-get-transfers', {
      globals: { slskdFetch: () => Promise.reject(boom) },
    })
    assert.ok(r.error, boom.message + ' must still surface as a rejection')
  }
})

test('a working poll still answers the slimmed list', async () => {
  const r = await runHandler('slsk-get-transfers', {
    globals: {
      slskdFetch: () => Promise.resolve([
        { username: 'someone', extra: 'dropped', directories: [{ directory: 'd', files: [{ id: 1 }] }] },
      ]),
      slimTransfer: (f) => ({ id: f.id }),
      dlBackfillPositions: () => Promise.resolve(),
      warnIfLarge: () => {},
    },
  })
  assert.ok(!r.error, String(r.error))
  assert.ok(Array.isArray(r.result), 'success is still a plain list')
  assert.strictEqual(r.result[0].username, 'someone')
  assert.strictEqual(r.result[0].extra, undefined, 'and still slimmed')
})

// ── renderer: what the page does with it ────────────────────────────────────

function liftFn (name) {
  const start = RENDERER.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' must still exist')
  let i = RENDERER.indexOf('{', RENDERER.indexOf('(', start))
  let depth = 0
  for (let j = i; j < RENDERER.length; j++) {
    if (RENDERER[j] === '{') depth++
    else if (RENDERER[j] === '}') { depth--; if (!depth) return RENDERER.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

// `known` is what the page already fetched — the rows a refusal must not wipe.
// The list starts on the page shell's "Loading…" placeholder, exactly as
// renderDownloads paints it.
function bannerPage (known) {
  const made = []
  const byId = {}
  const parent = { insertBefore (el) { byId[el.id] = el; made.push(el) } }
  const node = function (id) {
    return {
      id, className: '', textContent: '', innerHTML: '', dataset: {}, children: [],
      parentNode: parent,
      appendChild (c) { this.children.push(c); return c },
      addEventListener () {},
    }
  }
  byId['dl2-list'] = node('dl2-list')
  byId['dl2-list'].innerHTML = '<div class="dl2-empty"><p>Loading…</p></div>'
  const warnings = []
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => byId[id] || null,
      createElement: () => node(''),
    },
    console: { warn: (...a) => warnings.push(a.join(' ')) },
    _pollAndRenderDownloads () {},
  })
  vm.runInContext(
    'var _dlAuthWarned = false\nvar _dlLastFiles = ' + JSON.stringify(known || []) + '\n' +
      liftFn('_dlRenderUnauthorized') + '\n' + liftFn('_dlRenderDaemonDown'),
    ctx)
  return {
    ctx,
    warnings,
    banner: () => byId['dl2-daemon-banner'] || null,
    listHtml: () => byId['dl2-list'].innerHTML,
    madeCount: () => made.length,
    refuse: () => vm.runInContext('_dlRenderUnauthorized()', ctx),
    unreachable: () => vm.runInContext('_dlRenderDaemonDown()', ctx),
  }
}

test('the page blames the credentials, not the daemon', () => {
  const p = bannerPage()
  p.refuse()
  assert.match(p.banner().textContent, /refused these credentials/)
  assert.doesNotMatch(p.banner().textContent, /Can.t reach/,
    'slskd answered — telling someone to restart it is the wrong instruction')
})

test('and says it once, not once per poll', () => {
  const p = bannerPage()
  for (let i = 0; i < 30; i++) p.refuse()     // a minute of polling
  assert.strictEqual(p.madeCount(), 1, 'one banner, repainted, never stacked')
  assert.strictEqual(p.warnings.length, 1,
    'the console said it ' + p.warnings.length + ' times')
})

// ── M2: the banner was not the whole page ───────────────────────────────────
// _pollAndRenderDownloadsInner returns straight after _dlRenderUnauthorized(),
// so _renderDlTab never ran and #dl2-list kept the page shell's "Loading…"
// forever — a refusal banner sitting above a list that claimed to be busy.

test('the list stops claiming to be loading when the daemon will not let us in', () => {
  const p = bannerPage([])
  p.refuse()
  assert.doesNotMatch(p.listHtml(), /Loading/,
    'the list was still saying "Loading…" underneath the refusal banner')
  assert.match(p.listHtml(), /Nothing to show until the daemon lets us in\./)
})

test('and it stays that way across a minute of polling', () => {
  const p = bannerPage([])
  for (let i = 0; i < 30; i++) p.refuse()
  assert.match(p.listHtml(), /Nothing to show until the daemon lets us in\./)
})

test('but rows already fetched are not wiped by a later refusal', () => {
  // Same rule _dlRenderDaemonDown follows: a refusal mid-session must not cost
  // the user the state they were reading.
  const p = bannerPage([{ filename: 'Radiohead - Karma Police.flac' }])
  p.ctx.document.getElementById('dl2-list').innerHTML = '<div class="dl2-row">Karma Police</div>'
  p.refuse()
  assert.match(p.listHtml(), /Karma Police/)
})

test('MUTATION: without the list repaint the "Loading…" placeholder comes back', () => {
  const broken = RENDERER.replace(/\n  if \(!_dlLastFiles\.length\) \{\n    list\.innerHTML = [\s\S]*?\n  \}\n\}/,
    '\n}')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const made = []
  const byId = {}
  const parent = { insertBefore (el) { byId[el.id] = el; made.push(el) } }
  const node = (id) => ({ id, className: '', textContent: '', innerHTML: '', dataset: {}, children: [],
    parentNode: parent, appendChild (c) { this.children.push(c); return c }, addEventListener () {} })
  byId['dl2-list'] = node('dl2-list')
  byId['dl2-list'].innerHTML = '<div class="dl2-empty"><p>Loading…</p></div>'
  const ctx = vm.createContext({
    document: { getElementById: id => byId[id] || null, createElement: () => node('') },
    console: { warn () {} }, _pollAndRenderDownloads () {},
  })
  const start = broken.indexOf('function _dlRenderUnauthorized(')
  let depth = 0, end = broken.indexOf('{', start)
  for (let j = end; j < broken.length; j++) {
    if (broken[j] === '{') depth++
    else if (broken[j] === '}') { depth--; if (!depth) { end = j + 1; break } }
  }
  vm.runInContext('var _dlAuthWarned = false\nvar _dlLastFiles = []\n' + broken.slice(start, end), ctx)
  vm.runInContext('_dlRenderUnauthorized()', ctx)
  assert.match(byId['dl2-list'].innerHTML, /Loading/, 'this is the reported bug')
})

test('a real outage after a refusal still reads as an outage', () => {
  const p = bannerPage()
  p.refuse()
  p.unreachable()
  assert.match(p.banner().textContent, /Can.t reach the Soulseek daemon/)
  assert.strictEqual(p.banner().dataset.reason, undefined,
    'the banner must not still be marked as a credentials problem')
})

test('the poll reads a refusal as a refusal, not as an outage', () => {
  const poll = RENDERER.slice(RENDERER.indexOf('async function _pollAndRenderDownloadsInner'))
    .slice(0, 1200)
  assert.match(poll, /raw && raw\.unauthorized/,
    'the poll must recognise the refusal shape')
  assert.match(poll, /_dlRenderUnauthorized\(\)/)
  assert.match(poll, /_dlDaemonDown = false/,
    'a daemon that answered is not down')
})

test('the incidental readers treat a refusal as an empty list, not a crash', () => {
  const ctx = vm.createContext({ Array, JSON })
  vm.runInContext(liftFn('_slskTransfers'), ctx)
  const run = (v) => { ctx.__r = v; return vm.runInContext('JSON.stringify(_slskTransfers(__r))', ctx) }
  assert.strictEqual(run({ ok: false, unauthorized: true }), '[]',
    'a for...of over the refusal object would throw')
  assert.strictEqual(run([{ username: 'someone' }]), '[{"username":"someone"}]',
    'and a real list is passed straight through')
  assert.strictEqual(run(null), '[]')
  assert.strictEqual(run(undefined), '[]')
})

test('every reader of the transfer list goes through it', () => {
  const calls = RENDERER.match(/window\.api\.slskGetTransfers\(\)/g) || []
  assert.ok(calls.length >= 4, 'sanity: the list is read from several places')
  // Every read either normalises, or is the poll that handles the shape itself.
  const lines = RENDERER.split('\n').filter(l => /slskGetTransfers\(\)/.test(l))
  for (const l of lines) {
    const ok = /_slskTransfers\(/.test(l) || /_dlReachable = false/.test(l) ||
      /window\.api\.slskGetTransfers\b(?!\()/.test(l)
    assert.ok(ok, 'unnormalised read of the transfer list: ' + l.trim())
  }
})
