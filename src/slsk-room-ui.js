// The Listening Room: one page for a peer's library with three modes (Hunt,
// Wander, Folders) and one album dossier. Same show(username, deps) contract
// as slsk-shop-ui.js so renderer.js only swaps which module it calls.
;(function () {
  const W = () => (typeof window !== 'undefined' && window.PapaSlskWander) || null
  const H = () => (typeof window !== 'undefined' && window.PapaSlskHunt) || null
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) || null
  const T = () => (typeof window !== 'undefined' && window.PapaSlskTree) || null
  const SF = () => (typeof window !== 'undefined' && window.PapaSlskFilters) || null
  const CO = () => (typeof window !== 'undefined' && window.PapaSlskColumns) || null

  // Same deterministic hash-to-hue recipe as slsk-dossier.js's paintCover,
  // so a cover never renders as a flat dark square before art arrives.
  function coverGradient(title) {
    const hue = Math.abs([...String(title || '')].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
    return `linear-gradient(135deg,hsl(${hue},45%,20%),hsl(${(hue + 40) % 360},35%,12%))`
  }

  function modeKey(username) { return 'slsk_lib_mode:' + String(username || '').toLowerCase() }
  function sortKey(username) { return 'slsk_hunt_sort:' + String(username || '').toLowerCase() }
  function audioKey(username) { return 'slsk_folders_audio:' + String(username || '').toLowerCase() }

  // localStorage is user-editable and outlives any rename of these comparators,
  // so a stored sort is only honoured when it names one sortRows actually has.
  // Anything else falls back to the default instead of sorting by nothing.
  const SORT_KEYS = ['verdict', 'title', 'artist', 'year', 'size', 'theirs']
  const SORT_DIRS = ['asc', 'desc']

  // The header ring: four quality slices that always add up to exactly 100, so
  // the conic-gradient closes. Rounding drift is absorbed by the lossy slice.
  function headerModel(stats, line, status) {
    const st = stats || { albums: 0, hiRes: 0, surround: 0, losslessPct: 0, tracks: 0, size: 0 }
    const n = Math.max(1, st.albums || 0)
    const hires = Math.round((st.hiRes || 0) / n * 100)
    const surround = Math.round((st.surround || 0) / n * 100)
    const lossless = Math.max(0, (st.losslessPct || 0) - hires - surround)
    const lossy = Math.max(0, 100 - hires - surround - lossless)
    const ring = [
      { tier: 'hires', pct: hires },
      { tier: 'surround', pct: surround },
      { tier: 'lossless', pct: lossless },
      { tier: 'lossy', pct: lossy },
    ]
    ring[3].pct += 100 - ring.reduce((s, x) => s + x.pct, 0)
    const bits = []
    if (status && status.online) bits.push('online now')
    else if (status) bits.push('offline')
    if (status && status.queue != null) bits.push(status.queue + ' in their queue')
    return { ring, line: line || '', status: bits.join(' · '), losslessPct: st.losslessPct || 0, stats: st }
  }

  // characterLine() has no genre to work with on some shares and falls back to
  // a bare album count ("5276 albums"). The header then adds its own, properly
  // grouped, count — which is how "5276 albums · 5,276 albums" reached the
  // screen. The two lines say the same thing, so when the character line IS
  // that fallback it is dropped and only the header's count survives.
  function isCountFallback(line) {
    return /^\s*[\d.,  ]+\s+albums?\s*$/i.test(String(line || ''))
  }

  // The hero is two lines, not one: the character in full ink, the counting in
  // the muted line under it.
  function headLines(hm) {
    const raw = (hm && hm.line) || ''
    const character = isCountFallback(raw) ? '' : raw
    const albums = ((hm && hm.stats && hm.stats.albums) || 0).toLocaleString()
    const counts = [albums + ' albums', hm && hm.status].filter(Boolean).join(' · ')
    return { character, counts }
  }

  // Wander's shelf order is editorial, not data-driven: people first, then
  // what's new, then the connections, then the format rooms. Empty drops out.
  function wanderShelves(parts) {
    const out = []
    for (const e of parts.goDeep || []) {
      if (!e.albums || !e.albums.length) continue
      out.push({ id: 'deep:' + e.artist, title: e.artist, sub: e.count + ' albums · ' + e.lacking + ' you lack', albums: e.albums })
      if (out.length >= 3) break
    }
    if ((parts.fresh || []).length) out.push({ id: 'fresh', title: 'Fresh arrivals', sub: parts.fresh.length + ' added since you were last here', albums: parts.fresh })
    for (const b of parts.because || []) out.push({ id: 'because:' + b.seed.album, title: 'Because you own ' + b.seed.album, sub: 'same scene as ' + b.seed.artist, albums: b.albums })
    if (parts.onlyHere && parts.onlyHere.albums.length) out.push({ id: 'only', title: 'Only here', sub: 'in none of the ' + parts.onlyHere.peersChecked + ' other peers you\'ve browsed', albums: parts.onlyHere.albums })
    if (parts.decade && parts.decade.albums.length) out.push({ id: 'decade', title: 'The ' + String(parts.decade.decade).slice(2) + 's, a decade they love', sub: parts.decade.share + '% of their dated albums', albums: parts.decade.albums })
    if ((parts.surround || []).length) out.push({ id: 'surround', title: 'Their surround room', sub: parts.surround.length + ' multichannel', albums: parts.surround })
    if ((parts.hires || []).length) out.push({ id: 'hires', title: 'Hi-res', sub: parts.hires.length + ' at 24-bit or 88.2 kHz+', albums: parts.hires })
    return out
  }

  async function show(username, deps) {
    const esc = deps.esc, state = deps.state, host = deps.host
    let mode = 'hunt'
    try { mode = localStorage.getItem(modeKey(username)) || localStorage.getItem('slsk_lib_mode') || 'hunt'; if (mode === 'shelves') mode = 'hunt' } catch (_) {}
    if (!['hunt', 'wander', 'folders'].includes(mode)) mode = 'hunt'

    host.innerHTML = `<div class="slsk-room" id="slsk-room">
      <div class="slr-head" id="slr-head"><div class="slr-skel"></div></div>
      <div class="slr-body" id="slr-body"><div class="slr-loading">Reading ${esc(username)}'s library…</div></div>
    </div>`
    const root = host.querySelector('#slsk-room'), headEl = host.querySelector('#slr-head'), bodyEl = host.querySelector('#slr-body')
    let tree = null, albums = [], shelves = null, fresh = [], columns = null, dead = false
    let searchEl = null
    const hunt = { sort: 'verdict', dir: 'asc', filter: null, query: '' }
    // Mirrors slsk-columns' own defaults — audio-only ON, surround-only off.
    const folders = { audioOnly: true, surroundOnly: false }
    try { const v = localStorage.getItem(audioKey(username)); if (v != null) folders.audioOnly = v === '1' } catch (_) {}
    let lastStatus = null
    const albumsByPath = new Map()
    // Identity set, so a card can ask "is this one of the ones I lack?" in O(1)
    // instead of an includes() scan per card.
    let missingSet = new Set()

    // The binding rule for this header: it is built EXACTLY ONCE, by the first
    // paintHead, and never re-serialised. #slr-search is a live input, and
    // re-serialising headEl after first paint blows away its focus, its caret
    // and the debounce timer mid-keystroke, which is precisely the trap
    // slsk-shop-ui.js documents around its hero rule. Everything that can
    // change later (the ring, the one-line summary) carries an id and is
    // updated in place by updateHead(); the input and the mode buttons are
    // never touched again.
    let headPainted = false

    function ringGradient(hm) {
      return 'conic-gradient(' + hm.ring.reduce((acc, x) => { const from = acc.at; acc.at += x.pct; acc.s.push(`var(--slr-${x.tier}) ${from}% ${acc.at}%`); return acc }, { at: 0, s: [] }).s.join(',') + ')'
    }


    // Update only the mutable text nodes and styles. Safe to call at any time,
    // including from the background-refresh handler while the user is typing.
    function updateHead(hm) {
      if (!headPainted) { paintHead(hm); return }
      const ring = headEl.querySelector('#slr-ring')
      if (ring) {
        ring.style.background = ringGradient(hm)
        ring.title = hm.ring.map(x => x.tier + ' ' + x.pct + '%').join(', ')
        const b = ring.querySelector('b')
        if (b) b.textContent = hm.losslessPct + '%'
      }
      const hl = headLines(hm)
      const ch = headEl.querySelector('#slr-char')
      if (ch) ch.textContent = hl.character
      const line = headEl.querySelector('#slr-headline')
      if (line) line.textContent = hl.counts
    }

    function paintHead(hm) {
      const grad = ringGradient(hm)
      headEl.innerHTML = `
        <div class="slr-ring" id="slr-ring" style="background:${grad}" title="${esc(hm.ring.map(x => x.tier + ' ' + x.pct + '%').join(', '))}"><b>${hm.losslessPct}%</b></div>
        <div class="slr-head-text">
          <h1 class="slr-name">${esc(username)}</h1>
          <div class="slr-char" id="slr-char">${esc(headLines(hm).character)}</div>
          <div class="slr-muted"><span id="slr-headline">${esc(headLines(hm).counts)}</span><span id="slr-cache" class="slr-cache"></span></div>
          <div class="slr-modes" role="tablist">${['hunt', 'wander', 'folders'].map(m => `<button role="tab" class="slr-mode${m === mode ? ' is-on' : ''}" data-mode="${m}" aria-selected="${m === mode}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
        </div>
        <div class="slr-head-tools"><span class="slr-folder-filters" id="slr-folder-filters"${mode === 'folders' ? '' : ' hidden'}>
            <label class="slr-toggle"><input type="checkbox" id="slr-f-audio"${folders.audioOnly ? ' checked' : ''}> Audio only</label>
            <label class="slr-toggle"><input type="checkbox" id="slr-f-surround"${folders.surroundOnly ? ' checked' : ''}> Surround only</label>
          </span><input class="slr-search" id="slr-search" placeholder="Search ${esc(username)}'s library…" autocomplete="off"><button class="slr-btn slr-btn-quiet" id="slr-close" aria-label="Back">←</button></div>`
      headPainted = true
      headEl.querySelector('#slr-close').addEventListener('click', () => deps.onClose && deps.onClose())
      headEl.querySelectorAll('.slr-mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)))
      searchEl = headEl.querySelector('#slr-search')
      let t = null
      searchEl.addEventListener('input', () => {
        clearTimeout(t)
        t = setTimeout(() => {
          hunt.query = searchEl.value
          if (mode === 'folders' && columns) columns.search(searchEl.value)
          else paintBody()
        }, 160)
      })
      const audioBox = headEl.querySelector('#slr-f-audio')
      const surroundBox = headEl.querySelector('#slr-f-surround')
      audioBox.addEventListener('change', () => {
        folders.audioOnly = audioBox.checked
        try { localStorage.setItem(audioKey(username), folders.audioOnly ? '1' : '0') } catch (_) {}
        applyFolderFilters()
      })
      surroundBox.addEventListener('change', () => {
        folders.surroundOnly = surroundBox.checked
        applyFolderFilters()
      })
    }

    function applyFolderFilters() {
      if (columns) columns.setFilters({ audioOnly: folders.audioOnly, surroundOnly: folders.surroundOnly })
    }

    // The columns module drops its own query when a search hit is clicked, but
    // it cannot reach the page's search box. Nothing in its mount() return
    // reports that navigation, so the shell clears the box on any click inside
    // the columns area while a search is showing — the only way to move in that
    // area IS to navigate, so the box and the view stay honest.
    function clearSearchBox() {
      if (!searchEl || !searchEl.value) return
      searchEl.value = ''
      hunt.query = ''
    }

    function setMode(m) {
      if (m === mode) return
      mode = m
      try { localStorage.setItem(modeKey(username), m) } catch (_) {}
      headEl.querySelectorAll('.slr-mode').forEach(b => { b.classList.toggle('is-on', b.dataset.mode === m); b.setAttribute('aria-selected', String(b.dataset.mode === m)) })
      const ff = headEl.querySelector('#slr-folder-filters')
      if (ff) ff.hidden = m !== 'folders'
      paintBody()
    }

    function openDossier(album, opts) {
      const D = typeof window !== 'undefined' ? window.PapaSlskDossier : null
      const Wm = W()
      if (!D) return
      const sibs = Wm ? albums.filter(a => a !== album && a.artist && album.artist && Wm.norm(a.artist) === Wm.norm(album.artist)) : []
      // The whole library, the live tag map, and the two facts only this
      // closure knows — passed unconditionally. `albums` and `wander.tags` go
      // by REFERENCE so a background sweep that lands while the panel is open
      // shows up on its next repaint; tagsDone is a getter for the same reason.
      // The columns surface is mounted BY this room and handed this same
      // openDossier, so the Folders view gets all of it too.
      D.open({
        album, username, host: root, siblings: sibs,
        deps: {
          ...deps,
          openDossier,
          peerAlbums: albums,
          tagsByArtist: wander.tags,
          tagsDone: () => wander.tagsDone,
          ownsPeerAlbum: a => !missingSet.has(a),
        },
        autoVerify: !!(opts && opts.autoVerify),
      })
    }

    function cardHtml(a) {
      const tier = H().tierOf(a)
      const hint = a.upgrade ? 'upgrade' : (missingSet.has(a) ? 'not yours' : 'you have it')
      return `<button class="slr-card" data-path="${esc(a.folderPath)}"><span class="slr-card-cover" data-art="${esc(a.artist)}|${esc(a.album)}" style="background-image:${coverGradient(a.album || a.folderName)}"><i class="slr-lbl slr-lbl-${tier}"></i></span>
        <span class="slr-card-t">${esc(a.album || a.folderName)}</span><span class="slr-card-a">${esc([a.artist, a.year].filter(Boolean).join(' · '))}</span><span class="slr-card-hint slr-hint-${hint.replace(/\s/g, '-')}">${esc(hint)}${a.isHiRes ? ' · ' + esc(a.maxBitDepth) + '/' + Math.round(Number(a.maxSampleRate) / 1000) : ''}</span></button>`
    }

    function paintHunt() {
      const Hm = H()
      const tiles = Hm.tiles(shelves, fresh.length)
      let rows = Hm.buildRows(shelves, state.library)
      if (hunt.filter === 'upgrades') rows = rows.filter(r => r.verdictKind === 'upgrade' || r.verdictKind === 'surround')
      else if (hunt.filter === 'missing') rows = rows.filter(r => r.verdictKind === 'missing')
      else if (hunt.filter === 'surround') rows = rows.filter(r => r.album.surround)
      else if (hunt.filter === 'new') { const fp = new Set(fresh.map(a => a.folderPath)); rows = rows.filter(r => fp.has(r.album.folderPath)) }
      rows = Hm.sortRows(Hm.filterRows(rows, hunt.query), hunt.sort, hunt.dir)
      const upgrades = shelves.upgrades.length
      // "Yours" has no comparator in sortRows, so it is deliberately not a
      // sortable header — a click that does nothing reads as a bug.
      const head = ['', 'title:Album', 'theirs:Theirs', ':Yours', 'verdict:Verdict', 'size:Size'].map(h => {
        const [k, l] = h.split(':')
        return `<th${k ? ` data-sort="${k}" class="${hunt.sort === k ? 'is-sorted-' + hunt.dir : ''}"` : ''}>${l || ''}</th>`
      }).join('')
      const WINDOW = 300
      const rowHtml = r => `<tr class="slr-tr slr-tr-${r.verdictKind}" data-path="${esc(r.album.folderPath)}"><td><input type="checkbox" class="slr-pick" data-path="${esc(r.album.folderPath)}" aria-label="Select"></td>
        <td class="slr-td-title"><span class="slr-mini-cover" data-art="${esc(r.artist)}|${esc(r.title)}" style="background-image:${coverGradient(r.title)}"></span><b>${esc(r.title)}</b><small>${esc([r.artist, r.year].filter(Boolean).join(' · '))}</small></td>
        <td class="slr-mono"><i class="slr-lbl slr-lbl-${r.tier}"></i>${esc(r.theirs)}</td><td class="slr-mono">${esc(r.yours)}</td><td class="slr-verdict slr-v-${r.verdictKind}">${esc(r.verdictText)}</td><td class="slr-mono">${esc(SH().fmtSize(r.size))}</td></tr>`
      bodyEl.innerHTML = `
        <div class="slr-tiles">${tiles.map(t => `<button class="slr-tile${hunt.filter === t.id ? ' is-on' : ''}${t.id === 'upgrades' && t.n ? ' is-hot' : ''}" data-tile="${t.id}"><b>${t.n.toLocaleString()}</b><span>${esc(t.label)}</span></button>`).join('')}</div>
        <div class="slr-ledger-tools"><span class="slr-muted" id="slr-count">${rows.length.toLocaleString()} album${rows.length === 1 ? '' : 's'}</span><span class="slr-grow"></span>
          <button class="slr-btn" id="slr-dl-picked" disabled>Download selected</button>${upgrades ? `<button class="slr-btn slr-btn-pri" id="slr-grab-all">Grab all ${upgrades} upgrade${upgrades === 1 ? '' : 's'}</button>` : ''}</div>
        <div class="slr-ledger-wrap"><table class="slr-ledger"><thead><tr>${head}</tr></thead><tbody id="slr-tbody">${rows.slice(0, WINDOW).map(rowHtml).join('')}</tbody></table>
        ${rows.length > WINDOW ? `<button class="slr-btn slr-more" id="slr-more">Show ${Math.min(WINDOW, rows.length - WINDOW)} more</button>` : ''}</div>`
      let shown = WINDOW
      const more = bodyEl.querySelector('#slr-more')
      if (more) more.addEventListener('click', () => {
        bodyEl.querySelector('#slr-tbody').insertAdjacentHTML('beforeend', rows.slice(shown, shown + WINDOW).map(rowHtml).join(''))
        shown += WINDOW
        if (shown >= rows.length) more.remove()
        else more.textContent = 'Show ' + Math.min(WINDOW, rows.length - shown) + ' more'
        armArt()
      })
      bodyEl.querySelectorAll('[data-tile]').forEach(b => b.addEventListener('click', () => { hunt.filter = hunt.filter === b.dataset.tile ? null : b.dataset.tile; paintHunt() }))
      bodyEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const k = th.dataset.sort
        hunt.dir = hunt.sort === k && hunt.dir === 'asc' ? 'desc' : 'asc'
        hunt.sort = k
        try { localStorage.setItem(sortKey(username), hunt.sort + ':' + hunt.dir) } catch (_) {}
        paintHunt()
      }))
      bodyEl.querySelector('#slr-tbody').addEventListener('click', e => {
        if (e.target.closest('.slr-pick')) { updatePicked(); return }
        const tr = e.target.closest('tr[data-path]')
        if (tr) { const a = albumsByPath.get(tr.dataset.path.toLowerCase()); if (a) openDossier(a) }
      })
      function updatePicked() {
        const n = bodyEl.querySelectorAll('.slr-pick:checked').length
        const b = bodyEl.querySelector('#slr-dl-picked')
        b.disabled = !n
        b.textContent = n ? 'Download ' + n + ' selected' : 'Download selected'
      }
      bodyEl.querySelector('#slr-dl-picked').addEventListener('click', async () => {
        const picked = [...bodyEl.querySelectorAll('.slr-pick:checked')].map(cb => albumsByPath.get(cb.dataset.path.toLowerCase())).filter(Boolean)
        const items = picked.flatMap(a => (a.files || []).filter(f => T().AUDIO_RE.test(f.name)).map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
        const r = await deps._slskEnqueue(items)
        deps.showSnackbar(r && r.ok ? 'Downloading ' + picked.length + ' albums' : 'Could not start the download')
        if (r && r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan()
      })
      const grab = bodyEl.querySelector('#slr-grab-all')
      if (grab) grab.addEventListener('click', () => {
        const go = async () => {
          const items = shelves.upgrades.flatMap(a => (a.files || []).filter(f => T().AUDIO_RE.test(f.name)).map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
          const r = await deps._slskEnqueue(items)
          deps.showSnackbar(r && r.ok ? 'Downloading ' + shelves.upgrades.length + ' upgrades' : 'Could not start the download')
          if (r && r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan()
        }
        if (deps._mgConfirm) {
          deps._mgConfirm({
            title: 'Download all ' + shelves.upgrades.length + ' upgrades?',
            body: shelves.upgrades.slice(0, 12).map(a => a.artist + ' – ' + a.album).join('\n') + (shelves.upgrades.length > 12 ? '\n…' : ''),
            ok: 'Download',
          }).then(y => y && go())
        } else go()
      })
      armArt()
    }

    const wander = { tags: {}, tagsDone: false, seeds: [], otherPeers: [] }
    function paintWander() {
      const Wm = W()
      const owns = a => !missingSet.has(a)
      const parts = {
        goDeep: Wm.goDeep(albums, owns), fresh,
        because: Wm.becauseYouOwn(albums, wander.seeds || [], wander.tags),
        onlyHere: Wm.onlyHere(albums, wander.otherPeers || []),
        decade: Wm.decadeShelf(albums), surround: shelves.surround, hires: shelves.hires,
      }
      const list = wanderShelves(parts)
      const q = hunt.query.trim().toLowerCase()
      const filt = l => q ? l.filter(a => ((a.album || '') + ' ' + (a.artist || '')).toLowerCase().includes(q)) : l
      bodyEl.innerHTML = list.map(s => {
        const al = filt(s.albums)
        return al.length ? `<section class="slr-shelf" data-shelf="${esc(s.id)}"><div class="slr-shelf-h"><b>${esc(s.title)}</b><small>${esc(s.sub)}</small></div><div class="slr-strip">${al.slice(0, 40).map(cardHtml).join('')}${al.length > 40 ? `<button class="slr-card slr-card-more" data-seeall="${esc(s.id)}">+${al.length - 40} more</button>` : ''}</div></section>` : ''
      }).join('') +
        (list.length ? '' : '<div class="slr-muted slr-empty">Nothing to wander through yet.</div>') +
        '<div class="slr-story" id="slr-story"></div>' +
        (wander.tagsDone ? '' : `<div class="slr-muted slr-note">Working out what else you'd like… (${Object.keys(wander.tags).length} artists checked)</div>`)
      bodyEl.querySelectorAll('.slr-card[data-path]').forEach(c => c.addEventListener('click', () => { const a = albumsByPath.get(c.dataset.path.toLowerCase()); if (a) openDossier(a) }))
      bodyEl.querySelectorAll('[data-seeall]').forEach(b => b.addEventListener('click', () => {
        hunt.filter = null
        hunt.query = ''
        if (searchEl) searchEl.value = ''
        setMode('hunt')
      }))
      const top = parts.goDeep[0]
      if (top && window.api && window.api.artistInfo) {
        window.api.artistInfo({ artist: top.artist }).then(r => {
          const el = bodyEl.querySelector('#slr-story')
          // One line on a shelf header, with no expander behind it: one whole
          // sentence, and no ellipsis. The old hard slice(0,300) cut mid-word
          // and then promised more text there was no way to reach.
          const D = (typeof window !== 'undefined' && window.PapaSlskDossier) || null
          const line = D && D.firstSentence
            ? D.firstSentence(String(r && r.bio || ''), 300)
            : String(r && r.bio || '').slice(0, 300)
          if (el && line) el.innerHTML = `<b>${esc(top.artist)}</b> — ${esc(line)} This peer holds ${top.count} of their albums.`
        }).catch(() => {})
      }
      armArt()
    }

    // Lazy cover art for any [data-art="artist|album"] in view, via the existing handler.
    let artObs = null
    function armArt() {
      if (artObs) artObs.disconnect()
      artObs = new IntersectionObserver(entries => {
        for (const en of entries) if (en.isIntersecting) { artObs.unobserve(en.target); fetchArt(en.target) }
      }, { root: bodyEl, rootMargin: '200px' })
      bodyEl.querySelectorAll('[data-art]').forEach(el => artObs.observe(el))
    }
    function fetchArt(el) {
      const [artist, album] = String(el.dataset.art).split('|')
      const lib = (state.library || []).find(l => l.artPath && SH().tokenScore(album, l.name) >= 0.6 && (!artist || !l.artist || SH().tokenScore(artist, l.artist) >= 0.34))
      // Layer the art OVER the gradient rather than replacing it: an art path
      // that 404s or was deleted used to leave a blank tile, because the
      // gradient it overwrote was the only thing under it.
      const grad = el.dataset.grad || coverGradient(album)
      const put = p => { if (p && el.isConnected) el.style.backgroundImage = `url("${/^https?:/.test(p) ? p : 'file://' + p}"), ${grad}` }
      if (lib) return put(lib.artPath)
      if (window.api && window.api.fetchAlbumArt && artist) {
        window.api.fetchAlbumArt({ albumId: 'slsk-' + (artist + '-' + album).replace(/[^a-z0-9]+/gi, '-').toLowerCase(), artist, album }).then(put).catch(() => {})
      }
    }

    // Any click inside the columns navigates, and navigating drops the module's
    // surround-only list — so the toggle must follow it back down.
    function onFoldersClick() {
      clearSearchBox()
      if (!folders.surroundOnly) return
      folders.surroundOnly = false
      const box = headEl.querySelector('#slr-f-surround')
      if (box) box.checked = false
    }

    function paintFolders() {
      bodyEl.innerHTML = ''
      const C = CO()
      if (!C || typeof C.mount !== 'function') {
        bodyEl.innerHTML = `<div class="slr-empty">The folder browser did not load. Try Hunt or Wander instead.</div>`
        return
      }
      columns = C.mount({ host: bodyEl, tree, username, deps, albumsByPath, openDossier })
      applyFolderFilters()
      if (hunt.query) columns.search(hunt.query)
      bodyEl.addEventListener('click', onFoldersClick)
    }

    function paintBody() {
      if (columns) { bodyEl.removeEventListener('click', onFoldersClick); columns.destroy(); columns = null }
      if (!shelves) { bodyEl.innerHTML = `<div class="slr-loading">Reading ${esc(username)}'s library…</div>`; return }
      if (mode === 'hunt') paintHunt()
      else if (mode === 'wander') paintWander()
      else paintFolders()
    }

    // ── Load ─────────────────────────────────────────────────────────────────
    // The whole library in one IPC reply was measured at ~1.8 s of frozen
    // window on a large share, none of it interruptible. So when the engine
    // has the sliced handlers, pull it Begin/Chunk/End and build the tree
    // cooperatively, with the loading line doubling as the progress readout.
    // Without them, the single-shot call behaves exactly as it always did.
    let browseFp = null, fromCache = false, cachedAt = 0, newDirs = []

    function noteNewDirs(reply) {
      if (reply && Array.isArray(reply.newDirs) && reply.newDirs.length) newDirs = reply.newDirs
    }
    function loadingLine(pct) {
      const el = bodyEl.querySelector('.slr-loading')
      if (!el || !el.isConnected) return
      el.textContent = `Reading ${username}'s library… ${Math.max(0, Math.min(100, Math.round(pct)))}%`
    }
    function paintCacheLine(text) {
      const el = headEl.querySelector('#slr-cache')
      if (el) el.textContent = text
    }
    function cacheText() {
      if (!fromCache) return ''
      return ' · from cache' + (cachedAt ? ', ' + Math.round((Date.now() - cachedAt) / 60000) + ' min old' : '')
    }

    async function pullBrowse() {
      const SHm = SH()
      const streaming = !!(window.api.slskBrowseBegin && SHm && SHm.createTreeBuilder)
      const res = streaming
        ? await window.api.slskBrowseBegin({ username }).catch(e => ({ error: e.message }))
        : await window.api.slskBrowseUser({ username }).catch(e => ({ error: e.message }))
      if (!res || res.error || (streaming ? res.ok === false : !Array.isArray(res.directories))) {
        return { error: (res && res.error) || '' }
      }
      fromCache = !!res.fromCache
      cachedAt = Number(res.cachedAt) || 0
      noteNewDirs(res)
      if (!streaming) return { tree: T().buildTree(res.directories) }
      const builder = SHm.createTreeBuilder()
      const total = Number(res.dirCount) || 0
      let pulled = 0
      let failure = null
      try {
        for (let off = 0; off < total; off += 400) {
          // Leaving the page is simply "stop asking" — no cancel protocol.
          if (dead || !host.isConnected) return { aborted: true }
          const slice = await window.api.slskBrowseChunk({ token: res.token, offset: off, limit: 400 }).catch(() => null)
          // An expired token must not read as "the library ends here".
          if (!slice || !slice.ok) {
            failure = { error: slice && slice.expired ? 'That browse timed out — open it again.' : '' }
            break
          }
          builder.add(slice.directories || [])
          pulled += (slice.directories || []).length
          if (total) loadingLine((pulled / total) * 100)
        }
      } finally {
        // Main hashed the payload while we pulled and hands the hash back.
        try {
          const end = await window.api.slskBrowseEnd({ token: res.token })
          if (end && end.fingerprint) browseFp = end.fingerprint
          noteNewDirs(end)
        } catch (_) {}
      }
      if (failure) return failure
      if (dead || !host.isConnected) return { aborted: true }
      return { tree: builder.finish() }
    }

    // Albums, shelves and the fresh set, all derived from whatever `tree` is.
    // Returns false when the page died mid-build.
    async function buildFromTree() {
      const SHm = SH()
      albums = SHm.extractAlbumsChunked ? await SHm.extractAlbumsChunked(tree, { minTracks: 2, shouldAbort: () => dead }) : SHm.extractAlbums(tree, { minTracks: 2 })
      albums = albums || []
      if (dead || !host.isConnected) return false
      albumsByPath.clear()
      for (const a of albums) albumsByPath.set(String(a.folderPath).toLowerCase(), a)
      const detect = SF() ? SF().detectSurround : null
      shelves = SHm.buildShelvesChunked ? await SHm.buildShelvesChunked(albums, state.library, { detectSurround: detect, shouldAbort: () => dead }) : SHm.buildShelves(albums, state.library, { detectSurround: detect })
      if (dead || !shelves || !host.isConnected) return false
      missingSet = new Set(shelves.missing || [])
      for (const u of shelves.upgrades) albumsByPath.set(String(u.folderPath).toLowerCase(), u)
      const nd = new Set((newDirs || []).map(x => String(x).toLowerCase()))
      fresh = nd.size ? albums.filter(a => nd.has(String(a.folderPath).toLowerCase())) : []
      return true
    }

    // Builds the header on the first call and updates it in place on every one
    // after that (see the binding rule above paintHead). Nothing here may
    // re-serialise headEl, or the search box dies mid-keystroke.
    function refreshHead() {
      const Wm = W()
      updateHead(headerModel(shelves.stats, Wm ? Wm.characterLine(tree, albums) : '', lastStatus))
    }

    // Mirrors the shop's shScrolling gate: nothing heavy may rebuild under a
    // moving finger. A scroll sets the flag; 250 ms of quiet clears it.
    let roomScrolling = false
    let roomScrollSettle = null
    bodyEl.addEventListener('scroll', () => {
      roomScrolling = true
      clearTimeout(roomScrollSettle)
      roomScrollSettle = setTimeout(() => { roomScrolling = false }, 250)
    }, { passive: true })
    function idle() {
      return new Promise(r => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r()) : setTimeout(r, 50)))
    }

    // A background refresh landing means what is on screen is now stale.
    // Subscribed BEFORE the first pull: slsk-browse-begin kicks the refresh
    // itself, so a fast one could land with nobody listening.
    let offBrowseRefreshed = null
    if (window.api && typeof window.api.onSlskBrowseRefreshed === 'function') {
      offBrowseRefreshed = window.api.onSlskBrowseRefreshed(async (evt) => {
        if (dead || !host.isConnected) return
        if (!evt || String(evt.username || '') !== String(username)) return
        try {
          // Same hash as the one this page opened with: nothing changed.
          if (evt.fingerprint && browseFp && evt.fingerprint === browseFp) {
            fromCache = true
            cachedAt = Date.now()
            paintCacheLine(' · Updated just now')
            return
          }
          // The library really did change. Never rebuild under a moving
          // finger: wait out the scroll and take an idle slot first.
          while (roomScrolling && !dead && host.isConnected) await new Promise(r => setTimeout(r, 250))
          if (dead || !host.isConnected) return
          await idle()
          if (dead || !host.isConnected) return
          // The refresh wrote the cache a moment ago, so read it rather than
          // making slskd serve the whole library a second time.
          const res = await window.api.slskBrowseUser({ username }).catch(() => null)
          if (!res || !Array.isArray(res.directories) || dead || !host.isConnected) return
          const SHm = SH()
          let fp = null
          if (SHm && SHm.fingerprintBrowseChunked) {
            fp = await SHm.fingerprintBrowseChunked(res.directories, { shouldAbort: () => dead }).catch(() => null)
          }
          if (dead || !host.isConnected) return
          fromCache = !!res.fromCache
          cachedAt = Number(res.cachedAt) || Date.now()
          // Identical content: the multi-second rebuild would reproduce exactly
          // what is already painted. Freshen the provenance line and stop.
          if (fp && browseFp && fp === browseFp) { paintCacheLine(' · Updated just now'); return }
          if (fp) browseFp = fp
          noteNewDirs(res)
          const next = (SHm && SHm.buildTreeChunked)
            ? await SHm.buildTreeChunked(res.directories, { shouldAbort: () => dead })
            : T().buildTree(res.directories)
          if (!next || dead || !host.isConnected) return
          tree = next
          if (!(await buildFromTree())) return
          refreshHead()
          paintCacheLine(' · Updated just now')
          // In Folders, do NOT repaint. paintBody() destroys and remounts the
          // columns, which throws away where the user had navigated to (the
          // columns module exposes navTo but no way to read the current path
          // back, so we cannot restore it). The tree variable is already the
          // fresh one, so the next mount — a mode switch away and back — picks
          // it up; the header cache line above is what tells them it changed
          // in the meantime. Hunt and
          // Wander have no such position to lose and repaint normally.
          if (mode !== 'folders') paintBody()
        } catch (_) { /* a failed refresh must never disrupt the open page */ }
      })
    }

    const first = await pullBrowse()
    if (dead || !host.isConnected || first.aborted) return
    if (first.error !== undefined || !first.tree) {
      bodyEl.innerHTML = `<div class="slr-empty">Could not read this library. ${esc(first.error || '')}</div>`
      return
    }
    tree = first.tree
    if (!(await buildFromTree())) return
    try {
      const st0 = localStorage.getItem(sortKey(username))
      if (st0) { const [k, d] = st0.split(':'); if (SORT_KEYS.includes(k) && SORT_DIRS.includes(d)) { hunt.sort = k; hunt.dir = d } }
    } catch (_) {}
    const statuses = window.api.slskUserStatuses ? await window.api.slskUserStatuses().catch(() => null) : null
    if (dead || !host.isConnected) return
    const st = statuses && (statuses[username] || (Array.isArray(statuses) && statuses.find(x => x.username === username)))
    lastStatus = st ? { online: !!(st.online || st.isOnline || st.status === 'online'), queue: st.queueLength != null ? st.queueLength : st.queue } : null
    refreshHead()
    paintCacheLine(cacheText())
    paintBody()

    // Background: seeds and tags for "Because you own", other peers for "Only here".
    ;(async () => {
      const Wm = W()
      if (!Wm) return
      const lib = state.library || []
      const byArtist = new Map()
      for (const l of lib) if (l.artist) byArtist.set(l.artist, (byArtist.get(l.artist) || 0) + (Number(l.playCount) || 1))
      const peerArtists = new Set(albums.map(a => Wm.norm(a.artist)))
      wander.seeds = [...byArtist.entries()].sort((a, b) => b[1] - a[1])
        .map(([artist]) => lib.find(l => l.artist === artist))
        .filter(l => l && !peerArtists.has(Wm.norm(l.artist)))
        .slice(0, 3).map(l => ({ artist: l.artist, album: l.name }))
      const want = [...new Set([...wander.seeds.map(s => s.artist), ...Wm.goDeep(albums, null, 1).slice(0, 40).map(e => e.artist)])]
      for (const artist of want) {
        if (dead) return
        const r = window.api.musicbrainzArtistTags ? await window.api.musicbrainzArtistTags({ artist }).catch(() => null) : null
        if (r && r.ok) wander.tags[Wm.norm(artist)] = r.tags
      }
      wander.tagsDone = true
      if (window.api.slskCachedPeerAlbums) wander.otherPeers = await window.api.slskCachedPeerAlbums({ except: username }).catch(() => [])
      if (mode === 'wander' && !dead) paintWander()
    })()

    return {
      close() {
        dead = true
        if (artObs) artObs.disconnect()
        if (offBrowseRefreshed) { try { offBrowseRefreshed() } catch (_) {} offBrowseRefreshed = null }
        if (columns) columns.destroy()
        host.innerHTML = ''
      },
    }
  }

  const api = { show, headerModel, modeKey, wanderShelves, isCountFallback, headLines }
  if (typeof window !== 'undefined') window.PapaSlskRoomUI = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
