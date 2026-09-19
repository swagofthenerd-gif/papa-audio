'use strict'
// "slskd restarted after 3 failed health checks" was a message, not a restart.
//
// The monitor called `await startSlskd()`, and startSlskd returns immediately
// when slskdProc is set — slskd is our own child, so the guard that stops a
// second daemon being spawned also stopped the wedged one being replaced.
// Nothing was killed, nothing was started, the log said it had been, and the UI
// flickered "restarting" every three minutes for as long as the daemon stayed
// stuck.
//
// The real slskdHealthCheck and stopSlskdAndWait are lifted out of main.js and
// run here against a fake child process. NOTHING in this file touches the real
// daemon, the real port, or the user's account — the whole point is to test a
// restart without performing one.

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')

const { liftFns, MAIN } = require('./helpers/lift-main-fn.js')

// A stand-in for a spawned slskd. kill() is recorded; whether it then "exits"
// is the test's choice, which is how the SIGKILL escalation gets exercised.
function fakeProc(pid, { exitsOnTerm = true } = {}) {
  const proc = new EventEmitter()
  proc.pid = pid
  proc.killed = []
  proc.kill = function (sig) {
    proc.killed.push(sig || 'SIGTERM')
    if (sig === 'SIGKILL' || exitsOnTerm) setImmediate(() => proc.emit('exit', 0, sig || null))
  }
  return proc
}

// Build a sandbox where slskdProc/startSlskd/stopSlskd/slskdFetch are ours.
//
// The lifted code's module-level variables live on the sandbox's backing object,
// NOT on whatever object was passed in — liftFns copies. So the stubs are bound
// to that backing object after lifting, or they would be reading and writing a
// second, dead copy of slskdProc while the real code used another.
function harness({ proc = null, sessionFails = true, spawnPid = null, startThrows = false } = {}) {
  const log = { restarted: [], warned: [], errored: [], status: [] }
  const lifted = liftFns(['stopSlskdAndWait', 'slskdHealthCheck', 'stopSlskd'], {
    _slskdFailures: 0,
    slskdProc: proc,
    slskdReady: true,
    startSlskdCalls: 0,
    upnpUnmap() {},
    safeSend(_ch, payload) { log.status.push(payload) },
    console: {
      log(m) { log.restarted.push(String(m)) },
      warn(m) { log.warned.push(String(m)) },
      error(m) { log.errored.push(String(m)) },
    },
  }, ['SLSKD_STOP_TIMEOUT_MS'])
  const G = lifted.globals
  G.slskdFetch = async () => {
    if (sessionFails) throw new Error('ECONNREFUSED')
    return {}
  }
  G.startSlskd = async () => {
    G.startSlskdCalls++
    if (startThrows) throw new Error('spawn failed')
    // The real one returns early while slskdProc is set. Mirror that exactly:
    // if the monitor has not killed the old child, nothing new appears.
    if (G.slskdProc) return
    if (spawnPid != null) G.slskdProc = fakeProc(spawnPid)
  }
  return { env: G, fns: lifted.fns, log }
}

async function failThreeTimes(h) {
  let last = null
  for (let i = 0; i < 3; i++) last = await h.fns.slskdHealthCheck()
  return last
}

test('the premise: startSlskd is a no-op while slskdProc is set', () => {
  // If this stops being true the restart can go back to being one call, and
  // this whole file should be revisited rather than quietly kept.
  const at = MAIN.indexOf('async function startSlskd() {')
  assert.ok(at > -1)
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at))
  assert.ok(body.includes('if (slskdProc) return'),
    'startSlskd still returns early when we already have a child')
})

test('three failed health checks kill the wedged child and spawn a new one', async () => {
  const old = fakeProc(4242)
  const h = harness({ proc: old, spawnPid: 9999 })
  const verdict = await failThreeTimes(h)

  assert.strictEqual(verdict, 'restarted')
  assert.ok(old.killed.length > 0, 'the wedged daemon must actually be killed')
  assert.strictEqual(h.env.startSlskdCalls, 1, 'and a new one started')
  assert.strictEqual(h.env.slskdProc.pid, 9999, 'the running daemon is a different process now')
  assert.ok(h.log.restarted.some(m => /restarted.*4242 -> 9999/.test(m)),
    'and the log names both pids, so "restarted" can be checked against reality')
  assert.strictEqual(h.env._slskdFailures, 0, 'the counter resets on a real restart')
})

