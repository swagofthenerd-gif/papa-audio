const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// Two separate stores, two separate channel pairs:
//   getLiked / saveLiked             <-> likedAlbums  (album id hashes)
//   getLikedTracks / saveLikedTracks <-> likedTracks  (absolute file paths)
//
// Crossing them is silent and destructive: it replaces one store's contents
// with the other's shape, and the next ordinary save persists the corruption.
// This happened twice, in two unrelated places, so it is worth pinning.

test('saveLiked is never handed the liked-TRACKS array', () => {
  const bad = [...SRC.matchAll(/api\.saveLiked\(\s*state\.likedTracks\s*\)/g)]
  assert.equal(bad.length, 0,
    'saveLiked() writes likedAlbums — passing likedTracks wipes every liked album')
})

test('saveLikedTracks is never handed the liked-ALBUMS array', () => {
  const bad = [...SRC.matchAll(/api\.saveLikedTracks\(\s*state\.likedAlbums\s*\)/g)]
  assert.equal(bad.length, 0,
    'saveLikedTracks() writes likedTracks — passing likedAlbums wipes every liked song')
})

test('state.likedTracks is only ever loaded from getLikedTracks()', () => {
  const bad = [...SRC.matchAll(/state\.likedTracks\s*=\s*await\s+window\.api\.getLiked\(\)/g)]
  assert.equal(bad.length, 0,
    'getLiked() returns album ids; loading them into likedTracks corrupts it in memory')
})

test('state.likedAlbums is only ever loaded from getLiked()', () => {
  const bad = [...SRC.matchAll(/state\.likedAlbums\s*=\s*await\s+window\.api\.getLikedTracks\(\)/g)]
  assert.equal(bad.length, 0)
})
