'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The matcher is extracted and RUN, not read: the whole point of it is what it
// says about specific KeyboardEvents, and reading the source cannot tell me
// whether Shift+p matches a binding written 'Control+Shift+p'.
function loadShortcuts() {
  const start = RENDERER.indexOf('var DEFAULT_SHORTCUTS = {')
  const end = RENDERER.indexOf('function saveShortcuts()')
  assert.ok(start >= 0 && end > start, 'found the shortcut block')
  const src = RENDERER.slice(start, end)
    // The store read needs a window that is not here.
    .replace(/var _savedShortcuts = window\.PapaLocal[^\n]*\n/, 'var _savedShortcuts = {}\n')
  // eslint-disable-next-line no-new-func
  return new Function(src + `
    return { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, getShortcut, matchesShortcut,
             normalizeShortcut, comboFromEvent, setBinding: (a, c) => { _shortcuts[a] = c } }
  `)()
}

// A KeyboardEvent as the handler sees it.
const ev = (key, mods = {}) => ({
  key,
  code: key === ' ' || key === 'Space' ? 'Space' : 'Key' + String(key).toUpperCase(),
  ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift,
})

test('normalizeShortcut gives one spelling for equivalent combinations', () => {
  const S = loadShortcuts()
  const same = ['Control+Shift+p', 'ctrl+shift+P', 'Cmd+Shift+p', 'Meta+shift+p']
  const canon = same.map(S.normalizeShortcut)
  assert.strictEqual(new Set(canon).size, 1, canon.join(' | '))
  assert.strictEqual(canon[0], 'Control+Shift+p')
  // Modifier order in the input must not matter.
  assert.strictEqual(S.normalizeShortcut('Shift+Control+k'), S.normalizeShortcut('Control+Shift+k'))
})

test('a shifted letter matches a lower-case binding', () => {
  // e.key is 'P' for Shift+p, which is why the old literal tests had to spell
  // some bindings upper-case and others lower-case.
  const S = loadShortcuts()
  assert.strictEqual(S.matchesShortcut('commandPalette', ev('P', { ctrl: true, shift: true })), true)
  assert.strictEqual(S.matchesShortcut('commandPalette', ev('p', { ctrl: true, shift: true })), true)
})

test('the space bar is matched by code, not by key', () => {
  const S = loadShortcuts()
  assert.strictEqual(S.matchesShortcut('playPause', ev(' ')), true)
})

test('a modifier pressed alone is not a binding', () => {
  const S = loadShortcuts()
  for (const k of ['Control', 'Shift', 'Alt', 'Meta']) {
    assert.strictEqual(S.comboFromEvent(ev(k, { ctrl: true })), '', k)
  }
})

test('a bare key does not fire a modified binding, or the reverse', () => {
  const S = loadShortcuts()
  // 's' is shuffle, Control+s is save-queue: the pair that made the old
  // ordering load-bearing.
  assert.strictEqual(S.matchesShortcut('toggleShuffle', ev('s')), true)
  assert.strictEqual(S.matchesShortcut('toggleShuffle', ev('s', { ctrl: true })), false)
  assert.strictEqual(S.matchesShortcut('saveQueue', ev('s', { ctrl: true })), true)
  assert.strictEqual(S.matchesShortcut('saveQueue', ev('s')), false)
  // And q / Control+q.
  assert.strictEqual(S.matchesShortcut('toggleQueue', ev('q')), true)
  assert.strictEqual(S.matchesShortcut('addToQueue', ev('q', { ctrl: true })), true)
  assert.strictEqual(S.matchesShortcut('toggleQueue', ev('q', { ctrl: true })), false)
})

test('rebinding takes effect, which is the whole point', () => {
  const S = loadShortcuts()
  assert.strictEqual(S.matchesShortcut('toggleMute', ev('m')), true)
  S.setBinding('toggleMute', 'Control+Alt+m')
  assert.strictEqual(S.matchesShortcut('toggleMute', ev('m')), false)
  assert.strictEqual(S.matchesShortcut('toggleMute', ev('m', { ctrl: true, alt: true })), true)
})

test('every default binding is unique', () => {
  // Two actions on one combination means one of them can never fire.
  const S = loadShortcuts()
  const seen = new Map()
  for (const [action, combo] of Object.entries(S.DEFAULT_SHORTCUTS)) {
    const norm = S.normalizeShortcut(combo)
    assert.ok(!seen.has(norm), `${action} and ${seen.get(norm)} are both ${norm}`)
    seen.set(norm, action)
  }
})

test('every action has a human label', () => {
  const S = loadShortcuts()
  const missing = Object.keys(S.DEFAULT_SHORTCUTS).filter(a => !S.SHORTCUT_LABELS[a])
  assert.deepStrictEqual(missing, [], 'the dialog would show the camelCase id')
})

test('every declared shortcut is actually tested by the handler', () => {
  // This is the bug: the table advertised 25 shortcuts and the handler consulted
  // none of them, so three were bound to nothing and two described the opposite
  // of what happened.
  const S = loadShortcuts()
  const tested = new Set([...RENDERER.matchAll(/matchesShortcut\('([^']+)'/g)].map(m => m[1]))
  const declared = Object.keys(S.DEFAULT_SHORTCUTS)
  // toggleAgent has its own listener, registered next to the sidebar it opens.
  const ELSEWHERE = { toggleAgent: "bound in the chat sidebar's own keydown listener" }
  const unbound = declared.filter(a => !tested.has(a) && !(a in ELSEWHERE)).sort()
  assert.deepStrictEqual(unbound, [], 'declared in the table and bound to nothing')
})

test('the handler tests no action that is not declared', () => {
  const S = loadShortcuts()
  const tested = [...new Set([...RENDERER.matchAll(/matchesShortcut\('([^']+)'/g)].map(m => m[1]))]
  const undeclared = tested.filter(a => !(a in S.DEFAULT_SHORTCUTS)).sort()
  assert.deepStrictEqual(undeclared, [], 'getShortcut would return undefined and the test never fire')
})

test('the dialog builds from the user bindings and can capture a key', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function renderShortcutsConfig()'),
                            RENDERER.indexOf('function _onShortcutCaptureKey'))
  assert.match(fn, /getShortcut\(action\)/, 'not DEFAULT_SHORTCUTS')
  assert.doesNotMatch(fn, /DEFAULT_SHORTCUTS\[action\]\)\s*\+\s*'<\/kbd>/, 'the row shows the live binding')
  assert.match(fn, /data-sc-action/, 'each row is a control')
  assert.match(fn, /addEventListener\('click'/, 'and it is bound')
  const cap = RENDERER.slice(RENDERER.indexOf('function _onShortcutCaptureKey'),
                             RENDERER.indexOf('function toggleShortcutsConfig'))
  assert.match(cap, /saveShortcuts\(\)/, 'a captured key is stored')
  assert.match(cap, /e\.stopPropagation\(\)/, 'and does not also run as a shortcut')
})

test('the way into the dialog is not itself rebindable', () => {
  // Otherwise a binding set to something unreachable has no way back.
  const h = RENDERER.slice(RENDERER.indexOf("toggleShortcutsConfig(); return"))
  assert.ok(RENDERER.includes("e.shiftKey && e.key === ','"),
    'Ctrl+Shift+, stays a literal on purpose')
})
