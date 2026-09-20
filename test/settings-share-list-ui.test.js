'use strict'
// The Soulseek folder checklist, the off switch and the upload cap, as the
// settings panel actually paints them.
//
// The three-way "Share with other people" dropdown is gone. What replaced it
// has one rule that has to hold in the markup, in the paint and in the wiring:
// NOTHING CHANGES UNTIL HE PRESSES APPLY. Ticking a box must reach the store
// and the daemon exactly never; only the Apply button may. This file pins that,
// pins the ids the rest of the app and the other tests reference, and runs the
// real paint over a fake document so the row copy is the copy he sees.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const HTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')
const R = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')
const SHARE = require(path.join(root, 'src', 'slsk-share.js'))

// ── the markup ───────────────────────────────────────────────────────────────

test('the panel carries the folder list, its buttons and the off switch', () => {
	for (const id of ['slsk-enabled', 'slsk-enabled-text', 'slsk-enabled-timer-btn',
		'slsk-share-list', 'slsk-share-add-btn', 'slsk-share-apply-btn',
		'slsk-share-count', 'slsk-share-text',
		'slsk-upload-slots', 'slsk-upload-mbps', 'slsk-upload-text']) {
		assert.ok(HTML.includes('id="' + id + '"'), '#' + id + ' must be in index.html')
	}
})

test('the old three-way dropdown is gone from the page and from the renderer', () => {
	assert.ok(!HTML.includes('slsk-share-mode'), 'the select and its id are deleted')
	assert.ok(!HTML.includes('<option value="library">'), 'and its three options with it')
	assert.ok(!R.includes('slskShareModeGet('),
		'the renderer must not read the old mode any more')
	assert.ok(!R.includes('slskShareModeSet('),
		'and must never write it — the migration is the last read there will ever be')
})

test('the line that says nothing has happened yet is on the page', () => {
	assert.ok(HTML.includes('Nothing changes until you press Apply.'))
})

test('the pure module is loaded as a page script, so the list can collapse nesting', () => {
	// Without it the "already covered" row would need a round trip to main for
	// an answer the module already knows how to give.
	assert.ok(/<script src="slsk-share\.js"><\/script>/.test(HTML))
	const at = HTML.indexOf('<script src="slsk-share.js">')
	const rend = HTML.indexOf('<script src="renderer.js">')
	assert.ok(at > -1 && at < rend, 'it must load before renderer.js')
})

// ── Apply is the only thing that commits ─────────────────────────────────────

