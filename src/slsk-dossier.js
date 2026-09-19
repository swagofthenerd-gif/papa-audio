// The album dossier: everything the app can know about one remote album, in
// one panel, opened from Hunt, Wander, Folders or search. Replaces the
// slide-over in slsk-album-view.js for the new page; reuses its comparison
// table and my-copy lookup so the two never disagree.
;(function () {
  const AV = () => (typeof window !== 'undefined' && window.PapaSlskAlbumView) ||
    (typeof require === 'function' ? require('./slsk-album-view.js') : null)
  const SH = () => (typeof window !== 'undefined' && window.PapaSlskShelves) ||
    (typeof require === 'function' ? require('./slsk-shelves.js') : null)
  const CMP = () => (typeof window !== 'undefined' && window.PapaSlskCompare) ||
    (typeof require === 'function' ? require('./slsk-compare.js') : null)
  const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|aac|ogg|opus|ape|wv|alac|dsf|dff)$/i

  function fmtDur(sec) {
    const n = Math.round(Number(sec) || 0)
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0')
  }
  function fmtSize(n) { const s = SH(); return s && s.fmtSize ? s.fmtSize(n) : Math.round(n / 1e6) + ' MB' }
  function ago(ts) {
    const d = Date.now() - ts
    if (d < 90e3) return 'just now'
    if (d < 3600e3) return Math.round(d / 60e3) + ' min ago'
    if (d < 86400e3) return Math.round(d / 3600e3) + ' h ago'
    return Math.round(d / 86400e3) + ' d ago'
  }
  function tierOf(a) { return a.surround ? 'surround' : a.isHiRes ? 'hires' : a.lossless ? 'lossless' : 'lossy' }

  // "[2016 Remaster]", "(Deluxe Edition)", "{Vinyl}" out of the folder name.
  function editionOf(folderName) {
    const m = String(folderName || '').match(/[\[({]([^\])}]*(remaster|deluxe|edition|vinyl|mono|anniversary|expanded|japan|sacd|mfsl|dcc)[^\])}]*)[\])}]/i)
    return m ? m[1].trim() : ''
  }

  function model(album, username, mine) {
    const files = album.files || []
    const tracks = files.filter(f => AUDIO_RE.test(f.name || f.filename || ''))
    const total = tracks.reduce((s, f) => s + (Number(f.length) || 0), 0)
    const names = files.map(f => String(f.name || f.filename || '').toLowerCase())
    const s = SH()
    return {
      album, username, mine,
      title: album.album || album.folderName || '', artist: album.artist || '', year: album.year || null,
      editionNote: editionOf(album.folderName),
      quality: s && s.qualityString ? s.qualityString(album) : '',
      tier: tierOf(album),
      tracks, length: total ? fmtDur(total) : '', size: fmtSize(album.totalSize || 0),
      extras: {
        log: names.some(n => n.endsWith('.log')),
        cue: names.some(n => n.endsWith('.cue')),
        art: names.some(n => /\.(jpe?g|png|webp)$/.test(n)),
      },
      verdict: album.upgrade ? 'Upgrade over yours' : (mine ? 'You have this' : 'Not yours'),
      rip: null, reception: null, about: null, siblings: [],
    }
  }

  function labelDot(tier) { return `<i class="slr-lbl slr-lbl-${tier}"></i>` }

  function ripHtml(m, esc) {
    const r = m.rip
    if (!r) return `<div class="slr-rip slr-rip-idle"><button class="slr-btn" data-act="verify">Verify this rip</button>
      <span>Pulls one track, measures it, deletes it. Takes a minute or two.</span></div>`
    if (r.running) return `<div class="slr-rip slr-rip-busy"><span class="slr-spin"></span>Pulling ${esc(r.track || 'a track')}…</div>`
    if (!r.ok) return `<div class="slr-rip slr-rip-fail">${esc(r.reason || 'Could not verify.')} <button class="slr-btn slr-btn-quiet" data-act="verify">Try again</button></div>`
    // Only measured facts that actually came back get printed.
    const facts = []
    if (r.ceilingHz) facts.push('reaches ' + Math.round(r.ceilingHz / 1000) + ' kHz')
    if (r.dynamicRange != null) facts.push('dynamic range ' + r.dynamicRange)
    if (r.measuredBits) facts.push(r.measuredBits + ' bits used')
    const verdict = r.verdict || {}
    const tail = [facts.join(' · '), r.track ? 'verified from ' + r.track : '', ago(r.at || Date.now())]
      .filter(Boolean).join(' · ')
    return `<div class="slr-rip slr-rip-${esc(verdict.kind || 'unknown')}"><b class="slr-rip-verdict">${verdict.kind === 'genuine' ? '✓' : '⚠'} ${esc(verdict.text || '')}</b>
      <span>${esc(tail)}</span></div>`
  }

  function receptionHtml(m, esc) {
    const r = m.reception
    if (!r) return `<div class="slr-muted">Looking up…</div>`
    if (!r.ok) return r.reason === 'no-token'
      ? `<div class="slr-muted">Add a Discogs token in Settings to see ratings and tags.</div>`
      : `<div class="slr-muted">${esc(r.reason || 'Nothing found.')}</div>`
    const stars = r.rating ? '★'.repeat(Math.round(r.rating)) + '☆'.repeat(5 - Math.round(r.rating)) : ''
    const chips = [...(r.genres || []), ...(r.styles || [])].map(t => `<span class="slr-chip">${esc(t)}</span>`).join('')
    return `<div><span class="slr-stars">${stars}</span> <span class="slr-mono slr-muted">${r.rating != null ? esc(String(r.rating)) : '—'} · ${Number(r.count || 0).toLocaleString()} ratings on Discogs</span></div>
      <div class="slr-chips">${chips}</div>`
  }

  function sectionsHtml(m, esc) {
    const facts = [
      `<span class="slr-pill">${labelDot(m.tier)}${esc(m.quality)}</span>`,
      `<span class="slr-pill">${m.tracks.length} track${m.tracks.length === 1 ? '' : 's'}${m.length ? ' · ' + esc(m.length) : ''}</span>`,
      `<span class="slr-pill">${esc(m.size)}</span>`,
      (m.extras.log || m.extras.cue) ? `<span class="slr-pill">${[m.extras.log && 'log', m.extras.cue && 'cue'].filter(Boolean).join(' + ')}</span>` : '',
      `<span class="slr-pill slr-pill-verdict">${esc(m.verdict)}</span>`,
    ].filter(Boolean).join('')
    const sibs = (m.siblings || []).map(s => `<button class="slr-chip slr-chip-btn" data-sibling="${esc(s.folderPath)}">${esc(s.album)}${s.isHiRes ? ' · hi-res' : ''}${s.surround ? ' · surround' : ''}</button>`).join('')
    const about = m.about && m.about.bio ? `<div class="slr-muted">${esc(String(m.about.bio).slice(0, 420))}${m.about.bio.length > 420 ? '…' : ''}</div>` : `<div class="slr-muted">Nothing written about this artist yet.</div>`
    const tracks = m.tracks.map((t, i) => {
      const name = String(t.name || t.filename || '')
      const n = (name.match(/^\s*(\d{1,3})/) || [])[1] || (i + 1)
      const q = [t.bitDepth && t.bitDepth + '/' + Math.round((t.sampleRate || 0) / 1000), !t.bitDepth && t.bitRate && t.bitRate + ' kbps'].filter(Boolean).join('')
      return `<div class="slr-track" data-fi="${i}"><span class="slr-n slr-mono">${esc(String(n))}</span><span class="slr-t">${esc(name.replace(/^\s*\d{1,3}\s*[-._)]*\s*/, '').replace(/\.[a-z0-9]+$/i, ''))}</span>
        <span class="slr-q slr-mono">${t.length ? esc(fmtDur(t.length)) + ' · ' : ''}${esc(q)}</span>
        <span class="slr-track-acts"><button class="slr-mini" data-act="preview" data-fi="${i}" title="Preview">⚡</button><button class="slr-mini" data-act="dl" data-fi="${i}" title="Download">↓</button></span></div>`
    }).join('')
    return `
      <div class="slr-facts">${facts}</div>
      <div class="slr-sec"><b>Rip check</b>${ripHtml(m, esc)}</div>
      <div class="slr-sec"><b>Reception</b>${receptionHtml(m, esc)}</div>
      <div class="slr-sec"><b>About ${esc(m.artist || 'this artist')}</b>${about}</div>
      ${sibs ? `<div class="slr-sec"><b>Also by ${esc(m.artist)} here</b><div class="slr-chips">${sibs}</div></div>` : ''}
      <div class="slr-sec"><b>Tracks</b><div class="slr-tracks">${tracks}</div></div>
      <div class="slr-sec" id="slr-compare"><b>Tracks vs yours</b>${m.compareHtml || '<div class="slr-muted">You don\'t have this album.</div>'}</div>`
  }

  function open({ album, username, host, deps, siblings, autoVerify }) {
    const esc = deps.esc || (s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
    const showSnackbar = deps.showSnackbar || (() => {})
    const av = AV()
    const mine = av && av.findMyCopy ? av.findMyCopy(album, deps.state) : null
    const m = model(album, username, mine)
    m.siblings = siblings || []
    // Real signatures: findMyCopy(a, state); compareDrawerHtml(cmp, mine, a, esc),
    // where cmp comes from PapaSlskCompare.compareAlbums(theirFiles, myTracks).
    if (mine && av && av.compareDrawerHtml) {
      try {
        const c = CMP()
        if (c && c.compareAlbums) {
          const cmp = c.compareAlbums(album.files || [], mine.tracks || [])
          m.compareHtml = av.compareDrawerHtml(cmp, mine, album, esc)
        }
      } catch (_) {}
    }

    const root = document.createElement('div')
    root.className = 'slr-dossier'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', m.title)
    const mount = host || document.body
    mount.appendChild(root)

    function paint() {
      root.innerHTML = `
        <div class="slr-dossier-scrim" data-act="close"></div>
        <div class="slr-dossier-panel">
          <button class="slr-x" data-act="close" aria-label="Close">×</button>
          <div class="slr-dossier-head">
            <div class="slr-dossier-cover" id="slr-cover"></div>
            <div>
              <h2 class="slr-dossier-title">${esc(m.title)}</h2>
              <div class="slr-muted">${esc([m.artist, m.year, m.editionNote, 'from ' + username].filter(Boolean).join(' · '))}</div>
              <div class="slr-acts">
                <button class="slr-btn slr-btn-pri" data-act="download">Download album</button>
                <button class="slr-btn" data-act="preview" data-fi="0">Preview a track</button>
                ${deps.wishlistAdd ? `<button class="slr-btn" data-act="wishlist">Add to wishlist</button>` : ''}
                ${deps.openSlskChat ? `<button class="slr-btn" data-act="chat">Message ${esc(username)}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="slr-dossier-body">${sectionsHtml(m, esc)}</div>
        </div>`
      paintCover()
    }

    function paintCover() {
      const el = root.querySelector('#slr-cover')
      if (!el) return
      const lib = mine && mine.artPath ? mine.artPath : null
      if (lib) { el.innerHTML = `<img src="file://${esc(lib)}" alt="">`; return }
      const hue = Math.abs([...m.title].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
      el.style.background = `linear-gradient(135deg,hsl(${hue},45%,20%),hsl(${(hue + 40) % 360},35%,12%))`
      if (window.api && window.api.fetchAlbumArt && m.artist) {
        window.api.fetchAlbumArt({ albumId: 'slsk-' + (m.artist + '-' + m.title).replace(/[^a-z0-9]+/gi, '-').toLowerCase(), artist: m.artist, album: m.title })
          .then(p => { if (p && root.isConnected) el.innerHTML = `<img src="${/^https?:/.test(p) ? esc(p) : 'file://' + esc(p)}" alt="">` }).catch(() => {})
      }
    }

    async function verify() {
      m.rip = { running: true, track: '' }
      repaintBody()
      const res = await window.api.slskVerifyRip({ username, folderPath: album.folderPath, files: album.files }).catch(e => ({ ok: false, reason: e.message }))
      m.rip = res || { ok: false, reason: 'The check did not answer.' }
      try { localStorage.setItem('slr_rip:' + username + ':' + album.folderPath, JSON.stringify(m.rip)) } catch (_) {}
      repaintBody()
    }

    function repaintBody() {
      const b = root.querySelector('.slr-dossier-body')
      if (b) b.innerHTML = sectionsHtml(m, esc)
    }

    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-act],[data-sibling]')
      if (!t) return
      if (t.dataset.sibling) { const s = m.siblings.find(x => x.folderPath === t.dataset.sibling); close(); if (s && deps.openDossier) deps.openDossier(s); return }
      const fi = Number(t.dataset.fi)
      const f = m.tracks[fi]
      switch (t.dataset.act) {
        case 'close': close(); break
        case 'verify': verify(); break
        case 'download': {
          if (!deps._slskEnqueue) { showSnackbar('Downloads are not wired up'); break }
          const items = m.tracks.map(x => ({ username, filename: x.fullPath || x.filename || x.name, size: x.size || 0 }))
          const r = await deps._slskEnqueue(items)
          showSnackbar(r && r.ok ? 'Downloading ' + m.title : (r && r.reason) || 'Could not start the download')
          if (r && r.ok && deps._scheduleLibRescan) deps._scheduleLibRescan()
          break
        }
        case 'preview':
          if (!f) break
          if (!deps.startPreview) { showSnackbar('Preview is not wired up'); break }
          deps.startPreview({ username, filename: f.fullPath || f.filename || f.name, title: m.title })
          break
        case 'dl': {
          if (!f) break
          if (!deps._slskEnqueue) { showSnackbar('Downloads are not wired up'); break }
          const r = await deps._slskEnqueue([{ username, filename: f.fullPath || f.filename || f.name, size: f.size || 0 }])
          showSnackbar(r && r.ok ? 'Downloading' : 'Could not start the download')
          break
        }
        case 'wishlist': if (deps.wishlistAdd) deps.wishlistAdd(m.artist + ' ' + m.title); break
        case 'chat': if (deps.openSlskChat) deps.openSlskChat(username); break
      }
    })
    // A room teardown wipes host.innerHTML, which removes this root without
    // ever calling close() — so the listener would outlive the panel. First
    // keystroke after that unhooks it.
    function onKey(e) {
      if (!root.isConnected) { document.removeEventListener('keydown', onKey, true); return }
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    document.addEventListener('keydown', onKey, true)
    function close() { document.removeEventListener('keydown', onKey, true); root.remove() }

    paint()
    // Async sections: cached rip verdict, reception, about. Each paints when it lands.
    try { const c = localStorage.getItem('slr_rip:' + username + ':' + album.folderPath); if (c) { const r = JSON.parse(c); if (r && r.at && Date.now() - r.at < 30 * 86400e3) { m.rip = r; repaintBody() } } } catch (_) {}
    if (window.api && window.api.discogsAlbum) window.api.discogsAlbum({ artist: m.artist, album: m.title }).then(r => { m.reception = r; if (root.isConnected) repaintBody() }).catch(() => {})
    if (window.api && window.api.artistInfo && m.artist) window.api.artistInfo({ artist: m.artist }).then(r => { m.about = r; if (root.isConnected) repaintBody() }).catch(() => {})
    requestAnimationFrame(() => {
      root.classList.add('is-open')
      // "Verify this rip" opens the dossier and starts the check in one go;
      // a cached verdict already on screen is answer enough.
      if (autoVerify && !m.rip) verify()
    })
    return { close }
  }

  const api = { open, model, sectionsHtml, editionOf, fmtDur }
  if (typeof window !== 'undefined') window.PapaSlskDossier = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})()
