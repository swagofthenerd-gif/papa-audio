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

test('the trailer plays inline in the hero with sound and close; the theatre is only the fallback', () => {
  const play = fn('_playInlineTrailer')
  assert.match(play, /window\.api\.videoTrailerUrl\(\{ type: _videoDetail\.type \|\| 'movie', id:/)
  assert.match(play, /_makeTrailerVideo\(res\.url, 'vdet-trailer'\)/)
  assert.match(play, /if \(!res \|\| !res\.ok \|\| !res\.url\) return _playTrailerInTheatre\(\)/)
  assert.match(play, /if \(!v\.muted && state\.isPlaying\) \{ _inlineTrailer\.pausedMusic = true; togglePlay\(\) \}/, 'sound on pauses the music')
  assert.match(fn('_stopInlineTrailer'), /if \(!state\.isPlaying\) togglePlay\(\)/, 'and the music comes back')
  assert.match(fn('_bindTrailerButton'), /addEventListener\('click', _playInlineTrailer\)/)
  assert.match(RENDERER, /if \(typeof _stopInlineTrailer === 'function'\) _stopInlineTrailer\(\)/, 'navigation ends it')
  assert.match(CSS, /\.video-detail-hero\.is-trailer-playing \.vdet-trailer \{ opacity:1; \}/)
})

test('the detail page is keyboard-complete and the music shortcuts stand down for its keys', () => {
  // 0 joined the set when the season shortcut learned to reach past nine
  // (audit N19); the mapping itself is test/video-season-shortcut.test.js.
  assert.match(RENDERER, /var _DETAIL_KEYS = \/\^\(\?:\[pstPST0-9\]\|Escape\)\$\//)
  const grid = RENDERER.slice(RENDERER.indexOf('if (!VIDEO_PAGES.has(page)) return'), RENDERER.indexOf('function _moveCardFocus('))
  assert.match(grid, /if \(k === 'p'\) document\.getElementById\('vdet-play'\)\?\.click\(\)/)
  assert.match(grid, /if \(k === 's'\) document\.getElementById\('vdet-list'\)\?\.click\(\)/)
  assert.match(grid, /if \(k === 't'\) document\.getElementById\('video-trailer-btn'\)\?\.click\(\)/)
  // The season branch moved out to _pickSeasonByKey so Shift+digit can reach it.
  assert.match(grid, /if \(page === 'video-detail' && _pickSeasonByKey\(e\)\)/)
  assert.match(RENDERER, /sel\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/)
  assert.match(RENDERER, /state\.currentPage === 'video-detail' && !e\.ctrlKey && !e\.altKey && !e\.metaKey && !e\.shiftKey &&\n\s+_DETAIL_KEYS\.test\(e\.key\) && e\.key !== 'Escape' && !inInputNow\(e\)\) return/)
  for (const k of ["keys: \\['P'\\]", "keys: \\['S'\\]", "keys: \\['T'\\]"]) assert.match(RENDERER, new RegExp("category: 'Movies & TV page', " + k))
  // The season entry's label now comes from the keymap, so the sheet and the
  // mapping cannot disagree about where the digits reach.
  assert.match(RENDERER, /window\.PapaVideoKeymap\.SEASON_KEYS_LABEL/)
})

test('V2.5 small repairs: collections sort by year and never claim Watching; untitled airing entries are skipped; rating slots are blank, not dashed; a diary delete has Undo', () => {
  assert.match(RENDERER, /\.sort\(function \(a, b\) \{ return \(Number\(a\.year\) \|\| 9999\) - \(Number\(b\.year\) \|\| 9999\)/)
  assert.match(RENDERER, /'Part ' \+ \(i \+ 1\) \+ \(isCurrent \? ' <span class="vseason-here">this page<\/span>' : ''\)/)
  assert.doesNotMatch(RENDERER, /isCurrent \? 'Watching'/)
  assert.match(RENDERER, /const shown = items\.filter\(function \(e\) \{ return e && e\.title \}\)/)
  assert.match(fn('_vRatesHtml'), /\(has \? esc\(s\.fmt\(raw\)\) : '&nbsp;'\)/)
  const change = fn('_onTasteChange')
  assert.match(change, /if \(action === 'diary-delete' && result && result\.entry\)/)
  assert.match(change, /showSnackbar\('Viewing removed from your diary', 'Undo'/)
  assert.match(change, /window\.PapaTasteStore\.restoreViewing\(gone\)/)
  assert.match(RENDERER, /onChange: function \(action, result\) \{ _onTasteChange\(action, result\) \}/)
})
