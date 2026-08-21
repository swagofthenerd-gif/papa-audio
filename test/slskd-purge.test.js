const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')

test('stale searches are purged when slskd becomes ready', () => {
  assert.ok(main.includes('async function purgeStaleSearches'), 'purge function must exist')
  // Both paths reach a ready daemon: one we spawned, and one already running.
  const calls = (main.match(/await purgeStaleSearches\(\)/g) || []).length
  assert.ok(calls >= 2, `expected a purge on both startup paths, found ${calls}`)
})

test('the purge only deletes finished searches, never a running one', () => {
  const fn = main.slice(main.indexOf('async function purgeStaleSearches'))
    .slice(0, main.slice(main.indexOf('async function purgeStaleSearches')).indexOf('\n}\n') + 3)
  assert.ok(/Completed|Errored|TimedOut/.test(fn), 'must filter by finished states')
  assert.ok(!/filter\(\s*\(?s\)?\s*=>\s*true/.test(fn), 'must not delete indiscriminately')
  // A failed delete must not abort the loop and leave the rest leaked.
  assert.ok(fn.includes('catch'), 'individual deletes must be guarded')
})
