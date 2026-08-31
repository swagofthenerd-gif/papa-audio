'use strict';
// The face of the film diary.
//
// taste-store.js holds a decade of hand-typed history and has no interface at
// all; this module is that interface, and nothing else. It builds HTML strings
// and binds behaviour to them, exactly like video-player.js, so the renderer
// can drop the same panels into the detail page and into a stats page without
// either page knowing how a rating is stored.
//
// Three decisions worth stating up front, because they are the ones that would
// be wrong by default:
//
//  1. Everything a person typed is escaped on the way out. Notes and list names
//     are free text going straight into innerHTML; a note reading
//     "<img src=x onerror=…>" must appear on screen as those characters. There
//     is exactly one function that turns user data into markup (esc), and no
//     interpolation in this file bypasses it.
//
//  2. Every mutation goes through dispatch(), never through a listener body.
//     The delegated DOM listener only translates an event into a call to
//     dispatch, which means the whole of the panel's behaviour is reachable
//     from a test with no DOM at all — and the behaviour that matters here
//     (clearing a rating, refusing a fifth favourite, confirming a delete) is
//     behaviour, not markup.
//
//  3. Destruction is two-step and the step lives here, not in the store. A
//     diary entry is a sentence someone wrote about an evening and there is no
//     upstream to re-fetch it from, so the first click arms and the second
//     commits. Arming is per-target and is dropped as soon as anything else
//     happens.
//
// UMD-wrapped like taste-store.js and video-player.js so it loads as a classic
// <script> in the renderer and via require() in tests.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaTastePanel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const MAX_FAVOURITES = 4
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const STARS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]

  // The single escape. `'` and `"` are in here because half the call sites are
  // attribute values, and remembering which is which at each call site is the
  // way this eventually gets it wrong.
  function esc(value) {
    if (value === null || value === undefined) return ''
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function starGlyphs(value) {
    const v = Number(value) || 0
    let out = ''
    for (let i = 1; i <= 5; i += 1) {
      if (v >= i) out += '<i class="tp-star is-full"></i>'
      else if (v >= i - 0.5) out += '<i class="tp-star is-half"></i>'
      else out += '<i class="tp-star"></i>'
    }
    return out
  }

  function ratingWords(value) {
    const v = Number(value)
    if (!v) return 'Not rated'
    return v === 1 ? '1 star' : v + ' stars'
  }

  function todayISO(ts) {
    const d = new Date(typeof ts === 'number' ? ts : Date.now())
    const pad = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function pct(n, max) {
    const m = Number(max) || 0
    if (m <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((Number(n) || 0) / m * 100)))
  }

  function createTastePanel(opts) {
    const o = opts || {}
    const store = o.store
    const doc = o.doc || (typeof document !== 'undefined' ? document : null)
    const onChange = typeof o.onChange === 'function' ? o.onChange : function () {}
    const now = typeof o.now === 'function' ? o.now : () => Date.now()
    // Keys are opaque ("movie:238"); only the caller knows a title for one. When
    // it cannot say, the key itself is shown rather than an empty row, because a
    // diary that hides what it recorded is worse than an ugly one.
    const labelFor = typeof o.labelFor === 'function' ? o.labelFor : (k => k)

    if (!store) throw new Error('createTastePanel needs a store')

    // Armed destructive actions: target id -> when it was armed. Any other
    // dispatch disarms, so an arm cannot survive a page change and fire on the
    // next unrelated click.
    let armed = null

    function label(key) {
      let out = null
      try { out = labelFor(key) } catch (_) { out = null }
      return out === null || out === undefined || out === '' ? String(key) : String(out)
    }

    // ── rating ─────────────────────────────────────────────────────────────
    // A slider, not a row of clickable images: half stars over a 0.5 range are
    // a target of a few pixels, and someone who cannot use a pointer precisely
    // is exactly who needs the arrows. The stars are painted decoration
    // (aria-hidden) sitting on top of a real role="slider" that announces
    // "3.5 stars" rather than ten anonymous buttons.
    function renderRating(key) {
      const value = store.ratingOf(key)
      const has = value !== null && value !== undefined
      return '' +
        '<div class="tp-rate" data-tp-key="' + esc(key) + '">' +
          '<div class="tp-rate-slider" role="slider" tabindex="0"' +
            ' data-tp-role="rating"' +
            ' aria-label="Your rating for ' + esc(label(key)) + '"' +
            ' aria-valuemin="0" aria-valuemax="5" aria-step="0.5"' +
            ' aria-valuenow="' + esc(has ? value : 0) + '"' +
            ' aria-valuetext="' + esc(ratingWords(value)) + '">' +
            '<span class="tp-stars" aria-hidden="true">' + starGlyphs(value) + '</span>' +
          '</div>' +
          // Pointer users get the ten steps too, but they are secondary and are
          // hidden from the reader, which already has the slider.
          '<span class="tp-rate-steps" aria-hidden="true">' +
            STARS.map(v => '<button type="button" class="tp-rate-step' + (has && value >= v ? ' is-on' : '') +
              '" data-tp-action="rate" data-tp-value="' + v + '" tabindex="-1"' +
              ' title="' + esc(ratingWords(v)) + '"></button>').join('') +
          '</span>' +
          '<span class="tp-rate-value">' + esc(ratingWords(value)) + '</span>' +
          // Clearing is its own control and its own key (Delete). Dragging to
          // the bottom gives 0.5, which is a real verdict and must not be the
          // same gesture as never having said.
          (has
            ? '<button type="button" class="tp-clear" data-tp-action="rate-clear">Clear rating</button>'
            : '') +
        '</div>'
    }

    // ── seen ───────────────────────────────────────────────────────────────
    // Most of what anyone has seen they saw somewhere else, years before this
    // app existed. Logging that must never require pressing play.
    function renderSeen(key) {
      const count = store.watchCount(key)
      const seen = store.hasSeen(key)
      const first = !seen
      return '' +
        '<div class="tp-seen" data-tp-key="' + esc(key) + '">' +
          '<button type="button" class="tp-btn' + (seen ? ' is-on' : '') + '" data-tp-action="seen"' +
            ' aria-pressed="' + (seen ? 'true' : 'false') + '">' +
            (first ? 'I have seen this' : 'Log a rewatch') +
          '</button>' +
          '<span class="tp-seen-count">' +
            (count === 0
              ? (seen ? 'Seen, no date recorded' : 'Not seen')
              : (count === 1 ? 'Seen once' : 'Seen ' + count + ' times')) +
          '</span>' +
        '</div>'
    }

    // ── diary form ─────────────────────────────────────────────────────────
    function renderDiaryForm(key, prefill) {
      const p = prefill || {}
      const date = p.date || todayISO(now())
      const rewatch = p.rewatch === undefined ? store.hasSeen(key) : !!p.rewatch
      return '' +
        '<form class="tp-form" data-tp-form="diary" data-tp-key="' + esc(key) + '">' +
          '<label class="tp-field"><span>Date watched</span>' +
            '<input type="date" name="date" value="' + esc(date) + '" required></label>' +
          '<label class="tp-check">' +
            '<input type="checkbox" name="rewatch"' + (rewatch ? ' checked' : '') + '>' +
            '<span>I had seen this before</span></label>' +
          '<label class="tp-field"><span>Note <em>(optional)</em></span>' +
            '<textarea name="note" rows="3" placeholder="What stayed with you?">' + esc(p.note) + '</textarea></label>' +
          '<button type="submit" class="tp-btn is-primary" data-tp-action="diary-add">Add to diary</button>' +
        '</form>'
    }

    // ── diary ──────────────────────────────────────────────────────────────
    function renderDiaryEntry(entry, withTitle) {
      const isArmed = armed === entry.id
      return '' +
        '<li class="tp-entry' + (isArmed ? ' is-armed' : '') + '" data-tp-id="' + esc(entry.id) + '">' +
          '<time class="tp-entry-date" datetime="' + esc(entry.date) + '">' + esc(entry.date) + '</time>' +
          (withTitle ? '<span class="tp-entry-title">' + esc(label(entry.key)) + '</span>' : '') +
          (entry.rewatch ? '<span class="tp-tag">rewatch</span>' : '') +
          (entry.rating ? '<span class="tp-entry-rating" title="' + esc(ratingWords(entry.rating)) + '">' +
            '<span aria-hidden="true">' + starGlyphs(entry.rating) + '</span>' +
            '<span class="tp-sr">' + esc(ratingWords(entry.rating)) + '</span></span>' : '') +
          (entry.note ? '<p class="tp-entry-note">' + esc(entry.note) + '</p>' : '') +
          '<span class="tp-entry-acts">' +
            '<button type="button" class="tp-link" data-tp-action="diary-edit">Edit note</button>' +
            (isArmed
              ? '<button type="button" class="tp-link is-danger" data-tp-action="diary-delete">Really delete</button>' +
                '<button type="button" class="tp-link" data-tp-action="cancel">Keep it</button>'
              : '<button type="button" class="tp-link" data-tp-action="diary-delete">Delete</button>') +
          '</span>' +
          (isArmed ? '<p class="tp-warn" role="alert">This entry is only written down here. Deleting it is final.</p>' : '') +
        '</li>'
    }

    // One title's viewing history, or — with no key — the whole diary. Both are
    // reverse-chronological; the store already sorts, this only paints.
    function renderDiary(query) {
      const q = query || {}
      const entries = store.diary(q)
      const withTitle = !q.key
      if (!entries.length) {
        return '<div class="tp-diary tp-empty">' +
          (withTitle ? 'Your diary is empty. Anything you log turns up here.' : 'No viewings logged for this yet.') +
          '</div>'
      }
      return '<ol class="tp-diary">' + entries.map(e => renderDiaryEntry(e, withTitle)).join('') + '</ol>'
    }

    function renderNoteEditor(id) {
      const entry = store.diary().find(e => e.id === id)
      if (!entry) return ''
      return '' +
        '<form class="tp-form tp-note-edit" data-tp-form="note" data-tp-id="' + esc(id) + '">' +
          '<label class="tp-field"><span>Note</span>' +
            '<textarea name="note" rows="3">' + esc(entry.note) + '</textarea></label>' +
          '<button type="submit" class="tp-btn is-primary" data-tp-action="diary-note">Save note</button>' +
          '<button type="button" class="tp-link" data-tp-action="cancel">Cancel</button>' +
        '</form>'
    }

    // ── favourites ─────────────────────────────────────────────────────────
    // Four, and the store refuses a fifth outright rather than quietly dropping
    // one. So the panel never pretends a fifth was added: it says the shelf is
    // full and asks which of the four is leaving, and the replacement takes the
    // departing film's position so the order someone chose is not reshuffled by
    // an edit. Silently evicting the oldest would be the easy version and would
    // lose a choice made deliberately.
    let replacing = null

    function renderFavourites(currentKey) {
      const keys = store.favourites()
      const already = currentKey ? keys.indexOf(currentKey) >= 0 : false
      let html = '<div class="tp-favs">' +
        '<h3 class="tp-h">Favourites</h3>' +
        '<p class="tp-sub">Four films, in your order. There is no fifth.</p>'
      html += keys.length
        ? '<ol class="tp-fav-list">' + keys.map((k, i) => '' +
            '<li class="tp-fav" data-tp-key="' + esc(k) + '">' +
              '<span class="tp-fav-n" aria-hidden="true">' + (i + 1) + '</span>' +
              '<span class="tp-fav-title">' + esc(label(k)) + '</span>' +
              '<button type="button" class="tp-icon" data-tp-action="fav-move" data-tp-to="' + (i - 1) + '"' +
                (i === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(label(k)) + ' up">&#9650;</button>' +
              '<button type="button" class="tp-icon" data-tp-action="fav-move" data-tp-to="' + (i + 1) + '"' +
                (i === keys.length - 1 ? ' disabled' : '') + ' aria-label="Move ' + esc(label(k)) + ' down">&#9660;</button>' +
              '<button type="button" class="tp-link" data-tp-action="fav-remove"' +
                ' aria-label="Remove ' + esc(label(k)) + ' from favourites">Remove</button>' +
            '</li>').join('') + '</ol>'
        : '<p class="tp-empty">Nothing chosen yet.</p>'

      if (currentKey && !already) {
        if (replacing === currentKey) {
          html += '<div class="tp-replace" role="group" aria-label="Choose a favourite to replace">' +
            '<p class="tp-warn">Your four are full. ' + esc(label(currentKey)) +
              ' can take one of their places — pick which.</p>' +
            keys.map(k => '<button type="button" class="tp-btn" data-tp-action="fav-replace"' +
              ' data-tp-replace="' + esc(k) + '" data-tp-key="' + esc(currentKey) + '">' +
              'Replace ' + esc(label(k)) + '</button>').join('') +
            '<button type="button" class="tp-link" data-tp-action="cancel">Leave them as they are</button>' +
          '</div>'
        } else {
          html += '<button type="button" class="tp-btn" data-tp-action="fav-add" data-tp-key="' + esc(currentKey) + '">' +
            (keys.length >= MAX_FAVOURITES ? 'Make this a favourite&hellip;' : 'Make this a favourite') +
            '</button>'
        }
      }
      return html + '</div>'
    }

    // ── lists ──────────────────────────────────────────────────────────────
    function renderLists(currentKey) {
      const all = store.lists()
      let html = '<div class="tp-lists"><h3 class="tp-h">Lists</h3>'
      html += '<form class="tp-form tp-inline" data-tp-form="list-create">' +
        '<label class="tp-field"><span>New list</span>' +
          '<input type="text" name="name" placeholder="Films to watch with my brother" required></label>' +
        '<button type="submit" class="tp-btn is-primary" data-tp-action="list-create">Create</button>' +
      '</form>'
      html += all.length
        ? '<ul class="tp-list-index">' + all.map(l => renderListRow(l, currentKey)).join('') + '</ul>'
        : '<p class="tp-empty">No lists yet.</p>'
      return html + '</div>'
    }

    function renderListRow(list, currentKey) {
      const isArmed = armed === list.id
      const has = currentKey ? list.entries.some(e => e.key === currentKey) : false
      return '' +
        '<li class="tp-list' + (isArmed ? ' is-armed' : '') + '" data-tp-id="' + esc(list.id) + '">' +
          '<span class="tp-list-name">' + esc(list.name) + '</span>' +
          '<span class="tp-list-n">' + list.entries.length + '</span>' +
          (currentKey
            ? '<button type="button" class="tp-link" data-tp-action="' + (has ? 'list-remove' : 'list-add') + '"' +
              ' data-tp-key="' + esc(currentKey) + '">' + (has ? 'Remove from list' : 'Add to list') + '</button>'
            : '') +
          '<button type="button" class="tp-link" data-tp-action="list-rename-open">Rename</button>' +
          (isArmed
            ? '<button type="button" class="tp-link is-danger" data-tp-action="list-delete">Delete ' +
                esc(list.name) + ' for good</button>' +
              '<button type="button" class="tp-link" data-tp-action="cancel">Keep it</button>' +
              '<p class="tp-warn" role="alert">' + esc(list.name) + ' and its ' + list.entries.length +
                ' entries only exist here.</p>'
            : '<button type="button" class="tp-link" data-tp-action="list-delete">Delete</button>') +
        '</li>'
    }

    // One list, open: its entries in the order chosen, each with its own note.
    function renderList(id) {
      const list = store.getList(id)
      if (!list) return '<div class="tp-empty">That list is gone.</div>'
      return '' +
        '<section class="tp-list-open" data-tp-id="' + esc(list.id) + '">' +
          '<h3 class="tp-h">' + esc(list.name) + '</h3>' +
          (list.description ? '<p class="tp-sub">' + esc(list.description) + '</p>' : '') +
          '<form class="tp-form tp-inline" data-tp-form="list-rename" data-tp-id="' + esc(list.id) + '">' +
            '<label class="tp-field"><span>Name</span>' +
              '<input type="text" name="name" value="' + esc(list.name) + '" required></label>' +
            '<button type="submit" class="tp-btn" data-tp-action="list-rename">Rename</button>' +
          '</form>' +
          (list.entries.length
            ? '<ol class="tp-list-entries">' + list.entries.map((e, i) => '' +
                '<li class="tp-list-entry" data-tp-key="' + esc(e.key) + '">' +
                  '<span class="tp-fav-title">' + esc(label(e.key)) + '</span>' +
                  (e.note ? '<p class="tp-entry-note">' + esc(e.note) + '</p>' : '') +
                  '<button type="button" class="tp-icon" data-tp-action="list-move" data-tp-to="' + (i - 1) + '"' +
                    (i === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
                  '<button type="button" class="tp-icon" data-tp-action="list-move" data-tp-to="' + (i + 1) + '"' +
                    (i === list.entries.length - 1 ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
                  '<form class="tp-form tp-inline" data-tp-form="list-note" data-tp-id="' + esc(list.id) + '"' +
                    ' data-tp-key="' + esc(e.key) + '">' +
                    '<label class="tp-field"><span class="tp-sr">Note</span>' +
                      '<input type="text" name="note" value="' + esc(e.note) + '" placeholder="Why it is here"></label>' +
                    '<button type="submit" class="tp-btn" data-tp-action="list-note">Save</button>' +
                  '</form>' +
                  '<button type="button" class="tp-link" data-tp-action="list-remove">Remove</button>' +
                '</li>').join('') + '</ol>'
            : '<p class="tp-empty">Nothing in this list yet.</p>') +
        '</section>'
    }

    // ── taste profile ──────────────────────────────────────────────────────
    // The store hands back two numbers per name and both are printed. `count` is
    // how many of that director's films you have seen — breadth. `viewings` is
    // how many times you sat down to one — devotion. Printing only the first
    // makes three directors look identical when the second number says plainly
    // that one of them is the answer, and printing only the second lets one
    // rewatched film outrank a whole filmography.
    function renderTallies(title, rows, unit) {
      const noun = unit || 'films'
      if (!rows || !rows.length) return ''
      const max = rows.reduce((m, r) => Math.max(m, r.count), 0)
      return '' +
        '<section class="tp-tally"><h4 class="tp-h4">' + esc(title) + '</h4>' +
          '<ol class="tp-tally-rows">' + rows.map(r => '' +
            '<li class="tp-tally-row">' +
              '<span class="tp-tally-name">' + esc(r.name) + '</span>' +
              '<span class="tp-bar" aria-hidden="true"><i style="width:' + pct(r.count, max) + '%"></i></span>' +
              '<span class="tp-tally-n">' +
                '<b>' + esc(r.count) + '</b> ' + esc(r.count === 1 ? noun.replace(/s$/, '') : noun) +
                ' <span class="tp-dim">&middot; ' + esc(r.viewings) +
                (r.viewings === 1 ? ' viewing' : ' viewings') + '</span>' +
              '</span>' +
            '</li>').join('') +
          '</ol>' +
        '</section>'
    }

    function renderProfile(meta, profileOpts) {
      const p = store.profile(meta, profileOpts)
      const hours = Math.round(p.totalRuntime / 60 * 10) / 10
      return '' +
        '<div class="tp-profile">' +
          '<h3 class="tp-h">Your taste</h3>' +
          '<dl class="tp-stats">' +
            '<div><dt>Films</dt><dd>' + esc(p.titles) + '</dd></div>' +
            '<div><dt>Viewings</dt><dd>' + esc(p.viewings) + '</dd></div>' +
            '<div><dt>Hours</dt><dd>' + esc(hours) + '</dd></div>' +
            '<div><dt>Average rating</dt><dd>' +
              (p.averageRating === null ? '&mdash;' : esc(p.averageRating)) +
              '<span class="tp-dim"> over ' + esc(p.ratedTitles) + ' rated</span></dd></div>' +
          '</dl>' +
          renderTallies('Directors', p.topDirectors) +
          renderTallies('Decades', p.decades) +
          renderTallies('Countries', p.topCountries) +
          renderTallies('Languages', p.topLanguages) +
          (p.viewings ? '' : '<p class="tp-empty">Nothing logged yet. This fills in as you watch.</p>') +
        '</div>'
    }

    // ── year in review ─────────────────────────────────────────────────────
    function renderYearInReview(year, meta) {
      const y = store.yearInReview(year, meta)
      const monthMax = y.perMonth.reduce((m, n) => Math.max(m, n), 0)
      const dist = STARS.map(v => ({ value: v, n: Number(y.ratingDistribution[String(v)]) || 0 }))
      const distMax = dist.reduce((m, r) => Math.max(m, r.n), 0)
      return '' +
        '<div class="tp-year">' +
          '<h3 class="tp-h">' + esc(y.year) + ' in review</h3>' +
          '<dl class="tp-stats">' +
            '<div><dt>Films</dt><dd>' + esc(y.titles) + '</dd></div>' +
            '<div><dt>Viewings</dt><dd>' + esc(y.viewings) + '</dd></div>' +
            '<div><dt>Hours</dt><dd>' + esc(y.hours) + '</dd></div>' +
          '</dl>' +
          '<section class="tp-tally"><h4 class="tp-h4">Across the year</h4>' +
            '<ol class="tp-months">' + y.perMonth.map((n, i) => '' +
              '<li class="tp-month">' +
                '<span class="tp-col" aria-hidden="true"><i style="height:' + pct(n, monthMax) + '%"></i></span>' +
                '<span class="tp-month-n">' + esc(n) + '</span>' +
                '<span class="tp-month-l">' + MONTHS[i] + '</span>' +
              '</li>').join('') + '</ol>' +
          '</section>' +
          '<section class="tp-tally"><h4 class="tp-h4">How you rated them</h4>' +
            '<ol class="tp-tally-rows">' + dist.map(r => '' +
              '<li class="tp-tally-row">' +
                '<span class="tp-tally-name">' + esc(ratingWords(r.value)) + '</span>' +
                '<span class="tp-bar" aria-hidden="true"><i style="width:' + pct(r.n, distMax) + '%"></i></span>' +
                '<span class="tp-tally-n">' + esc(r.n) + '</span>' +
              '</li>').join('') + '</ol>' +
          '</section>' +
          renderTallies('Directors of the year', y.topDirectors) +
          (y.viewings ? '' : '<p class="tp-empty">Nothing logged in ' + esc(y.year) + '.</p>') +
        '</div>'
    }

    // ── behaviour ──────────────────────────────────────────────────────────
    // Every mutation in the panel funnels through here. The DOM listener below
    // does nothing but read attributes and call this, so the panel's behaviour
    // can be exercised, and this file's real risks tested, without a document.
    //
    // Returns { status, … }. 'ok' changed something, 'confirm' armed a
    // destructive action and changed nothing, 'full' means the four favourites
    // are taken, 'noop' means the store refused the input.
    function dispatch(action, data) {
      const d = data || {}
      // Any action other than the second half of a confirmation disarms. An arm
      // is a held breath, not a setting.
      const wasArmed = armed
      if (action !== 'diary-delete' && action !== 'list-delete') armed = null

      switch (action) {
        case 'rate': {
          const r = store.rate(d.key, d.value)
          return done(action, r ? 'ok' : 'noop', { key: d.key, rating: r ? r.value : store.ratingOf(d.key) })
        }
        case 'rate-clear': {
          const gone = store.unrate(d.key)
          return done(action, gone ? 'ok' : 'noop', { key: d.key, rating: null })
        }
        // Adjusting by keyboard: the arrows walk the half stars, and they clamp
        // at 0.5 rather than falling off into "unrated", because leaving the
        // rating is a separate decision with a separate key.
        case 'rate-nudge': {
          const cur = store.ratingOf(d.key)
          const step = Number(d.step) || 0
          const next = Math.max(0.5, Math.min(5, (cur === null ? (step > 0 ? 0 : 5.5) : cur) + step))
          const r = store.rate(d.key, next)
          return done(action, r ? 'ok' : 'noop', { key: d.key, rating: r ? r.value : cur })
        }
        case 'seen': {
          // rewatch is left to the store, which knows the log and cannot
          // disagree with itself the way a checkbox in the UI can.
          const entry = store.logViewing(d.key, { date: d.date, note: d.note })
          return done(action, entry ? 'ok' : 'noop', { key: d.key, entry })
        }
        case 'diary-add': {
          const entry = store.logViewing(d.key, {
            date: d.date,
            rewatch: typeof d.rewatch === 'boolean' ? d.rewatch : undefined,
            note: d.note ? String(d.note) : null,
          })
          return done(action, entry ? 'ok' : 'noop', { key: d.key, entry })
        }
        case 'diary-note': {
          const entry = store.setNote(d.id, d.note === null || d.note === undefined ? null : String(d.note))
          return done(action, entry ? 'ok' : 'noop', { entry })
        }
        case 'diary-delete': {
          if (wasArmed !== d.id) { armed = d.id; return { status: 'confirm', id: d.id } }
          armed = null
          const gone = store.removeViewing(d.id)
          return done(action, gone ? 'ok' : 'noop', { entry: gone })
        }
        case 'fav-add': {
          const next = store.addFavourite(d.key)
          if (next) { replacing = null; return done(action, 'ok', { favourites: next }) }
          // Refused: either the shelf is full, in which case the panel asks
          // which of the four is leaving, or the key was junk.
          if (store.favourites().length >= MAX_FAVOURITES) {
            replacing = d.key
            return { status: 'full', key: d.key, favourites: store.favourites() }
          }
          return done(action, 'noop', { favourites: store.favourites() })
        }
        case 'fav-replace': {
          const keys = store.favourites()
          const at = keys.indexOf(d.replace)
          if (at < 0 || !d.key || keys.indexOf(d.key) >= 0) return done(action, 'noop', { favourites: keys })
          keys.splice(at, 1, d.key)   // the newcomer inherits the place, not the end
          const next = store.setFavourites(keys)
          replacing = null
          return done(action, next ? 'ok' : 'noop', { favourites: store.favourites() })
        }
        case 'fav-remove': {
          replacing = null
          return done(action, 'ok', { favourites: store.removeFavourite(d.key) })
        }
        case 'fav-move': {
          const keys = store.favourites()
          const from = keys.indexOf(d.key)
          const to = Math.max(0, Math.min(keys.length - 1, Number(d.to)))
          if (from < 0 || !Number.isFinite(to) || from === to) return done(action, 'noop', { favourites: keys })
          keys.splice(to, 0, keys.splice(from, 1)[0])
          const next = store.setFavourites(keys)
          return done(action, next ? 'ok' : 'noop', { favourites: store.favourites() })
        }
        case 'list-create': {
          const list = store.createList(d.name)
          return done(action, list ? 'ok' : 'noop', { list })
        }
        case 'list-rename': {
          const list = store.renameList(d.id, d.name)
          return done(action, list ? 'ok' : 'noop', { list })
        }
        case 'list-delete': {
          if (wasArmed !== d.id) { armed = d.id; return { status: 'confirm', id: d.id } }
          armed = null
          const list = store.getList(d.id)
          // The store wants the name back as its own guard; the panel has it
          // and never asks the person to retype it.
          const gone = list ? store.deleteList(d.id, list.name) : null
          return done(action, gone ? 'ok' : 'noop', { list: gone })
        }
        case 'list-add': {
          const list = store.addToList(d.id, d.key, d.note)
          return done(action, list ? 'ok' : 'noop', { list })
        }
        case 'list-remove': {
          const list = store.removeFromList(d.id, d.key)
          return done(action, list ? 'ok' : 'noop', { list })
        }
        case 'list-note': {
          const list = store.annotateListEntry(d.id, d.key, d.note === undefined ? null : d.note)
          return done(action, list ? 'ok' : 'noop', { list })
        }
        case 'list-move': {
          const list = store.moveInList(d.id, d.key, d.to)
          return done(action, list ? 'ok' : 'noop', { list })
        }
        case 'cancel': {
          replacing = null
          return { status: 'cancelled' }
        }
        default:
          return { status: 'unknown', action }
      }
    }

    function done(action, status, extra) {
      const result = Object.assign({ status, action }, extra || {})
      if (status === 'ok') {
        try { onChange(action, result) } catch (_) { /* a bad host callback must not undo a saved entry */ }
      }
      return result
    }

    // ── DOM binding ────────────────────────────────────────────────────────
    function attr(el, name) {
      // Walks up for the context attributes (the list id on a section, the key
      // on a row) so each button only carries what is its own.
      let node = el
      while (node && node.getAttribute) {
        const v = node.getAttribute(name)
        if (v !== null && v !== undefined) return v
        node = node.parentElement
      }
      return null
    }

    function closestAction(el) {
      let node = el
      while (node && node.getAttribute) {
        const a = node.getAttribute('data-tp-action')
        if (a) return { node, action: a }
        node = node.parentElement
      }
      return null
    }

    function fieldValue(form, name) {
      const el = form.querySelector && form.querySelector('[name="' + name + '"]')
      if (!el) return null
      return el.type === 'checkbox' ? !!el.checked : el.value
    }

    function contextOf(node) {
      return { key: attr(node, 'data-tp-key'), id: attr(node, 'data-tp-id') }
    }

    // `root` is whatever element the renderer mounted the markup into. One
    // delegated listener per event, so re-rendering the innerHTML never leaks
    // handlers — the panels are rebuilt wholesale on every change.
    function mount(root) {
      if (!root || !root.addEventListener) return function () {}

      function onClick(ev) {
        const hit = closestAction(ev.target)
        if (!hit || hit.node.tagName === 'BUTTON' && hit.node.type === 'submit') return
        const ctx = contextOf(hit.node)
        const value = hit.node.getAttribute('data-tp-value')
        const to = hit.node.getAttribute('data-tp-to')
        const replace = hit.node.getAttribute('data-tp-replace')
        if (ev.preventDefault) ev.preventDefault()
        dispatch(hit.action, {
          key: ctx.key, id: ctx.id,
          value: value === null ? undefined : Number(value),
          to: to === null ? undefined : Number(to),
          replace: replace === null ? undefined : replace,
        })
      }

      function onSubmit(ev) {
        const form = ev.target
        const kind = form && form.getAttribute && form.getAttribute('data-tp-form')
        if (!kind) return
        if (ev.preventDefault) ev.preventDefault()
        const ctx = contextOf(form)
        if (kind === 'diary') {
          dispatch('diary-add', {
            key: ctx.key,
            date: fieldValue(form, 'date'),
            rewatch: fieldValue(form, 'rewatch'),
            note: fieldValue(form, 'note'),
          })
        } else if (kind === 'note') {
          dispatch('diary-note', { id: ctx.id, note: fieldValue(form, 'note') })
        } else if (kind === 'list-create') {
          dispatch('list-create', { name: fieldValue(form, 'name') })
        } else if (kind === 'list-rename') {
          dispatch('list-rename', { id: ctx.id, name: fieldValue(form, 'name') })
        } else if (kind === 'list-note') {
          dispatch('list-note', { id: ctx.id, key: ctx.key, note: fieldValue(form, 'note') })
        }
      }

      // The rating slider's keyboard contract, and the reason it is a slider:
      // arrows walk half stars, Home/End jump to the ends, and Delete or
      // Backspace — never a value key — removes the rating entirely.
      function onKeyDown(ev) {
        const node = ev.target
        if (!node || !node.getAttribute || node.getAttribute('data-tp-role') !== 'rating') return
        const key = attr(node, 'data-tp-key')
        let handled = true
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') dispatch('rate-nudge', { key, step: 0.5 })
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') dispatch('rate-nudge', { key, step: -0.5 })
        else if (ev.key === 'Home') dispatch('rate', { key, value: 0.5 })
        else if (ev.key === 'End') dispatch('rate', { key, value: 5 })
        else if (ev.key === 'Delete' || ev.key === 'Backspace') dispatch('rate-clear', { key })
        else handled = false
        if (handled && ev.preventDefault) ev.preventDefault()
      }

      root.addEventListener('click', onClick)
      root.addEventListener('submit', onSubmit)
      root.addEventListener('keydown', onKeyDown)
      return function unmount() {
        if (!root.removeEventListener) return
        root.removeEventListener('click', onClick)
        root.removeEventListener('submit', onSubmit)
        root.removeEventListener('keydown', onKeyDown)
      }
    }

    return {
      esc,
      renderRating, renderSeen, renderDiaryForm, renderDiary, renderNoteEditor,
      renderFavourites, renderLists, renderList,
      renderProfile, renderYearInReview,
      dispatch, mount,
      isArmed: () => armed,
      isReplacing: () => replacing,
      _doc: () => doc,
    }
  }

  return { createTastePanel, esc, MAX_FAVOURITES }
})
