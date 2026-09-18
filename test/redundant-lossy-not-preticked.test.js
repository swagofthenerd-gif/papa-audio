'use strict'
// The "Redundant lossy copies" list must arrive with nothing ticked.
//
// It shipped every box `checked`, directly above a red "Move selected to
// Trash…" button — and directly BELOW the Upgrades panel, which says in plain
// words "Nothing is selected for you." Two lists proposing the same kind of
// deletion, side by side, disagreeing about whether they had already decided
// for him. One click on the red button and every one of those albums was gone.
//
// The finder is good but it is not infallible: it matches on artist and album
// title, so a lossy copy with a different mastering, a different edit, or a
// bonus track the lossless rip does not have is still "redundant" to it. The
// cost of a false positive is a recording he may never find again; the cost of
// a false negative is that he ticks a box. So the default has to be "nothing
// happens". Same rationale as test/upgrade-dupes-wiring.test.js.
//
// _mgStorageHtml lives in renderer.js, a browser script with no exports, so the
// real function is lifted and run against the real matcher modules.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const Redundant = require('../src/manage-redundant.js')
const Shelves = require('../src/slsk-shelves.js')
const Upgrades = require('../src/upgrade-dupes.js')

function lift(name) {
	const start = src.indexOf('function ' + name + '(')
	assert.ok(start > -1, name + ' must still exist in renderer.js')
	const end = src.indexOf('\nfunction ', start + 1)
	const alt = src.indexOf('\nasync function ', start + 1)
	const stop = [end, alt].filter(n => n > -1).sort((a, b) => a - b)[0]
	return src.slice(start, stop === undefined ? undefined : stop)
}

function build(library) {
	const state = { library }
	const _mgState = {}
	const win = { PapaManageRedundant: Redundant, PapaSlskShelves: Shelves }
	const fn = new Function('state', '_mgState', 'window', 'console', `
		function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
		function _mgFmt(n) { return String(n) + ' B' }
		function _mgFormatBar() { return '' }
		function _mgUpgradeDupesHtml() { return '' }
		${lift('_mgStorageHtml')}
		return _mgStorageHtml(null)
	`)
	return { html: fn(state, _mgState, win, { error() {}, warn() {} }), _mgState }
}

function flac(p, title) {
	return { filePath: p, title, codec: 'flac', bitDepth: 16, sampleRate: 44100, duration: 200, size: 30e6 }
}
function mp3(p, title) {
	return { filePath: p, title, codec: 'mp3', bitrate: 320000, duration: 200, size: 5e6 }
}

// One album he owns twice: an MP3 rip and a FLAC rip. Exactly what the panel is
// for, and exactly the case where a wrong guess costs him something.
const bothCopies = [
	{ id: 'a1', name: 'Kid A', artist: 'Radiohead', tracks: [mp3('/m/mp3/Kid A/01.mp3', 'Everything In Its Right Place')] },
	{ id: 'a2', name: 'Kid A', artist: 'Radiohead', tracks: [flac('/m/flac/Kid A/01.flac', 'Everything In Its Right Place')] },
]

test('the panel appears when there really is a redundant copy', () => {
	const { html, _mgState } = build(bothCopies)
	assert.ok(_mgState.redundant.pairs.length > 0, 'the fixture must actually produce a pair')
	assert.match(html, /Redundant lossy copies/)
	assert.match(html, /mg-red-check/, 'with a checkbox to tick')
	assert.match(html, /mg-red-trash/, 'and the Trash button it feeds')
})

test('and NOTHING in it is ticked', () => {
	const { html } = build(bothCopies)
	const boxes = html.match(/<input[^>]*class="mg-red-check"[^>]*>/g) || []
	assert.ok(boxes.length > 0, 'there must be boxes to check')
	for (const b of boxes) {
		assert.doesNotMatch(b, /\bchecked\b/,
			'a list that proposes deleting his music must not preselect anything — ' +
			'one click on the red button below it and they are all gone')
	}
})

test('the panel says so in words, not just in markup', () => {
	const { html } = build(bothCopies)
	const section = html.slice(html.indexOf('Redundant lossy copies'))
	assert.match(section, /Nothing is selected for you/i,
		'the same promise the Upgrades panel right below it makes')
	assert.match(section, /Trash, not deleted/i, 'and that removal is recoverable')
})

test('the two deletion panels make the user the same promise', () => {
	// They sit one above the other on the same page. Disagreeing about whether
	// anything is preselected is worse than either default on its own, so this
	// renders BOTH for real and checks every box in the pair.
	const state = { library: bothCopies }
	const _mgState = {}
	const win = { PapaManageRedundant: Redundant, PapaSlskShelves: Shelves, PapaUpgradeDupes: Upgrades }
	const fn = new Function('state', '_mgState', 'window', 'console', `
		function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
		function _mgFmt(n) { return String(n) + ' B' }
		function _mgFormatBar() { return '' }
		${lift('_mgUpgradeDupesHtml')}
		${lift('_mgStorageHtml')}
		return _mgStorageHtml(null)
	`)
	const html = fn(state, _mgState, win, { error() {}, warn() {} })
	assert.ok(_mgState.redundant.pairs.length > 0, 'the redundant panel is on the page')
	assert.ok(_mgState.upgrades && _mgState.upgrades.plan.length > 0, 'and so is the upgrades panel')
	const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) || []
	assert.ok(boxes.length >= 2, 'both panels contributed boxes')
	for (const b of boxes) {
		assert.doesNotMatch(b, /\bchecked\b/,
			'nothing on a page whose buttons delete music may be ticked in advance')
	}
})

test('with only one copy of an album, no panel at all', () => {
	const { html, _mgState } = build([bothCopies[1]])
	assert.strictEqual(_mgState.redundant.pairs.length, 0)
	assert.doesNotMatch(html, /Redundant lossy copies/)
})

test('an empty selection cannot reach the trash path', () => {
	// The Trash handler already refuses an empty selection; with nothing ticked
	// that is now the state the panel opens in, so it has to hold.
	const body = lift('_mgTrashRedundant')
	assert.match(body, /\.mg-red-check:checked/, 'it reads only ticked boxes')
	assert.match(body, /if \(!chosen\.length\)/, 'and refuses when none are ticked')
})
