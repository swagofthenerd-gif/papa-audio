'use strict'
// An episode row (still, title, synopsis) plays when pressed, through the
// Play button's own path; it used to only select the episode.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

test('pressing an episode row selects it and presses Play; an unaired row only selects', () => {
  const at = R.indexOf("list.querySelectorAll('.video-episode-btn, .vep-row')")
  const block = R.slice(at, R.indexOf('})\n', R.indexOf("b.addEventListener('keydown'", at)) + 3)
  // Selecting refetches the episode's sources; the autoplay ticket plays once
  // the new list lands (playing at once used the previous episode's list).
  assert.match(block, /if \(!b\.classList\.contains\('unaired'\)\) _autoPlayTicket = _videoDetailTicket\n\s+setEp\(Number\(b\.dataset\.ep\) \|\| 1\)/)
  assert.match(R, /if \(_autoPlayTicket === _videoDetailTicket && streams\.length\) \{\n\s+_autoPlayTicket = 0\n\s+_videoPlayResult\(_autoPickStream\(streams\)\)/)
  assert.match(block, /b\.addEventListener\('click', go\)/)
  assert.match(block, /if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); go\(\) \}/)
})
