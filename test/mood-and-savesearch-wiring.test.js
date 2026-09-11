'use strict'
// R6 + R7 wiring in the renderer, main and preload.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('R6: the mood engine loads before the renderer and the features channel exists end to end', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('mood-map.js') > order.indexOf('music-tools.js') && order.indexOf('mood-map.js') < order.indexOf('renderer.js'))
  assert.match(MAIN, /ipcMain\.handle\('audio-features-all', \(\) => \(\{ features: \(featureStore\.get\(\) \|\| \{\}\)\.features \|\| \{\} \}\)\)/)
  assert.match(PRELOAD, /audioFeaturesAll: \(\) => ipcRenderer\.invoke\('audio-features-all'\)/)
  assert.match(fn('_moodFeatures'), /window\.api\.audioFeaturesAll\(\)/)
})

test('R6: Explore chips come from the mood engine, carry counts, and always land on the Library mood filter', () => {
  const explore = fn('renderExplore')
  assert.match(explore, /var moods = window\.PapaMoodMap \? window\.PapaMoodMap\.MOODS : \[\]/)
  assert.match(explore, /data-mood="' \+ m\.id \+ '"/)
  assert.match(explore, /window\.PapaMoodMap\.moodCounts\(state\.library, features\)/)
  assert.doesNotMatch(CODE, /genreMap = \{ energetic:'rock'/, 'the one-word genre map is gone')
  const click = CODE.slice(CODE.indexOf("document.querySelectorAll('.mood-card').forEach"), CODE.indexOf("document.querySelectorAll('.daily-mix-card[data-mix-genre]')"))
  assert.match(click, /state\.libMood = mood/)
  assert.match(click, /navigate\('library'\)/)
  assert.doesNotMatch(click, /navigate\('search'/, 'a mood never dumps onto a text search')
})

test('R6: the Library filters and ranks by mood, counts it as a filter, clears it everywhere, and explains an empty result', () => {
  const lib = fn('renderLibrary')
  assert.match(lib, /if \(state\.libMood\) \{\s*var moodRank = _libMoodRank\(\)/)
  assert.match(lib, /return albums\.sort\(function \(a, b\) \{ return mr\[a\.id\] - mr\[b\.id\] \}\)/)
  assert.match(lib, /if \(state\.libMood\) activeFilterCount\+\+/)
  assert.match(lib, /id="clear-mood-filter"/)
  assert.match(lib, /Nothing feels ' \+ _moodDef\.emoji/)
  assert.equal((lib.match(/state\.libMood = null/g) || []).length, 2, 'both reset buttons clear it')
  assert.match(CODE, /getElementById\('clear-mood-filter'\)\?\.addEventListener\('click', function\(\) \{ state\.libMood = null; renderLibrary\(\) \}\)/, 'and the chip ✕ clears it')
})

test('R6: genre chips split compound tags and the filter answers every part', () => {
  const lib = fn('renderLibrary')
  assert.match(lib, /_albumGenreKeys\(a\)\.forEach\(function \(key\)/)
  assert.match(lib, /_albumGenreKeys\(a\)\.indexOf\(state\.libGenre\) !== -1/)
  assert.match(fn('_albumGenreKeys'), /window\.PapaMoodMap\.genreKeysOf\(a\)/)
})

test('R7: Save search writes evaluator-language rules and opens with a count', () => {
  const search = fn('renderSearch')
  const save = search.slice(search.indexOf("document.getElementById('save-search-btn')"), search.indexOf("document.getElementById('clear-filters-btn')"))
  assert.match(save, /if \(ops\.text\) rules\.push\(\{ field: 'any', op: 'matches', value: ops\.text \}\)/)
  assert.match(save, /if \(ops\.is === 'liked'\) rules\.push\(\{ field: 'liked', op: 'is', value: 'true' \}\)/)
  assert.match(save, /if \(ops\.playsMin\) rules\.push\(\{ field: 'playCount', op: 'gt'/)
  assert.doesNotMatch(save, /field: 'title', op: 'contains'/, 'free text is no longer a title-only match')
  assert.match(save, /showSnackbar\('Smart playlist saved: ' \+ sp\.name \+ ' \(' \+ found/)
})

test('R7: smart playlists are swept into the evaluator language on load, and delete hits the right store', () => {
  assert.match(CODE, /state\.smartPlaylists = window\.PapaLocal\.readArray\('papa-smart-playlists'\)\s*if \(window\.PapaMusicTools && window\.PapaMusicTools\.normalizeSmartRules\)/)
  assert.match(CODE, /if \(_spChanged\) _persistSmartPlaylists\(\)/)
  const del = CODE.slice(CODE.indexOf("document.getElementById('pl-delete-btn')"), CODE.indexOf("document.getElementById('pl-delete-btn')") + 1200)
  assert.match(del, /var isSmart = pl\.type === 'smart'/)
  assert.match(del, /state\.smartPlaylists = state\.smartPlaylists\.filter\(p => p\.id !== id\)/)
  assert.match(del, /if \(isSmart\) \{ state\.smartPlaylists\.push\(deletedPl\); _persistSmartPlaylists\(\) \}/, 'undo restores to the right store')
})
