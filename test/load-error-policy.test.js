'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('node:vm')

const ctx = { window: {}, console }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'load-error-policy.js'), 'utf8'), ctx)
const { decide } = ctx.window.PapaLoadError

const GONE = { checked: true, exists: false }
const PRESENT = { checked: true, exists: true }
const UNKNOWN = { checked: false, exists: true, reason: 'EACCES' }

test('a file the filesystem says is gone is dropped from the queue', () => {
  const d = decide({ verdict: GONE, alreadyRetried: false, queueLength: 12 })
  assert.strictEqual(d.action, 'mark')
})

test('a file that is still there is retried once, never dropped', () => {
  // This is the bug: a transient demuxer or cache error on a large FLAC used to
  // delete a present file from the queue permanently.
  const d = decide({ verdict: PRESENT, alreadyRetried: false, queueLength: 12 })
  assert.strictEqual(d.action, 'retry')
  assert.strictEqual(d.reason, 'present-but-failed')
})

test('"could not tell" is never treated as "it is missing"', () => {
  for (const verdict of [UNKNOWN, {}, { checked: false, exists: false }, { exists: false }]) {
    const first = decide({ verdict, alreadyRetried: false, queueLength: 12 })
    assert.strictEqual(first.action, 'retry', JSON.stringify(verdict))
    const second = decide({ verdict, alreadyRetried: true, queueLength: 12 })
    assert.strictEqual(second.action, 'skip', JSON.stringify(verdict))
    assert.notStrictEqual(second.action, 'mark')
  }
})

test('a second failure on a present file skips without touching the queue', () => {
  const d = decide({ verdict: PRESENT, alreadyRetried: true, queueLength: 12 })
  assert.strictEqual(d.action, 'skip')
  assert.strictEqual(d.reason, 'failed-twice')
})

test('a second failure with nothing else queued stops rather than skipping', () => {
  const d = decide({ verdict: PRESENT, alreadyRetried: true, queueLength: 1 })
  assert.strictEqual(d.action, 'stop')
})

test('a confirmed-missing file is dropped even on the second attempt', () => {
  const d = decide({ verdict: GONE, alreadyRetried: true, queueLength: 12 })
  assert.strictEqual(d.action, 'mark')
})

test('only a confirmed absence can ever mutate the queue', () => {
  const verdicts = [GONE, PRESENT, UNKNOWN, {}, null, undefined]
  for (const verdict of verdicts) {
    for (const alreadyRetried of [false, true]) {
      for (const queueLength of [0, 1, 12]) {
        const d = decide({ verdict, alreadyRetried, queueLength })
        if (d.action === 'mark') {
          assert.ok(verdict && verdict.checked === true && verdict.exists === false,
            `mark requires a confirmed absence, got ${JSON.stringify(verdict)}`)
        }
      }
    }
  }
})

test('malformed input still produces a decision rather than throwing', () => {
  for (const facts of [undefined, {}, { verdict: null }, { queueLength: 'x' }]) {
    assert.doesNotThrow(() => decide(facts))
    assert.ok(['mark', 'retry', 'skip', 'stop'].includes(decide(facts).action))
  }
})
