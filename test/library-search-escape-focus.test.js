'use strict'
// D8 — Escape cleared the Library search box and threw the keyboard away.
//
// renderLibrary() calls setContent(), which replaces the whole page — the
// #lib-search input this handler is bound to is gone by the time the handler
// returns, and focus lands on <body>. The box looked cleared and ready, but the
// next keystroke went nowhere. The input debounce a few lines above already
// carried focus across the same repaint; Escape did not.
//
// The real keydown handler is lifted out of renderLibrary's wiring and run
// against a DOM that replaces the input on repaint, exactly as setContent does.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The Escape/Enter handler, verbatim.
function keydownBody() {
	const open = SRC.indexOf("    libSearch.addEventListener('keydown', function (e) {")
	assert.ok(open > -1, "the library search box's keydown handler must still exist")
	const bodyStart = SRC.indexOf('{', SRC.indexOf('function (e) {', open)) + 1
	let depth = 1
	let i = bodyStart
	while (depth > 0 && i < SRC.length) {
		const c = SRC[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return SRC.slice(bodyStart, i - 1)
}

// A page where renderLibrary() throws the input away and builds a new one —
// the behaviour that makes this a bug at all.
function makePage() {
	let input = null
	const doc = { activeElement: null }
	const newInput = value => {
		const el = {
			id: 'lib-search', value, focused: 0, blurred: 0, caret: null,
			focus() { this.focused++; doc.activeElement = this },
			blur() { this.blurred++; doc.activeElement = null },
			setSelectionRange(a) { this.caret = a },
		}
		return el
	}
	input = newInput('radiohead')
	doc.activeElement = input
	doc.getElementById = id => (id === 'lib-search' ? input : null)

	const remembered = []
	const ctx = {
		document: doc, console, String, Math,
		state: { libSearch: 'radiohead', _libNoCorrect: 'x' },
		searchTimeout: 0,
		clearTimeout() {},
		_rememberSearch: q => remembered.push(q),
		renderLibrary() {
			// setContent(): the old input is detached and a fresh one takes its
			// place, with nothing focused.
			input = newInput('')
			doc.activeElement = null
			ctx.repaints++
		},
		repaints: 0,
	}
	vm.createContext(ctx)
	vm.runInContext('var __key = function (e) {' + keydownBody() + '}', ctx)
	return {
		ctx, doc, remembered,
		press(key, self) {
			const target = self || input
			ctx.__key.call(target, { key })
		},
		get input() { return input },
	}
}

test('Escape clears the box', () => {
	const p = makePage()
	p.press('Escape')
	assert.strictEqual(p.ctx.repaints, 1, 'the page re-rendered')
	assert.strictEqual(p.ctx.state.libSearch, '')
})

test('and the keyboard stays in the box across the repaint', () => {
	const p = makePage()
	p.press('Escape')
	assert.strictEqual(p.doc.activeElement, p.input,
		'focus used to land on <body>: the box looked ready and swallowed the next keystroke')
	assert.strictEqual(p.input.focused, 1)
})

test('the caret is put at the start of the now-empty box', () => {
	const p = makePage()
	p.press('Escape')
	assert.strictEqual(p.input.caret, 0)
})

test('Escape on an ALREADY empty box blurs instead — the way out of the field', () => {
	const p = makePage()
	p.input.value = ''
	p.press('Escape')
	assert.strictEqual(p.ctx.repaints, 0, 'nothing to clear, so nothing to repaint')
	assert.strictEqual(p.doc.activeElement, null)
})

test('Enter still commits the query and does not clear or repaint', () => {
	const p = makePage()
	p.press('Enter')
	assert.deepStrictEqual(p.remembered, ['radiohead'])
	assert.strictEqual(p.ctx.repaints, 0)
})
