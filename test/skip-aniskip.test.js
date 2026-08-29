'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createAniSkip, buildUrl, normalizeResult, SKIP_KIND } = require('../skip/aniskip')

test('buildUrl produces the AniSkip endpoint with op and ed types', () => {
  assert.strictEqual(
    buildUrl({ malId: 21, episode: 1, episodeLength: 0 }),
    'https://api.aniskip.com/v2/skip-times/21/1?types=op&types=ed&episodeLength=0'
  )
  assert.strictEqual(
    buildUrl({ malId: 21, episode: 3, episodeLength: 1500 }),
    'https://api.aniskip.com/v2/skip-times/21/3?types=op&types=ed&episodeLength=1500'
  )
})

test('normalizeResult maps op/ed/recap and drops junk', () => {
  assert.deepStrictEqual(
    normalizeResult({ skipType: 'op', interval: { startTime: 28.7, endTime: 118.7 } }),
    { kind: 'intro', start: 28.7, end: 118.7, origin: 'aniskip', confidence: 0.95 }
  )
  assert.strictEqual(normalizeResult({ skipType: 'ed', interval: { startTime: 1388, endTime: 1500 } }).kind, 'credits')
  assert.strictEqual(normalizeResult({ skipType: 'recap', interval: { startTime: 0, endTime: 30 } }).kind, 'recap')
  assert.strictEqual(normalizeResult({ skipType: 'op', interval: { startTime: 100, endTime: 50 } }), null, 'inverted interval')
  assert.strictEqual(normalizeResult({ skipType: 'unknown', interval: { startTime: 0, endTime: 10 } }), null)
  assert.strictEqual(normalizeResult(null), null)
})

test('createAniSkip returns segments for a found result', async () => {
  const fetchFn = async (url) => {
    assert.ok(url.startsWith('https://api.aniskip.com/v2/skip-times/21/1'))
    return {
      ok: true,
      json: async () => ({
        statusCode: 200,
        found: true,
        results: [
          { skipType: 'op', interval: { startTime: 28.783, endTime: 118.783 } },
          { skipType: 'ed', interval: { startTime: 1387.996, endTime: 1500 } },
        ],
      }),
    }
  }
  const aniskip = createAniSkip({ fetchFn })
  const segments = await aniskip({ malId: 21, episode: 1 })
  assert.strictEqual(segments.length, 2)
  assert.strictEqual(segments[0].kind, 'intro')
  assert.strictEqual(segments[1].kind, 'credits')
})

test('createAniSkip returns [] when found is false, not an error', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ statusCode: 200, found: false, results: [] }) })
  const aniskip = createAniSkip({ fetchFn })
  assert.deepStrictEqual(await aniskip({ malId: 1, episode: 1 }), [])
})

test('createAniSkip never throws — network, non-OK and malformed payloads all return []', async () => {
  for (const fetchFn of [
    async () => { throw new Error('network down') },
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, json: async () => { throw new Error('bad json') } }),
    async () => ({ ok: true, json: async () => null }),
    async () => ({ ok: true, json: async () => ({ found: true, results: 'nope' }) }),
  ]) {
    const aniskip = createAniSkip({ fetchFn })
    assert.deepStrictEqual(await aniskip({ malId: 1, episode: 1 }), [])
  }
})

test('createAniSkip returns [] without a valid malId or episode', async () => {
  let called = 0
  const aniskip = createAniSkip({ fetchFn: async () => { called++; return { ok: true, json: async () => ({ found: true, results: [] }) } } })
  assert.deepStrictEqual(await aniskip({ malId: 0, episode: 1 }), [])
  assert.deepStrictEqual(await aniskip({ malId: 1, episode: 0 }), [])
  assert.deepStrictEqual(await aniskip({}), [])
  assert.strictEqual(called, 0, 'nothing may be fetched without a valid key')
})
