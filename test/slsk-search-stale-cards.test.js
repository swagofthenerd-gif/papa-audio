'use strict'
// Typing a new album left the PREVIOUS query's cards on screen, with no
// "searching" state, for as long as the spelling-correction lookup took --
// a network round trip with a six-second timeout. The old results read as the
// answer to the new question.
//
// runSlskSearch and the paint helper are lifted out of renderer.js and run
// against a stubbed correction that never settles, so the assertion is about
// what is on screen while the lookup is still in flight.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(decl) {
	const at = R.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in renderer.js')
	let i = R.indexOf('{', at)
	let depth = 1
	i++
	while (depth > 0 && i < R.length) {
		const c = R[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return R.slice(at, i)
}

const RUN_SEARCH = liftFn('async function runSlskSearch(query) {')
const BEGIN_PAINT = liftFn('function _slskBeginSearchPaint(query) {')

function start(prevQuery, prevResults) {
	const slsk = {
		lastQuery: prevQuery, results: prevResults, searching: false, searched: true,
		correction: null, noCorrectFor: null, status: { connected: true }, error: null,
	}
	const section = { innerHTML: '<div class="slsk-card">Kind of Blue</div>' }
	const env = { slsk, section }
	const started = new Function('env', `
		const { slsk, section } = env
		const state = { isOnline: true }
		let _slskRun = 0
		let _slskShowLimit = 0
		const SLSK_SHOW_STEP = 24
		let _slskTimer = null
		function _slskResetThrottleRetry() {}
		// The lookup the stale cards used to sit behind: never settles here.
		function _slskCorrectQuery() { return new Promise(() => {}) }
		function renderSoulseekRow(q) { return '<div class="slsk-searching">Searching… ' + q + '</div>' }
		function bindSlskSearchEvents() {}
		function refreshSlskStatus() { return Promise.resolve() }
		function _slskRepaint() {}
		function _buildSearchVariants(q) { return [q] }
		const document = { getElementById(id) { return id === 'slsk-section' ? section : null } }
		const window = { api: { slskCancelSearches() { return Promise.resolve() } } }
		${BEGIN_PAINT}
		${RUN_SEARCH}
		return runSlskSearch('a love supreme')
	`)(env)
	// Deliberately not awaited: the correction lookup never settles, which is
	// exactly the window the bug lived in.
	started.catch(() => {})
	return { slsk, section }
}

test('a new query clears the old cards before the correction lookup, not after', async () => {
	const { slsk } = start('kind of blue', [{ folderName: 'Kind of Blue' }, { folderName: 'Kind of Blue (1959)' }])
	await Promise.resolve()
	assert.deepStrictEqual(slsk.results, [],
		"the previous album's cards must be gone the moment the new search starts")
	assert.strictEqual(slsk.searching, true)
	assert.strictEqual(slsk.searched, false)
	assert.strictEqual(slsk.lastQuery, 'a love supreme')
})

test('the section says it is searching while the correction lookup is still out', async () => {
	const { section } = start('kind of blue', [{ folderName: 'Kind of Blue' }])
	await Promise.resolve()
	assert.ok(/Searching…/.test(section.innerHTML), section.innerHTML)
	assert.ok(!/slsk-card/.test(section.innerHTML),
		'no card from the previous query may still be painted: ' + section.innerHTML)
})
