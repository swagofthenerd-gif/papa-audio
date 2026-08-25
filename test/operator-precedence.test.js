// `!el.style.display === 'none'` parses as `(!display) === 'none'`, i.e.
// `false === 'none'`, which is ALWAYS false. It reads like a display check and
// silently never fires. One of these made Escape unable to close the context
// menu for as long as the handler has existed.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const FILES = ['src/renderer.js', 'main.js', 'preload.js', 'src/player-shim.js',
  'src/library-health.js', 'src/library-prune.js', 'src/slsk-filters.js']

test('the mistake really does evaluate to a constant false', () => {
  const el = { style: { display: 'flex' } }
  assert.equal(!el.style.display === 'none', false)
  assert.equal(!el.style.display === 'block', false)
  // Even when it IS none, the check is still false -- it can never be right.
  assert.equal(!{ style: { display: 'none' } }.style.display === 'none', false)
})

test('no source file negates the left side of an equality comparison', () => {
  // `!a === b` / `!a !== b`. Excludes `!(a === b)`, which is deliberate.
  const bad = /!\s*[A-Za-z_$][A-Za-z0-9_$]*(?:[.\[][^\s=!]*)*\s*[=!]==/g
  const hits = []
  for (const f of FILES) {
    const p = path.join(__dirname, '..', f)
    if (!fs.existsSync(p)) continue
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      if (bad.test(code)) hits.push(`${f}:${i + 1}: ${code.trim()}`)
      bad.lastIndex = 0
    })
  }
  assert.deepEqual(hits, [], 'negation binds tighter than ===; wrap it as !(a === b)')
})
