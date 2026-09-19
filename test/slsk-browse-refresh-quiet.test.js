'use strict'
// A background browse refresh used to pull the whole library over IPC again
// (a second slskd fetch, a 100 MB structure-clone) and re-parse 5,000 albums
// in the renderer — a 1.3 s freeze mid-scroll on every open, measured. Main now
// hashes the fresh payload and sends the hash; an unchanged library costs the
// shop one text node.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')

function liftRefresh() {
  const start = MAIN.indexOf('function _browseRefresh(')
  const src = MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 3)
  const sent = []
  const sb = {
    _browseRefreshing: new Set(), setImmediate,
    _browseFetch: async () => [{ name: 'A\\B', files: [{ filename: 'A\\B\\01.flac', size: 1 }] }],
    _browseCacheWrite: () => {},
    slskShelves: { fingerprintBrowseChunked: async (dirs) => 'fp-' + dirs.length },
    safeSend: (ch, p) => sent.push({ ch, p }),
  }
  require('vm').runInNewContext(src + '\nthis.run = _browseRefresh', sb)
  return { run: sb.run, sent }
}

test('the refresh event carries the fresh payload hash', async () => {
  const h = liftRefresh()
  h.run('peer')
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(h.sent, [{ ch: 'slsk-browse-refreshed', p: { username: 'peer', fingerprint: 'fp-1' } }])   // vm realm
})

function liftHandler() {
  const at = SHOP.indexOf('_offBrowseRefreshed = window.api.onSlskBrowseRefreshed(async (evt) => {')
  assert.ok(at > -1)
  const start = SHOP.indexOf('async (evt) => {', at)
  // balance braces from the arrow body
  let depth = 0, i = SHOP.indexOf('{', start)
  for (; i < SHOP.length; i++) { if (SHOP[i] === '{') depth++; else if (SHOP[i] === '}') { depth--; if (!depth) break } }
  return SHOP.slice(start, i + 1)
}

async function drive({ fp, evtFp }) {
  const calls = { browse: 0, hero: null }
  const hero = { classList: { remove () {} }, set textContent (v) { calls.hero = v } }
  const fn = new Function('window', 'dlg', 'username', 'shBody', 'shBrowseFp', 'shScrolling', '_shAgo', 'SH', 'T', 'setTimeout', `
    let shFromCache = false, shCachedAt = 0, shJustRefreshed = false, tree = null
    const buildFromTree = async () => { calls_build++ }
    let calls_build = 0
    const h = ${liftHandler()}
    return h(EVT).then(() => ({ build: calls_build }))
  `.replace('EVT', JSON.stringify({ username: 'peer', fingerprint: evtFp })))
  const window = { api: { slskBrowseUser: async () => { calls.browse++; return { ok: false } } }, requestIdleCallback: cb => cb() }
  const r = await fn(window, { isConnected: true }, 'peer', { querySelector: () => hero }, fp, false, () => 'just now', null, null, setTimeout)
  return { ...calls, ...r }
}

test('same hash: no IPC pull, no rebuild, only the provenance line changes', async () => {
  const r = await drive({ fp: 'fp-1', evtFp: 'fp-1' })
  assert.strictEqual(r.browse, 0)
  assert.strictEqual(r.build, 0)
  assert.match(String(r.hero), /updated just now/)
})

test('a different hash still pulls (from the cache the refresh just wrote — no noCache)', async () => {
  const r = await drive({ fp: 'fp-1', evtFp: 'fp-2' })
  assert.strictEqual(r.browse, 1)
  assert.doesNotMatch(liftHandler(), /noCache: true/)
})
