'use strict';
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { createTastePanel, esc } = require(path.join(__dirname, '..', 'src', 'taste-panel.js'))
const { createTasteStore, _memoryStorage } = require(path.join(__dirname, '..', 'src', 'taste-store.js'))

const XSS_NOTE = '<img src=x onerror=alert(1)>'
const XSS_NAME = '</div><script>'

// A real store over memory storage — the panel is only interesting against the
// data layer it actually has to obey.
function fresh(opts) {
  let t = Date.UTC(2026, 0, 2, 12)
  const store = createTasteStore({ storage: _memoryStorage(), now: () => (t += 1000) })
  const changes = []
  const panel = createTastePanel(Object.assign({
    store,
    now: () => t,
    onChange: (action, result) => changes.push({ action, result }),
    labelFor: k => (k === 'movie:238' ? 'The Godfather' : k),
  }, opts || {}))
  return { store, panel, changes }
}

// ── the fake document ───────────────────────────────────────────────────────
// Just enough of an element to carry attributes, a parent chain, form fields
// and delegated listeners, which is everything mount() touches.
function el(tag, attrs, kids) {
  const node = {
    tagName: String(tag).toUpperCase(),
    _attrs: Object.assign({}, attrs || {}),
    children: [],
    parentElement: null,
    listeners: {},
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null },
    setAttribute(n, v) { this._attrs[n] = String(v) },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn)
    },
    append(child) { child.parentElement = this; this.children.push(child); return child },
    querySelector(sel) {
      const m = /^\[name="(.+)"\]$/.exec(sel)
      const name = m ? m[1] : null
      const walk = n => {
        for (const c of n.children) {
          if (name && c.getAttribute('name') === name) return c
          const found = walk(c)
          if (found) return found
        }
        return null
      }
      return walk(this)
    },
    fire(type, ev) {
      for (const fn of (this.listeners[type] || [])) fn(ev)
    },
  }
  for (const k of (kids || [])) node.append(k)
  return node
}

function ev(target, extra) {
  let prevented = false
  return Object.assign({
    target,
    preventDefault() { prevented = true },
    wasPrevented: () => prevented,
  }, extra || {})
}

// ── escaping ────────────────────────────────────────────────────────────────

test('esc neutralises every character that can start markup or close an attribute', () => {
  assert.equal(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;')
  assert.equal(esc(null), '')
})

test('a diary note containing a script-y img tag renders as text, not markup', () => {
  const { store, panel } = fresh()
  store.logViewing('movie:238', { date: '2026-01-01', note: XSS_NOTE })
  const html = panel.renderDiary({ key: 'movie:238' })
  assert.ok(!html.includes('<img'), 'raw tag leaked into the markup')
  const inner = /<p class="tp-entry-note">([\s\S]*?)<\/p>/.exec(html)
  assert.ok(inner, 'the note was not rendered at all')
  assert.equal(inner[1], '&lt;img src=x onerror=alert(1)&gt;', 'the note must reach the page as characters')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'note is not shown escaped')
})

test('a list named </div><script> cannot break out of its row, in the index or open', () => {
  const { store, panel } = fresh()
  const list = store.createList(XSS_NAME)
  store.addToList(list.id, 'movie:238', XSS_NOTE)
  for (const html of [panel.renderLists(), panel.renderList(list.id)]) {
    assert.ok(!html.includes('<script'), 'script tag leaked')
    assert.ok(!html.includes('</div><script>'), 'raw list name leaked')
    assert.ok(html.includes('&lt;/div&gt;&lt;script&gt;'), 'list name is not shown escaped')
  }
  assert.ok(panel.renderList(list.id).includes('&lt;img src=x'), 'entry note is not escaped')
})

test('a key carrying a quote cannot escape the attribute it is written into', () => {
  const { panel } = fresh()
  const html = panel.renderRating('movie:" onmouseover="x')
  assert.ok(!html.includes('onmouseover="x"'), 'attribute was broken open')
  assert.ok(html.includes('&quot; onmouseover=&quot;x'))
})

