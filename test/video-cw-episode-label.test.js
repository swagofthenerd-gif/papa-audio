'use strict'
// A Continue Watching card for an anime did not say which episode you were on.
//
// _watchKey numbers television as 'tv:<id>:s<season>e<episode>' and anime as
// 'anime:<id>:e<episode>' — an anime runs straight through, so the store keeps
// an episode and no season for one (the play path writes
// `season: vd.type === 'tv' ? vs.season : null`).
//
// The card's meta line only ever printed the pair:
//
//     if (item.season != null && item.episode != null) push('S…·E…')
//
// so every anime card on the shelf showed a poster, a year and a progress bar
// and left out the one fact the shelf exists to carry. On a library that is
// mostly anime that is most of the shelf.
//
// These build cards with the REAL _videoCard.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') {
      depth--
      if (!depth) {
        const body = source.slice(start, j + 1)
        return (source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

function build (source) {
  const sandbox = {
    window: { PapaVideoStore: null, PapaWatchRules: null },
    _instantKeys: {},
    _VICON: { play: '<svg/>', check: '<svg/>', plus: '<svg/>' },
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([
    extractFn(source, '_vStore'),
    extractFn(source, '_watchKey'),
    extractFn(source, '_cwIsStale'),
    extractFn(source, '_certLabel'),
    extractFn(source, '_vRatesHtml'),
    extractFn(source, '_vRuntime'),
    extractFn(source, '_videoCard'),
    'const _VRATE_SOURCES = ' + /const _VRATE_SOURCES = (\[[\s\S]*?\n\])/.exec(source)[1],
  ].join('\n'), sandbox)
  return sandbox
}

// The meta line only, so an assertion cannot be satisfied by a badge or an
// aria-label somewhere else on the card.
function meta (html) {
  const m = /<div class="vcard-meta">([\s\S]*?)<\/div>/.exec(html)
  assert.ok(m, 'the card has a meta line')
  return m[1]
}

// Exactly what the store hands continueWatching() back for an anime.
const ANIME_CW = {
  type: 'anime', id: '154587', title: 'Frieren', poster: 'p.jpg',
  year: 2023, episode: 12, season: null, position: 600, duration: 1440,
  updatedAt: Date.now(),
}
const TV_CW = {
  type: 'tv', id: '1396', title: 'Breaking Bad', poster: 'p.jpg',
  year: 2008, season: 3, episode: 7, position: 600, duration: 2800,
  updatedAt: Date.now(),
}

test('an anime Continue Watching card says which episode you are on', () => {
  const s = build(SRC)
  assert.match(meta(s._videoCard(ANIME_CW)), /\bE12\b/,
    'the one fact the shelf is for')
})

test('television still reads as season and episode', () => {
  const s = build(SRC)
  const line = meta(s._videoCard(TV_CW))
  assert.match(line, /S3/)
  assert.match(line, /E7/)
  assert.ok(!/\bE3\b/.test(line), 'the season is not mistaken for an episode')
})

test('a film card grows nothing', () => {
  const s = build(SRC)
  const line = meta(s._videoCard({ type: 'movie', id: '27205', title: 'Inception', year: 2010 }))
  assert.strictEqual(line.trim(), '2010')
})

test('a catalogue card with no episode is unchanged', () => {
  const s = build(SRC)
  const line = meta(s._videoCard({ type: 'anime', id: '21', title: 'One Piece', year: 1999 }))
  assert.ok(!/E/.test(line.replace(/[^E]/g, '')) || !/E\d/.test(line),
    'no episode on the record, nothing invented')
})

test('an empty episode field is absence, not episode zero', () => {
  const s = build(SRC)
  assert.ok(!/E(?![a-z])/.test(meta(s._videoCard({ type: 'anime', id: '1', title: 'x', episode: '' }))))
})

test('the progress bar the shelf already drew is still there', () => {
  const s = build(SRC)
  assert.match(s._videoCard(ANIME_CW), /vcard-progress/,
    'this changes the words, not the bar')
})

test('MUTATION: without the anime branch the episode disappears again', () => {
  const broken = SRC.replace(
    "  else if (item.episode != null && item.episode !== '') metaBits.push('E' + esc(String(item.episode)))",
    '')
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const s = build(broken)
  const line = meta(s._videoCard(ANIME_CW))
  assert.ok(!/E12/.test(line), 'this is the defect: the card said 2023 and nothing else')
  assert.strictEqual(line.trim(), '2023')
})
