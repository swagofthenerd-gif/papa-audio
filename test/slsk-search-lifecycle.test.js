// Lifecycle invariants for runSlskSearch. These are structural because the
// behaviour needs a live Soulseek network to exercise end to end.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const R = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')
const start = R.indexOf('async function runSlskSearch(')
assert.ok(start > -1)
const fn = R.slice(start, R.indexOf('\nfunction ', start))

test('each search takes a generation ticket', () => {
  assert.ok(/const myRun = \+\+_slskRun/.test(fn), 'searches must be generation-tagged')
  assert.ok(/_slskRun === myRun/.test(fn), 'callbacks must compare against it')
})

test('every async callback checks it is still the current search', () => {
  // Merge, progress, per-variant resolve/reject, the repaint tick and the
  // teardown all mutate shared state on the single `slsk` object.
  //
  // Counts `if (!current())` however the condition is extended: the per-variant
  // resolve also checks the daemon-side `cancelled` flag now, and that is a
  // stronger guard, not the absence of one.
  const guards = (fn.match(/if \(!current\(\)(?: \|\| \w+)?\) return/g) || []).length
  assert.ok(guards >= 5, `expected >=5 staleness guards, found ${guards}`)
})

test('completion paints the final state before tearing down the timer', () => {
  const i = fn.indexOf('slsk.searched  = true')
  assert.ok(i > -1)
  const tail = fn.slice(i, i + 600)
  const paint = tail.indexOf('_slskRepaint(query)')
  const kill = tail.indexOf('clearInterval(_slskTimer)')
  assert.ok(paint > -1, 'the finished state must be painted')
  assert.ok(kill > -1 && paint < kill,
    'paint must happen BEFORE the repaint timer is cleared, or the last batch of results never renders')
})

test('a results section that is off screen never stops the search (R3)', () => {
  // The search is a background job that writes to `slsk`; the page that
  // carries #slsk-section paints from that state when it renders. Bailing
  // when the section was missing is what turned "navigate away two seconds
  // into a search, come back" into a false "No results".
  assert.ok(!/if \(!section\)/.test(fn), 'no early return on a missing section')
  assert.ok(!/section\.innerHTML = renderSoulseekRow/.test(fn), 'painting goes through _slskRepaint, which tolerates a missing section')
  const off = fn.indexOf('if (!slsk.status.connected)')
  assert.ok(off > -1)
  const branch = fn.slice(off, off + 400)
  assert.ok(/slsk\.searching = false/.test(branch), 'not-connected must clear searching, or the spinner sticks forever')
  assert.ok(!/slsk\.searched = true/.test(branch), 'not-connected is NOT a finished search: the connection coming up must be able to run it')
  assert.ok(/_slskRepaint\(query\)/.test(branch))
})

test('a partial failure keeps the results that did arrive', () => {
  // slsk.error is set per failed variant; the error state must only replace the
  // results view when there is genuinely nothing to show.
  const render = R.slice(R.indexOf('function renderSoulseekRow('))
  const errBranch = render.indexOf('if (slsk.error)')
  const guard = render.lastIndexOf('if (!groups.length)', errBranch)
  assert.ok(guard > -1 && guard < errBranch,
    'the error view must be gated behind having no groups')
})