test('an armed delete warning still escapes the list name it quotes back', () => {
  const { store, panel } = fresh()
  const list = store.createList(XSS_NAME)
  assert.equal(panel.dispatch('list-delete', { id: list.id }).status, 'confirm')
  const html = panel.renderLists()
  assert.ok(html.includes('tp-warn'))
  assert.ok(!html.includes('<script'))
})

// ── ratings ─────────────────────────────────────────────────────────────────

test('a rating round-trips through the panel and into the render', () => {
  const { store, panel, changes } = fresh()
  assert.equal(panel.dispatch('rate', { key: 'movie:238', value: 3.5 }).status, 'ok')
  assert.equal(store.ratingOf('movie:238'), 3.5)
  const html = panel.renderRating('movie:238')
  assert.ok(html.includes('aria-valuenow="3.5"'))
  assert.ok(html.includes('3.5 stars'))
  assert.equal(changes[0].action, 'rate')
})

test('clearing a rating removes it, and is not the same thing as half a star', () => {
  const { store, panel } = fresh()
  panel.dispatch('rate', { key: 'movie:238', value: 0.5 })
  assert.equal(store.ratingOf('movie:238'), 0.5, 'half a star is a real verdict')
  assert.ok(panel.renderRating('movie:238').includes('data-tp-action="rate-clear"'))

  assert.equal(panel.dispatch('rate-clear', { key: 'movie:238' }).status, 'ok')
  assert.equal(store.ratingOf('movie:238'), null)
  const html = panel.renderRating('movie:238')
  assert.ok(!html.includes('rate-clear'), 'offers to clear a rating that is not there')
  assert.ok(html.includes('Not rated'))
})

test('arrow nudges walk half stars and clamp at 0.5 instead of clearing', () => {
  const { store, panel } = fresh()
  panel.dispatch('rate-nudge', { key: 'movie:238', step: 0.5 })
  assert.equal(store.ratingOf('movie:238'), 0.5, 'first press from unrated lands on the lowest star')
  panel.dispatch('rate-nudge', { key: 'movie:238', step: 0.5 })
  assert.equal(store.ratingOf('movie:238'), 1)
  panel.dispatch('rate-nudge', { key: 'movie:238', step: -0.5 })
  panel.dispatch('rate-nudge', { key: 'movie:238', step: -0.5 })
  panel.dispatch('rate-nudge', { key: 'movie:238', step: -0.5 })
  assert.equal(store.ratingOf('movie:238'), 0.5, 'walking down must never silently unrate')
})

test('the rating control is a slider with a text value, not a row of images', () => {
  const { panel } = fresh()
  const html = panel.renderRating('movie:238')
  assert.ok(html.includes('role="slider"'))
  assert.ok(html.includes('tabindex="0"'))
  assert.ok(html.includes('aria-valuetext="Not rated"'))
  assert.ok(html.includes('aria-hidden="true"'), 'the painted stars must be hidden from the reader')
})

// ── seen and the diary ──────────────────────────────────────────────────────

test('marking seen logs a viewing with no playback, and the second is a rewatch', () => {
  const { store, panel } = fresh()
  const first = panel.dispatch('seen', { key: 'movie:238' })
  assert.equal(first.status, 'ok')
  assert.equal(first.entry.rewatch, false)
  assert.equal(store.watchCount('movie:238'), 1)
  assert.ok(panel.renderSeen('movie:238').includes('Log a rewatch'))

  const second = panel.dispatch('seen', { key: 'movie:238' })
  assert.equal(second.entry.rewatch, true)
  assert.equal(store.watchCount('movie:238'), 2)
  assert.ok(panel.renderSeen('movie:238').includes('Seen 2 times'))
})

test('a rewatch adds a diary entry and leaves the rating alone', () => {
  const { store, panel } = fresh()
  panel.dispatch('rate', { key: 'movie:238', value: 4.5 })
  panel.dispatch('seen', { key: 'movie:238' })
  panel.dispatch('seen', { key: 'movie:238' })
  assert.equal(store.diary({ key: 'movie:238' }).length, 2)
  assert.equal(store.ratingOf('movie:238'), 4.5, 'a rewatch must not restate the verdict')
})

