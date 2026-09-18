'use strict'
// "Mark season watched" could refuse with a full season on the screen.
//
// _seasonEpisodeNumbers answers "which episodes does this season have". It
// prefers the catalogue's own list (d.seasons[n].episodes, cached back by
// _refreshTvEpisodes), and falls back to reading the grid that is on screen —
// for the case where the episodes were fetched but never cached back, which
// happens whenever the season is not one of the entries the show's detail
// record carries.
//
// That fallback looked for `.video-episode-btn`. Those are the numbered
// buttons, which are the FALLBACK rendering — _tvEpRenderGrid and the anime
// grid both draw `.vep-row` instead whenever src/episode-list.js is loaded,
// which is every shipping build (index.html loads it). So the fallback matched
// nothing, _confirmMarkSeasonWatched got an empty list, and the button
// answered "No episodes to mark for this season" while twenty-four episode
// rows sat on the page.
//
// This runs the real _seasonEpisodeNumbers against both grid renderings.
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

// A DOM stub shaped like the real grid rather than like the selector under
// test. The old one special-cased the literal string 'data-ep', so renaming
// the attribute in the production selector to [data-episode] matched every
// node anyway and five of six tests stayed green. Here a node has the
// attributes it really has, and a selector matches only if the node carries
// what the selector asks for.
function makeDoc (nodes) {
  return {
    querySelectorAll (sel) {
      const out = []
      for (const part of sel.split(',')) {
        const m = /^#([a-z-]+)\s+(?:\.([a-z-]+)|\[([a-z-]+)\])$/.exec(part.trim())
        assert.ok(m, 'unrecognised selector: ' + part)
        const [, container, cls, attr] = m
        for (const n of nodes) {
          if (n.container !== container) continue
          if (cls && n.classList.indexOf(cls) === -1) continue
          if (attr && !(attr in n.attrs)) continue
          if (out.indexOf(n) === -1) out.push(n)
        }
      }
      return out
    },
  }
}

// Built from the markup each grid really renders: an episode row carries
// class="vep-row" and data-ep="<n>"; a numbered button carries
// class="video-episode-btn" and the same data-ep. Nothing carries an
// attribute it does not have in the app.
function node (container, cls, ep) {
  const attrs = { class: cls }
  if (ep != null) attrs['data-ep'] = String(ep)
  return {
    container,
    classList: cls.split(/\s+/),
    attrs,
    dataset: ep == null ? {} : { ep: String(ep) },
    getAttribute (k) { return k in attrs ? attrs[k] : null },
  }
}

function run (source, nodes, detail, season) {
  const sandbox = {
    document: makeDoc(nodes),
    _videoDetail: detail,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(extractFn(source, '_seasonEpisodeNumbers'), sandbox)
  return sandbox._seasonEpisodeNumbers(season)
}

// A show whose detail record names the season but carries no episode list for
// it — exactly when the on-screen fallback is the only answer available.
const DETAIL_NO_EPISODES = { type: 'tv', id: '1396', d: { id: '1396', seasons: [{ seasonNumber: 2 }] } }

test('the rows every shipping build draws are counted', () => {
  const rows = [1, 2, 3, 4].map(n => node('video-episode-list-inner', 'vep-row', n))
  assert.strictEqual(run(SRC, rows, DETAIL_NO_EPISODES, 2).join(','), '1,2,3,4')
})

test('the anime grid, which mounts its rows in the other container, too', () => {
  const rows = [7, 8, 9].map(n => node('video-episode-list', 'vep-row', n))
  assert.strictEqual(run(SRC, rows, DETAIL_NO_EPISODES, 2).join(','), '7,8,9')
})

test('the numbered-button rendering still works', () => {
  // The fallback rendering, used when src/episode-list.js is absent. Fixing
  // the rows must not cost the buttons.
  const btns = [1, 2, 3].map(n => node('video-episode-list', 'video-episode-btn', n))
  assert.strictEqual(run(SRC, btns, DETAIL_NO_EPISODES, 2).join(','), '1,2,3')
})

test('the catalogue list still wins over the screen when it has one', () => {
  const detail = {
    type: 'tv',
    d: { id: '1396', seasons: [{ seasonNumber: 2, episodes: [{ episodeNumber: 1 }, { episodeNumber: 2 }, { episodeNumber: 3 }] }] },
  }
  // Only one window of a long season is on screen; the answer must be the
  // whole season, not what happens to be painted.
  const rows = [3].map(n => node('video-episode-list-inner', 'vep-row', n))
  assert.strictEqual(run(SRC, rows, detail, 2).join(','), '1,2,3')
})

test('nothing on screen and nothing in the record is still an empty answer', () => {
  assert.strictEqual(run(SRC, [], DETAIL_NO_EPISODES, 2).length, 0)
})

test('MUTATION: keying on the button class alone finds nothing on a real page', () => {
  const broken = SRC.replace(
    "    document.querySelectorAll('#video-episode-list [data-ep], #video-episode-list-inner [data-ep]')",
    "    document.querySelectorAll('#video-episode-list .video-episode-btn, #video-episode-list-inner .video-episode-btn')")
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const rows = [1, 2, 3, 4].map(n => node('video-episode-list-inner', 'vep-row', n))
  assert.strictEqual(run(broken, rows, DETAIL_NO_EPISODES, 2).length, 0,
    'this is the defect: four episode rows on screen, "No episodes to mark"')
})

test('MUTATION: renaming the attribute in the selector finds nothing either', () => {
  // The other half of the same failure: the data attribute the rows actually
  // carry is data-ep, and a selector asking for anything else is as dead as
  // the old class-only one. The DOM stub must be able to tell the difference.
  const broken = SRC.replace(
    "    document.querySelectorAll('#video-episode-list [data-ep], #video-episode-list-inner [data-ep]')",
    "    document.querySelectorAll('#video-episode-list [data-episode], #video-episode-list-inner [data-episode]')")
  assert.notStrictEqual(broken, SRC, 'the mutation applied')
  const rows = [1, 2, 3, 4].map(n => node('video-episode-list-inner', 'vep-row', n))
  assert.strictEqual(run(broken, rows, DETAIL_NO_EPISODES, 2).length, 0,
    'four episode rows on screen, "No episodes to mark" again')
  const btns = [1, 2, 3].map(n => node('video-episode-list', 'video-episode-btn', n))
  assert.strictEqual(run(broken, btns, DETAIL_NO_EPISODES, 2).length, 0)
})
