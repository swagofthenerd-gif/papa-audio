'use strict'
// Two dialogs that were never given a dialog's obligations.
//
// D2 — "Recent notices" (#notice-history-modal, opened from the notice badge)
// had no role="dialog"/aria-modal, no focus trap, never moved focus in, and was
// not registered with the nav-dismiss set: a screen reader never heard it open,
// Tab walked straight out into the page behind it, and Ctrl+1 left it floating
// over Home.
//
// D5 — "Import playlist from text" (#import-pl-modal) had the nav dismisser but
// no dialog role and no Escape: the only way out was the mouse.
//
// Both builders run for real here, with the REAL _trapFocus, against a DOM
// small enough to assert focus on.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(source, name) {
	const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(source)
	assert.ok(m, name + ' not found in the renderer')
	const start = m.index + 1
	const end = source.indexOf('\n}\n', start)
	assert.ok(end > start, name + ' has no closing brace')
	return source.slice(start, end + 2)
}

function slice(source, from, to) {
	const a = source.indexOf(from)
	const b = source.indexOf(to, a)
	assert.ok(a > -1 && b > a, 'slice ' + from + ' .. ' + to + ' not found')
	return source.slice(a, b)
}

// ── A DOM with real attributes and real focus ────────────────────────────────
function makeDom() {
	const listeners = {}
	let document

	function Node(tag) {
		return {
			tagName: tag, id: '', className: '', innerHTML: '', isConnected: false,
			_attrs: {}, _l: {}, _kids: [],
			offsetWidth: 10, offsetHeight: 10, disabled: false, value: '',
			style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
			focused: 0,
			setAttribute(k, v) { this._attrs[k] = String(v) },
			getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null },
			focus() { this.focused++; document.activeElement = this },
			addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn) },
			removeEventListener(t, fn) {
				const a = this._l[t] || []; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1)
			},
			fire(t, ev) { for (const fn of (this._l[t] || []).slice()) fn(ev || {}) },
			contains(el) { return el === this || this._kids.indexOf(el) > -1 },
			// The dialogs build their contents as an innerHTML string, so the
			// focusables are derived from the ids that string actually contains.
			querySelectorAll() {
				const ids = (String(this.innerHTML).match(/id="([^"]+)"/g) || [])
					.map(m => m.slice(4, -1))
				const kids = ids.map(id => this.querySelector('#' + id))
				return kids
			},
			querySelector(sel) {
				if (!this._stubs) this._stubs = new Map()
				if (!String(this.innerHTML).includes(sel.replace('#', 'id="') + '"')) {
					// Only hand back an element the markup really declares.
					if (!this._stubs.has(sel)) return null
				}
				if (!this._stubs.has(sel)) {
					const k = Node('BUTTON')
					k._sel = sel
					k.id = sel.replace('#', '')
					this._stubs.set(sel, k)
					this._kids.push(k)
				}
				return this._stubs.get(sel)
			},
			remove() {
				this.isConnected = false
				const i = document.body.children.indexOf(this)
				if (i > -1) document.body.children.splice(i, 1)
			},
		}
	}

	document = {
		activeElement: null,
		body: {
			children: [],
			appendChild(el) { el.isConnected = true; this.children.push(el); return el },
			classList: { toggle() {} },
		},
		createElement: tag => Node(tag),
		getElementById(id) { return document.body.children.find(c => c.id === id) || null },
		querySelector: () => null,
		querySelectorAll: () => [],
		contains(el) { return !!(el && el.isConnected) },
		addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
		removeEventListener(t, fn) {
			const a = listeners[t] || []; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1)
		},
		_fire(t, ev) { for (const fn of (listeners[t] || []).slice()) fn(ev) },
		_count(t) { return (listeners[t] || []).length },
	}
	return document
}

const PAGES = ['home', 'library', 'playlists']
function harness(source) {
	const document = makeDom()
	const ctx = {
		console: { log() {}, warn() {}, error() {} },
		document, Map, Set, Array, Object, String, Number, Date, JSON, Math, RegExp,
		state: { currentPage: 'playlists', library: [], playlists: [], playlistFolders: [], smartPlaylists: [] },
		_scrollMemory: new Map(),
		window: {
			PapaJourney: null,
			PapaMusicTools: { parseImportLines: () => [], buildLibraryIndex: () => ({}), matchImportedTracks: () => ({ matched: [], missed: [] }) },
			api: { saveSessionState() {} },
		},
		requestAnimationFrame(fn) { fn() },
		setTimeout() { return 0 }, clearTimeout() {},
		esc: s => String(s == null ? '' : s),
		showSnackbar() {}, _restoreScrollTop() {}, _renderFailure() {}, _stopInlineTrailer() {},
		updateNavBtns() {}, _journeyCrumbUpdate() {}, hideContextMenu() {},
		_allLibraryTracks: () => [],
		updateNoticeBadge() {}, retuneDownloadsPolling() {}, _dlLastSig: '',
		pushUndo() {}, refreshSlskStatus: async () => {},
		_noticeHistory: [{ at: 1700000000000, text: 'slskd went away' }],
		_noticesSeen: 0,
	}
	for (const p of PAGES) ctx['render' + p[0].toUpperCase() + p.slice(1)] = function () {}
	ctx.renderHome = function () {}; ctx.renderLibrary = function () {}; ctx.renderPlaylists = function () {}
	ctx.globalThis = ctx
	vm.createContext(ctx)
	vm.runInContext([
		slice(source, 'const NAV_HISTORY_CAP', '// ── Overlay dismissal on navigation'),
		slice(source, '// ── Overlay dismissal on navigation', 'let _playCountTimer'),
		'const SCROLL_MEMORY_CAP = 200',
		slice(source, 'const VIDEO_PAGES = new Set(', '\nfunction navigate('),
		lift(source, 'navigate'),
		lift(source, '_currentNavId'),
		lift(source, '_focusables'),
		lift(source, '_trapFocus'),
		lift(source, 'showNoticeHistory'),
		lift(source, 'showImportPlaylistDialog'),
	].join('\n'), ctx)
	return { ctx, document, overlays: () => document.body.children.map(c => c.id) }
}