test('the diary form defaults to today and pre-ticks rewatch once a title is seen', () => {
  const { panel } = fresh()
  assert.ok(panel.renderDiaryForm('movie:238').includes('value="2026-01-02"'))
  assert.ok(!panel.renderDiaryForm('movie:238').includes('checkbox" name="rewatch" checked'))
  panel.dispatch('seen', { key: 'movie:238' })
  assert.ok(panel.renderDiaryForm('movie:238').includes('name="rewatch" checked'))
})

test('the diary is reverse-chronological, and the general one names its titles', () => {
  const { panel } = fresh()
  panel.dispatch('diary-add', { key: 'movie:238', date: '2026-01-01' })
  panel.dispatch('diary-add', { key: 'movie:999', date: '2026-03-04' })
  const html = panel.renderDiary({})
  assert.ok(html.indexOf('2026-03-04') < html.indexOf('2026-01-01'), 'newest must be first')
  assert.ok(html.includes('The Godfather'), 'general diary must say what was watched')
  assert.ok(!panel.renderDiary({ key: 'movie:238' }).includes('2026-03-04'), 'a title view must not show other titles')
})

test('an empty diary says so rather than rendering an empty list', () => {
  const { panel } = fresh()
  assert.ok(panel.renderDiary({}).includes('Your diary is empty'))
  assert.ok(panel.renderDiary({ key: 'movie:238' }).includes('No viewings logged'))
})

test('editing a note rewrites only the note', () => {
  const { store, panel } = fresh()
  const added = panel.dispatch('diary-add', { key: 'movie:238', date: '2026-01-01', note: 'first pass' })
  panel.dispatch('diary-note', { id: added.entry.id, note: XSS_NOTE })
  const entry = store.diary({ key: 'movie:238' })[0]
  assert.equal(entry.note, XSS_NOTE)
  assert.equal(entry.date, '2026-01-01')
  assert.ok(panel.renderNoteEditor(added.entry.id).includes('&lt;img'))
})

// ── destructive confirmation ────────────────────────────────────────────────

test('deleting a diary entry needs a second press, and the first press keeps it', () => {
  const { store, panel } = fresh()
  const added = panel.dispatch('diary-add', { key: 'movie:238', date: '2026-01-01', note: 'kept' })
  const first = panel.dispatch('diary-delete', { id: added.entry.id })
  assert.equal(first.status, 'confirm')
  assert.equal(store.diary().length, 1, 'the first press must not delete anything')
  assert.ok(panel.renderDiary({}).includes('Really delete'))

  const second = panel.dispatch('diary-delete', { id: added.entry.id })
  assert.equal(second.status, 'ok')
  assert.equal(store.diary().length, 0)
})

test('an arm does not survive another action, so a stray second click cannot delete', () => {
  const { store, panel } = fresh()
  const added = panel.dispatch('diary-add', { key: 'movie:238', date: '2026-01-01' })
  panel.dispatch('diary-delete', { id: added.entry.id })
  panel.dispatch('rate', { key: 'movie:238', value: 3 })      // anything else at all
  assert.equal(panel.dispatch('diary-delete', { id: added.entry.id }).status, 'confirm')
  assert.equal(store.diary().length, 1)
})

test('cancel disarms a pending delete', () => {
  const { store, panel } = fresh()
  const added = panel.dispatch('diary-add', { key: 'movie:238', date: '2026-01-01' })
  panel.dispatch('diary-delete', { id: added.entry.id })
  panel.dispatch('cancel', {})
  assert.equal(panel.isArmed(), null)
  assert.equal(panel.dispatch('diary-delete', { id: added.entry.id }).status, 'confirm')
  assert.equal(store.diary().length, 1)
})

test('deleting a list is two-step, and the panel supplies the name the store demands', () => {
  const { store, panel } = fresh()
  const list = store.createList('Sunday films')
  assert.equal(panel.dispatch('list-delete', { id: list.id }).status, 'confirm')
  assert.equal(store.lists().length, 1)
  assert.equal(panel.dispatch('list-delete', { id: list.id }).status, 'ok')
  assert.equal(store.lists().length, 0)
})

// ── favourites ──────────────────────────────────────────────────────────────

function fourFavourites(panel) {
  for (const k of ['movie:1', 'movie:2', 'movie:3', 'movie:4']) panel.dispatch('fav-add', { key: k })
}

