'use strict'
// "The sources are not loading for an anime I am watching — they were there
// before."
//
// Measured on the running app, 2026-09-23. It had started during a network blip:
//     [anilist] request degraded: fetch failed — pausing AniList calls for 30s
//     [papa][ipc] video-seasons timed out after 60000ms
//     [papa][ipc] video-enrich timed out after 60000ms
// so the detail page kept the English title and nothing else. Nearly every
// release of "Frieren: Beyond Journey's End" is named "Sousou no Frieren", and
// the source search — correctly — refuses a release that names a different show.
// Asked with the English title alone it found 0 sources; asked with the romaji
// title it found 19. The same query, the same minute, the same indexer.
//
// Nothing reported a fault. The page said there were no sources, which was a
// true statement about a question nobody meant to ask.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { matchesShowTitle, showTitles } = require('../providers/show-title')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift(name) {
  const at = MAIN.indexOf('\nasync function ' + name + '(')
  assert.ok(at > -1, name + ' must still be a top-level async function in main.js')
  let depth = 0
  for (let i = MAIN.indexOf('{', at); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++
    else if (MAIN[i] === '}') { depth--; if (depth === 0) return MAIN.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces reading ' + name)
}

// The real AniList answer for Frieren, trimmed.
const FRIEREN = {
  english: 'Frieren: Beyond Journey’s End',
  romaji: 'Sousou no Frieren',
  native: '葬送のフリーレン',
  synonyms: ['Frieren at the Funeral'],
}

// Release names taken verbatim from nyaa on the day this was diagnosed.
const RELEASES = [
  '[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [6AAEC79A].mkv',
  '[Erai-raws] Sousou no Frieren 2nd Season - 05 [1080p CR WEB-DL AVC AAC]',
]

function ctxWith(byId) {
  const logged = []
  const ctx = {
    Number, Object, Array, Map, Set, String, console: { log: m => logged.push(m), warn: m => logged.push(m) },
    anilist: () => ({ byId }),
  }
  vm.createContext(ctx)
  vm.runInContext('const _animeTitleCache = new Map()\n' + lift('_animeTitlesFor'), ctx)
  return { ctx, logged }
}

// ── The premise, stated so it cannot rot ────────────────────────────────────

test('the English title alone matches no real release; the romaji title matches them all', () => {
  const englishOnly = showTitles({ title: FRIEREN.english })
  for (const r of RELEASES) {
    assert.strictEqual(matchesShowTitle(r, englishOnly), false,
      'the guard is meant to refuse this — it names a show it was not asked for: ' + r)
  }
  const full = showTitles({ title: FRIEREN.english, titles: FRIEREN })
  for (const r of RELEASES) {
    assert.strictEqual(matchesShowTitle(r, full), true,
      'with the romaji name known, this is plainly the right show: ' + r)
  }
})

// ── The recovery ────────────────────────────────────────────────────────────

test('a page with no alternate titles has them fetched before searching', async () => {
  let asked = 0
  const { ctx, logged } = ctxWith(async id => { asked++; assert.strictEqual(id, 154587); return { titles: FRIEREN } })
  const got = await ctx._animeTitlesFor(154587, null)
  assert.strictEqual(asked, 1)
  assert.strictEqual(got.romaji, 'Sousou no Frieren')
  assert.ok(logged.some(m => /recovered/.test(String(m))), 'the recovery is said out loud, not silent')
  // And the search that follows would now work.
  assert.strictEqual(matchesShowTitle(RELEASES[0], showTitles({ title: FRIEREN.english, titles: got })), true)
})

test('a page that already has the romaji title asks AniList nothing', async () => {
  let asked = 0
  const { ctx } = ctxWith(async () => { asked++; return { titles: FRIEREN } })
  const got = await ctx._animeTitlesFor(154587, FRIEREN)
  assert.strictEqual(asked, 0, 'a working page must not pay for a call it does not need')
  assert.strictEqual(got, FRIEREN, 'and is handed back exactly what it had')
})

test('an English title the viewer is reading is not replaced by the romaji one', async () => {
  const { ctx } = ctxWith(async () => ({ titles: FRIEREN }))
  const got = await ctx._animeTitlesFor(154587, { english: 'A Name The Page Chose' })
  assert.strictEqual(got.english, 'A Name The Page Chose', 'the list must keep saying what it said')
  assert.strictEqual(got.romaji, 'Sousou no Frieren', 'and gain the name releases use')
})

test('the fetch happens once per show, not once per episode', async () => {
  let asked = 0
  const { ctx } = ctxWith(async () => { asked++; return { titles: FRIEREN } })
  for (let ep = 1; ep <= 5; ep++) await ctx._animeTitlesFor(154587, null)
  assert.strictEqual(asked, 1, 'asked ' + asked + ' times for five episodes of one show')
})

test('AniList still being down is survivable, not fatal', async () => {
  const { ctx } = ctxWith(async () => { throw new Error('fetch failed') })
  const had = { english: FRIEREN.english }
  const got = await ctx._animeTitlesFor(154587, had)
  assert.strictEqual(got, had, 'the search goes out with what we had rather than not going out')
})

test('an AniList answer carrying no usable name changes nothing', async () => {
  const { ctx } = ctxWith(async () => ({ titles: { english: 'Something Else' } }))
  const had = { english: FRIEREN.english }
  assert.strictEqual(await ctx._animeTitlesFor(154587, had), had,
    'an answer with no romaji or native name is not a recovery')
})

test('no AniList id means nothing to ask, and no crash', async () => {
  const { ctx } = ctxWith(async () => { throw new Error('should not be called') })
  assert.strictEqual(await ctx._animeTitlesFor(null, null), null)
  assert.strictEqual(await ctx._animeTitlesFor(0, null), null)
  assert.strictEqual(await ctx._animeTitlesFor('nonsense', null), null)
})

// ── The wiring ──────────────────────────────────────────────────────────────

test('video-streams recovers the titles it searches with, and only for anime', () => {
  const at = MAIN.indexOf("ipcMain.handle('video-streams'")
  assert.ok(at > -1)
  let depth = 0
  let body = ''
  for (let i = MAIN.indexOf('{', at); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++
    else if (MAIN[i] === '}') { depth--; if (depth === 0) { body = MAIN.slice(at, i + 1); break } }
  }
  assert.match(body, /_animeTitlesFor\(anilistId, titles\)/, 'the handler must recover the titles')
  assert.match(body, /titles: searchTitles/, 'and search with the recovered set, not the original')
  assert.match(body, /sourceType === 'anime'\s*\n?\s*\?\s*await _animeTitlesFor/,
    'film and television must not pay for an AniList call')
})
