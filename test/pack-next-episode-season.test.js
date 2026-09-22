'use strict'
// Press Next in season 2 and get season 1.
//
// A complete-series torrent puts each season in its own folder and numbers every
// one of them from 01 again. torrent-stream's files() carries that folder as
// `group` for exactly this reason — the flattened strip read "1 1 1 2 2 2…"
// without it. But the two places that answered "which file is the next episode?"
// matched on the episode NUMBER alone, so a pack holding four seasons held four
// files all answering to "episode 2", and the first one in the torrent won.
//
// The pack file lists here are produced by the real TorrentStreamer.files(), from
// paths spelled the way packs actually spell them, so the episode numbers and
// folder names under test are the ones that ship rather than ones invented here.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { TorrentStreamer } = require('../torrent-stream')
const RELEASE = require('../src/release-name')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(')
  assert.ok(start > -1, name + ' must still be a top-level function in renderer.js')
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces reading ' + name)
}

// The matcher, run with only the globals it actually reads.
function matcher() {
  const ctx = { window: { PapaReleaseName: RELEASE }, PapaReleaseName: RELEASE, Number, String, Array }
  vm.createContext(ctx)
  vm.runInContext(lift('_packGroupSeason') + '\n' + lift('_packFileForEpisode'), ctx)
  return ctx._packFileForEpisode
}

// A pack's file list exactly as the streamer produces it. `playingPath` marks
// which file is on screen, which is what files() reports as `current`.
function packFiles(paths, playingPath) {
  const streamer = Object.create(TorrentStreamer.prototype)
  streamer._torrent = { files: paths.map(p => ({ name: p.split('/').pop(), path: p, length: 1_400_000_000 })) }
  streamer._server = { address: () => ({ port: 8080 }) }
  streamer._fileIndex = paths.indexOf(playingPath)
  assert.ok(streamer._fileIndex > -1, 'playingPath must be one of the paths')
  return streamer.files()
}

// A complete-series batch: four seasons, each numbered from 01, each in its own
// folder, plus the credit-less openings packs always carry.
const SLIME = [
  'Slime Complete/Season 1/[SubsPlease] Slime - 01 (1080p).mkv',
  'Slime Complete/Season 1/[SubsPlease] Slime - 02 (1080p).mkv',
  'Slime Complete/Season 1/[SubsPlease] Slime - 03 (1080p).mkv',
  'Slime Complete/Season 2/[SubsPlease] Slime - 01 (1080p).mkv',
  'Slime Complete/Season 2/[SubsPlease] Slime - 02 (1080p).mkv',
  'Slime Complete/Season 3/[SubsPlease] Slime - 01 (1080p).mkv',
  'Slime Complete/Season 3/[SubsPlease] Slime - 02 (1080p).mkv',
  'Slime Complete/Extras/NCOP1.mkv',
]

test('the pack really does hold one "episode 2" per season', () => {
  const files = packFiles(SLIME, SLIME[3])
  const twos = files.filter(f => f.episode === 2)
  assert.strictEqual(twos.length, 3, 'the premise of the bug, measured: ' + JSON.stringify(twos.map(f => f.group)))
  assert.deepStrictEqual(twos.map(f => f.group), ['Season 1', 'Season 2', 'Season 3'])
})

test('Next from season 2 episode 1 plays SEASON 2 episode 2', () => {
  const pick = matcher()
  const files = packFiles(SLIME, SLIME[3])            // watching S2E1
  const got = pick(files, { season: 2, episode: 2 })
  assert.ok(got, 'the pack carries it; refusing here would send us to the indexers')
  assert.strictEqual(got.group, 'Season 2', 'played ' + got.group + ' instead')
  assert.strictEqual(got.name, '[SubsPlease] Slime - 02 (1080p).mkv')
})

test('Next from season 3 episode 1 plays SEASON 3 episode 2', () => {
  const pick = matcher()
  const files = packFiles(SLIME, SLIME[5])
  const got = pick(files, { season: 3, episode: 2 })
  assert.strictEqual(got.group, 'Season 3')
})

