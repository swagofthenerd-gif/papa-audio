'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')

// ── Papa Video: the renderer-side UI scaffold ───────────────────────────────

test('index.html declares the Movies & TV nav entry', () => {
  assert.match(HTML, /data-page="video"/, 'the sidebar needs a video page entry')
  assert.match(HTML, /Movies &amp; TV/, 'and it must be labelled')
})

test('index.html declares the video playback panel', () => {
  assert.match(HTML, /id="video-panel"/, 'the mpv surface mounts in this panel')
})

test('renderer.js defines the catalog and detail renders', () => {
  assert.match(RENDERER, /function renderVideo\b/, 'catalog view')
  assert.match(RENDERER, /function renderVideoDetail\b/, 'detail view')
})

test('renderer.js wires the router to the video pages', () => {
  assert.match(RENDERER, /page === 'video'\)\s*renderVideo\(\)/)
  assert.match(RENDERER, /page === 'video-detail'\)\s*renderVideoDetail\(navId\)/)
})

test('the source picker play buttons are always visible', () => {
  // Play buttons must not hide behind hover. The rule is checked for an
  // opacity at or above .85, matching the app-wide play-button convention.
  const at = CSS.indexOf('.video-source-play {')
  assert.ok(at > 0, 'a .video-source-play rule must exist')
  const rule = CSS.slice(at, CSS.indexOf('}', at))
  const m = rule.match(/opacity:\s*(\.?\d+(?:\.\d+)?)/)
  assert.ok(m, 'the rule must set an opacity')
  const opacity = parseFloat(m[1])
  assert.ok(opacity >= 0.85, `opacity must be >= .85, found ${m[1]}`)
})

test('renderer.js surfaces catalog/detail/streams errors with a helper', () => {
  assert.match(RENDERER, /function _videoError\b/, 'a _videoError helper must exist')
  assert.match(
    RENDERER,
    /TMDB API key\|401/,
    'the helper must detect TMDB-key and 401 errors'
  )
})

test('renderer.js hints where to set the TMDB key', () => {
  assert.match(
    RENDERER,
    /Set your TMDB API key in Settings → Video\./,
    'the hint string must be present'
  )
})

test('styles.css defines the error banner rule', () => {
  assert.match(CSS, /\.video-error\s*\{/, 'a .video-error rule must exist')
})
