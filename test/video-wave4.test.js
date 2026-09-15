'use strict'
// Wave-4 UI items (roadmap #28–#33) that live in the renderer: the pure
// season-marking decision, the Continue-Watching remove/undo wiring, the
// per-show track-memory feature-detect, and the "Mark season watched" control.
// The renderer is one large file that cannot be required outside Electron, so
// pure functions are extracted by brace-matching and run in a vm context, and
// the wiring is checked against the source the way the other renderer tests do.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in the renderer')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// A context with the two pure helpers the season-marking decision needs.
function markCtx() {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext(extract('_watchKey'), ctx)
  vm.runInContext(extract('_seasonEpisodesToMark'), ctx)
  return ctx
}

// ── _seasonEpisodesToMark (roadmap #33, pure) ─────────────────────────────────
test('_seasonEpisodesToMark returns the not-yet-watched episodes with their keys', () => {
  const ctx = markCtx()
  // Episode 2 is already watched; the rest are not.
  const store = { 'tv:1396:s1e2': { watched: true } }
  const out = ctx._seasonEpisodesToMark('tv', 1396, 1, [1, 2, 3], k => store[k] || null)
  assert.strictEqual(out.length, 2, 'the already-watched episode is skipped')
  // out crosses vm realms, so compare values not array identity.
  assert.strictEqual(out.map(e => e.episode).join(','), '1,3')
  assert.strictEqual(out[0].key, 'tv:1396:s1e1', 'keys match the watch-key shape')
  assert.strictEqual(out[1].key, 'tv:1396:s1e3')
})

test('_seasonEpisodesToMark returns nothing when the whole season is watched', () => {
  const ctx = markCtx()
  const store = { 'tv:9:s2e1': { watched: true }, 'tv:9:s2e2': { watched: true } }
  const out = ctx._seasonEpisodesToMark('tv', 9, 2, [1, 2], k => store[k] || null)
  assert.strictEqual(out.length, 0)
})

test('_seasonEpisodesToMark tolerates a missing reader, nulls and duplicates', () => {
  const ctx = markCtx()
  // No reader at all: every episode counts as unwatched.
  assert.strictEqual(ctx._seasonEpisodesToMark('tv', 1, 1, [1, 2], null).length, 2)
  // A reader that throws is treated as "unknown", i.e. not watched.
  const out = ctx._seasonEpisodesToMark('tv', 1, 1, [1, null, 1, 2], () => { throw new Error('x') })
  // The null is dropped and the duplicate 1 collapses to one key.
  assert.strictEqual(out.map(e => e.episode).join(','), '1,2')
})

// ── Continue-Watching remove + undo wiring (roadmap #33 / #66) ─────────────────
test('the CW card ✕ removes the store entry rather than marking it watched', () => {
  const at = SRC.indexOf('function _removeFromContinueWatching(')
  assert.ok(at > -1, 'the remove helper must exist')
  const body = SRC.slice(at, at + 2400)
  assert.match(body, /store\.remove\(/, 'it deletes the entry')
  assert.match(body, /pushUndo\(/, 'and offers Undo per the app convention')
  assert.match(body, /restore\(cwKey, removed\)/, 'undo restores the entry verbatim')
  // The card action was rewired from mark-watched to remove.
  assert.match(SRC, /data-act="cwremove"/)
  assert.match(SRC, /aria-label="Remove from Continue Watching"/)
  const handler = SRC.slice(SRC.indexOf("act.dataset.act === 'cwremove'"), SRC.indexOf("act.dataset.act === 'cwremove'") + 160)
  assert.match(handler, /_removeFromContinueWatching\(act\.dataset\.cwkey, c\)/)
})

// ── Mark season watched (roadmap #33) ─────────────────────────────────────────
test('the TV controls carry a confirmed, undoable "Mark season watched"', () => {
  assert.match(SRC, /id="video-season-seen"/, 'the button exists on the season row')
  assert.match(SRC, /_confirmMarkSeasonWatched\(_videoState\.season\)/, 'it is bound')
  const at = SRC.indexOf('function _confirmMarkSeasonWatched(')
  assert.ok(at > -1)
  const body = SRC.slice(at, at + 2600)
  assert.match(body, /_mgConfirm\(/, 'it confirms before marking')
  assert.match(body, /store\.markWatched\(/, 'it marks each episode watched')
  assert.match(body, /pushUndo\(/, 'and the whole action is undoable')
})

// ── Per-show track memory feature-detect (roadmap #31/#32) ─────────────────────
test('_videoPlayResult feature-detects the videoTrackMemory contract', () => {
  const at = SRC.indexOf('function _videoPlayResult(')
  // Widened as _videoPlayResult grew: the watch identity, the hedge lanes,
  // the debrid candidate list and the rewatch-cache probe all sit above the
  // track-memory block now (2026-09-16).
  const body = SRC.slice(at, at + 14000)
  // Read side: prefer the backend memory, fall back to the store's prefs.
  assert.match(body, /videoTrackMemoryGet/, 'reads from the contract when present')
  assert.match(body, /store\.prefs\(showKey\)/, 'still reads the local store')
  // Write side: mirror the pref change into the backend when it exists, as the
  // flat named fields the contract takes (not a wrapped {memory} object).
  assert.match(body, /videoTrackMemorySet/, 'writes to the contract when present')
  assert.match(body, /store\.setPrefs\(showKey, patch\)/, 'still writes the local store')
  assert.match(body, /call\.audioLang = patch\.audioLang/, 'sends flat named fields')
})

// ── Per-series dub/sub memory (roadmap #32) ───────────────────────────────────
test('the dub toggle remembers and re-applies the show’s dub/sub choice', () => {
  // Save: toggling the dub control records dubPref through the contract.
  const bind = SRC.slice(SRC.indexOf('function _bindDubControl('), SRC.indexOf('function _rememberDubPref('))
  assert.match(bind, /_rememberDubPref\(e\.target\.checked \? 'dub' : 'sub'\)/)
  const remember = SRC.slice(SRC.indexOf('function _rememberDubPref('), SRC.indexOf('function _seasonEpisodeNumbers('))
  assert.match(remember, /videoTrackMemorySet\(\{ showKey: showKey, dubPref: dubPref \}\)/)
  // Seed: opening a detail applies a remembered dubPref to the toggle.
  const seed = SRC.slice(SRC.indexOf('function _seedDubPref('), SRC.indexOf('function _rememberDubPref('))
  assert.match(seed, /videoTrackMemoryGet/)
  assert.match(seed, /dubPref !== 'dub' && dubPref !== 'sub'/)
  assert.match(seed, /_videoState\.sub = wantSub/)
  assert.match(SRC, /_seedDubPref\(type, id, ticket\)/, 'seed is called on detail open')
})
