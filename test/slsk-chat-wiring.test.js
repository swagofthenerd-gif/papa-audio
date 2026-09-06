'use strict'
// Peer chat (roadmap #55) — the main.js/preload wiring, source-shape asserted
// since main.js cannot be required outside Electron. The pure mapping + diff is
// covered in test/slsk-chat.test.js; this pins that main delegates to it and the
// contract channels are wired end to end (bridge side).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')

test('main requires the pure slsk-chat module (lazily, off the startup path)', () => {
  assert.match(MAIN, /const slskChat = _lazyNs\(\(\) => require\('\.\/src\/slsk-chat'\)\)/)
})

test('slsk-chat-list normalizes the /conversations list and degrades to []', () => {
  const start = MAIN.indexOf("ipcMain.handle('slsk-chat-list'")
  const body = MAIN.slice(start, start + 400)
  assert.match(body, /slskdFetch\('GET', '\/conversations'\)/)
  assert.match(body, /slskChat\.normalizeList\(rows\)/)
  assert.match(body, /return \[\]/, 'unreachable slskd is [], not a throw')
})

test('slsk-chat-history fetches the per-user conversation and normalizes it', () => {
  const start = MAIN.indexOf("ipcMain.handle('slsk-chat-history'")
  const body = MAIN.slice(start, start + 500)
  assert.match(body, /\/conversations\/\$\{encodeURIComponent\(username\)\}/)
  assert.match(body, /slskChat\.normalizeHistory\(convo\)/)
})

test('slsk-chat-send posts the message as slskd wants and rejects an empty one', () => {
  const start = MAIN.indexOf("ipcMain.handle('slsk-chat-send'")
  const body = MAIN.slice(start, start + 600)
  assert.match(body, /if \(!message\) return \{ ok: false/, 'an empty message is not sent')
  assert.match(body, /slskdFetch\('POST', `\/conversations\/\$\{encodeURIComponent\(username\)\}`, message\)/)
  assert.match(body, /return \{ ok: true \}/)
})

test('the 30s poll emits slsk-chat-message for new incoming, using the pure diff', () => {
  const start = MAIN.indexOf('async function slskChatPollOnce(')
  const body = MAIN.slice(start, MAIN.indexOf('function slskChatPollStart('))
  assert.match(body, /slskChat\.diffIncoming\(raw, prev\)/, 'the new-message decision is the pure diff')
  assert.match(body, /safeSend\('slsk-chat-message', \{ username: m\.username \|\| username, message: m\.message, at: m\.at \}\)/)
  // The watermark side-store, so a restart does not re-announce old messages.
  assert.match(body, /sideStores\.slskChatSeen/)
  // Skips when slskd is down — silence is not a new message.
  assert.match(body, /return\s+\/\/ slskd unreachable/, 'a down daemon leaves watermarks untouched')
})

test('CHAT_POLL_MS is 30 seconds and the poll is started with the other slsk polls', () => {
  assert.match(MAIN, /const CHAT_POLL_MS = 30000/)
  assert.match(MAIN, /slskChatPollStart\(\)/)
})

test('preload exposes the three chat methods and the message subscriber', () => {
  assert.match(PRELOAD, /slskChatList:.*invoke\('slsk-chat-list'/)
  assert.match(PRELOAD, /slskChatHistory:.*invoke\('slsk-chat-history'/)
  assert.match(PRELOAD, /slskChatSend:.*invoke\('slsk-chat-send'/)
  assert.match(PRELOAD, /onSlskChatMessage:.*ipcRenderer\.on\('slsk-chat-message'/)
})
