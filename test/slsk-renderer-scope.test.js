'use strict'
// The renderer's <script> tags share ONE top-level scope.
//
// src/index.html loads several dozen plain classic scripts. They are not
// modules and there is no bundler, so every top-level `const`, `let` and
// `class` in every one of them lands in the same global lexical environment. Two
// files declaring the same name is a redeclaration SyntaxError, and a
// SyntaxError in a classic script is not a console warning you notice later —
// the script never runs, so the whole feature it powers is simply gone. That has
// already happened once on the Soulseek tab, from a name shared between
// slsk-tree.js and slsk-shelves.js.
//
// This compiles the scripts the way the page loads them and fails on a
// collision. It COMPILES rather than runs: redeclaration is an early error, so
// compilation is enough to catch it, and nothing here needs a DOM.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, '..', 'src')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')

// Classic scripts only, in page order. A `type="module"` tag would have its own
// scope and must not be included; there are none today, and if one appears this
// picks it up as a plain src and the filter below drops it.
function pageScripts() {
	const out = []
	const re = /<script\b([^>]*)>/gi
	let m
	while ((m = re.exec(HTML))) {
		const attrs = m[1]
		if (/\btype\s*=\s*["']module["']/i.test(attrs)) continue
		const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)
		if (!src) continue
		const rel = src[1]
		if (/^(https?:)?\/\//.test(rel)) continue
		out.push(rel)
	}
	return out
}

test('index.html still loads the two Soulseek modules as plain shared-scope scripts', () => {
	const list = pageScripts()
	assert.ok(list.includes('slsk-tree.js'), 'slsk-tree.js is no longer a page script')
	assert.ok(list.includes('slsk-shelves.js'), 'slsk-shelves.js is no longer a page script')
	// If these ever become modules or get bundled, the collision hazard below
	// goes away and this file should go with it — but that has to be a deliberate
	// change, not something that quietly stops being true.
	assert.ok(list.length > 20, `expected the renderer to load many classic scripts, saw ${list.length}`)
})

test('no two renderer scripts declare the same top-level const/let/class', () => {
	const list = pageScripts()
	const sources = []
	const missing = []
	for (const rel of list) {
		const p = path.join(SRC, rel)
		if (!fs.existsSync(p)) { missing.push(rel); continue }
		// Label each chunk so a SyntaxError message can be traced back.
		sources.push(`/* ==== ${rel} ==== */\n` + fs.readFileSync(p, 'utf8'))
	}
	assert.deepStrictEqual(missing, [], 'index.html references scripts that do not exist')
	try {
		// eslint-disable-next-line no-new
		new vm.Script(sources.join('\n;\n'), { filename: 'renderer-scripts.js' })
	} catch (e) {
		assert.fail(
			'the renderer scripts do not compile in one shared scope — this is the bug ' +
			'class that kills a whole tab at load:\n  ' + e.message)
	}
})

test('slsk-tree.js and slsk-shelves.js specifically share no top-level name', () => {
	// The narrow version of the test above, kept separate so a failure names the
	// pair that has bitten this project rather than "somewhere in 40 files".
	const a = fs.readFileSync(path.join(SRC, 'slsk-tree.js'), 'utf8')
	const b = fs.readFileSync(path.join(SRC, 'slsk-shelves.js'), 'utf8')
	try {
		// eslint-disable-next-line no-new
		new vm.Script(a + '\n;\n' + b, { filename: 'slsk-pair.js' })
	} catch (e) {
		assert.fail('slsk-tree.js and slsk-shelves.js collide in the renderer scope: ' + e.message)
	}
	// And each must still compile alone, which a stray brace would break.
	// eslint-disable-next-line no-new
	new vm.Script(a, { filename: 'slsk-tree.js' })
	// eslint-disable-next-line no-new
	new vm.Script(b, { filename: 'slsk-shelves.js' })
})

test('both modules still publish their window API when run as page scripts', () => {
	// Compiling proves they parse; this proves they still register the globals the
	// rest of the renderer reaches for. Run in a bare context with a `window`, the
	// way the page provides one.
	// `window` IS the global in a page, and these modules are not consistent
	// about which one they register on — some write window.X, the UMD-wrapped
	// ones write globalThis.X. A sandbox where window points at the global is
	// the browser's arrangement, and the only one where both land in the same
	// place.
	const sandbox = { Intl, console }
	sandbox.window = sandbox
	const ctx = vm.createContext(sandbox)
	const ROOM_FILES = ['slsk-hunt.js', 'slsk-wander.js', 'slsk-columns.js',
		'slsk-dossier.js', 'slsk-room-ui.js']
	// transfer-indicator.js loads in the same shared scope and reaches for
	// PapaSlskShelves.fmtSize, so it belongs in this context, after the shelves.
	for (const f of ['slsk-tree.js', 'slsk-shelves.js', ...ROOM_FILES,
		'transfer-indicator.js']) {
		vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f })
	}
	assert.ok(ctx.window.PapaSlskTree, 'window.PapaSlskTree missing')
	assert.ok(ctx.window.PapaSlskShelves, 'window.PapaSlskShelves missing')
	for (const fn of ['buildTree', 'listDir', 'searchTree', 'breadcrumbs']) {
		assert.strictEqual(typeof ctx.window.PapaSlskTree[fn], 'function', `PapaSlskTree.${fn}`)
	}
	for (const fn of ['extractAlbums', 'buildShelves', 'mergeSourcesByAlbum',
		'sortMergedAlbums', 'buildLibraryIndex', 'parseAlbumFolder']) {
		assert.strictEqual(typeof ctx.window.PapaSlskShelves[fn], 'function', `PapaSlskShelves.${fn}`)
	}
	// The Listening Room's five modules register alongside them, in the same
	// shared scope, without a collision.
	for (const g of ['PapaSlskHunt', 'PapaSlskWander', 'PapaSlskColumns',
		'PapaSlskDossier', 'PapaSlskRoomUI', 'PapaTransferIndicator']) {
		assert.ok(ctx.window[g], `window.${g} missing`)
	}
	// The sidebar indicator's four surfaces, reachable in the page's own scope.
	for (const fn of ['downloadPill', 'sharingPill', 'sharingRows', 'todayLine']) {
		assert.strictEqual(typeof ctx.window.PapaTransferIndicator[fn], 'function',
			`PapaTransferIndicator.${fn}`)
	}
	// And it works here, not merely exists — including the size formatter it
	// borrows from the shelves module in this very context.
	assert.strictEqual(
		ctx.window.PapaTransferIndicator.downloadPill(
			[{ username: 'a', files: [{ filename: 'x.flac', state: 'InProgress' }] }]).text,
		'↓ 1')
	assert.strictEqual(typeof ctx.window.PapaSlskRoomUI.show, 'function')
	assert.strictEqual(typeof ctx.window.PapaSlskColumns.mount, 'function')
	assert.strictEqual(typeof ctx.window.PapaSlskDossier.open, 'function')

	// And they work in that context, not merely exist.
	const tree = ctx.window.PapaSlskTree.buildTree([
		{ name: 'A\\B', files: [{ filename: '01.flac', size: 10 }, { filename: '02.flac', size: 20 }] },
	])
	assert.strictEqual(tree.fileCount, 2)
	assert.strictEqual(ctx.window.PapaSlskShelves.extractAlbums(tree).length, 1)
})

