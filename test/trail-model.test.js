'use strict'
// J4: the Trail — sessions as stories, from stores that already exist.
const test = require('node:test')
const assert = require('node:assert')
const T = require('../src/trail-model')

const NOW = Date.UTC(2026, 8, 11, 22, 0, 0) // Fri 11 Sep 2026, 22:00 UTC
const min = n => n * 60 * 1000
const searches = [
  { q: 'camel', surfaces: { music: NOW - min(60) }, opened: [{ kind: 'album', id: 'c1', label: 'Mirage', ts: NOW - min(58) }] },
  { q: 'tokyo revengers', surfaces: { video: NOW - min(5 * 60) } },
]
const plays = [
  { filePath: '/c/1.flac', title: 'Freefall', artist: 'Camel', album: 'Moonmadness', albumId: 'c2', ts: NOW - min(55) },
  { filePath: '/c/2.flac', title: 'Lunar Sea', artist: 'Camel', album: 'Moonmadness', albumId: 'c2', ts: NOW - min(50) },
  { filePath: '/x/1.flac', title: 'Something', artist: 'Other', album: 'Else', albumId: 'o1', ts: NOW - min(30 * 60) },
]
const watches = [{ key: 'tv:1', type: 'tv', id: 1, title: 'Reacher', season: 1, episode: 3, position: 1200, duration: 3000, updatedAt: NOW - min(4 * 60 + 30) }]

test('moments come from searches (per surface), opens, plays (merged per album) and watches', () => {
  const s = T.fromSearches(searches)
  assert.equal(s.length, 3)
  assert.ok(s.some(m => m.kind === 'search' && m.label === 'Searched “camel”' && m.sub === 'Search'))
  assert.ok(s.some(m => m.kind === 'open' && m.label === 'Opened Mirage' && m.restore.type === 'album' && m.restore.id === 'c1'))
  const p = T.fromPlays(plays)
  assert.equal(p.length, 2, 'two Moonmadness plays are one listen; the old play is another')
  const moon = p.find(m => m.label === 'Listened to Moonmadness')
  assert.equal(moon.sub, '2 tracks · Camel')
  assert.deepEqual(moon.restore, { type: 'album', id: 'c2', label: 'Moonmadness' })
  const w = T.fromWatches(watches.concat(watches))
  assert.equal(w.length, 1, 'the same title from two store views is one moment')
  assert.equal(w[0].label, 'Watching Reacher S1E3')
  // An anime run: episodes 8–13 watched back to back are one moment.
  const run = T.fromWatches([8, 9, 10, 11, 12, 13].map(e => ({ type: 'anime', id: 'kitsu-1', title: 'Tenjiku', episode: e, watched: true, updatedAt: NOW - min(120) + min(e * 15) })))
  assert.equal(run.length, 1)
  assert.equal(run[0].label, 'Watched Tenjiku')
  assert.equal(run[0].sub, '6 episodes (E8–E13)')
  assert.equal(run[0].restore.key, 'anime:kitsu-1')
  assert.equal(w[0].sub, '40% in')
  assert.deepEqual(w[0].restore, { type: 'video', key: 'tv:1', label: 'Reacher' })
})

test('episodes split on a 45-minute silence, newest first, with a three-beat title', () => {
  const eps = T.build({ searches, plays, watches }, { now: NOW })
  assert.equal(eps.length, 3)
  assert.equal(eps[0].day, 'Today')
  assert.equal(eps[0].count, 3, 'search camel, open Mirage, listen Moonmadness')
  assert.equal(eps[0].title, '“camel” → Mirage → Moonmadness')
  assert.equal(eps[1].title, '“tokyo revengers” → Reacher', 'the video search and the watch half an hour later are one sitting; a beat is the show, not the episode')
  assert.equal(eps[2].moments[0].kind, 'listen')
  assert.ok(eps[0].start >= eps[1].end)
})

test('a moment in the future or with no time is ignored; an empty world is an empty trail', () => {
  assert.deepEqual(T.build({ searches: [{ q: 'x', surfaces: { music: NOW + min(120) } }], plays: [{ filePath: '/a' }], watches: [null] }, { now: NOW }), [])
  assert.deepEqual(T.build(null), [])
})

test('pickUp offers the latest episode\'s searches and opens, not its plays, de-duplicated', () => {
  const eps = T.build({ searches, plays, watches }, { now: NOW })
  const pick = T.pickUp(eps, 3)
  assert.deepEqual(pick.map(m => m.kind), ['open', 'search'])
  assert.equal(pick[0].label, 'Opened Mirage')
  assert.deepEqual(T.pickUp([], 3), [])
})

test('day and time labels read like a person', () => {
  assert.equal(T.dayLabel(NOW - min(10), NOW), 'Today')
  assert.equal(T.dayLabel(NOW - min(24 * 60), NOW), 'Yesterday')
  assert.match(T.dayLabel(NOW - min(3 * 24 * 60), NOW), /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day$/)
  assert.match(T.dayLabel(NOW - min(40 * 24 * 60), NOW), /\d/)
  assert.match(T.timeLabel(NOW), /\d{1,2}:\d{2} (am|pm)/)
})

test('export is a portable, readable JSON of the episodes', () => {
  const eps = T.build({ searches, plays, watches }, { now: NOW })
  const j = JSON.parse(T.exportJson(eps))
  assert.ok(j.exportedAt && Array.isArray(j.episodes))
  assert.equal(j.episodes[0].moments.length, 3)
  assert.ok(j.episodes[0].moments.every(m => m.at && m.kind && m.label))
})
