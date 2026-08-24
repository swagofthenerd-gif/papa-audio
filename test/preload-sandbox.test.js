'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

// Electron runs preload scripts sandboxed by default. A sandboxed preload's
// require() resolves only a small allowlist of builtins — requiring a local
// module throws, which aborts the whole preload and leaves window.api
// undefined, blanking the app. Static check because reproducing it needs a
// full Electron boot.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

test('preload requires no local modules', () => {
  const requires = [...SRC.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  const local = requires.filter(r => r.startsWith('.') || r.startsWith('/'))
  assert.deepStrictEqual(local, [], `sandboxed preload cannot require local modules: ${local.join(', ')}`)
})

test('preload only requires electron', () => {
  const requires = [...SRC.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  assert.deepStrictEqual([...new Set(requires)], ['electron'])
})

test('every exposed EQ API goes through ipcRenderer', () => {
  const eqLines = SRC.split('\n').filter(l => /^\s*eq[A-Z]/.test(l))
  assert.ok(eqLines.length >= 2, 'expected the EQ bridge methods to be present')
  for (const line of eqLines) {
    assert.match(line, /ipcRenderer\.invoke/, `EQ bridge must use IPC, not a local table: ${line.trim()}`)
  }
})

test('library-updated and scan-progress are subscribable', () => {
  // main emits both after every mutation and after the folder watcher fires.
  // They were absent from the allowlist, so the UI never refreshed itself.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8')
  const allowed = src.slice(src.indexOf('const allowed = ['), src.indexOf(']', src.indexOf('const allowed = [')))
  assert.match(allowed, /'library-updated'/)
  assert.match(allowed, /'scan-progress'/)
})
