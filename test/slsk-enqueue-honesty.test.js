'use strict'
// Every download control in the Soulseek shop announced success the moment the
// enqueue call came back without throwing. In dry-run the main process answers
// { ok:false, error:'…' } and the UI still said "Downloading from 62 sources in
// parallel", still painted "13 queued", still ticked a checkmark -- for zero
// queued files. The refusal was invisible.
//
// These tests lift the shipped functions and the shipped click-handler bodies
// out of the sources and run them against a small element model, so they follow
// the real code rather than a restatement of it.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const SH = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')

// ── lifting ────────────────────────────────────────────────────────────────
function braceBody(src, openIdx) {
	let depth = 1
	let i = openIdx + 1
	while (depth > 0 && i < src.length) {
		const c = src[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return src.slice(openIdx + 1, i - 1)
}

function liftFn(src, name) {
	const at = src.indexOf('function ' + name + '(')
	assert.ok(at > -1, name + ' must still exist')
	return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

// The body of the arrow function that begins at `marker` (marker must end just
// before the arrow's opening brace).
function liftArrowBody(src, marker) {
	const at = src.indexOf(marker)
	assert.ok(at > -1, 'anchor must still exist: ' + marker.slice(0, 60))
	return braceBody(src, src.indexOf('{', at + marker.length - 1))
}

const SLSK_ENQUEUE = liftFn(R, '_slskEnqueue')
const DL_ALL = liftArrowBody(R,
	"section.querySelectorAll('.slsk-dl-all-btn').forEach(btn => {\n    btn.addEventListener('click', async e => ")

// ── a button that records what it was told to say ──────────────────────────
function fakeBtn(html) {
	return { innerHTML: html, textContent: html, disabled: false, dataset: { gi: '0' } }
}

function runEnqueue(apiResult, { thrown } = {}) {
	const snacks = []
	const env = {
		api: {
			slskEnqueueDownloads() {
				return thrown ? Promise.reject(new Error(thrown)) : Promise.resolve(apiResult)
			},
		},
	}
	return new Function('env', 'snacks', `
		const window = { api: env.api }
		function showSnackbar(msg) { snacks.push(String(msg)) }
		function shortPath(p) { return p }
		function _slskOfferCapacityChoice() { snacks.push('capacity-choice') }
		function _slskOfferForcedEnqueue() { snacks.push('forced-choice') }
		${SLSK_ENQUEUE}
		return _slskEnqueue([{ username: 'AnYeluX', filename: 'a.flac', size: 1 }])
	`)(env, snacks).then(res => ({ res, snacks }))
}

test('a refused enqueue says why instead of resolving quietly', async () => {
	const { res, snacks } = await runEnqueue({ ok: false, error: 'Dry run — nothing was queued' })
	assert.strictEqual(res.ok, false, 'the caller must be able to see the refusal')
	assert.deepStrictEqual(snacks, ['Dry run — nothing was queued'])
})

test('a refusal with no message still says something', async () => {
	const { snacks } = await runEnqueue({ ok: false })
	assert.deepStrictEqual(snacks, ['Could not queue those downloads'])
})

test('an accepted enqueue says nothing extra and reports what it added', async () => {
	const { res, snacks } = await runEnqueue({ ok: true, added: 1 })
	assert.strictEqual(res.ok, true)
	assert.deepStrictEqual(snacks, [])
})

test('a thrown enqueue answers in the same shape the callers read', async () => {
	const { res, snacks } = await runEnqueue(null, { thrown: 'socket hang up' })
	assert.strictEqual(res.ok, false)
	assert.strictEqual(snacks.length, 1)
})

test('a capacity refusal still goes to the capacity chooser, not the plain message', async () => {
	const { snacks } = await runEnqueue({ ok: false, capacity: { kind: 'space', text: 'no room' } })
	assert.deepStrictEqual(snacks, ['capacity-choice'])
})

// ── the results-card "Download all" button ─────────────────────────────────
function runDlAll(enqueueResult) {
	const snacks = []
	const btn = fakeBtn('<svg>original</svg>')
	const g = {
		username: 'AnYeluX', folderName: 'Kind of Blue',
		files: [{ filename: 'a.flac', size: 1 }, { filename: 'b.flac', size: 2 }],
	}
	const env = {
		btn, g, snacks,
		enqueue() { return Promise.resolve(enqueueResult) },
	}
	return new Function('env', `
		const { btn, g, snacks } = env
		const groups = [g, { username: 'Other', folderName: 'Kind of Blue', files: g.files }]
		const window = {
			PapaSpread: {
				planSpread(alts, o) { return g.files.map(f => ({ username: 'AnYeluX', filename: f.filename, size: f.size })) },
				planPeers() { return 62 },
			},
			PapaSlskFilters: null,
		}
		const _slskCardDownloads = new Map()
		function _slskUnit() { return g }
		function _slskAlbumUnit() { return null }
		function _slskCardKey(u, f) { return u + '::' + f }
		function _slskEnqueue(plan) { return env.enqueue(plan) }
		function _scheduleLibRescan() { snacks.push('rescan') }
		function _verifySurroundWhenDone() {}
		function _rerenderSlskSection() { snacks.push('repaint') }
		function showSnackbar(m) { snacks.push(String(m)) }
		const query = 'miles davis'
		return (async e => {${DL_ALL}})({ stopPropagation() {} })
	`)(env).then(() => ({ btn, snacks }))
}

test('the "downloading from N sources" line is never printed for a refused queue', async () => {
	const { btn, snacks } = await runDlAll({ ok: false, error: 'Dry run — x' })
	assert.ok(!snacks.some(s => /Downloading from/.test(s)),
		'a refusal must not be announced as a parallel download: ' + JSON.stringify(snacks))
	assert.strictEqual(btn.disabled, false, 'the button must come back, not sit on a checkmark')
	assert.strictEqual(btn.innerHTML, '<svg>original</svg>')
})

test('an accepted queue still announces the parallel sources', async () => {
	const { snacks } = await runDlAll({ ok: true, added: 2 })
	assert.ok(snacks.some(s => s === 'Downloading from 62 sources in parallel'), JSON.stringify(snacks))
})

// ── the shelves "Grab all N upgrades" batch ────────────────────────────────
const GRAB_ALL = liftArrowBody(SH, '`Download ${ups.length}`,\n        async () => ')

function runGrabAll(results) {
	const snacks = []
	let i = 0
	const env = {
		snacks,
		enqueue() { return Promise.resolve(results[i++]) },
	}
	return new Function('env', `
		const { snacks } = env
		const username = 'AnYeluX'
		const ups = [
			{ folderName: 'A', files: [{ filename: 'a.flac', size: 1 }] },
			{ folderName: 'B', files: [{ filename: 'b.flac', size: 1 }] },
		]
		const _slskCardDownloads = new Map()
		function shAsGroup(a) { return { username, folderName: a.folderName, files: a.files } }
		function shTrackProgress() {}
		function _slskCardKey(u, f) { return u + '::' + f }
		function _slskEnqueue(items) { return env.enqueue(items) }
		function _scheduleLibRescan() { snacks.push('rescan') }
		function showSnackbar(m) { snacks.push(String(m)) }
		return (async () => {${GRAB_ALL}})()
	`)(env).then(() => snacks)
}

test('"Queued N upgrades" counts only the albums the scheduler accepted', async () => {
	const snacks = await runGrabAll([{ ok: true, added: 1 }, { ok: false, error: 'Dry run — x' }])
	assert.ok(snacks.includes('Queued 1 upgrade from AnYeluX'), JSON.stringify(snacks))
})

test('a batch where every album was refused reports the refusal, not a count', async () => {
	const snacks = await runGrabAll([
		{ ok: false, error: 'Dry run — nothing was queued' },
		{ ok: false, error: 'Dry run — nothing was queued' },
	])
	assert.ok(!snacks.some(s => /^Queued /.test(s)), JSON.stringify(snacks))
	assert.ok(snacks.includes('Dry run — nothing was queued'), JSON.stringify(snacks))
	assert.ok(!snacks.includes('rescan'), 'nothing was queued, so nothing can arrive to rescan for')
})

// ── the folders tree "Download everything below" button ────────────────────
const DL_TREE = liftArrowBody(SH,
	"dlg.querySelector('#slskx-dl-tree')?.addEventListener('click', async ev => ")

function runDlTree(enqueueResult) {
	const btn = fakeBtn('Download everything below (1)')
	const snacks = []
	const env = {
		btn, snacks,
		enqueue() { return Promise.resolve(enqueueResult) },
	}
	return new Function('env', `
		const { btn, snacks } = env
		const T = { AUDIO_RE: /\\.(flac|mp3|wav)$/i }
		const l = { node: { files: [{ name: 'a.flac', fullPath: 'x/a.flac', size: 1 }], dirs: new Map() } }
		const username = 'AnYeluX'
		function audioBelow(node, out) {
			out = out || { files: [], size: 0 }
			for (const f of node.files) if (T.AUDIO_RE.test(f.name)) { out.files.push(f); out.size += f.size || 0 }
			for (const c of node.dirs.values()) audioBelow(c, out)
			return out
		}
		// One file is far under the confirmation thresholds, so this runs straight through.
		function confirmSubtree(count, size, go) { return go() }
		function _slskEnqueue(items) { return env.enqueue(items) }
		function _scheduleLibRescan() { snacks.push('rescan') }
		function showSnackbar(m) { snacks.push(String(m)) }
		return (async ev => {${DL_TREE}})({ target: btn })
	`)(env).then(() => ({ btn, snacks }))
}

test('a refused subtree download restores its label instead of claiming "1 queued"', async () => {
	const { btn } = await runDlTree({ ok: false, error: 'Dry run — x' })
	assert.strictEqual(btn.textContent, 'Download everything below (1)')
	assert.strictEqual(btn.disabled, false)
})

test('an accepted subtree download reports what the scheduler actually took', async () => {
	const { btn } = await runDlTree({ ok: true, added: 1 })
	assert.strictEqual(btn.textContent, '1 queued')
})
