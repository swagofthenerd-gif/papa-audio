'use strict'
// The Soulseek shop opened with focus still on whatever had opened it, so Tab
// walked the page behind the modal and the folder rows -- plain divs with a
// click listener -- could not be reached by keyboard at all. Closing dropped
// focus to <body>, so Tab restarted from the top of the page. The album view
// declared role="dialog" and then never took focus.
//
// Alongside that: the expand toggles never said whether they were expanded,
// the filter chips were buttons with no pressed state, the sort select had no
// label, and the Downloads strip declared role="tab" while answering to
// nothing but a click.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SHOP = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')
const AV = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-album-view.js'), 'utf8')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(src, decl) {
	const at = src.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist')
	let i = at + decl.length
	let depth = 1
	while (depth > 0 && i < src.length) {
		const c = src[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return src.slice(at, i)
}

// ── the folder row's keyboard activation ───────────────────────────────────
const BIND_DIR_KEYS = lift(SHOP, 'function bindDirKeys(r, open) {')

function row() {
	const n = {
		listeners: {},
		addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
	}
	return n
}

function press(r, key, target) {
	const e = {
		key, target: target || r, prevented: false,
		preventDefault() { this.prevented = true },
	}
	for (const fn of r.listeners.keydown || []) fn(e)
	return e
}

function wire(r, opened) {
	new Function('r', 'open', BIND_DIR_KEYS + '\nbindDirKeys(r, open)')(r, () => opened.push(1))
}

test('Enter opens a folder row, the same as a click', () => {
	const r = row(); const opened = []
	wire(r, opened)
	const e = press(r, 'Enter')
	assert.strictEqual(opened.length, 1)
	assert.strictEqual(e.prevented, true)
})

test('Space opens a folder row too, and does not scroll the list', () => {
	const r = row(); const opened = []
	wire(r, opened)
	assert.strictEqual(press(r, ' ').prevented, true)
	assert.strictEqual(opened.length, 1)
})

test('a key pressed inside a button in the row does not also open the folder', () => {
	const r = row(); const opened = []
	wire(r, opened)
	press(r, 'Enter', { some: 'inner button' })
	assert.strictEqual(opened.length, 0, 'the per-folder search button must not navigate')
})

test('other keys are left alone', () => {
	const r = row(); const opened = []
	wire(r, opened)
	for (const k of ['a', 'Tab', 'ArrowDown', 'Escape']) assert.strictEqual(press(r, k).prevented, false)
	assert.strictEqual(opened.length, 0)
})

// ── the markup and the wiring the focus pass added ─────────────────────────
test('folder rows are tab stops that announce themselves', () => {
	const dirRows = SHOP.match(/class="slskx-row slskx-dir"[^>]*/g) || []
	assert.strictEqual(dirRows.length, 3, 'all three folder-row shapes must be covered')
	for (const r of dirRows) {
		assert.ok(/tabindex="0"/.test(r), 'unreachable by Tab: ' + r)
		assert.ok(/role="button"/.test(r), 'not announced as a control: ' + r)
		assert.ok(/aria-label="Open folder/.test(r), 'unnamed: ' + r)
	}
})

test('the shop takes focus when it opens, in both modes', () => {
	assert.ok(/if \(mode === 'folders'\) search\.focus\(\)\s*\n\s*else \(dlg\.querySelector\('#slsk-lib-close'\) \|\| dlg\)\.focus\(\)/.test(SHOP),
		'shelves mode used to leave focus on the opener behind the modal')
})

test('focus enters the modal when it is mounted, not after the browse', () => {
	// Verified on a twin: with no credentials the browse returns early, so the
	// post-browse focus line never ran and the error state sat there with focus
	// on the opener behind the overlay.
	const mount = SHOP.indexOf('document.body.appendChild(dlg)')
	assert.ok(mount > -1)
	const after = SHOP.slice(mount, mount + 600)
	assert.ok(/\(dlg\.querySelector\('#slsk-lib-close'\) \|\| dlg\)\.focus\(/.test(after), after.slice(0, 400))
	// And it must come before the browse call, not after it.
	assert.ok(mount < SHOP.indexOf('await window.api.slskBrowseBegin'))
})

test('closing the shop gives focus back to whatever opened it', () => {
	assert.ok(/const opener = document\.activeElement/.test(SHOP))
	assert.ok(/opener && opener\.isConnected && typeof opener\.focus === 'function'/.test(SHOP))
})

test('the album view is a dialog that actually takes and returns focus', () => {
	assert.ok(/panel\.setAttribute\('aria-modal', 'true'\)/.test(AV))
	assert.ok(/panel\.setAttribute\('tabindex', '-1'\)/.test(AV))
	assert.ok(/const slavOpener = document\.activeElement/.test(AV))
	assert.ok(/firstStop\.focus/.test(AV), 'the panel must take focus when it opens')
	assert.ok(/slavOpener && slavOpener\.isConnected/.test(AV), 'and hand it back on close')
})

// ── the smaller a11y gaps ──────────────────────────────────────────────────
test('the expand toggles say whether they are expanded, and what they control', () => {
	assert.ok(/slsk-sources-btn[\s\S]{0,180}aria-expanded="false" aria-controls="slsk-src-\$\{gi\}"/.test(R))
	assert.ok(/slsk-expand-btn[\s\S]{0,180}aria-expanded="false" aria-controls="slsk-tl-\$\{gi\}"/.test(R))
	// And the state is kept true when they are toggled.
	const toggles = R.match(/style\.display = open \? 'none' : 'block'\n\s*btn\.setAttribute\('aria-expanded'/g) || []
	assert.strictEqual(toggles.length, 2, 'both toggles must update aria-expanded')
})

test('the filter chips have a pressed state and a readable name', () => {
	assert.ok(/aria-pressed="\$\{slsk\.filter === k \? 'true' : 'false'\}"/.test(R))
	assert.ok(/aria-label="\$\{label\}, \$\{n\} source/.test(R))
})

test('the sort control is named', () => {
	assert.ok(/id="slsk-sort" aria-label="Sort the Soulseek results"/.test(R))
})

test('the glyph-only header buttons are named, not just tooltipped', () => {
	assert.ok(/id="slsk-saved-btn"[^>]*aria-label="Saved libraries"/.test(R))
	assert.ok(/id="slsk-retry-btn" title="Search again" aria-label="Search again"/.test(R))
})

test('a result card is announced as a named group', () => {
	assert.ok(/class="slsk-card" data-gi="\$\{gi\}" role="group" aria-label=/.test(R))
})

test('the Downloads tab strip answers to the arrow keys its role promises', () => {
	assert.ok(/_bindTablist\(document\.getElementById\('dl2-tabs'\)\)/.test(R))
})

test('the Surround finder reports that it is on', () => {
	assert.ok(/id="slskx-surround"[\s\S]{0,140}aria-pressed="false"/.test(SHOP), 'initial state')
	assert.ok(/setAttribute\('aria-pressed', surroundOnly \? 'true' : 'false'\)/.test(SHOP), 'and on toggle')
})

// ── The close-focus restore, run for real ──────────────────────────────────
// The source guards above proved the two lines existed; they could not see
// that the capture ran AFTER the dialog had already moved focus to the close
// button. `opener` was therefore always that button, the button is removed
// with the dialog, and the isConnected guard skipped the restore -- focus fell
// to <body>. These drive the shipped show() against a small DOM.

function makeShopDom() {
	const docListeners = {}
	function Stub(sel) {
		return {
			_sel: sel, value: '', textContent: '', innerHTML: '', disabled: false,
			focused: 0, isConnected: true, dataset: {}, style: {},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
			_l: {},
			addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn) },
			removeEventListener() {},
			setAttribute() {}, getAttribute: () => null, scrollIntoView() {},
			focus() { this.focused++; document.activeElement = this },
			click() {}, blur() {},
			querySelector: () => null, querySelectorAll: () => [],
			appendChild(c) { return c }, remove() { this.isConnected = false },
			getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
		}
	}
	function El(tag) {
		const stubs = new Map()
		return {
			tagName: tag, id: '', className: '', innerHTML: '', isConnected: false,
			style: {}, dataset: {},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
			_stubs: stubs, _l: {},
			querySelector(sel) {
				if (!stubs.has(sel)) stubs.set(sel, Stub(sel))
				return stubs.get(sel)
			},
			querySelectorAll() { return [] },
			addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn) },
			removeEventListener() {},
			setAttribute() {}, getAttribute: () => null,
			focus() { document.activeElement = this },
			appendChild(c) { return c },
			remove() {
				this.isConnected = false
				const i = document.body.children.indexOf(this)
				if (i > -1) document.body.children.splice(i, 1)
			},
		}
	}
	const document = {
		activeElement: null,
		body: {
			children: [],
			appendChild(el) { el.isConnected = true; this.children.push(el); return el },
			classList: { add() {}, remove() {}, toggle() {} },
		},
		createElement: (tag) => El(tag),
		getElementById(id) { return document.body.children.find(c => c.id === id) || null },
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn) },
		removeEventListener(t, fn) {
			const a = docListeners[t] || []
			const i = a.indexOf(fn)
			if (i > -1) a.splice(i, 1)
		},
		_fire(t, ev) { for (const fn of (docListeners[t] || []).slice()) fn(ev) },
	}
	return document
}

