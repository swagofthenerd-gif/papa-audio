'use strict'
// Three things the shop was not saying.
//
// #20: opening a peer whose browse is not cached sat on a static
// "Loading X's library…" for the whole slskd fetch -- seven seconds on a
// 7,635-album peer -- because the percentage needs a directory count that does
// not exist until slskd answers. Nothing moved, so it read as a hang.
//
// The engine now reports which folders are new since the last visit
// (`newDirs` on the browse begin/end reply) and whether the art source is
// rate-limiting us (`throttled` from fetchAlbumArt). Both are rendered only
// when the field is present, so an engine without them behaves exactly as
// before.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SH = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

function liftFn(decl) {
	const at = SH.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in slsk-shop-ui.js')
	let i = at + decl.length
	let depth = 1
	while (depth > 0 && i < SH.length) {
		const c = SH[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return SH.slice(at, i)
}

// ── #20: the loading phase ─────────────────────────────────────────────────
const PROGRESS = liftFn('function shLoadingProgress(el, text, pct) {')

function loadingEl() {
	const children = {
		'.slsk-lib-loading-text': { textContent: '' },
		'.slsk-lib-loading-bar span': { style: {} },
		'.slsk-lib-loading-bar': { attrs: {}, setAttribute(a, v) { this.attrs[a] = v } },
	}
	return {
		classes: new Set(['indeterminate']),
		textContent: '',
		classList: { remove(c) { children.owner.classes.delete(c) } },
		querySelector(sel) { return children[sel] || null },
		children,
	}
}

function run(pct) {
	const el = loadingEl()
	el.children.owner = el
	new Function('el', 'pct', PROGRESS + "\nshLoadingProgress(el, \"Loading sherrybaaz's library…\", pct)")(el, pct)
	return el
}

test('the browse starts on an indeterminate bar with the phase named', () => {
	assert.ok(/class="slsk-lib-loading indeterminate"/.test(SH), 'the bar must start indeterminate')
	assert.ok(/Fetching \$\{esc\(username\)\}'s file list from slskd…/.test(SH),
		'the copy must name the phase, not pretend to a percentage it does not have')
	assert.ok(/role="progressbar"/.test(SH))
})

test('the first real percentage stops the indeterminate animation', () => {
	const el = run(12)
	assert.ok(!el.classes.has('indeterminate'), 'a known percentage must not keep sliding')
})

test('the percentage drives both the text and the bar width', () => {
	const el = run(37.6)
	assert.strictEqual(el.children['.slsk-lib-loading-text'].textContent, "Loading sherrybaaz's library… 38%")
	assert.strictEqual(el.children['.slsk-lib-loading-bar span'].style.width, '38%')
	assert.strictEqual(el.children['.slsk-lib-loading-bar'].attrs['aria-valuenow'], '38')
})

test('a nonsense percentage is clamped rather than painted off the end', () => {
	assert.strictEqual(run(140).children['.slsk-lib-loading-bar span'].style.width, '100%')
	assert.strictEqual(run(-5).children['.slsk-lib-loading-bar span'].style.width, '0%')
})

test('the indeterminate bar respects a reduced-motion preference', () => {
	assert.ok(/prefers-reduced-motion: reduce[\s\S]{0,200}slsk-lib-loading-bar > span \{ animation: none/.test(CSS))
})

// ── newDirs → the "New since last visit" shelf ─────────────────────────────
const NEW_ALBUMS = liftFn('function shNewAlbums() {')
const NOTE = liftFn('function shNoteNewDirs(reply) {')

function shelfRun(reply, everything) {
	return new Function('reply', 'everything', `
		let shNewDirs = null
		const shelves = { everything }
		${NOTE}
		${NEW_ALBUMS}
		shNoteNewDirs(reply)
		return shNewAlbums().map(a => a.album)
	`)(reply, everything)
}

const LIB = [
	{ album: 'Kind of Blue', folderPath: '/music/Miles Davis/Kind of Blue', folderName: 'Kind of Blue' },
	{ album: 'A Love Supreme', folderPath: '/music/Coltrane/A Love Supreme', folderName: 'A Love Supreme' },
	{ album: 'Blue Train', folderPath: '/music/Coltrane/Blue Train', folderName: 'Blue Train' },
]

test('the shelf lists exactly the folders the engine reported as new', () => {
	const out = shelfRun({ newDirs: ['/music/Coltrane/Blue Train'] }, LIB)
	assert.deepStrictEqual(out, ['Blue Train'])
})

test('an engine that does not send newDirs produces no shelf at all', () => {
	assert.deepStrictEqual(shelfRun({ ok: true }, LIB), [])
	assert.deepStrictEqual(shelfRun(null, LIB), [])
})

test('an empty newDirs is not a shelf either', () => {
	assert.deepStrictEqual(shelfRun({ newDirs: [] }, LIB), [])
})

test('the shelf is rendered through the same rail builder, so it hides when empty', () => {
	assert.ok(/shRailHtml\('new', 'New since last visit'/.test(SH))
	assert.ok(/if \(!albums \|\| !albums\.length\) return ''/.test(SH),
		'shRailHtml must still hide an empty shelf')
})

test('both the begin and the end reply are read for newDirs', () => {
	assert.ok(/shNoteNewDirs\(res\)/.test(SH), 'the begin reply')
	assert.ok(/shNoteNewDirs\(endReply\)/.test(SH), 'and the end reply')
})

// ── throttled → stop the background art sweep ──────────────────────────────
test('a throttled art reply stops the background sweep for the session', () => {
	const fetchBody = SH.slice(SH.indexOf('const res = await window.api.fetchAlbumArt('))
	const head = fetchBody.slice(0, 600)
	assert.ok(/if \(res && res\.throttled\) \{ shArtPrefetchAbort = true; return \}/.test(head), head.slice(0, 400))
	// And the stop must come BEFORE the miss is cached, or a throttled identity
	// is remembered as "no art exists" for the rest of the session.
	assert.ok(head.indexOf('res.throttled') < head.indexOf("shArtCache.set(key, artPath || '')"))
})

test('the sweep itself honours that flag', () => {
	assert.ok(/while \(!shArtPrefetchAbort && cursor < plan\.length\)/.test(SH))
	assert.ok(/if \(!ART_IPC \|\| !PF \|\| !SH \|\| shArtPrefetchRunning \|\| shArtPrefetchAbort\) return/.test(SH))
})
