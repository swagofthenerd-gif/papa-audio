'use strict'
// J4 wiring: the Trail page exists, is reachable, restores moments through
// the same journeys the Omnibox takes, and Home offers the latest session.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
const CODE = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = CODE.indexOf('\nfunction ', at + 1)
  return CODE.slice(at, next === -1 ? undefined : next)
}

test('the Trail is a page: nav item, router, command, Omnibox place, model loaded before the renderer', () => {
  assert.match(HTML, /data-page="trail" id="nav-trail"/)
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(order.indexOf('trail-model.js') !== -1 && order.indexOf('trail-model.js') < order.indexOf('renderer.js'))
  assert.match(CODE, /else if \(page === 'trail'\)\s*renderTrail\(\)/)
  assert.match(CODE, /id:'nav-trail', label:'Go to your Trail'/)
  const model = fs.readFileSync(path.join(SRC, 'omnibox-model.js'), 'utf8')
  assert.match(model, /page: 'trail',\s*label: 'Your Trail'/)
  assert.match(CSS, /\.trail-episode\s*\{/)
})

test('the page reads the three stores through the model and restores through the shared journeys', () => {
  assert.match(fn('_trailSources'), /searches: mem \? mem\.list\(\) : \[\], plays: state\.playHistory \|\| \[\], watches: watches/)
  assert.match(fn('_trailEpisodes'), /window\.PapaTrail\.build\(_trailSources\(\)\)/)
  const r = fn('_restoreMoment')
  for (const k of ['search', 'album', 'artist', 'track', 'video']) assert.match(r, new RegExp("case '" + k + "'"))
  assert.match(r, /requestVideoSearch\(r\.q\); navigate\('video'\)/)
  assert.match(r, /else commitSearchQuery\(r\.q\)/)
  const page = fn('renderTrail')
  assert.match(page, /T\.exportJson\(eps\)/)
  assert.match(page, /window\.PapaSearchMemory\.SURFACES\.forEach\(function \(s\) \{ mem\.clear\(s\) \}\)/, 'erase forgets searches only')
  assert.match(page, /_mgConfirm\('Forget every remembered search\?'/, 'erase asks first')
})

test('Home has a "Pick up where you left off" row fed by the trail, placed after Continue listening', () => {
  assert.match(CODE, /var _HOME_DEFAULT_ROWS = \['jumpback', 'trail', 'quick'/)
  assert.match(CODE, /trail: _homeTrailHtml\(\),/)
  assert.match(CODE, /trail: 'Pick up where you left off'/)
  assert.match(fn('_homeTrailHtml'), /window\.PapaTrail\.pickUp\(_trailEpisodes\(\), 3\)/)
  assert.match(fn('_homeTrailHtml'), /data-page="trail">See the trail/)
  assert.match(CODE, /_bindHomeTrail\(\)\s*document\.getElementById\('jumpback-card'\)/)
})
