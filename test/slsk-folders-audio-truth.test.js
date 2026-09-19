'use strict'
// The folders view counted one thing and queued another. "Audio only" is on by
// default, so a folder of artwork and logs rendered no rows and said "This
// folder is empty." -- beside "1.9 GB below this point" and "Download
// everything below (1)", which then queued nothing, because the label came
// from node.fileCount (every file) while the download filtered to audio.
// The root of a big peer offered 1780 GB on a single unconfirmed click.
//
// audioBelow and confirmSubtree are lifted out of slsk-shop-ui.js.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SH = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-shop-ui.js'), 'utf8')

function liftFn(decl) {
	const at = SH.indexOf(decl)
	assert.ok(at > -1, decl + ' must still exist in slsk-shop-ui.js')
	let i = SH.indexOf('{', at) + 1
	let depth = 1
	while (depth > 0 && i < SH.length) {
		const c = SH[i]
		if (c === '{') depth++
		else if (c === '}') depth--
		i++
	}
	return SH.slice(at, i)
}

const AUDIO_BELOW = liftFn('function audioBelow(node, out) {')
const CONFIRM = liftFn('function confirmSubtree(count, size, go) {')
const THRESHOLDS = (() => {
	const f = SH.match(/const SUBTREE_CONFIRM_FILES = \d+/)[0]
	const b = SH.match(/const SUBTREE_CONFIRM_BYTES = [^\n]+/)[0]
	return f + '\n' + b
})()

function dir(files, kids) {
	return { files: files || [], dirs: new Map(Object.entries(kids || {})) }
}

function below(node) {
	return new Function('node', `
		const T = { AUDIO_RE: /\\.(flac|mp3|wav|m4a|ogg)$/i }
		${AUDIO_BELOW}
		return audioBelow(node)
	`)(node)
}

test('"everything below" counts the audio the download will actually queue', () => {
	// One audio track and a pile of artwork, logs and a cue sheet.
	const tree = dir(
		[{ name: 'folder.jpg', size: 900000 }, { name: 'rip.log', size: 4000 }, { name: 'x.cue', size: 1000 }],
		{ disc1: dir([{ name: '01.flac', size: 30000000 }, { name: 'back.jpg', size: 800000 }]) },
	)
	const b = below(tree)
	assert.strictEqual(b.files.length, 1, 'node.fileCount would have said 5')
	assert.strictEqual(b.size, 30000000, 'the artwork must not be counted as audio to download')
})

test('a folder holding only artwork has nothing to offer below it', () => {
	const b = below(dir([{ name: 'folder.jpg', size: 900000 }]))
	assert.strictEqual(b.files.length, 0)
	assert.strictEqual(b.size, 0)
})

function confirm(count, size) {
	const log = []
	new Function('log', `
		${THRESHOLDS}
		const username = 'AnYeluX'
		function esc(s) { return String(s) }
		function fmtSize(n) { return n + ' B' }
		function _mgConfirm(title, body, label) { log.push({ asked: true, title, body }) }
		${CONFIRM}
		confirmSubtree(${count}, ${size}, () => log.push({ ran: true }))
	`)(log)
	return log
}

test('a small subtree downloads straight away, as it always did', () => {
	assert.deepStrictEqual(confirm(3, 90000000), [{ ran: true }])
})

test('a subtree of many files states the real totals and waits', () => {
	const log = confirm(1800, 5)
	assert.strictEqual(log.length, 1)
	assert.strictEqual(log[0].asked, true, 'the download must not start unasked')
	assert.ok(/1800 files/.test(log[0].title), log[0].title)
})

test('a subtree that is merely huge is confirmed too, however few files', () => {
	const log = confirm(4, 900 * 1024 * 1024 * 1024)
	assert.strictEqual(log[0].asked, true)
	assert.ok(/966367641600 B/.test(log[0].body), 'the confirmation must state the size: ' + log[0].body)
})

test('cancelling the confirmation never starts the download', () => {
	// _mgConfirm has no cancel callback: cancelling simply never calls back.
	const log = confirm(1800, 5)
	assert.ok(!log.some(e => e.ran), JSON.stringify(log))
})

test('the folders view no longer labels the button from the all-files count', () => {
	assert.ok(!/Download everything below \(\$\{l\.node\.fileCount\}\)/.test(SH),
		'node.fileCount counts artwork and logs the button will not queue')
	assert.ok(/Download everything below \(\$\{belowAudio\.files\.length\}/.test(SH))
})

test('an "empty" folder that is only hiding non-audio files says so, with a way back', () => {
	assert.ok(/non-audio file\$\{hiddenHere !== 1 \? 's' : ''\} hidden/.test(SH), 'the copy must name what is hidden')
	assert.ok(/id="slskx-show-hidden"/.test(SH), 'and offer the toggle')
	assert.ok(/#slskx-show-hidden'\)\?\.addEventListener/.test(SH), 'and the toggle must be wired')
})

// ── #16: one size formatter ─────────────────────────────────────────────────
// The folders view had its own rounder that stopped at GB, so a big peer's
// root printed "1780.1 GB" and "2225.3 GB" where the rest of the app says TB.
const FMT = liftFn('function fmtSize(n) {')
const FMT_LOCAL = liftFn('function _fmtSizeLocal(n) {')

function fmt(n, withShelves) {
	return new Function('n', `
		const SH = ${withShelves ? `{ fmtSize(b) {
			let x = Number(b) || 0
			const u = ['B','KB','MB','GB','TB','PB']
			let i = 0
			while (x >= 1024 && i < u.length - 1) { x /= 1024; i++ }
			let s = i <= 1 ? String(Math.round(x)) : x.toFixed(1).replace(/\\.0$/, '')
			return s + ' ' + u[i]
		} }` : 'null'}
		${FMT}
		${FMT_LOCAL}
		return fmtSize(n)
	`)(n)
}

test('a terabyte-scale folder is printed in TB, not four digits of GB', () => {
	const tb = 1780.1 * 1024 * 1024 * 1024
	assert.strictEqual(fmt(tb, true), '1.7 TB')
	assert.ok(!/\d{4}/.test(fmt(tb, true)), fmt(tb, true))
})

test('the folders view uses the shared formatter when it is loaded', () => {
	// Same bytes, both entry points: one formatter, one answer.
	const bytes = 2225.3 * 1024 * 1024 * 1024
	assert.strictEqual(fmt(bytes, true), '2.2 TB')
})

test('without the shelves module it still formats rather than throwing', () => {
	assert.strictEqual(fmt(2048, false), '2 KB')
})
