'use strict';
// One click on a list's Delete wiped it: no "really?", no undo.
//
// The diary page rebuilds itself by writing #tp-body.innerHTML and then calling
// panel.mount(body). innerHTML replaces that element's *children*; it does not
// replace the element. The delegated click/submit/keydown listeners mount()
// attaches live on #tp-body itself, and renderDiary() creates #tp-body exactly
// once, so every rebuild left the previous rebuild's listeners in place.
//
// That becomes data loss because every mutation routes back through the
// rebuild: one click is delivered to all N listeners, each of them dispatches,
// each dispatch re-renders and mounts again — so N doubles per interaction
// (1, 2, 4, 8, 16). Destructive actions are arm-then-commit against a single
// module-level `armed` flag, so at two listeners the first click arms and the
// second commits within that same click. Lists get no Undo either: the page
// only offers one for 'diary-delete'.
//
// The sibling call site, _renderTasteSection, mounts on #vtaste-inner, which it
// re-creates on every paint — so it leaks nothing, and this was a slip rather
// than the house style.
//
// The real renderer block is lifted and run against the real panel and the real
// store. A copy of either would stop telling the truth the moment the original
// changed.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { createTastePanel, esc } = require(path.join(__dirname, '..', 'src', 'taste-panel.js'))
const { createTasteStore, _memoryStorage } = require(path.join(__dirname, '..', 'src', 'taste-store.js'))

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The whole diary-page block rather than one function: the page keeps its view
// state in module-level vars sitting beside those functions, and the handle to
// the previous mount has to live there too.
function liftDiaryBlock() {
	const start = src.indexOf('var _diaryYear = null')
	assert.ok(start > -1, 'the diary page must still hold its view state in renderer.js')
	const end = src.indexOf('// The unified chronological timeline', start)
	assert.ok(end > start, 'the diary block must still end before the timeline section')
	return src.slice(start, end)
}

// ── just enough of an element ───────────────────────────────────────────────
// The one behaviour that matters: assigning innerHTML drops the children and
// keeps the element, its identity and its listeners — which is exactly what a
// browser does, and exactly why the handlers survived.
function el(tag, attrs) {
	return {
		tagName: String(tag).toUpperCase(),
		_attrs: Object.assign({}, attrs || {}),
		_html: '',
		children: [],
		parentElement: null,
		listeners: {},
		get innerHTML() { return this._html },
		set innerHTML(v) { this._html = String(v); this.children = [] },
		getAttribute(n) {
			return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null
		},
		setAttribute(n, v) { this._attrs[n] = String(v) },
		addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
		removeEventListener(t, fn) {
			this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn)
		},
		append(c) { c.parentElement = this; this.children.push(c); return c },
		querySelectorAll() { return [] },
		// A real dispatch snapshots the listener list first: a handler added
		// while the event is being delivered does not get that same event.
		fire(type, ev) { for (const fn of (this.listeners[type] || []).slice()) fn(ev) },
		count(type) { return (this.listeners[type] || []).length },
	}
}

// A button inside its row, the shape renderListRow actually emits: the action
// is on the button, the list id is on the <li>, and the panel walks up for it.
function clickOn(body, action, rowAttrs, btnAttrs) {
	const row = el('li', rowAttrs || {})
	const btn = el('button', Object.assign({ 'data-tp-action': action }, btnAttrs || {}))
	row.append(btn)
	body.fire('click', { target: btn, preventDefault() {} })
}

function build() {
	let t = Date.UTC(2026, 0, 2, 12)
	const store = createTasteStore({ storage: _memoryStorage(), now: () => (t += 1000) })
	const body = el('div', { id: 'tp-body' })
	let render = null

	const panel = createTastePanel({
		store,
		now: () => t,
		// The page's own routing, copied from _onTasteChange: on the diary page
		// every mutation repaints the diary.
		onChange: () => { render() },
		labelFor: k => k,
	})

	const lifted = new Function('env', `
		const { document, window, panel, esc } = env
		function _taste() { return panel }
		function _tasteMetaMap() { return {} }
		function _diaryTimelineHtml() { return '' }
		function _bindDiaryLinks() {}
		function _bindTimelineLinks() {}
		${liftDiaryBlock()}
		return { renderDiaryBody: _renderDiaryBody }
	`)({
		document: { getElementById: id => (id === 'tp-body' ? body : null) },
		window: { PapaTasteStore: store },
		panel,
		esc,
	})

	render = lifted.renderDiaryBody
	return { store, panel, body, render }
}

test('repainting the diary leaves exactly one set of delegated listeners', () => {
	const { body, render } = build()
	render()

	const counts = [body.count('click')]
	// Four ordinary interactions. Each click is delivered to whatever listeners
	// are on #tp-body, and each of those repaints the page.
	for (let i = 0; i < 4; i++) {
		clickOn(body, 'rate', {}, { 'data-tp-key': 'movie:238', 'data-tp-value': String(i + 1) })
		counts.push(body.count('click'))
	}

	assert.deepStrictEqual(counts, [1, 1, 1, 1, 1],
		'one mount at a time — before the fix this ran 1, 2, 4, 8, 16')
	assert.strictEqual(body.count('submit'), 1, 'the submit listener must not stack either')
	assert.strictEqual(body.count('keydown'), 1, 'nor the keydown one')
})

test('deleting a list still takes two clicks after the page has been used', () => {
	const { body, render, store, panel } = build()
	render()

	const list = store.createList('Films to watch with my brother')
	assert.ok(list, 'the list must exist to begin with')
	render()

	// Use the page a little first — this is what armed the second listener.
	for (let i = 0; i < 3; i++) {
		clickOn(body, 'rate', {}, { 'data-tp-key': 'movie:238', 'data-tp-value': String(i + 1) })
	}

	clickOn(body, 'list-delete', { 'data-tp-id': list.id })
	assert.ok(store.getList(list.id),
		'one click must only arm the delete — it must never commit it')
	assert.strictEqual(panel.isArmed(), list.id,
		'and the row must be armed, so the "for good" warning is on screen')

	// The second, deliberate click is the one that destroys it.
	clickOn(body, 'list-delete', { 'data-tp-id': list.id })
	assert.strictEqual(store.getList(list.id), null, 'the confirming click deletes')
})

test('deleting a diary entry still takes two clicks after the page has been used', () => {
	const { body, render, store, panel } = build()
	render()

	const entry = store.logViewing('movie:238', { date: '2026-01-02', note: 'at the Ritzy' })
	assert.ok(entry && entry.id, 'the viewing must exist to begin with')
	render()

	for (let i = 0; i < 3; i++) {
		clickOn(body, 'rate', {}, { 'data-tp-key': 'movie:238', 'data-tp-value': String(i + 1) })
	}

	clickOn(body, 'diary-delete', { 'data-tp-id': entry.id })
	assert.ok(store.viewingsOf('movie:238').some(v => v.id === entry.id),
		'one click must only arm the delete of an evening he wrote up')
	assert.strictEqual(panel.isArmed(), entry.id, 'and it must be armed')
})
