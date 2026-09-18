const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('mpv is told to prefetch, which is what actually removes the gap', () => {
  const eng = R('mpv-engine.js')
  assert.ok(eng.includes("'--prefetch-playlist=yes'"),
    'without prefetch mpv opens the next file only after the current one ends')
  assert.ok(/gapless-audio=\$\{this\.config\.gapless \? 'yes' : 'no'\}/.test(eng),
    "'weak' only stays gapless when formats match exactly")
})

test('shuffle prefetches too — it used to skip it entirely', () => {
  const r = R('src/renderer.js')
  assert.ok(!/state\.shuffle && state\.queue\.length > 1\) return null/.test(r),
    'shuffle must no longer disable prefetch')
  assert.ok(r.includes('_pendingShuffle'), 'the next shuffle pick must be committed in advance')
})

test('the committed pick is the one actually played', () => {
  const r = R('src/renderer.js')
  // If playNext re-rolled, mpv would have prefetched a different file than the
  // one that plays — a gap AND the wrong track.
  assert.ok(/const committed = \(_pendingShuffle != null/.test(r),
    'playNext must consume the committed pick')
  // The pick used to be written straight into state.queueIndex. Since the fix
  // for shuffle stopping the music (a pick of 0 was read as "the queue
  // finished"), it lands in a local first and playNext commits that to
  // state.queueIndex once it has decided the queue has not ended. The property
  // this test cares about is unchanged: the commitment is dropped as it is
  // consumed, and the consumed value is what plays.
  assert.ok(/_pendingShuffle = null\s*\n\s*nextIdx = committed/.test(r),
    'the commitment must be cleared once used')
  assert.ok(/state\.queueIndex = nextIdx/.test(r),
    'and the pick that was prefetched must be the index that is played')
})

test('a stale commitment cannot outlive the queue or the shuffle toggle', () => {
  const r = R('src/renderer.js')
  assert.ok(/_pendingShuffle >= state\.queue\.length/.test(r),
    'an index past the end of a shrunken queue must be discarded')
  assert.ok(/state\.shuffle = !state\.shuffle\s*\n\s*_pendingShuffle = null/.test(r),
    'toggling shuffle must drop the commitment')
})
