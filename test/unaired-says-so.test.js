'use strict'
// An entry that has not aired is not a search that failed.
//
// He opened Steel Ball Run 2nd-3rd STAGE — AniList status NOT_YET_RELEASED —
// and the app ran its full twenty-second fan-out across every indexer for a
// season whose episodes do not exist anywhere, then said "No sources found".
// Which reads as the app being broken, and was reported as exactly that:
// "even jojo's new episodes arent playing man". The truth was one field away.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const at = SRC.indexOf('\nasync function ' + name + '(')
  assert.ok(at > -1, name + ' must be a top-level async function')
  let depth = 0
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(at, i + 1) }
  }
  throw new Error('unbalanced')
}

// A page with just the sources box, and a videoStreams spy that records
// whether the search was fired at all.
function page({ status, startDate } = {}) {
  const box = { innerHTML: '' }
  const searched = { count: 0 }
  const ctx = {
    document: {
      getElementById: id => (id === 'video-sources' ? box : null),
    },
    window: { api: { videoStreams: async () => { searched.count++; return { ok: true, streams: [] } } } },
    esc: s => String(s == null ? '' : s),
    _videoStreamRequest: () => ({ type: 'anime', title: 'x', episode: 1 }),
    _videoDetail: { type: 'anime', d: { title: 'Steel Ball Run 2nd - 3rd STAGE', status, startDate } },
    _videoDetailTicket: 1,
    _videoSeasonTicket: 1,
    _videoStreams: null,
    _videoStreamsHidden: null,
    String, Number, Array, Object,
  }
  vm.createContext(ctx)
  vm.runInContext(lift('_loadVideoSources'), ctx)
  return { ctx, box, searched }
}

test('an unaired entry says so, instead of searching and "finding nothing"', async () => {
  const { ctx, box, searched } = page({ status: 'NOT_YET_RELEASED', startDate: { year: 2026, month: 10, day: 8 } })
  await ctx._loadVideoSources(1, 1)
  assert.match(box.innerHTML, /has not aired yet/)
  assert.match(box.innerHTML, /2026-10-08/, 'the expected date is the useful half of the answer')
  assert.strictEqual(searched.count, 0,
    'no indexer is asked for episodes that do not exist anywhere — that was the 20s of looking broken')
})

test('a date known only to the year is still said, without inventing a month', async () => {
  const { ctx, box } = page({ status: 'NOT_YET_RELEASED', startDate: { year: 2027 } })
  await ctx._loadVideoSources(1, 1)
  assert.match(box.innerHTML, /2027/)
  assert.ok(!/2027-/.test(box.innerHTML))
})

test('a released entry searches exactly as before', async () => {
  const { ctx, searched } = page({ status: 'RELEASING' })
  await ctx._loadVideoSources(1, 1).catch(() => { /* the fake page stops after the search */ })
  assert.strictEqual(searched.count, 1, 'airing shows must keep their search')
})

test('a TMDB page with its own status vocabulary is untouched', async () => {
  // TMDB spells unreleased differently; the exact-AniList-string guard must
  // not swallow searches on pages whose status it does not understand.
  const { ctx, searched } = page({ status: 'Post Production' })
  await ctx._loadVideoSources(1, 1).catch(() => {})
  assert.strictEqual(searched.count, 1)
})
