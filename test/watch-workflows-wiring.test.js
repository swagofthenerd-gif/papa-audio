'use strict'
// V2 wiring: one resume rule everywhere, release names on sources with the
// group remembered per show, and television episodes as rows.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const STORE = fs.readFileSync(path.join(SRC, 'video-store.js'), 'utf8')
const HTML = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
function fn(name) {
  const at = RENDERER.indexOf('function ' + name + '(')
  assert.ok(at !== -1, name + ' must exist')
  const next = RENDERER.indexOf('\nfunction ', at + 1)
  return RENDERER.slice(at, next === -1 ? undefined : next)
}

test('the store, the resume offer, the cards and the episode marks all read the one rule', () => {
  assert.match(STORE, /const WATCHED_AT = rules \? rules\.WATCHED_AT : 0\.92/)
  assert.match(STORE, /const MIN_PROGRESS = rules \? rules\.STARTED_AT : 0\.05/)
  assert.match(STORE, /return rules \? rules\.isPartial\(item\.position, dur\)/, 'Continue Watching uses the same partial rule')
  assert.match(fn('_offerResume'), /PapaWatchRules\.resumeOffer\(pos, dur\)/)
  assert.doesNotMatch(fn('_offerResume'), /0\.95/, 'the old 95 % is gone')
  assert.match(fn('_videoCard'), /PapaWatchRules\.progressPct\(item\.position, item\.duration\)/)
  assert.match(RENDERER, /var _EP_STARTED = \(window\.PapaWatchRules && window\.PapaWatchRules\.STARTED_AT\) \|\| 0\.05/)
  assert.ok(HTML.indexOf('<script src="watch-rules.js">') < HTML.indexOf('<script src="video-store.js">'), 'the rules load before the store')
})

test('sources carry their release name; the row shows the group; the group is remembered and preferred', () => {
  for (const p of ['nyaa', 'animetosho', 'eztv', 'knaben', 'solidtorrents', 'apibay', 'jackett', 'yts', 'movie-tv']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'providers', p + '.js'), 'utf8')
    assert.match(src, /\n\s+title(?:: [^\n]+|,)\n/, p + ' keeps the release title on the entry')
  }
  const row = fn('_videoStreamRow')
  assert.match(row, /PapaReleaseName\.parse\(s\.title\)/)
  assert.match(row, /video-source-group/)
  assert.match(fn('_rememberPreferredSource'), /preferredGroup: cand\.group \|\| null/)
  assert.match(fn('_pickMatchingStream'), /if \(want\.group && _releaseGroupOf\(s\) === want\.group\) score \+= 200/)
  assert.match(fn('_preferredSourceOf'), /group: p\.preferredGroup \|\| null/)
  assert.match(RENDERER, /group: _releaseGroupOf\(result\)/, 'a manual pick records its group')
  assert.match(CSS, /\.video-source-group \{/)
})

test('television seasons paint as rows with still, title, date, synopsis, tick, bar and up-next', () => {
  const grid = fn('_tvEpRenderGrid')
  assert.match(grid, /EL\.rows\(shown, prog, _videoState\.episode, Date\.now\(\)\)\.map\(_epRowHtml\)/)
  assert.match(grid, /querySelectorAll\('\.video-episode-btn, \.vep-row'\)/)
  const row = fn('_epRowHtml')
  for (const cls of ['vep-still', 'vep-num', 'vep-bar', 'vep-title', 'vep-meta', 'vep-synopsis', 'vep-mark-seen', 'vep-kicker']) assert.match(row, new RegExp(cls))
  assert.match(row, /loading="lazy"/)
  assert.match(fn('_syncEpisodeSelection'), /'\.video-episode-btn, \.vep-row'/)
  assert.match(CSS, /\.vep-row \{[^}]*grid-template-columns:160px 1fr auto/)
  assert.match(HTML, /<script src="episode-list\.js">/)
})

test('sources that do not carry the title are hidden behind a count, never dropped', () => {
  const load = fn('_loadVideoSources')
  assert.match(load, /const split = _splitPlausibleStreams\(all\)/)
  assert.match(load, /_videoStreamsHidden = split\.unlikely/)
  assert.match(load, /_renderUnlikelyFoot\(target\)/)
  assert.match(load, /Show them anyway/)
  assert.match(fn('_splitPlausibleStreams'), /RN\.plausible\(req, s && s\.title\)/)
  assert.match(fn('_showUnlikelyStreams'), /_videoStreams = _videoStreams\.concat\(_videoStreamsHidden\)/)
  assert.match(fn('_videoStreamRow'), /video-source-unlikely/)
})
