// Soulseek user-library explorer + record shop — extracted VERBATIM from
// renderer.js (roadmap #62, structural split half A). The big self-contained
// modal: the folder tree (back/forward/up, breadcrumbs, subtree download,
// surround finder) and the "record shop" shelves view (albums, upgrades,
// grab-all, sort/filter, keyboard nav, lazy cover art).
//
// It lives apart from renderer.js so the ~30k-line renderer shrinks and this
// region loads as its own <script>. Rather than reach implicitly for the
// renderer globals it needs, every one is threaded in through an explicit
// `deps` object passed to show(username, deps). renderer.js keeps a thin
// delegating stub (showSlskUserExplorer) so every existing call site keeps
// working.
//
// The explorer's own close function used to be a module-level `var` in
// renderer.js; it was only ever read/written inside this region, so it moves in
// here whole. Its close() removes the keydown listener; opening the explorer for
// a second user tears the first one's DOM down and nulls this slot.
//
// Published as window.PapaSlskShopUI for the renderer; module.exports for tests.

;(function () {

  // The live explorer's own close function (was `var _slskExplorerClose` in
  // renderer.js). Module-scoped here so the moved body resolves it unchanged.
  var _slskExplorerClose = null

  // The extraction seam. The body below is showSlskUserExplorer's original body,
  // moved verbatim; the only addition is this deps preamble that binds the
  // renderer globals the body closes over to locals of the same name.
  async function show(username, deps) {
    const _mgConfirm         = deps._mgConfirm
    const _scheduleLibRescan = deps._scheduleLibRescan
    const _slskCardDownloads = deps._slskCardDownloads
    const _slskCardKey       = deps._slskCardKey
    const _slskCardProgress  = deps._slskCardProgress
    const _slskDirQuality    = deps._slskDirQuality
    const _slskEnqueue       = deps._slskEnqueue
    const esc                = deps.esc
    const hideContextMenu    = deps.hideContextMenu
    const navigate           = deps.navigate
    const openSlskChat       = deps.openSlskChat
    const playCurrentTrack   = deps.playCurrentTrack
    const showSnackbar       = deps.showSnackbar
    const slsk               = deps.slsk
    const startPreview       = deps.startPreview
    const state              = deps.state

  hideContextMenu()
  if (_slskExplorerClose) { try { _slskExplorerClose() } catch (_) {} }
  document.getElementById('slsk-user-lib-modal')?.remove()

  const T = window.PapaSlskTree
  const SH = window.PapaSlskShelves
  const AV = window.PapaSlskAlbumView   // the shared album view (slide-over)
  // Shelves ("the record shop") is the flagship default; Folders is the raw
  // tree power mode. The choice is remembered so a folder-diver isn't dropped
  // back into shelves every time.
  let mode = 'shelves'
  try { const m = localStorage.getItem('slsk_lib_mode'); if (m === 'folders' || m === 'shelves') mode = m } catch (_) {}
  const dlg = document.createElement('div')
  dlg.id = 'slsk-user-lib-modal'
  dlg.className = 'modal-overlay slsh-overlay'
  dlg.innerHTML = `<div class="modal-box slsk-lib-box slsh-box">
    <div class="modal-header-row slsh-header">
      <div class="modal-title">${esc(username)}</div>
      <span class="slsh-presence" id="slsh-presence" title="Presence"></span>
      <div class="slsh-modeswitch" id="slsh-modeswitch" role="tablist">
        <button class="slsh-mode-btn" data-mode="shelves" role="tab" title="The record shop — albums, upgrades and shelves">Shelves</button>
        <button class="slsh-mode-btn" data-mode="folders" role="tab" title="The raw file tree — breadcrumbs, subtree download, surround finder">Folders</button>
      </div>
      <button class="slskx-msg" id="slskx-msg" title="Message this user">✉</button>
      <button class="slskx-star" id="slskx-star" title="Save this library">☆</button>
      <button class="modal-close-btn" id="slsk-lib-close" aria-label="Close" title="Close">✕</button>
    </div>
    <div class="slskx-toolbar" id="slskx-toolbar">
      <button class="slskx-nav" id="slskx-back" title="Back (Alt+←)" disabled>←</button>
      <button class="slskx-nav" id="slskx-fwd"  title="Forward (Alt+→)" disabled>→</button>
      <button class="slskx-nav" id="slskx-up"   title="Up one level (Backspace)" disabled>↑</button>
      <div class="slskx-crumbs" id="slskx-crumbs"></div>
      <input class="slskx-search" id="slskx-search" placeholder="Search this library…" autocomplete="off">
      <select class="slskx-sort" id="slskx-sort" title="Sort">
        <option value="name">Name</option>
        <option value="size">Size</option>
        <option value="type">Type</option>
      </select>
      <label class="slskx-audio-toggle" title="Hide artwork, playlists and other non-audio files">
        <input type="checkbox" id="slskx-audio-only" checked> Audio only
      </label>
      <button class="slskx-nav slskx-sur-btn" id="slskx-surround" style="width:auto;padding:0 8px"
              aria-pressed="false"
              title="List every surround-labelled folder in this library">Surround finder</button>
    </div>
    <div class="slskx-actionbar" id="slskx-actionbar"></div>
    <div class="slsk-lib-body" id="slsk-lib-body">
      <div class="slsk-lib-loading indeterminate">
        <div class="slsk-lib-loading-text">Fetching ${esc(username)}'s file list from slskd…</div>
        <div class="slsk-lib-loading-bar" role="progressbar" aria-label="Fetching the library"><span></span></div>
      </div>
    </div>
    <div class="slsh-body" id="slsh-body" style="display:none"></div>
    <div class="slskx-statusbar" id="slskx-status"></div>
  </div>`
  document.body.appendChild(dlg)
  // Focus moves into the modal the moment it exists, not after the browse.
  // A browse that fails (an offline peer, no credentials) returns early, and
  // focus used to stay on the opener behind the overlay for the whole of that
  // error state -- Tab walked the page underneath it.
  try { (dlg.querySelector('#slsk-lib-close') || dlg).focus({ preventScroll: true }) } catch (_) {}

  const body    = dlg.querySelector('#slsk-lib-body')
  const crumbs  = dlg.querySelector('#slskx-crumbs')
  const status  = dlg.querySelector('#slskx-status')
  const actions = dlg.querySelector('#slskx-actionbar')
  const search  = dlg.querySelector('#slskx-search')
  const shBody  = dlg.querySelector('#slsh-body')
  const toolbar = dlg.querySelector('#slskx-toolbar')
  let shelves   = null   // parsed { upgrades, missing, surround, hires, everything, stats }
  let peerAlbums = null  // raw parsed album list, for instant search

  // Toggle between the record shop (shelves) and the raw folder tree.
  function applyMode() {
    const shelvesMode = mode === 'shelves'
    shBody.style.display   = shelvesMode ? '' : 'none'
    body.style.display     = shelvesMode ? 'none' : ''
    toolbar.style.display  = shelvesMode ? 'none' : ''
    actions.style.display  = shelvesMode ? 'none' : ''
    status.style.display   = shelvesMode ? 'none' : ''
    dlg.querySelectorAll('.slsh-mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode))
    if (shelvesMode) renderShelves()
    else render()
  }
  dlg.querySelectorAll('.slsh-mode-btn').forEach(b =>
    b.addEventListener('click', () => {
      if (mode === b.dataset.mode) return
      mode = b.dataset.mode
      try { localStorage.setItem('slsk_lib_mode', mode) } catch (_) {}
      applyMode()
    }))

  // The live album-view slide-over, when one is open over the shop. Its Esc is
  // layered ABOVE the shop's own Esc chain (see onKey): closing the panel first,
  // then the shop. Opened by a card-body click / Enter and by folder rows.
  let _slavPanel = null
  function openAlbumView(album, sourceIndex) {
    if (!AV || !AV.open || !album) return
    if (_slavPanel) { try { _slavPanel.close() } catch (_) {} _slavPanel = null }
    _slavPanel = AV.open({
      album, sourceIndex,
      host: dlg.querySelector('.slsh-box') || dlg,
      deps: {
        esc, showSnackbar, startPreview, playCurrentTrack, state,
        _slskEnqueue, _scheduleLibRescan, navigate, openSlskChat,
        showSlskUserExplorer: (u) => { close(); if (typeof window.showSlskUserExplorer === 'function') window.showSlskUserExplorer(u) },
        onClose: () => { _slavPanel = null },
      },
    })
  }

  // Focus came from somewhere and has to go back there. Closing the shop used
  // to leave focus on a removed node, which drops it to <body> -- Tab then
  // restarted from the top of the page.
  const opener = document.activeElement

  const close = () => {
    if (_slavPanel) { try { _slavPanel.close() } catch (_) {} _slavPanel = null }
    if (_slskExplorerClose === close) _slskExplorerClose = null
    document.removeEventListener('keydown', onKey)
    // Tear down the lazy-art observer so its callback can't fire into a removed
    // DOM and its pending fetches are dropped on the floor.
    try { if (shArtObserver) { shArtObserver.disconnect(); shArtObserver = null } } catch (_) {}
    shArtQueue.length = 0
    // Abort the background cover prefetch so its remaining fetches are dropped.
    shArtPrefetchAbort = true
    // Drop the background-refresh subscription so it can't rebuild a dead shop.
    try { if (typeof _offBrowseRefreshed === 'function') _offBrowseRefreshed() } catch (_) {}
    dlg.remove()
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus() } catch (_) {}
    }
  }
  _slskExplorerClose = close
  dlg.querySelector('#slsk-lib-close').addEventListener('click', close)
  dlg.addEventListener('click', e => { if (e.target === dlg) close() })

  let tree = null
  const hist = new T.NavHistory('')
  let sort = 'name'
  let audioOnly = true
  let searching = ''
  let surroundOnly = false
  // Folder-mode track selection: file indices (into the current listing) ticked
  // for a "Download selected" batch. Cleared on every navigation.
  const folderSel = new Set()
  let folderSelLast = -1

  // The folders view used to round with its own GB-capped helper, so a big
  // peer's root printed "1780.1 GB" and "2225.3 GB". One formatter for the
  // whole shop -- the shelves module's, which rolls up to TB and PB.
  function fmtSize(n) { return (SH && SH.fmtSize) ? SH.fmtSize(n) : _fmtSizeLocal(n) }
  function _fmtSizeLocal(n) {
    n = Number(n) || 0
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
    if (n >= 1048576)    return (n / 1048576).toFixed(0) + ' MB'
    if (n >= 1024)       return (n / 1024).toFixed(0) + ' KB'
    return n + ' B'
  }

  // Every count and total the folders view prints about "everything below"
  // must mean the same thing the Download button will actually queue: audio
  // files only. The button used to say 1780 GB / 1 file from node.fileCount
  // (which counts artwork, logs and cue sheets) and then queue none of them.
  function audioBelow(node, out) {
    out = out || { files: [], size: 0 }
    if (!node) return out
    for (const f of node.files) {
      if (T.AUDIO_RE.test(f.name)) { out.files.push(f); out.size += Number(f.size) || 0 }
    }
    for (const c of node.dirs.values()) audioBelow(c, out)
    return out
  }

  // Above either of these, "Download everything below" states the real totals
  // and waits for a yes. A peer's root was offering 1780 GB on one click.
  const SUBTREE_CONFIRM_FILES = 50
  const SUBTREE_CONFIRM_BYTES = 5 * 1024 * 1024 * 1024

  // Runs `go` straight away for a small subtree; for anything big, states the
  // real totals first and runs it only on a yes. _mgConfirm has no cancel
  // callback -- cancelling simply never calls back, which is what we want.
  function confirmSubtree(count, size, go) {
    if (count <= SUBTREE_CONFIRM_FILES && size <= SUBTREE_CONFIRM_BYTES) return go()
    if (typeof _mgConfirm !== 'function') return go()
    return _mgConfirm(
      `Download ${count} file${count !== 1 ? 's' : ''}?`,
      `<p>That is <strong>${fmtSize(size)}</strong> of audio from ${esc(username)}, ` +
      `across every folder below this one.</p>`,
      `Download ${count}`,
      go,
    )
  }

  // The wishlist add with its dedupe lives in renderer.js, where the state and
  // the save call are. Falling back to a plain push keeps this file standalone.
  function wishlistAdd(q) {
    const W = window.PapaWishlist
    if (W && typeof W.add === 'function') return W.add(q)
    if (!Array.isArray(state.downloadWishlist)) state.downloadWishlist = []
    state.downloadWishlist.push({ query: q, addedAt: Date.now() })
    window.api.saveDownloadWishlist(state.downloadWishlist)
    return { added: true, query: q }
  }

  // A cache-miss browse sits on a static line for the whole slskd fetch --
  // seven seconds on a 7,635-album peer -- before the first percentage can
  // exist, because the percentage needs a directory count we do not have yet.
  // The bar runs indeterminate until then, and the copy names the phase.
  function shLoadingProgress(el, text, pct) {
    if (!el) return
    el.classList.remove('indeterminate')
    const t = el.querySelector('.slsk-lib-loading-text')
    const bar = el.querySelector('.slsk-lib-loading-bar span')
    const p = Math.max(0, Math.min(100, Math.round(pct)))
    if (t) t.textContent = `${text} ${p}%`
    else el.textContent = `${text} ${p}%`
    if (bar) bar.style.width = p + '%'
    const pb = el.querySelector('.slsk-lib-loading-bar')
    if (pb) { pb.setAttribute('aria-valuenow', String(p)); pb.setAttribute('aria-valuemin', '0'); pb.setAttribute('aria-valuemax', '100') }
  }

  // Folder paths the engine reports as new since this peer was last browsed.
  // Null until a reply carries the field, so an engine without it behaves
  // exactly as before: no rail, nothing said.
  let shNewDirs = null

  function shNewAlbums() {
    if (!shNewDirs || !shNewDirs.size || !shelves || !shelves.everything) return []
    const out = []
    for (const a of shelves.everything) {
      if (shNewDirs.has(a.folderPath) || shNewDirs.has(a.folderName)) out.push(a)
    }
    return out
  }

  function shNoteNewDirs(reply) {
    if (reply && Array.isArray(reply.newDirs) && reply.newDirs.length) {
      shNewDirs = new Set(reply.newDirs)
    }
  }

  function navTo(path) { hist.go(path); searching = ''; search.value = ''; render() }

  function renderCrumbs(path) {
    crumbs.innerHTML = T.breadcrumbs(path)
      .map((b, i, arr) => `<button class="slskx-crumb${i === arr.length - 1 ? ' current' : ''}"
            data-path="${esc(b.path)}">${esc(b.name)}</button>`)
      .join('<span class="slskx-crumb-sep">›</span>')
    crumbs.querySelectorAll('.slskx-crumb').forEach(b =>
      b.addEventListener('click', () => navTo(b.dataset.path)))
    crumbs.scrollLeft = crumbs.scrollWidth
  }

  function render() {
    const path = hist.current
    dlg.querySelector('#slskx-back').disabled = !hist.canBack
    dlg.querySelector('#slskx-fwd').disabled  = !hist.canForward
    dlg.querySelector('#slskx-up').disabled   = !path
    renderCrumbs(path)

    if (surroundOnly) return renderSurroundFolders()
    if (searching) return renderSearch()

    const l = T.listDir(tree, path, { sort, audioOnly })
    if (!l) { body.innerHTML = `<div class="slsk-lib-empty">Folder not found.</div>`; return }

    // A fresh folder view starts with nothing selected.
    folderSel.clear()
    const audioHere = l.files.filter(f => T.AUDIO_RE.test(f.name))
    const belowAudio = audioBelow(l.node)
    // With "Audio only" on, listDir hides the non-audio files, so a folder of
    // artwork and logs rendered zero rows and said "This folder is empty."
    const hiddenHere = audioOnly ? Math.max(0, (l.node.files.length || 0) - audioHere.length) : 0
    actions.innerHTML = audioHere.length
      ? `<button class="slskx-act" id="slskx-dl-folder">Download folder (${audioHere.length})</button>
         <button class="slskx-act" id="slskx-play-first">Play first track</button>
         <button class="slskx-act" id="slskx-dl-selected" disabled>Download selected</button>`
      : (belowAudio.files.length
          ? `<button class="slskx-act" id="slskx-dl-tree">Download everything below (${belowAudio.files.length} · ${fmtSize(belowAudio.size)})</button>` : '')

    const rows = []
    for (const d of l.dirs) {
      // Per-folder quality summary, computed from the real tree node's audio
      // files ("mostly FLAC 16/44 · 2 surround"). slsk-tree keeps the files, so
      // pull the node back out rather than trying to carry them on the dir stub.
      const dNode = T.getNode(tree, d.path)
      const qSum  = dNode ? _slskDirQuality(dNode) : ''
      rows.push(`<div class="slskx-row slskx-dir" data-path="${esc(d.path)}" role="button" tabindex="0" aria-label="Open folder ${esc(d.name)}, ${d.fileCount} files">
        <span class="slskx-ico">📁</span>
        <span class="slskx-name">${esc(d.name)}${qSum ? `<span class="slskx-dir-qual">${esc(qSum)}</span>` : ''}</span>
        <span class="slskx-meta">${d.subdirCount ? d.subdirCount + ' folders · ' : ''}${d.fileCount} files</span>
        <span class="slskx-size">${fmtSize(d.totalSize)}</span>
        <span class="slskx-rowbtns">
          <button class="slskx-mini-search slskx-dir-search" data-fsearch="${esc(d.name)}" title="Search everywhere for this folder name" aria-label="Search everywhere for this folder name">⌕</button>
        </span>
      </div>`)
    }
    l.files.forEach((f, i) => {
      const isAudio = T.AUDIO_RE.test(f.name)
      rows.push(`<div class="slskx-row slskx-file${isAudio ? '' : ' dim'}" data-fi="${i}">
        ${isAudio ? `<label class="slskx-selbox"><input type="checkbox" class="slskx-file-cb" data-fi="${i}"></label>` : '<span class="slskx-selbox"></span>'}
        <span class="slskx-ico">${isAudio ? '🎵' : '📄'}</span>
        <span class="slskx-name">${esc(f.name)}</span>
        <span class="slskx-meta">${f.bitDepth ? f.bitDepth + '-bit ' : ''}${f.sampleRate ? (f.sampleRate/1000).toFixed(1) + 'kHz' : ''}</span>
        <span class="slskx-size">${fmtSize(f.size)}</span>
        <span class="slskx-rowbtns">
          ${isAudio ? `<button class="slskx-mini" data-act="preview" data-fi="${i}" title="Preview — hear it before you download" aria-label="Preview track">⚡</button>` : ''}
          ${isAudio ? `<button class="slskx-mini" data-act="play" data-fi="${i}" title="Download &amp; play" aria-label="Download and play">▶</button>` : ''}
          <button class="slskx-mini" data-act="dl" data-fi="${i}" title="Download" aria-label="Download">↓</button>
        </span>
      </div>`)
    })

    const emptyCopy = hiddenHere
      ? `<div class="slsk-lib-empty">No audio here — ${hiddenHere} non-audio file${hiddenHere !== 1 ? 's' : ''} hidden.
           <button class="slskx-act" id="slskx-show-hidden">Show them</button></div>`
      : `<div class="slsk-lib-empty">This folder is empty.</div>`
    body.innerHTML = rows.length ? rows.join('') : emptyCopy
    status.textContent = `${l.dirs.length} folder${l.dirs.length !== 1 ? 's' : ''} · ${l.files.length} file${l.files.length !== 1 ? 's' : ''} · ${fmtSize(belowAudio.size)} of audio below this point`
    bindRows(l)
  }

  // The reason to care about a peer at all: one 5.1 album usually means more.
  // This walks the whole tree and lists every surround-labelled folder, which
  // is the fastest way to see what a good source actually holds.
  function renderSurroundFolders() {
    const SF = window.PapaSlskFilters
    const hits = []
    const walk = (n) => {
      for (const d of n.dirs.values()) {
        const sur = SF && SF.detectSurround(d.path)
        if (sur && d.fileCount) hits.push({ node: d, label: sur.label })
        walk(d)
      }
    }
    walk(tree)
    hits.sort((a, b) => b.node.fileCount - a.node.fileCount)
    actions.innerHTML = ''
    body.innerHTML = hits.length
      ? hits.map(h => `<div class="slskx-row slskx-dir" data-path="${esc(h.node.path)}" role="button" tabindex="0" aria-label="Open folder ${esc(h.node.name)}, ${h.node.fileCount} files">
          <span class="slskx-ico">📁</span>
          <span class="slskx-name">${esc(h.node.name)}
            <span class="slskx-card-surround" style="position:static;margin-left:6px">${esc(h.label)}</span></span>
          <span class="slskx-meta">${esc(h.node.path)}</span>
          <span class="slskx-size">${h.node.fileCount} files</span>
        </div>`).join('')
      : `<div class="slsk-lib-empty">No surround-labelled folders in this library.<br>
           <span style="color:var(--text3);font-size:11px">Only the folder names are searchable — an unlabelled 5.1 rip cannot be spotted from here.</span></div>`
    status.textContent = hits.length
      ? `${hits.length} surround folder${hits.length !== 1 ? 's' : ''} found`
      : 'No surround folders found'
    body.querySelectorAll('.slskx-dir').forEach(r => {
      const open = () => { surroundOnly = false; navTo(r.dataset.path) }
      r.addEventListener('click', open)
      bindDirKeys(r, open)
    })
  }

  function renderSearch() {
    // Folders-mode search: same 300-hit contract, served from the precomputed
    // index once it lands (a raw searchTree walk re-lowercases every name).
    const hits = (shTreeSearchIndex && SH && SH.searchTreeIndex)
      ? SH.searchTreeIndex(shTreeSearchIndex, searching, 300)
      : T.searchTree(tree, searching)
    actions.innerHTML = ''
    body.innerHTML = hits.length
      ? hits.map(h => h.type === 'dir'
          ? `<div class="slskx-row slskx-dir" data-path="${esc(h.path)}" role="button" tabindex="0" aria-label="Open folder ${esc(h.name)}, ${h.fileCount} files">
               <span class="slskx-ico">📁</span><span class="slskx-name">${esc(h.name)}</span>
               <span class="slskx-meta">${esc(h.path)}</span>
               <span class="slskx-size">${h.fileCount} files</span></div>`
          : `<div class="slskx-row slskx-file" data-gopath="${esc(h.path)}">
               <span class="slskx-ico">🎵</span><span class="slskx-name">${esc(h.name)}</span>
               <span class="slskx-meta">${esc(h.path)}</span></div>`).join('')
      : `<div class="slsk-lib-empty">Nothing matching “${esc(searching)}”.</div>`
    status.textContent = `${hits.length} match${hits.length !== 1 ? 'es' : ''}${hits.length >= 300 ? ' (showing first 300)' : ''}`
    body.querySelectorAll('.slskx-dir').forEach(r =>
      r.addEventListener('click', () => navTo(r.dataset.path)))
    body.querySelectorAll('[data-gopath]').forEach(r =>
      r.addEventListener('click', () => navTo(r.dataset.gopath)))
  }

  async function dlFile(btn, f) {
    const orig = btn.innerHTML
    btn.disabled = true; btn.textContent = '…'
    try {
      await window.api.slskDownload({ username, filename: f.fullPath, size: f.size || 0 })
      btn.textContent = '✓'
      _scheduleLibRescan()
      // Restored on success too: the tick used to be permanent, so a file that
      // failed later in the transfer could not be asked for again.
      setTimeout(() => { if (btn.isConnected) { btn.innerHTML = orig; btn.disabled = false } }, 2500)
    } catch (e) {
      btn.textContent = '✕'; btn.title = 'Failed: ' + (e?.message || 'error')
      setTimeout(() => { if (btn.isConnected) { btn.innerHTML = orig; btn.disabled = false } }, 2500)
    }
  }

  // A folder row is a control: Enter and Space open it, the same as a click.
  // Without this the rows were reachable by Tab but did nothing.
  function bindDirKeys(r, open) {
    r.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (e.target !== r) return
      e.preventDefault()
      open()
    })
  }

  function bindRows(l) {
    body.querySelectorAll('.slskx-dir').forEach(r => {
      const open = () => navTo(r.dataset.path)
      r.addEventListener('click', e => {
        // The per-folder search button lives inside the row; a click on it must
        // not also navigate into the folder.
        if (e.target.closest && e.target.closest('.slskx-dir-search')) return
        open()
      })
      bindDirKeys(r, open)
    })

    // Search the whole app for this uploader's folder name. Same handoff the
    // search-card breadcrumb uses: close the modal, then navigate('search', q).
    body.querySelectorAll('.slskx-dir-search').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation()
        const q = btn.dataset.fsearch
        if (!q) return
        close()
        navigate('search', q)
      }))

    body.querySelectorAll('.slskx-mini').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation()
        const f = l.files[parseInt(btn.dataset.fi)]
        if (!f) return
        if (btn.dataset.act === 'dl') return dlFile(btn, f)
        if (btn.dataset.act === 'preview') {
          // Raw tree has no parsed artist; the filename carries the track title.
          // The containing folder name is the best artist/album hint, so pass it
          // as the artist and let the racer derive "<folder> <track>".
          const hint = (l.path || '').split(/[\\/]/).filter(Boolean).pop() || ''
          startPreview({ username, filename: f.fullPath, size: f.size || 0, artist: hint })
          return
        }
        // play: queue the download, then poll for the finished file
        btn.disabled = true; btn.textContent = '…'
        try {
          await window.api.slskDownload({ username, filename: f.fullPath, size: f.size || 0 })
          _scheduleLibRescan()
          const deadline = Date.now() + 120000
          const poll = async () => {
            if (Date.now() > deadline) { btn.textContent = '▶'; btn.disabled = false; return }
            // poll is called from setTimeout, so a rejection here was an
            // unhandled one and the button stayed '…' and disabled forever.
            let found
            try {
              found = await window.api.slskResolveFile({ username, filename: f.fullPath })
            } catch (_) {
              btn.textContent = '▶'; btn.disabled = false
              return
            }
            if (found?.path) {
              state.queue = [{ filePath: found.path, title: f.name, artist: username,
                               albumArtist: username, artPath: null,
                               albumName: l.path.split('\\').pop() || username, albumId: `slsk_lib_${username}` }]
              state.queueIndex = 0
              playCurrentTrack()
              btn.textContent = '▶'; btn.disabled = false
            } else setTimeout(poll, 3000)
          }
          setTimeout(poll, 3000)
        } catch (_) { btn.textContent = '▶'; btn.disabled = false }
      })
    })

    dlg.querySelector('#slskx-dl-folder')?.addEventListener('click', async ev => {
      const btn = ev.target
      const label = btn.textContent
      const files = l.files.filter(f => T.AUDIO_RE.test(f.name))
      btn.disabled = true
      btn.textContent = `Queuing ${files.length}…`
      // Without this, a throw left "Queuing N…" on a dead button forever.
      try {
        const res = await _slskEnqueue(files.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
        // A refusal used to still print "N queued" on a button that had
        // queued nothing. _slskEnqueue has already said why.
        if (!res || res.ok === false) { btn.disabled = false; btn.textContent = label; return }
        btn.textContent = `${res.added != null ? res.added : files.length} queued`
        _scheduleLibRescan()
      } catch (e) {
        btn.disabled = false
        btn.textContent = label
        showSnackbar('Could not queue the folder: ' + String(e && e.message || e), null, null, 6000)
      }
    })

    dlg.querySelector('#slskx-play-first')?.addEventListener('click', () => {
      const first = body.querySelector('.slskx-mini[data-act="play"]')
      if (first) first.click()
    })

    // Per-track checkboxes with shift-click range select, and the matching
    // "Download selected (N)" batch button — the same selection affordance the
    // album view offers, brought to the raw folder file list.
    const selBtn = dlg.querySelector('#slskx-dl-selected')
    const updateFolderSelUi = () => {
      if (selBtn) {
        const n = folderSel.size
        selBtn.textContent = n ? `Download selected (${n})` : 'Download selected'
        selBtn.disabled = !n
      }
      body.querySelectorAll('.slskx-file-cb').forEach(cb => {
        const i = parseInt(cb.dataset.fi, 10)
        cb.checked = folderSel.has(i)
        cb.closest('.slskx-row')?.classList.toggle('sel', folderSel.has(i))
      })
    }
    body.querySelectorAll('.slskx-file-cb').forEach(cb => {
      cb.addEventListener('click', e => {
        e.stopPropagation()
        const i = parseInt(cb.dataset.fi, 10)
        if (e.shiftKey && folderSelLast >= 0) {
          const [lo, hi] = [Math.min(i, folderSelLast), Math.max(i, folderSelLast)]
          for (let k = lo; k <= hi; k++) {
            // Only audio rows have checkboxes; guard on the file being audio.
            if (l.files[k] && T.AUDIO_RE.test(l.files[k].name)) {
              if (cb.checked) folderSel.add(k); else folderSel.delete(k)
            }
          }
        } else {
          if (cb.checked) folderSel.add(i); else folderSel.delete(i)
        }
        folderSelLast = i
        updateFolderSelUi()
      })
    })
    selBtn?.addEventListener('click', async ev => {
      const picks = [...folderSel].sort((x, y) => x - y).map(i => l.files[i]).filter(Boolean)
      if (!picks.length) return
      const btn = ev.currentTarget
      const label = btn.textContent
      btn.disabled = true; btn.textContent = `Queuing ${picks.length}…`
      try {
        const res = await _slskEnqueue(picks.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
        if (!res || res.ok === false) { btn.disabled = false; btn.textContent = label; return }
        _scheduleLibRescan()
        btn.textContent = `${res.added != null ? res.added : picks.length} queued`
        setTimeout(() => { folderSel.clear(); folderSelLast = -1; updateFolderSelUi() }, 1200)
      } catch (e) {
        btn.disabled = false; btn.textContent = label
        showSnackbar('Could not queue those tracks: ' + String(e && e.message || e), null, null, 6000)
      }
    })

    // "Audio only" is on by default, so a folder of artwork and logs showed
    // no rows at all and read as empty. The copy now says what is hidden and
    // this turns the filter off in place.
    dlg.querySelector('#slskx-show-hidden')?.addEventListener('click', () => {
      const cb = dlg.querySelector('#slskx-audio-only')
      if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')) }
    })

    dlg.querySelector('#slskx-dl-tree')?.addEventListener('click', async ev => {
      // Walk every descendant folder, not just this one -- the same audio set
      // the button's own label counts.
      const below = audioBelow(l.node)
      const files = below.files
      const btn = ev.target
      const label = btn.textContent
      if (!files.length) { showSnackbar('There is no audio below this folder'); return }
      // The root of a big peer holds thousands of files and terabytes. That is
      // not something to start on one click with no statement of what it is.
      await confirmSubtree(files.length, below.size, async () => {
        btn.disabled = true
        btn.textContent = `Queuing ${files.length}…`
        try {
          const res = await _slskEnqueue(files.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
          if (!res || res.ok === false) { btn.disabled = false; btn.textContent = label; return }
          btn.textContent = `${res.added != null ? res.added : files.length} queued`
          _scheduleLibRescan()
        } catch (e) {
          btn.disabled = false
          btn.textContent = label
          showSnackbar('Could not queue the tree: ' + String(e && e.message || e), null, null, 6000)
        }
      })
    })
  }

  // Grid-aware focus movement over the shop's album cards. Left/right step in
  // DOM order (which flows rails then grid); up/down move a row, with the column
  // count read from the cards' own geometry so it survives the responsive grid.
  // Rails scroll horizontally, the grid wraps — treating them as one ordered
  // list keeps a single mental model and one code path.
  function shMoveCardFocus(e) {
    const cards = Array.prototype.slice.call(shBody.querySelectorAll('.slsh-card:not(.slsh-skel)'))
    if (!cards.length) return
    const active = document.activeElement
    let index = cards.indexOf(active)
    if (index === -1) { cards[0].focus(); cards[0].scrollIntoView({ block: 'nearest', inline: 'nearest' }); e.preventDefault(); return }
    let next = index
    if (e.key === 'ArrowRight') next = Math.min(cards.length - 1, index + 1)
    else if (e.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else {
      const firstTop = cards[0].getBoundingClientRect().top
      let perRow = cards.findIndex(c => c.getBoundingClientRect().top > firstTop + 4)
      if (perRow <= 0) perRow = cards.length
      next = e.key === 'ArrowDown'
        ? Math.min(cards.length - 1, index + perRow)
        : Math.max(0, index - perRow)
    }
    if (next !== index) { cards[next].focus(); cards[next].scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
    e.preventDefault()
  }

  // Click a card's primary/secondary action from the keyboard.
  function shCardAction(card, sel) {
    const b = card && card.querySelector(sel)
    if (b) { b.click(); return true }
    return false
  }

  function onKey(e) {
    if (!document.getElementById('slsk-user-lib-modal')) return
    // An open album-view slide-over owns the keyboard: it runs a capture-phase
    // handler that stops propagation, so this rarely even fires while it is up —
    // but guard explicitly so nothing leaks through to the shop underneath.
    if (_slavPanel) return
    // Don't fight text entry: while a field is focused, only Escape (blur/clear)
    // is ours — mirrors the app's global keymap guard.
    const tag = String(e.target && e.target.tagName || '').toUpperCase()
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      (e.target && e.target.isContentEditable === true)
    if (e.key === 'Escape') {
      // Layered close: a focused field blurs first; then an active shelves
      // search clears; then the modal closes.
      if (typing) { try { e.target.blur() } catch (_) {} e.preventDefault(); return }
      if (mode === 'shelves' && shSearchQuery) {
        shSearchQuery = ''
        renderShelves()
        return
      }
      return close()
    }
    if (typing) return
    // Never override the app's own chords (Ctrl/Alt/Meta combos).
    if (e.ctrlKey || e.metaKey) return
    // Shelves-mode card keyboard nav: one delegated handler, no per-card
    // listeners. Enter plays, D downloads, arrows move the focus ring.
    if (mode === 'shelves') {
      if (e.key.startsWith('Arrow') && !e.altKey) { shMoveCardFocus(e); return }
      const card = document.activeElement && document.activeElement.classList &&
        document.activeElement.classList.contains('slsh-card') ? document.activeElement : null
      if (!card) return
      // Enter OPENS the album view (per the album-functionality brief); the DL/
      // Play/preview buttons still act via mouse/focus. D keeps the quick grab.
      if (e.key === 'Enter') {
        const a = shFlat[parseInt(card.dataset.idx, 10)]
        if (a) { openAlbumView(a); e.preventDefault() }
        return
      }
      if (e.key === 'd' || e.key === 'D') { if (shCardAction(card, '.slsh-dl')) e.preventDefault(); return }
      return
    }
    // Folder-tree keys apply only in Folders mode.
    if (mode !== 'folders') return
    if (document.activeElement === search) return
    if (e.key === 'Backspace' && hist.current) { e.preventDefault(); navTo(T.parentPath(hist.current)) }
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); hist.back(); render() }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); hist.forward(); render() }
  }
  document.addEventListener('keydown', onKey)

  dlg.querySelector('#slskx-back').addEventListener('click', () => { hist.back(); render() })
  dlg.querySelector('#slskx-fwd').addEventListener('click',  () => { hist.forward(); render() })
  dlg.querySelector('#slskx-up').addEventListener('click',   () => navTo(T.parentPath(hist.current)))
  dlg.querySelector('#slskx-surround').addEventListener('click', () => {
    surroundOnly = !surroundOnly
    searching = ''; search.value = ''
    dlg.querySelector('#slskx-surround').classList.toggle('active', surroundOnly)
    // The class was the only signal that the filter was on.
    dlg.querySelector('#slskx-surround').setAttribute('aria-pressed', surroundOnly ? 'true' : 'false')
    render()
  })
  dlg.querySelector('#slskx-sort').addEventListener('change', e => { sort = e.target.value; render() })
  dlg.querySelector('#slskx-audio-only').addEventListener('change', e => { audioOnly = e.target.checked; render() })
  let _st = null
  search.addEventListener('input', () => {
    clearTimeout(_st)
    _st = setTimeout(() => { searching = search.value.trim(); render() }, 180)
  })

  // ── The record shop (shelves mode) ─────────────────────────────────────────
  // A shelf is a horizontal rail of album cards. The parsing that fills them is
  // done in chunks (see the tail of this function) so a 100k-file tree never
  // freezes the paint; until it finishes, skeleton rails stand in.
  let shSearchQuery = ''
  let shParsing = true
  // Session-only shop sort/filter state for the Everything grid and the
  // search-within-library results. Not persisted (briefed: session-only fine).
  let shSort = 'az'
  const shFilters = new Set()   // any of 'lossless' | 'hires' | 'surround'
  let shDecade = ''             // decade start year as a string, '' = all
  // Cache provenance from slskBrowseUser (engine may send fromCache/cachedAt).
  // shJustRefreshed drives a brief "Updated just now" pulse after a background
  // refresh lands.
  let shFromCache = false
  let shCachedAt = 0
  let shJustRefreshed = false
  // Fingerprint of the browse payload the current tree/shelves were built from.
  // A background refresh whose payload fingerprints identically is content-
  // unchanged and skips the whole rebuild (the old path paid the full multi-
  // second build a second time for nothing).
  let shBrowseFp = null
  // Precomputed search indexes (lowercased once per library load) so a search
  // keystroke is a linear scan over ready strings, not a fresh toLowerCase walk
  // of the whole tree. Null until the background build lands; the render paths
  // fall back to the old direct scans while null.
  let shTreeSearchIndex = null
  let shAlbumHays = null
  let shAlbumByFolder = null
  // Build generation: bumped at every (re)build so chunked slices belonging to
  // a superseded build abort instead of racing the fresh one.
  let _buildGen = 0

  // Prefer the module's TB-aware formatter so the shop hero never shows a
  // four-digit unit ("6453.3 GB" → "6.3 TB"); fall back to the local one.
  function shFmtSize(n) { return fmtSize(n) }

  // Token-bucketed index over the library albums that HAVE cover art, so the
  // "does the local library already supply this cover?" test is a handful of
  // candidate comparisons instead of a full library scan. A tokenScore ≥ 0.6
  // match requires at least one shared album token, so scanning only the
  // buckets the peer album's own tokens point at finds exactly the matches the
  // old full scan did; candidates keep their library order so first-match-wins
  // is preserved. Built lazily once per library snapshot: the per-card render
  // AND the prefetch planner used to each pay the O(library) loop per album,
  // which on an 11k-album peer was a ~820ms single block.
  let _shLibArtIdx = null
  function shLibArtIndex() {
    const lib = state.library
    if (_shLibArtIdx && _shLibArtIdx.ref === lib && _shLibArtIdx.len === lib.length) return _shLibArtIdx
    const buckets = new Map()
    if (SH) {
      lib.forEach((l, order) => {
        if (!l.artPath) return
        for (const t of SH.normTokenSet(l.name)) {
          let arr = buckets.get(t)
          if (!arr) { arr = []; buckets.set(t, arr) }
          arr.push({ l, order })
        }
      })
    }
    _shLibArtIdx = { ref: lib, len: lib.length, buckets }
    return _shLibArtIdx
  }
  // The exact predicate the old scans used, over the bucketed candidates only.
  // Returns the first (library-order) matching album with art, or null.
  function shFindLocalArt(a) {
    if (!SH || !a || !a.album) return null
    const idx = shLibArtIndex()
    let best = null
    let bestOrder = Infinity
    const seen = new Set()
    for (const t of SH.normTokenSet(a.album)) {
      const arr = idx.buckets.get(t)
      if (!arr) continue
      for (const c of arr) {
        if (c.order >= bestOrder || seen.has(c.order)) continue
        seen.add(c.order)
        if (SH.tokenScore(a.album, c.l.name) >= 0.6 &&
            (!a.artist || !c.l.artist || SH.tokenScore(a.artist, c.l.artist) >= 0.34)) {
          best = c.l; bestOrder = c.order
        }
      }
    }
    return best
  }

  // Local-library art for a peer album, matched by album-name similarity. Reuses
  // the same file://-vs-http art helper and gradient fallback the library grid
  // uses, so streamed art and local paths both render correctly.
  function shAlbumArtHtml(a) {
    let artPath = null
    if (SH) {
      const m = shFindLocalArt(a)
      if (m) artPath = m.artPath
    }
    const hue = Math.abs([...(a.folderName || a.album || '')]
      .reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
    const grad = `background:linear-gradient(135deg,hsl(${hue},45%,18%),hsl(${(hue + 40) % 360},35%,11%))`
    const badges =
      (a.lossless ? '<span class="slsh-badge slsh-badge-lossless">LOSSLESS</span>' : '') +
      (a.isHiRes ? '<span class="slsh-badge slsh-badge-hires">HI-RES</span>' : '')
    if (artPath) {
      const src = /^https?:\/\//.test(artPath) ? artPath : `file://${artPath}`
      return `<div class="slsh-card-art">
        <img src="${esc(src)}" alt="" loading="lazy" decoding="async"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="slsh-card-art-fallback" style="display:none;${grad}">
          <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
        ${badges}</div>`
    }
    // No local match: fetch a real cover lazily when the card scrolls into view.
    // Carry the artist/album on the container for the IntersectionObserver; if
    // the session cache already has it, paint immediately (no fetch).
    const artKey = SH ? SH.normKey(`${a.artist} ${a.album}`) : `${a.artist} ${a.album}`.toLowerCase()
    const cached = shArtCache.get(artKey)
    const fetchable = ART_IPC && (a.album || a.artist)
    if (cached) {
      const src = /^https?:\/\//.test(cached) ? cached : `file://${cached}`
      return `<div class="slsh-card-art">
        <img src="${esc(src)}" alt="" loading="lazy" decoding="async"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="slsh-card-art-fallback" style="display:none;${grad}">
          <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
        ${badges}</div>`
    }
    return `<div class="slsh-card-art"${fetchable ? ` data-art-key="${esc(artKey)}" data-art-artist="${esc(a.artist || '')}" data-art-album="${esc(a.album || '')}"` : ''}>
      <div class="slsh-card-art-fallback" style="${grad}">
        <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
      ${badges}</div>`
  }

  // ── Lazy network cover art (art-by-name) ────────────────────────────────────
  // fetchAlbumArt({albumId, artist, album}) exists in preload → iTunes search by
  // artist+album, returns { artPath } (a cached jpg on disk). We reuse it for
  // shop cards that have no local-library cover: only for cards actually on
  // screen (IntersectionObserver), at small concurrency, with an in-memory
  // per-session cache keyed by normalised artist+album so repeats are free and
  // scrolling back never refetches. albumId is a stable synthetic key so the
  // on-disk cache is shared across sessions too.
  const ART_IPC = !!(window.api && window.api.fetchAlbumArt)
  const shArtCache = new Map()   // artKey → artPath | '' (miss)
  // Identities with a fetch in flight (via EITHER the on-screen observer or the
  // background prefetch), so the two paths never ask iTunes for the same cover
  // at once — the observer's visible-first job and the prefetch's shelf-order
  // sweep dedupe against this shared set.
  const shArtInProgress = new Set()
  let shArtObserver = null
  let shArtInflight = 0
  const SH_ART_MAX = 3
  const shArtQueue = []

  function shArmArtObserver(container) {
    // New cards just rendered → the key→els paint index is stale.
    shArtIndexInvalidate()
    if (!ART_IPC || typeof IntersectionObserver !== 'function') return
    if (!shArtObserver) {
      shArtObserver = new IntersectionObserver((ents) => {
        for (const ent of ents) {
          if (!ent.isIntersecting) continue
          const el = ent.target
          shArtObserver.unobserve(el)
          shArtEnqueue(el)
        }
      }, { root: shBody, rootMargin: '300px' })
    }
    container.querySelectorAll('.slsh-card-art[data-art-key]').forEach(el => {
      if (el.dataset.artArmed) return
      el.dataset.artArmed = '1'
      shArtObserver.observe(el)
    })
  }

  function shArtEnqueue(el) {
    shArtQueue.push(el)
    shArtPump()
  }
  function shArtPump() {
    if (shScrolling) return   // resume on the scroll lull (see the gate below)
    while (shArtInflight < SH_ART_MAX && shArtQueue.length) {
      const el = shArtQueue.shift()
      if (!el || !el.isConnected) continue
      shArtInflight++
      shArtFetchFor(el).finally(() => { shArtInflight--; shArtPump() })
    }
  }
  async function shArtFetchFor(el) {
    const key = el.dataset.artKey
    const artist = el.dataset.artArtist || ''
    const album = el.dataset.artAlbum || ''
    await shArtFetchIdentity(key, artist, album)
  }
  // Fetch one album-art identity and paint it. Shared by the on-screen observer
  // and the background prefetch. Idempotent: a cached result (hit OR recorded
  // miss) short-circuits, and an in-flight identity is not fetched twice.
  async function shArtFetchIdentity(key, artist, album) {
    if (!key) return
    if (shArtCache.has(key)) { const c = shArtCache.get(key); if (c) shArtPaint(key, c); return }
    if (shArtInProgress.has(key)) return
    shArtInProgress.add(key)
    // Stable synthetic albumId so the on-disk cache (keyed <albumId>.jpg) is
    // reused across sessions and across every card with the same identity.
    const albumId = 'slshart_' + key.replace(/[^a-z0-9]+/g, '_').slice(0, 60)
    try {
      const res = await window.api.fetchAlbumArt({ albumId, artist, album }).catch(() => null)
      // The art source is rate-limiting us. Keep hammering it and every later
      // fetch fails too, including the ones a shopper is actually looking at.
      // Stop the background sweep for the session; on-demand fetches for
      // visible cards still go out.
      if (res && res.throttled) { shArtPrefetchAbort = true; return }
      const artPath = res && res.artPath
      shArtCache.set(key, artPath || '')
      if (artPath) shArtPaint(key, artPath)
    } catch (_) { shArtCache.set(key, '') }
    finally { shArtInProgress.delete(key) }
  }
  // Scroll-quiet gate. Fetching and painting covers WHILE the shopper scrolls
  // is what made huge libraries lag: every landing ran a body-wide query and a
  // layout-forcing insert mid-frame (measured: 158ms avg frames on a 438-album
  // shop; 38ms with art off). All art work now waits for a 160ms scroll lull
  // and paints drain in small rAF batches with the bitmap pre-decoded.
  let shScrolling = false
  let shScrollSettle = null
  const shArtPaintQueue = []
  shBody.addEventListener('scroll', () => {
    shScrolling = true
    clearTimeout(shScrollSettle)
    shScrollSettle = setTimeout(() => {
      shScrolling = false
      shArtDrainPaints()
      shArtPump()
      if (shGridAppendPending) { shGridAppendPending = false; shGridAppend() }
    }, 160)
  }, { passive: true })
  function shArtDrainPaints() {
    if (shScrolling || !shArtPaintQueue.length) return
    requestAnimationFrame(() => {
      let n = 0
      // Time-budgeted: disk-cached covers resolve instantly, so hundreds can
      // queue at open — a fixed per-frame count still froze the page for ~10s
      // (measured: 47 long tasks, 10.6s blocked). 3ms of paint work per frame
      // keeps the open buttery no matter how full the cache is.
      const t0 = performance.now()
      while (shArtPaintQueue.length && (performance.now() - t0) < 3) {
        const q = shArtPaintQueue.shift()
        shArtPaintNow(q.key, q.artPath)
        n++
      }
      if (shArtPaintQueue.length) shArtDrainPaints()
    })
  }
  // Queue a paint; it lands immediately when idle, after the lull when not.
  function shArtPaint(key, artPath) {
    shArtPaintQueue.push({ key, artPath })
    shArtDrainPaints()
  }
  // Swap the fetched cover into every on-screen card with this identity.
  // key → [els] index, rebuilt lazily whenever the shelves re-render (the
  // rebuild marker is cleared by shArtIndexInvalidate below). A body-wide
  // querySelectorAll PER LANDED COVER was the open-freeze: with a warm disk
  // cache every cover lands instantly and each paint walked thousands of
  // nodes.
  let shArtElIndex = null
  function shArtIndexInvalidate() { shArtElIndex = null }
  function shArtElsFor(key) {
    if (!shArtElIndex) {
      shArtElIndex = new Map()
      shBody.querySelectorAll('.slsh-card-art[data-art-key]').forEach(el => {
        const k = el.dataset.artKey
        if (!shArtElIndex.has(k)) shArtElIndex.set(k, [])
        shArtElIndex.get(k).push(el)
      })
    }
    return shArtElIndex.get(key) || []
  }
  function shArtPaintNow(key, artPath) {
    const src = /^https?:\/\//.test(artPath) ? artPath : `file://${artPath}`
    shArtElsFor(key).forEach(el => {
      if (!el.isConnected) return
      if (el.querySelector('img')) return
      const fb = el.querySelector('.slsh-card-art-fallback')
      const img = document.createElement('img')
      // NOT loading='lazy': lazy defers the browser's own load/decode until
      // the card scrolls into view — putting decode cost back inside the
      // scroll. We already viewport-gate via the observer and pre-decode
      // below, so eager + pre-decoded is the smooth path.
      img.alt = ''; img.decoding = 'async'
      img.onerror = () => { img.remove(); if (fb) fb.style.display = 'flex' }
      img.src = src
      // decode() rasterises off the main thread so the insert below is
      // paint-ready — no mid-scroll decode stall, no layout flash. If the
      // shopper starts scrolling between decode and insert, requeue the
      // paint for the next lull instead of mutating mid-frame.
      const place = () => {
        if (!el.isConnected || el.querySelector('img')) return
        if (shScrolling) { el.dataset.artKey = key; shArtPaint(key, artPath); return }
        el.insertBefore(img, el.firstChild)
        if (fb) fb.style.display = 'none'
        // Once painted it is no longer a fetch target.
        delete el.dataset.artKey
      }
      if (img.decode) img.decode().then(place, () => {}) 
      else place()
    })
  }

  // ── Background cover prefetch (saved friends & cached browses) ───────────────
  // When the shop opens from a cached browse OR the peer is in the saved list,
  // the shopper is likely to keep scrolling, so we warm covers ahead of the
  // scroll instead of only fetching what's on screen. Priority order (via the
  // pure planner): Upgrades, then the first Missing rows, then everything in
  // shelf order. Concurrency 2, gentle gaps so iTunes isn't hammered, abortable
  // the instant the modal closes. Because fetchAlbumArt caches to disk under the
  // stable synthetic albumId, a SECOND open of the same friend is face-rich
  // immediately — the disk cache satisfies every fetch without a network hit.
  const PF = window.PapaSlskArtPrefetch
  let shArtPrefetchAbort = false
  let shArtPrefetchRunning = false
  const SH_ART_PREFETCH_MAX = 2
  async function shArtPrefetch() {
    if (!ART_IPC || !PF || !SH || shArtPrefetchRunning || shArtPrefetchAbort) return
    if (!shelves) return
    shArtPrefetchRunning = true
    try {
      // Let the shelves paint before the planner's one synchronous pass runs.
      await new Promise(r => setTimeout(r, 0))
      if (shArtPrefetchAbort || !dlg.isConnected) return
      // Local-library matches already show a cover — don't spend a fetch on
      // them. Served by the bucketed index (see shFindLocalArt): the old
      // per-album library scan made planning an ~820ms block on a big peer.
      const hasLocalArt = (a) => !!shFindLocalArt(a)
      const plan = PF.planArtPrefetch(shelves, {
        normKey: SH.normKey,
        hasLocalArt,
        // Skip identities the session already resolved (hit or recorded miss);
        // the disk cache still short-circuits the rest inside fetchAlbumArt.
        alreadyCached: (k) => !PF.shouldFetchArt(shArtCache, k),
      })
      let cursor = 0
      const worker = async () => {
        while (!shArtPrefetchAbort && cursor < plan.length) {
          const job = plan[cursor++]
          if (!job) break
          await shArtFetchIdentity(job.key, job.artist, job.album)
          if (shArtPrefetchAbort) break
          // Gentle spacing between requests (50-100ms jitter) so a long sweep
          // stays a background trickle, not a burst.
          await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 50)))
        }
      }
      const workers = []
      for (let i = 0; i < SH_ART_PREFETCH_MAX; i++) workers.push(worker())
      await Promise.all(workers)
    } catch (_) { /* prefetch is best-effort; never disrupt the shop */ }
    finally { shArtPrefetchRunning = false }
  }

  // One album card. `variant` tweaks the badge line: 'upgrade' shows the
  // yours/theirs quality pair, 'missing' shows a wishlist +.
  function shCardHtml(a, idx, variant) {
    const title = a.album || a.folderName || 'Unknown album'
    const artist = a.artist || ''
    const qual = SH ? SH.albumQualityLabel(a) : ''
    const meta = `${a.trackCount} track${a.trackCount !== 1 ? 's' : ''} · ${shFmtSize(a.totalSize)}`
    let badgeLine = ''
    if (variant === 'upgrade' && a.upgrade) {
      badgeLine = `<div class="slsh-card-upgrade">
        <span class="slsh-q-yours">Yours: ${esc(a.upgrade.yours || '—')}</span>
        <span class="slsh-q-arrow">→</span>
        <span class="slsh-q-theirs">Theirs: ${esc(a.upgrade.theirs || qual)}</span></div>`
    } else if (variant === 'missing') {
      badgeLine = `<div class="slsh-card-qual">${esc(qual)}</div>`
    } else {
      badgeLine = `<div class="slsh-card-qual">${esc(qual)}${a.inLibrary ? ' · <span class="slsh-inlib">In Library</span>' : ''}</div>`
    }
    const wishBtn = variant === 'missing'
      ? `<button class="slsh-card-act slsh-wish" data-idx="${idx}" title="Add to wishlist">＋</button>` : ''
    return `<div class="slsh-card" data-idx="${idx}" data-folder="${esc(a.folderPath)}" tabindex="0" role="button" aria-label="Open ${esc((a.artist ? a.artist + ' — ' : '') + (a.album || 'album'))}">
      ${shAlbumArtHtml(a)}
      <div class="slsh-card-title" title="${esc(title)}">${esc(title)}</div>
      <div class="slsh-card-artist" title="${esc(artist)}">${esc(artist)}${a.year ? ' · ' + a.year : ''}</div>
      ${badgeLine}
      <div class="slsh-card-meta">${esc(meta)}</div>
      <div class="slsh-card-actions">
        <button class="slsh-card-act slsh-preview" data-idx="${idx}" title="Preview — hear it before you download (races Soulseek vs YouTube)">⚡</button>
        <button class="slsh-card-act slsh-play" data-idx="${idx}" title="Download the first track and play">▶</button>
        <button class="slsh-card-act slsh-dl" data-idx="${idx}" title="Download this album (${a.trackCount})">⬇</button>
        <button class="slsh-card-act slsh-find" data-idx="${idx}" title="Find other sources for this album">⌕</button>
        ${wishBtn}
      </div>
      <div class="slsh-card-progress" data-folder="${esc(a.folderPath)}" style="display:none">
        <div class="slsh-card-progress-fill"></div><span class="slsh-card-progress-label"></span></div>
    </div>`
  }

  function shRailHtml(id, title, sub, albums, variant, headAction) {
    // Empty shelves hide entirely rather than rendering an empty rail.
    if (!albums || !albums.length) return ''
    const cards = albums.slice(0, 40).map(a => shCardHtml(a, a._idx, variant)).join('')
    return `<section class="slsh-rail" data-rail="${id}">
      <div class="slsh-rail-head">
        <span class="slsh-rail-title">${esc(title)}</span>
        <span class="slsh-rail-sub">${esc(sub || '')}</span>
        ${headAction || ''}
      </div>
      <div class="slsh-rail-track">${cards}</div>
    </section>`
  }

  // The changing half of the hero: the stats line and the cache provenance note.
  // Kept apart from the hero itself so a repaint can refresh the numbers without
  // going anywhere near the search box sitting below them.
  function shHeroMetaHtml() {
    const st = shelves ? shelves.stats : { albums: 0, tracks: 0, size: 0, losslessPct: 0, hiRes: 0, surround: 0 }
    const bits = [
      `${st.albums.toLocaleString()} album${st.albums !== 1 ? 's' : ''}`,
      `${st.tracks.toLocaleString()} track${st.tracks !== 1 ? 's' : ''}`,
      shFmtSize(st.size),
      `${st.losslessPct}% lossless`,
      st.hiRes ? `${st.hiRes} hi-res` : '',
      st.surround ? `${st.surround} surround` : '',
    ].filter(Boolean)
    // Cache provenance line: only when the browse came from cache. "just now"
    // pulse after a live background refresh replaces it.
    let cacheLine = ''
    if (shJustRefreshed) {
      cacheLine = '<div class="slsh-hero-cache slsh-hero-pulse">Updated just now</div>'
    } else if (shFromCache) {
      cacheLine = `<div class="slsh-hero-cache">from cache${shCachedAt ? ' · updated ' + _shAgo(shCachedAt) : ''}</div>`
    }
    return `<div class="slsh-hero-stats">${bits.map(b => `<span class="slsh-stat">${esc(b)}</span>`).join('<span class="slsh-stat-sep">·</span>')}</div>${cacheLine}`
  }

  function shHeroHtml() {
    return `<div class="slsh-hero">
      <div class="slsh-hero-meta" id="slsh-hero-meta">${shHeroMetaHtml()}</div>
      <input class="slsh-search" id="slsh-search" placeholder="Search ${esc(username)}'s albums and files…" autocomplete="off">
    </div>`
  }

  // Paint the shop: the hero, then whatever the caller wants underneath it.
  //
  // The hero holds the search box he types into, and every repaint used to
  // re-emit it — which destroyed that input mid-keystroke. The replacement was
  // repopulated from the TRIMMED query and had its caret forced to the end, so
  // typing "pink", pausing, then "floyd" gave him "pinkfloyd": the 160ms debounce
  // fired during the pause, the space was trimmed off with the rest of the value,
  // and the caret jumped to the end. A background browse refresh repaints too, so
  // it could happen while he was not typing at all.
  //
  // The hero is therefore built once and then left alone. Later paints replace
  // only what sits after it and refresh the stats in place; the input element,
  // its value and its selection are never touched again.
  function shPaint(bodyHtml) {
    const hero = shBody.querySelector('.slsh-hero')
    if (!hero) {
      shBody.innerHTML = shHeroHtml() + bodyHtml
      bindShHero()
      return
    }
    const meta = shBody.querySelector('#slsh-hero-meta')
    if (meta) meta.innerHTML = shHeroMetaHtml()
    while (hero.nextSibling) hero.parentNode.removeChild(hero.nextSibling)
    hero.insertAdjacentHTML('afterend', bodyHtml)
  }

  // "5m ago" / "just now" from a millisecond timestamp. Small and local — the
  // hero is the only caller.
  function _shAgo(ts) {
    const secs = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000))
    if (secs < 45) return 'just now'
    const mins = Math.round(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.round(hrs / 24)}d ago`
  }

  function shSkeletonHtml() {
    const card = '<div class="slsh-card slsh-skel"><div class="slsh-card-art slsh-skel-art"></div><div class="slsh-skel-line"></div><div class="slsh-skel-line short"></div></div>'
    const rail = (t) => `<section class="slsh-rail"><div class="slsh-rail-head"><span class="slsh-rail-title">${t}</span></div><div class="slsh-rail-track">${card.repeat(6)}</div></section>`
    return rail('Upgrades for you') + rail('You don\'t have these') + rail('Hi-Res')
  }

  // Index every album once so cards can reference back into a flat array shared
  // by all rails and the grid; the click handlers read data-idx.
  let shFlat = []
  function shReindex() {
    shFlat = peerAlbums || []
    shFlat.forEach((a, i) => { a._idx = i })
  }

  function renderShelves() {
    if (shParsing || !shelves) {
      shPaint(`<div class="slsh-rails">${shSkeletonHtml()}</div>`)
      return
    }
    if (shSearchQuery) return renderShelvesSearch()

    const grabAll = shelves.upgrades.length
      ? `<button class="slsh-grab-all" id="slsh-grab-all" title="Download every upgrade in this shelf">⬇ Grab all ${shelves.upgrades.length} upgrade${shelves.upgrades.length !== 1 ? 's' : ''}</button>`
      : ''
    // Only rendered when the engine actually sent newDirs; shRailHtml hides an
    // empty shelf on its own, so an engine without the field changes nothing.
    const fresh = shNewAlbums()
    const rails =
      shRailHtml('new', 'New since last visit',
        `${fresh.length} added since you were last here`, fresh, 'plain') +
      shRailHtml('upgrades', 'Upgrades for you',
        `${shelves.upgrades.length} better than your copies`, shelves.upgrades, 'upgrade', grabAll) +
      shRailHtml('missing', 'You don\'t have these',
        `${shelves.missing.length} not in your library`, shelves.missing, 'missing') +
      shRailHtml('surround', 'Surround',
        `${shelves.surround.length} multichannel`, shelves.surround, 'plain') +
      shRailHtml('hires', 'Hi-Res',
        `${shelves.hires.length} at 24-bit or 88.2kHz+`, shelves.hires, 'plain')

    const emptyRails = !rails
      ? '<div class="slsh-empty">No albums could be read from this library. Try Folders mode for the raw file tree.</div>'
      : ''

    shPaint(
      `<div class="slsh-rails">${rails}${emptyRails}</div>` +
      `<div class="slsh-grid-wrap" id="slsh-grid-wrap"></div>`)
    shRenderGrid()
    bindShCards(shBody)
    shBindGrabAll()
    shArmArtObserver(shBody)
  }

  // "Grab all N upgrades": confirm with the album list, then enqueue every
  // upgrade album's files through the same per-card path (shAsGroup → _slskEnqueue
  // → inline progress). One snackbar summary at the end.
  function shBindGrabAll() {
    const btn = dlg.querySelector('#slsh-grab-all')
    if (!btn) return
    btn.addEventListener('click', () => {
      const ups = (shelves && shelves.upgrades) || []
      if (!ups.length) return
      const listHtml = '<ul class="slsh-grab-list">' + ups.slice(0, 40).map(a =>
        `<li>${esc(a.artist ? a.artist + ' — ' : '')}${esc(a.album || a.folderName)}` +
        `${a.upgrade ? ` <span class="slsh-grab-q">${esc(a.upgrade.yours || '—')} → ${esc(a.upgrade.theirs || '')}</span>` : ''}</li>`
      ).join('') + (ups.length > 40 ? `<li>…and ${ups.length - 40} more</li>` : '') + '</ul>'
      const totalFiles = ups.reduce((n, a) => n + ((a.files && a.files.length) || 0), 0)
      _mgConfirm(
        `Grab all ${ups.length} upgrade${ups.length !== 1 ? 's' : ''}?`,
        `<p>This queues <strong>${totalFiles}</strong> file${totalFiles !== 1 ? 's' : ''} across ${ups.length} album${ups.length !== 1 ? 's' : ''} from ${esc(username)}. Each shows its own progress on its card.</p>${listHtml}`,
        `Download ${ups.length}`,
        async () => {
          let queued = 0
          let refusal = ''
          for (const a of ups) {
            const g = shAsGroup(a)
            if (!g.files.length) continue
            try {
              const res = await _slskEnqueue(g.files.map(f => ({ username, filename: f.filename, size: f.size })))
              // Not throwing is not the same as being accepted. Only an
              // explicit ok counts towards "Queued N upgrades".
              if (!res || res.ok === false) {
                if (!refusal) refusal = (res && res.error) || ''
                continue
              }
              _slskCardDownloads.set(_slskCardKey(username, a.folderName), { total: g.files.length })
              shTrackProgress(a)
              queued++
            } catch (_) { /* keep going; one bad album must not abort the batch */ }
          }
          if (queued) _scheduleLibRescan()
          showSnackbar(queued
            ? `Queued ${queued} upgrade${queued !== 1 ? 's' : ''} from ${username}`
            : (refusal || 'Could not queue those upgrades'))
        }
      )
    })
  }

  function renderShelvesSearch() {
    const q = shSearchQuery
    const ql = q.toLowerCase()
    // Album matches by parsed artist/album/folder. The precomputed haystacks
    // (lowercased once per library load) make a keystroke pass a linear scan;
    // until they land, fall back to the on-the-fly filter.
    let albumHits
    if (shAlbumHays && shAlbumHays.length === shFlat.length) {
      albumHits = []
      for (let i = 0; i < shFlat.length; i++) {
        if (shAlbumHays[i].includes(ql)) albumHits.push(shFlat[i])
      }
    } else {
      albumHits = shFlat.filter(a => {
        const hay = `${a.artist} ${a.album} ${a.folderName}`.toLowerCase()
        return hay.includes(ql)
      })
    }
    // Raw filename hits → resolve to the album the file lives in, if any. Same
    // searchTree contract, served from the precomputed index when it is ready
    // (the per-keystroke toLowerCase walk of 140k names was the 2.4s freeze).
    const fileHits = (shTreeSearchIndex && SH && SH.searchTreeIndex)
      ? SH.searchTreeIndex(shTreeSearchIndex, q, 120).filter(h => h.type === 'file')
      : T.searchTree(tree, q, 120).filter(h => h.type === 'file')
    const extraFolders = new Set(albumHits.map(a => a.folderPath.toLowerCase()))
    for (const h of fileHits) {
      const owner = shAlbumByFolder
        ? shAlbumByFolder.get(String(h.path).toLowerCase())
        : shFlat.find(a => a.folderPath.toLowerCase() === String(h.path).toLowerCase())
      if (owner && !extraFolders.has(owner.folderPath.toLowerCase())) {
        albumHits.push(owner); extraFolders.add(owner.folderPath.toLowerCase())
      }
    }
    // The same shop sort/filter chips apply to search results.
    const SF = window.PapaSlskFilters
    const shown = (SF && SF.applyShelfFilterSort)
      ? SF.applyShelfFilterSort(albumHits, { filters: shFilters, decade: shDecade, sort: shSort })
      : albumHits
    const cards = shown.slice(0, 120).map(a => shCardHtml(a, a._idx, a.inLibrary ? 'plain' : 'missing')).join('')
    shPaint(
      `<div class="slsh-search-results">
        <div class="slsh-rail-head"><span class="slsh-rail-title">Results for “${esc(q)}”</span>
          <span class="slsh-rail-sub">${shown.length} album${shown.length !== 1 ? 's' : ''}</span></div>
        ${shControlsHtml()}
        <div class="slsh-grid">${cards || '<div class="slsh-empty">Nothing matching that.</div>'}</div>
      </div>`)
    bindShCards(shBody)
    shBindShelfControls()
    shArmArtObserver(shBody)
  }

  // Called once, when the hero is first built — shPaint keeps the input alive
  // across every later repaint, so nothing here runs again while he is typing.
  // Seeding the value and placing the caret is therefore a restore (reopening
  // the shop with a query already set), not something done mid-keystroke.
  //
  // `shSearchQuery` is trimmed because a trailing space means nothing to the
  // search. The box itself is never written back from it: that is what swallowed
  // the space between two words.
  function bindShHero() {
    const si = dlg.querySelector('#slsh-search')
    if (!si) return
    si.value = shSearchQuery
    let t = null
    si.addEventListener('input', () => {
      clearTimeout(t)
      t = setTimeout(() => { shSearchQuery = si.value.trim(); renderShelves() }, 160)
    })
    if (shSearchQuery) { si.focus(); si.setSelectionRange(si.value.length, si.value.length) }
  }

  // The Everything grid: alphabetical by artist with sticky letter headers,
  // rendered in slices so a huge collection paints instantly. Mirrors the
  // library grid's chunk-and-observe pattern.
  const SLSH_CHUNK = 120
  let shGridGroups = []
  let shGridRendered = 0
  let shGridObserver = null
  // Is the grid in its plain, default A–Z / no-filter state? Only then do the
  // sticky letter headers make sense; any active sort or filter flattens it.
  function shGridIsPlain() {
    return shSort === 'az' && shFilters.size === 0 && !shDecade
  }

  // The compact control row: sort dropdown + Lossless/Hi-Res/Surround chips +
  // a Decade dropdown built from the years actually parsed. Applies to the
  // Everything grid and to search-within-library.
  function shControlsHtml() {
    const SF = window.PapaSlskFilters
    const decades = (SF && SF.shelfDecades) ? SF.shelfDecades(shelves.everything) : []
    const chip = (k, label) =>
      `<button class="slsh-chip${shFilters.has(k) ? ' active' : ''}" data-shfilter="${k}">${label}</button>`
    return `<div class="slsh-controls" id="slsh-controls">
      <label class="slsh-ctl-sort">Sort
        <select id="slsh-sort">
          ${[['quality', 'Quality'], ['year', 'Year'], ['size', 'Size'], ['az', 'A–Z']]
            .map(([v, l]) => `<option value="${v}"${shSort === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <div class="slsh-chips">
        ${chip('lossless', 'Lossless')}${chip('hires', 'Hi-Res')}${chip('surround', 'Surround')}
      </div>
      ${decades.length ? `<label class="slsh-ctl-decade">Decade
        <select id="slsh-decade">
          <option value="">All</option>
          ${decades.map(d => `<option value="${esc(d.value)}"${shDecade === d.value ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
        </select>
      </label>` : ''}
    </div>`
  }

  function shRenderGrid() {
    const wrap = dlg.querySelector('#slsh-grid-wrap')
    if (!wrap || !SH) return
    const SF = window.PapaSlskFilters
    const plain = shGridIsPlain()
    // Flatten to a render list of {header}|{album} for slicing. In plain mode we
    // keep the sticky letter headers; once any control is active we show one
    // flat, filtered+sorted grid (letters would be meaningless under Year/Size).
    shGridFlat = []
    let count
    if (plain) {
      shGridGroups = SH.groupByLetter(shelves.everything)
      for (const g of shGridGroups) {
        shGridFlat.push({ header: g.letter })
        for (const a of g.albums) shGridFlat.push({ album: a })
      }
      count = shelves.everything.length
    } else {
      const filtered = (SF && SF.applyShelfFilterSort)
        ? SF.applyShelfFilterSort(shelves.everything, { filters: shFilters, decade: shDecade, sort: shSort })
        : shelves.everything
      for (const a of filtered) shGridFlat.push({ album: a })
      count = filtered.length
    }
    shGridRendered = 0
    wrap.innerHTML = `<div class="slsh-rail-head slsh-grid-head"><span class="slsh-rail-title">Everything</span>
      <span class="slsh-rail-sub">${count} album${count !== 1 ? 's' : ''}</span></div>
      ${shControlsHtml()}
      <div class="slsh-grid" id="slsh-grid"></div>
      <div class="slsh-grid-sentinel" id="slsh-grid-more" aria-hidden="true"></div>`
    shBindShelfControls()
    if (!shGridFlat.length) {
      const grid = dlg.querySelector('#slsh-grid')
      if (grid) grid.innerHTML = '<div class="slsh-empty">No albums match those filters.</div>'
      const more = dlg.querySelector('#slsh-grid-more'); if (more) more.style.display = 'none'
      return
    }
    shGridAppend()
  }

  // Wire the shop control row. Rebuilds the grid (or the search view) in place.
  function shBindShelfControls() {
    const ctl = dlg.querySelector('#slsh-controls')
    if (!ctl || ctl.dataset.bound) return
    ctl.dataset.bound = '1'
    ctl.querySelector('#slsh-sort')?.addEventListener('change', e => {
      shSort = e.target.value; shReRenderResults()
    })
    ctl.querySelector('#slsh-decade')?.addEventListener('change', e => {
      shDecade = e.target.value; shReRenderResults()
    })
    ctl.querySelectorAll('[data-shfilter]').forEach(b =>
      b.addEventListener('click', () => {
        const k = b.dataset.shfilter
        if (shFilters.has(k)) shFilters.delete(k); else shFilters.add(k)
        shReRenderResults()
      }))
  }

  // Repaint whichever surface the controls belong to: the search view when a
  // search is active, else the Everything grid.
  function shReRenderResults() {
    if (shSearchQuery) renderShelvesSearch()
    else shRenderGrid()
  }
  let shGridFlat = []
  let shGridAppendPending = false
  function shGridAppend() {
    const grid = dlg.querySelector('#slsh-grid')
    if (!grid) return
    // Parsing 120 cards of HTML mid-scroll is a frame-killer; wait for the
    // lull (the scroll gate above re-calls us). The 600px sentinel margin
    // means the shopper still never sees the bottom edge.
    if (shScrolling) { shGridAppendPending = true; return }
    const slice = shGridFlat.slice(shGridRendered, shGridRendered + SLSH_CHUNK)
    const html = slice.map(item => item.header != null
      ? `<div class="slsh-letter" data-letter="${esc(item.header)}">${esc(item.header)}</div>`
      : shCardHtml(item.album, item.album._idx, item.album.inLibrary ? 'plain' : 'missing')).join('')
    grid.insertAdjacentHTML('beforeend', html)
    shGridRendered += slice.length
    bindShCards(grid)
    shArmArtObserver(grid)
    shArmGridObserver()
  }
  function shArmGridObserver() {
    const more = dlg.querySelector('#slsh-grid-more')
    if (shGridObserver) { shGridObserver.disconnect(); shGridObserver = null }
    if (!more) return
    if (shGridRendered >= shGridFlat.length) { more.style.display = 'none'; return }
    if (typeof IntersectionObserver !== 'function') { while (shGridRendered < shGridFlat.length) shGridAppend(); return }
    shGridObserver = new IntersectionObserver(ents => {
      if (ents.some(e => e.isIntersecting)) shGridAppend()
    }, { root: shBody, rootMargin: '600px' })
    shGridObserver.observe(more)
  }

  // Turn a parsed album into the {username, folderName, files} shape the shared
  // download/play helpers expect. The peer's files carry `fullPath` (built by
  // slsk-tree), which is what slskd needs to request the transfer.
  function shAsGroup(a) {
    return {
      username,
      folderName: a.folderName,
      folderPath: a.folderPath,
      files: a.files.map(f => ({
        filename: f.fullPath || f.filename, size: f.size || 0,
        isFlac: SH ? SH.isLosslessName(f.name || f.filename) : /\.flac$/i.test(f.name || f.filename),
        bitDepth: f.bitDepth, sampleRate: f.sampleRate, bitRate: f.bitRate,
      })),
    }
  }

  // Download the chosen (best) track of an album, then play it once it lands on
  // disk. Same shape as the explorer's own play-poll handler — filenames use the
  // peer's fullPath, resolve is polled with a deadline, transfers are watched so
  // a failed transfer aborts the wait instead of hanging for the full timeout.
  async function shDownloadAndPlay(btn, g, targetFile, album) {
    const orig = btn.textContent
    btn.disabled = true; btn.textContent = '…'
    const title = (targetFile.filename || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '')
    const play = (filePath) => {
      state.queue = [{ filePath, title, artist: (album && album.artist) || username,
        albumArtist: (album && album.artist) || username, artPath: null,
        albumName: (album && album.album) || g.folderName, albumId: `slsh_${username}_${g.folderName}` }]
      state.queueIndex = 0
      playCurrentTrack()
    }
    try {
      const existing = await window.api.slskResolveFile({ username, filename: targetFile.filename }).catch(() => null)
      if (existing && existing.path) { play(existing.path); btn.textContent = orig; btn.disabled = false; return }
      await window.api.slskDownload({ username, filename: targetFile.filename, size: targetFile.size || 0 })
      _scheduleLibRescan()
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const res = await window.api.slskResolveFile({ username, filename: targetFile.filename }).catch(() => null)
        if (res && res.path) { play(res.path); break }
        const raw = await window.api.slskGetTransfers().catch(() => [])
        const hit = raw.flatMap(u => (u.directories || []).flatMap(d => d.files || []))
          .find(f => f.filename === targetFile.filename)
        if (hit && hit.state && /Failed|Aborted|Cancelled/.test(hit.state)) break
      }
    } catch (_) {}
    btn.textContent = orig; btn.disabled = false
  }

  // Delegated card handlers (one listener per container, not per card — soak
  // listener budget). Reuses the existing enqueue, wishlist and folder-search
  // code paths rather than duplicating them.
  function bindShCards(container) {
    if (container.dataset.shBound) return
    container.dataset.shBound = '1'
    container.addEventListener('click', async e => {
      const btn = e.target.closest('.slsh-card-act')
      if (!btn) {
        // A click on the card BODY (not an action button) opens the album view —
        // the card becomes a first-class, openable album.
        const card = e.target.closest('.slsh-card:not(.slsh-skel)')
        if (card) {
          const a = shFlat[parseInt(card.dataset.idx, 10)]
          if (a) openAlbumView(a)
        }
        return
      }
      e.stopPropagation()
      const a = shFlat[parseInt(btn.dataset.idx, 10)]
      if (!a) return
      const g = shAsGroup(a)
      if (btn.classList.contains('slsh-preview')) {
        const sorted = [...g.files].sort((x, y) => (y.isFlac ? 1 : 0) - (x.isFlac ? 1 : 0))
        if (sorted[0]) {
          // No explicit title: the first track's filename is the real song, so
          // let the racer derive "<artist> <track>" from it (better than the
          // album name for a YouTube match and for the pill label).
          startPreview({ username, filename: sorted[0].filename, size: sorted[0].size,
            artist: a.artist || '' })
        }
      } else if (btn.classList.contains('slsh-play')) {
        const sorted = [...g.files].sort((x, y) => (y.isFlac ? 1 : 0) - (x.isFlac ? 1 : 0))
        if (sorted[0]) {
          await shDownloadAndPlay(btn, g, sorted[0], a)
          _slskEnqueue(sorted.slice(1).map(f => ({ username, filename: f.filename, size: f.size })))
        }
      } else if (btn.classList.contains('slsh-dl')) {
        const orig = btn.textContent
        btn.disabled = true; btn.textContent = '…'
        try {
          await _slskEnqueue(g.files.map(f => ({ username, filename: f.filename, size: f.size })))
          _scheduleLibRescan()
          _slskCardDownloads.set(_slskCardKey(username, a.folderName), { total: g.files.length })
          btn.textContent = '✓'
          shTrackProgress(a)
        } catch (_) { btn.disabled = false; btn.textContent = orig }
      } else if (btn.classList.contains('slsh-find')) {
        close(); navigate('search', a.album || a.folderName)
      } else if (btn.classList.contains('slsh-wish')) {
        const q = `${a.artist} ${a.album}`.trim() || a.folderName
        const w = wishlistAdd(q)
        btn.textContent = '✓'; btn.disabled = true
        showSnackbar(w.added ? `Added “${q}” to your wishlist` : `“${q}” is already on your wishlist`)
      }
    })
    // Right-click a missing card to wishlist it, too.
    container.addEventListener('contextmenu', e => {
      const card = e.target.closest('.slsh-card')
      if (!card) return
      const a = shFlat[parseInt(card.dataset.idx, 10)]
      if (!a || a.inLibrary) return
      e.preventDefault()
      const q = `${a.artist} ${a.album}`.trim() || a.folderName
      // Right-clicking the same card twice used to make two identical entries.
      const w = wishlistAdd(q)
      showSnackbar(w.added ? `Added “${q}” to your wishlist` : `“${q}” is already on your wishlist`)
    })
  }

  // Paint inline download progress on a card by reading the same downloads-poll
  // data the search cards use (_slskCardProgress via _dlLastFiles). No new poll:
  // just repaint on a short timer while the strip is visible.
  const shProgTimers = new Set()
  function shTrackProgress(a) {
    const key = _slskCardKey(username, a.folderName)
    if (shProgTimers.has(key)) return
    shProgTimers.add(key)
    const tick = () => {
      if (!dlg.isConnected) { shProgTimers.delete(key); return }
      const prog = _slskCardProgress(shAsGroup(a))
      const strips = shBody.querySelectorAll(`.slsh-card-progress[data-folder="${CSS.escape(a.folderPath)}"]`)
      strips.forEach(strip => {
        if (!prog) { strip.style.display = 'none'; return }
        strip.style.display = ''
        strip.querySelector('.slsh-card-progress-fill').style.width = prog.pct + '%'
        strip.querySelector('.slsh-card-progress-label').textContent = prog.complete ? 'Done' : prog.pct + '%'
      })
      if (prog && prog.complete) { shProgTimers.delete(key); return }
      setTimeout(tick, 2000)
    }
    setTimeout(tick, 800)
  }

  // Message this user (roadmap #55): opens the renderer's chat panel straight
  // into this peer's thread. Feature-detected — hidden when the build has no
  // chat contract (openSlskChat only wired when window.api.slskChatSend exists),
  // so the explorer never shows a dead button.
  const msgBtn = dlg.querySelector('#slskx-msg')
  if (msgBtn) {
    if (typeof openSlskChat === 'function') {
      msgBtn.addEventListener('click', () => { try { openSlskChat(username) } catch (_) {} })
    } else {
      msgBtn.style.display = 'none'
    }
  }

  const starBtn = dlg.querySelector('#slskx-star')
  let savedList = await window.api.slskSavedUsers().catch(() => [])
  function paintStar() {
    const on = window.PapaSavedUsers.isSaved(savedList, username)
    starBtn.textContent = on ? '★' : '☆'
    starBtn.classList.toggle('on', on)
    starBtn.title = on ? 'Saved — click to remove' : 'Save this library for later'
  }
  paintStar()
  starBtn.addEventListener('click', async () => {
    const on = window.PapaSavedUsers.isSaved(savedList, username)
    savedList = on
      ? await window.api.slskUnsaveUser({ username })
      : await window.api.slskSaveUser({ username,
          fileCount: tree ? tree.fileCount : null,
          dirCount: tree ? tree.dirs.size : null })
    paintStar()
    showSnackbar(on ? `Removed ${username}` : `Saved ${username}'s library`)
  })

  // Pull the library in slices instead of one enormous reply. Handing the whole
  // tree across the process boundary at once was measured at 1.8 s of frozen
  // window on a large share (114 MB: 594 ms to serialise, 1,208 ms to
  // deserialise), none of it interruptible. Pulling gives backpressure, lets the
  // percentage move honestly, and makes closing the dialog mean "stop asking".
  // Falls back to the single-shot call on an engine without the new handlers.
  // Subscribed BEFORE the pull, not after it. The pull now takes seconds where
  // the old single-shot call took one round trip, and slsk-browse-begin kicks a
  // background refresh on a cache hit — so a fast refresh could land while there
  // was nobody listening, and the shop showed stale data for a whole cycle.
  // Seamless background refresh (engine contract): when a fresh browse for THIS
  // user lands, re-fetch and rebuild while preserving scroll, mode and search
  // text, with an "Updated just now" pulse. Feature-detected — an engine without
  // the event simply never fires this.
  let _offBrowseRefreshed = null
  if (window.api && typeof window.api.onSlskBrowseRefreshed === 'function') {
    _offBrowseRefreshed = window.api.onSlskBrowseRefreshed(async (evt) => {
      if (!dlg.isConnected) return
      if (!evt || String(evt.username || '') !== String(username)) return
      try {
        const fresh = await window.api.slskBrowseUser({ username, noCache: true }).catch(() => null)
        if (!fresh || !fresh.ok || !dlg.isConnected) return
        // W-S2: fingerprint the fresh payload first. Identical content means
        // the multi-second rebuild would reproduce exactly what is on screen —
        // skip it entirely and only freshen the provenance line in place.
        let freshFp = null
        if (SH && SH.fingerprintBrowseChunked) {
          freshFp = await SH.fingerprintBrowseChunked(fresh.directories || [],
            { shouldAbort: () => !dlg.isConnected }).catch(() => null)
        }
        if (!dlg.isConnected) return
        if (freshFp && shBrowseFp && freshFp === shBrowseFp) {
          shFromCache = !!fresh.fromCache
          shCachedAt = Number(fresh.cachedAt) || Date.now()
          const hero = shBody.querySelector('.slsh-hero-cache')
          if (hero) {
            hero.classList.remove('slsh-hero-pulse')
            hero.textContent = shFromCache && shCachedAt
              ? 'from cache · updated ' + _shAgo(shCachedAt) : ''
          }
          return
        }
        shBrowseFp = freshFp
        shFromCache = !!fresh.fromCache
        shCachedAt = Number(fresh.cachedAt) || Date.now()
        shJustRefreshed = true
        tree = (SH && SH.buildTreeChunked)
          ? await SH.buildTreeChunked(fresh.directories || [], { shouldAbort: () => !dlg.isConnected })
          : T.buildTree(fresh.directories || [])
        if (!tree || !dlg.isConnected) return
        await buildFromTree({ refresh: true })
      } catch (_) { /* a failed refresh must never disrupt the open shop */ }
    })
  }

  const streaming = !!(window.api.slskBrowseBegin && SH && SH.createTreeBuilder)
  const res = streaming
    ? await window.api.slskBrowseBegin({ username })
    : await window.api.slskBrowseUser({ username })
  if (!res.ok) {
    // Say what actually happened (R15). A peer who is offline cannot be
    // browsed, and the raw "slskd 404 on GET …" said nothing about that; the
    // presence lookup the card already makes answers it.
    let online = null
    try {
      if (window.api.slskUserStatus) {
        const st = await window.api.slskUserStatus({ username })
        if (st) online = !!(st.online || st.presence === 'Online' || st.status === 'Online')
      }
    } catch (_) { online = null }
    body.innerHTML = `<div class="slsk-lib-empty">${esc(browseFailureText(username, res.error, online))}</div>`
    return
  }
  // Engine may serve a cached browse and refresh in the background; feature-
  // detect both fields so an engine without them behaves exactly as before.
  shFromCache = !!res.fromCache
  shCachedAt = Number(res.cachedAt) || 0
  shNoteNewDirs(res)
  // Chunked, time-sliced build (SH.buildTreeChunked) so a 140k-file library
  // never blocks the main thread; the existing loading line doubles as the
  // progress affordance. Falls back to the sync build if the module is old.
  if (streaming) {
    const loadingEl = body.querySelector('.slsk-lib-loading')
    const treeBuilder = SH.createTreeBuilder()
    const total = Number(res.dirCount) || 0
    let pulled = 0
    try {
      for (let off = 0; off < total; off += 400) {
        // Closing the dialog is simply "stop asking" — no cancellation protocol
        // needed, which is the other reason this pulls rather than being pushed.
        if (!dlg.isConnected) return
        const slice = await window.api.slskBrowseChunk({ token: res.token, offset: off, limit: 400 })
        // An expired token must not read as "the library ends here".
        if (!slice || !slice.ok) {
          if (slice && slice.expired && loadingEl && loadingEl.isConnected) {
            loadingEl.textContent = 'That browse timed out — open it again.'
            loadingEl.classList.remove('indeterminate')
          }
          return
        }
        treeBuilder.add(slice.directories || [])
        pulled += (slice.directories || []).length
        if (loadingEl && loadingEl.isConnected && total) {
          shLoadingProgress(loadingEl, `Loading ${username}'s library…`, (pulled / total) * 100)
        }
      }
    } finally {
      // main hashed the payload in the background while we were pulling, and
      // hands the result back here. The renderer no longer has the payload to
      // fingerprint itself, and must not — that hash is ~100 ms of work.
      try {
        const endReply = await window.api.slskBrowseEnd({ token: res.token })
        if (endReply && endReply.fingerprint && dlg.isConnected) shBrowseFp = endReply.fingerprint
        shNoteNewDirs(endReply)
      } catch (_) {}
    }
    if (!dlg.isConnected) return
    tree = treeBuilder.finish()
  } else if (SH && SH.buildTreeChunked) {
    const loadingEl = body.querySelector('.slsk-lib-loading')
    tree = await SH.buildTreeChunked(res.directories || [], {
      shouldAbort: () => !dlg.isConnected,
      onProgress: (done, total) => {
        if (loadingEl && loadingEl.isConnected && total) {
          shLoadingProgress(loadingEl, `Loading ${username}'s library…`, (done / total) * 100)
        }
      },
    })
    if (!tree || !dlg.isConnected) return
    if (SH.fingerprintBrowseChunked) {
      SH.fingerprintBrowseChunked(res.directories || [], { shouldAbort: () => !dlg.isConnected })
        .then(fp => { if (fp && dlg.isConnected) shBrowseFp = fp })
        .catch(() => {})
    }
  } else {
    tree = T.buildTree(res.directories || [])
  }
  // Skip past a single wrapper folder so the first view is useful, not one row.
  let start = ''
  for (let i = 0; i < 3; i++) {
    const l = T.listDir(tree, start, { audioOnly })
    if (l && l.dirs.length === 1 && !l.files.length) start = l.dirs[0].path
    else break
  }
  if (start) hist.go(start)

  // Paint immediately: shelves shows hero + skeleton rails, folders shows the
  // tree. The album parse then runs in idle slices so a 100k-file tree never
  // blocks the main thread. When it finishes, the real shelves swap in.
  applyMode()
  // Shelves mode used to leave focus on the opener behind the modal, so Tab
  // walked the page underneath and Escape was the only key that reached it.
  if (mode === 'folders') search.focus()
  else (dlg.querySelector('#slsk-lib-close') || dlg).focus()

  // Parse the current `tree` into albums+shelves off the paint thread, then swap
  // the real shelves in. Named (not an inline IIFE) so a background refresh can
  // re-run it against a freshly rebuilt tree. `opts.refresh` preserves the shop's
  // scroll, mode and search when a background update lands.
  async function buildFromTree(opts) {
    const refresh = !!(opts && opts.refresh)
    // Every build claims a generation; slices of a superseded build (a newer
    // refresh landed, or the modal closed) abort instead of racing it.
    const gen = ++_buildGen
    const dead = () => gen !== _buildGen || !dlg.isConnected
    // Remember the scroll so a seamless refresh doesn't jump the user.
    const prevScroll = refresh ? shBody.scrollTop : 0
    // The search indexes describe the OLD tree from here on — drop them so the
    // search paths fall back to direct scans until the fresh ones land.
    shTreeSearchIndex = null; shAlbumHays = null; shAlbumByFolder = null
    try {
      // Yield once before starting so the skeleton is on screen first.
      await new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 500 }) : setTimeout(r, 1)))
      if (dead()) return
      // Chunked, time-sliced album parse (falls back to the sync walk on an old
      // shelves module).
      peerAlbums = (SH && SH.extractAlbumsChunked)
        ? await SH.extractAlbumsChunked(tree, { minTracks: 2, shouldAbort: dead })
        : (SH ? SH.extractAlbums(tree, { minTracks: 2 }) : [])
      if (dead() || !peerAlbums) return
      const detectSurround = window.PapaSlskFilters && window.PapaSlskFilters.detectSurround
      if (SH && SH.buildShelvesChunked) {
        // Chunked classification. markInLibrary stamps a.inLibrary from the
        // same index lookup (drives the "In Library" chip and keeps owned
        // albums out of wishlist-by-default) — the old path paid a second full
        // sweep just for that.
        shReindex()
        shelves = await SH.buildShelvesChunked(peerAlbums, state.library,
          { detectSurround, shouldAbort: dead, markInLibrary: true })
        if (dead() || !shelves) return
      } else {
        // Legacy sync path, kept verbatim for an old shelves module.
        if (SH) {
          const libIndex = SH.buildLibraryIndex
            ? SH.buildLibraryIndex(state.library)
            : null
          if (libIndex) {
            for (const a of peerAlbums) {
              a.inLibrary = !!libIndex.findMatch({ artist: a.artist, album: a.album })
            }
          } else {
            const libComp = state.library.map(SH.libAlbumToComparable)
            for (const a of peerAlbums) {
              a.inLibrary = libComp.some(lc => SH.albumsMatch(
                { artist: a.artist, album: a.album }, lc))
            }
          }
        }
        shReindex()
        await new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 500 }) : setTimeout(r, 1)))
        if (dead()) return
        shelves = SH ? SH.buildShelves(peerAlbums, state.library, { detectSurround }) : null
      }
      shParsing = false
      // Precompute the search indexes in the background (chunked): the per-
      // keystroke pass then scans ready lowercase strings instead of re-walking
      // 140k names. Fire-and-forget; search falls back until they land.
      if (SH && SH.buildTreeSearchIndexChunked) {
        const idxTree = tree
        const idxAlbums = peerAlbums
        ;(async () => {
          try {
            const ti = await SH.buildTreeSearchIndexChunked(idxTree, { shouldAbort: dead })
            if (ti && !dead()) shTreeSearchIndex = ti
            const ai = await SH.buildAlbumSearchIndexChunked(idxAlbums, { shouldAbort: dead })
            if (ai && !dead()) { shAlbumHays = ai.hays; shAlbumByFolder = ai.byFolderLower }
          } catch (_) { /* search simply keeps its fallback path */ }
        })()
      }
      // Warm covers ahead of the scroll when this is a shopper likely to browse
      // the whole library: a cached browse (they've been here) or a saved friend.
      // Fire-and-forget; the observer still handles visible-first, and the two
      // paths dedupe. A background refresh re-runs it so newly parsed albums also
      // get warmed (the disk cache makes the re-run nearly free).
      if (!shArtPrefetchAbort && dlg.isConnected &&
          (shFromCache || (window.PapaSavedUsers && window.PapaSavedUsers.isSaved(savedList, username)))) {
        shArtPrefetch()
      }
      if (mode === 'shelves' && dlg.isConnected) {
        renderShelves()
        if (refresh) {
          // Preserve scroll + the tiny pulse; the pulse auto-clears so the hero
          // settles back to the plain "from cache" line (or nothing).
          shBody.scrollTop = prevScroll
          setTimeout(() => { shJustRefreshed = false; if (dlg.isConnected && mode === 'shelves' && !shSearchQuery) {
            const hero = shBody.querySelector('.slsh-hero-cache')
            if (hero) { hero.classList.remove('slsh-hero-pulse'); hero.textContent = shFromCache && shCachedAt ? 'from cache · updated ' + _shAgo(shCachedAt) : '' }
          } }, 4000)
        }
      }
      if (refresh && mode === 'folders' && dlg.isConnected) render()
    } catch (e) {
      shParsing = false
      // Never swallow the reason: shelves failing on a real library is a bug
      // to report, and the console line is what makes it diagnosable.
      console.error('[slsh] shelves parse failed', e)
      window.__slshLastError = String((e && e.stack) || e)
      if (!refresh && mode === 'shelves' && dlg.isConnected) {
        shBody.innerHTML = `<div class="slsh-empty">Could not read albums from this library.<br>
          <span style="color:var(--text3);font-size:11px">Switch to Folders mode to browse the raw file tree.</span></div>`
      }
    }
  }
  buildFromTree()


  // Presence dot, if the presence module is available (best-effort).
  try {
    const pres = dlg.querySelector('#slsh-presence')
    if (pres && window.PapaSlskPresence && window.api.slskUserStatus) {
      window.api.slskUserStatus({ username }).then(st => {
        if (!pres.isConnected || !st) return
        const online = st.online || st.presence === 'Online' || st.status === 'Online'
        pres.classList.add(online ? 'online' : 'offline')
        pres.title = online ? 'Online' : 'Offline'
      }).catch(() => {})
    }
  } catch (_) {}

  // Keep a saved entry's counts and last-visited time current.
  if (window.PapaSavedUsers.isSaved(savedList, username)) {
    savedList = await window.api.slskTouchUser({
      username, fileCount: tree.fileCount, dirCount: tree.dirs.size }).catch(() => savedList)
  }
  }

  var api = { show: show }

  // The wording for a library that could not be loaded (R15). `online` is
  // true/false when the presence lookup answered, null when it did not.
  function browseFailureText(username, error, online) {
    const msg = String(error || '')
    if (online === false) return username + ' is offline, so their library cannot be browsed right now. Try again when they are back.'
    if (/\b404\b/.test(msg)) return 'slskd has no record of ' + username + ' right now — they may be offline or have changed their name.'
    if (/\b401\b|unauthor/i.test(msg)) return 'slskd rejected our login — check its username and password in Settings.'
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) return 'Could not reach the slskd daemon.'
    if (/timed out|timeout|abort/i.test(msg)) return username + ' did not answer in time. They may be busy or on a slow link — try again in a moment.'
    return 'Could not load this library: ' + (msg || 'unknown error')
  }
  api.browseFailureText = browseFailureText
  if (typeof window !== 'undefined') window.PapaSlskShopUI = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api

})()