// A button on the page behind the modal: the thing that opened the shop.
function openerButton(document) {
	return {
		tagName: 'BUTTON', isConnected: true, focused: 0,
		focus() { this.focused++; document.activeElement = this },
	}
}

function runShop(source) {
	const vm = require('vm')
	const document = makeShopDom()
	const opener = openerButton(document)
	document.activeElement = opener
	const ctx = {
		console: { log() {}, warn() {}, error() {}, debug() {} },
		document,
		module: { exports: {} },
		setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
		requestAnimationFrame(fn) { fn() },
		Promise, Set, Map, Array, Object, String, Number, Boolean, Math, JSON, Date,
		RegExp, Error, parseInt, parseFloat, isNaN, isFinite, Intl,
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		IntersectionObserver: function () {
			return { observe() {}, unobserve() {}, disconnect() {} }
		},
		window: {
			PapaSlskTree: {
				NavHistory: function () {
					this.current = ''
					this.back = () => {}
					this.forward = () => {}
					this.go = () => {}
				},
				parentPath: () => '',
				buildTree: () => null,
			},
			PapaSlskShelves: null,
			PapaSlskAlbumView: null,
			// Every bridge call parks forever: the test drives only the
			// synchronous open path and then closes, so nothing must resolve
			// into a torn-down DOM after the assertions.
			api: new Proxy({}, {
				get: (_t, prop) => (prop === 'onSlskBrowseRefreshed' ? undefined
					: () => new Promise(() => {})),
				has: () => true,
			}),
		},
	}
	ctx.globalThis = ctx
	vm.createContext(ctx)
	vm.runInContext(source, ctx, { filename: 'src/slsk-shop-ui.js' })
	const deps = {
		_mgConfirm: () => Promise.resolve(false),
		_scheduleLibRescan() {}, _slskCardDownloads: () => [], _slskCardKey: () => '',
		_slskCardProgress: () => null, _slskDirQuality: () => '',
		_slskEnqueue: () => Promise.resolve({ ok: true }),
		esc: s => String(s == null ? '' : s),
		hideContextMenu() {}, navigate() {}, openSlskChat() {},
		playCurrentTrack() {}, showSnackbar() {}, slsk: { status: {} },
		startPreview() {}, state: {},
	}
	ctx.module.exports.show('sherrybaaz', deps)
	return { document, opener }
}

