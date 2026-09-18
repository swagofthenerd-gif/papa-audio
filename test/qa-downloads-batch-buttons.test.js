'use strict'
// L2 — "▶ Resume All" on the Downloads page was a permanent no-op.
//
// Its entire handler was
//
//     showSnackbar('Resume not yet supported — re-queue downloads')
//
// and it could never be anything else: Soulseek has no resume, which is why
// "Pause All" cancels the transfers and its confirm says they have to be
// queued again. A button whose only job is to say it does not work is worse
// than no button — it reads as a feature that is broken today.
//
// It is gone, along with the message. "Pause All" is now labelled Stop All,
// which is what it has always actually done.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The markup renderDownloads paints for the batch row, evaluated rather than
// pattern-matched, so this sees the string the page really gets.
function batchButtonsHtml(source) {
  const at = source.indexOf('  var batchBtns = ')
  assert.ok(at > -1, 'the batch button row must still be built in renderDownloads')
  const end = source.indexOf('\n', at)
  return vm.runInNewContext(source.slice(at + '  var batchBtns = '.length, end))
}

test('the batch row offers exactly one action', () => {
  const html = batchButtonsHtml(RENDERER)
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])
  assert.deepStrictEqual(ids, ['dl-pause-all'])
})

test('and it is not called Resume', () => {
  const html = batchButtonsHtml(RENDERER)
  assert.doesNotMatch(html, /Resume/i)
  assert.match(html, /Stop All/)
})

test('nothing binds or mentions the dead button any more', () => {
  assert.ok(!/getElementById\('dl-resume-all'\)/.test(RENDERER),
    'a handler for a button that is not painted is dead code')
  assert.ok(!/Resume not yet supported/.test(RENDERER.replace(/^\s*\/\/.*$/gm, '')),
    'the apology string is gone from the code, comments aside')
})

test('the remaining action still stops what is downloading', () => {
  // The one real batch action must not have been lost with the fake one.
  const at = RENDERER.indexOf("getElementById('dl-pause-all')")
  assert.ok(at > -1, 'Stop All must still be bound')
  const body = RENDERER.slice(at, at + 1200)
  assert.match(body, /slskCancelTransfer/)
  assert.match(body, /Nothing is downloading/, 'and still says so when there is nothing to stop')
  assert.match(body, /queued again/, 'and still warns that Soulseek cannot resume')
})

test('MUTATION: putting the no-op button back is visible from the markup alone', () => {
  const broken = RENDERER.replace(
    '<button class="dl-action-btn" id="dl-pause-all">\\u23f9 Stop All</button></div>',
    '<button class="dl-action-btn" id="dl-pause-all">\\u23f9 Stop All</button><button class="dl-action-btn" id="dl-resume-all">\\u25b6 Resume All</button></div>')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const ids = [...batchButtonsHtml(broken).matchAll(/id="([^"]+)"/g)].map(m => m[1])
  assert.deepStrictEqual(ids, ['dl-pause-all', 'dl-resume-all'], 'this is the reported bug')
})
