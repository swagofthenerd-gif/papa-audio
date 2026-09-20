'use strict'
// Wave 3 backend wiring (roadmap #36, #37, #39, #51, #54 + artistInfo contract).
// These are structural checks against main.js and preload.js: the pure logic each
// item rests on is unit-tested in its own file (airing-calendar, bandwidth-
// schedule, upload-stats, artist-info, providers-jackett); here we only prove the
// handlers, backends and bridge are actually registered, since a working module
// that nothing calls ships nothing.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')

// --- #36 airing calendar --------------------------------------------------

test('#36 airingCalendar IPC is registered and uses the pure bucketer', () => {
  assert.match(MAIN, /ipcMain\.handle\(\s*'video-airing-calendar'/)
  assert.match(MAIN, /airingCalendar\.bucketMonth\(/)
  assert.match(MAIN, /require\('\.\/src\/airing-calendar'\)/)
  assert.match(PRELOAD, /videoAiringCalendar:\s*\(p\) => ipcRenderer\.invoke\('video-airing-calendar'/)
})

test('#36 the calendar tags entries with a followed-only flag', () => {
  // The handler builds the followed key set and hands it to the bucketer as the
  // `followed` option — that is what drives isFollowed per entry.
  assert.match(MAIN, /_followedAiringKeys\(\)/)
  const fn = MAIN.slice(MAIN.indexOf('function _followedAiringKeys'),
    MAIN.indexOf('function _followedAiringKeys') + 400)
  assert.match(fn, /'anime:'/)
  assert.match(fn, /'tv:'/)
})

// --- #37 TMDB collections -------------------------------------------------

test('#37 videoCollection IPC exists and surfaces a collection field', () => {
  assert.match(MAIN, /ipcMain\.handle\(\s*'video-collection'/)
  assert.match(PRELOAD, /videoCollection:\s*\(p\) => ipcRenderer\.invoke\('video-collection'/)
  // The catalog exposes a collection() fetch and a belongs_to_collection mapper.
  const tmdb = root('catalog/tmdb.js')
  assert.match(tmdb, /buildCollectionUrl\(/)
  assert.match(tmdb, /belongs_to_collection/)
  assert.match(tmdb, /async collection\(collectionId\)/)
})

// --- #39 Jackett/Prowlarr -------------------------------------------------

test('#39 Jackett is config-gated and registered in the video backends', () => {
  assert.match(MAIN, /require\('\.\/providers\/jackett'\)/)
  // The lazy getter returns null when unconfigured, so _videoBackends omits it.
  const getter = MAIN.slice(MAIN.indexOf('function jackett()'),
    MAIN.indexOf('function jackett()') + 600)
  assert.match(getter, /jackettUrl/)
  assert.match(getter, /jackettApiKey/)
  assert.match(getter, /return null/)
  // _videoBackends only adds it when jackett() is truthy (configured).
  const backends = MAIN.slice(MAIN.indexOf('function _videoBackends'),
    MAIN.indexOf('function _videoBackends') + 900)
  assert.match(backends, /const jk = torrents \? jackett\(\) : null/)
  assert.match(backends, /withJackett/)
})

test('#39 the Jackett settings keys are whitelisted for the renderer', () => {
  const set = MAIN.slice(MAIN.indexOf('const VIDEO_SETTING_KEYS'),
    MAIN.indexOf('const VIDEO_SETTING_KEYS') + 400)
  assert.match(set, /'jackettUrl'/)
  assert.match(set, /'jackettApiKey'/)
})

// --- #51 bandwidth schedule -----------------------------------------------

test('#51 the schedule get/set IPC is registered and applies a live cap', () => {
  assert.match(MAIN, /ipcMain\.handle\(\s*'slsk-schedule-get'/)
  assert.match(MAIN, /ipcMain\.handle\(\s*'slsk-schedule-set'/)
  assert.match(MAIN, /bandwidthSchedule\.currentLimitKbps\(/)
  assert.match(PRELOAD, /slskScheduleGet:\s*\(\)\s*=> ipcRenderer\.invoke\('slsk-schedule-get'/)
  assert.match(PRELOAD, /slskScheduleSet:\s*\(p\) => ipcRenderer\.invoke\('slsk-schedule-set'/)
})

test('#51 the schedule is re-applied on every download tick', () => {
  const tick = MAIN.slice(MAIN.indexOf('async function dlTick'),
    MAIN.indexOf('async function dlTick') + 1200)
  assert.match(tick, /_applyBandwidthSchedule\(now\)/)
})

// This used to assert the opposite, and the opposite was a lie. The day/night
// schedule throttles video downloads and has never written one byte for
// Soulseek in either direction, so telling the user a Soulseek change needed a
// restart offered him a bounce that would have achieved nothing. Soulseek has
// its own limit now, in Settings -> Soulseek, and the daemon reads that one
// live — measured against slskd 0.26.0.0, not assumed.
test('#51 slsk-schedule-set no longer claims a Soulseek restart it does not need', () => {
  const at = MAIN.indexOf("ipcMain.handle('slsk-schedule-set'")
  const handler = MAIN.slice(at, at + 1400)
  assert.match(handler, /slskdNeedsRestart:\s*false/)
  assert.ok(!/slskdNeedsRestart:\s*true/.test(handler))
  // And nothing in it touches slskd, which is why.
  assert.ok(!/writeSlskdConfig|startSlskd|stopSlskd/.test(handler),
    'if this handler ever does write for Soulseek, the flag has to be revisited')
})

// --- #54 upload awareness -------------------------------------------------

test('#54 the upload-stats IPC, poll and activity event are wired', () => {
  assert.match(MAIN, /ipcMain\.handle\(\s*'slsk-upload-stats'/)
  assert.match(MAIN, /uploadStats\.ingest\(/)
  assert.match(MAIN, /slskUploadPollStart\(/)
  assert.match(MAIN, /safeSend\('slsk-upload-activity'/)
  // The channel takes an options argument now (the sidebar's cachedOk), so the
  // arrow has a parameter — the wiring this test is about is unchanged.
  assert.match(PRELOAD, /slskUploadStats:\s*\(opts\)\s*=> ipcRenderer\.invoke\('slsk-upload-stats'/)
  assert.match(PRELOAD, /onSlskUploadActivity:/)
})

test('#54 the poll cadence is 60s active / 5min idle', () => {
  assert.match(MAIN, /UPLOAD_POLL_ACTIVE_MS = 60 \* 1000/)
  assert.match(MAIN, /UPLOAD_POLL_IDLE_MS = 5 \* 60 \* 1000/)
})

// --- artistInfo contract --------------------------------------------------

test('artistInfo IPC is registered, cached, and timeout-guarded', () => {
  assert.match(MAIN, /ipcMain\.handle\(\s*'artist-info'/)
  assert.match(MAIN, /artistInfo\.resolve\(/)
  assert.match(MAIN, /artistInfoCache/)
  assert.match(PRELOAD, /artistInfo:\s*\(p\) => ipcRenderer\.invoke\('artist-info'/)
  // The fetch helper bounds each request with an AbortController.
  const helper = MAIN.slice(MAIN.indexOf('async function _artistInfoFetchJson'),
    MAIN.indexOf('async function _artistInfoFetchJson') + 900)
  assert.match(helper, /AbortController/)
  assert.match(helper, /REQUEST_TIMEOUT_MS/)
})

test('the new side-stores exist for the upload counters and artist cache', () => {
  assert.match(MAIN, /slskUploadStats: new SideStore\(/)
  assert.match(MAIN, /artistInfoCache: new SideStore\(/)
})