// The thing that opened the dialog — a control on the page behind it.
function opener(document) {
	return {
		tagName: 'BUTTON', isConnected: true, focused: 0,
		focus() { this.focused++; document.activeElement = this },
	}
}

const DIALOGS = {
	'Recent notices': { id: 'notice-history-modal', open: c => c.showNoticeHistory() },
	'Import playlist from text': { id: 'import-pl-modal', open: c => c.showImportPlaylistDialog() },
}

for (const [name, d] of Object.entries(DIALOGS)) {
	test(`${name}: announces itself as a modal dialog`, () => {
		const h = harness(SRC)
		d.open(h.ctx)
		const dlg = h.document.getElementById(d.id)
		assert.ok(dlg, 'it opened')
		assert.strictEqual(dlg.getAttribute('role'), 'dialog',
			'a screen reader never heard this open')
		assert.strictEqual(dlg.getAttribute('aria-modal'), 'true')
		const labelled = dlg.getAttribute('aria-labelledby')
		assert.ok(labelled, 'the dialog must name itself')
		assert.ok(String(dlg.innerHTML).includes('id="' + labelled + '"'),
			'aria-labelledby must point at an element that exists: ' + labelled)
	})

	test(`${name}: moves focus into the dialog`, () => {
		const h = harness(SRC)
		const op = opener(h.document)
		op.focus()
		d.open(h.ctx)
		const dlg = h.document.getElementById(d.id)
		assert.notStrictEqual(h.document.activeElement, op,
			'focus used to stay on the control behind the overlay')
		assert.ok(dlg.contains(h.document.activeElement),
			'focus must land inside the dialog')
	})

	test(`${name}: Escape closes it and hands focus back to the opener`, () => {
		const h = harness(SRC)
		const op = opener(h.document)
		op.focus()
		d.open(h.ctx)
		let prevented = 0
		h.document._fire('keydown', { key: 'Escape', preventDefault() { prevented++ } })
		assert.deepStrictEqual(h.overlays(), [], 'Escape must close it')
		assert.strictEqual(prevented, 1)
		assert.strictEqual(h.document.activeElement, op, 'focus must go back where it came from')
	})

	test(`${name}: navigating away closes it`, () => {
		const h = harness(SRC)
		d.open(h.ctx)
		assert.strictEqual(h.document.body.children.length, 1)
		h.ctx.navigate('home')
		assert.deepStrictEqual(h.overlays(), [],
			'Ctrl+1 used to leave it floating over Home')
	})

	test(`${name}: its key listener comes off with it`, () => {
		const h = harness(SRC)
		const before = h.document._count('keydown')
		d.open(h.ctx)
		assert.strictEqual(h.document._count('keydown'), before + 1)
		h.ctx.navigate('home')
		assert.strictEqual(h.document._count('keydown'), before,
			'a navigation-closed dialog must not leave its key handler behind')
	})

	test(`${name}: traps Tab inside itself`, () => {
		const h = harness(SRC)
		d.open(h.ctx)
		const dlg = h.document.getElementById(d.id)
		const items = h.ctx._focusables(dlg)
		assert.ok(items.length > 0, 'the dialog must have something focusable')
		// Tab from the last control wraps to the first instead of escaping.
		items[items.length - 1].focus()
		let prevented = 0
		dlg.fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented++ } })
		assert.strictEqual(prevented, 1, 'Tab used to walk out of the dialog')
		assert.strictEqual(h.document.activeElement, items[0])
	})

	test(`${name}: opening it twice leaves exactly one`, () => {
		const h = harness(SRC)
		d.open(h.ctx)
		d.open(h.ctx)
		assert.ok(h.document.body.children.length <= 1,
			'a second open must toggle or focus, never stack')
	})

	test(`${name}: reopening after a navigation still works`, () => {
		const h = harness(SRC)
		d.open(h.ctx)
		h.ctx.navigate('home')
		d.open(h.ctx)
		assert.strictEqual(h.document.body.children.length, 1)
		h.ctx.navigate('library')
		assert.deepStrictEqual(h.overlays(), [])
	})
}

test('the notice badge still toggles: a second click closes it', () => {
	const h = harness(SRC)
	h.ctx.showNoticeHistory()
	assert.strictEqual(h.document.body.children.length, 1)
	h.ctx.showNoticeHistory()
	assert.deepStrictEqual(h.overlays(), [], 'clicking the badge again must close it')
	// And the toggle-close must clean up like any other close.
	assert.strictEqual(h.document._count('keydown'), 0)
})