// ── Folders column widths ────────────────────────────────────────────────────
// Dragging a column wider is only useful if the width survives navigating, so
// it is stored per column INDEX in localStorage. That store is a plain string a
// user can edit by hand, which is what these guard: nothing that comes back out
// of it may become a width outside the usable range, and nothing unparseable
// may throw on the way in.
test('column widths clamp, round-trip and reject junk', () => {
	const C = require('../src/slsk-columns.js')
	assert.strictEqual(C.COL_W_MIN, 140)
	assert.strictEqual(C.COL_W_MAX, 480)

	// Clamping is what keeps a column readable and on screen.
	assert.strictEqual(C.clampColWidth(10), 140)
	assert.strictEqual(C.clampColWidth(9999), 480)
	assert.strictEqual(C.clampColWidth(301.6), 302)
	assert.strictEqual(C.clampColWidth('not a number'), 140)

	// A drag is start width plus pointer delta, clamped at both ends.
	assert.strictEqual(C.nextColWidth(220, 60), 280)
	assert.strictEqual(C.nextColWidth(220, -500), 140)
	assert.strictEqual(C.nextColWidth(220, 5000), 480)
	assert.strictEqual(C.nextColWidth(220, undefined), 220)

	// Anything a hand-edited store can hold has to arrive as an empty map, not
	// as a throw and not as a width.
	assert.deepStrictEqual(C.parseColWidths(null), {})
	assert.deepStrictEqual(C.parseColWidths('{oops'), {})
	assert.deepStrictEqual(C.parseColWidths('[1,2]'), {})
	assert.deepStrictEqual(C.parseColWidths('"420"'), {})
	assert.deepStrictEqual(C.parseColWidths('{"a":300}'), {})
	assert.deepStrictEqual(C.parseColWidths('{"0":-5}'), {})
	assert.deepStrictEqual(C.parseColWidths('{"0":9999,"2":300}'), { 0: 480, 2: 300 })

	// Round trip: what is written is what comes back.
	const written = C.serializeColWidths({ 0: 260, 1: 9999, 2: 10, bad: 300 })
	assert.deepStrictEqual(C.parseColWidths(written), { 0: 260, 1: 480, 2: 140 })
})

