'use strict'
// Three controls that lied about having nothing to do.
//
// #19: a filter that matched nothing on the Downloads tab fell through to the
// generic "No completed downloads / Finished downloads will appear here" --
// which is false when there ARE finished downloads and a filter is hiding
// them, and offered no way to clear it. "Stop All" sat enabled over an idle
// list and "Run all now" over an empty wishlist.
//
// #17: "Jump to Soulseek results" existed only in the no-local-results state,
// which is the one case where the lane was already on screen. With local hits
// the lane sat about 1,900px down with no affordance at all, and the jump
// scrolled without moving focus.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(decl) {
	const at = R.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in renderer.js')
	let i = at + decl.length
	let depth = 1
	while (depth > 0 && i < R.length) {
		const c = R[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return R.slice(at, i)
}

// ── the "clear the filter" way out ─────────────────────────────────────────
const BIND_CLEAR = liftFn('function _bindDlClearFilter(container) {')

function clearFilterRun() {
	const log = []
	const btn = {
		listeners: [],
		addEventListener(t, fn) { if (t === 'click') this.listeners.push(fn) },
		click() { for (const fn of this.listeners) fn.call(this) },
	}
	const input = { value: 'coltrane' }
	const env = { log, btn, input }
	const out = new Function('env', `
		const { log, btn, input } = env
		let _dlFilter = 'coltrane'
		let _dlLastSig = 'sig'
		const _dlLastFiles = [{ state: 'Completed, Succeeded' }]
		const container = { querySelector(sel) { return sel === '#dl2-clear-filter' ? btn : null } }
		const document = { getElementById(id) { return id === 'dl2-filter-input' ? input : null } }
		function _renderDlTab(files) { log.push('repaint:' + files.length) }
		${BIND_CLEAR}
		_bindDlClearFilter(container)
		btn.click()
		return { filter: _dlFilter, sig: _dlLastSig }
	`)(env)
	return { out, log, input }
}

test('clearing the filter empties it, resets the input and repaints', () => {
	const { out, log, input } = clearFilterRun()
	assert.strictEqual(out.filter, '')
	assert.strictEqual(input.value, '')
	assert.strictEqual(out.sig, '', 'the signature must be cleared or the repaint is skipped')
	assert.deepStrictEqual(log, ['repaint:1'])
})

test('a filtered-empty Downloads view says the filter did it, not that there is nothing', () => {
	const at = R.indexOf("_dlFilter && _dlFilter.trim() && _dlTab === 'completed'")
	assert.ok(at > -1, 'the empty state must distinguish "nothing here" from "the filter hid it"')
	const block = R.slice(at, at + 900)
	assert.ok(/No downloads match "\$\{esc\(_dlFilter\.trim\(\)\)\}"/.test(block), block.slice(0, 400))
	assert.ok(/id="dl2-clear-filter"/.test(block), 'and it must offer the way out')
})

test('the completed tab’s own filter-empty offers the same way out', () => {
	const at = R.indexOf('No albums match "${esc(filterQ)}"')
	assert.ok(at > -1)
	assert.ok(/id="dl2-clear-filter"/.test(R.slice(at, at + 300)))
	assert.ok(/_bindDlClearFilter\(container\)/.test(R.slice(at, at + 400)), 'and it must be wired')
})

test('Stop All is disabled when nothing is downloading', () => {
	const at = R.indexOf('var _anyActive =')
	assert.ok(at > -1, 'Stop All must be driven by whether anything is running')
	const block = R.slice(at, at + 500)
	assert.ok(/_dlCategory\(f\.state\) === 'active'/.test(block), block)
	assert.ok(/_anyActive \? '' : ' disabled title="Nothing is downloading right now"'/.test(block), block)
})

test('Run all now is disabled over an empty wishlist', () => {
	const at = R.indexOf("var runAll = document.getElementById('slsk-hub-wishlist-runall')")
	assert.ok(at > -1)
	const block = R.slice(at, at + 400)
	assert.ok(/runAll\.disabled = !wl\.length/.test(block), block)
	assert.ok(/Your wishlist is empty/.test(block), 'and it must say why')
})

// ── #17: the jump ──────────────────────────────────────────────────────────
const JUMP = liftFn('function _jumpToSlskLane() {')

function jumpRun(hasSection) {
	const sec = {
		attrs: {}, focused: 0, scrolled: null,
		hasAttribute(a) { return a in this.attrs },
		setAttribute(a, v) { this.attrs[a] = v },
		scrollIntoView(o) { this.scrolled = o },
		focus() { this.focused++ },
	}
	const env = { sec: hasSection ? sec : null }
	new Function('env', `
		const document = { getElementById() { return env.sec } }
		${JUMP}
		_jumpToSlskLane()
	`)(env)
	return sec
}

test('the jump scrolls the Soulseek lane into view and takes focus with it', () => {
	const sec = jumpRun(true)
	assert.deepStrictEqual(sec.scrolled, { behavior: 'smooth', block: 'start' })
	assert.strictEqual(sec.attrs.tabindex, '-1', 'a section cannot take focus without this')
	assert.strictEqual(sec.focused, 1, 'scrolling alone leaves the next Tab back at the top of the page')
})

test('the jump does nothing at all when there is no lane', () => {
	assert.doesNotThrow(() => jumpRun(false))
})

test('the jump is offered whenever there is a query, not only when nothing matched locally', () => {
	assert.ok(/id="search-jump-slsk"/.test(R), 'the always-on affordance must exist')
	// It sits in the `${query ? ...}` row, so it is there whenever a search ran.
	const at = R.indexOf("id=\"search-jump-slsk\"")
	const before = R.slice(Math.max(0, at - 1200), at)
	assert.ok(/\$\{query \?/.test(before), 'it must be in the query row, not the empty state')
})

test('both jump buttons run the same handler', () => {
	assert.ok(/getElementById\('search-empty-slsk-btn'\)\?\.addEventListener\('click', _jumpToSlskLane\)/.test(R))
	assert.ok(/getElementById\('search-jump-slsk'\)\?\.addEventListener\('click', _jumpToSlskLane\)/.test(R))
})
