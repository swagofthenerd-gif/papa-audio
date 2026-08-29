'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const p = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const renderer = p('src/renderer.js')
const html = p('src/index.html')
const css = p('src/styles.css')

// RULING 1: the brief's original test asserted these six modules were loaded
// as classic <script> tags in index.html. Five of the six call require() and
// none defines a window fallback, so a classic <script> tag would throw
// ReferenceError on load and take the whole renderer down. All queue building
// already happens in the main process (Task 11), reachable from here only
// through window.api.queueBuild. Loading them in the renderer would be both
// broken and pointless, so this test asserts the opposite of the brief.
test('the queue modules stay in the main process and are not loaded in the renderer', () => {
  for (const f of ['audio-features', 'taste-model', 'queue-sampler', 'queue-sequencer', 'queue-clusters', 'queue-engine']) {
    assert.ok(!html.includes(`${f}.js`), `${f}.js must not be loaded in the renderer`)
  }
})

test('the renderer can start each of the four modes', () => {
  for (const m of ['radio', 'mix', 'surprise', 'rediscover']) {
    assert.ok(renderer.includes(`'${m}'`), `mode ${m} unreachable from the renderer`)
  }
})

test('stereo tracks in a surround-first queue get a marker with a real rule', () => {
  assert.ok(renderer.includes('q-stereo-badge'), 'no stereo badge emitted')
  assert.ok(/\.q-stereo-badge\s*\{/.test(css), 'q-stereo-badge has no CSS rule')
})

test('every new class the renderer emits has a CSS rule', () => {
  for (const c of ['q-madeforyou', 'q-mix-card', 'q-analysis-progress']) {
    assert.ok(renderer.includes(c), `${c} not emitted`)
    assert.ok(new RegExp(`\\.${c}\\s*[{,]`).test(css), `.${c} has no CSS rule`)
  }
})

test('the empty state says features are still being built rather than showing nothing', () => {
  assert.ok(/still (listening|analysing|analyzing)/i.test(renderer), 'no "still analysing" empty state')
})

// Fix round 1: two mode:'mix' calls returned disjoint tracks from unrelated
// artists — five "Mix N" cards were five random draws from one pool, not real
// daily mixes. Mixes must be named from queueMixes() and, until analysis has
// produced clusters, the UI must show ONE honest unlock prompt rather than
// five placeholder cards that would all build the same undifferentiated queue.
test('made-for-you mixes come from queueMixes(), not a fixed "Mix N" placeholder loop', () => {
  assert.ok(/window\.api\.queueMixes\(\)/.test(renderer), 'renderer never calls queueMixes()')
  assert.ok(!/\[1,\s*2,\s*3,\s*4,\s*5\]/.test(renderer), 'still generating five fixed placeholder mix cards')
})

test('mix cards target a specific cluster via mixIndex', () => {
  assert.ok(/startSmartQueue\(\s*'mix'\s*,\s*null\s*,\s*\{\s*mixIndex/.test(renderer), 'mix cards must pass mixIndex through to startSmartQueue')
})

test('an empty mixes list renders one unlock prompt, not fake cards', () => {
  assert.ok(renderer.includes('q-mix-card-unlock'), 'no unlock-prompt card for the no-features case')
  assert.ok(/\.q-mix-card-unlock\s*[{,]/.test(css), 'q-mix-card-unlock has no CSS rule')
  assert.ok(/queueAnalysisStart\(\)/.test(renderer), 'unlock prompt must be able to kick off analysis')
})
