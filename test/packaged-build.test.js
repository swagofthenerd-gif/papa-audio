'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// Specifying `files` REPLACES electron-builder's default of everything, so a
// local module main.js requires and the list omits is missing from the packaged
// app — MODULE_NOT_FOUND at the first require, before a window ever opens. This
// went unnoticed because launch.sh runs electron directly against the source
// tree; the RPM path (dist/linux-unpacked) is the one that breaks.
test('every local module main.js requires is in the packaged build', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const required = [...main.matchAll(/require\(\s*'\.\/([^']+)'\s*\)/g)].map(m => m[1])
  assert.ok(required.length >= 8, `expected several local requires, found ${required.length}`)

  const files = pkg.build.files
  const covered = (rel) => {
    const withExt = /\.js$/.test(rel) ? rel : rel + '.js'
    return files.some(pattern => {
      if (pattern.startsWith('!')) return false
      if (pattern === withExt || pattern === rel) return true
      // A directory glob such as "src/**" covers anything beneath it.
      const dir = pattern.replace(/\/\*\*$/, '')
      return pattern.endsWith('/**') && withExt.startsWith(dir + '/')
    })
  }

  const missing = required.filter(r => !covered(r))
  assert.deepStrictEqual(missing, [],
    'these are required at startup and would be absent from a packaged build')
})

test('the files list is still valid JSON with no duplicates', () => {
  const files = pkg.build.files
  assert.deepStrictEqual(files, [...new Set(files)], 'duplicate patterns')
  assert.ok(files.includes('main.js') && files.includes('preload.js'))
})
