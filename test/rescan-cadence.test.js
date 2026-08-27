'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// Two code paths and one document described three different policies: the
// torrent path used 8/25/60, the Soulseek path 15/45/120, and CLAUDE.md
// documented only the second. Nothing linked them but the intention.
test('main, the renderer and the document agree on the rescan cadence', () => {
  const main = root('main.js')
  const renderer = root('src/renderer.js')
  const doc = root('CLAUDE.md')

  const mainDelays = /const LIB_RESCAN_DELAYS = \[([^\]]+)\]/.exec(main)
  assert.ok(mainDelays, 'main.js must declare LIB_RESCAN_DELAYS')
  const fromMain = mainDelays[1].split(',').map(x => Number(x.trim()))

  const rendDelays = /const _LIB_RESCAN_DELAYS = \[([^\]]+)\]/.exec(renderer)
  assert.ok(rendDelays, 'renderer.js must declare _LIB_RESCAN_DELAYS')
  const fromRenderer = rendDelays[1].split(',').map(x => Number(x.trim().replace(/_/g, '')))

  assert.deepStrictEqual(fromMain, fromRenderer, 'the two code paths must use one policy')

  // The document states them in seconds.
  const seconds = fromMain.map(ms => ms / 1000)
  const stated = /rescan\*\* at ([\d]+) s, ([\d]+) s, and ([\d]+) s/.exec(doc)
  assert.ok(stated, 'CLAUDE.md must state the cadence in a form this test can read')
  assert.deepStrictEqual([Number(stated[1]), Number(stated[2]), Number(stated[3])], seconds,
    'the document has to match the code')
})

test('no path schedules a rescan with its own hand-written delays', () => {
  const main = root('main.js')
  // The literal set that used to live in the torrent handler.
  assert.doesNotMatch(main, /\[8000, 25000, 60000\]/, 'use LIB_RESCAN_DELAYS')
})
