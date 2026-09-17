'use strict'
// Restoring a backup must bring back the settings it saved.
//
// The export writes { stores, settings }. The import iterated only `stores`,
// skipping `settings` because it "would clobber real keys with the redaction
// marker". Measured against a real config that reasoning is inverted: 31 keys
// carry real data and 6 are redacted. The guard against 6 was discarding 31 —
// liked albums, followed artists, the download wishlist, the music folders
// themselves — while the UI said "Restored ✓".

const test = require('node:test')
const assert = require('node:assert')
const { planSettingsRestore, mergeUnredacted, MARK } = require('../src/restore-merge')

test('ordinary settings come back', () => {
  const plan = planSettingsRestore({}, {
    likedAlbums: ['a1', 'a2'],
    theme: 'dark',
    musicFolders: ['/mnt/data/MUSIC'],
  })
  const keys = plan.writes.map(w => w.key).sort()
  assert.deepStrictEqual(keys, ['likedAlbums', 'musicFolders', 'theme'])
  assert.deepStrictEqual(plan.writes.find(w => w.key === 'likedAlbums').value, ['a1', 'a2'])
})

test('a wholly redacted key is left alone, not written as the marker', () => {
  const plan = planSettingsRestore({ apiKeys: { real: 'secret-in-place' } }, {
    apiKeys: MARK,
    theme: 'dark',
  })
  assert.deepStrictEqual(plan.writes.map(w => w.key), ['theme'],
    'the marker must never be written over a real value')
  assert.ok(plan.skipped.includes('apiKeys'), 'and the restore must be able to say so')
})

test('a partly redacted object keeps its real fields AND its existing secret', () => {
  // This is the case the original blanket skip got wrong: skipping the whole
  // key to protect the secret also threw away the username beside it.
  const cur = { lastfmConfig: { username: 'old-name', sessionKey: 'live-secret' } }
  const inc = { lastfmConfig: { username: 'backed-up-name', sessionKey: MARK } }
  const plan = planSettingsRestore(cur, inc)
  const w = plan.writes.find(x => x.key === 'lastfmConfig')
  assert.ok(w, 'the key must still be restored')
  assert.strictEqual(w.value.username, 'backed-up-name', 'the real field comes back')
  assert.strictEqual(w.value.sessionKey, 'live-secret', 'the live secret is untouched')
  assert.ok(plan.skipped.includes('lastfmConfig'), 'and it is reported as partial')
})

test('nested redaction is handled at any depth', () => {
  const cur = { a: { b: { keep: 1, token: 'live' } } }
  const inc = { a: { b: { keep: 2, token: MARK } } }
  const w = planSettingsRestore(cur, inc).writes.find(x => x.key === 'a')
  assert.strictEqual(w.value.b.keep, 2)
  assert.strictEqual(w.value.b.token, 'live')
})

test('an array carrying a redacted entry keeps the current list', () => {
  // Half a wishlist is worse than a stale one.
  const cur = { slskSavedUsers: ['alice', 'bob'] }
  const inc = { slskSavedUsers: ['alice', MARK] }
  const plan = planSettingsRestore(cur, inc)
  const w = plan.writes.find(x => x.key === 'slskSavedUsers')
  assert.deepStrictEqual(w.value, ['alice', 'bob'], 'never a partial list')
  assert.ok(plan.skipped.includes('slskSavedUsers'))
})

test('a clean array is replaced wholesale, not merged by index', () => {
  const cur = { likedAlbums: ['old1', 'old2', 'old3'] }
  const inc = { likedAlbums: ['new1'] }
  const w = planSettingsRestore(cur, inc).writes.find(x => x.key === 'likedAlbums')
  assert.deepStrictEqual(w.value, ['new1'],
    'merging two lists by index would produce a list that was in neither backup')
})

test('keys the backup does not mention are not touched', () => {
  const plan = planSettingsRestore({ volume: 0.5, theme: 'dark' }, { theme: 'light' })
  assert.deepStrictEqual(plan.writes.map(w => w.key), ['theme'])
})

test('a missing or malformed settings blob restores nothing and throws nothing', () => {
  for (const bad of [null, undefined, [], 'nope', 42]) {
    const plan = planSettingsRestore({ theme: 'dark' }, bad)
    assert.deepStrictEqual(plan.writes, [], String(bad))
  }
})

test('the real shape of his config survives a round trip', () => {
  // The keys measured on the live machine, with the six that genuinely redact.
  const real = {
    likedAlbums: ['x'], followedArtists: ['y'], downloadWishlist: [{ q: 'z' }],
    musicFolders: ['/mnt/data/MUSIC'], theme: 'dark', volume: 0.8,
    eqSettings: { bands: [1, 2] }, slskSavedUsers: ['peer'],
    apiKeys: MARK, ytCookie: MARK, slskdApiCreds: MARK,
  }
  const plan = planSettingsRestore({}, real)
  const written = plan.writes.map(w => w.key)
  for (const k of ['likedAlbums', 'followedArtists', 'downloadWishlist', 'musicFolders',
                   'theme', 'volume', 'eqSettings', 'slskSavedUsers']) {
    assert.ok(written.includes(k), k + ' must be restored')
  }
  for (const k of ['apiKeys', 'ytCookie', 'slskdApiCreds']) {
    assert.ok(!written.includes(k), k + ' must not be written as the marker')
  }
})
