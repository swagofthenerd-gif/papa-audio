'use strict'
// `radiohead year:>1999 format:flac` returned 0 local albums.
//
// His Radiohead folders are "2000 Kid A (4.0)", "2001 Amnesiac" — no tag year
// at all — and the filter read `a.year >= filters.yearMin`. `null >= 1999` is
// false, so every untagged album was silently dropped and the page said the
// library had nothing. The same page then printed the chip as `key + ':' +
// value`, so `year:>1999` and `year:<1999` both rendered "year:1999", with the
// value interpolated unescaped.
//
// Both helpers are lifted from renderer.js and run for real.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(names) {
	const parts = names.map(n => {
		const start = SRC.indexOf('\nfunction ' + n + '(')
		assert.ok(start > -1, n + ' must still be a top-level function in renderer.js')
		const a = SRC.indexOf('\nfunction ', start + 1)
		const b = SRC.indexOf('\nasync function ', start + 1)
		const stop = [a, b].filter(x => x > -1).sort((x, y) => x - y)[0]
		return SRC.slice(start, stop)
	})
	const ctx = vm.createContext({ String, Number, parseInt, RegExp, Math })
	vm.runInContext(parts.join('\n') + '\nvar __f = {' + names.map(n => n + ':' + n).join(',') + '}', ctx)
	return ctx.__f
}

const { _albumFilterYear, _filterChipLabel } = lift(['_albumFilterYear', '_filterChipLabel'])

// The filter block VERBATIM out of renderSearch — re-typing it here would mean
// a change to the page could not turn this file red.
const YEAR_BLOCK = (() => {
	const start = SRC.indexOf('  var unknownYearKept = 0')
	assert.ok(start > -1, 'the year filter block must still start with unknownYearKept')
	const end = SRC.indexOf('\n  if (filters.format)', start)
	assert.ok(end > start, 'the year block must still be followed by the format filter')
	return SRC.slice(start, end)
})()

function applyYear(albums, filters) {
	const ctx = vm.createContext({
		String, Number, parseInt, RegExp, Math,
		matchAlbums: albums.slice(), filters,
		_albumFilterYear,
	})
	vm.runInContext(YEAR_BLOCK + '\nvar __r = { out: matchAlbums, unknownYearKept: unknownYearKept }', ctx)
	return ctx.__r
}

// ── the year fallback ────────────────────────────────────────────────────────

test('a tagged year still wins', () => {
	assert.strictEqual(_albumFilterYear({ year: 1997, name: '2000 Wrong' }), 1997)
	assert.strictEqual(_albumFilterYear({ year: '1997', name: 'OK Computer' }), 1997)
})

test('a null year falls back to the leading year in the folder name', () => {
	assert.strictEqual(_albumFilterYear({ year: null, name: '2000 Kid A (4.0)' }), 2000)
	assert.strictEqual(_albumFilterYear({ year: null, name: '2001 Amnesiac' }), 2001)
})

test('a number that is not a leading year is not mistaken for one', () => {
	// "1999" by Prince is a title, not a prefix; "10 Songs" is a track count.
	assert.strictEqual(_albumFilterYear({ year: null, name: 'Kid A' }), null)
	assert.strictEqual(_albumFilterYear({ year: null, name: '10 Songs' }), null)
	assert.strictEqual(_albumFilterYear({ year: null, name: 'Album 2000' }), null)
})

test('year:>1999 matches the untagged "2000 Kid A" folder — the reported bug', () => {
	const albums = [
		{ id: 'a', artist: 'Radiohead', name: '2000 Kid A (4.0)', year: null },
		{ id: 'b', artist: 'Radiohead', name: '2001 Amnesiac', year: null },
		{ id: 'c', artist: 'Radiohead', name: '1997 OK Computer', year: null },
	]
	const r = applyYear(albums, { yearMin: 1999 })
	assert.deepStrictEqual(r.out.map(a => a.id), ['a', 'b'],
		'the 2000 and 2001 folders must match year:>1999; 1997 must not')
	assert.strictEqual(r.unknownYearKept, 0)
})

test('an album whose year is genuinely unknown is KEPT, not dropped', () => {
	const albums = [
		{ id: 'a', name: '2000 Kid A', year: null },
		{ id: 'u', name: 'Untitled Bootleg', year: null },
	]
	const r = applyYear(albums, { yearMin: 1999 })
	assert.deepStrictEqual(r.out.map(a => a.id), ['a', 'u'])
	assert.strictEqual(r.unknownYearKept, 1,
		'the page must be able to say how many it kept on faith')
})

test('yearMax uses the same helper — both bounds agree', () => {
	const albums = [{ id: 'a', name: '2000 Kid A', year: null }, { id: 'c', name: '1997 OK Computer', year: null }]
	assert.deepStrictEqual(applyYear(albums, { yearMax: 1999 }).out.map(a => a.id), ['c'])
})

// ── the chip ─────────────────────────────────────────────────────────────────

test('the chip keeps the > sign — year:>1999, not year:1999', () => {
	assert.strictEqual(_filterChipLabel({ key: 'year', op: '>', value: 1999 }), 'year:>1999')
	assert.strictEqual(_filterChipLabel({ key: 'year', op: '<', value: 1999 }), 'year:<1999')
})

test('an "is" operator prints no sign, and a range prints its own', () => {
	assert.strictEqual(_filterChipLabel({ key: 'artist', op: 'is', value: 'Radiohead' }), 'artist:Radiohead')
	assert.strictEqual(_filterChipLabel({ key: 'year', op: 'range', value: '1970-1979' }), 'year:1970-1979')
})

test('the chip value goes through esc() — a < in it cannot open a tag', () => {
	// The label is escaped at the call site, so the label itself carries the
	// raw sign; what matters is that renderSearch escapes it.
	const chipLine = /filters\.operators\.map\(function\(op\)[^\n]*/.exec(SRC)[0]
	assert.ok(/esc\(_filterChipLabel\(op\)\)/.test(chipLine),
		'the chip label must be escaped before it reaches innerHTML: ' + chipLine)
	assert.ok(!/'\s*\+\s*op\.value/.test(chipLine),
		'op.value must never be interpolated raw: ' + chipLine)
})

test('the unknown-year count reaches the page', () => {
	assert.ok(/unknownYearKept \? .*with unknown year kept/.test(SRC),
		'the chip row must say how many albums were kept with no known year')
})