test('a fifth favourite is refused and asks which of the four is leaving', () => {
  const { store, panel } = fresh()
  fourFavourites(panel)
  const fifth = panel.dispatch('fav-add', { key: 'movie:238' })
  assert.equal(fifth.status, 'full')
  assert.deepEqual(store.favourites(), ['movie:1', 'movie:2', 'movie:3', 'movie:4'], 'nothing may be evicted silently')
  assert.equal(panel.isReplacing(), 'movie:238')
  const html = panel.renderFavourites('movie:238')
  assert.ok(html.includes('Your four are full'))
  assert.ok(html.includes('data-tp-replace="movie:2"'))
})

test('the replacement takes the departing favourite s place, not the end of the row', () => {
  const { store, panel } = fresh()
  fourFavourites(panel)
  panel.dispatch('fav-add', { key: 'movie:238' })
  assert.equal(panel.dispatch('fav-replace', { key: 'movie:238', replace: 'movie:2' }).status, 'ok')
  assert.deepEqual(store.favourites(), ['movie:1', 'movie:238', 'movie:3', 'movie:4'])
  assert.equal(panel.isReplacing(), null)
})

test('favourites reorder and remove, and the chooser is not offered when there is room', () => {
  const { store, panel } = fresh()
  panel.dispatch('fav-add', { key: 'movie:1' })
  panel.dispatch('fav-add', { key: 'movie:2' })
  panel.dispatch('fav-move', { key: 'movie:2', to: 0 })
  assert.deepEqual(store.favourites(), ['movie:2', 'movie:1'])
  panel.dispatch('fav-remove', { key: 'movie:2' })
  assert.deepEqual(store.favourites(), ['movie:1'])
  const html = panel.renderFavourites('movie:238')
  assert.ok(html.includes('Make this a favourite'))
  assert.ok(!html.includes('Your four are full'))
})

// ── lists ───────────────────────────────────────────────────────────────────

test('lists can be made, renamed, filled, annotated, reordered and emptied', () => {
  const { store, panel } = fresh()
  const created = panel.dispatch('list-create', { name: '  Noir  ' })
  const id = created.list.id
  assert.equal(store.getList(id).name, 'Noir')

  panel.dispatch('list-rename', { id, name: 'Neo-noir' })
  assert.equal(store.getList(id).name, 'Neo-noir')

  panel.dispatch('list-add', { id, key: 'movie:1' })
  panel.dispatch('list-add', { id, key: 'movie:2' })
  panel.dispatch('list-note', { id, key: 'movie:2', note: XSS_NOTE })
  panel.dispatch('list-move', { id, key: 'movie:2', to: 0 })
  assert.deepEqual(store.getList(id).entries.map(e => e.key), ['movie:2', 'movie:1'])
  assert.equal(store.getList(id).entries[0].note, XSS_NOTE)

  panel.dispatch('list-remove', { id, key: 'movie:1' })
  assert.equal(store.getList(id).entries.length, 1)
  assert.equal(panel.dispatch('list-create', { name: '   ' }).status, 'noop', 'a nameless list is refused')
})

test('a list row offers add or remove depending on whether the title is already in it', () => {
  const { store, panel } = fresh()
  const list = store.createList('Watchlist')
  assert.ok(panel.renderLists('movie:238').includes('>Add to list<'))
  panel.dispatch('list-add', { id: list.id, key: 'movie:238' })
  assert.ok(panel.renderLists('movie:238').includes('>Remove from list<'))
})

// ── profile and year in review ──────────────────────────────────────────────

const META = {
  'movie:1': { directors: ['Kurosawa'], year: 1954, countries: ['Japan'], languages: ['ja'], runtime: 207 },
  'movie:2': { directors: ['Kurosawa'], year: 1950, countries: ['Japan'], languages: ['ja'], runtime: 88 },
  'movie:3': { directors: ['Coppola'], year: 1972, countries: ['USA'], languages: ['en'], runtime: 175 },
}