// ── The shared panel resizer ─────────────────────────────────────────────────
test('panel-resize: clamping, drag direction and the persisted round trip', () => {
	const PR = require('../src/panel-resize.js')

	assert.strictEqual(PR.clamp(10, 240, 560), 240)
	assert.strictEqual(PR.clamp(9999, 240, 560), 560)
	assert.strictEqual(PR.clamp(300.4, 240, 560), 300)
	assert.strictEqual(PR.clamp('nonsense', 240, 560), 240)

	// A left-edge panel is anchored to the right of the window, so dragging the
	// pointer LEFT widens it. Getting this backwards is the bug that makes a
	// panel shrink when you pull it open, so both directions are pinned.
	const box = { startPx: 320, min: 240, max: 560, windowWidth: 1600 }
	assert.strictEqual(PR.nextWidth({ ...box, edge: 'left', dx: -100 }), 420)
	assert.strictEqual(PR.nextWidth({ ...box, edge: 'left', dx: 100 }), 240) // 220, clamped to min
	assert.strictEqual(PR.nextWidth({ ...box, edge: 'right', dx: 100 }), 420)
	assert.strictEqual(PR.nextWidth({ ...box, edge: 'right', dx: -100 }), 240)

	// The window is a harder limit than the design max: a panel wider than its
	// window has its own close button off screen.
	assert.strictEqual(PR.effectiveMax(900, 1600), 900)
	assert.strictEqual(PR.effectiveMax(900, 700), 580)
	assert.strictEqual(PR.nextWidth({ startPx: 500, dx: -900, edge: 'left', min: 380, max: 900, windowWidth: 700 }), 580)

	// Stored state. The legacy queue store held a CSS string, so parseFloat
	// rather than Number is what keeps an existing width from being thrown away.
	const opts = { min: 240, max: 560, defaultPx: 320 }
	assert.deepStrictEqual(PR.readState('340px', null, opts), { width: 340, collapsed: false })
	assert.deepStrictEqual(PR.readState(null, null, opts), { width: 320, collapsed: false })
	assert.deepStrictEqual(PR.readState('', '1', opts), { width: 320, collapsed: true })
	assert.deepStrictEqual(PR.readState('99999', '0', opts), { width: 560, collapsed: false })
	assert.deepStrictEqual(PR.readState('-40', null, opts), { width: 320, collapsed: false })
	assert.strictEqual(PR.readState(PR.writeWidth(413.7), null, opts).width, 414)
	assert.strictEqual(PR.collapsedKey('papa-mcs-width'), 'papa-mcs-width:collapsed')
})