function liftFn(decl) {
	const at = R.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in renderer.js')
	let i = R.indexOf('{', at) + 1
	let depth = 1
	while (depth > 0 && i < R.length) {
		const c = R[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return { body: R.slice(at, i), start: at, end: i }
}

test('the only call that writes the folder list is inside _slskShareApply', () => {
	const apply = liftFn('async function _slskShareApply() {')
	const calls = []
	const re = /window\.api\.slskShareFoldersSet\(/g
	let m
	while ((m = re.exec(R))) calls.push(m.index)
	assert.strictEqual(calls.length, 1,
		'exactly one call site — a second one is a second way to commit')
	assert.ok(calls[0] > apply.start && calls[0] < apply.end,
		'ticking a box must not be able to reach the store or the daemon')
})

test('the tick handler only repaints', () => {
	const wire = liftFn('function _wireSoulseekSettings() {')
	const change = wire.body.slice(wire.body.indexOf("list.addEventListener('change'"))
	const handler = change.slice(0, change.indexOf("list.addEventListener('click'"))
	assert.ok(handler.includes('_paintSlskShareList()'), 'a tick repaints the list')
	assert.ok(!/window\.api\./.test(handler), 'and talks to main about nothing')
})

// ── the paint ────────────────────────────────────────────────────────────────

function node(id) {
	return {
		id, textContent: '', innerHTML: '', hidden: false, disabled: false,
		value: '', checked: false,
		querySelector() { return null },
		addEventListener() {},
	}
}

// Everything from the share-list state down to the off switch, run against a
// fake document. Lifted as one slice so the module-level tick state comes with
// the functions that read it.
const BLOCK = (() => {
	const from = R.indexOf('let _slskShareRows = []')
	const to = R.indexOf('// ── Go easy on my connection')
	assert.ok(from > -1 && to > from, 'the Soulseek settings block must still be here')
	return R.slice(from, to)
})()

function paint({ rows, saved, dlFiles, uploads, applyAnswer }) {
	const ids = ['slsk-share-list', 'slsk-share-count', 'slsk-share-busy',
		'slsk-share-apply-btn', 'slsk-share-text', 'slsk-enabled',
		'slsk-enabled-text', 'slsk-enabled-timer-btn']
	const els = {}
	for (const id of ids) els[id] = node(id)
	const said = []
	const env = { els, rows, saved, dlFiles: dlFiles || [], uploads: uploads || 0, said, SHARE,
		applyAnswer: applyAnswer || { ok: true, dirs: [], refused: [] } }
	return new Function('env', `
		const { els, said } = env
		const PapaSlskShare = env.SHARE
		let _dlLastFiles = env.dlFiles
		let _sharingStats = { activeUploads: env.uploads }
		function _dlCategory(s) { return s }
		function esc(s) {
			return String(s == null ? '' : s)
				.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
		}
		function showSnackbar(m) { said.push(String(m)) }
		function _mgConfirm() {}
		const document = { getElementById(id) { return els[id] || null } }
		// Apply's answer is whatever the test handed in; the repaint that
		// follows it reads nothing, so the snackbar is the only thing left.
		const window = { api: {
			slskShareFoldersSet: async () => env.applyAnswer,
			slskShareFoldersGet: async () => null,
		} }
		${BLOCK}
		_slskShareRows = env.rows
		_slskShareSaved = env.saved
		_paintSlskShareList()
		return {
			els, said,
			apply: _slskShareApply,
			enabled: _paintSlskEnabled,
			inFlight: _slskOffInFlightText,
			clock: _slskOffUntilClock,
			count: _slskShareCountText,
		}
	`)(env)
}

const DOWNLOADS = { path: '/mnt/data/MUSIC/Downloads', label: 'Downloads', source: 'download', selected: true, missing: false }
const MUSIC = { path: '/mnt/windows/Music', label: 'Music', source: 'music', selected: false, missing: false }
const AERO = {
	path: '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}',
	label: 'Aerosmith (1973) [Dolby Atmos]', source: 'music', selected: false, missing: false,
}

test('a ticked folder shows its own name and its whole path, escaped', () => {
	const out = paint({ rows: [{ ...AERO, selected: true }], saved: [AERO.path] })
	const html = out.els['slsk-share-list'].innerHTML
	assert.ok(html.includes('Aerosmith (1973) [Dolby Atmos]'), 'the folder name')
	assert.ok(html.includes('Aerosmith P&amp;D - Sony'),
		'the full path, with the ampersand escaped rather than left to the parser')
	assert.ok(!html.includes('P&D - Sony}<'), 'the raw ampersand must not reach the page')
	assert.ok(html.includes('checked'), 'and it is ticked')
})

test('the count says what actually goes out', () => {
	assert.strictEqual(
		paint({ rows: [DOWNLOADS], saved: [DOWNLOADS.path] }).els['slsk-share-count'].textContent,
		'Sharing 1 folder')
	assert.strictEqual(
		paint({ rows: [DOWNLOADS, { ...MUSIC, selected: true }], saved: [] })
			.els['slsk-share-count'].textContent,
		'Sharing 2 folders')
	assert.strictEqual(
		paint({ rows: [{ ...DOWNLOADS, selected: false }], saved: [] })
			.els['slsk-share-count'].textContent,
		'Not sharing anything')
})

test('a folder inside another ticked folder is greyed and says which one covers it', () => {
	const out = paint({
		rows: [{ ...MUSIC, selected: true }, { ...AERO, selected: true }],
		saved: [MUSIC.path, AERO.path],
	})
	const html = out.els['slsk-share-list'].innerHTML
	assert.ok(html.includes("Already covered — this folder is inside /mnt/windows/Music, which you're sharing."),
		html)
	assert.ok(html.includes('mcs-share-row-covered'), 'and the row is painted as covered')
	// Only the parent is what would reach the daemon, so only the parent counts.
	assert.strictEqual(out.els['slsk-share-count'].textContent, 'Sharing 1 folder')
})

test('a folder that is no longer there says so and offers to leave the list', () => {
	const out = paint({
		rows: [{ ...AERO, selected: true, missing: true }],
		saved: [AERO.path],
	})
	const html = out.els['slsk-share-list'].innerHTML
	assert.ok(html.includes("can't find this folder any more"), html)
	assert.ok(html.includes('Take it off the list'))
	assert.ok(html.includes('mcs-share-row-missing'))
	// Never silently sent to the daemon, so never counted as shared.
	assert.strictEqual(out.els['slsk-share-count'].textContent, 'Not sharing anything')
})

test('a hand-picked folder can leave the list; a music folder cannot', () => {
	const custom = paint({
		rows: [{ path: '/mnt/data/Extra', label: 'Extra', source: 'custom', selected: true, missing: false }],
		saved: ['/mnt/data/Extra'],
	})
	assert.ok(custom.els['slsk-share-list'].innerHTML.includes('data-slsk-share-drop'))
	const music = paint({ rows: [MUSIC], saved: [] })
	assert.ok(!music.els['slsk-share-list'].innerHTML.includes('data-slsk-share-drop'),
		'music and download folders belong to other parts of the app')
})

test('Apply is dead until something is different from what is stored', () => {
	const same = paint({ rows: [DOWNLOADS], saved: [DOWNLOADS.path] })
	assert.strictEqual(same.els['slsk-share-apply-btn'].disabled, true)
	const changed = paint({ rows: [DOWNLOADS, { ...MUSIC, selected: true }], saved: [DOWNLOADS.path] })
	assert.strictEqual(changed.els['slsk-share-apply-btn'].disabled, false)
})

test('a different tick ORDER is not a change', () => {
	// main stores his tick order; the list paints in candidate order. A row
	// swap must not light Apply up and invite a pointless daemon bounce.
	const out = paint({
		rows: [DOWNLOADS, { ...MUSIC, selected: true }],
		saved: [MUSIC.path, DOWNLOADS.path],
	})
	assert.strictEqual(out.els['slsk-share-apply-btn'].disabled, true)
})

test('downloads in progress are named before Apply is pressed, not after', () => {
	const idle = paint({ rows: [DOWNLOADS], saved: [DOWNLOADS.path] })
	assert.strictEqual(idle.els['slsk-share-busy'].hidden, true)
	const busy = paint({
		rows: [DOWNLOADS], saved: [DOWNLOADS.path],
		dlFiles: [{ state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'queued' }],
	})
	assert.strictEqual(busy.els['slsk-share-busy'].hidden, false)
	assert.strictEqual(busy.els['slsk-share-busy'].textContent,
		'3 downloads are running. Changing this stops them and starts them again ' +
		'on their own — it can take a couple of minutes.')
	const one = paint({ rows: [DOWNLOADS], saved: [DOWNLOADS.path], dlFiles: [{ state: 'active' }] })
	assert.ok(one.els['slsk-share-busy'].textContent.startsWith('1 download is running.'),
		one.els['slsk-share-busy'].textContent)
})

// ── the off switch ───────────────────────────────────────────────────────────

test('the switch says what each state actually means', () => {
	const out = paint({ rows: [], saved: [] })
	out.enabled({ enabled: true, offUntil: null })
	assert.strictEqual(out.els['slsk-enabled'].checked, true)
	assert.strictEqual(out.els['slsk-enabled-text'].textContent,
		'On — you can search and download, and people can take files you share.')
	assert.strictEqual(out.els['slsk-enabled-timer-btn'].hidden, true)

	out.enabled({ enabled: false, offUntil: null })
	assert.strictEqual(out.els['slsk-enabled'].checked, false)
	assert.strictEqual(out.els['slsk-enabled-text'].textContent,
		'Off — no searching, no downloading, nobody can take anything from you.')
	assert.strictEqual(out.els['slsk-enabled-timer-btn'].hidden, false)
	assert.strictEqual(out.els['slsk-enabled-timer-btn'].textContent, 'Back on in an hour')

	const at = new Date(); at.setHours(21, 40, 0, 0)
	out.enabled({ enabled: false, offUntil: at.getTime() })
	assert.strictEqual(out.els['slsk-enabled-text'].textContent,
		'Off until 21:40 — it comes back on by itself.')
	assert.strictEqual(out.els['slsk-enabled-timer-btn'].textContent, 'Turn it on now')
})

test('turning it off is only confirmed when something is actually in flight', () => {
	const quiet = paint({ rows: [], saved: [] })
	assert.strictEqual(quiet.inFlight(), '', 'nothing moving, nothing to ask about')

	const both = paint({ rows: [], saved: [], dlFiles: [{ state: 'active' }, { state: 'active' }], uploads: 1 })
	assert.strictEqual(both.inFlight(),
		'2 downloads are running and 1 person is taking a file from you. ' +
		'Turning Soulseek off stops all of it. Your downloads go back on the ' +
		'list and start again when you turn it back on.')

	const upOnly = paint({ rows: [], saved: [], uploads: 3 })
	assert.strictEqual(upOnly.inFlight(),
		'3 people are taking files from you. Turning Soulseek off stops all of it.',
		'no downloads, so no promise about downloads coming back')
})

// main drops a folder its refusal predicate will not let out — a symlink to
// home, a whole drive, anything that reached the channel it should not have.
// A row disappearing with nothing said is the silent behaviour this panel
// exists to stop, so Apply says which folder and why.
test('a folder main refused is named, not quietly dropped', async () => {
	const out = paint({
		rows: [DOWNLOADS], saved: [DOWNLOADS.path],
		applyAnswer: {
			ok: true, dirs: ['/mnt/data/MUSIC/Downloads'],
			refused: [{ path: '/', reason: 'drive',
				error: "That's a whole drive. Pick the folder your music is actually in." }],
		},
	})
	await out.apply()
	assert.ok(out.said.some(m => /whole drive/.test(m)),
		'he is told which folder did not go out and why: ' + JSON.stringify(out.said))
})

test('a clean apply still just says how much is shared', async () => {
	const out = paint({
		rows: [DOWNLOADS], saved: [DOWNLOADS.path],
		applyAnswer: { ok: true, dirs: ['/mnt/data/MUSIC/Downloads'], refused: [] },
	})
	await out.apply()
	assert.ok(out.said.some(m => /Sharing 1 folder/.test(m)), JSON.stringify(out.said))
})