test('the profile prints breadth and devotion side by side, because they differ', () => {
  const { panel } = fresh()
  panel.dispatch('diary-add', { key: 'movie:1', date: '2026-01-05' })
  panel.dispatch('diary-add', { key: 'movie:2', date: '2026-02-05' })
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-02-06' })
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-02-07' })   // a rewatch
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-02-08' })   // and another

  const html = panel.renderProfile(META)
  assert.ok(/Kurosawa[\s\S]*?<b>2<\/b> films[\s\S]*?2 viewings/.test(html), 'Kurosawa: two films, two viewings')
  assert.ok(/Coppola[\s\S]*?<b>1<\/b> film[\s\S]*?3 viewings/.test(html), 'Coppola: one film watched three times')
  assert.ok(html.includes('<span class="tp-tally-name">Japan</span>'), 'countries are shown')
  // Was asserting "1950", which is what the store holds and reads on screen as
  // a year rather than a decade. The store still holds the number; the panel
  // formats it.
  assert.ok(html.includes('<span class="tp-tally-name">1950s</span>'), 'decades read as decades')
})

test('the profile totals films, viewings and hours separately', () => {
  const { panel } = fresh()
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-01-01' })
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-01-02' })
  const html = panel.renderProfile(META)
  assert.ok(/<dt>Films<\/dt><dd>1<\/dd>/.test(html))
  assert.ok(/<dt>Viewings<\/dt><dd>2<\/dd>/.test(html))
  assert.ok(/<dt>Hours<\/dt><dd>5\.8<\/dd>/.test(html), '175 minutes twice is 5.8 hours')
})

test('an empty profile says it is empty instead of showing zeroes as insight', () => {
  const { panel } = fresh()
  assert.ok(panel.renderProfile(META).includes('Nothing logged yet'))
})

test('the year in review counts months, ratings and the year s directors', () => {
  const { panel } = fresh()
  panel.dispatch('diary-add', { key: 'movie:1', date: '2026-02-10' })
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-02-11' })
  panel.dispatch('diary-add', { key: 'movie:3', date: '2026-07-01' })
  panel.dispatch('diary-add', { key: 'movie:2', date: '2025-07-01' })   // a different year
  const html = panel.renderYearInReview(2026, META)
  assert.ok(html.includes('2026 in review'))
  assert.ok(/<dt>Viewings<\/dt><dd>3<\/dd>/.test(html), 'last year must not be counted')
  assert.ok(html.includes('Kurosawa') && html.includes('Coppola'))
  assert.ok(html.includes('Feb') && html.includes('Dec'))
  // Two in February, one in July, nothing anywhere else.
  const heights = (html.match(/height:(\d+)%/g) || [])
  assert.equal(heights.length, 12)
  assert.equal(heights[1], 'height:100%')
  assert.equal(heights[6], 'height:50%')
  assert.equal(heights[0], 'height:0%')
})

test('a year with nothing in it says so', () => {
  const { panel } = fresh()
  assert.ok(panel.renderYearInReview(1999, META).includes('Nothing logged in 1999'))
})

// ── DOM binding ─────────────────────────────────────────────────────────────

test('a click on a star step rates through the delegated listener', () => {
  const { store, panel } = fresh()
  const root = el('div')
  const rate = root.append(el('div', { 'data-tp-key': 'movie:238' }))
  const step = rate.append(el('button', { 'data-tp-action': 'rate', 'data-tp-value': '4' }))
  panel.mount(root)
  root.fire('click', ev(step))
  assert.equal(store.ratingOf('movie:238'), 4)
})

test('Delete on the slider clears; the arrows walk it; other keys are left alone', () => {
  const { store, panel } = fresh()
  const root = el('div')
  const rate = root.append(el('div', { 'data-tp-key': 'movie:238' }))
  const slider = rate.append(el('div', { 'data-tp-role': 'rating' }))
  panel.mount(root)

  root.fire('keydown', ev(slider, { key: 'End' }))
  assert.equal(store.ratingOf('movie:238'), 5)
  root.fire('keydown', ev(slider, { key: 'ArrowLeft' }))
  assert.equal(store.ratingOf('movie:238'), 4.5)

  const untouched = ev(slider, { key: 'a' })
  root.fire('keydown', untouched)
  assert.equal(untouched.wasPrevented(), false, 'unrelated keys must not be swallowed')
  assert.equal(store.ratingOf('movie:238'), 4.5)

  root.fire('keydown', ev(slider, { key: 'Delete' }))
  assert.equal(store.ratingOf('movie:238'), null)
})

