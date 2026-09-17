'use strict'
// The assistant's "are you sure?" before a Soulseek download was switched off by
// the word "get".
//
// The rule the code sets for itself is written above the table: a consequential
// step "the person did not ask for in so many words" is previewed first, and a
// message that names the action is already permission. The test for naming the
// action was a word list — download, get, grab, fetch, save — matched anywhere
// in his last message.
//
// "get me something chill" is a request for music. The assistant deciding that
// means fetching a stranger's file off Soulseek is exactly the case the preview
// exists for, and the word "get" in his own sentence turned it off.
//
// "save" was worse than loose, it was wrong: "save this queue" is about the
// queue, and it authorised a download in the same turn purely because the word
// appeared somewhere.
//
// The real table and the real gate are lifted out of renderer.js and run.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftTopLevel(opener, what) {
	const start = src.indexOf(opener)
	assert.ok(start > -1, what + ' must still exist in renderer.js')
	const end = src.indexOf('\n}\n', start)
	assert.ok(end > start, what + ' must still close at column 0')
	return src.slice(start, end + 3)
}

const TABLE = liftTopLevel('var _CONSEQUENTIAL_TOOLS = {', 'the consequential-tool table')
const GATE = liftTopLevel('function _toolPreviewIfNeeded(', '_toolPreviewIfNeeded')

// Run the real gate for one tool against one last-user-message. Returns whether
// he was shown the confirmation. _mgConfirm is called synchronously inside the
// promise the gate returns, so the answer is known as soon as the call returns.
function wasAsked(tool, lastUserMessage, input) {
	const shown = []
	const chatState = {
		history: [
			{ role: 'user', content: 'something earlier' },
			{ role: 'assistant', content: 'download all of it' },   // not his words
			{ role: 'user', content: lastUserMessage },
		],
	}

	new Function('chatState', 'shown', `
		const esc = s => String(s)
		const document = { getElementById: () => null }
		const setInterval = () => 0
		const clearInterval = () => {}
		function _mgConfirm(question, note, label, onConfirm) { shown.push(question) }
		${TABLE}
		${GATE}
		_toolPreviewIfNeeded(${JSON.stringify(tool)}, ${JSON.stringify(input || { query: 'something chill' })})
	`)(chatState, shown)

	return shown.length > 0
}

// ── the case that started this ──────────────────────────────────────────────

test('"get me something chill" is asked about before anything is downloaded', () => {
	assert.strictEqual(wasAsked('auto_download', 'get me something chill'), true,
		'asking for music is not asking for a download')
})

test('a plain "get" in any ordinary sentence no longer counts as permission', () => {
	for (const msg of [
		'get me something chill',
		'can you get something moody going',
		'what do you get if you cross jazz and dub',
		'get the volume down a bit',
	]) {
		assert.strictEqual(wasAsked('auto_download', msg), true, 'must still ask: ' + msg)
	}
})

test('"save this queue" no longer authorises a download in the same breath', () => {
	assert.strictEqual(wasAsked('auto_download', 'save this queue'), true,
		'a queue instruction is not permission to fetch files from strangers')
	assert.strictEqual(wasAsked('auto_download', 'save that for later'), true)
})

// ── what must still go straight through ─────────────────────────────────────

test('naming the action really is permission, and still skips the dialog', () => {
	for (const msg of [
		'download Wish You Were Here',
		'Download the new Radiohead album',
		'downloading that one please',
		're-download it, the first one was broken',
		'grab that album for me',
		'go and fetch the Miles Davis one',
		'fetching the whole discography would be great',
	]) {
		assert.strictEqual(wasAsked('auto_download', msg), false, 'must not ask again: ' + msg)
	}
})

test('"get" counts when the sentence says where from', () => {
	assert.strictEqual(wasAsked('auto_download', 'get Wish You Were Here from Soulseek'), false,
		'that names the action and the place')
	assert.strictEqual(wasAsked('auto_download', 'get it off slsk'), true,
		'"off" is not "from" — near-misses still ask rather than assume')
})

test('the word has to be his, not the assistant\'s', () => {
	// The gate reads the last USER message. The assistant saying "download" in
	// the turn before must never stand in for his permission.
	assert.strictEqual(wasAsked('auto_download', 'something chill please'), true)
})

// ── the other consequential tool is untouched ───────────────────────────────

test('clearing the queue still behaves as it did', () => {
	assert.strictEqual(wasAsked('clear_queue', 'clear the queue', {}), false)
	assert.strictEqual(wasAsked('clear_queue', 'play something nice', {}), true)
})

test('a tool that is not consequential is never previewed', () => {
	assert.strictEqual(wasAsked('play_from_library', 'get me something chill'), false)
})
