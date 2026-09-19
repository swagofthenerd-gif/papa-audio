'use strict'
// A TERM to the whole process group left `cleanShutdown` false and the next
// boot offered a crash restore for a shutdown that was asked for (final live
// pass, 2026-09-19). The flag must be the first thing the signal handler
// writes, ahead of every teardown that can be slow or die with the children.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function handlerBody() {
  const at = MAIN.indexOf('function shutdownFromSignal()')
  assert.ok(at > -1)
  return MAIN.slice(at, MAIN.indexOf('\n}\n', at))
}

test('the clean-shutdown flag is written before any teardown in the signal handler', () => {
  const body = handlerBody()
  const flag = body.indexOf("store.set('cleanShutdown', true)")
  assert.ok(flag > -1, 'the handler must still write the flag')
  for (const later of ['player?.stop()', '_videoTeardown()', '_torrentTeardown(', 'stopSlskd()']) {
    const at = body.indexOf(later)
    assert.ok(at > flag, `${later} must come AFTER the flag write, got ${at} vs ${flag}`)
  }
})

test('the flag is written exactly once in the handler', () => {
  assert.strictEqual(handlerBody().split("store.set('cleanShutdown', true)").length - 1, 1)
})
