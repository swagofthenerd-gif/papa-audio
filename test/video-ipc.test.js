'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')

const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const MAIN_CODE = strip(MAIN)
const PRELOAD_CODE = strip(PRELOAD)

const HANDLERS = [
  'video-settings-get', 'video-settings-set', 'video-catalog-get',
  'video-search', 'video-detail', 'video-streams', 'video-probe',
  'video-play', 'video-stop',
]

const PRELOAD_METHODS = [
  'videoSettingsGet', 'videoSettingsSet', 'videoCatalogGet',
  'videoSearch', 'videoDetail', 'videoStreams', 'videoProbe',
  'videoPlay', 'videoStop', 'onVideoEvent',
]

test('every Papa Video handler is registered in main', () => {
  const registered = new Set([...MAIN_CODE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]))
  const missing = HANDLERS.filter(h => !registered.has(h))
  assert.deepStrictEqual(missing, [], 'these video handlers are not registered')
})

test('the video IPC timeout map carries generous budgets', () => {
  const tbl = MAIN.slice(MAIN.indexOf('const IPC_TIMEOUT_OVERRIDES = {'), MAIN.indexOf('const _ipcRawHandle'))
  assert.match(tbl, /'video-probe': \d+/)
  assert.match(tbl, /'video-play': \d+/)
})

test('the preload surface exposes the video methods', () => {
  const exposed = new Set([...PRELOAD_CODE.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map(m => m[1]))
  const missing = PRELOAD_METHODS.filter(m => !exposed.has(m))
  assert.deepStrictEqual(missing, [], 'these video methods are not exposed on window.api')
})

test('video-event is in the preload channel allowlist', () => {
  const start = PRELOAD.indexOf('const allowed = [')
  const end = PRELOAD.indexOf(']', start)
  const allowed = PRELOAD.slice(start, end)
  assert.match(allowed, /'video-event'/, 'main sends video-event; preload must allow it')
})
