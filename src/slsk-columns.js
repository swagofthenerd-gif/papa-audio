// Folders mode: a Finder-style column browser with a live inspector.
//
// Every column is one level of the tree; the last panel is an inspector for
// whatever is selected. Everything painted here comes from a stranger's share,
// so every interpolated string goes through `esc` — a peer can and will name a
// folder `<img onerror=...>`, and that must arrive as text.
//
// The pure helpers (columnsFor, inspectorModel, searchRows, surroundRows) hold
// all the logic worth testing and run in node; mount() only paints and wires.
;(function () {
  const T = () => (typeof window !== 'undefined' && window.PapaSlskTree)
    || (typeof require === 'function' ? require('./slsk-tree.js') : null)
  const SEP = '\\'
  const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|aac|ogg|opus|ape|wv|alac|dsf|dff)$/i

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  // Same deterministic hash-to-hue recipe as slsk-dossier.js's paintCover, so
  // the inspector cover is never a flat dark square while art loads (or if
  // none is ever fetched for it).
  function coverGradient(title) {
    const hue = Math.abs([...String(title || '')].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
    return `linear-gradient(135deg,hsl(${hue},45%,20%),hsl(${(hue + 40) % 360},35%,12%))`
  }

  // ── Column widths ─────────────────────────────────────────────────────────
  // Stored per column INDEX, not per path: the point of dragging column 1 wider
  // is that the first level of every share stays wide, whichever folder you are
  // standing in. localStorage is user-editable, so everything read back out of
  // it is re-clamped and anything unparseable is simply no stored width.
  const COLS_W_KEY = 'slsk_cols_w'
  const COL_W_MIN = 140
  const COL_W_MAX = 480

  function clampColWidth(px) {
    const n = Math.round(Number(px))
    if (!isFinite(n)) return COL_W_MIN
    return Math.max(COL_W_MIN, Math.min(COL_W_MAX, n))
  }

  function parseColWidths(raw) {
    let obj = null
    try { obj = JSON.parse(String(raw == null ? '' : raw)) } catch (_) { return {} }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out = {}
    for (const k of Object.keys(obj)) {
      if (!/^\d+$/.test(k)) continue
      const v = Number(obj[k])
      if (!isFinite(v) || v <= 0) continue
      out[k] = clampColWidth(v)
    }
    return out
  }

  function serializeColWidths(map) {
    const out = {}
    for (const k of Object.keys(map || {})) {
      if (!/^\d+$/.test(String(k))) continue
      const v = Number(map[k])
      if (!isFinite(v) || v <= 0) continue
      out[k] = clampColWidth(v)
    }
    return JSON.stringify(out)
  }

  // The width a drag lands on: where it started plus how far the pointer moved.
  function nextColWidth(startPx, dx) {
    return clampColWidth(Number(startPx) + Number(dx || 0))
  }

  function columnsFor(tree, path, opts) {
    const t = T()
    const parts = String(path || '').split(SEP).filter(Boolean)
    const out = []
    const acc = []
    for (let i = 0; i <= parts.length; i++) {
      const p = acc.join(SEP)
      const l = t.listDir(tree, p, {
        sort: (opts && opts.sort) || 'name',
        audioOnly: !!(opts && opts.audioOnly),
      })
      if (!l) break
      const selected = parts[i] || null
      out.push({
        path: p,
        selected,
        node: l.node,
        rows: l.dirs.map(d => ({ ...d, kind: 'dir' }))
          .concat(l.files.map((f, idx) => ({ name: f.name, kind: 'file', idx, file: f }))),
      })
      if (selected) acc.push(selected)
    }
    return out
  }

  // Flat search across the whole tree, mapped to the same row shape the columns
  // use. slsk-tree's searchTree returns { type, name, path, fileCount|file };
  // for a file hit `path` is the CONTAINING folder, which is where a click has
  // to land, so it is carried separately from the row's own identity.
  function searchRows(tree, q, limit) {
    const t = T()
    const hits = t.searchTree(tree, q, limit == null ? 300 : limit) || []
    return hits.map((h) => (h.type === 'dir'
      ? { kind: 'dir', name: h.name, path: h.path, dirPath: h.path, fileCount: h.fileCount || 0 }
      : { kind: 'file', name: h.name, path: h.path, dirPath: h.path, file: h.file || null }))
  }

  // Every folder in the share whose path reads as a surround release. Only the
  // names are searchable — an unlabelled 5.1 rip cannot be spotted from here,
  // which is the same honest limit the old shop's list carried.
  function surroundRows(tree, detectSurround) {
    if (typeof detectSurround !== 'function') return []
    const out = []
    const walk = (n) => {
      for (const d of n.dirs.values()) {
        const sur = detectSurround(d.path)
        if (sur && d.fileCount) {
          out.push({
            kind: 'dir', name: d.name, path: d.path, dirPath: d.path,
            fileCount: d.fileCount, totalSize: d.totalSize,
            label: (sur && sur.label) || '',
          })
        }
        walk(d)
      }
    }
    walk(tree)
    out.sort((a, b) => b.fileCount - a.fileCount)
    return out
  }

  function inspectorModel(item, albumsByPath) {
    if (!item) return { kind: 'none' }
    if (item.dirs === undefined) {
      return {
        kind: 'file', name: item.name, size: Number(item.size) || 0,
        bitDepth: Number(item.bitDepth) || 0, sampleRate: Number(item.sampleRate) || 0,
        bitRate: Number(item.bitRate) || 0, length: Number(item.length) || 0,
        audio: AUDIO_RE.test(item.name || ''), file: item,
      }
    }
    const node = item
    const audio = (node.files || []).filter(f => AUDIO_RE.test(f.name || ''))
    const names = (node.files || []).map(f => String(f.name || '').toLowerCase())
    const subAudio = [...(node.dirs ? node.dirs.values() : [])]
      .some(d => (d.files || []).some(f => AUDIO_RE.test(f.name || '')))
    const album = albumsByPath && albumsByPath.get(String(node.path || '').toLowerCase())
    if (audio.length >= 2 && (!subAudio || album)) {
      return {
        kind: 'album', node, album: album || null, name: node.name, path: node.path,
        tracks: audio, size: node.totalSize || 0,
        extras: {
          log: names.some(n => n.endsWith('.log')),
          cue: names.some(n => n.endsWith('.cue')),
          art: names.some(n => /\.(jpe?g|png|webp)$/.test(n)),
        },
      }
    }
    return {
      kind: 'folder', node, name: node.name, path: node.path,
      fileCount: node.fileCount || 0, size: node.totalSize || 0,
      subdirCount: node.dirs ? node.dirs.size : 0, audioHere: audio.length,
    }
  }

  function mount({ host, tree, username, deps, albumsByPath, openDossier }) {
    const d = deps || {}
    const esc = d.esc || escapeHtml
    const showSnackbar = d.showSnackbar || (() => {})
    const startPreview = d.startPreview || (() => {})
    const enqueueFiles = d._slskEnqueue || (() => Promise.resolve({ ok: false }))
    const dirQuality = d._slskDirQuality
    const scheduleLibRescan = d._scheduleLibRescan
    const mgConfirm = d._mgConfirm
    // Numbers still come from a peer. Coerce rather than trust — a "fileCount"
    // of `"><script>` must become 0, not markup.
    const num = n => String(Number(n) || 0)

    let colWidths = {}
    try { colWidths = parseColWidths(localStorage.getItem(COLS_W_KEY)) } catch (_) { colWidths = {} }
    function saveColWidths() {
      try { localStorage.setItem(COLS_W_KEY, serializeColWidths(colWidths)) } catch (_) {}
    }

    let path = ''
    let sel = null
    const filters = { audioOnly: true, surroundOnly: false }
    let query = ''

    host.innerHTML = '<div class="slr-crumbs" id="slr-crumbs"></div>'
      + '<div class="slr-cols" id="slr-cols"></div>'
    const colsEl = host.querySelector('#slr-cols')
    const crumbsEl = host.querySelector('#slr-crumbs')

    function fmtSize(n) {
      return (typeof window !== 'undefined' && window.PapaSlskShelves && window.PapaSlskShelves.fmtSize)
        ? window.PapaSlskShelves.fmtSize(n) : Math.round((Number(n) || 0) / 1e6) + ' MB'
    }

    function rowHtml(r, colPath, isSel) {
      if (r.kind === 'dir') {
        const node = T().getNode(tree, r.path)
        const q = node && dirQuality ? dirQuality(node) : ''
        return `<div class="slr-row slr-row-dir${isSel ? ' is-sel' : ''}" data-path="${esc(r.path)}" role="option" tabindex="-1"><span class="slr-row-name">${esc(r.name)}</span><span class="slr-row-meta slr-mono">${q ? esc(q) + ' · ' : ''}${num(r.fileCount)}</span><span class="slr-row-arrow">›</span></div>`
      }
      const f = r.file
      const audio = AUDIO_RE.test(f.name)
      const spec = f.bitDepth ? num(f.bitDepth) + '/' + num(Math.round(Number(f.sampleRate) / 1000)) : ''
      return `<div class="slr-row slr-row-file${audio ? '' : ' is-dim'}${isSel ? ' is-sel' : ''}" data-file="${num(r.idx)}" data-col="${esc(colPath)}" role="option" tabindex="-1"><span class="slr-row-name">${esc(f.name)}</span><span class="slr-row-meta slr-mono">${esc(spec)}</span></div>`
    }

    function inspectorHtml(m) {
      if (m.kind === 'none') return '<div class="slr-insp slr-muted">Pick a folder or a file.</div>'
      if (m.kind === 'file') {
        const rows = [
          ['Size', fmtSize(m.size)],
          m.bitDepth && ['Bit depth', m.bitDepth + '-bit'],
          m.sampleRate && ['Sample rate', (m.sampleRate / 1000).toFixed(1) + ' kHz'],
          m.bitRate && ['Bitrate', m.bitRate + ' kbps'],
          m.length && ['Length', Math.floor(m.length / 60) + ':' + String(m.length % 60).padStart(2, '0')],
        ].filter(Boolean)
        return `<div class="slr-insp"><h4>${esc(m.name)}</h4><dl class="slr-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="slr-mono">${esc(String(v))}</dd>`).join('')}</dl>
          <div class="slr-acts">${m.audio ? '<button class="slr-btn slr-btn-pri" data-act="play">Download &amp; play</button><button class="slr-btn" data-act="preview">Preview</button>' : ''}<button class="slr-btn" data-act="dl">Download</button></div></div>`
      }
      if (m.kind === 'folder') {
        return `<div class="slr-insp"><h4>${esc(m.name)}</h4><div class="slr-muted">${num(m.subdirCount)} folder${m.subdirCount === 1 ? '' : 's'} · ${num(m.fileCount)} file${m.fileCount === 1 ? '' : 's'} · ${esc(fmtSize(m.size))}</div>
          <div class="slr-acts"><button class="slr-btn" data-act="dl-tree">Download everything below</button></div></div>`
      }
      const a = m.album
      const q = dirQuality ? dirQuality(m.node) : ''
      const tracks = m.tracks.map((t, i) => `<div class="slr-track" data-fi="${i}"><span class="slr-n slr-mono">${i + 1}</span><span class="slr-t">${esc(String(t.name || '').replace(/\.[a-z0-9]+$/i, ''))}</span><span class="slr-q slr-mono">${esc(t.bitDepth ? num(t.bitDepth) + '/' + num(Math.round(Number(t.sampleRate) / 1000)) : '')}</span></div>`).join('')
      const ex = [m.extras.log && 'log', m.extras.cue && 'cue', m.extras.art && 'artwork'].filter(Boolean).join(' · ')
      return `<div class="slr-insp"><div class="slr-insp-cover" data-cover="${esc(m.path)}" style="background-image:${coverGradient(a ? a.album : m.name)}"></div><h4>${esc(a ? a.album : m.name)}</h4>
        <div class="slr-muted">${esc([a && a.artist, a && a.year, q].filter(Boolean).join(' · '))}</div>
        <dl class="slr-kv"><dt>Tracks</dt><dd class="slr-mono">${num(m.tracks.length)}</dd><dt>Size</dt><dd class="slr-mono">${esc(fmtSize(m.size))}</dd>${ex ? `<dt>Extras</dt><dd>${esc(ex)}</dd>` : ''}${a && a.upgrade ? `<dt>Yours</dt><dd class="slr-mono">${esc(a.upgrade.yours || '')}</dd><dt>Verdict</dt><dd class="slr-v-up">upgrade</dd>` : ''}</dl>
        <div class="slr-tracks">${tracks}</div>
        <div class="slr-acts"><button class="slr-btn slr-btn-pri" data-act="dl-album">Download album</button><button class="slr-btn" data-act="preview-first">Preview</button><button class="slr-btn" data-act="dossier">Open dossier</button><button class="slr-btn" data-act="dossier-verify">Verify this rip</button></div></div>`
    }

    // One flat column of results, used by both search and the surround filter.
    // Rows carry data-path so the existing click handler navigates them; a file
    // hit navigates to the folder that holds it.
    function flatColumnHtml(rows, emptyText) {
      if (!rows.length) return `<div class="slr-col slr-col-flat" role="listbox"><div class="slr-muted slr-col-empty">${esc(emptyText)}</div></div>`
      const html = rows.map((r) => {
        const meta = r.kind === 'dir'
          ? (r.label ? esc(r.label) + ' · ' : '') + num(r.fileCount) + ' files'
          : esc(r.dirPath || '')
        return `<div class="slr-row slr-row-${r.kind === 'dir' ? 'dir' : 'file'} slr-row-hit" data-path="${esc(r.dirPath || r.path || '')}" role="option" tabindex="-1"><span class="slr-row-name">${esc(r.name)}</span><span class="slr-row-meta slr-mono">${meta}</span></div>`
      }).join('')
      return `<div class="slr-col slr-col-flat" role="listbox">${html}</div>`
    }

    // A 6px grab strip on the right edge of every browsing column. It is a flex
    // item with a -3px margin either side, so it straddles the column border
    // and costs the layout nothing; an absolutely positioned one would scroll
    // away with the column's own overflow-y. Not focusable on purpose — the
    // columns are already fully walkable with the arrow keys and Enter, so a
    // resize handle in the tab order would only add stops that do nothing for
    // someone who cannot drag.
    function armColResizers() {
      const cols = [...colsEl.querySelectorAll('.slr-col:not(.slr-col-insp)')]
      cols.forEach((col, i) => {
        const stored = colWidths[String(i)]
        if (stored) col.style.width = stored + 'px'
        const h = document.createElement('div')
        h.className = 'slr-col-grip'
        h.setAttribute('aria-hidden', 'true')
        let id = null, startX = 0, startW = 0
        h.addEventListener('pointerdown', e => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          id = e.pointerId
          startX = e.clientX
          startW = col.offsetWidth
          h.classList.add('is-dragging')
          try { h.setPointerCapture(e.pointerId) } catch (_) {}
        })
        h.addEventListener('pointermove', e => {
          if (id !== e.pointerId) return
          const w = nextColWidth(startW, e.clientX - startX)
          col.style.width = w + 'px'
          colWidths[String(i)] = w
        })
        const end = e => {
          if (id !== e.pointerId) return
          id = null
          h.classList.remove('is-dragging')
          try { h.releasePointerCapture(e.pointerId) } catch (_) {}
          saveColWidths()
        }
        h.addEventListener('pointerup', end)
        h.addEventListener('pointercancel', end)
        // Double-click puts this column back to whatever the stylesheet says,
        // which is also how a flat search column keeps its own wider default.
        h.addEventListener('dblclick', e => {
          e.preventDefault()
          e.stopPropagation()
          col.style.width = ''
          delete colWidths[String(i)]
          saveColWidths()
        })
        col.insertAdjacentElement('afterend', h)
      })
      armInspResizer()
    }

    // The inspector is the last panel in the row, so its drag edge is its left
    // one. It is the same job as the browsing columns but a different shape, so
    // it uses the shared panel resizer rather than a second copy of the grip
    // code above. Not collapsible: folding it would leave a selected album with
    // nowhere to show itself, which reads as the page having broken.
    function armInspResizer() {
      const PR = (typeof window !== 'undefined' && window.PapaPanelResize) || null
      const insp = colsEl.querySelector('.slr-col-insp')
      if (!PR || !insp) return
      PR.attach({ el: insp, edge: 'left', key: 'slsk_insp_w', min: 240, max: 560, defaultPx: 320 })
    }

    function render() {
      const bc = T().breadcrumbs(path)
      crumbsEl.innerHTML = bc.map((b, i) => `<button class="slr-crumb${i === bc.length - 1 ? ' is-current' : ''}" data-path="${esc(b.path)}">${esc(b.name)}</button>`)
        .join('<span class="slr-crumb-sep">›</span>')

      // Search wins over everything: one column of hits, no deeper columns.
      if (query) {
        const rows = searchRows(tree, query)
        colsEl.innerHTML = flatColumnHtml(rows, 'Nothing in this library matches that.')
          + '<div class="slr-col slr-col-insp">' + inspectorHtml({ kind: 'none' }) + '</div>'
        colsEl.scrollLeft = 0
        colsEl._model = { kind: 'none' }
        armColResizers()
        return
      }

      if (filters.surroundOnly) {
        const SF = (typeof window !== 'undefined' && window.PapaSlskFilters) || null
        const rows = surroundRows(tree, SF && SF.detectSurround)
        colsEl.innerHTML = flatColumnHtml(rows, 'No surround-labelled folders in this library.')
          + '<div class="slr-col slr-col-insp">' + inspectorHtml({ kind: 'none' }) + '</div>'
        colsEl.scrollLeft = 0
        colsEl._model = { kind: 'none' }
        armColResizers()
        return
      }

      const cols = columnsFor(tree, path, { audioOnly: filters.audioOnly })
      let selItem = null
      const html = cols.map(c => `<div class="slr-col" data-col="${esc(c.path)}" role="listbox">${c.rows.map(r => {
        const isSel = (r.kind === 'dir' && r.name === c.selected)
          || (sel && sel.col === c.path && sel.file === r.idx)
        if (sel && sel.col === c.path && r.kind === 'file' && sel.file === r.idx) selItem = r.file
        return rowHtml(r, c.path, isSel)
      }).join('') || '<div class="slr-muted slr-col-empty">Empty</div>'}</div>`).join('')
      const node = selItem ? null : T().getNode(tree, path)
      const m = inspectorModel(selItem || (path ? node : null), albumsByPath)
      colsEl.innerHTML = html + `<div class="slr-col slr-col-insp">${inspectorHtml(m)}</div>`
      colsEl.scrollLeft = colsEl.scrollWidth
      colsEl._model = m
      armColResizers()
    }

    // Navigating out of a search or the surround list is what makes the click
    // visible — leaving either mode on would repaint the same flat list.
    function goTo(p) {
      path = p
      sel = null
      query = ''
      filters.surroundOnly = false
      render()
    }

    function onColsClick(e) {
      const row = e.target.closest('.slr-row')
      const act = e.target.closest('[data-act]')
      if (row && row.dataset.path !== undefined) { goTo(row.dataset.path); return }
      if (row && row.dataset.file !== undefined) {
        sel = { col: row.dataset.col, file: Number(row.dataset.file) }
        render()
        return
      }
      if (!act) return
      const m = colsEl._model
      if (!m) return
      const enq = files => enqueueFiles(files.map(f => ({
        username, filename: f.fullPath || f.name, size: f.size || 0,
      })))
      const done = (r, okText) => {
        showSnackbar(r && r.ok ? okText : 'Could not start the download')
        if (r && r.ok && scheduleLibRescan) scheduleLibRescan()
      }
      const run = async () => {
        switch (act.dataset.act) {
          case 'dl': case 'play': case 'preview': {
            const f = m.file
            if (!f) return
            if (act.dataset.act === 'preview') {
              startPreview({ username, filename: f.fullPath || f.name, title: f.name })
            } else done(await enq([f]), 'Downloading')
            break
          }
          case 'dl-album':
            done(await enq(m.tracks), 'Downloading ' + m.name)
            break
          case 'preview-first':
            if (m.tracks && m.tracks.length) {
              startPreview({
                username, filename: m.tracks[0].fullPath || m.tracks[0].name, title: m.name,
              })
            }
            break
          case 'dossier': case 'dossier-verify':
            if (openDossier) {
              openDossier(m.album || {
                artist: '', album: m.name, folderName: m.name, folderPath: m.path,
                files: m.node.files, totalSize: m.size,
                lossless: m.tracks.every(t => /\.(flac|wav|ape|wv|alac|aiff?|dsf|dff)$/i.test(t.name)),
              }, { autoVerify: act.dataset.act === 'dossier-verify' })
            }
            break
          case 'dl-tree': {
            const all = []
            ;(function walk(n) {
              for (const f of n.files || []) if (AUDIO_RE.test(f.name)) all.push(f)
              for (const c of n.dirs.values()) walk(c)
            })(m.node)
            const go = async () => done(await enq(all), 'Downloading ' + all.length + ' files')
            if (mgConfirm) {
              const yes = await mgConfirm({
                title: 'Download ' + all.length + ' files?',
                body: fmtSize(all.reduce((s, f) => s + (Number(f.size) || 0), 0)),
                ok: 'Download',
              })
              if (yes) await go()
            } else await go()
            break
          }
        }
      }
      run().catch(() => showSnackbar('Could not start the download'))
    }

    function onCrumbClick(e) {
      const b = e.target.closest('[data-path]')
      if (b) goTo(b.dataset.path)
    }

    colsEl.addEventListener('click', onColsClick)
    crumbsEl.addEventListener('click', onCrumbClick)

    // The handler lives on document so the columns are walkable without having
    // to click into them first. That means it also sees the page's own search
    // box, so typing in any field must pass straight through.
    function onKey(e) {
      if (!host || !host.isConnected) return
      const t = e.target
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return
      const cols = [...colsEl.querySelectorAll('.slr-col:not(.slr-col-insp)')]
      const active = cols.findIndex(c => c.querySelector('.is-sel'))
      const col = cols[active >= 0 ? active : cols.length - 1]
      const rows = col ? [...col.querySelectorAll('.slr-row')] : []
      const i = rows.findIndex(r => r.classList.contains('is-sel'))
      const pick = (r) => {
        if (!r) return
        if (r.dataset.path !== undefined) { goTo(r.dataset.path); return }
        sel = { col: r.dataset.col, file: Number(r.dataset.file) }
        render()
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); pick(rows[Math.min(rows.length - 1, i + 1)]) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pick(rows[Math.max(0, i - 1)]) }
      else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault()
        goTo(T().parentPath(path))
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        const next = cols[cols.length - 1]
        const first = next && next.querySelector('.slr-row')
        if (first && !first.classList.contains('is-sel')) pick(first)
      }
    }
    document.addEventListener('keydown', onKey)

    render()
    return {
      navTo(p) { path = p || ''; sel = null; render() },
      setFilters(f) { Object.assign(filters, f); render() },
      search(q) { query = String(q || '').trim(); render() },
      destroy() {
        document.removeEventListener('keydown', onKey)
        colsEl.removeEventListener('click', onColsClick)
        crumbsEl.removeEventListener('click', onCrumbClick)
        host.innerHTML = ''
      },
    }
  }

  const api = { mount, columnsFor, inspectorModel, searchRows, surroundRows,
    clampColWidth, parseColWidths, serializeColWidths, nextColWidth,
    COLS_W_KEY, COL_W_MIN, COL_W_MAX }
  if (typeof window !== 'undefined') window.PapaSlskColumns = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
