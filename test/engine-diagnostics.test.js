'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { formatDiagnostic, DIAG_FLIGHT_LINES, DIAG_LOG_LINES } = require('../engine-diagnostics')

// The stop that started this work: 85.2s into a 192s track, mid-album, with
// nothing in the log. This is the entry that has to exist next time.
const SNOW_GOOSE = () => {
  const t0 = 1_800_000_000_000
  return {
    kind: 'stopped',
    detail: { reason: 'stop', path: '/mnt/data/MUSIC/06 - The Snow Goose.flac', position: 85.2, duration: 192 },
    state: { path: '/mnt/data/MUSIC/06 - The Snow Goose.flac', position: 85.2, duration: 192, paused: false, volume: 100, audioParams: { samplerate: 48000 } },
    log: [
      { at: t0 + 71_000, source: 'mpv/ao/pipewire', text: '[error] Audio device lost, trying to reopen' },
    ],
    flight: [
      { at: t0 + 60_000, ev: 'heartbeat', path: '/mnt/data/MUSIC/06 - The Snow Goose.flac', position: 70, paused: false },
      { at: t0 + 71_000, ev: 'mpv-log', source: 'mpv/ao/pipewire', text: '[error] Audio device lost, trying to reopen' },
      { at: t0 + 85_200, ev: 'end-file', reason: 'stop', expected: false, path: '/mnt/data/MUSIC/06 - The Snow Goose.flac', position: 85.2, duration: 192, hasNext: true },
    ],
  }
}

test('the entry names the fault, the file, and the position', () => {
  const out = formatDiagnostic(SNOW_GOOSE())
  assert.match(out, /DIAGNOSTIC stopped/)
  assert.match(out, /reason=stop/)
  assert.match(out, /06 - The Snow Goose\.flac/)
  assert.match(out, /position=85\.2/)
})

test("mpv's own words are in the entry, which is the whole point", () => {
  const out = formatDiagnostic(SNOW_GOOSE())
  assert.match(out, /Audio device lost, trying to reopen/)
  assert.match(out, /mpv\/ao\/pipewire/)
})

test('times are relative to the fault, so the sequence reads at a glance', () => {
  const out = formatDiagnostic(SNOW_GOOSE())
  // The heartbeat is 25.2s before the end-file, and the device loss 14.2s before.
  assert.match(out, /-25\.200s heartbeat/)
  assert.match(out, /-14\.200s mpv-log/)
  assert.match(out, /0\.000s end-file/)
})

test('every line is greppable, because a wrapped block is not', () => {
  const out = formatDiagnostic(SNOW_GOOSE())
  const lines = out.split('\n')
  assert.ok(lines.length > 5)
  for (const l of lines) {
    assert.match(l, /^\[papa\]\[engine\] /, `un-prefixed line would be invisible to grep: ${l}`)
  }
})

test('an empty recorder says so instead of looking like a clean run', () => {
  const out = formatDiagnostic({ kind: 'stopped', detail: { reason: 'stop' }, state: null, log: [], flight: [] })
  assert.match(out, /nothing — mpv logged no warnings or errors/)
  assert.match(out, /empty — the recorder had nothing, which is itself a finding/)
})

test('the entry is capped, so one fault cannot fill the disk', () => {
  const t0 = 1_800_000_000_000
  const big = {
    kind: 'stopped',
    detail: { reason: 'stop' },
    state: { path: '/a.flac', position: 1 },
    log: Array.from({ length: 500 }, (_, i) => ({ at: t0 + i, source: 'stderr', text: `line ${i}` })),
    flight: Array.from({ length: 900 }, (_, i) => ({ at: t0 + i, ev: 'filler', i })),
  }
  const out = formatDiagnostic(big)
  assert.match(out, new RegExp(`mpv said \\(${DIAG_LOG_LINES}\\+ lines\\)`))
  assert.match(out, new RegExp(`flight recorder \\(${DIAG_FLIGHT_LINES}\\+ entries\\)`))
  // The newest entries are the ones kept — the oldest are the least relevant.
  assert.match(out, /line 499/)
  assert.doesNotMatch(out, /line 0\b/)
  assert.match(out, /i=899/)
})

test('a malformed diagnostic still produces a line rather than throwing', () => {
  for (const bad of [undefined, {}, { kind: 'stopped' }, { flight: null, log: null }]) {
    assert.doesNotThrow(() => formatDiagnostic(bad), JSON.stringify(bad))
    assert.match(formatDiagnostic(bad), /^\[papa\]\[engine\] DIAGNOSTIC/)
  }
})

test('audioParams is left out of the state line, being noise not evidence', () => {
  const out = formatDiagnostic(SNOW_GOOSE())
  const stateLine = out.split('\n').find(l => l.includes('state '))
  assert.ok(stateLine)
  assert.doesNotMatch(stateLine, /samplerate/)
  assert.match(stateLine, /paused=false/)
})

test('the four fault kinds each produce their own entry', () => {
  for (const kind of ['stopped', 'load-error', 'engine-failed', 'engine-recovered']) {
    const out = formatDiagnostic({ kind, detail: { reason: 'x' }, state: null, log: [], flight: [] })
    assert.match(out, new RegExp(`DIAGNOSTIC ${kind}`))
  }
})
