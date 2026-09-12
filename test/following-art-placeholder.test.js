'use strict'
// Roadmap S8: following-row artist art painted as blank circles before the
// photo arrived. The silhouette is now the placeholder and the photo fades in
// over it once loaded; a failed photo just leaves the silhouette.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')

test('both following-card templates keep the silhouette visible and fade the photo in on load', () => {
  const lib = RENDERER.slice(RENDERER.indexOf('data-follow-artist="${esc(name)}"'), RENDERER.indexOf('artist-card-name', RENDERER.indexOf('data-follow-artist="${esc(name)}"')))
  const yt = RENDERER.slice(RENDERER.indexOf('yt-artist-card" data-channel'), RENDERER.indexOf('artist-card-name', RENDERER.indexOf('yt-artist-card" data-channel')))
  for (const tpl of [lib, yt]) {
    assert.match(tpl, /onload="this\.classList\.add\('is-loaded'\)" onerror="this\.remove\(\)"/)
    assert.match(tpl, /<div class="artist-card-art-fallback">/, 'the silhouette is never display:none')
    assert.doesNotMatch(tpl, /style="display:none"/)
  }
  assert.match(CSS, /\.artist-card-art img \{\n\s+position: absolute;[\s\S]*?opacity: 0;/)
  assert.match(CSS, /\.artist-card-art img\.is-loaded \{ opacity: 1; \}/)
})

// Roadmap W-T: reopening the queue panel centres the playing track instead of
// leaving it just below the fold (the render used to restore the old scroll
// position after nudging the row into view).
test('opening the queue panel centres the playing row; live re-renders keep their scroll', () => {
  const tog = RENDERER.slice(RENDERER.indexOf('function toggleQueuePanel()'), RENDERER.indexOf('\nfunction ', RENDERER.indexOf('function toggleQueuePanel()') + 10))
  assert.match(tog, /if \(state\.queuePanelOpen\) \{ state\._queueJustOpened = true; renderQueuePanel\(\) \}/)
  const at = RENDERER.indexOf('function renderQueuePanel()')
  const body = RENDERER.slice(at, RENDERER.indexOf('\nfunction addToQueue', at))
  assert.match(body, /const justOpened = !!state\._queueJustOpened\n\s+state\._queueJustOpened = false/)
  assert.match(body, /if \(playingEl && !justOpened\) playingEl\.scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.match(body, /if \(qp3 && !justOpened\) qp3\.scrollTop = st/)
  assert.match(body, /if \(playingEl && justOpened\) \{ try \{ playingEl\.scrollIntoView\(\{ block: 'center' \}\) \}/)
})
