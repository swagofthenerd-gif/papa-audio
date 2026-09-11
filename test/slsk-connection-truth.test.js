'use strict'
// R4: one Soulseek connection truth. Both pollers write through _setSlskStatus,
// which fills both readers, repaints the footer dot, and runs a waiting search
// when the connection comes up. R3/launch race: no caller gates a search on a
// possibly-stale status.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('every status fetch lands in _setSlskStatus; nothing writes slsk.status or connectionStatus.slskd directly', () => {
  const writes = [...CODE.matchAll(/slsk\.status = /g)].length
  assert.equal(writes, 1, 'only _setSlskStatus assigns slsk.status')
  const connWrites = [...CODE.matchAll(/state\.connectionStatus\.slskd = /g)].length
  assert.equal(connWrites, 1, 'only _setSlskStatus assigns the footer truth')
  assert.match(fn('refreshSlskStatus'), /_setSlskStatus\(await window\.api\.slskStatus\(\)\)/)
  assert.match(fn('checkConnections'), /_setSlskStatus\(s\)/)
  assert.match(CODE, /window\.api\.slskStatus\(\)\.then\(s => \{ _setSlskStatus\(s\) \}\)/, 'the startup fetch too')
})

test('_setSlskStatus fills both readers, paints the dot, and runs the waiting search on the connect edge', () => {
  const src = fn('_setSlskStatus') + '\n' + fn('_paintSlskConnDot') + '\n' + fn('_onSlskConnected')
  const runs = []
  const ctx = {
    slsk: { status: { installed: true, running: true, connected: false, configured: true }, lastQuery: 'camel', searching: false, searched: false },
    state: { connectionStatus: { slskd: 'disconnected', youtube: 'disconnected' } },
    document: { getElementById: (id) => (id === 'slsk-section' ? {} : null) },
    runSlskSearch: (q) => runs.push(q),
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  vm.runInContext("_setSlskStatus({ installed: true, running: true, connected: true, configured: true })", ctx)
  assert.equal(ctx.slsk.status.connected, true)
  assert.equal(ctx.state.connectionStatus.slskd, 'connected')
  assert.deepEqual(runs, ['camel'], 'the search that was waiting for the connection runs once')
  vm.runInContext("_setSlskStatus({ installed: true, running: true, connected: true, configured: true })", ctx)
  assert.deepEqual(runs, ['camel'], 'no edge, no re-run')
  vm.runInContext("_setSlskStatus(null)", ctx)
  assert.equal(ctx.slsk.status.connected, false, 'a failed fetch reads as disconnected')
  assert.equal(ctx.state.connectionStatus.slskd, 'disconnected')
  ctx.slsk.searched = true
  vm.runInContext("_setSlskStatus({ installed: true, running: true, connected: true, configured: true })", ctx)
  assert.deepEqual(runs, ['camel'], 'a finished search is not re-run by a reconnect')
})

test('no search entry point gates on a possibly-stale slsk.status (the launch race)', () => {
  assert.doesNotMatch(fn('renderSearch'), /slsk\.status\.connected && canSearchOnline/)
  assert.match(fn('renderSearch'), /if \(canSearchOnline\) \{/)
  assert.doesNotMatch(fn('renderSoulseekHub'), /slsk\.status\.connected\) runSlskSearch/)
  assert.match(fn('renderSoulseekHub'), /_rememberSearch\(q, 'soulseek'\)\s*runSlskSearch\(q\)/)
  assert.doesNotMatch(fn('_renderHubWishlist'), /slsk\.status\.connected\) runSlskSearch/)
})
