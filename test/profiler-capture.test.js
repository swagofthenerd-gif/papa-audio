'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  DEFAULT_SECONDS, MIN_SECONDS, MAX_SECONDS, normalizeSeconds, profileFilename,
} = require('../src/profiler-capture')

// ── Arg guard (roadmap #70): the seconds request is clamped, never rejected ──

test('a missing or empty request uses the default duration', () => {
  assert.strictEqual(normalizeSeconds(), DEFAULT_SECONDS)
  assert.strictEqual(normalizeSeconds({}), DEFAULT_SECONDS)
  assert.strictEqual(normalizeSeconds(null), DEFAULT_SECONDS)
})

test('a plain number and a { seconds } object are both accepted', () => {
  assert.strictEqual(normalizeSeconds(15), 15)
  assert.strictEqual(normalizeSeconds({ seconds: 15 }), 15)
})

test('non-numeric, zero and negative requests fall back to the default', () => {
  assert.strictEqual(normalizeSeconds({ seconds: 'abc' }), DEFAULT_SECONDS)
  assert.strictEqual(normalizeSeconds({ seconds: 0 }), DEFAULT_SECONDS)
  assert.strictEqual(normalizeSeconds({ seconds: -5 }), DEFAULT_SECONDS)
  assert.strictEqual(normalizeSeconds({ seconds: NaN }), DEFAULT_SECONDS)
})

test('the duration is clamped to the sane band and floored to whole seconds', () => {
  assert.strictEqual(normalizeSeconds({ seconds: 0.5 }), MIN_SECONDS)
  assert.strictEqual(normalizeSeconds({ seconds: 9999 }), MAX_SECONDS)
  assert.strictEqual(normalizeSeconds({ seconds: 12.9 }), 12)
})

// ── Output filename: timestamped and .cpuprofile so viewers recognise it ─────

test('the profile filename is timestamped and ends in .cpuprofile', () => {
  const name = profileFilename(new Date('2026-09-06T12:34:56.000Z'))
  assert.match(name, /^papa-.*\.cpuprofile$/)
  // No characters that break a filename on any platform.
  assert.doesNotMatch(name, /[:.](?!cpuprofile$)/)
})

test('two captures a moment apart do not collide', () => {
  const a = profileFilename(new Date('2026-09-06T12:34:56.000Z'))
  const b = profileFilename(new Date('2026-09-06T12:34:57.000Z'))
  assert.notStrictEqual(a, b)
})

// ── The IPC handler around it (main.js): one at a time, honest errors ─────────

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('the profiler IPC is registered and guards against a concurrent capture', () => {
  assert.match(MAIN, /ipcMain\.handle\('papa-profile-capture'/)
  assert.match(MAIN, /_profileInFlight/)
  const handler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('papa-profile-capture'"),
    MAIN.indexOf("ipcMain.handle('papa-profile-capture'") + 2000)
  assert.match(handler, /if \(_profileInFlight\)/, 'must refuse a second concurrent capture')
  assert.match(handler, /already running/, 'the refusal must be an honest message')
  assert.match(handler, /Profiler\.start/, 'must drive the CDP CPU profiler')
  assert.match(handler, /Profiler\.stop/)
  assert.match(handler, /\.cpuprofile|profileFilename/, 'must write a .cpuprofile')
  assert.match(handler, /finally/, 'the in-flight flag must be released in a finally')
})

test('preload exposes papaProfileCapture', () => {
  const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.match(PRELOAD, /papaProfileCapture:.*invoke\('papa-profile-capture'/)
})
