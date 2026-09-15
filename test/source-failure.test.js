'use strict'
const test = require('node:test')
const assert = require('node:assert')
const F = require('../src/source-failure')

// Roadmap 057: offline, cancelled, timed out, rate limited and nothing are different answers.
test('each failure kind has its own sentence and next step', () => {
  assert.deepEqual(F.explain('YouTube', null, { cancelled: true }), { kind: 'cancelled', text: 'YouTube search cancelled.', action: 'retry' })
  assert.equal(F.explain('YouTube', 'x', { offline: true }).kind, 'offline')
  assert.equal(F.explain('Soulseek', 'HTTP 429 Too Many Requests').kind, 'ratelimited')
  assert.equal(F.explain('Soulseek', 'Request timed out after 20 s').kind, 'timeout')
  assert.equal(F.explain('YouTube', 'Sign in to confirm you are not a bot').action, 'settings')
  assert.equal(F.explain('Soulseek', 'not connected').kind, 'disconnected')
  assert.equal(F.explain('Soulseek', 'fetch failed').kind, 'unreachable')
  assert.equal(F.explain('YouTube', '').kind, 'empty')
  assert.equal(F.explain('YouTube', null).text, 'Nothing found on YouTube.')
})

test('Electron IPC noise is stripped before it reaches a person', () => {
  const r = F.explain('Soulseek', new Error("Error invoking remote method 'slsk-search': Error: ECONNREFUSED 127.0.0.1:5030"))
  assert.equal(r.kind, 'unreachable')
  assert.doesNotMatch(r.text, /remote method/)
})

test('cancelled beats offline beats the error text, so a deliberate cancel is never called a failure', () => {
  assert.equal(F.explain('YouTube', 'timeout', { cancelled: true, offline: true }).kind, 'cancelled')
  assert.equal(F.explain('YouTube', 'timeout', { offline: true }).kind, 'offline')
})

test('action labels exist for every action that has a button', () => {
  for (const a of ['retry', 'wait', 'connection', 'settings']) assert.ok(F.actionLabel(a))
  assert.equal(F.actionLabel('none'), '')
})
