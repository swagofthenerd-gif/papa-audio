'use strict'
// App #53: the slsk-search handler serves persisted results instantly
// (fromCache) and revalidates live in the background, mirroring slsk-browse-user.
// The list logic is covered in search-history.test.js; this asserts the WIRING
// in main.js — that the handler consults the persisted store, returns
// fromCache:true, kicks a revalidation, and that the live path persists results.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const CODE = MAIN
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

test('the slsk-search handler goes through the serve-then-revalidate entry point', () => {
  assert.match(CODE, /ipcMain\.handle\('slsk-search',\s*\(_,\s*args\)\s*=>\s*slskServeSearch\(/,
    'the handler must route through slskServeSearch, not straight to slskRunSearch')
})

test('a persisted hit is served with fromCache:true and triggers a revalidation', () => {
  const fn = CODE.slice(CODE.indexOf('function slskServeSearch('),
    CODE.indexOf('async function slskRunSearch('))
  assert.match(fn, /_searchPersistGet\(query\)/, 'it reads the persisted store')
  assert.match(fn, /fromCache:\s*true/, 'it flags the served copy as cache')
  assert.match(fn, /_searchRevalidate\(/, 'it kicks a background live search')
  // A noCache request (the revalidation itself) must not re-serve from cache.
  assert.match(fn, /!args\.noCache/, 'a forced refresh bypasses the cache serve')
})

test('the revalidation runs a live search with noCache and guards against overlap', () => {
  const fn = CODE.slice(CODE.indexOf('function _searchRevalidate('),
    CODE.indexOf('function _searchRevalidate(') + 700)
  assert.match(fn, /_searchRevalidating\.(has|add)\(/, 'overlapping revalidations are guarded')
  assert.match(fn, /noCache:\s*true/, 'it forces past the in-memory cache')
})

test('the live search persists its final results across restarts', () => {
  const h = CODE.slice(CODE.indexOf('async function slskRunSearch('),
    CODE.indexOf('async function slskRunSearch(') + 8000)
  assert.match(h, /_searchPersistSet\(query,\s*results\)/,
    'a completed live search records its results for the next launch')
})

test('the persisted store is a capped SideStore, not an unbounded blob', () => {
  assert.match(CODE, /searchHistory:\s*new SideStore\(/, 'search history has its own side file')
  const helper = CODE.slice(CODE.indexOf('function _searchPersistSet('),
    CODE.indexOf('function _searchPersistSet(') + 400)
  assert.match(helper, /searchHistory\.put\(/, 'writes go through the capping put()')
})