test('closing the shop puts focus back on the button that opened it', () => {
	const h = runShop(SHOP)
	assert.strictEqual(h.document.body.children.length, 1, 'the shop opened')
	assert.notStrictEqual(h.document.activeElement, h.opener,
		'focus moves into the modal on open')
	h.document._fire('keydown', { key: 'Escape', target: {}, preventDefault() {} })
	assert.strictEqual(h.document.body.children.length, 0, 'Escape closed it')
	assert.strictEqual(h.document.activeElement, h.opener,
		'focus used to drop to <body> here')
	assert.ok(h.opener.focused > 0)
})

test('MUTATION: capturing the opener after the dialog is focused breaks it again', () => {
	const CAPTURE = `  // Focus came from somewhere and has to go back there when the shop closes.`
	const at = SHOP.indexOf(CAPTURE)
	assert.ok(at > -1, 'the capture comment must still mark the spot')
	const line = '  const opener = document.activeElement\n'
	// Move the capture back below the append+focus, where it used to live.
	let broken = SHOP.replace(line, '')
	broken = broken.replace('  const close = () => {', line + '\n  const close = () => {')
	assert.notStrictEqual(broken, SHOP, 'the mutation applied')
	const h = runShop(broken)
	h.document._fire('keydown', { key: 'Escape', target: {}, preventDefault() {} })
	assert.notStrictEqual(h.document.activeElement, h.opener,
		'this is the reported bug: the close button was the captured opener')
})