test('submitting the diary form reads its fields and logs the viewing', () => {
  const { store, panel } = fresh()
  const root = el('div')
  const form = root.append(el('form', { 'data-tp-form': 'diary', 'data-tp-key': 'movie:238' }))
  const date = form.append(el('input', { name: 'date' })); date.value = '2026-04-05'; date.type = 'date'
  const re = form.append(el('input', { name: 'rewatch' })); re.type = 'checkbox'; re.checked = true
  const note = form.append(el('textarea', { name: 'note' })); note.value = XSS_NOTE
  panel.mount(root)

  const event = ev(form)
  root.fire('submit', event)
  assert.equal(event.wasPrevented(), true, 'the page must not navigate')
  const entry = store.diary({ key: 'movie:238' })[0]
  assert.equal(entry.date, '2026-04-05')
  assert.equal(entry.rewatch, true)
  assert.equal(entry.note, XSS_NOTE)
  assert.ok(panel.renderDiary({ key: 'movie:238' }).includes('&lt;img'), 'and it is escaped on the way back out')
})

test('unmount takes its listeners with it', () => {
  const { store, panel } = fresh()
  const root = el('div')
  const btn = root.append(el('button', { 'data-tp-action': 'rate', 'data-tp-value': '3', 'data-tp-key': 'movie:238' }))
  const unmount = panel.mount(root)
  unmount()
  root.fire('click', ev(btn))
  assert.equal(store.ratingOf('movie:238'), null)
})

test('the panel refuses to exist without a store', () => {
  assert.throws(() => createTastePanel({}), /needs a store/)
})

// ── the panel and the store, together, after the wiring ────────────────────
//
// The panel could record THAT something was watched and never WHAT: it logged
// viewings with no metadata, so the diary would have shown raw keys like
// "movie:238" and the taste profile — built entirely from directors, years,
// countries, languages and runtime — would have come out empty however much
// history existed. These test the join.

function withMeta(metaByKey) {
  let t = 1700000000000
  const store = createTasteStore({ storage: _memoryStorage(), now: () => (t += 1000) })
  const panel = createTastePanel({
    store,
    now: () => t,
    metaFor: key => metaByKey[key] || null,
    labelFor: key => (metaByKey[key] ? metaByKey[key].title : key),
  })
  return { store, panel }
}

const FILMS = {
  'movie:346': { title: 'Seven Samurai', year: 1954, runtime: 207, directors: ['Akira Kurosawa'], languages: ['Japanese'], countries: ['Japan'] },
  'movie:1': { title: 'Ikiru', year: 1952, runtime: 143, directors: ['Akira Kurosawa'], languages: ['Japanese'], countries: ['Japan'] },
  'movie:3': { title: 'Tokyo Story', year: 1953, runtime: 136, directors: ['Yasujiro Ozu'], languages: ['Japanese'], countries: ['Japan'] },
}

test('a logged viewing carries the film with it', () => {
  const { store, panel } = withMeta(FILMS)
  panel.dispatch('diary-add', { key: 'movie:346', date: '2024-05-20' })
  const entry = store.viewingsOf('movie:346')[0]
  assert.ok(entry.meta, 'the viewing recorded no metadata, so the diary cannot name it')
  assert.strictEqual(entry.meta.title, 'Seven Samurai')
  assert.strictEqual(entry.meta.runtime, 207)
})

test('marking seen carries it too, not only the diary form', () => {
  const { store, panel } = withMeta(FILMS)
  panel.dispatch('seen', { key: 'movie:1' })
  assert.strictEqual(store.viewingsOf('movie:1')[0].meta.title, 'Ikiru')
})

