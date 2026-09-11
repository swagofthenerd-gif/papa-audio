'use strict'
// YouTube stopped serving one file with both picture and sound (2026-09), and
// yt-dlp needs a JavaScript runtime for YouTube: every trailer in the app
// had died. The resolver asks for the pair and the stream server copies it
// into one local stream; both trailer paths use it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
function fn(name) {
  const at = MAIN.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = MAIN.indexOf('\nfunction ', at + 1)
  return MAIN.slice(at, next === -1 ? undefined : next)
}

test('the pair format exists and resolveYtUrl returns two URLs for it', () => {
  assert.match(MAIN, /pair: 'bestvideo\[height<=1080\]\[ext=mp4\]\[vcodec\^=avc1\]\+bestaudio\[ext=m4a\]\/bestvideo\[ext=mp4\]\+bestaudio'/)
  const r = fn('resolveYtUrl')
  assert.match(r, /if \(code === 0 && kind === 'pair' && lines\.length >= 2\)/)
  assert.match(r, /resolve\(lines\.slice\(0, 2\)\)/)
  assert.match(r, /ytdlp\.jsRuntimeArgs\(\)\.concat/)
})

test('resolveTrailerStream tries the muxed file, then pairs through the stream server', () => {
  const r = fn('resolveTrailerStream')
  assert.match(r, /resolveYtUrl\(videoId, 'video'\)/)
  assert.match(r, /Requested format is not available/)
  assert.match(r, /resolveYtUrl\(videoId, 'pair'\)/)
  assert.match(r, /_webStream\(\)\.openPair\(pair\[0\], pair\[1\]\)/)
})

test('both trailer IPCs use it; the theatre announces a paired session as web-ready in smooth mode; previews are swept', () => {
  const theatre = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-trailer',"), MAIN.indexOf("ipcMain.handle('video-trailer-url'"))
  assert.match(theatre, /const got = await resolveTrailerStream\(youtubeId\)/)
  assert.match(theatre, /kind: 'web-ready', session: got\.session, title: title \|\| '', trailer: true/)
  assert.match(theatre, /await videoEngine\(\)\.start\(got\.url, \{ wid: null \}\)/, 'purist mode still plays through mpv')
  const url = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-trailer-url'"), MAIN.indexOf("ipcMain.handle('video-pack-select'"))
  assert.match(url, /const got = await resolveTrailerStream\(key\)/)
  assert.match(url, /_notePreviewSession\(got\.session\.id\)/)
  assert.match(fn('_notePreviewSession'), /while \(_previewSessions\.length > 4\)/)
})