test('Next from season 1 still plays season 1', () => {
  const pick = matcher()
  const files = packFiles(SLIME, SLIME[0])
  const got = pick(files, { season: 1, episode: 2 })
  assert.strictEqual(got.group, 'Season 1')
})

// Anime entries are a single season in the catalog, so the target names no
// season at all. The folder the file on screen lives in is what settles it.
test('with no season asked for, the folder being watched is the one used', () => {
  const pick = matcher()
  const files = packFiles(SLIME, SLIME[4])            // watching S2E2
  const got = pick(files, { season: null, episode: 3 })
  // Season 2 has no episode 3, and nothing else names season 2 — so rather than
  // reaching into another season this refuses and the caller resolves fresh.
  assert.strictEqual(got, null, 'reached into another season for episode 3')
})

test('a single-season pack is unaffected', () => {
  const pick = matcher()
  const ONE = [
    'Show S01/Show - 01.mkv',
    'Show S01/Show - 02.mkv',
    'Show S01/Show - 03.mkv',
  ]
  const files = packFiles(ONE, ONE[0])
  const got = pick(files, { season: 1, episode: 2 })
  assert.strictEqual(got.name, 'Show - 02.mkv')
})

test('a flat pack with no folders at all still works', () => {
  const pick = matcher()
  const FLAT = ['Show - 01.mkv', 'Show - 02.mkv', 'Show - 03.mkv']
  const files = packFiles(FLAT, FLAT[0])
  const got = pick(files, { season: 1, episode: 2 })
  assert.strictEqual(got.name, 'Show - 02.mkv', 'a pack with one file per episode has no ambiguity to resolve')
})

test('an episode the pack does not carry returns nothing, as before', () => {
  const pick = matcher()
  const files = packFiles(SLIME, SLIME[3])
  assert.strictEqual(pick(files, { season: 2, episode: 40 }), null)
})

test('folders spelled S02 rather than "Season 2" are understood', () => {
  const pick = matcher()
  const P = [
    'Show Complete/S01/Show - 01.mkv',
    'Show Complete/S01/Show - 02.mkv',
    'Show Complete/S02/Show - 01.mkv',
    'Show Complete/S02/Show - 02.mkv',
  ]
  const files = packFiles(P, P[2])
  const got = pick(files, { season: 2, episode: 2 })
  assert.strictEqual(got.group, 'S02')
})

test('folders spelled "2nd Season" are understood', () => {
  const pick = matcher()
  const P = [
    'Slime/Slime/Slime - 01.mkv',
    'Slime/Slime/Slime - 02.mkv',
    'Slime/Slime 2nd Season/Slime - 01.mkv',
    'Slime/Slime 2nd Season/Slime - 02.mkv',
  ]
  const files = packFiles(P, P[2])
  const got = pick(files, { season: 2, episode: 2 })
  assert.strictEqual(got.group, 'Slime 2nd Season')
})

test('two encodes of the same episode in the right season take the larger', () => {
  const pick = matcher()
  const files = [
    { index: 0, name: 'S - 02 v1.mkv', group: 'Season 2', episode: 2, length: 900 },
    { index: 1, name: 'S - 02 v2.mkv', group: 'Season 2', episode: 2, length: 1500 },
    { index: 2, name: 'S - 02.mkv', group: 'Season 1', episode: 2, length: 4000 },
  ]
  const got = pick(files, { season: 2, episode: 2 })
  assert.strictEqual(got.name, 'S - 02 v2.mkv', 'a bigger file in the WRONG season must not win')
})

test('when no folder identifies the season, it refuses rather than guessing', () => {
  const pick = matcher()
  const files = [
    { index: 0, name: 'a - 02.mkv', group: 'Disc 1', episode: 2, length: 100 },
    { index: 1, name: 'b - 02.mkv', group: 'Disc 2', episode: 2, length: 100 },
  ]
  // Nothing declares a season and nothing is playing, so neither rule applies.
  assert.strictEqual(pick(files, { season: 2, episode: 2 }), null,
    'a guess here is the wrong-episode bug; the caller resolves fresh sources instead')
})
