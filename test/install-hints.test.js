'use strict'
const test = require('node:test')
const assert = require('node:assert')
const H = require('../src/install-hints')

// Roadmap 008: Linux commands must never appear as Windows or Mac instructions.
test('each platform gets its own install command for mpv and ffmpeg', () => {
  assert.equal(H.hint('mpv', 'darwin').primary, 'brew install mpv')
  assert.equal(H.hint('ffmpeg', 'darwin').primary, 'brew install ffmpeg')
  assert.equal(H.hint('mpv', 'win32').primary, 'winget install mpv')
  assert.equal(H.hint('mpv', 'linux').primary, 'sudo dnf install -y mpv')
  for (const p of ['darwin', 'win32']) {
    const all = [H.hint('mpv', p).primary].concat(H.hint('mpv', p).alternatives).join('\n')
    assert.doesNotMatch(all, /dnf|apt |pacman/, p + ' never shows a Linux package manager')
  }
})

test('unknown platforms fall back to the Linux answer; unknown tools to a plain sentence', () => {
  assert.equal(H.normalise('freebsd'), 'linux')
  assert.equal(H.normalise(undefined), 'linux')
  assert.equal(H.hint('mpv', 'freebsd').primary, 'sudo dnf install -y mpv')
  assert.equal(H.hint('yt-dlp', 'darwin'), null)
  assert.equal(H.next('yt-dlp', 'darwin'), 'Install yt-dlp and try again.')
  assert.equal(H.next('mpv', 'darwin'), 'Run: brew install mpv')
})

test('detect prefers the platform preload exposes, then the user agent', () => {
  assert.equal(H.detect({ api: { platform: 'darwin' }, navigator: { platform: 'Win32' } }), 'darwin')
  assert.equal(H.detect({ navigator: { platform: 'MacIntel' } }), 'darwin')
  assert.equal(H.detect({ navigator: { userAgentData: { platform: 'Windows' } } }), 'win32')
  assert.equal(H.detect({ navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }), 'linux')
  assert.equal(H.detect(null), 'linux')
})

test('the returned record is a copy the caller may edit', () => {
  const a = H.hint('mpv', 'linux'); a.alternatives.push('x'); a.primary = 'y'
  assert.equal(H.hint('mpv', 'linux').primary, 'sudo dnf install -y mpv')
  assert.equal(H.hint('mpv', 'linux').alternatives.length, 2)
})
