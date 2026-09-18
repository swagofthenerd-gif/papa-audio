'use strict'
// The season shortcut stopped at nine (Movies & TV audit N19).
//
// The detail page read a bare digit out of event.key and looked for an option
// with that value, so Doctor Who, Grey's Anatomy and every other long-runner
// had a keyboard shortcut for the first nine seasons of its run and silence
// after that — with the help sheet still advertising "1–9 Pick a season" as
// though that were the whole story.
//
// Two halves are tested: the pure mapping in video-keymap.js, and the DOM half
// in renderer.js lifted out of the shipped source and driven against a fake
// season <select>. The mapping reads event.CODE rather than event.key, because
// Shift+1 is '!' on a US layout and '"' on a UK one — a shifted digit has no
// portable key.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')
const keymap = require(path.join(root, 'src', 'video-keymap.js'))

const ev = (code, extra = {}) => ({ code, key: /Digit(\d)/.test(code) ? RegExp.$1 : '', ...extra })

test('1 through 9 are still themselves', () => {
  for (let n = 1; n <= 9; n++) {
    assert.strictEqual(keymap.seasonFromKey(ev('Digit' + n)), n)
  }
})

test('0 is season ten, not season zero', () => {
  assert.strictEqual(keymap.seasonFromKey(ev('Digit0')), 10)
})

test('Shift adds ten, so 11 to 19 are reachable', () => {
  for (let n = 1; n <= 9; n++) {
    assert.strictEqual(keymap.seasonFromKey(ev('Digit' + n, { shiftKey: true })), 10 + n)
  }
  assert.strictEqual(keymap.seasonFromKey(ev('Digit0', { shiftKey: true })), 20)
})

test('the numpad works too', () => {
  assert.strictEqual(keymap.seasonFromKey(ev('Numpad4')), 4)
  assert.strictEqual(keymap.seasonFromKey(ev('Numpad4', { shiftKey: true })), 14)
})

test('a shifted digit is read from the physical key, not the symbol', () => {
  // What a US keyboard actually sends for Shift+3. Reading `key` would see '#'
  // and find no season; reading `code` sees Digit3.
  assert.strictEqual(keymap.seasonFromKey({ code: 'Digit3', key: '#', shiftKey: true }), 13)
  // And a UK keyboard's Shift+2.
  assert.strictEqual(keymap.seasonFromKey({ code: 'Digit2', key: '"', shiftKey: true }), 12)
})

test('typing in a box, and the browser and OS chords, are never seasons', () => {
  assert.strictEqual(keymap.seasonFromKey(ev('Digit3'), { isInput: true }), null)
  assert.strictEqual(keymap.seasonFromKey(ev('Digit3', { ctrlKey: true })), null)
  assert.strictEqual(keymap.seasonFromKey(ev('Digit3', { metaKey: true })), null)
  assert.strictEqual(keymap.seasonFromKey(ev('Digit3', { altKey: true })), null)
  assert.strictEqual(keymap.seasonFromKey({ code: 'KeyP', key: 'p' }), null)
  assert.strictEqual(keymap.seasonFromKey(null), null)
})

test('the theatre keeps its own digits — they seek, they do not pick seasons', () => {
  assert.deepStrictEqual(keymap.resolve({ key: '3' }), { action: 'seekTo', arg: 0.3 })
})

// ── The DOM half, lifted from the shipped renderer ────────────────────────────

function liftPicker() {
  const open = RENDERER.indexOf('function _pickSeasonByKey(e) {')
  assert.ok(open > -1, 'the detail page must still have a season-by-digit picker')
  let depth = 0
  let i = RENDERER.indexOf('{', open)
  const start = i
  do {
    if (RENDERER[i] === '{') depth++
    else if (RENDERER[i] === '}') depth--
    i++
  } while (depth > 0 && i < RENDERER.length)
  const body = RENDERER.slice(start + 1, i - 1)
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'inInputNow', 'Event', 'e', body)
}

const pick = liftPicker()

// A season picker with the seasons a show actually has.
function selectWith(seasons) {
  const el = {
    value: '',
    options: seasons.map(n => ({ value: String(n) })),
    changes: 0,
    dispatchEvent(evt) { if (evt && evt.type === 'change') this.changes++; return true },
  }
  return el
}

function drive(sel, event) {
  const doc = { getElementById: (id) => (id === 'video-season-select' ? sel : null) }
  function FakeEvent(type) { this.type = type }
  return pick({ PapaVideoKeymap: keymap }, doc, () => false, FakeEvent, event)
}

test('pressing 0 on a fourteen-season show selects season ten', () => {
  const sel = selectWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  assert.strictEqual(drive(sel, ev('Digit0')), true)
  assert.strictEqual(sel.value, '10')
  assert.strictEqual(sel.changes, 1, 'the picker is told, so the episodes reload')
})

test('Shift+3 on the same show selects season thirteen', () => {
  const sel = selectWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  assert.strictEqual(drive(sel, { code: 'Digit3', key: '#', shiftKey: true }), true)
  assert.strictEqual(sel.value, '13')
})

test('a season the show does not have is left alone, not swallowed', () => {
  const sel = selectWith([1, 2, 3, 4])
  assert.strictEqual(drive(sel, ev('Digit0')), false, 'no season ten to pick')
  assert.strictEqual(sel.value, '', 'and nothing was selected')
  assert.strictEqual(sel.changes, 0)
})

test('with no season picker on the page the digit does nothing', () => {
  const doc = { getElementById: () => null }
  function FakeEvent(type) { this.type = type }
  assert.strictEqual(pick({ PapaVideoKeymap: keymap }, doc, () => false, FakeEvent, ev('Digit2')), false)
})

// ── The help sheet ────────────────────────────────────────────────────────────

test('the keyboard help says where the digits now reach', () => {
  assert.match(keymap.SEASON_KEYS_LABEL, /0/, 'the sheet must mention 0')
  assert.match(keymap.SEASON_KEYS_LABEL, /Shift/, 'and Shift')
  assert.match(keymap.SEASON_KEYS_DESC, /season 10/i, 'and say what 0 does')
  // And the sheet must be reading those, not a second copy of the words.
  assert.match(RENDERER, /window\.PapaVideoKeymap\.SEASON_KEYS_LABEL/,
    'the help entry must take its label from the keymap')
  assert.match(RENDERER, /window\.PapaVideoKeymap\.SEASON_KEYS_DESC/,
    'and its description too')
})
