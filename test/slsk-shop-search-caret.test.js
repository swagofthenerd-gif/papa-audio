'use strict'
// The Soulseek shop's search box ate the space between two words and threw the
// caret to the end: type "pink", pause, type "floyd", get "pinkfloyd".
//
// Typing is debounced by 160ms, and when it fires it repaints the shop. The
// repaint re-emitted the whole hero into innerHTML — and the hero contains the
// very input being typed into, so the element was destroyed and rebuilt under
// his fingers. The rebuilt one was then filled from the TRIMMED query, which is
// where the trailing space went, and its caret was forced to the end of the
// value.
//
// A background browse refresh repaints as well, so the same thing could happen
// while he was not typing at all.
//
// There is no DOM in this test runner and the app does not carry one, so the
// browser is doubled below. Only the behaviours this bug turns on are modelled,
// and they are modelled the way a browser really behaves: assigning innerHTML
// replaces an element's children with NEW elements, so anything the old
// children held — an input's value, its selection, its focus — is gone;
// insertAdjacentHTML('afterend') does not disturb the element it is called on.
// The code under test is the real shHeroHtml, shHeroMetaHtml, shPaint and
// bindShHero, lifted out of src/slsk-shop-ui.js.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SHOP = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')

function lift(opener, what) {
	const start = SHOP.indexOf(opener)
	assert.ok(start > -1, what + ' must still exist in src/slsk-shop-ui.js')
	const end = SHOP.indexOf('\n  }\n', start)
	assert.ok(end > start, what + ' must still close at its own indent')
	return SHOP.slice(start, end + 5)
}

const CODE = [
	lift('  function shHeroMetaHtml() {', 'shHeroMetaHtml'),
	lift('  function shHeroHtml() {', 'shHeroHtml'),
	lift('  function shPaint(', 'shPaint'),
	lift('  function bindShHero() {', 'bindShHero'),
].join('\n')

// ── the browser double ──────────────────────────────────────────────────────

let nextId = 1
function makeNode(tag, attrs, raw) {
	return {
		_uid: nextId++,
		tagName: String(tag).toUpperCase(),
		_attrs: attrs || {},
		_raw: raw || '',
		children: [],
		parentNode: null,
		listeners: {},
		value: '',
		selectionStart: 0,
		selectionEnd: 0,
		focused: false,
		focus() { this.focused = true },
		setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b },
		addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
		removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn) },
		fire(t) { for (const fn of (this.listeners[t] || []).slice()) fn({ target: this }) },
		get innerHTML() { return this._raw },
		// A browser throws the old children away and builds new ones. That is the
		// whole mechanism of this bug, so it is modelled exactly.
		set innerHTML(html) { this._raw = String(html); this.children = parse(String(html), this) },
		get nextSibling() {
			if (!this.parentNode) return null
			const i = this.parentNode.children.indexOf(this)
			return this.parentNode.children[i + 1] || null
		},
		removeChild(c) {
			const i = this.children.indexOf(c)
			if (i >= 0) { this.children.splice(i, 1); c.parentNode = null }
			return c
		},
		insertAdjacentHTML(where, html) {
			assert.strictEqual(where, 'afterend', 'only the afterend case is modelled')
			const parent = this.parentNode
			const at = parent.children.indexOf(this) + 1
			const made = parse(String(html), parent)
			parent.children.splice(at, 0, ...made)
		},
		querySelector(sel) {
			const match = n =>
				(sel.startsWith('#') && n._attrs.id === sel.slice(1)) ||
				(sel.startsWith('.') && String(n._attrs.class || '').split(/\s+/).includes(sel.slice(1)))
			const walk = n => {
				for (const c of n.children) {
					if (match(c)) return c
					const found = walk(c)
					if (found) return found
				}
				return null
			}
			return walk(this)
		},
	}
}

// Enough of a parser for the markup the hero actually emits: the hero div, the
// meta div inside it, the search input inside that, and one opaque node standing
// in for whatever body html was painted underneath.
function parse(html, parent) {
	const out = []
	if (/class="slsh-hero"/.test(html)) {
		const hero = makeNode('div', { class: 'slsh-hero' })
		hero.parentNode = parent
		const meta = makeNode('div', { class: 'slsh-hero-meta', id: 'slsh-hero-meta' })
		meta.parentNode = hero
		hero.children.push(meta)
		if (/id="slsh-search"/.test(html)) {
			const input = makeNode('input', { class: 'slsh-search', id: 'slsh-search' })
			input.parentNode = hero
			hero.children.push(input)
		}
		out.push(hero)
		html = html.slice(html.indexOf('</div>', html.indexOf('id="slsh-search"')) + 6)
	}
	if (html.trim()) {
		const body = makeNode('div', { class: 'slsh-body-chunk' }, html)
		body.parentNode = parent
		out.push(body)
	}
	return out
}

// ── the harness ─────────────────────────────────────────────────────────────

