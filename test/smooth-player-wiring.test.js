'use strict'
// V1 wiring: the smooth player is the default, main serves a session instead
// of spinning mpv, the renderer plays it in the page through the API proxy,
// stop closes the session, and the mini card's picture is a drag surface.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const DECK = fs.readFileSync(path.join(SRC, 'video-player.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = src.indexOf('\nfunction ', at + 1)
  return src.slice(at, next === -1 ? undefined : next)
}

test('main: purist (mpv) is the default again, the stored smooth default is migrated once and a chosen mode is kept; a play opens a web session and announces it; the planner refusing falls back to mpv; stop closes the session', () => {
  assert.match(MAIN, /playerMode: 'purist',/)
  assert.match(MAIN, /if \(stored\.playerMode === 'smooth' && !stored\.playerModeByUser && !stored\.playerModeMigrated\) \{/)
  assert.match(MAIN, /if \(clean\.playerMode\) clean\.playerModeByUser = true/)
  assert.match(CODE, /modeSel\.value = s\.playerMode === 'smooth' \? 'smooth' : 'purist'/)
  const play = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-play'"), MAIN.indexOf("ipcMain.handle('video-trailer'"))
  assert.match(play, /const smooth = _videoSettings\(\)\.playerMode !== 'purist'/)
  assert.match(play, /const sess = await _webOpenAndAnnounce\(url, current, title\)/)
  // A planner refusal goes to mpv; a probe failure is reported instead (V4).
  assert.match(play, /if \(sess\.refused\) \{[\s\S]*?throw new Error\(sess\.reason\)[\s\S]*?await purist\(url\)/)
  assert.match(play, /return \{ ok: true, smooth: true \}/)
  assert.match(fn(MAIN, '_webOpenAndAnnounce'), /safeSend\('video-event', \{ kind: 'web-ready', session: sess, title: title \|\| '' \}\)/)
  const stop = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-stop'"), MAIN.indexOf("ipcMain.handle('video-stop'") + 300)
  assert.match(stop, /_webClose\(\)/)
  assert.match(MAIN, /const \{ createWebStreamServer \} = require\('\.\/web-stream'\)/)
})

test('renderer: the deck is built on the engine proxy, web-ready plays in the page, restore comes back from a double-click', () => {
  assert.match(fn(CODE, '_initVideoUI'), /api: eng \? eng\.wrapApi\(window\.api\) : window\.api,/)
  assert.match(fn(CODE, '_webEngine'), /window\.PapaWebPlayer\.create\(\{/)
  assert.match(fn(CODE, '_webEngine'), /if \(ev\.kind === 'restore'\) \{ if \(_player\) _player\.restore\(\); return \}/)
  const ev = fn(CODE, '_handleVideoEvent')
  assert.match(ev, /payload\.kind === 'web-ready'/)
  assert.match(ev, /eng2\.open\(payload\.session, 0\)/)
  assert.match(ev, /showToast\(payload\.session\.plan\.badges\.join\(' · '\)\)/, 'the planner’s badges are said out loud')
  assert.match(fn(CODE, '_initVideoUI'), /if \(_webPlayer && _webPlayer\.active\(\)\) _webPlayer\.close\(\)\s*window\.api\.videoStop\(\)/, 'stop closes the in-page engine too')
})

test('the picture region is a drag surface; the settings toggle exists; scripts and styles are in place', () => {
  assert.match(DECK, /for \(const el of \[handle, bar, \$\('vmini-video'\)\]\)/)
  assert.match(HTML, /id="video-player-mode"/)
  assert.match(HTML, /<option value="smooth">/)
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('web-player.js') !== -1 && order.indexOf('web-player.js') < order.indexOf('video-player.js'))
  assert.match(CSS, /\.vt-web-video \{ position:absolute; inset:0; width:100%; height:100%; object-fit:contain/)
  assert.match(fn(CODE, '_initVideoSettings'), /save\(\{ playerMode: modeSel\.value \}\)/)
})