test('only two failures restart nothing', async () => {
  const old = fakeProc(4242)
  const h = harness({ proc: old, spawnPid: 9999 })
  assert.strictEqual(await h.fns.slskdHealthCheck(), 'counting')
  assert.strictEqual(await h.fns.slskdHealthCheck(), 'counting')
  assert.deepStrictEqual(old.killed, [], 'nothing killed yet')
  assert.strictEqual(h.env.startSlskdCalls, 0)
})

test('a daemon that comes back healthy clears the count without a restart', async () => {
  const old = fakeProc(4242)
  const h = harness({ proc: old, sessionFails: true, spawnPid: 9999 })
  await h.fns.slskdHealthCheck()
  await h.fns.slskdHealthCheck()
  assert.strictEqual(h.env._slskdFailures, 2)
  h.env.slskdFetch = async () => ({})
  assert.strictEqual(await h.fns.slskdHealthCheck(), 'ok')
  assert.strictEqual(h.env._slskdFailures, 0)
  assert.deepStrictEqual(old.killed, [], 'a daemon that answered was never killed')
})

test('rate limiting is not a fault and never restarts anything', async () => {
  const old = fakeProc(4242)
  const h = harness({ proc: old, spawnPid: 9999 })
  h.env.slskdFetch = async () => { const e = new Error('429'); e.code = 'SLSKD_THROTTLED'; throw e }
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(await h.fns.slskdHealthCheck(), 'throttled')
  }
  assert.strictEqual(h.env._slskdFailures, 0)
  assert.deepStrictEqual(old.killed, [])
  assert.strictEqual(h.env.startSlskdCalls, 0)
})

test('a restart that produces nothing is reported as what it is, and retried', async () => {
  // The child is killed, startSlskd spawns nothing (the binary is gone, the
  // port is held). The old code logged a successful restart here.
  const old = fakeProc(4242)
  const h = harness({ proc: old, spawnPid: null })
  const verdict = await failThreeTimes(h)

  assert.strictEqual(verdict, 'failed')
  assert.ok(old.killed.length > 0)
  assert.ok(!h.log.restarted.some(m => /restarted/.test(m)),
    'nothing may claim a restart happened')
  assert.ok(h.log.warned.some(m => /did not come back/.test(m)), 'it says so instead')
  assert.strictEqual(h.env._slskdFailures, 3,
    'the count is kept so the next cycle tries again rather than believing itself')
  assert.strictEqual(h.log.status[h.log.status.length - 1].restarting, false,
    'and the UI stops saying "restarting"')
})

test('no child of ours means there is nothing to kill, and it says reconnected', async () => {
  // slskd running externally: startSlskd re-authenticates against it. Killing
  // someone else's daemon is not ours to do.
  const h = harness({ proc: null, spawnPid: null })
  const verdict = await failThreeTimes(h)
  assert.strictEqual(verdict, 'reconnected')
  assert.ok(!h.log.restarted.some(m => /restarted/.test(m)))
  assert.strictEqual(h.env._slskdFailures, 0)
})

test('a child that ignores SIGTERM is SIGKILLed rather than waited on forever', async () => {
  const stubborn = fakeProc(4242, { exitsOnTerm: false })
  const h = harness({ proc: stubborn })
  // Run stopSlskdAndWait directly with the ten-second cap collapsed, so the test
  // exercises the escalation instead of sleeping through it.
  h.env.setTimeout = (fn) => { const t = setImmediate(fn); t.unref = () => {}; return t }
  h.env.clearTimeout = (t) => { try { clearImmediate(t) } catch (_) {} }
  const relifted = liftFns(['stopSlskdAndWait', 'stopSlskd'], h.env, ['SLSKD_STOP_TIMEOUT_MS'])
  const pid = await relifted.fns.stopSlskdAndWait()
  assert.strictEqual(pid, 4242, 'it resolves with the pid it killed')
  assert.ok(stubborn.killed.includes('SIGKILL'),
    'SIGTERM was ignored, so SIGKILL must follow — a restart cannot wait forever')
})

test('the health monitor interval delegates to slskdHealthCheck', () => {
  // The function can be as careful as it likes; if the timer still carries its
  // own copy of the old logic, none of it runs in the app.
  const at = MAIN.indexOf('// Auto-restart monitoring:')
  assert.ok(at > -1, 'the monitor must still be armed')
  const block = MAIN.slice(at, MAIN.indexOf('}, 60000)', at))
  assert.ok(block.includes('slskdHealthCheck()'), 'the timer calls the real decision')
  assert.ok(!block.includes('_slskdFailures'),
    'and does not keep a second copy of the failure counting')
})