function shop() {
	const shBody = makeNode('div', { id: 'slsh-body' })
	const timers = []
	const painted = []
	const env = {
		shBody,
		dlg: shBody,                       // the hero lives inside the dialog body
		shelves: { stats: { albums: 12, tracks: 140, size: 5e9, losslessPct: 100, hiRes: 3, surround: 1 } },
		username: 'somepeer',
		repaints: 0,
		painted,
		timers,
	}

	const api = new Function('env', `
		const { shBody, dlg, shelves, username, painted, timers } = env
		let shSearchQuery = ''
		let shJustRefreshed = false, shFromCache = false, shCachedAt = 0
		const esc = s => String(s == null ? '' : s)
		const shFmtSize = n => String(n) + 'B'
		const _shAgo = () => 'just now'
		// The debounce is captured rather than run, so the test decides when the
		// 160ms is up. Nothing here is timing-dependent.
		const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
		const clearTimeout = i => { if (i) timers[i - 1] = null }
		function renderShelves() {
			env.repaints++
			painted.push('repaint')
			shPaint('<div class="slsh-rails">rails</div>')
		}
		${CODE}
		return {
			paint: html => shPaint(html),
			repaint: () => renderShelves(),
			query: () => shSearchQuery,
			setQuery: q => { shSearchQuery = q },
		}
	`)(env)

	return { api, shBody, env, timers }
}

const input = shBody => shBody.querySelector('#slsh-search')

// Run whichever debounce callback is still armed.
function fireDebounce(timers) {
	const live = timers.filter(Boolean)
	assert.ok(live.length, 'a debounce must be pending')
	const last = live[live.length - 1]
	assert.strictEqual(last.ms, 160, 'the search debounce is 160ms')
	last.fn()
}

// He types some characters into whatever box is on screen at that moment —
// which is the point. Looking the element up each time is what a person does;
// holding a reference to the one that was there a second ago is not, and would
// hide the very destroy-and-rebuild this test exists to catch.
function type(shBody, text) {
	const si = input(shBody)
	assert.ok(si, 'there must be a search box to type into')
	si.value += text
	si.selectionStart = si.selectionEnd = si.value.length
	si.fire('input')
	return si
}

test('the space between two words survives the repaint', () => {
	const { api, shBody, timers } = shop()
	api.paint('<div class="slsh-rails">rails</div>')
	assert.ok(input(shBody), 'the hero must have put a search box on screen')

	type(shBody, 'pink')
	fireDebounce(timers)          // he paused; the debounce fires and repaints

	type(shBody, ' ')
	fireDebounce(timers)          // he paused again, mid-phrase

	type(shBody, 'floyd')
	fireDebounce(timers)

	assert.strictEqual(input(shBody).value, 'pink floyd',
		'this used to come out as "pinkfloyd"')
})

test('the box he is typing into is never rebuilt underneath him', () => {
	const { api, shBody, timers } = shop()
	api.paint('<div class="slsh-rails">rails</div>')
	const first = input(shBody)

	type(shBody, 'pink')
	fireDebounce(timers)

	assert.strictEqual(input(shBody)._uid, first._uid,
		'the same element must still be there after a repaint')
})

test('the caret stays where he left it', () => {
	const { api, shBody, timers } = shop()
	api.paint('<div class="slsh-rails">rails</div>')
	type(shBody, 'pink floyd')
	fireDebounce(timers)
	// He clicks back to fix the first word.
	input(shBody).selectionStart = input(shBody).selectionEnd = 4

	api.repaint()

	assert.strictEqual(input(shBody).selectionStart, 4,
		'a repaint must not throw the caret to the end of the line')
	assert.strictEqual(input(shBody).selectionEnd, 4)
})

test('a background browse refresh does not disturb what he is typing', () => {
	const { api, shBody } = shop()
	api.paint('<div class="slsh-rails">rails</div>')
	const si = input(shBody)
	si.value = 'wish you '
	si.selectionStart = si.selectionEnd = 9

	// Not him: the browse cache came back and the shop repainted itself.
	api.repaint()

	assert.strictEqual(input(shBody).value, 'wish you ', 'his half-typed phrase is untouched')
	assert.strictEqual(input(shBody).selectionStart, 9, 'and so is his caret')
})

test('the shop still repaints its contents around the box', () => {
	const { api, shBody } = shop()
	api.paint('<div class="slsh-rails">first</div>')
	assert.match(shBody.children[1]._raw, /first/)

	api.paint('<div class="slsh-search-results">second</div>')
	assert.strictEqual(shBody.children.length, 2, 'hero plus one body, not a growing pile')
	assert.match(shBody.children[1]._raw, /second/, 'the new contents replaced the old')
	assert.ok(input(shBody), 'and the search box is still there')
})

test('the query the search runs on is still trimmed', () => {
	const { api, shBody, timers } = shop()
	api.paint('<div class="slsh-rails">rails</div>')
	type(shBody, 'pink ')
	fireDebounce(timers)

	assert.strictEqual(api.query(), 'pink', 'a trailing space means nothing to the search')
	assert.strictEqual(input(shBody).value, 'pink ', 'but it stays in the box he is typing in')
})
