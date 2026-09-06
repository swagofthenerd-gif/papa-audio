'use strict'
// App #49+75 — the unified diary timeline. The aggregation module is pure, so it
// is run for real; the renderer glue is pinned by source shape at the end.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { buildTimeline, albumFirstPlays } = require('../src/diary-timeline')

// A viewing as the taste store stores it: a calendar day plus a meta snapshot.
const view = (date, title, extra = {}) =>
  ({ id: 'd-' + date + '-' + title, key: 'movie:' + title, date, meta: { title }, ...extra })

// A play-history row as the music side records it.
const play = (album, artist, ts) => ({ album, artist, ts, artPath: null })

test('albumFirstPlays keeps the earliest play per album+artist', () => {
  const hist = [
    play('Kind of Blue', 'Miles Davis', 3000),
    play('Kind of Blue', 'Miles Davis', 1000),   // earlier — this wins
    play('Kind of Blue', 'Miles Davis', 2000),
    play('Blue Train', 'John Coltrane', 5000),
  ]
  const firsts = albumFirstPlays(hist)
  assert.strictEqual(firsts.length, 2)
  const kob = firsts.find(f => f.album === 'Kind of Blue')
  assert.strictEqual(kob.ts, 1000, 'the earliest timestamp is the first listen')
  assert.strictEqual(kob.artist, 'Miles Davis')
})

test('albumFirstPlays drops rows with no album name or a bad timestamp', () => {
  const firsts = albumFirstPlays([
    play('', 'Nobody', 1000),
    { album: 'Good', artist: 'A', ts: 'not-a-number' },
    play('Real', 'Artist', 4000),
    null, 42,
  ])
  assert.deepStrictEqual(firsts.map(f => f.album), ['Real'])
})

test('the same album by two artists is two first-listens', () => {
  const firsts = albumFirstPlays([
    play('Greatest Hits', 'Queen', 1000),
    play('Greatest Hits', 'ABBA', 2000),
  ])
  assert.strictEqual(firsts.length, 2)
})

test('buildTimeline interleaves films and albums newest-first, grouped by month', () => {
  const jan = new Date(2026, 0, 10).getTime()
  const feb = new Date(2026, 1, 5).getTime()
  const built = buildTimeline({
    viewings: [view('2026-01-15', 'Dune'), view('2026-02-20', 'Arrival')],
    history: [play('Selected Ambient Works', 'Aphex Twin', jan), play('Discovery', 'Daft Punk', feb)],
  })
  assert.strictEqual(built.hasAlbums, true)
  // February before January (newest-first months).
  assert.deepStrictEqual(built.months.map(m => m.label), ['February 2026', 'January 2026'])
  // Inside February: Arrival (20th) before Discovery (5th).
  assert.deepStrictEqual(built.months[0].events.map(e => e.kind), ['film', 'album'])
  assert.strictEqual(built.months[0].events[0].title, 'Arrival')
})

test('buildTimeline is films-only, and says so, with no play history', () => {
  const built = buildTimeline({ viewings: [view('2026-03-01', 'Solaris')], history: [] })
  assert.strictEqual(built.hasAlbums, false)
  assert.strictEqual(built.months.length, 1)
  assert.strictEqual(built.months[0].events.length, 1)
  assert.strictEqual(built.months[0].events[0].kind, 'film')
})

test('buildTimeline filters to a single year when asked', () => {
  const y2025 = new Date(2025, 5, 1).getTime()
  const built = buildTimeline({
    viewings: [view('2026-01-01', 'New'), view('2025-06-01', 'Old')],
    history: [play('Album25', 'Artist', y2025)],
    year: 2026,
  })
  const titles = built.months.flatMap(m => m.events.map(e => e.title || e.album))
  assert.deepStrictEqual(titles, ['New'])
})

test('a film event carries its key, title, poster and rating; a bad date is dropped', () => {
  const built = buildTimeline({
    viewings: [
      { key: 'movie:27205', date: '2026-04-04', rating: 4.5, meta: { title: 'Inception', poster: '/p.jpg' } },
      { key: 'movie:bad', date: 'nonsense', meta: { title: 'Dropped' } },
    ],
    history: [],
  })
  const ev = built.months[0].events[0]
  assert.strictEqual(ev.key, 'movie:27205')
  assert.strictEqual(ev.poster, '/p.jpg')
  assert.strictEqual(ev.rating, 4.5)
  // The undated viewing never made it in.
  const all = built.months.flatMap(m => m.events)
  assert.ok(!all.some(e => e.title === 'Dropped'))
})

// ── Renderer wiring ─────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')

function fn(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

test('the diary body includes the timeline section', () => {
  const body = fn('_renderDiaryBody')
  assert.match(body, /_diaryTimelineHtml\(store\)/)
})

test('the timeline pulls viewings and the music play history through the pure module', () => {
  const t = fn('_diaryTimelineHtml')
  assert.match(t, /window\.PapaDiaryTimeline/)
  assert.match(t, /store\.diary\(/)
  assert.match(t, /state\.playHistory/)
  assert.match(t, /buildTimeline\(/)
  // The honest films-only note when the history yielded nothing.
  assert.match(t, /Films and shows only/)
})

test('timeline film rows link to the detail page; album rows do not', () => {
  const bind = fn('_bindTimelineLinks')
  assert.match(bind, /\.tl-film\[data-tl-key\]/)
  assert.match(bind, /navigate\('video-detail'/)
})

test('the diary-timeline module is loaded before the renderer', () => {
  assert.match(HTML, /<script src="diary-timeline\.js"><\/script>/)
  const at = HTML.indexOf('<script src="diary-timeline.js">')
  const rat = HTML.indexOf('<script src="renderer.js">')
  assert.ok(at > -1 && rat > -1 && at < rat, 'must load before renderer.js reads window.PapaDiaryTimeline')
})
