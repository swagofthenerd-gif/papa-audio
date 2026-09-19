'use strict'
// The mute button is a toggle, so its tooltip has to say what pressing it will
// do. It read "Mute (M)" while the sound was already off, which tells a
// hovering user and a screen-reader user the same wrong thing.
//
// setVolDisplay is the one funnel every volume change goes through — the bar,
// the wheel, the keyboard, the typed value and the mute button itself — so the
// real function is lifted out of renderer.js and driven against a fake DOM.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

const SET_VOL_DISPLAY = lift('setVolDisplay')

function build() {
  const els = {}
  function el(id) {
    const n = {
      id, attrs: {}, title: '', innerHTML: '', style: {},
      classList: { add() {}, remove() {} },
      setAttribute(a, v) { n.attrs[a] = String(v) },
      getAttribute(a) { return a in n.attrs ? n.attrs[a] : null },
    }
    els[id] = n
    return n
  }
  const btn = el('btn-vol')
  const icon = el('vol-icon')
  const document = {
    getElementById: id => els[id] || null,
    querySelector: sel => sel.includes('vol-icon') ? icon : null,
  }
  const snacks = []
  const env = { document, snacks }
  const fn = new Function('env', `
    const { document, snacks } = env
    let _lastVolDisplay = 0.8
    const audio = { volume: 0.8 }
    const state = { lastVolume: 0.8 }
    function updateBitPerfectBadge() {}
    function _syncVolumeAria() {}
    function showSnackbar(m) { snacks.push(m) }
    function setTimeout() {}
    ${SET_VOL_DISPLAY}
    return setVolDisplay
  `)(env)
  return { setVolDisplay: fn, btn, icon }
}

test('the tooltip offers to unmute once the sound is off', () => {
  const h = build()
  h.setVolDisplay(0)
  assert.strictEqual(h.btn.title, 'Unmute (M)',
    'saying "Mute" while already muted tells the user the sound is still on')
  assert.strictEqual(h.btn.getAttribute('aria-label'), 'Mute', 'the name is stable; aria-pressed carries the state')
  assert.strictEqual(h.btn.getAttribute('aria-pressed'), 'true')
})

test('the tooltip offers to mute while the sound is on', () => {
  const h = build()
  h.setVolDisplay(0.4)
  assert.strictEqual(h.btn.title, 'Mute (M)')
  assert.strictEqual(h.btn.getAttribute('aria-label'), 'Mute')
  assert.strictEqual(h.btn.getAttribute('aria-pressed'), 'false')
})

test('it follows the volume back and forth, not just the first change', () => {
  const h = build()
  h.setVolDisplay(0.6)
  h.setVolDisplay(0)
  assert.strictEqual(h.btn.title, 'Unmute (M)')
  h.setVolDisplay(0.6)
  assert.strictEqual(h.btn.title, 'Mute (M)', 'unmuting must put the label back')
  assert.strictEqual(h.btn.getAttribute('aria-pressed'), 'false')
})

test('a very quiet but audible volume is not called muted', () => {
  const h = build()
  h.setVolDisplay(0.01)
  assert.strictEqual(h.btn.title, 'Mute (M)',
    '1% is quiet, not off — pressing the button there still means mute')
})
