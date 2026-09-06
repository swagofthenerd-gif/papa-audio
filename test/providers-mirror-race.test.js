'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { raceMirrors, DEFAULT_RACE_TIMEOUT_MS } = require('../providers/mirror-race')

test('the fast mirror wins and the slow one is aborted', async () => {
  const events = []
  const attempt = (baseUrl, signal) => new Promise(resolve => {
    if (baseUrl === 'https://fast') {
      setTimeout(() => resolve(['payload']), 5)
      return
    }
    signal.addEventListener('abort', () => {
      events.push(`${baseUrl} aborted`)
      resolve(null)
    })
    // Never resolves on its own: only the abort ends it.
  })
  const won = await raceMirrors(['https://slow', 'https://fast'], attempt)
  assert.deepStrictEqual(won, { baseUrl: 'https://fast', result: ['payload'] })
  // The loser must have been aborted by the time the race settles, not left
  // running out a timeout in the background.
  assert.deepStrictEqual(events, ['https://slow aborted'])
})

test('a dead mirror (null) never wins; the working one does', async () => {
  const won = await raceMirrors(['https://dead', 'https://live'], async baseUrl =>
    baseUrl === 'https://live' ? { rows: 1 } : null)
  assert.deepStrictEqual(won, { baseUrl: 'https://live', result: { rows: 1 } })
})

test('every mirror failing resolves null rather than hanging or throwing', async () => {
  assert.strictEqual(await raceMirrors(['https://a', 'https://b'], async () => null), null)
})

test('a rejecting attempt counts as a dead mirror, not a crash', async () => {
  const won = await raceMirrors(['https://boom', 'https://live'], async baseUrl => {
    if (baseUrl === 'https://boom') throw new Error('ENOTFOUND')
    return ['ok']
  })
  assert.deepStrictEqual(won, { baseUrl: 'https://live', result: ['ok'] })
  assert.strictEqual(await raceMirrors(['https://boom'], async () => {
    throw new Error('ENOTFOUND')
  }), null)
})

test('an empty or missing mirror list resolves null', async () => {
  assert.strictEqual(await raceMirrors([], async () => ['x']), null)
  assert.strictEqual(await raceMirrors(null, async () => ['x']), null)
})

// Audit #6: the race has its own overall timeout so a direct caller can never
// hang on an attempt that neither resolves nor respects its signal.
test('the overall timeout resolves null and aborts stragglers', async () => {
  const aborted = []
  // An attempt that never resolves on its own — only the race timeout ends it.
  const attempt = (baseUrl, signal) => new Promise(() => {
    signal.addEventListener('abort', () => aborted.push(baseUrl))
  })
  const started = Date.now()
  const won = await raceMirrors(['https://hang1', 'https://hang2'], attempt, { timeoutMs: 20 })
  assert.strictEqual(won, null, 'a hung race resolves null on expiry, never hangs')
  assert.ok(Date.now() - started >= 15, 'it waited out the timeout')
  assert.deepStrictEqual(aborted.sort(), ['https://hang1', 'https://hang2'],
    'every straggler is aborted when the timeout fires')
})

test('a winner before the timeout clears the timer and still resolves the winner', async () => {
  // Resolves well within a generous timeout; the point is the timer is cleared
  // (no double-resolve, no leaked handle) and the winner is returned.
  const won = await raceMirrors(['https://slow', 'https://fast'], async baseUrl =>
    baseUrl === 'https://fast' ? ['payload'] : null, { timeoutMs: 5000 })
  assert.deepStrictEqual(won, { baseUrl: 'https://fast', result: ['payload'] })
})

test('the default overall timeout is exported and sane', () => {
  assert.strictEqual(typeof DEFAULT_RACE_TIMEOUT_MS, 'number')
  assert.ok(DEFAULT_RACE_TIMEOUT_MS >= 1000)
})

test('timeoutMs: 0 disables the overall timeout (all-fail still resolves null)', async () => {
  // With the backstop disabled, a race of dead mirrors must still resolve null
  // through the normal all-failed path rather than hanging.
  assert.strictEqual(
    await raceMirrors(['https://a', 'https://b'], async () => null, { timeoutMs: 0 }),
    null)
})

test('a late second success after the winner is ignored', async () => {
  const attempt = baseUrl => new Promise(resolve => {
    setTimeout(() => resolve([baseUrl]), baseUrl === 'https://first' ? 5 : 15)
  })
  const won = await raceMirrors(['https://second', 'https://first'], attempt)
  assert.strictEqual(won.baseUrl, 'https://first')
  // Give the slower one time to resolve; nothing should blow up.
  await new Promise(r => setTimeout(r, 25))
})

test('mirrors are initiated in list order, so the preferred mirror leads', async () => {
  const calls = []
  await raceMirrors(['https://a', 'https://b', 'https://c'], async baseUrl => {
    calls.push(baseUrl)
    return ['x']
  })
  assert.deepStrictEqual(calls.slice(0, 1), ['https://a'])
})