test('panel-resize is a page script and publishes its global', () => {
	assert.ok(pageScripts().includes('panel-resize.js'),
		'index.html no longer loads panel-resize.js, so nothing can attach a handle')
	const ctx = vm.createContext({ window: {}, console })
	vm.runInContext(fs.readFileSync(path.join(SRC, 'panel-resize.js'), 'utf8'), ctx,
		{ filename: 'panel-resize.js' })
	assert.ok(ctx.window.PapaPanelResize, 'window.PapaPanelResize missing')
	assert.strictEqual(typeof ctx.window.PapaPanelResize.attach, 'function')
	// attach() with no element must be a no-op, not a throw: every caller below
	// runs in a context where the panel may simply not be on the page yet.
	assert.strictEqual(ctx.window.PapaPanelResize.attach({}), null)
	assert.strictEqual(ctx.window.PapaPanelResize.attach(), null)
})

// The four attachments, checked at the text level. A wiring test that only
// asserted "PapaPanelResize exists" would stay green through a rename that
// silently unhooks a panel, so each call site is pinned to its own key, panel
// and range — the numbers a user would notice going wrong.
test('every side panel is actually attached to the shared resizer', () => {
	const read = f => fs.readFileSync(path.join(SRC, f), 'utf8')
	const renderer = read('renderer.js')
	const columns = read('slsk-columns.js')
	const dossier = read('slsk-dossier.js')

	// The old per-panel copy is gone, replaced by the shared one.
	assert.ok(!/initResizableQueue/.test(renderer),
		'the queue panel still has its own private resizer')
	assert.ok(/initPanelResizers\s*\(\)/.test(renderer), 'initPanelResizers is never called')

	const expect = [
		[renderer, 'queue-panel', "key: 'papa-queue-width'", 'the queue popover'],
		[renderer, 'np-queue-panel', "key: 'papa-np-queue-width'", 'the now-playing queue'],
		[renderer, "getElementById('mcs')", "key: 'papa-mcs-width'", 'the agent/Settings sidebar'],
		[columns, 'slr-col-insp', "key: 'slsk_insp_w'", 'the Folders inspector'],
		[dossier, 'slr-dossier-panel', "key: 'slr_dossier_w'", 'the album dossier'],
	]
	for (const [src, anchor, key, what] of expect) {
		assert.ok(src.includes(anchor), `${what}: lost its element anchor ${anchor}`)
		assert.ok(src.includes(key), `${what}: no longer attaches with ${key}`)
	}

	// The ranges the brief fixed, so a later edit cannot quietly let a panel
	// shrink past readable or grow past the window.
	assert.ok(/key: 'slr_dossier_w', min: 380, max: 900/.test(dossier),
		'the dossier resizer lost its 380-900 range')
	assert.ok(/key: 'slsk_insp_w', min: 240, max: 560/.test(columns),
		'the Folders inspector lost its 240-560 range')
	// The queue popover's layout comes from --queue-w, so it must be resized by
	// setting that property, not the element width, or the panel's own rules
	// stop following the drag.
	assert.ok(/cssVar: '--queue-w'/.test(renderer),
		'the queue popover no longer resizes through --queue-w')
	// Only the sidebar collapses; a panel with a close button does not need a
	// second way to go away.
	assert.strictEqual((renderer.match(/collapsible: true/g) || []).length, 1)
})
