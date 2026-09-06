'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const sched = require('../src/download-scheduler')

// ── The substitution log itself (roadmap #56), capped at 200 ─────────────────

test('logSubstitution records the decision fields', () => {
  const state = sched.createState()
  const entry = sched.logSubstitution(state, {
    key: 'k1', from: 'a.flac', to: 'b.flac', candidate: 'peer', accepted: true, reason: 'better bitrate',
  })
  assert.strictEqual(entry.accepted, true)
  assert.strictEqual(entry.reason, 'better bitrate')
  assert.strictEqual(entry.candidate, 'peer')
  assert.strictEqual(state.subLog.length, 1)
})

test('the log is capped at 200 entries, oldest dropped first', () => {
  const state = sched.createState()
  for (let i = 0; i < 250; i++) {
    sched.logSubstitution(state, { key: 'k' + i, reason: 'r' + i, accepted: i % 2 === 0 })
  }
  assert.strictEqual(state.subLog.length, 200)
  // The first 50 were dropped; the tail is the newest.
  assert.strictEqual(state.subLog[0].key, 'k50')
  assert.strictEqual(state.subLog[state.subLog.length - 1].key, 'k249')
})

// ── The IPC surface (main.js) returns a copy of the live log ─────────────────

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

test('slsk-scheduler-sublog is registered and returns a defensive copy', () => {
  const handler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('slsk-scheduler-sublog'"),
    MAIN.indexOf("ipcMain.handle('slsk-scheduler-sublog'") + 300)
  assert.ok(handler.length > 0, 'the handler must exist')
  assert.match(handler, /dlState\.subLog/)
  assert.match(handler, /\.slice\(\)/, 'must return a copy, not the live array')
  assert.match(handler, /Array\.isArray/, 'must be safe before subLog is populated')
})

test('preload exposes slskSubLog', () => {
  assert.match(PRELOAD, /slskSubLog:.*invoke\('slsk-scheduler-sublog'/)
})
