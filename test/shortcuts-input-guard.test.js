'use strict'
// Five shortcuts were tested before the handler asked whether he was typing.
//
// The keyboard handler works out `inInput` — is the focus in a text box, a
// textarea, a dropdown, a rich-text field — and then, quite a long way further
// down, bails out with `if (inInput) return`. Everything tested ABOVE that line
// has to carry its own `&& !inInput`, and Undo, sitting right there among them,
// does. Like this track, Sleep timer, Auto-skip short tracks, Skip interludes
// and Save the queue did not.
//
// On the shipped defaults all five are Ctrl chords, so nothing happens today.
// But the rebinding dialog stores whatever key is pressed, with no requirement
// for a modifier, so a single plain letter is a binding he can make in two
// clicks — and from then on typing that letter into any search box fires the
// shortcut instead of typing.
//
// Ctrl+K (search) and Ctrl+Shift+P (commands) are deliberately live while
// typing and are left alone; the handler says so where they are tested.
//
// The real handler's shortcut tests are lifted out of renderer.js and run
// against the real matchesShortcut and the real inInputNow.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// Stops at the closing brace in column 0 rather than at the next `function`,
// so a lifted helper cannot drag the module-level `var _shortcuts = {}` in
// behind it and quietly shadow the bindings under test.
function liftTopLevel(opener, what) {
	const start = src.indexOf(opener)
	assert.ok(start > -1, what + ' must still exist in renderer.js')
	const end = src.indexOf('\n}\n', start)
	assert.ok(end > start, what + ' must still close at column 0')
	return src.slice(start, end + 3)
}

function lift(name) {
	return liftTopLevel('function ' + name + '(', name)
}

function liftBetween(startAnchor, endAnchor, what) {
	const at = src.indexOf(startAnchor)
	assert.ok(at > -1, what + ' must still exist in renderer.js')
	const end = src.indexOf(endAnchor, at)
	assert.ok(end > at, what + ' must still end at its anchor')
	return src.slice(at, end)
}

// The shortcut machinery itself, used for real rather than reimplemented — the
// point of the test is what the shipped matching does with a rebound key.
const HELPERS = [
	liftTopLevel('var SHORTCUT_KEY_ALIASES = {', 'the key-alias table'),
	liftTopLevel('var DEFAULT_SHORTCUTS = {', 'the default bindings'),
	lift('inInputNow'),
	lift('normalizeShortcutKey'),
	lift('normalizeShortcut'),
	lift('comboFromEvent'),
	lift('matchesShortcut'),
	// A one-liner, so it ends at its own newline rather than at the next
	// column-0 brace.
	liftBetween('function getShortcut(action)', '\n', 'getShortcut'),
].join('\n')

// Everything the handler tests between working out `inInput` and reaching the
// F6 region-cycling block, which is where the shortcuts in question live.
const BLOCK = liftBetween(
	'    const inInput = inInputNow(e)',
	'    // F6 / Ctrl+Tab',
	"the keyboard handler's pre-guard shortcut tests",
)

// Fire one key at the lifted block and report which action ran.
function press({ key, ctrl, shift, alt, tag, shortcuts }) {
	const fired = []
	const e = {
		key,
		code: key === ' ' ? 'Space' : 'Key' + String(key).toUpperCase(),
		ctrlKey: !!ctrl, shiftKey: !!shift, altKey: !!alt, metaKey: false,
		target: { tagName: tag || 'BODY', isContentEditable: tag === 'CE' },
		preventDefault() {},
	}
	if (tag === 'CE') e.target.tagName = 'DIV'

	new Function('e', 'fired', '_shortcuts', 'state', `
		${HELPERS}
		const toggleCommandPalette = w => fired.push('palette:' + (w || 'search'))
		const toggleTrackLike = () => fired.push('likeTrack')
		const undoLastAction = () => fired.push('undo')
		const setSleepTimer = () => fired.push('sleepTimer')
		const saveCurrentQueue = () => fired.push('saveQueue')
		const showSnackbar = () => {}
		;(function () {
			${BLOCK}
		})()
	`)(e, fired, shortcuts || {}, {
		queue: [{ filePath: '/m/a.flac' }], queueIndex: 0,
		skipShortTracks: false, skipInterludes: false,
	})

	return fired
}

// What he would have to do to hit this: open the shortcuts dialog and press a
// single letter. The dialog stores exactly that.
const BARE = {
	likeTrack: 'l',
	sleepTimer: 'z',
	skipShort: 'k',
	skipInterludes: 'i',
	saveQueue: 'q',
	undo: 'u',
}

const TYPING_IN = ['INPUT', 'TEXTAREA', 'SELECT', 'CE']

test('a shortcut rebound to a plain letter does not fire while he is typing', () => {
	for (const [action, key] of Object.entries(BARE)) {
		for (const tag of TYPING_IN) {
			const fired = press({ key, tag, shortcuts: BARE })
			assert.deepStrictEqual(fired, [],
				`typing "${key}" in a ${tag} must type it, not run ${action}`)
		}
	}
})

test('the same letter still works when he is not typing', () => {
	const expected = {
		likeTrack: 'likeTrack', sleepTimer: 'sleepTimer', saveQueue: 'saveQueue', undo: 'undo',
	}
	for (const [action, key] of Object.entries(expected)) {
		const fired = press({ key: BARE[action], tag: 'BODY', shortcuts: BARE })
		assert.deepStrictEqual(fired, [key], action + ' must still work outside a text box')
	}
	// The two toggles have no callback of their own; they flip state and say so,
	// so they are checked by the fact that nothing else swallowed the key.
	for (const action of ['skipShort', 'skipInterludes']) {
		assert.deepStrictEqual(press({ key: BARE[action], tag: 'BODY', shortcuts: BARE }), [],
			action + ' consumes its own key outside a text box')
	}
})

test('Ctrl+K and Ctrl+Shift+P stay live while typing, on purpose', () => {
	assert.deepStrictEqual(
		press({ key: 'k', ctrl: true, tag: 'INPUT' }), ['palette:search'],
		'the omnibox is meant to be reachable from inside a text box')
	assert.deepStrictEqual(
		press({ key: 'p', ctrl: true, shift: true, tag: 'INPUT' }), ['palette:commands'])
})

test('the shipped defaults are unaffected either way', () => {
	// Ctrl+Shift+L is the default for Like this track: a chord, so it was never
	// reachable by plain typing. It must keep working outside a text box, and
	// must not start firing inside one.
	assert.deepStrictEqual(press({ key: 'l', ctrl: true, shift: true, tag: 'BODY' }), ['likeTrack'])
	assert.deepStrictEqual(press({ key: 'l', ctrl: true, shift: true, tag: 'INPUT' }), [])
	// And an ordinary letter with nothing bound to it is just a letter.
	assert.deepStrictEqual(press({ key: 'l', tag: 'INPUT' }), [])
})
