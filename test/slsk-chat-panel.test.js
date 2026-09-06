'use strict'
// Structural guards for the peer-messaging UI (roadmap #55). renderer.js can't
// be imported in Node (it touches window/DOM at load), so — like the other
// slsk UI wiring tests — these read the source and assert the panel keeps the
// shape its behaviour depends on. The pure list/badge/thread logic is covered
// by slsk-chat-model.test.js; this file covers the wiring around it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(__dirname, '../src/slsk-shop-ui.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8')

function slice(code, from, toMarker) {
  const s = code.indexOf(from)
  assert.ok(s > -1, `expected to find: ${from}`)
  const e = code.indexOf(toMarker, s + from.length)
  return code.slice(s, e > -1 ? e : code.length)
}

// ── module wiring ─────────────────────────────────────────────────────────────
test('the chat model module is loaded before renderer.js', () => {
  const a = HTML.indexOf('src="slsk-chat-model.js"')
  const r = HTML.indexOf('src="renderer.js"')
  assert.ok(a > -1, 'index.html must load slsk-chat-model.js')
  assert.ok(r > -1 && a < r, 'it must load before renderer.js')
})

test('all list/badge/thread decisions go through PapaSlskChatModel, not ad-hoc', () => {
  const region = slice(CODE, '// ── Soulseek peer messaging', '// ── Soulseek friends sidebar')
  assert.match(region, /window\.PapaSlskChatModel/, 'the chat region must use the model')
  assert.match(region, /M\.threads\(/, 'ordering comes from the model')
  assert.match(region, /M\.totalUnread\(/, 'the badge count comes from the model')
  assert.match(region, /M\.ingest\(/, 'de-dupe comes from the model')
  assert.match(region, /M\.toastFor\(/, 'the toast text comes from the model')
})

// ── the Messages button + badge ───────────────────────────────────────────────
test('the hub has a Messages button with an unread badge', () => {
  const fn = slice(CODE, 'function renderSoulseekHub(', '\nfunction _renderHubFriends')
  assert.match(fn, /id="slsk-hub-messages"/, 'the hub head must carry the Messages button')
  assert.match(fn, /id="slsk-hub-msg-badge"/, 'and its unread badge')
  assert.match(fn, /_openSlskChatPanel\(\)/, 'clicking it opens the panel')
  assert.match(fn, /_renderHubMessagesBtn\(\)/, 'the button is feature-detected on render')
})

test('the Messages button is feature-detected on the send contract', () => {
  const fn = slice(CODE, 'function _renderHubMessagesBtn(', '\nfunction _paintChatBadge')
  assert.match(fn, /typeof window\.api\.slskChatSend === 'function'/,
    'no send contract -> the button hides rather than opening a dead panel')
})

// ── incoming wiring + toast ───────────────────────────────────────────────────
test('incoming messages are wired through onSlskChatMessage, bound once', () => {
  const fn = slice(CODE, 'function _slskBindChat(', '\nfunction _openSlskChatPanel')
  assert.match(fn, /if \(_slskChat\.bound\) return/, 'binding is idempotent')
  assert.match(fn, /window\.api\.onSlskChatMessage\(/, 'it subscribes via onSlskChatMessage')
  assert.match(fn, /typeof window\.api\.onSlskChatMessage !== 'function'/, 'feature-detected (guards on absence)')
})

test('a message arriving with the panel closed raises a click-to-open toast', () => {
  const fn = slice(CODE, 'function _slskBindChat(', '\nfunction _openSlskChatPanel')
  assert.match(fn, /_slskChat\.open/, 'it checks whether the panel is open')
  assert.match(fn, /showSnackbar\(M\.toastFor\(msg\)/, 'closed -> toast with the model text')
  assert.match(fn, /_openSlskChatPanel\(who\)/, 'the toast action opens that peer’s thread')
})

test('the listener is also bound at startup so a toast fires before the hub opens', () => {
  const start = slice(CODE, '// ── Start ', '_selBindBar()')
  assert.match(start, /_slskBindChat\(\)/, 'chat is bound at startup, not only on hub render')
})

// ── the panel: list -> thread -> send ─────────────────────────────────────────
test('the conversation list renders rows with an unread badge', () => {
  const fn = slice(CODE, 'function _renderChatList(', '\nfunction _renderChatThread')
  assert.match(fn, /slsk-chat-row/, 'one row per conversation')
  assert.match(fn, /_renderChatThread\(/, 'a row opens its thread')
  assert.match(fn, /t\.unread/, 'the row carries its unread badge')
})

test('the thread view has in/out bubbles, timestamps and an Enter-sends box', () => {
  const fn = slice(CODE, 'function _renderChatThread(', '\nfunction _sendSlskChat')
  assert.match(fn, /slsk-bubble-out/, 'outgoing bubbles')
  assert.match(fn, /slsk-bubble-in/, 'incoming bubbles')
  assert.match(fn, /slsk-bubble-time/, 'each bubble is timestamped')
  assert.match(fn, /_slskChatMarkRead\(username/, 'opening a thread marks it read')
  const form = fn.match(/id="slsk-chat-send"/)
  assert.ok(form, 'a send form (submit == Enter) exists')
})

test('opening a thread lazy-loads history once, feature-detected', () => {
  const fn = slice(CODE, 'function _renderChatThread(', '\nfunction _sendSlskChat')
  assert.match(fn, /typeof window\.api\.slskChatHistory === 'function'/, 'history is feature-detected')
  assert.match(fn, /_slskChat\.loadedHistory/, 'and fetched at most once per peer per session')
})

test('sending echoes locally then calls slskChatSend', () => {
  const fn = slice(CODE, 'function _sendSlskChat(', '\nfunction _fmtChatTime')
  assert.match(fn, /direction: 'out'/, 'the outgoing line is echoed immediately')
  assert.match(fn, /window\.api\.slskChatSend\(\{ username: username, message: body \}\)/,
    'and sent over the contract channel')
})

// ── read marks persist ────────────────────────────────────────────────────────
test('read marks persist through PapaLocal under a dedicated key', () => {
  const region = slice(CODE, '// ── Soulseek peer messaging', '// ── Soulseek friends sidebar')
  assert.match(region, /_SLSK_CHAT_READ_KEY = 'papa-slsk-chat-read'/, 'a stable key')
  assert.match(region, /window\.PapaLocal\.write\(_SLSK_CHAT_READ_KEY/, 'marks are written to PapaLocal')
  assert.match(region, /M\.readMarkFor\(thread/, 'the mark itself is the model’s decision')
})

// ── explorer ✉ button ─────────────────────────────────────────────────────────
test('the explorer header has a ✉ button next to the save star', () => {
  const header = slice(SHOP, 'class="modal-header-row slsh-header"', 'modal-close-btn')
  assert.match(header, /id="slskx-msg"/, 'the envelope button lives in the explorer header')
  assert.match(header, /id="slskx-star"/, 'beside the save star')
})

test('the ✉ button is feature-detected and opens the chat for that user', () => {
  const region = slice(SHOP, "const msgBtn = dlg.querySelector('#slskx-msg')", 'const starBtn')
  assert.match(region, /typeof openSlskChat === 'function'/, 'hidden when the build cannot message')
  assert.match(region, /openSlskChat\(username\)/, 'clicking opens the panel for this user')
  // The renderer threads openSlskChat through only when the send contract exists.
  const deps = slice(CODE, 'return S.show(username, {', '})')
  assert.match(deps, /openSlskChat:/, 'the dep is passed from the renderer')
  assert.match(deps, /typeof window\.api\.slskChatSend === 'function'/, 'feature-detected there too')
})

// ── the ipc-wiring test knows about the new channel ───────────────────────────
test('the ipc channel-wiring guard recognises onSlskChatMessage as a listener', () => {
  const wiring = fs.readFileSync(path.join(__dirname, 'ipc-channel-wiring.test.js'), 'utf8')
  assert.match(wiring, /onSlskChatMessage\\\(.*slsk-chat-message/s,
    'once main sends slsk-chat-message, the guard must count the dedicated subscriber as heard')
})
