'use strict'
// No top-level function may read a name that only exists inside another one.
//
// This has now cost two whole pages:
//   * _playOnArrival (10d4662) — video detail painted a grey skeleton for ever;
//   * _moodDef — the Library's empty state threw, so a no-match search showed
//     the entire unfiltered library and the next render killed the page.
// Both are the same mechanic. In sloppy mode an ASSIGNMENT to an undeclared
// name silently makes a global, so the code looks fine and even runs fine as
// long as the sibling function happens to have run first; a READ of a name
// that was never assigned throws ReferenceError. Inside an async renderer that
// throw is a blank page, not a message.
//
// Unit tests cannot see it — they call the function with everything already in
// scope. So this parses the real source and checks the scopes themselves.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const scan = require('../tools/scope-scan.js')

const SRC = path.join(__dirname, '..', 'src')
const FILES = ['renderer.js', 'video-player.js', 'player-shim.js']
	.filter(f => fs.existsSync(path.join(SRC, f)))

test('the scanner catches the shape that killed the video detail page', () => {
	// A miniature of the real thing: arm() declares the name as its own local,
	// consume() reads it from the top level. That read is a ReferenceError.
	const findings = scan.scanSource(`
		function arm() { var _playOnArrival = { episode: 9 }; return _playOnArrival }
		function consume() { const a = _playOnArrival; return a }
	`, 'fixture.js')
	assert.strictEqual(findings.length, 1, 'exactly one cross-function read')
	assert.strictEqual(findings[0].fn, 'consume')
	assert.strictEqual(findings[0].name, '_playOnArrival')
	assert.strictEqual(findings[0].owner, 'arm')
})

test('the scanner catches the shape that killed the Library page', () => {
	const findings = scan.scanSource(`
		function _libEmptyHtml() { if (_moodDef) return _moodDef.name; return 'empty' }
		function renderLibrary() { var _moodDef = moodById(state.libMood); return _moodDef }
	`, 'fixture.js')
	assert.deepStrictEqual(findings.map(f => f.fn + '/' + f.name), ['_libEmptyHtml/_moodDef'])
})

test('the scanner does not cry wolf', () => {
	// Genuine globals, shared top-level names, nested params, destructuring,
	// property keys and catch bindings are all fine and must stay quiet.
	const findings = scan.scanSource(`
		var shared = 1
		function a(items) {
			return items.map(function (x) { return x + shared })
		}
		function b() {
			try { document.title = 'x' } catch (err) { console.log(err) }
			const { name, ...rest } = window.thing
			const o = { name: name, rest: rest }
			press('id', true)
			function press(id, on) { return id + on }
			return o
		}
		function c() { var name = 2; return name }
	`, 'fixture.js')
	assert.deepStrictEqual(findings.map(scan.format), [])
})

test('the real renderer scripts have no cross-function scope reads', () => {
	const findings = []
	for (const f of FILES) findings.push(...scan.scanFile(path.join(SRC, f)))
	assert.deepStrictEqual(findings.map(scan.format), [],
		'each of these is a page that throws the moment that line runs')
})