test('the profile is built from what the viewings recorded', () => {
  // The whole point. Without metaFor this came out with no directors, no
  // decades, no countries and zero hours.
  const { store, panel } = withMeta(FILMS)
  for (const key of Object.keys(FILMS)) panel.dispatch('diary-add', { key, date: '2024-01-01' })

  // The map a caller builds from the diary's own snapshots.
  const meta = {}
  for (const e of store.diary()) if (e.meta) meta[e.key] = e.meta

  const p = store.profile(meta)
  assert.strictEqual(p.titles, 3)
  assert.strictEqual(p.topDirectors[0].name, 'Akira Kurosawa', 'two films beats one')
  assert.strictEqual(p.topDirectors[0].count, 2)
  assert.strictEqual(p.decades[0].name, 1950)
  assert.strictEqual(p.totalRuntime, 207 + 143 + 136)
})

test('a film with no metadata still logs, because the evening happened', () => {
  // metaFor returning null must never stop a viewing being recorded: a diary
  // entry is worth more than the facts attached to it.
  const { store, panel } = withMeta({})
  panel.dispatch('diary-add', { key: 'movie:999', date: '2024-01-01' })
  assert.strictEqual(store.viewingsOf('movie:999').length, 1)
  assert.strictEqual(store.viewingsOf('movie:999')[0].meta, null)
})

test('a metaFor that throws does not stop the log', () => {
  let t = 1700000000000
  const store = createTasteStore({ storage: _memoryStorage(), now: () => (t += 1000) })
  const panel = createTastePanel({
    store,
    metaFor: () => { throw new Error('boom') },
  })
  assert.doesNotThrow(() => panel.dispatch('diary-add', { key: 'movie:1', date: '2024-01-01' }))
  assert.strictEqual(store.viewingsOf('movie:1').length, 1)
})

test('a metaFor returning nonsense is ignored rather than stored', () => {
  for (const bad of ['a string', 42, [], true]) {
    let t = 1700000000000
    const store = createTasteStore({ storage: _memoryStorage(), now: () => (t += 1000) })
    const panel = createTastePanel({ store, metaFor: () => bad })
    panel.dispatch('diary-add', { key: 'movie:1', date: '2024-01-01' })
    assert.strictEqual(store.viewingsOf('movie:1')[0].meta, null, String(bad) + ' was stored')
  }
})

test('the favourite reorder goes through the store, not through a whole array', () => {
  // fav-move used to read the four, splice a copy and write the array back,
  // which is the stale-array hazard moveInList exists to avoid.
  const { store, panel } = withMeta(FILMS)
  for (const k of ['a', 'b', 'c', 'd']) store.addFavourite(k)
  panel.dispatch('fav-move', { key: 'd', to: 0 })
  assert.deepStrictEqual(store.favourites(), ['d', 'a', 'b', 'c'])
  // A move of something that is not a favourite changes nothing.
  const before = store.favourites()
  panel.dispatch('fav-move', { key: 'zzz', to: 0 })
  assert.deepStrictEqual(store.favourites(), before)
})

test("the year view's average is the year's, and the panel prints it", () => {
  const { store, panel } = withMeta(FILMS)
  store.logViewing('movie:old', { date: '2023-01-01', meta: FILMS['movie:1'] })
  store.rate('movie:old', 2)
  store.logViewing('movie:346', { date: '2024-05-20', meta: FILMS['movie:346'] })
  store.rate('movie:346', 5)

  // Scoped to the stats block: the rating-distribution rows below it are
  // labelled "3.5 stars" and so contain the lifetime figure as ordinary text.
  const html = panel.renderYearInReview(2024, { 'movie:346': FILMS['movie:346'] })
  // The average's own cell, not the whole stats block: Seven Samurai is 207
  // minutes, which is 3.5 hours, and the Hours figure beside it therefore reads
  // 3.5 — the same number as the lifetime average, by coincidence. Asserting on
  // the block would have been asserting on that coincidence.
  const cell = html.slice(html.indexOf('<dt>Average rating</dt>'))
  const dd = cell.slice(cell.indexOf('<dd>'), cell.indexOf('</dd>'))
  assert.match(dd, /^<dd>5</, 'the 2024 average is 5, not the lifetime 3.5')
  assert.match(dd, /over 1 rated/, 'and it says how many it averaged')

  // The store's own answer, so a change in either would be caught.
  assert.strictEqual(store.yearInReview(2024, {}).averageRating, 5)
  assert.strictEqual(store.profile({}).averageRating, 3.5)
})
