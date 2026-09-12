'use strict'
// Every season, prequel, sequel and side story of an anime is on its page:
// the seasons request carries the MAL id and title so a fallback-sourced card
// resolves; main falls back to MAL's graph; the page shows a Related rail.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('the seasons request carries idMal and title, and main tries MAL when AniList gives nothing', () => {
  assert.match(R, /window\.api\.videoSeasons\(\{ type: 'anime', id: detail\.d\.id, idMal: detail\.d\.idMal \|\| null, title: detail\.d\.title \|\| null \}\)/)
  assert.match(M, /out = await anilist\(\)\.seasonChain\(id, \{ idMal: idMal \|\| null, title: title \|\| null \}\)/)
  assert.match(M, /const viaMal = await jikan\(\)\.seasonChain\(mal\)/)
})

test('related titles render as their own rail with the relation named, even when there is only one season', () => {
  assert.match(R, /if \(items\.length < 2 && !related\.length\) \{ box\.hidden = true/)
  assert.match(R, /_relatedRailHtml\(related\)/)
  const at = R.indexOf('function _relatedRailHtml(related)')
  const fn = R.slice(at, R.indexOf('\n}\n', at))
  assert.match(fn, /vseasons-title">Related</)
  assert.match(fn, /_relationWord\(item\.relation, item\.format\)/)
  const w = R.slice(R.indexOf('const _RELATION_WORDS'), at)
  assert.match(w, /SIDE_STORY: 'Side story'/)
  assert.match(w, /if \(f === 'MOVIE'\) return base === 'Related' \? 'Film' : base \+ ' · film'/)
})
