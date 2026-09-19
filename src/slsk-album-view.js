// The shared album view — ONE component that turns a remote Soulseek album into
// a first-class, openable object with a full track list and every per-track and
// per-album action. It serves all three surfaces that show remote albums:
//
//   • the record SHOP (shelves mode) — a card body click / Enter opens it
//   • SEARCH RESULTS — a merged card's body click opens it (fed by the best
//     source, or a specific source row when opened from one)
//   • FOLDERS mode — a directory row's album action opens it
//
// It renders as a slide-over panel: mounted into a host element when one is
// given (the shop modal, so it layers over the shelves like the queue panel),
// or as its own full overlay when no host is passed (search results, which have
// no modal to live inside). Either way the markup, styling, keyboard handling
// and action wiring are identical — the whole point of the extraction.
//
// Pure-ish: it owns its own DOM and closes over an explicit `deps` object (the
// same renderer globals the shop already threads: download/preview/play/enqueue,
// chat, navigate, snackbar, state, esc). No implicit renderer globals.
//
// Published as window.PapaSlskAlbumView; module.exports for tests.

;(function () {

  // In the app the shelves module is on window; under node (tests) it is a
  // require, so the fuzzy library match works in both.
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? (() => { try { return require('./slsk-shelves.js') } catch (_) { return null } })() : null)

  // ── Small pure helpers (also exported for unit tests) ───────────────────────

  // The basename of a slsk path (they use backslashes; some use forward).
  function baseName(p) {
    return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
  }

  // A track number leading the filename ("07 - ...", "07. ...", "07_..."). Null
  // when there isn't one. Kept separate so the list can show it in its own column.
  function trackNumOf(filename) {
    const b = baseName(filename)
    // A 1–3 digit number, then a separator (space / . / _ / - / )) OR end. Using
    // an explicit separator instead of \b — \b sees no boundary before "_", so
    // "07_Song" would otherwise miss.
    const m = b.match(/^\s*(\d{1,3})(?=[\s._)\-]|$)/)
    if (!m) return null
    const n = parseInt(m[1], 10)
    return (n >= 1 && n <= 999) ? n : null
  }

  // A human track title: basename, drop the extension, strip a leading track
  // number, and drop a leading "Artist - " / "Album - " prefix when it just
  // repeats the album name. Deliberately conservative — a wrong strip that eats
  // the real title is worse than a slightly noisy one.
  function cleanTrackTitle(filename, album) {
    let s = baseName(filename).replace(/\.[^.]+$/, '')
    s = s.replace(/^\s*\d{1,3}(?=[\s._)\-]|$)[\s._)\-.]*/, '')  // leading track number
    const albumName = String((album && album.album) || '').trim()
    if (albumName && albumName.length >= 4) {
      const low = s.toLowerCase()
      const al = albumName.toLowerCase()
      if (low.startsWith(al)) {
        const after = s.slice(albumName.length).replace(/^[\s\-–—_.()\[\]]+/, '')
        if (after.length > 2) s = after
      }
    }
    s = s.replace(/^[\s\-–—_.]+|[\s\-–—_.]+$/g, '')
    return s || baseName(filename)
  }

  // Per-track quality label from the file entry ("FLAC 24/96", "MP3 320", "FLAC").
  function trackQuality(f) {
    const s = SH()
    const name = f.name || f.filename || ''
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toUpperCase()
    const lossless = f.isFlac || (s ? s.isLosslessName(name) : /\.(flac|wav|aiff?|ape|wv|alac)$/i.test(name))
    const bd = Number(f.bitDepth) || 0
    const sr = Number(f.sampleRate) || 0
    const fmt = ext === 'FLAC' ? 'FLAC' : ext || (lossless ? 'FLAC' : 'MP3')
    if (lossless) {
      if (bd && sr) return `${fmt} ${bd}/${Math.round(sr / 1000)}`
      if (sr) return `${fmt} ${Math.round(sr / 1000)}kHz`
      return fmt
    }
    const kbps = Number(f.bitRate) || 0
    return kbps ? `${fmt} ${kbps}` : fmt
  }

  function fmtSize(bytes) {
    const s = SH()
    if (s && s.fmtSize) return s.fmtSize(bytes)
    let n = Number(bytes) || 0
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
    if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
    return n + ' B'
  }

  // Normalise whatever an opener hands us into the album shape the view renders.
  // Accepts: a shop/shelf album (files carry fullPath), a merged search album
  // (has .sources — we take .best or a chosen source), or a raw folder-group
  // (username + folderName + files). `sourceIndex` picks a specific source of a
  // merged album (a source-row open); otherwise the best source is used.
  function normalizeAlbum(input, sourceIndex) {
    if (!input) return null
    // A merged search album: pick the chosen source (or the best).
    let src = input
    let sources = null
    if (Array.isArray(input.sources)) {
      sources = input.sources
      const chosen = (sourceIndex != null && sources[sourceIndex]) || input.best || sources[0] || {}
      src = { ...input, ...chosen }   // chosen's files/username override the album's
    }
    const rawFiles = (src.files || []).filter(Boolean)
    const matchedLibId = input.matchedLibId != null ? String(input.matchedLibId) : null
    const s = SH()
    const files = rawFiles.map(f => ({
      // slsk-tree files carry fullPath (what slskd needs); search groups carry
      // filename. Prefer fullPath, fall back to filename. Keep the display name.
      filename: f.fullPath || f.filename || f.name || '',
      name: baseName(f.name || f.filename || f.fullPath || ''),
      size: Number(f.size) || 0,
      bitDepth: f.bitDepth, sampleRate: f.sampleRate, bitRate: f.bitRate, length: f.length,
      isFlac: f.isFlac != null ? !!f.isFlac
        : (s ? s.isLosslessName(f.name || f.filename || '') : /\.flac$/i.test(f.name || f.filename || '')),
    }))
    const totalSize = files.reduce((n, f) => n + f.size, 0)
    return {
      username: src.username || input.username || '',
      artist: input.artist || src.artist || '',
      album: input.album || src.folderName || baseName(src.folderPath) || '',
      year: input.year || src.year || null,
      folderName: src.folderName || input.folderName || '',
      folderPath: src.folderPath || input.folderPath || '',
      files,
      totalSize,
      lossless: files.length ? files.filter(f => f.isFlac).length >= files.length / 2 : false,
      isHiRes: files.some(f => (Number(f.bitDepth) || 0) >= 24 || (Number(f.sampleRate) || 0) >= 88200),
      matchedLibId,
      sources,          // kept so the header can offer "other sources"
      sourceIndex: sourceIndex != null ? sourceIndex : null,
    }
  }

  // My copy of this album, if I have one: the shelf's library match first,
  // else the same fuzzy artist/album match the cover lookup already trusts.
  function findMyCopy(a, state) {
    if (!state || !Array.isArray(state.library)) return null
    if (a.matchedLibId) {
      const hit = state.library.find(l => l && String(l.id) === a.matchedLibId)
      if (hit) return hit
    }
    const s = SH()
    if (!s || !a.album) return null
    return state.library.find(l => l && s.tokenScore(a.album, l.name) >= 0.6 &&
      (!a.artist || !l.artist || s.tokenScore(a.artist, l.artist) >= 0.34)) || null
  }

  function fmtDur(sec) {
    const n = Math.round(Number(sec) || 0)
    if (!n) return '—'
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0')
  }
  function fmtQual(t) {
    if (!t) return '—'
    const bd = Number(t.bitDepth) || 0, sr = Number(t.sampleRate) || 0, kb = Number(t.bitRate) || 0
    if (t.lossless) return t.fmt + (bd && sr ? ` ${bd}/${Math.round(sr / 1000)}` : sr ? ` ${Math.round(sr / 1000)}kHz` : '')
    return t.fmt + (kb ? ` ${kb}k` : '')
  }
  const VERDICT_GLYPH = { better: '▲', same: '=', worse: '▼', 'only-theirs': '+', 'only-mine': '−' }
  const VERDICT_TEXT = { better: 'theirs is better', same: 'same quality', worse: 'yours is better',
    'only-theirs': 'only in theirs', 'only-mine': 'only in yours' }

  // The compare drawer: peer album vs my copy, one row per track, and one
  // honest verdict. Pure — takes the comparison, returns markup.
  function compareDrawerHtml(cmp, mine, a, esc) {
    const s = cmp.summary
    const rows = cmp.rows.map(r => {
      const t = r.theirs, m = r.mine
      return `<tr class="slx-cmp-row slx-v-${r.verdict}">
        <td class="slx-cmp-n">${r.n != null ? r.n : ''}</td>
        <td class="slx-cmp-title" title="${esc((t || m).rawTitle)}">${esc((t || m).rawTitle)}</td>
        <td class="slx-cmp-dur">${t ? fmtDur(t.duration) : '—'}<span class="slx-cmp-vs">/</span>${m ? fmtDur(m.duration) : '—'}</td>
        <td class="slx-cmp-qual">${esc(fmtQual(t))}<span class="slx-cmp-vs">/</span>${esc(fmtQual(m))}</td>
        <td class="slx-cmp-size">${t ? esc(fmtSize(t.size)) : '—'}<span class="slx-cmp-vs">/</span>${m ? esc(fmtSize(m.size)) : '—'}</td>
        <td class="slx-cmp-verdict" title="${VERDICT_TEXT[r.verdict]}" aria-label="${VERDICT_TEXT[r.verdict]}">${VERDICT_GLYPH[r.verdict]}</td>
      </tr>`
    }).join('')
    const replaceWhy = s.replaceOk ? 'Download this copy; once every track is verified, offer to move yours to Trash'
      : !s.countsMatch ? 'Track counts differ — Replace would lose or duplicate music'
      : s.worse ? 'Yours is better on some tracks'
      : s.onlyMine ? 'Some of your tracks are missing from theirs'
      : 'Not an upgrade over your copy'
    return `<div class="slx-cmp-head">
        <div class="slx-cmp-side"><span class="slx-cmp-label">Theirs</span> ${esc(albumQualityLabel(a))} · ${s.theirsCount} tracks</div>
        <div class="slx-cmp-side"><span class="slx-cmp-label">Yours</span> ${esc(mine.name || '')} · ${s.mineCount} tracks</div>
      </div>
      <div class="slx-cmp-verdictline">${esc(s.line)}</div>
      <div class="slx-cmp-scroll"><table class="slx-cmp-table">
        <thead><tr><th>#</th><th>Title</th><th>Length <small>theirs / yours</small></th><th>Quality <small>theirs / yours</small></th><th>Size <small>theirs / yours</small></th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="slx-cmp-actions">
        <button class="slx-cmp-replace" ${s.replaceOk ? '' : 'disabled'} title="${esc(replaceWhy)}">⇄ Replace my copy</button>
        <span class="slx-cmp-why">${s.replaceOk ? '' : esc(replaceWhy)}</span>
        <button class="slx-cmp-close">Close compare</button>
      </div>`
  }

  // The album-quality summary line for the header.
  function albumQualityLabel(a) {
    const s = SH()
    if (s && s.albumQualityLabel) {
      const topExt = a.files.length
        ? (a.files.filter(f => f.isFlac).length >= a.files.length / 2 ? 'flac' : baseName(a.files[0].name).split('.').pop())
        : ''
      const maxBd = Math.max(0, ...a.files.map(f => Number(f.bitDepth) || 0))
      const maxSr = Math.max(0, ...a.files.map(f => Number(f.sampleRate) || 0))
      return s.albumQualityLabel({ topExt, lossless: a.lossless, maxBitDepth: maxBd, maxSampleRate: maxSr, files: a.files })
    }
    return a.lossless ? 'FLAC' : 'MP3'
  }

  // ── The component ───────────────────────────────────────────────────────────

  // open(spec) mounts the panel. spec:
  //   album       — the raw album/merged/group object (required)
  //   sourceIndex — pick a specific source of a merged album (optional)
  //   host        — element to mount into (slide-over inside the shop). When
  //                 omitted, a standalone overlay is created (search results).
  //   deps        — { esc, showSnackbar, startPreview, playCurrentTrack, state,
  //                   _slskEnqueue, _scheduleLibRescan, navigate, openSlskChat,
  //                   onClose } — the same renderer globals the shop threads.
  //
  // Returns { close } so the caller can tear it down (e.g. its own Esc chain).
  function open(spec) {
    const deps = spec.deps || {}
    const esc = deps.esc || (s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
    const showSnackbar = deps.showSnackbar || (() => {})
    const startPreview = deps.startPreview || (() => {})
    const playCurrentTrack = deps.playCurrentTrack || (() => {})
    const state = deps.state || { queue: [], queueIndex: 0, downloadWishlist: [] }
    const _slskEnqueue = deps._slskEnqueue || (() => Promise.resolve())
    const _scheduleLibRescan = deps._scheduleLibRescan || (() => {})
    const navigate = deps.navigate || (() => {})
    const openSlskChat = deps.openSlskChat
    const api = (typeof window !== 'undefined' && window.api) || {}

    const a = normalizeAlbum(spec.album, spec.sourceIndex)
    const myCopy = a ? findMyCopy(a, state) : null
    if (!a || !a.files.length) { showSnackbar('That album had no readable tracks'); return { close() {} } }
    const username = a.username

    // Sort files: track number if present, else FLAC-first then name — a stable
    // reading order for the list and for "first track" play.
    a.files.sort((x, y) => {
      const nx = trackNumOf(x.filename), ny = trackNumOf(y.filename)
      if (nx != null && ny != null && nx !== ny) return nx - ny
      if ((nx != null) !== (ny != null)) return nx != null ? -1 : 1
      return (y.isFlac ? 1 : 0) - (x.isFlac ? 1 : 0) ||
        (x.name || '').localeCompare(y.name || '')
    })

    const standalone = !spec.host
    const host = spec.host || document.body

    const panel = document.createElement('div')
    panel.className = 'slav-panel' + (standalone ? ' slav-standalone' : '')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', `${a.album} by ${a.artist || username}`)
    // A dialog nobody can reach by keyboard is not a dialog. The panel takes
    // focus when it opens and hands it back to whatever opened it on close.
    panel.setAttribute('tabindex', '-1')
    const slavOpener = document.activeElement

    // Selection state for the checkbox range-select.
    const selected = new Set()
    let lastClickedIndex = -1

    function selCount() { return selected.size }
    function updateSelUi() {
      const n = selCount()
      const bar = panel.querySelector('.slav-dl-selected')
      if (bar) {
        bar.textContent = n ? `⬇ Download selected (${n})` : 'Download selected'
        bar.disabled = !n
      }
      panel.querySelectorAll('.slav-track').forEach(row => {
        const i = parseInt(row.dataset.i, 10)
        row.classList.toggle('sel', selected.has(i))
        const cb = row.querySelector('.slav-track-cb')
        if (cb) cb.checked = selected.has(i)
      })
    }

    const sourcesNote = a.sources && a.sources.length > 1
      ? `<button class="slav-other-sources" title="Choose a different uploader">▾ ${a.sources.length} sources</button>` : ''
    const presenceNote = username
      ? `<button class="slav-user-link" data-username="${esc(username)}" title="Browse ${esc(username)}'s library">${esc(username)}</button>` : ''

    panel.innerHTML = `
      <div class="slav-head">
        <div class="slav-cover">${coverHtml(a, esc, state)}</div>
        <div class="slav-headmeta">
          <div class="slav-title" title="${esc(a.album)}">${esc(a.album || 'Unknown album')}</div>
          <div class="slav-artist">${esc(a.artist || '')}${a.year ? ` · ${a.year}` : ''}</div>
          <div class="slav-sub">
            <span class="slav-qual">${esc(albumQualityLabel(a))}</span>
            <span class="slav-dot">·</span>
            <span>${a.files.length} track${a.files.length !== 1 ? 's' : ''}</span>
            <span class="slav-dot">·</span>
            <span>${esc(fmtSize(a.totalSize))}</span>
          </div>
          <div class="slav-from">from ${presenceNote}${sourcesNote}</div>
          <div class="slav-actions">
            <button class="slav-dl-album">⬇ Download album</button>
            <button class="slav-dl-selected" disabled>Download selected</button>
            <button class="slav-wish" title="Add this album to your wishlist">＋ Wishlist</button>
            <button class="slav-find" title="Find other people sharing this album">⌕ Other sources</button>
            ${myCopy ? '<button class="slav-compare" aria-expanded="false" title="Track-by-track against the copy in your library">⇄ Compare with my copy</button>' : ''}
            ${openSlskChat ? '<button class="slav-msg" title="Message this uploader">✉ Message</button>' : ''}
          </div>
        </div>
        <button class="slav-close" aria-label="Close" title="Close (Esc)">✕</button>
      </div>
      <div class="slx-compare" hidden></div>
      <div class="slav-tracks-head">
        <label class="slav-selall" title="Select all tracks"><input type="checkbox" class="slav-selall-cb"> All</label>
        <span class="slav-th-num">#</span>
        <span class="slav-th-title">Title</span>
        <span class="slav-th-qual">Quality</span>
        <span class="slav-th-size">Size</span>
        <span class="slav-th-act"></span>
      </div>
      <div class="slav-tracks">
        ${a.files.map((f, i) => trackRowHtml(f, i, a, esc)).join('')}
      </div>`

    // Mount. Standalone gets an overlay wrapper so a click on the backdrop and
    // the modal-overlay styling both apply; the slide-over version mounts into
    // its host directly (positioned by CSS as an absolute slide-over).
    let overlay = null
    if (standalone) {
      overlay = document.createElement('div')
      overlay.className = 'modal-overlay slav-overlay'
      overlay.appendChild(panel)
      host.appendChild(overlay)
      overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })
    } else {
      host.appendChild(panel)
      // A one-frame delay lets the slide-in transition run from its start state.
      requestAnimationFrame(() => panel.classList.add('open'))
    }

    let closed = false
    function close() {
      if (closed) return
      closed = true
      document.removeEventListener('keydown', onKey, true)
      if (standalone) { if (overlay && overlay.isConnected) overlay.remove() }
      else {
        panel.classList.remove('open')
        // Remove after the slide-out; guard against a re-open reusing the node.
        setTimeout(() => { if (panel.isConnected) panel.remove() }, 220)
      }
      if (typeof deps.onClose === 'function') { try { deps.onClose() } catch (_) {} }
      if (slavOpener && slavOpener.isConnected && typeof slavOpener.focus === 'function') {
        try { slavOpener.focus() } catch (_) {}
      }
    }

    // ── Track row helpers ──────────────────────────────────────────────────────
    function fileAt(i) { return a.files[i] || null }

    async function downloadOne(btn, f) {
      const orig = btn.innerHTML
      btn.disabled = true; btn.textContent = '…'
      try {
        await api.slskDownload({ username, filename: f.filename, size: f.size || 0 })
        _scheduleLibRescan()
        btn.textContent = '✓'
        setTimeout(() => { if (btn.isConnected) { btn.innerHTML = orig; btn.disabled = false } }, 2500)
      } catch (e) {
        btn.textContent = '✕'; btn.title = 'Failed: ' + (e && e.message || 'error')
        setTimeout(() => { if (btn.isConnected) { btn.innerHTML = orig; btn.disabled = false } }, 2500)
      }
    }

    async function downloadAndPlay(btn, f) {
      const orig = btn.textContent
      btn.disabled = true; btn.textContent = '…'
      const title = cleanTrackTitle(f.filename, a)
      const play = (filePath) => {
        state.queue = [{ filePath, title, artist: a.artist || username, albumArtist: a.artist || username,
          artPath: null, albumName: a.album || a.folderName, albumId: `slav_${username}_${a.folderName}` }]
        state.queueIndex = 0
        playCurrentTrack()
      }
      try {
        const existing = await api.slskResolveFile({ username, filename: f.filename }).catch(() => null)
        if (existing && existing.path) { play(existing.path); btn.textContent = orig; btn.disabled = false; return }
        await api.slskDownload({ username, filename: f.filename, size: f.size || 0 })
        _scheduleLibRescan()
        const deadline = Date.now() + 180000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 2000))
          const res = await api.slskResolveFile({ username, filename: f.filename }).catch(() => null)
          if (res && res.path) { play(res.path); break }
          const raw = await api.slskGetTransfers().catch(() => [])
          const hit = raw.flatMap(u => (u.directories || []).flatMap(d => d.files || []))
            .find(x => x.filename === f.filename)
          if (hit && hit.state && /Failed|Aborted|Cancelled/.test(hit.state)) break
        }
      } catch (_) {}
      btn.textContent = orig; btn.disabled = false
    }

    // ── Wire it up (one delegated listener for the track list) ──────────────────
    panel.querySelector('.slav-close').addEventListener('click', close)

    panel.querySelector('.slav-dl-album').addEventListener('click', async ev => {
      const btn = ev.currentTarget
      const label = btn.textContent
      btn.disabled = true; btn.textContent = `Queuing ${a.files.length}…`
      try {
        const res = await _slskEnqueue(a.files.map(f => ({ username, filename: f.filename, size: f.size })))
        // Not throwing is not acceptance; a refusal restores the button.
        if (!res || res.ok === false) { btn.disabled = false; btn.textContent = label; return }
        _scheduleLibRescan()
        btn.textContent = `✓ ${res.added != null ? res.added : a.files.length} queued`
      } catch (e) {
        btn.disabled = false; btn.textContent = label
        showSnackbar('Could not queue the album: ' + String(e && e.message || e), null, null, 6000)
      }
    })

    const cmpBtn = panel.querySelector('.slav-compare')
    if (cmpBtn && myCopy) {
      const drawer = panel.querySelector('.slx-compare')
      cmpBtn.addEventListener('click', () => {
        const C = (typeof window !== 'undefined' && window.PapaSlskCompare) || null
        if (!C) { showSnackbar('The compare module did not load'); return }
        const open = drawer.hasAttribute('hidden')
        if (open) {
          const cmp = C.compareAlbums(a.files, myCopy.tracks || [])
          drawer.innerHTML = compareDrawerHtml(cmp, myCopy, a, esc)
          drawer.removeAttribute('hidden')
          const rep = drawer.querySelector('.slx-cmp-replace')
          rep.addEventListener('click', async () => {
            const label = rep.textContent
            rep.disabled = true; rep.textContent = 'Queuing…'
            try {
              const res = await _slskEnqueue(a.files.map(f => ({ username, filename: f.filename, size: f.size, replaceLibId: String(myCopy.id) })))
              if (!res || res.ok === false) { rep.disabled = false; rep.textContent = label; return }
              _scheduleLibRescan()
              rep.textContent = '✓ Downloading — Trash offered after verification'
              showSnackbar('Downloading the upgrade. Once every track is verified you will be offered to move your old copy to Trash.')
            } catch (e) { rep.disabled = false; rep.textContent = label; showSnackbar('Could not queue: ' + String(e && e.message || e)) }
          })
          drawer.querySelector('.slx-cmp-close').addEventListener('click', () => { drawer.setAttribute('hidden', ''); cmpBtn.setAttribute('aria-expanded', 'false'); cmpBtn.focus() })
          cmpBtn.setAttribute('aria-expanded', 'true')
          drawer.querySelector('.slx-cmp-replace').focus()
        } else {
          drawer.setAttribute('hidden', ''); cmpBtn.setAttribute('aria-expanded', 'false')
        }
      })
    }

    panel.querySelector('.slav-dl-selected').addEventListener('click', async ev => {
      const btn = ev.currentTarget
      const picks = [...selected].sort((x, y) => x - y).map(i => fileAt(i)).filter(Boolean)
      if (!picks.length) return
      const label = btn.textContent
      btn.disabled = true; btn.textContent = `Queuing ${picks.length}…`
      try {
        const res = await _slskEnqueue(picks.map(f => ({ username, filename: f.filename, size: f.size })))
        if (!res || res.ok === false) { btn.disabled = false; btn.textContent = label; return }
        _scheduleLibRescan()
        btn.textContent = `✓ ${res.added != null ? res.added : picks.length} queued`
        setTimeout(() => { if (btn.isConnected) { selected.clear(); updateSelUi() } }, 1200)
      } catch (e) {
        btn.disabled = false; btn.textContent = label
        showSnackbar('Could not queue those tracks: ' + String(e && e.message || e), null, null, 6000)
      }
    })

    panel.querySelector('.slav-wish').addEventListener('click', ev => {
      const q = `${a.artist} ${a.album}`.trim() || a.folderName
      const W = window.PapaWishlist
      let added = true
      if (W && typeof W.add === 'function') added = W.add(q).added
      else {
        if (!Array.isArray(state.downloadWishlist)) state.downloadWishlist = []
        state.downloadWishlist.push({ query: q, addedAt: Date.now() })
        if (api.saveDownloadWishlist) api.saveDownloadWishlist(state.downloadWishlist)
      }
      ev.currentTarget.textContent = '✓ Wishlisted'; ev.currentTarget.disabled = true
      showSnackbar(added ? `Added “${q}” to your wishlist` : `“${q}” is already on your wishlist`)
    })

    panel.querySelector('.slav-find').addEventListener('click', () => {
      close(); navigate('search', a.album || a.folderName)
    })

    const msgBtn = panel.querySelector('.slav-msg')
    if (msgBtn && openSlskChat) msgBtn.addEventListener('click', () => { try { openSlskChat(username) } catch (_) {} })

    panel.querySelector('.slav-user-link')?.addEventListener('click', () => {
      // Reuse the shop's own explorer opener via the renderer stub.
      if (typeof deps.showSlskUserExplorer === 'function') deps.showSlskUserExplorer(username)
      else if (typeof window.showSlskUserExplorer === 'function') window.showSlskUserExplorer(username)
    })

    // "Other sources" of a merged album → a tiny inline chooser that re-opens the
    // view fed by the picked source. Only present for merged albums with >1.
    panel.querySelector('.slav-other-sources')?.addEventListener('click', ev => {
      ev.stopPropagation()
      let menu = panel.querySelector('.slav-source-menu')
      if (menu) { menu.remove(); return }
      menu = document.createElement('div')
      menu.className = 'slav-source-menu'
      menu.innerHTML = a.sources.map((sc, si) => {
        const files = sc.files || []
        const flac = files.filter(f => f.isFlac || (SH() && SH().isLosslessName(f.name || f.filename))).length
        const q = flac ? `FLAC ×${flac}` : 'MP3'
        return `<button class="slav-source-opt${si === (a.sourceIndex || 0) ? ' current' : ''}" data-si="${si}">
          ${esc(sc.username || '')} <span class="slav-source-q">${q} · ${files.length} · ${esc(fmtSize(files.reduce((n, f) => n + (Number(f.size) || 0), 0)))}</span></button>`
      }).join('')
      panel.querySelector('.slav-from').appendChild(menu)
      menu.querySelectorAll('.slav-source-opt').forEach(opt => opt.addEventListener('click', () => {
        const si = parseInt(opt.dataset.si, 10)
        // Re-open fed by the chosen source, in the same host, then drop this one.
        const reopened = open({ album: spec.album, sourceIndex: si, host: spec.host, deps: spec.deps })
        close()
        return reopened
      }))
    })

    // Select-all.
    panel.querySelector('.slav-selall-cb').addEventListener('change', e => {
      selected.clear()
      if (e.target.checked) a.files.forEach((_, i) => selected.add(i))
      updateSelUi()
    })

    // Delegated track-list clicks: checkboxes (with shift-range), and per-track
    // ⚡ preview / ▶ play / ⬇ download.
    const tracksEl = panel.querySelector('.slav-tracks')
    tracksEl.addEventListener('click', async e => {
      const row = e.target.closest('.slav-track')
      if (!row) return
      const i = parseInt(row.dataset.i, 10)
      const f = fileAt(i)
      if (!f) return
      const cb = e.target.closest('.slav-track-cb')
      const act = e.target.closest('[data-act]')
      if (cb) {
        // Shift-click extends the range from the last checkbox click.
        if (e.shiftKey && lastClickedIndex >= 0) {
          const [lo, hi] = [Math.min(i, lastClickedIndex), Math.max(i, lastClickedIndex)]
          const turnOn = cb.checked
          for (let k = lo; k <= hi; k++) { if (turnOn) selected.add(k); else selected.delete(k) }
        } else {
          if (cb.checked) selected.add(i); else selected.delete(i)
        }
        lastClickedIndex = i
        updateSelUi()
        return
      }
      if (!act) return
      e.stopPropagation()
      const kind = act.dataset.act
      if (kind === 'preview') {
        startPreview({ username, filename: f.filename, size: f.size || 0, artist: a.artist || '' })
      } else if (kind === 'play') {
        await downloadAndPlay(act, f)
      } else if (kind === 'dl') {
        await downloadOne(act, f)
      }
    })

    // Keyboard: Esc closes; ↑/↓ move a focus ring over the track rows; Enter on a
    // focused row plays it. Captured (useCapture) and layered so the shop's own
    // Esc chain sees the panel first when it is open.
    const rows = () => Array.prototype.slice.call(panel.querySelectorAll('.slav-track'))
    let focusIdx = -1
    function focusRow(idx) {
      const rs = rows()
      if (!rs.length) return
      focusIdx = Math.max(0, Math.min(rs.length - 1, idx))
      rs.forEach((r, k) => r.classList.toggle('kfocus', k === focusIdx))
      rs[focusIdx].scrollIntoView({ block: 'nearest' })
    }
    function onKey(e) {
      if (!panel.isConnected) return
      const tag = String(e.target && e.target.tagName || '').toUpperCase()
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusRow(focusIdx + 1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusRow(focusIdx - 1) }
      else if (e.key === 'Enter' && focusIdx >= 0) {
        e.preventDefault(); e.stopPropagation()
        const r = rows()[focusIdx]
        const playBtn = r && r.querySelector('[data-act="play"]')
        if (playBtn) playBtn.click()
      }
    }
    // Capture so we win the Esc race against the shop's own document keydown; the
    // shop's onKey checks for the album panel and defers (see the shop wiring).
    document.addEventListener('keydown', onKey, true)

    // Focus the close button when there is one, otherwise the panel itself, so
    // Tab walks the album's own controls rather than the page behind it.
    const firstStop = panel.querySelector('.slav-close') || panel
    try { firstStop.focus({ preventScroll: true }) } catch (_) { try { firstStop.focus() } catch (_) {} }

    return { close, panel, album: a }
  }

  // ── Static HTML fragment builders ─────────────────────────────────────────────

  function trackRowHtml(f, i, album, esc) {
    const num = trackNumOf(f.filename)
    const title = cleanTrackTitle(f.filename, album)
    return `<div class="slav-track" data-i="${i}">
      <label class="slav-track-sel"><input type="checkbox" class="slav-track-cb"></label>
      <span class="slav-track-num">${num != null ? num : '·'}</span>
      <span class="slav-track-title" title="${esc(f.name)}">${esc(title)}</span>
      <span class="slav-track-qual">${esc(trackQuality(f))}</span>
      <span class="slav-track-size">${esc(fmtSize(f.size))}</span>
      <span class="slav-track-actions">
        <button class="slav-track-btn" data-act="preview" title="Preview — hear it before downloading" aria-label="Preview">⚡</button>
        <button class="slav-track-btn" data-act="play" title="Download &amp; play" aria-label="Play">▶</button>
        <button class="slav-track-btn" data-act="dl" title="Download this track" aria-label="Download">⬇</button>
      </span>
    </div>`
  }

  // Album cover: reuse a local-library match (by album-name similarity) when the
  // shelves module is present, else a deterministic gradient fallback. Kept simple
  // — the view is opened on demand, not en-masse, so no lazy fetch machinery here.
  function coverHtml(a, esc, state) {
    const s = SH()
    let artPath = null
    if (s && state && Array.isArray(state.library)) {
      for (const lib of state.library) {
        if (!lib.artPath) continue
        if (s.tokenScore(a.album, lib.name) >= 0.6 &&
            (!a.artist || !lib.artist || s.tokenScore(a.artist, lib.artist) >= 0.34)) { artPath = lib.artPath; break }
      }
    }
    const hue = Math.abs([...(a.album || a.folderName || '')]
      .reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
    const grad = `background:linear-gradient(135deg,hsl(${hue},45%,20%),hsl(${(hue + 40) % 360},35%,12%))`
    if (artPath) {
      const src = /^https?:\/\//.test(artPath) ? artPath : `file://${artPath}`
      return `<img class="slav-cover-img" src="${esc(src)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="slav-cover-fb" style="display:none;${grad}"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>`
    }
    return `<div class="slav-cover-fb" style="${grad}"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>`
  }

  const api = {
    open,
    compareDrawerHtml, findMyCopy,
    // Exposed for unit tests.
    normalizeAlbum, cleanTrackTitle, trackNumOf, trackQuality, baseName,
  }
  if (typeof window !== 'undefined') window.PapaSlskAlbumView = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api

})()
