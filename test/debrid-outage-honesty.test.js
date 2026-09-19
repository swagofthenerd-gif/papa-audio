'use strict'
// A RealDebrid outage or a bad token used to come back as "no such file in
// this release": packFiles swallowed every resolve failure and returned [], and
// linkForFile swallowed it and then fell through to its own NO_FILE. So the
// viewer went hunting for a problem with the release while the actual problem
// was their account or RD being down.
//
// These drive the real client with a scripted fetch.
const test = require('node:test')
const assert = require('node:assert')
const { createDebrid, DebridError } = require('../src/debrid')

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789&dn=Some.Show.S02'

// Every RD call answers with one status, which is what an outage or a dead
// token actually looks like from here.
function failingFetch(status) {
  return async () => ({
    ok: false,
    status,
    text: async () => 'RealDebrid says ' + status,
  })
}

function client(fetchFn) {
  return createDebrid({ token: 'tok', fetchFn, sleep: async () => {}, pollIntervalMs: 1 })
}

for (const [status, code] of [[401, 'BAD_TOKEN'], [503, 'HTTP_503'], [429, 'HTTP_429'], [500, 'HTTP_500']]) {
  test(`packFiles reports a ${status} instead of an empty episode strip`, async () => {
    const d = client(failingFetch(status))
    await assert.rejects(() => d.packFiles(MAGNET, { episode: 3 }), e => {
      assert.ok(e instanceof DebridError, 'the real reason must reach the caller')
      assert.strictEqual(e.code, code)
      return true
    })
  })

  test(`linkForFile reports a ${status} instead of "no such file"`, async () => {
    const d = client(failingFetch(status))
    await assert.rejects(() => d.linkForFile(MAGNET, 3), e => {
      assert.notStrictEqual(e.code, 'NO_FILE',
        'a ' + status + ' is not the release missing a file')
      assert.strictEqual(e.code, code)
      return true
    })
  })
}

// The other half: a release RealDebrid genuinely does not have still gives the
// quiet answer, because that IS what it means.
test('a 404 still means an empty strip, not an error', async () => {
  const d = client(failingFetch(404))
  assert.deepStrictEqual(await d.packFiles(MAGNET, { episode: 3 }), [])
})

test('a 404 still reports no such file', async () => {
  const d = client(failingFetch(404))
  await assert.rejects(() => d.linkForFile(MAGNET, 3), e => {
    assert.strictEqual(e.code, 'NO_FILE')
    return true
  })
})

// RD's own verdict on a magnet is about the release too.
test("RD's own terminal verdict on a magnet is an empty strip", async () => {
  const fetchFn = async url => {
    const body = url.includes('/torrents/info/')
      ? { status: 'magnet_error', files: [], links: [] }
      : { id: 'T1' }
    return { ok: true, status: url.includes('selectFiles') ? 204 : 200, text: async () => JSON.stringify(body) }
  }
  const d = client(fetchFn)
  assert.deepStrictEqual(await d.packFiles(MAGNET, { episode: 3 }), [])
})
