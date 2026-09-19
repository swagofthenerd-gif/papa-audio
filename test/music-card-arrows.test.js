'use strict'
// D7 — choosing the next album scrubbed the playing track.
//
// The cards on Home, Library, Artists and the YouTube pages are focusable and
// carry role="button", but nothing owned their arrow keys. DEFAULT_SHORTCUTS
// maps seekForward to a bare ArrowRight, and _moveCardFocus covered only the
// VIDEO grid (.vcard) — so ArrowRight on a focused .album-card fell through to
// the document handler and jumped the playing track +10 s instead of moving to
// the next card.
//
// The real #content delegate body and the real helpers are lifted out of
// renderer.js and driven through a DOM model with positions, so the row-wrap
// arithmetic is exercised rather than described.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function fnSource(name) {
	const m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(SRC)
	assert.ok(m, name + ' must still be a top-level function in renderer.js')
	const start = m.index + 1
	const end = SRC.indexOf('\n}\n', start)
	assert.ok(end > start, name + ' has no closing brace')
	return SRC.slice(start, end + 2)
}

// The arrow branch of the #content keydown delegate, verbatim.
function delegateBody() {
	const open = SRC.indexOf("document.getElementById('content')?.addEventListener('keydown', e => {")
	assert.ok(open > -1, 'the #content card keydown delegate must still exist')
	const bodyStart = SRC.indexOf('{', SRC.indexOf('e => {', open)) + 1
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

// The seek branch of the global shortcut handler, verbatim.
function seekBranch() {
	const a = SRC.indexOf('    const _onMusicCard = !!_focusedMusicCard(e)')
	assert.ok(a > -1, 'the seek branch must consult the focused music card')
	const b = SRC.indexOf("\n    // Volume", a)
	assert.ok(b > a)
	return SRC.slice(a, b)
}

// ── A DOM with geometry ──────────────────────────────────────────────────────
function makeCard(cls, parent, top) {
	const n = {
		cls, parent, children: [], focused: 0, _top: top,
		classList: { contains: c => cls.split(/\s+/).includes(c) },
		closest(sel) {
			const wanted = sel.split(',').map(s => s.trim().replace(/^\./, ''))
			let cur = n
			while (cur) {
				if (wanted.some(w => String(cur.cls).split(/\s+/).includes(w))) return cur
				cur = cur.parent
			}
			return null
		},
		get parentElement() { return n.parent },
		getBoundingClientRect() { return { top: n._top } },
		focus() { n.focused++; n._doc.activeElement = n },
		scrollIntoView() {},
		querySelectorAll() { return [] },
	}
	if (parent) parent.children.push(n)
	return n
}

// `perRow` cards laid out in rows, all inside one container.
function grid(cls, count, perRow) {
	const container = {
		cls: 'grid', parent: null, children: [],
		closest: () => null,
		get parentElement() { return null },
		querySelectorAll() { return container.children },
	}
	const doc = { activeElement: null }
	for (let i = 0; i < count; i++) {
		const c = makeCard(cls, container, Math.floor(i / perRow) * 200)
		c._doc = doc
	}
	return { container, cards: container.children, doc }
}

function ctxFor(doc) {
	const ctx = {
		Array, Math, String, Object, console,
		document: doc,
		audio: { currentTime: 40, duration: 300 },
		state: { currentPage: 'home' },
		VIDEO_PAGES: new Set(['video', 'browse']),
	}
	vm.createContext(ctx)
	// The selector list itself, so a card class dropped from it turns this red.
	const selSrc = /const MUSIC_CARD_SEL = [\s\S]*?'\n/.exec(SRC)
	assert.ok(selSrc, 'MUSIC_CARD_SEL must still be a top-level const')
	vm.runInContext([
		selSrc[0],
		fnSource('_focusedMusicCard'),
		fnSource('_moveMusicCardFocus'),
		'var __delegate = function (e) {' + delegateBody() + '}',
	].join('\n'), ctx)
	return ctx
}

function press(ctx, key, target, extra) {
	const e = Object.assign({
		key, target,
		defaultPrevented: false, propagationStopped: false,
		ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
		preventDefault() { this.defaultPrevented = true },
		stopPropagation() { this.propagationStopped = true },
	}, extra || {})
	ctx.__delegate(e)
	return e
}

// ── the reported bug ─────────────────────────────────────────────────────────

test('ArrowRight on a focused album card moves to the next card', () => {
	const g = grid('album-card', 6, 3)
	const ctx = ctxFor(g.doc)
	const e = press(ctx, 'ArrowRight', g.cards[0])
	assert.strictEqual(g.cards[1].focused, 1, 'focus must move along the row')
	assert.strictEqual(e.defaultPrevented, true)
})

test('and the keypress never reaches the seek shortcut', () => {
	const g = grid('album-card', 6, 3)
	const ctx = ctxFor(g.doc)
	const e = press(ctx, 'ArrowRight', g.cards[0])
	assert.strictEqual(e.propagationStopped, true,
		'this is the bug: the same press scrubbed the playing track +10 s')
})

test('even at the END of the grid, where focus cannot move, the seek is refused', () => {
	// The nastiest shape of the bug: the last card has nowhere to go, so a
	// handler that only stops the event when focus MOVED would still scrub.
	const g = grid('album-card', 3, 3)
	const ctx = ctxFor(g.doc)
	const e = press(ctx, 'ArrowRight', g.cards[2])
	assert.strictEqual(e.propagationStopped, true)
	assert.strictEqual(g.cards[2].focused, 0, 'and it stays where it is')
})

test('ArrowLeft steps back and stops at the first card', () => {
	const g = grid('artist-card', 6, 3)
	const ctx = ctxFor(g.doc)
	press(ctx, 'ArrowLeft', g.cards[2])
	assert.strictEqual(g.cards[1].focused, 1)
	const e = press(ctx, 'ArrowLeft', g.cards[0])
	assert.strictEqual(g.cards[0].focused, 0, 'no wrap past the start')
	assert.strictEqual(e.propagationStopped, true)
})

test('ArrowDown moves by a row, worked out from the cards own positions', () => {
	const g = grid('album-card', 9, 3)
	const ctx = ctxFor(g.doc)
	press(ctx, 'ArrowDown', g.cards[1])
	assert.strictEqual(g.cards[4].focused, 1, 'one row down from index 1 in a 3-wide grid')
	press(ctx, 'ArrowUp', g.cards[4])
	assert.strictEqual(g.cards[1].focused, 1)
})

test('ArrowDown in a single-row scroll row falls through so the page can scroll', () => {
	// Every card shares a top, so there is no row below; consuming the key
	// there would make the page feel stuck.
	const g = grid('quick-card', 5, 5)
	const ctx = ctxFor(g.doc)
	const e = press(ctx, 'ArrowDown', g.cards[0])
	assert.strictEqual(e.defaultPrevented, false)
	assert.strictEqual(e.propagationStopped, false)
})

test('every music grid card class is covered, not just album cards', () => {
	for (const cls of ['album-card', 'artist-card', 'quick-card', 'yt-album-card',
		'yt-artist-card', 'yt-playlist-card', 'pl-card', 'genre-tile', 'mood-card',
		'daily-mix-card', 'jumpback-card']) {
		const g = grid(cls, 4, 4)
		const ctx = ctxFor(g.doc)
		const e = press(ctx, 'ArrowRight', g.cards[0])
		assert.strictEqual(g.cards[1].focused, 1, cls + ' must rove')
		assert.strictEqual(e.propagationStopped, true, cls + ' must not scrub')
	}
})

// ── what must keep working ───────────────────────────────────────────────────

test('an arrow inside a tab strip is left alone — a tablist owns its own arrows', () => {
	const strip = { cls: 'tabs', parent: null, children: [], closest: null }
	strip.closest = sel => (sel.includes('tablist') ? strip : null)
	strip.cls = 'tabs'
	const tab = makeCard('album-card', strip, 0)
	tab.closest = sel => (sel.includes('tablist') ? strip : (sel.includes('album-card') ? tab : null))
	const ctx = ctxFor({ activeElement: null })
	const e = press(ctx, 'ArrowRight', tab)
	assert.strictEqual(e.propagationStopped, false)
})

test('an arrow in a text field is left alone', () => {
	const input = makeCard('', null, 0)
	input.closest = sel => (sel.includes('contenteditable') ? input : null)
	const ctx = ctxFor({ activeElement: null })
	const e = press(ctx, 'ArrowRight', input)
	assert.strictEqual(e.propagationStopped, false)
})

test('Shift+ArrowRight still means next track, not card movement', () => {
	const g = grid('album-card', 6, 3)
	const ctx = ctxFor(g.doc)
	const e = press(ctx, 'ArrowRight', g.cards[0], { shiftKey: true })
	assert.strictEqual(g.cards[1].focused, 0)
	assert.strictEqual(e.propagationStopped, false, 'the nextTrack shortcut must still get it')
})

// ── the seek branch itself ───────────────────────────────────────────────────

test('the seek shortcut refuses outright when a card has focus', () => {
	// Belt to the delegate's braces: if anything ever re-routes the event, the
	// scrub still must not happen.
	const g = grid('album-card', 4, 4)
	const ctx = ctxFor(g.doc)
	ctx.matchesShortcut = (name, e) => (name === 'seekForward' && e.key === 'ArrowRight')
	vm.runInContext('var _onVideoGrid = false\nvar __seek = function (e) {' + seekBranch() + '\nreturn "seeked" }', ctx)

	const before = ctx.audio.currentTime
	const out = ctx.__seek({ key: 'ArrowRight', target: g.cards[0], preventDefault() {} })
	assert.strictEqual(ctx.audio.currentTime, before, 'the track must not move')
	assert.notStrictEqual(out, 'seeked')
})

test('and still seeks normally when nothing on the grid has focus', () => {
	const ctx = ctxFor({ activeElement: null })
	ctx.matchesShortcut = (name, e) => (name === 'seekForward' && e.key === 'ArrowRight')
	vm.runInContext('var _onVideoGrid = false\nvar __seek = function (e) {' + seekBranch() + '\nreturn "fell-through" }', ctx)
	const body = { cls: 'body', parent: null, closest: () => null }
	ctx.__seek({ key: 'ArrowRight', target: body, preventDefault() {} })
	assert.strictEqual(ctx.audio.currentTime, 50, 'a normal ArrowRight still seeks +10 s')
})
