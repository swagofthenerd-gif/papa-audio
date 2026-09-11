'use strict'
// R18: the smart-queues banner reports the whole library, counting what was
// already analysed, so an already-analysed library never reads "0 of N (0%)".
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('startAnalysisRun reports done = already-analysed + this pass, over the whole library', () => {
  const fn = MAIN.slice(MAIN.indexOf('function startAnalysisRun()'), MAIN.indexOf('function startAnalysisRun()') + 3000)
  assert.match(fn, /const already = tracks\.filter\(t => t && t\.filePath && !runnerNeedsAnalysis\(t, existingNow\.get\(t\.filePath\)\)\)\.length/)
  assert.match(fn, /const wholeLibrary = p => \(\{ \.\.\.p, done: already \+ \(Number\(p && p\.done\) \|\| 0\), total: tracks\.length \}\)/)
  assert.match(fn, /onProgress: p => safeSend\('queue-analysis-progress', wholeLibrary\(p\)\)/)
  assert.match(fn, /\{ done: already \+ r\.analysed, total: tracks\.length, finished: !r\.halted, halted: r\.halted \}/)
  assert.match(MAIN, /needsAnalysis: runnerNeedsAnalysis \} = require\('\.\/analysis-runner'\)/)
})
