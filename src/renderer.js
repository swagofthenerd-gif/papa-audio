// ── State ──────────────────────────────────────────────────────────────────
const state = {
  library: [],
  musicFolders: [],
  recentlyPlayed: [],
  savedSites: [],
  likedAlbums: [],
  currentPage: 'home',
  currentAlbumId: null,
  currentArtistName: '',
  currentSearchQuery: '',
  queue: [],
  queueIndex: -1,
  ytDownloads: new Map(),  // id → { id, videoId, title, artist, percent, state, error }
  shuffle: false,
  repeat: 'off',
  isPlaying: false,
  browserActive: false,
  browserLoading: false,
  currentUrl: '',
  libSort: 'alpha',
  libLikedOnly: false,
  queuePanelOpen: false,
  lastVolume: 0.8,
  modalOpen: false,
  playbackSpeed: 1,
  sleepTimerEnd: null,
  savedQueues: [],
  qualitySources: [],
  upgradeHints: new Map(),  // albumId → [{ source, searchUrl }]
  libTab: 'albums',
  libGenre: null,
  playlists: [],
  currentPlaylistId: null,
  likedTracks: [],
  playCounts: {},
  playHistory: [],
  followedArtists: [],
  ytLiked: [],
  ytFollowed: [],
  ytSavedAlbums: [],
  ytRecent: [],
}

const slsk = {
  status: { installed: false, running: false, connected: false, configured: false },
  searching: false,
  searched: false,
  results: [],
  lastQuery: '',
  pendingSearches: 0,
}
// Cache for online source results: query → Map(sourceId → result object)
const _onlineCache = new Map()

const navHistory = []
const navFuture  = []
let _playCountTimer = null
let _shuffleHistory = []
const audio = window.__papaPlayer
let _volSaveTimer = null
let _homeClockInterval = null
let _allTracksCache = null
let _allTracksCacheRef = null
let _suggCache = { trackFp: null, pool: [] }
const _scrollMemory = new Map()

// ── Visibility & power management ───────────────────────────────────────────
let _appVisible = !document.hidden
const _dom = {}  // cached refs for hot-path elements (populated in init)

const SPEEDS = [1, 1.25, 1.5, 2, 0.75]

// ── Lyrics / Artist bio ────────────────────────────────────────────────────────
let _lyrics = null
let _dlPrevActiveCount = 0
const _bioCache = new Map()

document.addEventListener('visibilitychange', () => {
  _appVisible = !document.hidden
  if (!_appVisible) {
    startDownloadsPolling(60000)
    if (_homeClockInterval) { clearInterval(_homeClockInterval); _homeClockInterval = null }
  } else {
    startDownloadsPolling(state.currentPage === 'downloads' ? 2000 : 6000)
    if (state.currentPage === 'home' && !_homeClockInterval) {
      _drawHomeClock()
      _homeClockInterval = setInterval(_drawHomeClock, 1000)
    }
  }
})

// ── Dynamic album art color ───────────────────────────────────────────────────
// Single reusable canvas + image for color extraction — never recreated
const _colorCanvas = document.createElement('canvas')
_colorCanvas.width = _colorCanvas.height = 20  // 20×20 is plenty for dominant color
const _colorCtx = _colorCanvas.getContext('2d', { willReadFrequently: true })
const _colorImg = new Image()
const _colorCache = new Map()  // artPath → [r,g,b]

_colorImg.onload = () => {
  _colorCtx.drawImage(_colorImg, 0, 0, 20, 20)
  const data = _colorCtx.getImageData(0, 0, 20, 20).data
  let bestScore = -1, br = 29, bg = 185, bb = 84
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2]
    const max = Math.max(r,g,b), min = Math.min(r,g,b)
    const sat = max === 0 ? 0 : (max - min) / max
    const lum = (max + min) / 510
    const score = sat * (1 - Math.abs(lum - 0.45))
    if (score > bestScore && lum > 0.12 && lum < 0.88 && sat > 0.3) {
      bestScore = score; br = r; bg = g; bb = b
    }
  }
  if (_colorCache.size > 200) _colorCache.delete(_colorCache.keys().next().value)  // evict oldest
  _colorCache.set(_colorImg._artPath, [br, bg, bb])
  setAccent(`rgb(${br},${bg},${bb})`, `rgba(${br},${bg},${bb},0.85)`, `${br},${bg},${bb}`)
}

function extractAlbumColor(artPath) {
  if (!artPath) { setAccent('#1db954', '#1ed760'); return }
  const cached = _colorCache.get(artPath)
  if (cached) { const [r,g,b] = cached; setAccent(`rgb(${r},${g},${b})`, `rgba(${r},${g},${b},0.85)`, `${r},${g},${b}`); return }
  _colorImg._artPath = artPath
  _colorImg.src = `file://${artPath}`
}

function setAccent(color, hover, rgb) {
  document.documentElement.style.setProperty('--accent', color)
  document.documentElement.style.setProperty('--accent-hover', hover || color)
  if (rgb) document.documentElement.style.setProperty('--accent-rgb', rgb)
}

// ── Playback speed ────────────────────────────────────────────────────────────
function cycleSpeed() {
  const idx = SPEEDS.indexOf(state.playbackSpeed)
  state.playbackSpeed = SPEEDS[(idx + 1) % SPEEDS.length]
  audio.playbackRate = state.playbackSpeed
  const btn = document.getElementById('btn-speed')
  if (btn) btn.querySelector('.btn-speed-label').textContent =
    state.playbackSpeed === 1 ? '1×' : `${state.playbackSpeed}×`
  btn?.classList.toggle('active', state.playbackSpeed !== 1)
}

// ── Sleep timer ───────────────────────────────────────────────────────────────
let _sleepTimeout = null
function setSleepTimer(mins) {
  if (_sleepTimeout) { clearTimeout(_sleepTimeout); _sleepTimeout = null }
  state.sleepTimerEnd = null
  if (mins <= 0) { updateSleepBtn(); return }
  state.sleepTimerEnd = Date.now() + mins * 60000
  _sleepTimeout = setTimeout(() => {
    audio.pause(); state.isPlaying = false
    updatePlayBtn(); updateTrackHighlight()
    if (state.modalOpen) syncModalPlayBtn()
    state.sleepTimerEnd = null
    updateSleepBtn()
  }, mins * 60000)
  updateSleepBtn()
}

function updateSleepBtn() {
  const btn = document.getElementById('btn-sleep')
  if (!btn) return
  const active = !!state.sleepTimerEnd
  btn.classList.toggle('active', active)
  btn.title = active
    ? `Sleep timer: ${Math.round((state.sleepTimerEnd - Date.now()) / 60000)}m remaining`
    : 'Sleep timer'
}

function updateFormatBadge(track) {
  const el = document.getElementById('np-format')
  if (!el) return
  const sr = track?.sampleRate || 0
  const bd = track?.bitsPerSample || 0
  if (!sr && !bd) { el.textContent = ''; el.className = 'np-format'; return }
  el.textContent = fmtSpec(bd, sr)
  const isMaster = bd >= 24 && sr >= 176400  // 24-bit / 176.4kHz+
  const isHiRes  = bd >= 24 && sr > 48000
  el.className = 'np-format' + (isMaster ? ' hi-res master' : isHiRes ? ' hi-res' : '')
}

// ── Context menu target ─────────────────────────────────────────────────────
let ctxTarget = null  // { type: 'album'|'track', albumId, track, artist }

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const [info, liked, savedQueues, qualitySources, playlists, likedTracks, playCounts, playHistory, followedArtists, ytLiked, ytFollowed, ytSavedAlbums, ytRecent] = await Promise.all([
    window.api.getAppInfo(), window.api.getLiked(),
    window.api.getSavedQueues(), window.api.getQualitySources(),
    window.api.getPlaylists(), window.api.getLikedTracks(), window.api.getPlayCounts(),
    window.api.getPlayHistory(), window.api.getFollowedArtists(),
    window.api.getYtLiked(), window.api.getYtFollowed(),
    window.api.getYtSavedAlbums(), window.api.getYtRecent(),
  ])
  state.ytLiked        = ytLiked || []
  state.ytFollowed     = ytFollowed || []
  state.ytSavedAlbums  = ytSavedAlbums || []
  state.ytRecent       = ytRecent || []
  state.likedTracks    = likedTracks || []
  state.playCounts     = playCounts || {}
  state.playHistory    = playHistory || []
  state.followedArtists = followedArtists || []
  state.playlists = playlists || []
  state.savedQueues = savedQueues || []
  state.qualitySources = qualitySources || []
  state.musicFolders   = info.musicFolders   || []
  state.savedSites     = info.savedSites     || []
  state.recentlyPlayed = info.recentlyPlayed || []
  state.likedAlbums    = liked || []
  audio.volume = info.volume ?? 0.8
  state.lastVolume = audio.volume
  setVolDisplay(audio.volume)

  renderFolders()
  renderSavedSites()
  renderSavedQueues()
  renderQualitySources()
  initChatSidebar()
  initPlaybackSettings()
  setupListeners()

  const blocker = document.getElementById('mpv-blocker')
  const showBlocker = show => { blocker.style.display = show ? 'flex' : 'none' }
  window.api.on('player-event', ({ type }) => {
    if (type === 'mpvMissing' || type === 'engineFailed') showBlocker(true)
  })
  const playerStatus = await window.api.playerGetStatus()
  if (!playerStatus.available) showBlocker(true)
  document.getElementById('mpv-recheck-btn').onclick = async () => {
    const msg = document.getElementById('mpv-recheck-msg')
    msg.textContent = 'Checking…'
    const r = await window.api.playerRecheck()
    if (r.available) { showBlocker(false); msg.textContent = '' }
    else { msg.textContent = 'Still not found. Install mpv, then try again.' }
  }
  window.api.slskStatus().then(s => { slsk.status = s }).catch(() => {})
  startDownloadsPolling(6000)

  if (!state.musicFolders.length) {
    document.getElementById('setup-overlay').style.display = 'flex'
    return
  }

  const cached = await window.api.getLibraryCache()
  if (cached?.length) {
    state.library = cached
    checkFollowedArtistsForNew()
    navigate('home', null, { skipHistory: true })
    syncLibraryExt()
    setTimeout(backgroundSync, 800)
    setTimeout(restorePlaybackState, 1200)
  } else {
    showLoading()
    await fullScan()
  }
}

// ── Library ─────────────────────────────────────────────────────────────────
async function fullScan() {
  const data = await window.api.scanLibrary()
  state.library = data.albums || []
  navigate('home', null, { skipHistory: true })
  setTimeout(fetchMissingArtwork, 1200)
  syncLibraryExt()
}

function _libSig(lib) { return lib.length + ':' + lib.map(a => a.id).join('') }

async function backgroundSync() {
  const data = await window.api.scanLibrary()
  const fresh = data.albums || []
  const changed = _libSig(fresh) !== _libSig(state.library)
  if (changed) {
    state.library = fresh
    navigate(state.currentPage, _currentNavId(), { skipHistory: true })
    setTimeout(fetchMissingArtwork, 600)
    syncLibraryExt()
  }
}

function _currentNavId() {
  if (state.currentPage === 'album')  return state.currentAlbumId
  if (state.currentPage === 'artist') return state.currentArtistName
  if (state.currentPage === 'search') return state.currentSearchQuery
  if (state.currentPage === 'playlist') return state.currentPlaylistId
  return null
}

// ── Playback state restore ──────────────────────────────────────────────────
async function restorePlaybackState() {
  const saved = await window.api.getPlaybackState()
  if (!saved || !saved.filePath) return
  const album = state.library.find(a => a.tracks.some(t => t.filePath === saved.filePath))
  if (!album) return
  const idx = album.tracks.findIndex(t => t.filePath === saved.filePath)
  if (idx < 0) return
  state.queue = album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name }))
  state.queueIndex = idx
  const resumePos = saved.position || 0
  if (resumePos > 0) {
    const onMeta = () => { audio.currentTime = resumePos; audio.removeEventListener('loadedmetadata', onMeta) }
    audio.addEventListener('loadedmetadata', onMeta)
  }
  audio.src = `file://${saved.filePath}`
  state.isPlaying = false
  updatePlayBtn()
  updateNowPlaying(state.queue[idx])
  updateTrackHighlight()
  updateLikeBtn()
  syncExtension()
}

// ── Navigation ──────────────────────────────────────────────────────────────
function navigate(page, navId, opts = {}) {
  // Save scroll position of page we're leaving
  const contentEl = document.getElementById('content')
  if (contentEl && state.currentPage) {
    _scrollMemory.set(`${state.currentPage}:${_currentNavId() ?? ''}`, contentEl.scrollTop)
  }
  if (!opts.skipHistory) {
    navHistory.push({ page: state.currentPage, navId: _currentNavId() })
    navFuture.length = 0
  }
  if (page !== 'browse' && state.browserActive) hideBrowser()

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page)
  })

  state.currentPage        = page
  state.currentAlbumId     = page === 'album'  ? navId : null
  state.currentArtistName  = page === 'artist' ? navId : ''
  state.currentSearchQuery = page === 'search' ? navId : ''
  state.currentPlaylistId  = page === 'playlist' ? navId : null

  if (page === 'home')    renderHome()
  else if (page === 'library')   renderLibrary()
  else if (page === 'artists')   renderArtists()
  else if (page === 'album')     renderAlbum(navId)
  else if (page === 'browse')    renderBrowse()
  else if (page === 'artist')    renderArtist(navId)
  else if (page === 'search')    renderSearch(navId)
  else if (page === 'downloads') renderDownloads()
  else if (page === 'playlists') renderPlaylists()
  else if (page === 'playlist')  renderPlaylist(navId)
  else if (page === 'stats')     renderStats()
  else if (page === 'liked')     renderLikedSongs()
  else if (page === 'yt-album')  renderYtAlbum(navId)
  else if (page === 'yt-artist') renderYtArtist(navId)
  else if (page === 'yt-see-all')  renderYtSeeAll(navId)
  else if (page === 'yt-playlist') renderYtPlaylist(navId)

  if (page === 'downloads') startDownloadsPolling(2000)
  else { _dlLastSig = ''; startDownloadsPolling(6000) }

  updateNavBtns()
  hideContextMenu()

  if (opts.restoreScroll && contentEl) {
    const savedScroll = _scrollMemory.get(`${page}:${navId ?? ''}`) || 0
    requestAnimationFrame(() => { contentEl.scrollTop = savedScroll })
  }
}

function navigateBack() {
  if (!navHistory.length) return
  navFuture.push({ page: state.currentPage, navId: _currentNavId() })
  const prev = navHistory.pop()
  navigate(prev.page, prev.navId, { skipHistory: true, restoreScroll: true })
}

function navigateForward() {
  if (!navFuture.length) return
  navHistory.push({ page: state.currentPage, navId: _currentNavId() })
  const next = navFuture.pop()
  navigate(next.page, next.navId, { skipHistory: true, restoreScroll: true })
}

function updateNavBtns() {
  const back = document.getElementById('tb-back')
  const fwd  = document.getElementById('tb-fwd')
  if (back) back.disabled = navHistory.length === 0
  if (fwd)  fwd.disabled  = navFuture.length  === 0
}

// ── Folder management ──────────────────────────────────────────────────────
function renderFolders() {
  const list = document.getElementById('folders-list')
  if (!list) return
  list.innerHTML = state.musicFolders.map(f => `
    <li class="site-item" title="${esc(f)}">
      <span>${esc(shortPath(f))}</span>
      <button class="site-item-del" data-folder="${esc(f)}" title="Remove">&#10005;</button>
    </li>`).join('')
  list.querySelectorAll('.site-item-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      state.musicFolders = await window.api.removeMusicFolder(btn.dataset.folder)
      renderFolders()
      await fullScan()
    })
  })
}

function shortPath(p) {
  const home = '/home/' + (p.split('/')[2] || '')
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}

// ── Artwork fetching ───────────────────────────────────────────────────────
let artFetchCancelled = false

async function fetchMissingArtwork() {
  const missing = state.library.filter(a => !a.artPath)
  if (!missing.length) return
  artFetchCancelled = false
  const statusEl = document.getElementById('art-status')
  const textEl   = document.getElementById('art-status-text')
  const fillEl   = document.getElementById('art-status-fill')
  statusEl.style.display = 'flex'
  let found = 0
  for (let i = 0; i < missing.length; i++) {
    if (artFetchCancelled) break
    const album = missing[i]
    textEl.textContent = `${i + 1}/${missing.length} — ${album.name}`
    fillEl.style.width = `${Math.round((i / missing.length) * 100)}%`
    const result = await window.api.fetchAlbumArt({ albumId: album.id, artist: album.artist, album: album.name })
    if (result?.artPath) {
      found++
      album.artPath = result.artPath
      patchAlbumArtInDOM(album.id, result.artPath)
    }
    await sleep(250)
  }
  fillEl.style.width = '100%'
  textEl.textContent = artFetchCancelled ? 'Cancelled' : `Done — ${found}/${missing.length} covers found`
  if (found > 0) window.api.saveLibraryCache(state.library)
  await sleep(2500)
  statusEl.style.display = 'none'
}

function patchAlbumArtInDOM(albumId, artPath) {
  const src = `file://${artPath}`
  document.querySelectorAll(`.album-card[data-album="${albumId}"]`).forEach(card => {
    const wrap = card.querySelector('.album-card-art-wrap')
    const fallback = card.querySelector('.album-card-art-fallback')
    let img = card.querySelector('.album-card-art')
    if (!img && wrap) {
      img = Object.assign(document.createElement('img'), { className: 'album-card-art', alt: '', loading: 'lazy' })
      wrap.prepend(img)
    }
    if (img) { img.src = src; img.style.display = 'block' }
    if (fallback) fallback.style.display = 'none'
  })
  document.querySelectorAll(`.quick-card[data-album="${albumId}"]`).forEach(card => {
    const img = card.querySelector('.quick-card-art')
    const fallback = card.querySelector('.quick-card-art-fallback')
    if (img) { img.src = src; img.style.display = 'block' }
    if (fallback) fallback.style.display = 'none'
  })
  const heroImg = document.querySelector('.album-hero-art')
  if (heroImg && state.currentAlbumId === albumId) {
    heroImg.src = src; heroImg.style.display = 'block'
    const fb = document.querySelector('.album-hero-art-fallback')
    if (fb) fb.style.display = 'none'
  }
  const currentTrack = state.queue[state.queueIndex]
  if (currentTrack) {
    const ownerAlbum = state.library.find(a => a.id === albumId)
    const ownsCurrent = ownerAlbum?.tracks.some(t => t.filePath === currentTrack.filePath)
    if (ownsCurrent) {
      state.queue.forEach(t => { if (!t.artPath) t.artPath = artPath })
      const npArt = document.getElementById('np-art')
      const npFb  = document.getElementById('np-art-fallback')
      if (npArt) { npArt.src = src; npArt.style.display = 'block' }
      if (npFb)  npFb.style.display = 'none'
      updateNowPlayingModal()
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function showLoading() { setContent(`<div class="loading-wrap"><div class="spinner"></div><p>Scanning your library…</p></div>`) }

// ── Pages ───────────────────────────────────────────────────────────────────
function renderHome() {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const quickIds = state.recentlyPlayed.slice(0, 6)
  const quickAlbums = quickIds.map(id => state.library.find(a => a.id === id)).filter(Boolean)
  if (quickAlbums.length < 6) {
    const extra = state.library.filter(a => !quickIds.includes(a.id)).slice(0, 6 - quickAlbums.length)
    quickAlbums.push(...extra)
  }
  const missingCount = state.library.filter(a => !a.artPath).length
  const artBtnHTML = missingCount > 0 ? `
    <button class="find-art-btn" id="find-art-btn">
      <svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
      Find artwork for ${missingCount} album${missingCount !== 1 ? 's' : ''}
    </button>` : ''

  const quickHTML = quickAlbums.length ? `
    <div class="quick-grid">${quickAlbums.map(a => `
      <div class="quick-card" data-album="${a.id}">
        ${artImg(a.artPath, 'quick-card-art', 'quick-card-art-fallback')}
        <span class="quick-card-name">${esc(a.name)}</span>
        <button class="quick-card-play" data-play="${a.id}">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>`).join('')}
    </div>` : ''

  const recentAlbums = state.recentlyPlayed.map(id => state.library.find(a => a.id === id)).filter(Boolean).slice(0, 8)
  const ytRecentCards = state.ytRecent.slice(0, 4).map(r => `
    <div class="album-card yt-recent-card" data-ytalbum="${esc(r.albumId)}">
      <div class="album-card-art-wrap">
        ${r.artUrl ? `<img class="album-card-art" src="${esc(r.artUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
        <span class="yt-badge yt-card-badge">YT</span>
      </div>
      <div class="album-card-name">${esc(r.title || r.name)}</div>
      <div class="album-card-meta">${esc(r.artist || '')}</div>
    </div>`).join('')
  const recentHTML = (recentAlbums.length || state.ytRecent.length) ? `
    <div class="section-header">
      <span class="section-title">Recently Played</span>
      <button class="section-see-all" data-page="library" data-sort="recent">See all</button>
    </div>
    <div class="scroll-row">${recentAlbums.map(albumCard).join('')}${ytRecentCards}</div>` : ''

  const addedAlbums = [...state.library].filter(a => a.addedAt).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 8)
  const addedHTML = addedAlbums.length ? `
    <div class="section-header">
      <span class="section-title">Recently Added</span>
      <button class="section-see-all" data-page="library" data-sort="added">See all</button>
    </div>
    <div class="scroll-row">${addedAlbums.map(albumCard).join('')}</div>` : ''

  const ytFollowingCards = state.ytFollowed.map(a => `
    <div class="artist-card following-card yt-artist-card" data-channel="${esc(a.channelId)}">
      <div class="artist-card-art">
        ${a.thumbnailUrl ? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
        <div class="artist-card-art-fallback" ${a.thumbnailUrl ? 'style="display:none"' : ''}>
          <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </div>
      </div>
      <div class="artist-card-name">${esc(a.name)}</div>
      <div class="artist-card-meta">Artist · YT</div>
    </div>`).join('')

  const followingHTML = (state.followedArtists.length || state.ytFollowed.length) ? `
    <div class="section-header">
      <span class="section-title">Following</span>
    </div>
    <div class="scroll-row">${ytFollowingCards}${state.followedArtists.map(name => {
      const ap = (state.library.find(a => a.artist === name || a.albumArtist === name) || {}).artPath
      const ct = _artistAlbumCount(name)
      return `<div class="artist-card following-card" data-follow-artist="${esc(name)}">
        <div class="artist-card-art">
          ${ap ? `<img src="file://${ap}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
          <div class="artist-card-art-fallback" ${ap ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
        </div>
        <div class="artist-card-name">${esc(name)}</div>
        <div class="artist-card-meta">${ct} album${ct !== 1 ? 's' : ''}</div>
      </div>`
    }).join('')}</div>` : ''

  const allHTML = state.library.length ? `
    <div class="section-header">
      <span class="section-title">Your Library</span>
      <button class="section-see-all" data-page="library">See all</button>
    </div>
    <div class="album-grid">${state.library.slice(0, 24).map(albumCard).join('')}</div>` : `
    <div class="empty-wrap">
      <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
      <h2>No music found</h2><p>Add FLAC files to your music folder.</p>
    </div>`

  setContent(`<div class="page">
    <div class="home-header"><div class="home-header-left"><canvas class="home-clock" id="home-clock" width="56" height="56"></canvas><div class="greeting">${greeting}</div></div>${artBtnHTML}</div>
    ${quickHTML}${followingHTML}${recentHTML}${addedHTML}${allHTML}
    <div id="yt-home"></div>
  </div>`)

  document.querySelectorAll('.section-see-all').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.sort) state.libSort = btn.dataset.sort
      navigate(btn.dataset.page || 'library')
    })
  })
  document.querySelectorAll('.yt-recent-card').forEach(card => card.addEventListener('click', () => {
    const r = state.ytRecent.find(x => x.albumId === card.dataset.ytalbum)
    if (!r) return
    state.queue = [{ filePath: r.filePath, title: r.title || r.name, artist: r.artist, albumArtist: r.artist, albumName: r.name, albumId: r.albumId, artPath: r.artUrl, duration: 0 }]
    state.queueIndex = 0
    playCurrentTrack()
  }))
  loadYtHome()
  document.querySelectorAll('.following-card[data-follow-artist]').forEach(card => {
    card.addEventListener('click', () => navigate('artist', card.dataset.followArtist))
  })
  document.querySelectorAll('.following-card[data-channel]').forEach(card => {
    card.addEventListener('click', () => navigate('yt-artist', card.dataset.channel))
  })
}

// ── YT Music home feed (session-cached; silently omitted offline) ───────────
let _ytHomeCache = null
async function loadYtHome() {
  if (!document.getElementById('yt-home')) return
  if (!_ytHomeCache) {
    const res = await window.api.ytHome().catch(() => ({ ok: false }))
    if (!res.ok || !res.sections?.length) return
    _ytHomeCache = res.sections
  }
  const el = document.getElementById('yt-home')
  if (!el || state.currentPage !== 'home') return
  el.innerHTML = _ytHomeCache.map((sec, si) => `
    <div class="section-header" style="margin-top:28px">
      <span class="section-title">${esc(sec.title)} <span class="yt-badge">YT</span></span>
    </div>
    ${sec.kind === 'songs'
      ? `<div class="yt-home-songs" data-si="${si}">${_ytSongRows(sec.items)}</div>`
      : `<div class="scroll-row">${sec.items.map(_ytAlbumCard).join('')}</div>`}
  `).join('')
  el.querySelectorAll('.yt-home-songs').forEach(box => {
    bindYtEvents(_ytHomeCache[parseInt(box.dataset.si)].items, box)
  })
  el.querySelectorAll('.yt-album-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-album', card.dataset.browse)
  }))
}

function renderArtists() {
  const artistMap = new Map()
  for (const album of state.library) {
    const key = album.artist
    if (!artistMap.has(key)) {
      artistMap.set(key, { name: album.artist, albums: [], artPath: null })
    }
    const entry = artistMap.get(key)
    entry.albums.push(album)
    if (!entry.artPath && album.artPath) entry.artPath = album.artPath
  }
  const artists = [...artistMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (!artists.length) { navigate('library'); return }

  setContent(`<div class="page">
    <div class="page-header">
      <h1 class="section-title" style="margin-bottom:20px">Artists</h1>
      <div class="library-search-wrap">
        <input class="library-search" id="artist-search" type="text" placeholder="Search artists…">
      </div>
    </div>
    <div class="artist-grid" id="artist-grid">${artists.map(ar => `
      <div class="artist-card" data-artist="${esc(ar.name)}">
        <div class="artist-card-art">
          ${ar.artPath
            ? `<img src="file://${ar.artPath}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="artist-card-art-fallback" ${ar.artPath ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
        </div>
        <div class="artist-card-name">${esc(ar.name)}</div>
        <div class="artist-card-meta">${ar.albums.length} album${ar.albums.length !== 1 ? 's' : ''}</div>
      </div>`).join('')}
    ${state.ytFollowed.map(a => `
      <div class="artist-card yt-artist-card" data-channel="${esc(a.channelId)}" data-artist="${esc(a.name)}">
        <div class="artist-card-art">
          ${a.thumbnailUrl
            ? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="artist-card-art-fallback" ${a.thumbnailUrl ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
        </div>
        <div class="artist-card-name">${esc(a.name)}</div>
        <div class="artist-card-meta">Artist · YT</div>
      </div>`).join('')}
    </div>
  </div>`)

  document.getElementById('artist-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase()
    const grid = document.getElementById('artist-grid')
    if (!grid) return
    grid.querySelectorAll('.artist-card').forEach(card => {
      const name = (card.dataset.artist || '').toLowerCase()
      card.style.display = name.includes(q) ? '' : 'none'
    })
  })

  document.querySelectorAll('.artist-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.channel) { navigate('yt-artist', card.dataset.channel); return }
      const artist = card.dataset.artist
      if (artist) navigate('artist', artist)
    })
  })
}

function renderLibrary() {
  const getSorted = () => {
    // Saved YT albums are merged as pseudo-cards at render time — they never
    // live in state.library, so a rescan can't clobber them.
    const ytAlbums = state.ytSavedAlbums.map(a => ({
      id: `yt_${a.browseId}`, isYt: true, browseId: a.browseId,
      name: a.title, artist: a.artist, year: parseInt(a.year, 10) || 0,
      artPath: a.thumbnailUrl || null, addedAt: a.savedAt || 0,
      tracks: a.tracks || [], genre: null,
    }))
    let albums = [...state.library, ...ytAlbums]
    if (state.libLikedOnly) albums = albums.filter(a => state.likedAlbums.includes(a.id) || a.isYt)
    if (state.libGenre) albums = albums.filter(a => a.genre === state.libGenre)
    if (state.libSort === 'alpha')  return albums.sort((a, b) => a.name.localeCompare(b.name))
    if (state.libSort === 'artist') return albums.sort((a, b) => a.artist.localeCompare(b.artist))
    if (state.libSort === 'year')   return albums.sort((a, b) => (b.year || 0) - (a.year || 0))
    if (state.libSort === 'recent') return albums.sort((a, b) => state.recentlyPlayed.indexOf(a.id) - state.recentlyPlayed.indexOf(b.id)).filter(a => state.recentlyPlayed.includes(a.id)).concat(albums.filter(a => !state.recentlyPlayed.includes(a.id)))
    if (state.libSort === 'added') return albums.filter(a => a.addedAt).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).concat(albums.filter(a => !a.addedAt))
    if (state.libSort === 'genre') return albums.sort((a, b) => (a.genre || 'zzz').localeCompare(b.genre || 'zzz'))
    return albums
  }

  const sortBtns = [
    { key: 'alpha', label: 'A–Z' },
    { key: 'artist', label: 'Artist' },
    { key: 'year', label: 'Year' },
    { key: 'genre', label: 'Genre' },
    { key: 'recent', label: 'Recently played' },
    { key: 'added', label: 'Recently added' },
  ].map(s => `<button class="sort-btn${state.libSort === s.key ? ' active' : ''}" data-sort="${s.key}">${s.label}</button>`).join('')

  const likedBtn = `<button class="sort-btn${state.libLikedOnly ? ' active' : ''}" id="liked-filter-btn" style="margin-left:auto">♥ Liked only</button>`

  const genres = [...new Set(state.library.map(a => a.genre).filter(Boolean))].sort()
  const genreChips = genres.length ? `<div class="genre-chip-bar">
    <button class="genre-chip${!state.libGenre ? ' active' : ''}" data-genre="">All</button>
    ${genres.map(g => `<button class="genre-chip${state.libGenre === g ? ' active' : ''}" data-genre="${esc(g)}">${esc(g)}</button>`).join('')}
  </div>` : ''

  setContent(`<div class="page">
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <h1 class="section-title">Your Library</h1>
        <span class="lib-count">${state.library.length + state.ytSavedAlbums.length} albums</span>
        <button class="rescan-btn" id="lib-rescan-btn" title="Rescan music folders">
          <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
          Rescan
        </button>
      </div>
      <div class="library-search-wrap">
        <input class="library-search" id="lib-search" type="text" placeholder="Search albums or artists…">
      </div>
      <div class="sort-bar">${sortBtns}${likedBtn}</div>
      ${genreChips}
    </div>
    <div class="album-grid" id="lib-grid">${getSorted().map(albumCard).join('')}</div>
  </div>`)

  document.getElementById('lib-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase()
    const filtered = getSorted().filter(a =>
      a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
    )
    const grid = document.getElementById('lib-grid')
    if (grid) grid.innerHTML = filtered.map(albumCard).join('')
    bindContentEvents()
  })

  document.querySelectorAll('.sort-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.libSort = btn.dataset.sort
      renderLibrary()
    })
  })
  document.getElementById('liked-filter-btn')?.addEventListener('click', () => {
    state.libLikedOnly = !state.libLikedOnly
    renderLibrary()
  })
  document.querySelectorAll('.genre-chip[data-genre]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.libGenre = btn.dataset.genre || null
      renderLibrary()
    })
  })

  document.getElementById('lib-rescan-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('lib-rescan-btn')
    if (!btn) return
    btn.disabled = true
    btn.innerHTML = '<svg viewBox="0 0 24 24" style="animation:dl2Spin 1s linear infinite"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg> Scanning…'
    const data = await window.api.scanLibrary()
    state.library = data.albums || []
    renderLibrary()
    syncLibraryExt()
  })
}

function renderAlbum(albumId) {
  const album = state.library.find(a => a.id === albumId)
  if (!album) { navigate('home', null, { skipHistory: true }); return }
  const totalDur = album.tracks.reduce((s, t) => s + t.duration, 0)
  const colors = ['#5038a0','#a04038','#2d7a4a','#3850a0','#a07038','#6b38a0','#1a5a7a','#7a1a4a']
  const color = colors[parseInt(albumId.slice(0,2), 16) % colors.length]
  const isLiked = state.likedAlbums.includes(albumId)

  const discs = new Set(album.tracks.map(t => t.discNumber))
  const hasMultipleDiscs = discs.size > 1
  let lastDisc = null
  const trackRows = album.tracks.map((t, i) => {
    let discHeader = ''
    if (hasMultipleDiscs && t.discNumber !== lastDisc) {
      lastDisc = t.discNumber
      discHeader = `<div class="disc-separator">Disc ${t.discNumber}</div>`
    }
    const isPlaying = isCurrentTrack(t.filePath)
    const plays = state.playCounts[t.filePath] || 0
    const tLiked = state.likedTracks.includes(t.filePath)
    return discHeader + `
      <div class="track-row ${isPlaying ? 'playing' : ''}" data-file="${esc(t.filePath)}" data-idx="${i}" data-album="${albumId}">
        <span class="track-num">${isPlaying
          ? '<div class="playing-bars"><span></span><span></span><span></span></div>'
          : (t.trackNumber || i + 1)}</span>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}${t.explicit ? '<span class="track-explicit">E</span>' : ''}</div>
          <div class="track-artist" data-artist="${esc(t.artist || album.artist)}">${esc(t.artist || album.artist)}${t.bpm ? `<span class="track-bpm">${t.bpm} BPM</span>` : ''}</div>
        </div>
        ${plays > 0 ? `<span class="track-plays">${plays}</span>` : '<span class="track-plays"></span>'}
        <button class="track-like-btn ${tLiked ? 'liked' : ''}" data-like="${esc(t.filePath)}" title="${tLiked ? 'Unlike' : 'Like'}">${tLiked ? '♥' : '♡'}</button>
        <span class="track-dur">${fmtDur(t.duration)}</span>
        <button class="track-more-btn" title="More options"><svg viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></button>
      </div>`
  }).join('')

  setContent(`
    <div class="album-sticky-header" id="album-sticky-header">
      <button class="sticky-play-btn" id="sticky-play-btn">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="sticky-album-title">${esc(album.name)}</div>
      <div class="sticky-album-artist">${esc(album.artist)}</div>
    </div>
    <div class="album-hero" id="album-hero-sentinel" style="background: linear-gradient(${color}cc, var(--bg) 100%)">
      <img class="album-hero-art" src="${album.artPath ? 'file://' + album.artPath : ''}" alt="" ${!album.artPath ? 'style="display:none"' : ''} onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="album-hero-art-fallback" ${album.artPath ? 'style="display:none"' : ''}><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Album</div>
        <div class="album-hero-title">${esc(album.name)}</div>
        <div class="album-hero-meta">
          <span class="artist-link" data-artist="${esc(album.artist)}">${esc(album.artist)}</span>
          &bull; ${album.year || ''} &bull; ${album.tracks.length} songs, ${fmtTime(totalDur)}
          ${album.isHiRes ? `&bull; <span class="hero-hires-badge">${fmtSpec(album.maxBitsPerSample, album.maxSampleRate)}</span>` : ''}
          ${album.genre ? `&bull; <span class="genre-badge">${esc(album.genre)}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="album-play-btn">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn album-like-btn like-btn ${isLiked ? 'liked' : ''}" id="album-like-btn" data-album="${albumId}" title="${isLiked ? 'Unlike' : 'Like'}">
        <svg class="heart-outline" viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09A5.99 5.99 0 0 0 7.5 3C4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>
        <svg class="heart-filled" viewBox="0 0 24 24" style="display:none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
      <button class="ctrl-btn album-addpl-btn" id="album-addpl-btn" title="Add album to playlist">
        <svg viewBox="0 0 24 24"><path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm14-2v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z"/></svg>
      </button>
    </div>
    <div class="track-list">
      <div class="track-list-header"><span>#</span><span>Title</span><span style="text-align:right">Duration</span></div>
      ${trackRows}
    </div>
    <div id="album-credits-section"></div>
    ${(() => {
      const moreByArtist = state.library.filter(a => a.artist === album.artist && a.id !== albumId)
      if (!moreByArtist.length) return ''
      return `<div class="section-header" style="margin-top:40px">
        <span class="section-title">More by ${esc(album.artist)}</span>
        <button class="section-see-all" data-artist="${esc(album.artist)}">See discography</button>
      </div>
      <div class="scroll-row more-by-row">${moreByArtist.map(albumCard).join('')}</div>`
    })()}`)

  document.getElementById('album-play-btn')?.addEventListener('click', () => playAlbum(album, 0))
  document.getElementById('album-like-btn')?.addEventListener('click', () => toggleLike(albumId))
  document.getElementById('album-addpl-btn')?.addEventListener('click', () => {
    showAddToPlaylistModal(album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name })))
  })
  document.querySelector('.section-see-all[data-artist]')?.addEventListener('click', e => {
    navigate('artist', e.currentTarget.dataset.artist)
  })
  wireTrackLikeButtons()
  renderAlbumCredits(album)

  // Sticky header: show when hero scrolls out of view
  document.getElementById('sticky-play-btn')?.addEventListener('click', () => playAlbum(album, 0))
  const heroSentinel = document.getElementById('album-hero-sentinel')
  const stickyHeader = document.getElementById('album-sticky-header')
  if (heroSentinel && stickyHeader) {
    const io = new IntersectionObserver(entries => {
      stickyHeader.classList.toggle('visible', !entries[0].isIntersecting)
    }, { threshold: 0, rootMargin: '-80px 0px 0px 0px' })
    io.observe(heroSentinel)
  }
}

function renderAlbumCredits(album) {
  const el = document.getElementById('album-credits-section')
  if (!el) return

  // Gather credits from embedded tags
  const credits = {}
  const addCredit = (role, name) => {
    if (!name) return
    if (!credits[role]) credits[role] = new Set()
    credits[role].add(name)
  }

  // Label / catalog metadata (album level from first track with it)
  let label = null, catalogNumber = null
  for (const t of album.tracks) {
    if (!label && t.label) label = t.label
    if (!catalogNumber && t.catalogNumber) catalogNumber = t.catalogNumber
    addCredit('Composed by', t.composer)
    addCredit('Lyrics by', t.lyricist)
  }

  const hasCredits = Object.keys(credits).length > 0 || label || catalogNumber || album.genre || album.year

  if (!hasCredits) { el.style.display = 'none'; return }

  const creditRows = Object.entries(credits).map(([role, names]) =>
    `<div class="credit-item">
      <div class="credit-role">${esc(role)}</div>
      <div class="credit-name">${[...names].map(n => esc(n)).join(', ')}</div>
    </div>`
  ).join('')

  const metaRows = [
    label          ? `<div class="credit-item"><div class="credit-role">Label</div><div class="credit-name">${esc(label)}</div></div>` : '',
    catalogNumber  ? `<div class="credit-item"><div class="credit-role">Catalog #</div><div class="credit-name">${esc(catalogNumber)}</div></div>` : '',
    album.genre    ? `<div class="credit-item"><div class="credit-role">Genre</div><div class="credit-name">${esc(album.genre)}</div></div>` : '',
    album.year     ? `<div class="credit-item"><div class="credit-role">Released</div><div class="credit-name">${album.year}</div></div>` : '',
    (album.maxSampleRate && album.maxBitsPerSample) ? `<div class="credit-item"><div class="credit-role">Quality</div><div class="credit-name">${fmtSpec(album.maxBitsPerSample, album.maxSampleRate)}</div></div>` : '',
  ].filter(Boolean).join('')

  el.innerHTML = `
    <div class="credits-section">
      <div class="credits-section-title">Credits</div>
      <div class="credits-grid">
        ${creditRows}
        ${metaRows}
      </div>
    </div>`
}

function wireTrackLikeButtons() {
  document.querySelectorAll('.track-like-btn[data-like]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const fp = btn.dataset.like
      const liked = toggleTrackLike(fp)
      btn.classList.toggle('liked', liked)
      btn.textContent = liked ? '♥' : '♡'
      btn.title = liked ? 'Unlike' : 'Like'
      if (liked) { btn.classList.remove('heart-pulse'); void btn.offsetWidth; btn.classList.add('heart-pulse') }
      btn.addEventListener('animationend', () => btn.classList.remove('heart-pulse'), { once: true })
    })
  })
}

function toggleTrackLike(filePath) {
  const idx = state.likedTracks.indexOf(filePath)
  let liked
  if (idx >= 0) { state.likedTracks.splice(idx, 1); liked = false }
  else { state.likedTracks.push(filePath); liked = true }
  window.api.saveLikedTracks(state.likedTracks)
  return liked
}

const GENRE_COLORS = {
  'Rock':        'linear-gradient(135deg,#e8113a,#a00)',
  'Pop':         'linear-gradient(135deg,#c60050,#780)',
  'Hip-Hop':     'linear-gradient(135deg,#e47000,#7a4000)',
  'Jazz':        'linear-gradient(135deg,#00539a,#002a50)',
  'Classical':   'linear-gradient(135deg,#6c3f9a,#2d1a45)',
  'Electronic':  'linear-gradient(135deg,#0066cc,#003380)',
  'R&B':         'linear-gradient(135deg,#b30085,#5c004a)',
  'Metal':       'linear-gradient(135deg,#1a1a1a,#555)',
  'Folk':        'linear-gradient(135deg,#3c7a1a,#1a4000)',
  'Country':     'linear-gradient(135deg,#c87a00,#6a3c00)',
  'Blues':       'linear-gradient(135deg,#0a4a7a,#001a30)',
  'Soul':        'linear-gradient(135deg,#9a1a00,#4a0a00)',
  'Ambient':     'linear-gradient(135deg,#00777a,#003c40)',
  'Punk':        'linear-gradient(135deg,#cc0000,#440000)',
  'Reggae':      'linear-gradient(135deg,#009900,#004400)',
  'Latin':       'linear-gradient(135deg,#e05000,#6a2000)',
}
function renderSearch(query) {
  if (!query) {
    // Genre browse landing
    const libGenres = [...new Set(state.library.map(a => a.genre).filter(Boolean))]
    const displayGenres = libGenres.length > 0 ? libGenres : Object.keys(GENRE_COLORS)
    const tiles = displayGenres.slice(0, 20).map(g => {
      const bg = GENRE_COLORS[g] || `linear-gradient(135deg,hsl(${Math.abs(g.charCodeAt(0)*7)%360},55%,28%),hsl(${Math.abs(g.charCodeAt(0)*7+40)%360},45%,18%))`
      return `<div class="genre-tile" style="background:${bg}" data-genre="${esc(g)}">${esc(g)}</div>`
    }).join('')
    setContent(`<div class="page">
      <div class="section-header"><span class="section-title">Browse by genre</span></div>
      <div class="genre-grid">${tiles}</div>
    </div>`)
    document.querySelectorAll('.genre-tile[data-genre]').forEach(tile => {
      tile.addEventListener('click', () => {
        state.libGenre = tile.dataset.genre
        navigate('library')
      })
    })
    return
  }
  const q = query.toLowerCase()
  const matchAlbums = state.library.filter(a =>
    a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
  )
  const artistSet = new Set()
  state.library.forEach(a => { if (a.artist.toLowerCase().includes(q)) artistSet.add(a.artist) })
  const matchArtists = [...artistSet]
  const matchTracks = state.library.flatMap(a =>
    a.tracks.filter(t => t.title.toLowerCase().includes(q))
      .map(t => ({ ...t, albumId: a.id, albumArtist: a.artist, artPath: a.artPath }))
  ).slice(0, 20)

  const hasLocal = matchAlbums.length || matchArtists.length || matchTracks.length
  ytSearchState.showTopResult = !hasLocal

  const tabs = ['All', 'Songs', 'Albums', 'Artists', 'Playlists']
  let html = `<div class="page">
    <div class="search-tabs" id="search-tabs">
      ${tabs.map(t => `<button class="search-tab${t==='All'?' active':''}" data-tab="${t}">${t}</button>`).join('')}
    </div>`

  if (hasLocal) {
    // Top result — best matching album or artist
    const topAlbum = matchAlbums[0]
    if (topAlbum) {
      const hue = _cardHue((topAlbum.artist||'') + (topAlbum.name||''))
      const artStyle = topAlbum.artPath
        ? `background:url('file://${topAlbum.artPath}') center/cover no-repeat`
        : `background:linear-gradient(135deg,hsl(${hue},55%,28%) 0%,hsl(${(hue+40)%360},45%,18%) 100%)`
      html += `<div class="search-section" data-section="All"><div class="search-top-row">
        <div class="search-top-result" data-album="${topAlbum.id}">
          <div class="str-label">Top Result</div>
          <div class="str-art" style="${artStyle}">
            ${!topAlbum.artPath ? `<svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:rgba(255,255,255,.5)"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>` : ''}
          </div>
          <div class="str-name">${esc(topAlbum.name)}</div>
          <div class="str-artist">${esc(topAlbum.artist)} · Album</div>
          <button class="str-play album-card-play" data-play="${topAlbum.id}">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>`

      if (matchTracks.length) {
        html += `<div class="search-top-tracks">`
        html += matchTracks.slice(0, 4).map((t, i) => {
          const trackHue = _cardHue(t.albumArtist + t.title)
          const artThumb = t.artPath
            ? `<img src="file://${t.artPath}" class="str-track-thumb" alt="" onerror="this.style.display='none'">`
            : `<div class="str-track-thumb" style="background:linear-gradient(135deg,hsl(${trackHue},50%,22%),hsl(${(trackHue+40)%360},40%,14%))"></div>`
          return `<div class="str-track track-row" data-file="${esc(t.filePath)}" data-idx="${i}" data-album="${t.albumId}">
            ${artThumb}
            <div class="str-track-info">
              <div class="str-track-title">${esc(t.title)}</div>
              <div class="str-track-artist">${esc(t.albumArtist)}</div>
            </div>
            <span class="str-track-dur">${fmtDur(t.duration)}</span>
          </div>`
        }).join('')
        html += `</div>`
      }

      html += `</div></div>`
    }

    if (matchAlbums.length > 1 || (!topAlbum && matchAlbums.length)) {
      const startIdx = topAlbum ? 1 : 0
      html += `<div class="search-section" data-section="Albums">
        <div class="section-header"><span class="section-title">Albums</span></div>
        <div class="album-grid">${matchAlbums.slice(startIdx, startIdx + 8).map(albumCard).join('')}</div>
      </div>`
    }
    if (matchArtists.length) {
      html += `<div class="search-section" data-section="Artists">
        <div class="section-header"><span class="section-title">Artists</span></div>
        <div class="artist-pill-list">${matchArtists.map(a => `<div class="artist-pill" data-artist="${esc(a)}">${esc(a)}</div>`).join('')}</div>
      </div>`
    }
    if (matchTracks.length > 4 || (!topAlbum && matchTracks.length)) {
      const startIdx = topAlbum ? 4 : 0
      html += `<div class="search-section" data-section="Songs">
        <div class="section-header"><span class="section-title">Songs</span></div>
        <div class="track-list">
        <div class="track-list-header"><span>#</span><span>Title</span><span style="text-align:right">Duration</span></div>`
      html += matchTracks.slice(startIdx).map((t, i) => `
        <div class="track-row" data-file="${esc(t.filePath)}" data-idx="${i + startIdx}" data-album="${t.albumId}">
          <span class="track-num">${i + startIdx + 1}</span>
          <div class="track-info">
            <div class="track-title">${esc(t.title)}</div>
            <div class="track-artist" data-artist="${esc(t.albumArtist)}">${esc(t.albumArtist)}</div>
          </div>
          <span class="track-dur">${fmtDur(t.duration)}</span>
        </div>`).join('')
      html += `</div></div>`
    }
  } else {
    html += `<div class="empty-wrap"><h2>Nothing in your library for "${esc(query)}"</h2><p>Search Soulseek below to find &amp; download it.</p></div>`
  }

  // YouTube section (async — filled by runYtSearch)
  html += `<div class="search-section" data-section="YouTube" id="yt-section">
    <div class="section-header">
      <span class="section-title">YouTube</span>
      <div class="yt-scope-tabs">
        <button class="yt-scope${ytSearchState.scope === 'music' ? ' active' : ''}" data-scope="music">Music</button>
        <button class="yt-scope${ytSearchState.scope === 'all' ? ' active' : ''}" data-scope="all">All of YouTube</button>
      </div>
    </div>
    <div id="yt-results"><div class="yt-status">Searching YouTube…</div></div>
  </div>`

  // Online quality search section
  const enabledSources = state.qualitySources.filter(s => s.enabled)
  html += `<div class="online-search-section">
    <div class="section-header" style="margin-top:28px">
      <span class="section-title">Download at Highest Quality</span>
    </div>
    <div class="online-search-list" id="online-search-results">${
      enabledSources.length
        ? enabledSources.map(s => `
            <div class="osrc-row" data-source="${esc(s.id)}">
              <span class="osrc-name">${esc(s.name)}</span>
              <span class="osrc-status searching">Searching…</span>
            </div>`).join('')
        : `<div class="osrc-empty">No sources enabled. Add sources in the sidebar.</div>`
    }
    <div id="slsk-section">${renderSoulseekRow(query)}</div>
    </div>
  </div>`

  html += `</div>`
  setContent(html)
  bindContentEvents()

  // Wire up filter tabs
  document.querySelectorAll('#search-tabs .search-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#search-tabs .search-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const active = tab.dataset.tab
      document.querySelectorAll('.search-section').forEach(sec => {
        if (sec.id === 'yt-section') {
          // YouTube has its own Songs/Albums/Artists/Playlists sub-sections
          sec.hidden = active !== 'All' && !['Songs', 'Albums', 'Artists', 'Playlists'].includes(active)
        } else {
          sec.hidden = active !== 'All' && sec.dataset.section !== active
        }
      })
      _applyYtFilter()
    })
  })

  // YouTube scope tabs (Music / All of YouTube)
  document.querySelectorAll('.yt-scope').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.yt-scope').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      runYtSearch(query, tab.dataset.scope)
    })
  })

  const sameQuery  = slsk.lastQuery === query
  const hasResults = slsk.results.length > 0
  if (enabledSources.length) {
    if (sameQuery && _onlineCache.has(query) && hasResults) {
      _restoreOnlineCache(query, enabledSources)
    } else {
      runOnlineSearch(query, enabledSources)
    }
  }
  bindSlskSearchEvents(query)
  if (!sameQuery || !slsk.searched || (!slsk.searching && !hasResults)) {
    runSlskSearch(query)
  } else {
    const navQ = document.getElementById('nav-search-query')
    if (navQ) navQ.textContent = query
    const section = document.getElementById('slsk-section')
    if (section) { section.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }
  }
  runYtSearch(query, ytSearchState.scope)
}

// ── YouTube search section ──────────────────────────────────────────────────
const ytSearchState = { scope: 'music', cache: new Map(), lastQuery: null, showTopResult: false }

function _activeSearchTab() {
  return document.querySelector('#search-tabs .search-tab.active')?.dataset.tab || 'All'
}

function _applyYtFilter() {
  const active = _activeSearchTab()
  document.querySelectorAll('.yt-sub').forEach(sub => {
    sub.hidden = active !== 'All' && sub.dataset.sub !== active
  })
}

function _ytQueueItem(r) {
  return {
    filePath: `https://www.youtube.com/watch?v=${r.videoId}`,
    videoId: r.videoId,
    title: r.title,
    artist: r.artist,
    albumArtist: r.artist,
    albumName: r.album || 'YouTube',
    albumId: `yt_${r.videoId}`,
    artPath: r.thumbnailUrl || null,
    duration: r.duration || 0,
    albumBrowseId: r.albumBrowseId || null,
    channelId: r.channelId || null,
  }
}

// ── YT saves: likes / follows / saved albums / recents ──────────────────────
function watchUrl(videoId) { return `https://www.youtube.com/watch?v=${videoId}` }
function isHttpPath(p) { return /^https?:\/\//.test(p || '') }

function isYtLiked(videoId) { return state.ytLiked.some(t => t.videoId === videoId) }
function toggleYtLike(track) {
  const i = state.ytLiked.findIndex(t => t.videoId === track.videoId)
  let liked
  if (i >= 0) { state.ytLiked.splice(i, 1); liked = false }
  else {
    state.ytLiked.unshift({
      videoId: track.videoId, title: track.title, artist: track.artist,
      album: track.album || null, duration: track.duration || 0,
      thumbnailUrl: track.thumbnailUrl || null,
      albumBrowseId: track.albumBrowseId || null, channelId: track.channelId || null,
      likedAt: Date.now(),
    })
    liked = true
  }
  window.api.saveYtLiked(state.ytLiked)
  return liked
}

function isYtFollowed(channelId) { return state.ytFollowed.some(a => a.channelId === channelId) }
function toggleYtFollow(artist) {
  const i = state.ytFollowed.findIndex(a => a.channelId === artist.channelId)
  let following
  if (i >= 0) { state.ytFollowed.splice(i, 1); following = false }
  else {
    state.ytFollowed.unshift({
      channelId: artist.channelId, name: artist.name,
      thumbnailUrl: artist.thumbnailUrl || null, followedAt: Date.now(),
    })
    following = true
  }
  window.api.saveYtFollowed(state.ytFollowed)
  return following
}

function isYtAlbumSaved(browseId) { return state.ytSavedAlbums.some(a => a.browseId === browseId) }
function toggleYtSaveAlbum(album) {
  const i = state.ytSavedAlbums.findIndex(a => a.browseId === album.browseId)
  let saved
  if (i >= 0) { state.ytSavedAlbums.splice(i, 1); saved = false }
  else { state.ytSavedAlbums.unshift({ ...album, savedAt: Date.now() }); saved = true }
  window.api.saveYtSavedAlbums(state.ytSavedAlbums)
  return saved
}

function recordYtRecent(qItem) {
  if (!qItem || !isHttpPath(qItem.filePath)) return
  state.ytRecent = [
    { albumId: qItem.albumId, name: qItem.albumName, artist: qItem.artist,
      artUrl: qItem.artPath, filePath: qItem.filePath, title: qItem.title, playedAt: Date.now() },
    ...state.ytRecent.filter(x => x.albumId !== qItem.albumId),
  ].slice(0, 20)
  window.api.saveYtRecent(state.ytRecent)
}

async function runYtSearch(query, scope) {
  ytSearchState.scope = scope
  ytSearchState.lastQuery = query
  const box = document.getElementById('yt-results')
  if (!box) return
  const cacheKey = `${scope}::${query}`
  if (ytSearchState.cache.has(cacheKey)) {
    renderYtResults(ytSearchState.cache.get(cacheKey), query)
    return
  }
  box.innerHTML = `<div class="yt-status">Searching YouTube…</div>`
  const call = scope === 'music' ? window.api.ytMusicSearchFull : window.api.ytSearch
  const res = await call({ query }).catch(e => ({ ok: false, error: String(e) }))
  // Stale response guard — user typed a new query or switched scope meanwhile
  if (ytSearchState.lastQuery !== query || ytSearchState.scope !== scope) return
  if (!res.ok) {
    const cur = document.getElementById('yt-results')
    if (cur) cur.innerHTML = `<div class="yt-status yt-error">YouTube search failed: ${esc(res.error || 'unknown error')}</div>`
    return
  }
  ytSearchState.cache.set(cacheKey, res.results)
  renderYtResults(res.results, query)
}

function _ytSongRows(songs) {
  return `<div class="yt-list">${songs.map((r, i) => `
    <div class="yt-row" data-i="${i}">
      ${r.thumbnailUrl
        ? `<img class="yt-thumb" src="${esc(r.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="yt-thumb yt-thumb-empty"></div>`}
      <div class="yt-info">
        <div class="yt-title">${esc(r.title)} <span class="yt-badge">YT</span></div>
        <div class="yt-sub-line">${esc(r.artist)}${r.album ? ' · ' + esc(r.album) : ''}${r.viewCount ? ' · ' + esc(r.viewCount) : ''}</div>
      </div>
      <span class="yt-dur">${r.duration ? fmtDur(r.duration) : ''}</span>
      <div class="yt-actions">
        <button class="yt-btn yt-play" data-i="${i}" title="Stream now">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="yt-btn yt-queue" data-i="${i}" title="Add to queue">+</button>
        <button class="yt-btn yt-like${isYtLiked(r.videoId) ? ' liked' : ''}" data-i="${i}" title="${isYtLiked(r.videoId) ? 'Unlike' : 'Like'}">${isYtLiked(r.videoId) ? '♥' : '♡'}</button>
        <button class="yt-btn yt-dl" data-i="${i}" title="Download">
          <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
      </div>
    </div>`).join('')}</div>`
}

function _ytAlbumCard(a) {
  const hue = _cardHue((a.artist || '') + (a.title || ''))
  return `<div class="album-card yt-album-card" data-browse="${esc(a.browseId)}">
    <div class="album-card-art-wrap">
      ${a.thumbnailUrl
        ? `<img class="album-card-art" src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-card-art-fallback" ${a.thumbnailUrl ? 'style="display:none"' : `style="background:linear-gradient(135deg,hsl(${hue},55%,22%) 0%,hsl(${(hue+40)%360},45%,14%) 100%)"`}>
        <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
      </div>
      <span class="yt-badge yt-card-badge">YT</span>
    </div>
    <div class="album-card-name">${esc(a.title)}</div>
    <div class="album-card-meta">${esc(a.year || '')}${a.year && a.artist ? ' · ' : ''}${esc(a.artist || '')}</div>
  </div>`
}

function _ytArtistCard(a) {
  return `<div class="artist-card yt-artist-card" data-channel="${esc(a.channelId)}">
    <div class="artist-card-art">
      ${a.thumbnailUrl
        ? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="artist-card-art-fallback" ${a.thumbnailUrl ? 'style="display:none"' : ''}>
        <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
      </div>
    </div>
    <div class="artist-card-name">${esc(a.name)}</div>
    <div class="artist-card-meta">${esc((a.subtitle || 'Artist').split('•')[0].trim())} · YT</div>
  </div>`
}

function _ytPlaylistCard(p) {
  const hue = _cardHue((p.author || '') + (p.title || ''))
  return `<div class="album-card yt-playlist-card" data-playlist="${esc(p.playlistId)}">
    <div class="album-card-art-wrap">
      ${p.thumbnailUrl
        ? `<img class="album-card-art" src="${esc(p.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-card-art-fallback" ${p.thumbnailUrl ? 'style="display:none"' : `style="background:linear-gradient(135deg,hsl(${hue},55%,22%) 0%,hsl(${(hue+40)%360},45%,14%) 100%)"`}>
        <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
      </div>
      <span class="yt-badge yt-card-badge">YT</span>
    </div>
    <div class="album-card-name">${esc(p.title)}</div>
    <div class="album-card-meta">Playlist${p.author ? ' · ' + esc(p.author) : ''}${p.songCount ? ' · ' + esc(p.songCount) : ''}</div>
  </div>`
}

function _ytTopResultCard(r, query) {
  // Spotify-style: prefer the artist when the query is (close to) their name
  const artistHit = r.artists?.[0] && r.artists[0].name.toLowerCase().includes(query.toLowerCase().trim())
  if (artistHit) {
    const a = r.artists[0]
    return `<div class="search-top-result yt-top-result" data-channel="${esc(a.channelId)}">
      <div class="str-label">Top Result</div>
      <div class="str-art yt-str-art-round" style="${a.thumbnailUrl ? `background:url('${esc(a.thumbnailUrl)}') center/cover no-repeat` : ''}"></div>
      <div class="str-name">${esc(a.name)}</div>
      <div class="str-artist">Artist · YouTube</div>
    </div>`
  }
  const s = r.songs?.[0]
  if (!s) return ''
  return `<div class="search-top-result yt-top-result" data-i="0">
    <div class="str-label">Top Result</div>
    <div class="str-art" style="${s.thumbnailUrl ? `background:url('${esc(s.thumbnailUrl)}') center/cover no-repeat` : ''}"></div>
    <div class="str-name">${esc(s.title)}</div>
    <div class="str-artist">${esc(s.artist)} · Song · YouTube</div>
    <button class="str-play album-card-play yt-top-play" data-i="0">
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </button>
  </div>`
}

function renderYtResults(results, query) {
  const box = document.getElementById('yt-results')
  if (!box) return

  // "All of YouTube" scope — flat video list, counts as Songs for the filter tabs
  if (Array.isArray(results)) {
    if (!results.length) {
      box.innerHTML = `<div class="yt-status">Nothing on YouTube for "${esc(query)}"</div>`
      return
    }
    box.innerHTML = `<div class="yt-sub" data-sub="Songs">
      <div class="yt-sub-header">Videos <button class="yt-see-all" data-kind="video">See all</button></div>
      ${_ytSongRows(results)}</div>`
    bindYtEvents(results)
    _bindYtSeeAll(box)
    _applyYtFilter()
    return
  }

  // Music scope — Spotify-style entity sections
  const { songs = [], albums = [], artists = [], playlists = [] } = results
  if (!songs.length && !albums.length && !artists.length && !playlists.length) {
    box.innerHTML = `<div class="yt-status">Nothing on YouTube Music for "${esc(query)}"</div>`
    return
  }
  let html = ''
  if (ytSearchState.showTopResult) {
    html += `<div class="yt-sub yt-top-wrap" data-sub="All">${_ytTopResultCard(results, query)}</div>`
  }
  if (songs.length) {
    html += `<div class="yt-sub" data-sub="Songs">
      <div class="yt-sub-header">Songs <button class="yt-see-all" data-kind="song">See all</button></div>
      ${_ytSongRows(songs)}
    </div>`
  }
  if (artists.length) {
    html += `<div class="yt-sub" data-sub="Artists">
      <div class="yt-sub-header">Artists <button class="yt-see-all" data-kind="artist">See all</button></div>
      <div class="artist-grid yt-artist-grid">${artists.map(_ytArtistCard).join('')}</div>
    </div>`
  }
  if (albums.length) {
    html += `<div class="yt-sub" data-sub="Albums">
      <div class="yt-sub-header">Albums <button class="yt-see-all" data-kind="album">See all</button></div>
      <div class="album-grid">${albums.map(_ytAlbumCard).join('')}</div>
    </div>`
  }
  if (playlists.length) {
    html += `<div class="yt-sub" data-sub="Playlists">
      <div class="yt-sub-header">Playlists <button class="yt-see-all" data-kind="playlist">See all</button></div>
      <div class="album-grid">${playlists.map(_ytPlaylistCard).join('')}</div>
    </div>`
  }
  box.innerHTML = html
  bindYtEvents(songs)
  _bindYtEntityEvents(results)
  _bindYtSeeAll(box)
  _applyYtFilter()
}

function _bindYtSeeAll(box) {
  box.querySelectorAll('.yt-see-all').forEach(btn => btn.addEventListener('click', () => {
    navigate('yt-see-all', `${btn.dataset.kind}::${ytSearchState.lastQuery}`)
  }))
}

function _bindYtEntityEvents(results) {
  const box = document.getElementById('yt-results')
  if (!box) return
  box.querySelectorAll('.yt-album-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-album', card.dataset.browse)
  }))
  box.querySelectorAll('.yt-artist-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-artist', card.dataset.channel)
  }))
  box.querySelectorAll('.yt-playlist-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-playlist', card.dataset.playlist)
  }))
  const top = box.querySelector('.yt-top-result')
  if (top) {
    top.addEventListener('click', () => {
      if (top.dataset.channel) navigate('yt-artist', top.dataset.channel)
    })
    top.querySelector('.yt-top-play')?.addEventListener('click', e => {
      e.stopPropagation()
      const s = results.songs?.[0]
      if (!s) return
      state.queue = [_ytQueueItem(s)]
      state.queueIndex = 0
      playCurrentTrack()
    })
  }
}

async function ytRowContextMenu(r) {
  const liked = isYtLiked(r.videoId)
  const items = [
    { label: 'Play now', action: 'play' },
    { label: 'Play next', action: 'playnext' },
    { label: 'Add to queue', action: 'queue' },
    { label: liked ? 'Unlike' : 'Like', action: 'like' },
    { label: 'Add to playlist…', action: 'addpl' },
  ]
  if (r.albumBrowseId) items.push({ label: 'Go to album', action: 'goalbum' })
  if (r.channelId) items.push({ label: 'Go to artist', action: 'goartist' })
  items.push({ label: 'Download', action: 'download' })
  const action = await window.api.ctxMenuShow(items)
  if (action === 'play') { state.queue = [_ytQueueItem(r)]; state.queueIndex = 0; playCurrentTrack() }
  else if (action === 'playnext') { state.queue.splice(state.queueIndex + 1, 0, _ytQueueItem(r)); updateNextPrefetch() }
  else if (action === 'queue') { state.queue.push(_ytQueueItem(r)); updateNextPrefetch() }
  else if (action === 'like') toggleYtLike(r)
  else if (action === 'addpl') showAddToPlaylistModal([_ytQueueItem(r)])
  else if (action === 'goalbum') navigate('yt-album', r.albumBrowseId)
  else if (action === 'goartist') navigate('yt-artist', r.channelId)
  else if (action === 'download') window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
  return action
}

function renderLikeButtons(box, results) {
  box.querySelectorAll('.yt-like').forEach(btn => {
    const r = results[parseInt(btn.dataset.i)]
    if (!r) return
    const liked = isYtLiked(r.videoId)
    btn.classList.toggle('liked', liked)
    btn.textContent = liked ? '♥' : '♡'
    btn.title = liked ? 'Unlike' : 'Like'
  })
}

function bindYtEvents(results, rootEl) {
  const box = rootEl || document.getElementById('yt-results')
  if (!box) return
  box.querySelectorAll('.yt-row').forEach(row => row.addEventListener('click', () => {
    const r = results[parseInt(row.dataset.i)]
    state.queue = [_ytQueueItem(r)]
    state.queueIndex = 0
    playCurrentTrack()
  }))
  box.querySelectorAll('.yt-play').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    state.queue = [_ytQueueItem(r)]
    state.queueIndex = 0
    playCurrentTrack()
  }))
  box.querySelectorAll('.yt-queue').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    state.queue.push(_ytQueueItem(r))
    updateNextPrefetch()
    if (state.queuePanelOpen) renderQueuePanel()
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = '+' }, 1200)
  }))
  box.querySelectorAll('.yt-like').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    const liked = toggleYtLike(r)
    btn.classList.toggle('liked', liked)
    btn.textContent = liked ? '♥' : '♡'
    btn.title = liked ? 'Unlike' : 'Like'
  }))
  box.querySelectorAll('.yt-dl').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    btn.disabled = true
    btn.innerHTML = '…'
    await window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
  }))
  box.querySelectorAll('.yt-row').forEach(row => row.addEventListener('contextmenu', async e => {
    e.preventDefault()
    const r = results[parseInt(row.dataset.i)]
    const action = await ytRowContextMenu(r)
    if (action === 'like') renderLikeButtons(box, results)
  }))
}

// ── YouTube album page ──────────────────────────────────────────────────────
function _ytAlbumTrackItem(al, t) {
  return {
    filePath: `https://www.youtube.com/watch?v=${t.videoId}`,
    title: t.title,
    artist: al.artist,
    albumArtist: al.artist,
    albumName: al.title,
    albumId: `yt_${al.browseId}`,
    artPath: al.thumbnailUrl || null,
    duration: t.duration || 0,
  }
}

async function renderYtAlbum(browseId) {
  // Saved albums open instantly from the stored snapshot; a background fetch
  // refreshes the page only if the data actually changed.
  const snap = state.ytSavedAlbums.find(a => a.browseId === browseId)
  if (snap) _paintYtAlbum(snap)
  else setContent(`<div class="page"><div class="yt-status">Loading album from YouTube…</div></div>`)
  const res = await window.api.ytAlbum({ browseId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-album') return
  if (!res.ok) {
    // A stale snapshot beats an error page
    if (!snap) setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load album: ${esc(res.error || 'unknown error')}</div></div>`)
    return
  }
  const changed = !snap
    || JSON.stringify({ ...snap, savedAt: 0 }) !== JSON.stringify({ ...res.album, savedAt: 0 })
  if (changed) _paintYtAlbum(res.album)
}

function _paintYtAlbum(al) {
  const colors = ['#5038a0','#a04038','#2d7a4a','#3850a0','#a07038','#6b38a0','#1a5a7a','#7a1a4a']
  const color = colors[Math.abs(_cardHue(al.title + al.artist)) % colors.length]

  const trackRows = al.tracks.map((t, i) => `
    <div class="track-row yt-track-row" data-i="${i}">
      <span class="track-num">${t.index}</span>
      <div class="track-info">
        <div class="track-title">${esc(t.title)}</div>
        <div class="track-artist">${esc(al.artist)}</div>
      </div>
      <button class="yt-btn yt-track-dl" data-i="${i}" title="Download">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      </button>
      <span class="track-dur">${t.duration ? fmtDur(t.duration) : ''}</span>
    </div>`).join('')

  setContent(`
    <div class="album-hero" style="background: linear-gradient(${color}cc, var(--bg) 100%)">
      <img class="album-hero-art" src="${esc(al.thumbnailUrl || '')}" alt="" ${!al.thumbnailUrl ? 'style="display:none"' : ''} onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="album-hero-art-fallback" ${al.thumbnailUrl ? 'style="display:none"' : ''}><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Album <span class="yt-badge">YT</span></div>
        <div class="album-hero-title">${esc(al.title)}</div>
        <div class="album-hero-meta">
          <span>${esc(al.artist)}</span>
          ${al.year ? `&bull; ${esc(al.year)}` : ''} ${al.summary ? `&bull; ${esc(al.summary)}` : ''}
        </div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="yt-album-play-btn" title="Play all">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn yt-album-dl-btn" id="yt-album-dl-btn" title="Download album">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      </button>
      <button class="ctrl-btn yt-album-save-btn${isYtAlbumSaved(al.browseId) ? ' saved' : ''}" id="yt-album-save-btn" title="${isYtAlbumSaved(al.browseId) ? 'Remove from library' : 'Save to library'}">${isYtAlbumSaved(al.browseId) ? '♥' : '♡'}</button>
      <span class="yt-album-dl-note" id="yt-album-dl-note"></span>
    </div>
    <div class="track-list">
      <div class="track-list-header"><span>#</span><span>Title</span><span style="text-align:right">Duration</span></div>
      ${trackRows}
    </div>`)

  const queueFrom = (i) => {
    state.queue = al.tracks.slice(i).map(t => _ytAlbumTrackItem(al, t))
    state.queueIndex = 0
    playCurrentTrack()
  }
  document.getElementById('yt-album-play-btn')?.addEventListener('click', () => queueFrom(0))
  document.getElementById('yt-album-dl-btn')?.addEventListener('click', async () => {
    const note = document.getElementById('yt-album-dl-note')
    if (note) note.textContent = `Queuing ${al.tracks.length} downloads…`
    for (const t of al.tracks) {
      await window.api.ytDownload({
        videoId: t.videoId, title: t.title, artist: al.artist,
        subdir: `${al.artist} - ${al.title}`,
      })
    }
    if (note) note.textContent = `${al.tracks.length} tracks queued — see Downloads`
    _scheduleLibRescan()
  })
  document.querySelectorAll('.yt-track-row').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('.yt-track-dl')) return
    queueFrom(parseInt(row.dataset.i))
  }))
  document.querySelectorAll('.yt-track-dl').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const t = al.tracks[parseInt(btn.dataset.i)]
    btn.disabled = true
    window.api.ytDownload({ videoId: t.videoId, title: t.title, artist: al.artist, subdir: `${al.artist} - ${al.title}` })
  }))
  document.getElementById('yt-album-save-btn')?.addEventListener('click', () => {
    const saved = toggleYtSaveAlbum(al)
    const b = document.getElementById('yt-album-save-btn')
    if (b) { b.classList.toggle('saved', saved); b.textContent = saved ? '♥' : '♡'; b.title = saved ? 'Remove from library' : 'Save to library' }
  })
}

// ── YouTube artist page ─────────────────────────────────────────────────────
// ── YouTube playlist page ───────────────────────────────────────────────────
function sanitizePathSegment(s) { return String(s || '').replace(/[\/\\:*?"<>|]/g, '_').trim() }

function _ytPlTrackToQueueItem(pl, t) {
  return {
    filePath: watchUrl(t.videoId),
    videoId: t.videoId,
    title: t.title,
    artist: t.artist,
    albumArtist: t.artist,
    albumName: t.album || pl.title,
    albumId: `yt_${t.videoId}`,
    artPath: t.thumbnailUrl || pl.thumbnailUrl || null,
    duration: t.duration || 0,
    albumBrowseId: t.albumBrowseId || null,
    channelId: t.channelId || null,
  }
}

async function renderYtPlaylist(playlistId) {
  setContent(`<div class="page"><div class="yt-status">Loading playlist from YouTube…</div></div>`)
  const res = await window.api.ytPlaylist({ playlistId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-playlist') return
  if (!res.ok) {
    setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load playlist: ${esc(res.error || 'unknown error')}</div></div>`)
    return
  }
  const pl = res.playlist
  const colors = ['#5038a0','#a04038','#2d7a4a','#3850a0','#a07038','#6b38a0','#1a5a7a','#7a1a4a']
  const color = colors[Math.abs(_cardHue(pl.title + pl.author)) % colors.length]
  const totalDur = pl.tracks.reduce((s, t) => s + (t.duration || 0), 0)

  setContent(`
    <div class="album-hero" style="background: linear-gradient(${color}cc, var(--bg) 100%)">
      <img class="album-hero-art" src="${esc(pl.thumbnailUrl || '')}" alt="" ${!pl.thumbnailUrl ? 'style="display:none"' : ''} onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="album-hero-art-fallback" ${pl.thumbnailUrl ? 'style="display:none"' : ''}><svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Playlist <span class="yt-badge">YT</span></div>
        <div class="album-hero-title">${esc(pl.title)}</div>
        <div class="album-hero-meta">
          ${pl.author ? `<span>${esc(pl.author)}</span> &bull;` : ''}
          ${pl.tracks.length} song${pl.tracks.length !== 1 ? 's' : ''}${totalDur ? `, ${fmtTime(totalDur)}` : ''}
        </div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="yt-pl-play-btn" title="Play all" ${!pl.tracks.length ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn" id="yt-pl-shuffle-btn" title="Shuffle">
        <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
      </button>
      <button class="ctrl-btn" id="yt-pl-queue-btn" title="Add all to queue">+</button>
      <button class="ctrl-btn" id="yt-pl-dl-btn" title="Download all">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      </button>
      <button class="ctrl-btn" id="yt-pl-save-btn" title="Save to your playlists">
        <svg viewBox="0 0 24 24"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm18-4.5V22l-4-2-4 2V11.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5z"/></svg>
      </button>
      <span class="yt-album-dl-note" id="yt-pl-note"></span>
    </div>
    <div class="track-list">
      <div class="track-list-header"><span>#</span><span>Title</span><span style="text-align:right">Duration</span></div>
      <div id="yt-pl-tracks">${_ytSongRows(pl.tracks)}</div>
    </div>`)

  const toQueue = t => _ytPlTrackToQueueItem(pl, t)
  document.getElementById('yt-pl-play-btn')?.addEventListener('click', () => {
    state.queue = pl.tracks.map(toQueue); state.queueIndex = 0; playCurrentTrack()
  })
  document.getElementById('yt-pl-shuffle-btn')?.addEventListener('click', () => {
    state.queue = pl.tracks.map(toQueue).sort(() => Math.random() - 0.5)
    state.queueIndex = 0; playCurrentTrack()
  })
  document.getElementById('yt-pl-queue-btn')?.addEventListener('click', () => {
    state.queue.push(...pl.tracks.map(toQueue)); updateNextPrefetch()
    const note = document.getElementById('yt-pl-note')
    if (note) { note.textContent = `Added ${pl.tracks.length} to queue`; setTimeout(() => { note.textContent = '' }, 2000) }
  })
  document.getElementById('yt-pl-dl-btn')?.addEventListener('click', () => {
    for (const t of pl.tracks) window.api.ytDownload({ videoId: t.videoId, title: t.title, artist: t.artist, subdir: sanitizePathSegment(pl.title) })
    const note = document.getElementById('yt-pl-note')
    if (note) note.textContent = `Downloading ${pl.tracks.length} tracks…`
  })
  document.getElementById('yt-pl-save-btn')?.addEventListener('click', () => {
    const local = {
      id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: pl.title, tracks: pl.tracks.map(toQueue), createdAt: Date.now(),
    }
    state.playlists.unshift(local)
    window.api.savePlaylist(local)
    navigate('playlist', local.id)
  })
  const tracksEl = document.getElementById('yt-pl-tracks')
  if (tracksEl) bindYtEvents(pl.tracks, tracksEl)
}

// ── YouTube see-all page (paged search results) ─────────────────────────────
const YT_KIND_LABEL = { song: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists', video: 'Videos' }

async function renderYtSeeAll(navId) {
  const sep = navId.indexOf('::')
  const kind = navId.slice(0, sep)
  const query = navId.slice(sep + 2)
  const items = []
  let hasMore = false

  setContent(`<div class="page">
    <div class="section-header"><span class="section-title">${YT_KIND_LABEL[kind] || 'Results'} · “${esc(query)}” <span class="yt-badge">YT</span></span></div>
    <div id="yt-seeall-body"><div class="yt-status">Loading…</div></div>
    <div id="yt-seeall-more"></div>
  </div>`)

  async function loadPage(next) {
    const res = await window.api.ytSearchPage({ kind, query, next }).catch(e => ({ ok: false, error: String(e) }))
    if (state.currentPage !== 'yt-see-all') return
    const body = document.getElementById('yt-seeall-body')
    const moreBox = document.getElementById('yt-seeall-more')
    if (!body) return
    if (!res.ok) {
      const note = `<div class="yt-status yt-error">Couldn't load${next ? ' more' : ''}: ${esc(res.error || 'unknown')} <button class="yt-retry" id="yt-seeall-retry">Retry</button></div>`
      if (next) { moreBox.innerHTML = note } else { body.innerHTML = note }
      document.getElementById('yt-seeall-retry')?.addEventListener('click', () => loadPage(next))
      return
    }
    items.push(...res.items)
    hasMore = res.hasMore
    renderBody()
  }

  function renderBody() {
    const body = document.getElementById('yt-seeall-body')
    const moreBox = document.getElementById('yt-seeall-more')
    if (!body) return
    if (!items.length) { body.innerHTML = `<div class="yt-status">Nothing found.</div>`; moreBox.innerHTML = ''; return }
    if (kind === 'song' || kind === 'video') {
      body.innerHTML = _ytSongRows(items)
      bindYtEvents(items, body)
    } else {
      const card = kind === 'album' ? _ytAlbumCard : kind === 'artist' ? _ytArtistCard : _ytPlaylistCard
      body.innerHTML = `<div class="${kind === 'artist' ? 'artist-grid yt-artist-grid' : 'album-grid'}">${items.map(card).join('')}</div>`
      body.querySelectorAll('.yt-album-card').forEach(c => c.addEventListener('click', () => navigate('yt-album', c.dataset.browse)))
      body.querySelectorAll('.yt-artist-card').forEach(c => c.addEventListener('click', () => navigate('yt-artist', c.dataset.channel)))
      body.querySelectorAll('.yt-playlist-card').forEach(c => c.addEventListener('click', () => navigate('yt-playlist', c.dataset.playlist)))
    }
    moreBox.innerHTML = hasMore ? `<button class="yt-load-more" id="yt-load-more">Load more</button>` : ''
    document.getElementById('yt-load-more')?.addEventListener('click', () => {
      document.getElementById('yt-load-more').textContent = 'Loading…'
      loadPage(true)
    })
  }

  await loadPage(false)
}

async function renderYtArtist(channelId) {
  setContent(`<div class="page"><div class="yt-status">Loading artist from YouTube…</div></div>`)
  const res = await window.api.ytArtist({ channelId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-artist') return
  if (!res.ok) {
    setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load artist: ${esc(res.error || 'unknown error')}</div></div>`)
    return
  }
  const ar = res.artist

  function albumSection(label, items) {
    if (!items.length) return ''
    return `<div class="album-type-section">
      <div class="album-type-header">${label}</div>
      <div class="album-grid">${items.map(_ytAlbumCard).join('')}</div>
    </div>`
  }

  setContent(`<div>
    <div class="artist-hero">
      <img class="artist-hero-photo loaded" src="${esc(ar.thumbnailUrl || '')}" alt="" ${!ar.thumbnailUrl ? 'style="display:none"' : ''} onerror="this.style.display='none'">
      <div class="artist-hero-name">${esc(ar.name)} <span class="yt-badge">YT</span></div>
      <div class="artist-hero-meta">${ar.albums.length + ar.singles.length} release${(ar.albums.length + ar.singles.length) !== 1 ? 's' : ''} on YouTube Music</div>
      <button class="follow-btn${isYtFollowed(channelId) ? ' following' : ''}" id="yt-follow-btn">${isYtFollowed(channelId) ? 'Following' : 'Follow'}</button>
    </div>
    <div class="page" style="padding-top:16px">
      ${ar.topSongs.length ? `
        <div class="section-header"><span class="section-title">Top songs</span></div>
        <div id="yt-artist-top">${_ytSongRows(ar.topSongs)}</div>` : ''}
      ${albumSection('Albums', ar.albums)}
      ${albumSection('Singles & EPs', ar.singles)}
    </div>
  </div>`)

  // Top songs: play streams from that song onward, +queue, download
  const top = document.getElementById('yt-artist-top')
  if (top) {
    top.querySelectorAll('.yt-play').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation()
      const i = parseInt(btn.dataset.i)
      state.queue = ar.topSongs.slice(i).map(_ytQueueItem)
      state.queueIndex = 0
      playCurrentTrack()
    }))
    top.querySelectorAll('.yt-queue').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation()
      state.queue.push(_ytQueueItem(ar.topSongs[parseInt(btn.dataset.i)]))
      updateNextPrefetch()
      btn.textContent = '✓'
      setTimeout(() => { btn.textContent = '+' }, 1200)
    }))
    top.querySelectorAll('.yt-dl').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation()
      const s = ar.topSongs[parseInt(btn.dataset.i)]
      btn.disabled = true
      btn.innerHTML = '…'
      window.api.ytDownload({ videoId: s.videoId, title: s.title, artist: s.artist })
    }))
  }
  document.querySelectorAll('.yt-album-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-album', card.dataset.browse)
  }))
  document.getElementById('yt-follow-btn')?.addEventListener('click', () => {
    const now = toggleYtFollow({ channelId, name: ar.name, thumbnailUrl: ar.thumbnailUrl })
    const btn = document.getElementById('yt-follow-btn')
    if (btn) { btn.classList.toggle('following', now); btn.textContent = now ? 'Following' : 'Follow' }
  })
}

function renderArtist(artistName) {
  const artistAlbums = state.library.filter(a => a.artist === artistName || a.albumArtist === artistName)
  if (!artistAlbums.length) { navigate('home', null, { skipHistory: true }); return }
  const totalTracks = artistAlbums.reduce((s, a) => s + a.tracks.length, 0)
  const following = state.followedArtists.includes(artistName)

  // Split albums by type
  const albums   = artistAlbums.filter(a => a.tracks.length >= 6)
  const eps      = artistAlbums.filter(a => a.tracks.length >= 3 && a.tracks.length <= 5)
  const singles  = artistAlbums.filter(a => a.tracks.length <= 2)

  function typeSection(label, items) {
    if (!items.length) return ''
    return `<div class="album-type-section">
      <div class="album-type-header">${label}</div>
      <div class="album-grid">${items.map(albumCard).join('')}</div>
    </div>`
  }

  // Related artists: same genre, different artist
  const artistGenres = new Set(artistAlbums.map(a => a.genre).filter(Boolean))
  const related = state.library
    .filter(a => a.artist !== artistName && a.albumArtist !== artistName && a.genre && artistGenres.has(a.genre))
    .reduce((map, a) => { if (!map.has(a.artist)) map.set(a.artist, a); return map }, new Map())
  const relatedArtists = [...related.values()].slice(0, 8)

  const relatedHTML = relatedArtists.length ? `
    <div class="artist-related">
      <div class="section-header"><span class="section-title">Fans also like</span></div>
      <div class="scroll-row">${relatedArtists.map(a => {
        const ct = _artistAlbumCount(a.artist)
        return `<div class="album-card" data-artist="${esc(a.artist)}" style="cursor:pointer">
          ${artImg(a.artPath, 'album-card-art', 'album-card-art-fallback')}
          <div class="album-card-name">${esc(a.artist)}</div>
          <div class="album-card-meta">Artist · ${ct} album${ct!==1?'s':''}</div>
        </div>`
      }).join('')}</div>
    </div>` : ''

  // Derive hero art from first album with artwork
  const heroArtAlbum = artistAlbums.find(a => a.artPath)
  const heroArtSrc = heroArtAlbum ? 'file://' + heroArtAlbum.artPath : ''

  setContent(`<div>
    <div class="artist-hero" id="artist-hero">
      <img class="artist-hero-photo" id="artist-hero-bg-img" src="${heroArtSrc}" alt="" ${heroArtSrc ? 'onload="this.classList.add(\'loaded\')"' : 'style="display:none"'} onerror="this.style.display='none'">
      <img class="artist-portrait" id="artist-portrait-img" src="" alt="" style="display:none" onerror="this.style.display='none'">
      <div class="artist-hero-name">${esc(artistName)}</div>
      <div class="artist-hero-meta">${artistAlbums.length} release${artistAlbums.length !== 1 ? 's' : ''} · ${totalTracks} songs</div>
      <button class="follow-btn ${following ? 'following' : ''}" id="artist-follow-btn" data-artist="${esc(artistName)}">${following ? 'Following' : 'Follow'}</button>
    </div>
    <div class="page" style="padding-top:16px">
      <div class="artist-bio" id="artist-bio"><div class="artist-bio-skeleton"></div></div>
      ${typeSection('Albums', albums)}
      ${typeSection('EPs', eps)}
      ${typeSection('Singles', singles)}
      ${relatedHTML}
    </div>
  </div>`)

  document.getElementById('artist-follow-btn')?.addEventListener('click', () => {
    const now = toggleFollowArtist(artistName)
    const btn = document.getElementById('artist-follow-btn')
    if (btn) { btn.classList.toggle('following', now); btn.textContent = now ? 'Following' : 'Follow' }
  })
  // Related artist cards click
  document.querySelectorAll('[data-artist]').forEach(card => {
    card.addEventListener('click', () => navigate('artist', card.dataset.artist))
  })
  loadArtistBio(artistName)
}

function toggleFollowArtist(artistName) {
  const idx = state.followedArtists.indexOf(artistName)
  let following
  if (idx >= 0) { state.followedArtists.splice(idx, 1); following = false }
  else { state.followedArtists.push(artistName); following = true }
  window.api.saveFollowedArtists(state.followedArtists)
  return following
}

function _artistAlbumCount(artistName) {
  return state.library.filter(a => a.artist === artistName || a.albumArtist === artistName).length
}

function checkFollowedArtistsForNew() {
  let prev = {}
  try { prev = JSON.parse(localStorage.getItem('followedAlbumCounts') || '{}') } catch(_) {}
  const current = {}
  for (const artistName of state.followedArtists) {
    const count = _artistAlbumCount(artistName)
    current[artistName] = count
    if (prev[artistName] != null && count > prev[artistName]) {
      const newAlbum = state.library.filter(a => a.artist === artistName || a.albumArtist === artistName)
        .sort((a, b) => (b.tracks?.[0]?.addedAt || 0) - (a.tracks?.[0]?.addedAt || 0))[0]
      window.api.notifyTrack({ title: 'New music from ' + artistName, artist: newAlbum?.name || '', artPath: newAlbum?.artPath || null })
      showToast(`New album from ${artistName}${newAlbum ? ': ' + newAlbum.name : ''}`)
    }
  }
  try { localStorage.setItem('followedAlbumCounts', JSON.stringify(current)) } catch(_) {}
}

let _toastTimer = null
function showToast(msg) {
  const el = document.getElementById('toast-notification')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

function startRadio(seedTrack, seedArtist, seedGenre) {
  const all = _allLibraryTracks()
  const currentPaths = new Set(state.queue.map(t => t.filePath))
  let candidates = all.filter(t => !currentPaths.has(t.filePath))

  // Score: same artist > same genre > anything
  const radioAlbumGenreMap = new Map(state.library.map(a => [a.id, a.genre]))
  const scored = candidates.map(t => {
    let score = 0
    if (seedArtist && (t.albumArtist === seedArtist || t.artist === seedArtist)) score += 10
    if (seedGenre && radioAlbumGenreMap.get(t.albumId) === seedGenre) score += 5
    score += Math.random() * 3  // shuffle within tiers
    return { t, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const radio = scored.slice(0, 25).map(x => x.t)
  if (!radio.length) { showToast('Not enough tracks in library for radio'); return }

  if (state.queue.length && state.queueIndex >= 0) {
    // Append after current track
    state.queue.splice(state.queueIndex + 1, 0, ...radio)
  } else {
    state.queue = radio
    state.queueIndex = 0
    playCurrentTrack()
  }
  showToast(`Radio: ${radio.length} tracks queued`)
  syncExtension()
  if (state.queuePanelOpen) renderQueuePanel()
}

async function loadArtistBio(artistName) {
  const PREVIEW_LEN = 320
  const render = (data) => {
    const el = document.getElementById('artist-bio')
    if (!el) return
    if (!data || !data.extract) { el.style.display = 'none'; return }

    // Update hero with Wikipedia photo
    if (data.thumbnail) {
      const portrait = document.getElementById('artist-portrait-img')
      if (portrait) {
        portrait.src = data.thumbnail
        portrait.style.display = ''
        portrait.onload = () => portrait.classList.add('loaded')
      }
      const bgImg = document.getElementById('artist-hero-bg-img')
      if (bgImg) {
        bgImg.src = data.thumbnail
        bgImg.onload = () => bgImg.classList.add('loaded')
      }
    }

    const full = data.extract
    const isLong = full.length > PREVIEW_LEN
    const preview = isLong ? full.slice(0, PREVIEW_LEN).trim() + '…' : full

    el.innerHTML = `
      <div class="artist-bio-text">
        <div class="artist-bio-heading">About</div>
        <p class="artist-bio-preview">${esc(preview)}</p>
        ${isLong ? `<p class="artist-bio-full" style="display:none">${esc(full)}</p>
        <button class="artist-bio-expand-btn" id="artist-bio-expand">Show more</button>` : ''}
      </div>`

    if (isLong) {
      document.getElementById('artist-bio-expand')?.addEventListener('click', (e) => {
        const btn = e.currentTarget
        const preview = el.querySelector('.artist-bio-preview')
        const fullEl = el.querySelector('.artist-bio-full')
        const expanded = fullEl.style.display !== 'none'
        preview.style.display = expanded ? '' : 'none'
        fullEl.style.display = expanded ? 'none' : ''
        btn.textContent = expanded ? 'Show more' : 'Show less'
      })
    }
  }
  if (_bioCache.has(artistName)) { render(_bioCache.get(artistName)); return }
  try {
    const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(artistName))
    if (!res.ok) throw new Error('no bio')
    const json = await res.json()
    const data = { extract: json.extract || null, thumbnail: json.thumbnail?.source || null }
    _bioCache.set(artistName, data)
    if (state.currentPage === 'artist' && state.currentArtistName === artistName) render(data)
  } catch (_) {
    _bioCache.set(artistName, null)
    if (state.currentPage === 'artist' && state.currentArtistName === artistName) render(null)
  }
}

// ── Playlists ────────────────────────────────────────────────────────────────
function _plArtPaths(pl) {
  const paths = []
  for (const t of (pl.tracks || [])) {
    if (t.artPath && !paths.includes(t.artPath)) paths.push(t.artPath)
    if (paths.length >= 4) break
  }
  return paths
}

function _plCollage(pl, cls) {
  const paths = _plArtPaths(pl)
  const note = `<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
  if (!paths.length) {
    const hue = _cardHue(pl.name || pl.id)
    return `<div class="${cls} pl-collage-empty" style="background:linear-gradient(135deg,hsl(${hue},55%,24%),hsl(${(hue+40)%360},45%,15%))">${note}</div>`
  }
  const artUrl = p => (isHttpPath(p) ? p : `file://${p}`)
  if (paths.length < 4) {
    return `<div class="${cls}" style="background:url('${artUrl(paths[0])}') center/cover no-repeat"></div>`
  }
  return `<div class="${cls} pl-collage-grid">${paths.slice(0,4).map(p => `<div style="background:url('${artUrl(p)}') center/cover no-repeat"></div>`).join('')}</div>`
}

function _plTotalDur(pl) {
  return (pl.tracks || []).reduce((s, t) => s + (t.duration || 0), 0)
}

function renderPlaylists() {
  const cards = state.playlists.map(pl => `
    <div class="pl-card" data-pl="${esc(pl.id)}">
      ${_plCollage(pl, 'pl-card-art')}
      <div class="pl-card-name">${esc(pl.name)}</div>
      <div class="pl-card-meta">${(pl.tracks || []).length} song${(pl.tracks || []).length !== 1 ? 's' : ''}</div>
    </div>`).join('')

  setContent(`<div class="page">
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <h1 class="section-title">Playlists</h1>
        <span class="lib-count">${state.playlists.length} playlist${state.playlists.length !== 1 ? 's' : ''}</span>
        <button class="rescan-btn" id="pl-new-btn" style="margin-left:auto">
          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          New playlist
        </button>
      </div>
    </div>
    ${state.playlists.length
      ? `<div class="pl-grid">${cards}</div>`
      : `<div class="pl-empty-state">
          <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
          <p>No playlists yet. Create one to get started.</p>
        </div>`}
  </div>`)

  document.getElementById('pl-new-btn')?.addEventListener('click', () => {
    showNameInputModal('New playlist', 'Playlist name…', name => {
      const pl = { id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name, tracks: [], createdAt: Date.now() }
      state.playlists.unshift(pl)
      window.api.savePlaylist(pl)
      navigate('playlist', pl.id)
    })
  })

  document.querySelectorAll('.pl-card[data-pl]').forEach(card => {
    card.addEventListener('click', () => navigate('playlist', card.dataset.pl))
  })
}

function renderPlaylist(id, sortKey = 'default') {
  const pl = state.playlists.find(p => p.id === id)
  if (!pl) { navigate('playlists', null, { skipHistory: true }); return }
  let tracks = [...(pl.tracks || [])]
  if (sortKey === 'title') tracks.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  else if (sortKey === 'artist') tracks.sort((a, b) => (a.albumArtist || a.artist || '').localeCompare(b.albumArtist || b.artist || ''))
  const totalDur = tracks.reduce((s, t) => s + (t.duration || 0), 0)
  const colors = ['#5038a0','#a04038','#2d7a4a','#3850a0','#a07038','#6b38a0','#1a5a7a','#7a1a4a']
  const color = colors[parseInt((id.replace(/\D/g,'0').slice(-2) || '0'), 10) % colors.length]

  // Recommended tracks: same genre or artist as playlist tracks (local only —
  // YT rows have no library albumId/genre to match against)
  const localTracks = tracks.filter(t => !isHttpPath(t.filePath))
  const plArtists = new Set(localTracks.map(t => t.albumArtist || t.artist).filter(Boolean))
  const plGenres  = new Set(localTracks.map(t => {
    const a = state.library.find(x => x.id === t.albumId); return a?.genre
  }).filter(Boolean))
  const plPaths = new Set(tracks.map(t => t.filePath))
  const plAlbumGenreMap = new Map(state.library.map(a => [a.id, a.genre]))
  const recs = _allLibraryTracks()
    .filter(t => !plPaths.has(t.filePath) && (
      plArtists.has(t.albumArtist || t.artist) ||
      (t.albumId && plGenres.has(plAlbumGenreMap.get(t.albumId)))
    ))
    .sort(() => Math.random() - 0.5)
    .slice(0, 6)

  const isSorted = sortKey !== 'default'
  const trackRows = tracks.map((t, i) => {
    const isPlaying = isCurrentTrack(t.filePath)
    // In default order: use position index for up/down/remove (maps to pl.tracks)
    // In sorted view: hide reorder buttons, use filePath for remove
    const actions = isSorted
      ? `<button class="pl-track-btn" data-pl-remove-fp="${esc(t.filePath)}" title="Remove">
           <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
         </button>`
      : `<button class="pl-track-btn" data-pl-up="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>
           <svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5z"/></svg>
         </button>
         <button class="pl-track-btn" data-pl-down="${i}" title="Move down" ${i === tracks.length - 1 ? 'disabled' : ''}>
           <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
         </button>
         <button class="pl-track-btn" data-pl-remove="${i}" title="Remove">
           <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
         </button>`
    return `
      <div class="track-row pl-track-row ${isPlaying ? 'playing' : ''}" data-pl-idx="${i}">
        <span class="track-num">${isPlaying
          ? '<div class="playing-bars"><span></span><span></span><span></span></div>'
          : (i + 1)}</span>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}${isHttpPath(t.filePath) ? ' <span class="yt-badge">YT</span>' : ''}</div>
          <div class="track-artist" data-artist="${esc(t.albumArtist || t.artist || '')}">${esc(t.albumArtist || t.artist || '')}</div>
        </div>
        <span class="track-dur">${fmtDur(t.duration)}</span>
        <div class="pl-track-actions">${actions}</div>
      </div>`
  }).join('')

  const recHTML = recs.length ? `
    <div class="recommended-section">
      <div class="section-header"><span class="section-title">Recommended</span><span class="section-meta" style="font-size:11px;color:var(--text3);margin-left:8px">Based on this playlist</span></div>
      <div class="track-list">
        ${recs.map((t, i) => `
          <div class="track-row" data-file="${esc(t.filePath)}" data-idx="${i}" data-album="${esc(t.albumId||'')}">
            <span class="track-num">${i+1}</span>
            <div class="track-info">
              <div class="track-title">${esc(t.title)}</div>
              <div class="track-artist">${esc(t.albumArtist || t.artist || '')}</div>
            </div>
            <button class="queue-suggestion-add" data-add-track="${esc(t.filePath)}" title="Add to playlist">
              <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
            <span class="track-dur">${fmtDur(t.duration)}</span>
          </div>`).join('')}
      </div>
    </div>` : ''

  setContent(`
    <div class="album-hero pl-hero" style="background: linear-gradient(${color}cc, var(--bg) 100%)">
      ${_plCollage(pl, 'album-hero-art pl-hero-art')}
      <div class="album-hero-info">
        <div class="album-hero-type">Playlist</div>
        <div class="album-hero-title">${esc(pl.name)}</div>
        <div class="album-hero-meta">${pl.tracks.length} song${pl.tracks.length !== 1 ? 's' : ''}${pl.tracks.length ? `, ${fmtTime(totalDur)}` : ''}</div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="pl-play-btn" ${!tracks.length ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn" id="pl-rename-btn" title="Rename">
        <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      </button>
      <button class="ctrl-btn" id="pl-delete-btn" title="Delete playlist">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
    </div>
    <div class="pl-sort-row">
      <span class="pl-sort-label">Sort:</span>
      <button class="pl-sort-btn${sortKey==='default'?' active':''}" data-sort="default">Default</button>
      <button class="pl-sort-btn${sortKey==='title'?' active':''}" data-sort="title">Title</button>
      <button class="pl-sort-btn${sortKey==='artist'?' active':''}" data-sort="artist">Artist</button>
    </div>
    <div class="track-list">
      ${tracks.length
        ? trackRows
        : '<div class="pl-empty-state" style="padding:40px 0"><p>This playlist is empty. Add songs from albums or the context menu.</p></div>'}
    </div>
    ${recHTML}`)

  document.getElementById('pl-play-btn')?.addEventListener('click', () => {
    if (!tracks.length) return
    state.queue = tracks.map(t => ({ ...t }))
    state.queueIndex = 0
    playCurrentTrack()
  })

  document.getElementById('pl-rename-btn')?.addEventListener('click', () => {
    showNameInputModal('Rename playlist', pl.name, name => {
      pl.name = name
      window.api.savePlaylist(pl)
      renderPlaylist(id)
    })
  })

  document.getElementById('pl-delete-btn')?.addEventListener('click', () => {
    if (!confirm(`Delete playlist "${pl.name}"?`)) return
    state.playlists = state.playlists.filter(p => p.id !== id)
    window.api.deletePlaylist(id)
    navigate('playlists', null, { skipHistory: true })
  })

  document.querySelectorAll('.pl-track-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.pl-track-actions')) return
      const idx = parseInt(row.dataset.plIdx)
      if (!tracks[idx]) return
      state.queue = tracks.slice(idx).map(t => ({ ...t }))
      state.queueIndex = 0
      playCurrentTrack()
    })
  })

  document.querySelectorAll('[data-pl-up]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const i = parseInt(btn.dataset.plUp)
      if (i <= 0) return
      ;[pl.tracks[i - 1], pl.tracks[i]] = [pl.tracks[i], pl.tracks[i - 1]]
      window.api.savePlaylist(pl)
      renderPlaylist(id)
    })
  })
  document.querySelectorAll('[data-pl-down]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const i = parseInt(btn.dataset.plDown)
      if (i >= pl.tracks.length - 1) return
      ;[pl.tracks[i + 1], pl.tracks[i]] = [pl.tracks[i], pl.tracks[i + 1]]
      window.api.savePlaylist(pl)
      renderPlaylist(id)
    })
  })
  document.querySelectorAll('[data-pl-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const i = parseInt(btn.dataset.plRemove)
      pl.tracks.splice(i, 1)
      window.api.savePlaylist(pl)
      renderPlaylist(id, sortKey)
    })
  })
  document.querySelectorAll('[data-pl-remove-fp]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const fp = btn.dataset.plRemoveFp
      const idx = pl.tracks.findIndex(t => t.filePath === fp)
      if (idx >= 0) { pl.tracks.splice(idx, 1); window.api.savePlaylist(pl); renderPlaylist(id, sortKey) }
    })
  })

  // Sort buttons
  document.querySelectorAll('.pl-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => renderPlaylist(id, btn.dataset.sort))
  })

  // Recommended: add to playlist
  document.querySelectorAll('[data-add-track]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const fp = btn.dataset.addTrack
      const track = _allLibraryTracks().find(t => t.filePath === fp)
      if (!track) return
      pl.tracks.push({ ...track })
      window.api.savePlaylist(pl)
      showToast(`Added "${track.title}" to ${pl.name}`)
      renderPlaylist(id, sortKey)
    })
  })
}

function _allLibraryTracks() {
  if (_allTracksCache && _allTracksCacheRef === state.library) return _allTracksCache
  _allTracksCacheRef = state.library
  const out = []
  for (const a of state.library) {
    for (const t of (a.tracks || [])) {
      out.push({ ...t, albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id })
    }
  }
  _allTracksCache = out
  return out
}

function renderLikedSongs() {
  const all = _allLibraryTracks()
  const byPath = new Map(all.map(t => [t.filePath, t]))
  const tracks = state.likedTracks.map(fp => byPath.get(fp)).filter(Boolean)
  const totalDur = tracks.reduce((s, t) => s + (t.duration || 0), 0)
    + state.ytLiked.reduce((s, t) => s + (t.duration || 0), 0)
  const totalCount = tracks.length + state.ytLiked.length

  const trackRows = tracks.map((t, i) => {
    const isPlaying = isCurrentTrack(t.filePath)
    const plays = state.playCounts[t.filePath] || 0
    return `
      <div class="track-row liked-track-row ${isPlaying ? 'playing' : ''}" data-liked-idx="${i}">
        <span class="track-num">${isPlaying
          ? '<div class="playing-bars"><span></span><span></span><span></span></div>'
          : (i + 1)}</span>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}${t.explicit ? '<span class="track-explicit">E</span>' : ''}</div>
          <div class="track-artist" data-artist="${esc(t.albumArtist || t.artist || '')}">${esc(t.albumArtist || t.artist || '')}${t.bpm ? `<span class="track-bpm">${t.bpm} BPM</span>` : ''}</div>
        </div>
        ${plays > 0 ? `<span class="track-plays">${plays}</span>` : '<span class="track-plays"></span>'}
        <button class="track-like-btn liked" data-like="${esc(t.filePath)}" title="Unlike">♥</button>
        <span class="track-dur">${fmtDur(t.duration)}</span>
      </div>`
  }).join('')

  setContent(`
    <div class="album-hero" style="background: linear-gradient(#5038a0cc, var(--bg) 100%)">
      <div class="album-hero-art-fallback" style="display:flex;background:linear-gradient(135deg,#4338a0,#a0387a)"><svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Auto Playlist</div>
        <div class="album-hero-title">Liked Songs</div>
        <div class="album-hero-meta">${totalCount} song${totalCount !== 1 ? 's' : ''}${totalCount ? `, ${fmtTime(totalDur)}` : ''}</div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="liked-play-btn" ${!totalCount ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
    </div>
    <div class="track-list">
      ${tracks.length
        ? trackRows
        : (state.ytLiked.length ? '' : '<div class="pl-empty-state" style="padding:40px 0"><p>No liked songs yet. Tap the heart on any track.</p></div>')}
      ${state.ytLiked.length ? `
        <div class="yt-sub-header" style="margin-top:20px">From YouTube</div>
        <div id="yt-liked-list">${state.ytLiked.map((t, i) => `
          <div class="track-row yt-row yt-liked-row" data-i="${i}">
            ${t.thumbnailUrl
              ? `<img class="yt-thumb" src="${esc(t.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
              : `<div class="yt-thumb yt-thumb-empty"></div>`}
            <div class="track-info">
              <div class="track-title">${esc(t.title)} <span class="yt-badge">YT</span></div>
              <div class="track-artist">${esc(t.artist)}</div>
            </div>
            <button class="track-like-btn liked" data-yt-unlike="${i}" title="Unlike">♥</button>
            <span class="track-dur">${t.duration ? fmtDur(t.duration) : ''}</span>
          </div>`).join('')}</div>` : ''}
    </div>`)

  document.getElementById('liked-play-btn')?.addEventListener('click', () => {
    if (!totalCount) return
    state.queue = [...tracks.map(t => ({ ...t })), ...state.ytLiked.map(t => _ytQueueItem(t))]
    state.queueIndex = 0
    playCurrentTrack()
  })
  const ytList = document.getElementById('yt-liked-list')
  if (ytList) {
    ytList.querySelectorAll('.yt-liked-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.track-like-btn')) return
        const i = parseInt(row.dataset.i)
        state.queue = state.ytLiked.slice(i).map(t => _ytQueueItem(t))
        state.queueIndex = 0
        playCurrentTrack()
      })
      row.addEventListener('contextmenu', async e => {
        e.preventDefault()
        const t = state.ytLiked[parseInt(row.dataset.i)]
        const action = await ytRowContextMenu(t)
        if (action === 'like') renderLikedSongs()
      })
    })
    ytList.querySelectorAll('[data-yt-unlike]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation()
      toggleYtLike(state.ytLiked[parseInt(btn.dataset.ytUnlike)])
      renderLikedSongs()
    }))
  }
  document.querySelectorAll('.liked-track-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.track-like-btn')) return
      const idx = parseInt(row.dataset.likedIdx)
      if (!tracks[idx]) return
      state.queue = tracks.slice(idx).map(t => ({ ...t }))
      state.queueIndex = 0
      playCurrentTrack()
    })
  })
  document.querySelectorAll('.liked-track-row .track-like-btn[data-like]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      toggleTrackLike(btn.dataset.like)
      renderLikedSongs()
    })
  })
}

function renderStats() {
  const all = _allLibraryTracks()
  const byPath = new Map(all.map(t => [t.filePath, t]))
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const recent = (state.playHistory || []).filter(h => (h.timestamp || 0) >= cutoff)

  let totalSecs = 0
  for (const h of recent) {
    const t = byPath.get(h.filePath)
    if (t) totalSecs += (t.duration || 0)
  }
  const hours = Math.floor(totalSecs / 3600)
  const mins  = Math.floor((totalSecs % 3600) / 60)

  const artistCounts = {}
  for (const h of recent) {
    const a = h.artist || (byPath.get(h.filePath)?.albumArtist) || 'Unknown'
    artistCounts[a] = (artistCounts[a] || 0) + 1
  }
  const topArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)

  const topTracks = Object.entries(state.playCounts || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([fp, count]) => ({ count, track: byPath.get(fp) }))
    .filter(x => x.track)

  const genreCounts = {}
  for (const h of recent) {
    const t = byPath.get(h.filePath)
    const g = t?.genre
    if (g) genreCounts[g] = (genreCounts[g] || 0) + 1
  }
  const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const maxGenre = topGenres.length ? topGenres[0][1] : 1

  const artFor = (artistName) => {
    const al = state.library.find(a => a.artist === artistName || a.albumArtist === artistName)
    return al?.artPath || null
  }

  const artistRows = topArtists.map(([name, count], i) => {
    const ap = artFor(name)
    return `<div class="stats-rank-row" data-stats-artist="${esc(name)}">
      <span class="stats-rank-num">${i + 1}</span>
      ${ap ? `<img class="stats-rank-art" src="file://${ap}" alt="">` : '<div class="stats-rank-art"></div>'}
      <div class="stats-rank-info"><div class="stats-rank-name">${esc(name)}</div></div>
      <span class="stats-rank-count">${count} play${count !== 1 ? 's' : ''}</span>
    </div>`
  }).join('') || '<div class="stats-rank-sub" style="padding:8px 0">No plays yet this month.</div>'

  const trackRows = topTracks.map(({ track, count }, i) => `
    <div class="stats-rank-row" data-stats-album="${esc(track.albumId || '')}">
      <span class="stats-rank-num">${i + 1}</span>
      ${track.artPath ? `<img class="stats-rank-art" src="file://${track.artPath}" alt="">` : '<div class="stats-rank-art"></div>'}
      <div class="stats-rank-info">
        <div class="stats-rank-name">${esc(track.title)}</div>
        <div class="stats-rank-sub">${esc(track.albumArtist || track.artist || '')}</div>
      </div>
      <span class="stats-rank-count">${count} play${count !== 1 ? 's' : ''}</span>
    </div>`).join('') || '<div class="stats-rank-sub" style="padding:8px 0">No tracks played yet.</div>'

  const genreRows = topGenres.map(([name, count]) => `
    <div class="stats-genre-bar">
      <span class="stats-genre-name">${esc(name)}</span>
      <div class="stats-genre-track"><div class="stats-genre-fill" style="width:${Math.round(count / maxGenre * 100)}%"></div></div>
      <span class="stats-genre-ct">${count}</span>
    </div>`).join('') || '<div class="stats-rank-sub">No genre data yet.</div>'

  setContent(`<div class="stats-page">
    <div class="stats-hero">Listening time this month<span>${hours}h ${mins}m</span></div>
    <div class="stats-section">
      <h2>Top Artists</h2>
      ${artistRows}
    </div>
    <div class="stats-section">
      <h2>Top Tracks</h2>
      ${trackRows}
    </div>
    <div class="stats-section">
      <h2>By Genre</h2>
      ${genreRows}
    </div>
  </div>`)

  document.querySelectorAll('[data-stats-artist]').forEach(row => {
    row.addEventListener('click', () => navigate('artist', row.dataset.statsArtist))
  })
  document.querySelectorAll('[data-stats-album]').forEach(row => {
    row.addEventListener('click', () => { if (row.dataset.statsAlbum) navigate('album', row.dataset.statsAlbum) })
  })
}

function showNameInputModal(title, placeholder, onConfirm) {
  const existing = document.getElementById('name-input-modal')
  if (existing) existing.remove()
  const overlay = document.createElement('div')
  overlay.id = 'name-input-modal'
  overlay.className = 'addpl-overlay'
  overlay.innerHTML = `
    <div class="addpl-card" style="max-width:340px">
      <div class="addpl-header">
        <span>${esc(title)}</span>
        <button class="addpl-close" id="nim-close">&#10005;</button>
      </div>
      <div style="padding:16px">
        <input id="nim-input" class="sq-name-input" style="width:100%;box-sizing:border-box" type="text" placeholder="${esc(placeholder)}" maxlength="80" autofocus>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button class="secondary" id="nim-cancel">Cancel</button>
          <button id="nim-ok">Create</button>
        </div>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const input = overlay.querySelector('#nim-input')
  const close = () => overlay.remove()
  const confirm = () => {
    const name = (input.value || '').trim()
    if (!name) { input.focus(); return }
    close()
    onConfirm(name)
  }
  overlay.querySelector('#nim-close')?.addEventListener('click', close)
  overlay.querySelector('#nim-cancel')?.addEventListener('click', close)
  overlay.querySelector('#nim-ok')?.addEventListener('click', confirm)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') close() })
  setTimeout(() => input.focus(), 50)
}

function showAddToPlaylistModal(tracks) {
  if (!tracks || !tracks.length) return
  const existing = document.getElementById('addpl-modal')
  if (existing) existing.remove()

  const slim = tracks.map(t => ({
    id: t.id, title: t.title, artist: t.artist, albumArtist: t.albumArtist || t.artist || '',
    albumName: t.albumName || '', duration: t.duration || 0, filePath: t.filePath,
    artPath: t.artPath || null, albumId: t.albumId || null,
    videoId: t.videoId || null, albumBrowseId: t.albumBrowseId || null, channelId: t.channelId || null,
    replayGainTrack: t.replayGainTrack ?? null, replayGainAlbum: t.replayGainAlbum ?? null,
    sampleRate: t.sampleRate || 0, bitsPerSample: t.bitsPerSample || 0, channels: t.channels || 0,
  }))

  const overlay = document.createElement('div')
  overlay.className = 'addpl-overlay'
  overlay.id = 'addpl-modal'
  overlay.innerHTML = `
    <div class="addpl-card">
      <div class="addpl-header">
        <span>Add ${slim.length} song${slim.length !== 1 ? 's' : ''} to…</span>
        <button class="addpl-close" id="addpl-close">&#10005;</button>
      </div>
      <button class="addpl-new" id="addpl-new">
        <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        New playlist
      </button>
      <div class="addpl-list" id="addpl-list">
        ${state.playlists.length
          ? state.playlists.map(pl => `
            <button class="addpl-item" data-pl="${esc(pl.id)}">
              ${_plCollage(pl, 'addpl-item-art')}
              <div class="addpl-item-info">
                <div class="addpl-item-name">${esc(pl.name)}</div>
                <div class="addpl-item-meta">${(pl.tracks || []).length} song${(pl.tracks || []).length !== 1 ? 's' : ''}</div>
              </div>
            </button>`).join('')
          : '<div class="addpl-empty">No playlists yet</div>'}
      </div>
    </div>`
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  const addTo = (pl) => {
    pl.tracks = pl.tracks || []
    pl.tracks.push(...slim)
    window.api.savePlaylist(pl)
    close()
    if (state.currentPage === 'playlist' && state.currentPlaylistId === pl.id) renderPlaylist(pl.id)
    if (state.currentPage === 'playlists') renderPlaylists()
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('addpl-close')?.addEventListener('click', close)
  document.getElementById('addpl-new')?.addEventListener('click', () => {
    showNameInputModal('New playlist', 'Playlist name…', name => {
      const pl = { id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name, tracks: [], createdAt: Date.now() }
      state.playlists.unshift(pl)
      addTo(pl)
    })
  })
  overlay.querySelectorAll('.addpl-item[data-pl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === btn.dataset.pl)
      if (pl) addTo(pl)
    })
  })
}

// ── Download panel ──────────────────────────────────────────────────────────
const _downloads = new Map()

function renderDlPanel() {
  const list = document.getElementById('dl-panel-list')
  if (!list) return
  const badge = document.getElementById('bnav-dl-badge')
  const active = [..._downloads.values()].filter(d => d.state === 'active').length
  if (badge) { badge.style.display = active > 0 ? 'flex' : 'none'; badge.textContent = active }
  if (!_downloads.size) { list.innerHTML = '<div class="dl-empty">No downloads yet</div>'; return }
  list.innerHTML = [..._downloads.entries()].reverse().map(([id, dl]) => {
    const pct = dl.total ? Math.round((dl.received / dl.total) * 100) : 0
    const kb  = dl.total ? `${Math.round(dl.received / 1024)} / ${Math.round(dl.total / 1024)} KB` : ''
    const stateEl = dl.state === 'done'
      ? `<span class="dl-item-state done">Done</span>`
      : dl.state === 'cancelled'
      ? `<span class="dl-item-state cancelled">Cancelled</span>`
      : dl.state === 'failed'
      ? `<span class="dl-item-state failed">Failed</span>`
      : `<button class="dl-item-cancel" data-id="${id}">&#10005;</button>`
    return `<div class="dl-item">
      <div class="dl-item-top">
        <span class="dl-item-name" title="${esc(dl.filename)}">${esc(dl.filename)}</span>
        ${stateEl}
      </div>
      ${dl.state === 'active' ? `<div class="dl-item-bar-wrap">
        <div class="dl-item-bar"><div class="dl-item-fill" style="width:${pct}%"></div></div>
        <span class="dl-item-size">${kb}</span>
      </div>` : ''}
    </div>`
  }).join('')
  list.querySelectorAll('.dl-item-cancel').forEach(btn =>
    btn.addEventListener('click', () => window.api.cancelDownload(btn.dataset.id))
  )
}

function toggleDlPanel() {
  const panel = document.getElementById('dl-panel')
  if (!panel) return
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
}

function renderBrowse() {
  document.getElementById('browser-nav').style.display = 'flex'
  document.getElementById('content').classList.add('browser-open')
  state.browserActive = true
  setContent(`<div class="browser-placeholder" style="height:100%">
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
    <h2>Browse &amp; Download</h2>
    <p>Type a URL above and press Go, or click a saved site.</p>
  </div>`)
  // Only re-attach BrowserView if a page was previously loaded — otherwise show the placeholder
  if (state.currentUrl) window.api.showBrowser('')
}

// ── Browser helpers ─────────────────────────────────────────────────────────
function loadBrowserUrl(url) {
  if (!url) return
  const full = url.startsWith('http') ? url : `https://${url}`
  state.currentUrl = full
  const bar = document.getElementById('url-bar')
  if (bar) bar.value = full
  // showBrowser handles create, attach, and load — safe to call every time
  window.api.showBrowser(full)
  if (!state.browserActive) {
    document.getElementById('browser-nav').style.display = 'flex'
    document.getElementById('content').classList.add('browser-open')
    state.browserActive = true
  }
}

function hideBrowser() {
  document.getElementById('browser-nav').style.display = 'none'
  document.getElementById('content').classList.remove('browser-open')
  state.browserActive = false
  window.api.hideBrowser()
}

// ── Like / favourite ────────────────────────────────────────────────────────
function toggleLike(albumId) {
  if (state.likedAlbums.includes(albumId)) {
    state.likedAlbums = state.likedAlbums.filter(id => id !== albumId)
  } else {
    state.likedAlbums = [albumId, ...state.likedAlbums]
  }
  window.api.saveLiked(state.likedAlbums)
  updateLikeBtn(albumId)
}

function updateLikeBtn(albumId) {
  const currentAlbumId = albumId || (state.currentPage === 'album' ? state.currentAlbumId : null)
  if (!currentAlbumId) return
  const liked = state.likedAlbums.includes(currentAlbumId)
  document.querySelectorAll('.album-like-btn').forEach(btn => {
    if (!albumId || btn.dataset.album === albumId) btn.classList.toggle('liked', liked)
  })
  // Update player bar heart for currently playing album
  const npAlbum = state.library.find(a => a.id === currentAlbumId)
  if (npAlbum && state.queue.length && npAlbum.tracks.some(t => t.filePath === state.queue[state.queueIndex]?.filePath)) {
    const likeBtn = document.getElementById('btn-like')
    if (likeBtn) likeBtn.classList.toggle('liked', liked)
  }
}

function updatePlayerLikeBtn() {
  const currentTrack = state.queue[state.queueIndex]
  if (!currentTrack) return
  const album = state.library.find(a => a.tracks.some(t => t.filePath === currentTrack.filePath))
  if (!album) return
  const likeBtn = document.getElementById('btn-like')
  if (likeBtn) {
    likeBtn.classList.toggle('liked', state.likedAlbums.includes(album.id))
    likeBtn.dataset.album = album.id
  }
}

// ── Queue panel ─────────────────────────────────────────────────────────────
function toggleQueuePanel() {
  state.queuePanelOpen = !state.queuePanelOpen
  const panel = document.getElementById('queue-panel')
  const btn   = document.getElementById('btn-queue')
  panel.classList.toggle('open', state.queuePanelOpen)
  if (btn) btn.classList.toggle('active', state.queuePanelOpen)
  if (state.queuePanelOpen) renderQueuePanel()
}

function renderQueuePanel() {
  const list = document.getElementById('queue-list')
  if (!list) return
  const curTrack = state.queue[state.queueIndex]
  const fromName = curTrack?.albumName || ''
  const fromHtml = fromName
    ? `<div class="queue-from">Playing from <span class="queue-from-name">${esc(fromName)}</span></div>`
    : ''
  if (!state.queue.length) {
    list.innerHTML = fromHtml + `<div style="padding:20px 16px; color:var(--text3); font-size:13px;">Nothing in queue</div>`
    return
  }

  const dragHandleSvg = `<svg viewBox="0 0 24 24"><path d="M9 4h2v2H9zm4 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zM9 14h2v2H9zm4 0h2v2h-2z"/></svg>`
  const removeSvg     = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`

  list.innerHTML = fromHtml + state.queue.map((t, i) => {
    const isPlaying = i === state.queueIndex
    const art = t.artPath
      ? `<img class="queue-row-art" src="file://${t.artPath}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : ''
    return `
      <div class="queue-row ${isPlaying ? 'playing' : ''}" draggable="true" data-queue-idx="${i}">
        <div class="queue-drag-handle">${dragHandleSvg}</div>
        ${art}
        <div class="queue-row-art-fallback" ${art ? 'style="display:none"' : ''}>
          <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
        </div>
        <div class="queue-row-info">
          <div class="queue-row-title">${esc(t.title)}${t.explicit ? '<span class="track-explicit">E</span>' : ''}</div>
          <div class="queue-row-artist">${esc(t.albumArtist || t.artist || '')}${t.bpm ? `<span class="track-bpm">${t.bpm} BPM</span>` : ''}</div>
        </div>
        ${(state.playCounts[t.filePath] || 0) > 0 ? `<span class="track-plays">${state.playCounts[t.filePath]}</span>` : ''}
        <button class="track-like-btn ${state.likedTracks.includes(t.filePath) ? 'liked' : ''}" data-like="${esc(t.filePath)}" title="${state.likedTracks.includes(t.filePath) ? 'Unlike' : 'Like'}">${state.likedTracks.includes(t.filePath) ? '♥' : '♡'}</button>
        <button class="queue-row-remove" data-remove-idx="${i}" title="Remove">${removeSvg}</button>
      </div>`
  }).join('')

  // Add clear-all button
  const clearBtn = document.createElement('button')
  clearBtn.className = 'queue-clear-btn'
  clearBtn.textContent = 'Clear queue'
  clearBtn.addEventListener('click', () => {
    audio.pause()
    state.queue = []; state.queueIndex = -1; state.isPlaying = false
    updateNextPrefetch()
    updatePlayBtn(); updateNowPlaying(null)
    renderQueuePanel()
  })
  list.appendChild(clearBtn)

  // Click to play
  list.querySelectorAll('.queue-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.queue-row-remove') || e.target.closest('.queue-drag-handle') || e.target.closest('.track-like-btn')) return
      state.queueIndex = parseInt(row.dataset.queueIdx)
      playCurrentTrack()
      renderQueuePanel()
    })
  })
  wireTrackLikeButtons()

  // Remove buttons
  list.querySelectorAll('.queue-row-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.removeIdx)
      state.queue.splice(idx, 1)
      if (idx < state.queueIndex) state.queueIndex--
      else if (idx === state.queueIndex) {
        if (state.queue.length) playCurrentTrack()
        else { audio.pause(); state.isPlaying = false; state.queueIndex = -1; updatePlayBtn(); updateNowPlaying(null) }
      }
      renderQueuePanel()
    })
  })

  // Drag-to-reorder
  let dragSrcIdx = null
  list.querySelectorAll('.queue-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragSrcIdx = parseInt(row.dataset.queueIdx)
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
      const t = state.queue[dragSrcIdx]
      if (t) {
        const ghost = document.createElement('div')
        ghost.style.cssText = 'position:fixed;top:-200px;left:-200px;z-index:9999;display:flex;align-items:center;gap:8px;padding:6px 12px 6px 8px;background:rgba(22,22,22,.96);border:1px solid rgba(255,255,255,.14);border-radius:8px;font-size:12px;color:#fff;max-width:230px;pointer-events:none'
        if (t.artPath) {
          const img = document.createElement('img')
          img.src = 'file://' + t.artPath
          img.style.cssText = 'width:28px;height:28px;border-radius:4px;object-fit:cover;flex-shrink:0'
          ghost.appendChild(img)
        }
        const span = document.createElement('span')
        span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        span.textContent = t.title || ''
        ghost.appendChild(span)
        document.body.appendChild(ghost)
        e.dataTransfer.setDragImage(ghost, 16, 20)
        setTimeout(() => ghost.remove(), 0)
      }
    })
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging')
      list.querySelectorAll('.queue-row').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'))
    })
    row.addEventListener('dragover', e => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = row.getBoundingClientRect()
      const isTop = e.clientY < rect.top + rect.height / 2
      list.querySelectorAll('.queue-row').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'))
      row.classList.add(isTop ? 'drag-over-top' : 'drag-over-bottom')
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-top', 'drag-over-bottom')
    })
    row.addEventListener('drop', e => {
      e.preventDefault()
      const destIdx = parseInt(row.dataset.queueIdx)
      if (dragSrcIdx === null || dragSrcIdx === destIdx) return
      const rect = row.getBoundingClientRect()
      const insertBefore = e.clientY < rect.top + rect.height / 2
      const insertAt = insertBefore ? destIdx : destIdx + 1

      const [moved] = state.queue.splice(dragSrcIdx, 1)
      const adjustedInsert = dragSrcIdx < insertAt ? insertAt - 1 : insertAt
      state.queue.splice(adjustedInsert, 0, moved)

      // Keep queueIndex pointing at the same track
      if (dragSrcIdx === state.queueIndex) {
        state.queueIndex = adjustedInsert
      } else if (dragSrcIdx < state.queueIndex && adjustedInsert >= state.queueIndex) {
        state.queueIndex--
      } else if (dragSrcIdx > state.queueIndex && adjustedInsert <= state.queueIndex) {
        state.queueIndex++
      }
      dragSrcIdx = null
      renderQueuePanel()
    })
  })

  const playingEl = list.querySelector('.queue-row.playing')
  if (playingEl) playingEl.scrollIntoView({ block: 'nearest' })

  // Smart suggestions based on current track — cached per-track, O(1) on re-renders
  if (curTrack) {
    const qPaths = new Set(state.queue.map(t => t.filePath))
    if (_suggCache.trackFp !== curTrack.filePath) {
      const curAlbum = state.library.find(a => a.id === curTrack.albumId)
      const curArtist = curTrack.albumArtist || curTrack.artist
      const curGenre  = curAlbum?.genre
      const suggGenreMap = new Map(state.library.map(a => [a.id, a.genre]))
      const pool = _allLibraryTracks()
        .filter(t => (
          (curArtist && (t.albumArtist === curArtist || t.artist === curArtist)) ||
          (curGenre && suggGenreMap.get(t.albumId) === curGenre)
        ))
        .sort(() => Math.random() - 0.5)
        .slice(0, 20)
      _suggCache = { trackFp: curTrack.filePath, pool }
    }
    const suggs = _suggCache.pool.filter(t => !qPaths.has(t.filePath)).slice(0, 5)

    if (suggs.length) {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = `<div class="queue-suggestions-header"><span>Suggested next</span></div>` +
        suggs.map((t, i) => `
          <div class="queue-suggestion-row" data-sugg-idx="${i}">
            ${t.artPath
              ? `<img class="queue-suggestion-art" src="file://${t.artPath}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="queue-suggestion-art-fb" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>`
              : `<div class="queue-suggestion-art-fb"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>`}
            <div class="queue-suggestion-info">
              <div class="queue-suggestion-title">${esc(t.title)}</div>
              <div class="queue-suggestion-artist">${esc(t.albumArtist || t.artist || '')}</div>
            </div>
            <button class="queue-suggestion-add" title="Add to queue">
              <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>`).join('')
      wrapper.addEventListener('click', e => {
        const row = e.target.closest('[data-sugg-idx]')
        if (!row) return
        const t = suggs[parseInt(row.dataset.suggIdx)]
        if (!t) return
        if (e.target.closest('.queue-suggestion-add')) {
          e.stopPropagation()
          state.queue.splice(state.queueIndex + 1, 0, { ...t })
          syncExtension()
          renderQueuePanel()
        } else {
          state.queue.splice(state.queueIndex + 1, 0, { ...t })
          state.queueIndex++
          playCurrentTrack()
          renderQueuePanel()
        }
      })
      list.appendChild(wrapper)
    }
  }
}

function addToQueue(album, tracksOverride) {
  const tracks = tracksOverride
    ?? album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name }))
  if (!state.queue.length) {
    state.queue = tracks
    state.queueIndex = 0
    playCurrentTrack()
  } else {
    state.queue.push(...tracks)
  }
  if (state.queuePanelOpen) renderQueuePanel()
}

// ── Now Playing modal ───────────────────────────────────────────────────────
let _npHideTimer = null
function resetNpHide() {
  const modal = document.getElementById('np-modal')
  if (!modal || !state.modalOpen) return
  modal.classList.remove('controls-hidden')
  clearTimeout(_npHideTimer)
  _npHideTimer = setTimeout(() => modal.classList.add('controls-hidden'), 3000)
}

function showNowPlayingModal() {
  state.modalOpen = true
  const modal = document.getElementById('np-modal')
  modal.style.display = 'flex'
  if (!modal._autoHideWired) {
    modal._autoHideWired = true
    modal.addEventListener('mousemove', resetNpHide)
    modal.addEventListener('click',     resetNpHide)
  }
  resetNpHide()
  updateNowPlayingModal()
  updateNpNext()
  renderLyricsPanel()
  if (!document.getElementById('np-next')?._clickWired) {
    const nextEl = document.getElementById('np-next')
    if (nextEl) {
      nextEl._clickWired = true
      nextEl.addEventListener('click', () => {
        if (state.queueIndex + 1 < state.queue.length) {
          state.queueIndex++
          playCurrentTrack()
          updateNowPlayingModal()
          updateNpNext()
        }
      })
    }
  }

  if (!modal._draggableSetup) {
    modal._draggableSetup = true
    const modalTrack = document.getElementById('np-modal-track')
    const modalFill  = document.getElementById('np-modal-fill')
    const modalThumb = document.getElementById('np-modal-thumb')
    if (modalTrack) {
      makeDraggable(modalTrack, modalFill, modalThumb, ratio => {
        if (audio.duration) audio.currentTime = ratio * audio.duration
      })
    }
  }
}

function hideNowPlayingModal() {
  state.modalOpen = false
  clearTimeout(_npHideTimer)
  const modal = document.getElementById('np-modal')
  modal.classList.remove('controls-hidden')
  modal.style.display = 'none'
  const artBg = document.getElementById('np-modal-art-bg')
  if (artBg) artBg.src = ''
  const artImg = document.getElementById('np-modal-art-img')
  if (artImg) artImg.src = ''
}

function updateNowPlayingModal() {
  const track = state.queue[state.queueIndex]
  const titleEl  = document.getElementById('np-modal-title')
  const artistEl = document.getElementById('np-modal-artist')
  const albumEl  = document.getElementById('np-modal-album')
  const artBgEl  = document.getElementById('np-modal-art-bg')
  if (titleEl)  titleEl.textContent  = track?.title  || '—'
  if (artistEl) artistEl.textContent = track?.albumArtist || track?.artist || '—'
  if (albumEl)  albumEl.textContent  = track?.albumName || ''
  if (artBgEl) {
    if (track?.artPath) {
      artBgEl.src = `file://${track.artPath}`
      artBgEl.style.display = 'block'
    } else {
      artBgEl.style.display = 'none'
    }
  }
  const artImg = document.getElementById('np-modal-art-img')
  const artFb  = document.getElementById('np-modal-art-fb')
  if (artImg) {
    if (track?.artPath) {
      artImg.src = `file://${track.artPath}`
      artImg.style.display = 'block'
      if (artFb) artFb.style.display = 'none'
    } else {
      artImg.src = ''
      artImg.style.display = 'none'
      if (artFb) artFb.style.display = 'flex'
    }
  }
  // Sync shuffle/repeat state
  document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
  document.getElementById('np-modal-repeat')?.classList.toggle('active', state.repeat !== 'off')
  // Sync karaoke header
  if (track) {
    const lyrTitle = document.getElementById('np-modal-lyrics-title')
    const lyrArtist = document.getElementById('np-modal-lyrics-artist')
    if (lyrTitle) lyrTitle.textContent = track.title || '—'
    if (lyrArtist) lyrArtist.textContent = track.albumArtist || track.artist || '—'
  }
  updateStatsRow(track)
  updateNpNext()
}

function updateNpNext() {
  const el = document.getElementById('np-next')
  if (!el || !state.modalOpen) return
  const nextIdx = state.queueIndex + 1
  if (nextIdx < state.queue.length) {
    const next = state.queue[nextIdx]
    el.style.display = 'flex'
    document.getElementById('np-next-title').textContent = next.title || '—'
    document.getElementById('np-next-artist').textContent = next.albumArtist || next.artist || ''
    const artEl = document.getElementById('np-next-art')
    if (next.artPath) { artEl.src = 'file://' + next.artPath; artEl.style.display = 'block' }
    else { artEl.src = ''; artEl.style.display = 'none' }
  } else {
    el.style.display = 'none'
  }
}

function syncModalPlayBtn() {
  const p = document.querySelector('#np-modal .icon-play')
  const u = document.querySelector('#np-modal .icon-pause')
  if (p) p.style.display = state.isPlaying ? 'none' : 'block'
  if (u) u.style.display = state.isPlaying ? 'block' : 'none'
}

// ── Context menu ────────────────────────────────────────────────────────────
function showContextMenu(e, target) {
  e.preventDefault()
  ctxTarget = target
  const menu = document.getElementById('ctx-menu')
  const liked = ctxTarget.albumId ? state.likedAlbums.includes(ctxTarget.albumId) : false
  document.getElementById('ctx-like-label').textContent = liked ? 'Unlike' : 'Like'
  menu.style.left = '-9999px'
  menu.style.top  = '-9999px'
  menu.style.display = 'block'
  const mw = menu.offsetWidth + 8
  const mh = menu.offsetHeight + 8
  const x = Math.max(8, Math.min(e.clientX, window.innerWidth  - mw))
  const y = Math.max(8, Math.min(e.clientY, window.innerHeight - mh))
  menu.style.left = `${x}px`
  menu.style.top  = `${y}px`
}

function hideContextMenu() {
  document.getElementById('ctx-menu').style.display = 'none'
  ctxTarget = null
}

// ── Player ──────────────────────────────────────────────────────────────────
function playAlbum(album, startIndex) {
  state.queue = album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }))
  state.queueIndex = startIndex
  window.api.saveRecentlyPlayed(album.id)
  state.recentlyPlayed = [album.id, ...state.recentlyPlayed.filter(x => x !== album.id)].slice(0, 20)
  playCurrentTrack()
}

function playTrack(album, trackIdx) {
  if (!album.tracks[trackIdx]) return
  state.queue = album.tracks.slice(trackIdx).map(t => ({
    ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id,
  }))
  state.queueIndex = 0
  window.api.saveRecentlyPlayed(album.id)
  state.recentlyPlayed = [album.id, ...state.recentlyPlayed.filter(x => x !== album.id)].slice(0, 20)
  playCurrentTrack()
}

// Mirror of playNext()'s selection, without side effects — used for gapless prefetch
function computeNextIndex() {
  if (state.repeat === 'one') return state.queueIndex
  if (state.shuffle && state.queue.length > 1) return null // shuffle picks lazily; skip prefetch
  if (state.queueIndex + 1 < state.queue.length) return state.queueIndex + 1
  return state.repeat === 'all' ? 0 : null
}

function updateNextPrefetch() {
  if (!state.queue.length) { audio.setNext(null); return }
  const idx = computeNextIndex()
  audio.setNext(idx == null ? null : state.queue[idx].filePath)
}

function playCurrentTrack() {
  const track = state.queue[state.queueIndex]
  if (!track) return
  if (isHttpPath(track.filePath)) recordYtRecent(track)
  if (!audio.paused && !audio.ended) audio.pause()
  const isStream = /^https?:\/\//.test(track.filePath)
  audio.src = isStream ? track.filePath : `file://${track.filePath}`
  audio.play().then(() => {
    extractAlbumColor(/^https?:\/\//.test(track.artPath || '') ? null : (track.artPath || null))
    state.isPlaying = true
    updatePlayBtn()
    updateNowPlaying(track)
    updateTrackHighlight()
    updatePlayerLikeBtn()
    if (state.queuePanelOpen) renderQueuePanel()
    if (state.modalOpen) { updateNowPlayingModal(); syncModalPlayBtn() }
    window.api.savePlaybackState({ filePath: track.filePath, position: 0 })
    window.api.notifyTrack({ title: track.title, artist: track.albumArtist || track.artist || '', artPath: track.artPath || null })
    _shuffleHistory.push(state.queueIndex)
    if (_shuffleHistory.length > 10) _shuffleHistory.shift()
    clearTimeout(_playCountTimer)
    _playCountTimer = setTimeout(() => {
      state.playCounts[track.filePath] = (state.playCounts[track.filePath] || 0) + 1
      window.api.incrementPlayCount(track.filePath)
      window.api.addPlayHistory({ filePath: track.filePath, title: track.title, artist: track.albumArtist || track.artist, album: track.albumName, artPath: track.artPath || null, timestamp: Date.now() })
    }, 30000)
    _lyrics = null
    renderLyricsPanel()
    updateLyricsDrawer()
    fetchLyrics(track).then(lines => { _lyrics = lines; renderLyricsPanel(); updateLyricsDrawer() })
    syncExtension()
    updateNextPrefetch()
  }).catch(e => {
    console.error('Playback error:', e)
    state.isPlaying = false
    updatePlayBtn()
    const titleEl = document.getElementById('np-title')
    if (titleEl) {
      const orig = titleEl.textContent
      titleEl.textContent = 'File not available'
      setTimeout(() => { titleEl.textContent = orig }, 2500)
    }
  })
}

function updateNowPlaying(track) {
  const titleEl  = document.getElementById('np-title')
  const artistEl = document.getElementById('np-artist')
  const albumEl  = document.getElementById('np-album')
  const sepEl    = document.getElementById('np-sep')
  const artEl    = document.getElementById('np-art')
  const artFb    = document.getElementById('np-art-fallback')
  const artistStr = track.albumArtist || track.artist || ''
  const albumStr  = track.albumName || ''
  if (titleEl)  { titleEl.textContent = track.title || '—'; titleEl.dataset.albumId = track.albumId || ''; applyTicker(titleEl) }
  if (artistEl) { artistEl.textContent = artistStr || '—'; applyTicker(artistEl) }
  if (albumEl)  { albumEl.textContent = albumStr; albumEl.dataset.albumId = track.albumId || '' }
  if (sepEl)    sepEl.style.display = (artistStr && albumStr) ? 'inline' : 'none'
  if (artEl && artFb) {
    if (track.artPath) {
      const newSrc = /^https?:\/\//.test(track.artPath) ? track.artPath : `file://${track.artPath}`
      if (artEl.getAttribute('src') !== newSrc) {
        artEl.style.opacity = '0'
        artEl.addEventListener('load', () => { artEl.style.opacity = '1' }, { once: true })
        artEl.src = newSrc
      }
      artEl.style.display = 'block'; artFb.style.display = 'none'
    } else {
      artEl.style.display = 'none'; artFb.style.display = 'flex'
    }
  }
  updateFormatBadge(track)
  updateStatsRow(track)
}

function applyTicker(el) {
  el.classList.remove('ticker-active')
  el.style.removeProperty('--ticker-dist')
  requestAnimationFrame(() => {
    const overflow = el.scrollWidth - el.clientWidth
    if (overflow > 4) {
      el.style.setProperty('--ticker-dist', `-${overflow}px`)
      el.classList.add('ticker-active')
    }
  })
}

function updateStatsRow(track) {
  const el = document.getElementById('np-stats-row')
  if (!el) return
  if (!track) { el.innerHTML = ''; return }
  const pills = []
  if (track.codec) pills.push(esc(String(track.codec).toUpperCase()))
  const bd = track.bitDepth || track.bitsPerSample
  const sr = track.sampleRate
  if (bd && sr) pills.push(`${bd}-bit / ${(sr/1000)} kHz`)
  else if (sr) pills.push(`${(sr/1000)} kHz`)
  if (track.bitrate) pills.push(`${Math.round(track.bitrate/1000).toLocaleString()} kbps`)
  if (track.fileSize) pills.push(`${(track.fileSize/1024/1024).toFixed(1)} MB`)
  el.innerHTML = pills.map(p => `<span class="np-stats-pill">${esc(p)}</span>`).join('')
}

function updatePlayBtn() {
  [document, document.getElementById('np-modal')].filter(Boolean).forEach(scope => {
    scope.querySelectorAll('.icon-play').forEach(el => el.style.display = state.isPlaying ? 'none' : 'block')
    scope.querySelectorAll('.icon-pause').forEach(el => el.style.display = state.isPlaying ? 'block' : 'none')
  })
  document.getElementById('np-art')?.classList.toggle('paused-anim', !state.isPlaying)
  window.api.setPowerSave(state.isPlaying)
}

function updateTrackHighlight() {
  const current = state.queue[state.queueIndex]
  if (!current) return
  document.querySelectorAll('.track-row').forEach(row => {
    const isPlaying = row.dataset.file === current.filePath && state.isPlaying
    row.classList.toggle('playing', isPlaying)
    const numCell = row.querySelector('.track-num')
    if (numCell) {
      if (isPlaying) {
        numCell.innerHTML = '<div class="playing-bars"><span></span><span></span><span></span></div>'
      } else {
        const idx = parseInt(row.dataset.idx)
        const album = state.library.find(a => a.id === row.dataset.album)
        const track = album?.tracks[idx]
        numCell.textContent = track?.trackNumber || idx + 1
      }
    }
  })
}

function isCurrentTrack(filePath) {
  return state.queue[state.queueIndex]?.filePath === filePath && state.isPlaying
}

function togglePlay() {
  if (!state.queue.length) return
  if (audio.paused) {
    audio.play(); state.isPlaying = true
  } else {
    audio.pause(); state.isPlaying = false
  }
  updatePlayBtn()
  updateTrackHighlight()
  if (state.modalOpen) syncModalPlayBtn()
  syncExtension()
}

function playNext() {
  if (!state.queue.length) return
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return }
  if (state.shuffle) {
    const recent = _shuffleHistory.slice(-3)
    state.queueIndex = pickShuffleIndex(state.queue, recent)
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length
  }
  if (state.queueIndex === 0 && state.repeat === 'off') {
    audio.pause(); state.isPlaying = false; updatePlayBtn(); syncExtension(); return
  }
  playCurrentTrack()
}

function pickShuffleIndex(queue, recentIndices) {
  const recentArtists = new Set(recentIndices.map(i => queue[i]?.albumArtist || queue[i]?.artist).filter(Boolean))
  const candidates = queue.map((t, i) => i).filter(i => !recentIndices.includes(i))
  const preferred = candidates.filter(i => !recentArtists.has(queue[i]?.albumArtist || queue[i]?.artist))
  const pool = preferred.length > 0 ? preferred : candidates.length > 0 ? candidates : queue.map((_,i)=>i)
  return pool[Math.floor(Math.random() * pool.length)]
}

function playPrev() {
  if (!state.queue.length) return
  if (audio.currentTime > 3) { audio.currentTime = 0; return }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length
  playCurrentTrack()
}

// ── Lyrics ──────────────────────────────────────────────────────────────────
async function fetchLyrics(track) {
  if (!track) return null
  try {
    const params = new URLSearchParams({
      track_name: track.title || '',
      artist_name: track.albumArtist || track.artist || '',
      album_name: track.albumName || '',
      duration: String(Math.round(track.duration || audio.duration || 0)),
    })
    const res = await fetch('https://lrclib.net/api/get?' + params.toString())
    if (!res.ok) return null
    const json = await res.json()
    if (json.syncedLyrics) {
      const lines = []
      for (const raw of json.syncedLyrics.split('\n')) {
        const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/)
        if (!m) continue
        const time = parseInt(m[1]) * 60 + parseFloat(m[2])
        const text = m[3].trim()
        if (text) lines.push({ time, text })
      }
      if (lines.length) return lines.sort((a, b) => a.time - b.time)
    }
    if (json.plainLyrics) {
      const paras = json.plainLyrics.split('\n').map(s => s.trim()).filter(Boolean)
      if (!paras.length) return null
      const dur = track.duration || audio.duration || paras.length
      const step = dur / paras.length
      return paras.map((text, i) => ({ time: i * step, text }))
    }
    return null
  } catch (_) {
    return null
  }
}

function renderLyricsPanel() {
  const panel = document.getElementById('lyrics-panel')
  if (!panel) return
  if (!_lyrics || !_lyrics.length) {
    panel.innerHTML = '<div class="lyrics-empty">No lyrics found</div>'
    return
  }
  panel.innerHTML = _lyrics.map(l =>
    `<div class="lyrics-line" data-time="${l.time}">${esc(l.text)}</div>`
  ).join('')
  updateLyricsHighlight()
}

function updateLyricsHighlight() {
  const panel = document.getElementById('lyrics-panel')
  if (!panel || !_lyrics || !_lyrics.length) return
  const t = audio.currentTime
  let activeIdx = -1
  for (let i = 0; i < _lyrics.length; i++) {
    if (_lyrics[i].time <= t) activeIdx = i; else break
  }
  const lines = panel.querySelectorAll('.lyrics-line')
  lines.forEach((el, i) => {
    const isActive = i === activeIdx
    if (isActive && !el.classList.contains('lyrics-line-active')) {
      el.classList.add('lyrics-line-active')
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (!isActive) {
      el.classList.remove('lyrics-line-active')
    }
  })
}

// ── Lyrics drawer (compact, above player bar) ───────────────────────────────
let _lyricsDrawerOpen = false

function toggleLyricsDrawer() {
  if (_lyricsDrawerOpen) {
    closeLyricsDrawer()
  } else {
    openLyricsDrawer()
  }
}

function openLyricsDrawer() {
  const drawer = document.getElementById('lyrics-drawer')
  const btn = document.getElementById('btn-lyrics')
  if (!drawer) return
  _lyricsDrawerOpen = true
  drawer.classList.add('open')
  btn?.classList.add('active')
  updateLyricsDrawer()
}

function closeLyricsDrawer() {
  const drawer = document.getElementById('lyrics-drawer')
  const btn = document.getElementById('btn-lyrics')
  if (!drawer) return
  _lyricsDrawerOpen = false
  drawer.classList.remove('open')
  btn?.classList.remove('active')
}

function updateLyricsDrawer() {
  if (!_lyricsDrawerOpen) return
  const body = document.getElementById('lyrics-drawer-body')
  const trackLabel = document.getElementById('lyrics-drawer-track')
  if (!body) return

  const track = state.queue[state.queueIndex]
  if (trackLabel && track) trackLabel.textContent = track.title || '—'

  if (!_lyrics || !_lyrics.length) {
    body.innerHTML = '<div class="lyrics-drawer-empty">No lyrics available</div>'
    return
  }
  body.innerHTML = _lyrics.map(l =>
    `<div class="lyrics-drawer-line" data-time="${l.time}">${esc(l.text)}</div>`
  ).join('')
  updateLyricsDrawerHighlight()
}

function updateLyricsDrawerHighlight() {
  if (!_lyricsDrawerOpen) return
  const body = document.getElementById('lyrics-drawer-body')
  if (!body || !_lyrics || !_lyrics.length) return
  const t = audio.currentTime
  let activeIdx = -1
  for (let i = 0; i < _lyrics.length; i++) {
    if (_lyrics[i].time <= t) activeIdx = i; else break
  }
  const lines = body.querySelectorAll('.lyrics-drawer-line')
  lines.forEach((el, i) => {
    const isActive = i === activeIdx
    if (isActive && !el.classList.contains('active')) {
      el.classList.add('active')
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (!isActive) {
      el.classList.remove('active')
    }
  })
}

// ── Lyrics: search online + save to disk ─────────────────────────────────────
async function searchAndSaveLyrics() {
  const track = state.queue[state.queueIndex]
  if (!track) { showToast('No track playing'); return }

  const btn = document.getElementById('lyrics-drawer-search')
  if (btn) { btn.classList.add('searching'); btn.disabled = true }

  try {
    const fetched = await fetchLyrics(track)
    if (!fetched || !fetched.length) {
      showToast('No lyrics found online')
      return
    }

    const lrcLines = fetched.map(l => {
      const mins = Math.floor(l.time / 60)
      const secs = (l.time % 60).toFixed(2).padStart(5, '0')
      return `[${String(mins).padStart(2, '0')}:${secs}]${l.text}`
    }).join('\n')

    const filePath = track.filePath
    if (filePath && window.api.saveLyrics) {
      const result = await window.api.saveLyrics({ filePath, lrcContent: lrcLines })
      if (result.success) {
        _lyrics = fetched
        renderLyricsPanel()
        updateLyricsDrawer()
        showToast('Lyrics saved ✓')
        if (btn) btn.classList.add('saved')
        setTimeout(() => btn?.classList.remove('saved'), 3000)
      } else {
        showToast('Could not save: ' + (result.error || 'unknown error'))
      }
    } else {
      _lyrics = fetched
      renderLyricsPanel()
      updateLyricsDrawer()
      showToast('Lyrics loaded (no file path to save)')
    }
  } catch (e) {
    showToast('Lyrics search failed')
  } finally {
    if (btn) { btn.classList.remove('searching'); btn.disabled = false }
  }
}

// ── Draggable bar ───────────────────────────────────────────────────────────
function makeDraggable(trackEl, fillEl, thumbEl, onChange) {
  let dragging = false
  function update(e) {
    const rect = trackEl.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    if (fillEl)  fillEl.style.width = `${ratio * 100}%`
    if (thumbEl) thumbEl.style.left = `${ratio * 100}%`
    onChange(ratio)
  }
  trackEl.addEventListener('mousedown', e => { dragging = true; update(e) })
  document.addEventListener('mousemove', e => { if (dragging) update(e) })
  document.addEventListener('mouseup', () => { dragging = false })
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function setContent(html) {
  document.getElementById('content').innerHTML = html
  bindContentEvents()
}

function _drawHomeClock() {
  const canvas = document.getElementById('home-clock')
  if (!canvas) {
    if (_homeClockInterval) { clearInterval(_homeClockInterval); _homeClockInterval = null }
    return
  }
  const ctx = canvas.getContext('2d')
  const w = canvas.width, h = canvas.height
  const cx = w / 2, cy = h / 2, r = w / 2 - 2
  const now = new Date()
  const sec = now.getSeconds(), min = now.getMinutes(), hr = now.getHours() % 12

  ctx.clearRect(0, 0, w, h)

  // Face
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Hour ticks
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2
    const inner = i % 3 === 0 ? r * 0.72 : r * 0.82
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    ctx.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1))
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)'
    ctx.lineWidth = i % 3 === 0 ? 1.5 : 1
    ctx.stroke()
  }

  // Hour hand
  const hrA = ((hr + min / 60) / 12) * Math.PI * 2 - Math.PI / 2
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(hrA) * r * 0.48, cy + Math.sin(hrA) * r * 0.48)
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.stroke()

  // Minute hand
  const minA = ((min + sec / 60) / 60) * Math.PI * 2 - Math.PI / 2
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(minA) * r * 0.70, cy + Math.sin(minA) * r * 0.70)
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 1.5
  ctx.lineCap = 'round'
  ctx.stroke()

  // Center dot
  ctx.beginPath()
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
  ctx.fillStyle = '#1db954'
  ctx.fill()
}

function bindContentEvents() {
  if (document.getElementById('home-clock')) {
    if (_homeClockInterval) { clearInterval(_homeClockInterval); _homeClockInterval = null }
    _drawHomeClock()
    _homeClockInterval = setInterval(_drawHomeClock, 1000)
  }

  document.getElementById('find-art-btn')?.addEventListener('click', () => {
    document.getElementById('find-art-btn').remove()
    fetchMissingArtwork()
  })

  document.querySelectorAll('.album-card').forEach(el => {
    // YT entity cards bind their own navigation (browse/channel/playlist ids)
    if (el.dataset.browse || el.dataset.channel || el.dataset.playlist) return
    el.addEventListener('click', e => {
      if (e.target.closest('.album-card-play') || e.target.closest('.album-card-artist')) return
      const id = el.dataset.album
      if (id && id.startsWith('yt_')) { navigate('yt-album', id.slice(3)); return }
      navigate('album', id)
    })
    if (!(el.dataset.album || '').startsWith('yt_')) {
      el.addEventListener('contextmenu', e =>
        showContextMenu(e, { type: 'album', albumId: el.dataset.album,
          artist: state.library.find(a => a.id === el.dataset.album)?.artist })
      )
    }
  })
  document.querySelectorAll('.album-card-play').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const id = btn.dataset.play
      if (id && id.startsWith('yt_')) {
        const saved = state.ytSavedAlbums.find(a => a.browseId === id.slice(3))
        if (saved) {
          state.queue = saved.tracks.map(t => _ytAlbumTrackItem(saved, t))
          state.queueIndex = 0
          playCurrentTrack()
        }
        return
      }
      const album = state.library.find(a => a.id === id)
      if (album) playAlbum(album, 0)
    })
  })
  document.querySelectorAll('.album-card-artist').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      navigate('artist', el.textContent)
    })
  })
  document.querySelectorAll('.quick-card').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.quick-card-play')) return
      navigate('album', el.dataset.album)
    })
  })
  document.querySelectorAll('.quick-card-play').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const album = state.library.find(a => a.id === btn.dataset.play)
      if (album) playAlbum(album, 0)
    })
  })
  document.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.track-more-btn') || e.target.closest('.track-like-btn')) return
      const album = state.library.find(a => a.id === row.dataset.album)
      if (!album) return
      const idx = album.tracks.findIndex(t => t.filePath === row.dataset.file)
      if (idx >= 0) playTrack(album, idx)
    })
    row.addEventListener('contextmenu', e => {
      const album = state.library.find(a => a.id === row.dataset.album)
      const track = album?.tracks.find(t => t.filePath === row.dataset.file)
      showContextMenu(e, { type: 'track', albumId: row.dataset.album, track, artist: album?.artist })
    })
    row.querySelector('.track-more-btn')?.addEventListener('click', e => {
      e.stopPropagation()
      const album = state.library.find(a => a.id === row.dataset.album)
      const track = album?.tracks.find(t => t.filePath === row.dataset.file)
      showContextMenu(e, { type: 'track', albumId: row.dataset.album, track, artist: album?.artist })
    })
  })
  document.querySelectorAll('.artist-link, .artist-pill').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      navigate('artist', el.dataset.artist || el.textContent)
    })
  })

  document.querySelectorAll('.search-top-result').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.album-card-play')) return
      navigate('album', el.dataset.album)
    })
  })

  document.querySelectorAll('.album-upgrade-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const albumId = btn.dataset.album
      const album = state.library.find(a => a.id === albumId)
      if (!album) return
      const hints = state.upgradeHints.get(albumId)
      const searchUrl = hints?.[0]?.searchUrl
      if (searchUrl) {
        if (state.currentPage !== 'browse') navigate('browse')
        setTimeout(() => { window.api.showBrowser(''); window.api.browserNavigate(searchUrl) }, 150)
      } else {
        const q = encodeURIComponent(`${album.artist} ${album.name}`)
        const enabled = state.qualitySources.filter(s => s.enabled)
        if (enabled.length) {
          const url = enabled[0].searchUrl.replace('{query}', q)
          if (state.currentPage !== 'browse') navigate('browse')
          setTimeout(() => { window.api.showBrowser(''); window.api.browserNavigate(url) }, 150)
        }
      }
    })
  })
}

function _cardHue(str) {
  return Math.abs([...str].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
}

function albumCard(album) {
  const hiResTag = album.isHiRes
    ? `<span class="album-hires-badge">${fmtSpec(album.maxBitsPerSample, album.maxSampleRate)}</span>`
    : ''
  const upgradeHints = state.upgradeHints.get(album.id)
  const upgradeTag = upgradeHints?.length
    ? `<button class="album-upgrade-btn" data-album="${album.id}" title="Higher quality found online — click to open">
        <svg viewBox="0 0 24 24"><path d="M4 16v2h16v-2H4zm8-10.17L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83z"/></svg>
        HQ
       </button>`
    : ''
  const hue = _cardHue((album.artist || '') + (album.name || ''))
  const fallbackStyle = `background:linear-gradient(135deg,hsl(${hue},55%,22%) 0%,hsl(${(hue+40)%360},45%,14%) 100%)`
  return `<div class="album-card" data-album="${album.id}">
    <div class="album-card-art-wrap">
      ${album.artPath
        ? `<img class="album-card-art" src="${isHttpPath(album.artPath) ? esc(album.artPath) : `file://${album.artPath}`}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-card-art-fallback" ${album.artPath ? 'style="display:none"' : `style="${fallbackStyle}"`}>
        <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
      </div>
      ${album.isYt ? '<span class="yt-badge yt-card-badge">YT</span>' : ''}
      ${hiResTag}${upgradeTag}
      <button class="album-card-play" data-play="${album.id}">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
    </div>
    <div class="album-card-name">${esc(album.name)}</div>
    <div class="album-card-artist" data-artist="${esc(album.artist)}">${esc(album.artist)}</div>
  </div>`
}

function fmtSpec(bd, sr) {
  const srLabel = sr >= 1000 ? `${sr % 1000 === 0 ? sr / 1000 : (sr / 1000).toFixed(1)}kHz` : `${sr}Hz`
  return bd ? `${bd}bit · ${srLabel}` : srLabel
}

function artImg(artPath, imgClass, fallbackClass) {
  const musicNote = `<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
  if (artPath) {
    const src = /^https?:\/\//.test(artPath) ? artPath : `file://${artPath}`
    return `<img class="${imgClass}" src="${src}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="${fallbackClass}" style="display:none">${musicNote}</div>`
  }
  return `<div class="${fallbackClass}">${musicNote}</div>`
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function fmtDur(sec) {
  if (!sec) return '—'
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
function fmtTime(sec) {
  if (!sec) return '0 min'
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  return h ? `${h} hr ${m} min` : `${m} min`
}
function setVolDisplay(vol) {
  const pct = `${Math.round(vol * 100)}%`
  const fill  = document.getElementById('vol-fill')
  const thumb = document.getElementById('vol-thumb')
  if (fill)  fill.style.width  = pct
  if (thumb) thumb.style.left  = pct
  const icon = document.querySelector('#btn-vol .vol-icon')
  if (icon) {
    if (vol === 0) {
      icon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    } else if (vol < 0.5) {
      icon.innerHTML = '<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>'
    } else {
      icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77z"/>'
    }
  }
}

// ── Saved sites ─────────────────────────────────────────────────────────────
function renderSavedSites() {
  const list = document.getElementById('saved-sites-list')
  if (!list) return
  list.innerHTML = state.savedSites.map(s => `
    <li class="site-item" data-url="${esc(s.url)}">
      <span title="${esc(s.url)}">${esc(s.name || s.url)}</span>
      <button class="site-item-del" data-url="${esc(s.url)}" title="Remove">&#10005;</button>
    </li>`).join('')
  list.querySelectorAll('.site-item').forEach(li => {
    li.addEventListener('click', e => {
      if (e.target.closest('.site-item-del')) return
      const url = li.dataset.url
      if (state.currentPage !== 'browse') navigate('browse')
      setTimeout(() => loadBrowserUrl(url), 150)
    })
  })
  list.querySelectorAll('.site-item-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      state.savedSites = await window.api.removeSite(btn.dataset.url)
      renderSavedSites()
    })
  })
}

// ── Saved queues ─────────────────────────────────────────────────────────────
function renderSavedQueues() {
  const list = document.getElementById('saved-queues-list')
  if (!list) return
  if (!state.savedQueues.length) {
    list.innerHTML = `<li style="padding:4px 12px 8px; font-size:11px; color:var(--text3); opacity:0.6">No saved queues yet</li>`
    return
  }
  list.innerHTML = state.savedQueues.map(q => {
    const firstArt = q.tracks?.find(t => t.artPath)?.artPath
    const artHtml = firstArt
      ? `<img class="sq-item-art" src="file://${firstArt}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<span class="sq-item-art-fb" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></span>`
      : `<span class="sq-item-art-fb"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></span>`
    return `
    <li class="sq-item" data-qid="${esc(q.id)}">
      ${artHtml}
      <span class="sq-item-info">
        <span class="sq-item-name" title="${esc(q.name)}">${esc(q.name)}</span>
        <span class="sq-item-count">${q.tracks?.length || 0} tracks</span>
      </span>
      <button class="sq-item-del" data-qid="${esc(q.id)}" title="Delete">&#10005;</button>
    </li>`
  }).join('')

  list.querySelectorAll('.sq-item').forEach(li => {
    li.addEventListener('click', e => {
      if (e.target.closest('.sq-item-del')) return
      const q = state.savedQueues.find(x => x.id === li.dataset.qid)
      if (!q?.tracks?.length) return
      state.queue = q.tracks
      state.queueIndex = 0
      playCurrentTrack()
      if (state.queuePanelOpen) renderQueuePanel()
    })
  })
  list.querySelectorAll('.sq-item-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      state.savedQueues = state.savedQueues.filter(x => x.id !== btn.dataset.qid)
      window.api.deleteSavedQueue(btn.dataset.qid)
      renderSavedQueues()
    })
  })
}

// ── Quality Sources ──────────────────────────────────────────────────────────
function renderQualitySources() {
  const list = document.getElementById('quality-sources-list')
  if (!list) return
  list.innerHTML = state.qualitySources.map(s => `
    <li class="qsrc-item" data-id="${esc(s.id)}">
      <button class="qsrc-toggle ${s.enabled ? 'on' : 'off'}" data-id="${esc(s.id)}" title="${s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}">
        <span class="qsrc-dot"></span>
      </button>
      <span class="qsrc-name">${esc(s.name)}</span>
<button class="qsrc-del" data-id="${esc(s.id)}" title="Remove source">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </li>`).join('')

  list.querySelectorAll('.qsrc-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      state.qualitySources = state.qualitySources.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s)
      window.api.saveQualitySources(state.qualitySources)
      renderQualitySources()
    })
  })
list.querySelectorAll('.qsrc-del').forEach(btn => {
    btn.addEventListener('click', () => {
      state.qualitySources = state.qualitySources.filter(s => s.id !== btn.dataset.id)
      window.api.saveQualitySources(state.qualitySources)
      renderQualitySources()
    })
  })
}



// ══════════════════════════════════════════════════════════════════════════════
// MUSIC CHAT SIDEBAR — multi-provider agent with persistent memory
// ══════════════════════════════════════════════════════════════════════════════

const chatState = {
  open:         false,
  history:      [],
  tasteProfile: { totalPlays: 0, topArtists: [], recent: [] },
  busy:         false,
  aborted:      false,
  provider:     'ollama',
  activeTab:    'chat',
  convStartedAt: null,
}

function _setChatBusy(busy) {
  chatState.busy = busy
  const send = document.getElementById('mcs-send-btn')
  const stop = document.getElementById('mcs-stop-btn')
  if (send) send.style.display = busy ? 'none' : ''
  if (stop) stop.style.display = busy ? '' : 'none'
  const input = document.getElementById('mcs-input')
  if (input) input.disabled = busy
}

// ── Tool execution — agent calls these, renderer executes them ─────────────
async function _executeTool(name, input) {
  switch (name) {

    case 'play_from_library': {
      const q = (input.query || '').toLowerCase().trim()

      // 0. Handle "song by artist" — split on " by " and narrow to artist first
      if (q.includes(' by ')) {
        const byIdx = q.lastIndexOf(' by ')
        const trackPart  = q.slice(0, byIdx).trim()
        const artistPart = q.slice(byIdx + 4).trim()
        for (const a of state.library) {
          if ((a.artist || '').toLowerCase().includes(artistPart)) {
            const idx = (a.tracks || []).findIndex(t => (t.title || '').toLowerCase().includes(trackPart))
            if (idx >= 0) { playTrack(a, idx); return `Playing "${a.tracks[idx].title}" from "${a.name}" by ${a.artist}.` }
          }
        }
        // Artist found but track title not matched — play artist anyway
        const artistAlbumsBy = state.library.filter(a => (a.artist || '').toLowerCase().includes(artistPart))
        if (artistAlbumsBy.length) {
          const tracks = artistAlbumsBy.flatMap(a => (a.tracks || []).map(t => ({ ...t, albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id })))
          state.queue = tracks; state.queueIndex = 0; playCurrentTrack()
          return `Couldn't find a track called "${trackPart}" — playing all ${tracks.length} tracks by ${artistAlbumsBy[0].artist} instead.`
        }
      }

      // 1. Exact album name
      let album = state.library.find(a => (a.name || '').toLowerCase() === q)
      if (album) { playAlbum(album, 0); return `Playing "${album.name}" by ${album.artist}.` }

      // 2. Album name contains full query
      album = state.library.find(a => (a.name || '').toLowerCase().includes(q))
      if (album) { playAlbum(album, 0); return `Playing "${album.name}" by ${album.artist}.` }

      // 3. Artist name contains full query — queue all their albums
      let artistAlbums = state.library.filter(a => (a.artist || '').toLowerCase().includes(q))
      if (artistAlbums.length) {
        const tracks = artistAlbums.flatMap(a => (a.tracks || []).map(t => ({ ...t, albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id })))
        state.queue = tracks; state.queueIndex = 0; playCurrentTrack()
        return `Playing ${tracks.length} tracks by ${artistAlbums[0].artist} (${artistAlbums.length} album${artistAlbums.length !== 1 ? 's' : ''}).`
      }

      // 4. Track title search across all albums
      for (const a of state.library) {
        const idx = (a.tracks || []).findIndex(t => (t.title || '').toLowerCase().includes(q))
        if (idx >= 0) {
          playTrack(a, idx)
          return `Playing "${a.tracks[idx].title}" from "${a.name}" by ${a.artist}.`
        }
      }

      // 5. Token fallback — strip filler words, try each remaining word against artist/album/track
      const STOP = new Set(['play','some','a','an','the','and','or','of','by','me','songs','song','tracks','track','music','album','artist','anything','something'])
      const tokens = q.split(/\s+/).filter(t => t.length > 1 && !STOP.has(t))
      if (tokens.length) {
        // Try artist token match — all albums by any matching artist
        artistAlbums = state.library.filter(a => tokens.some(tok => (a.artist || '').toLowerCase().includes(tok)))
        if (artistAlbums.length) {
          const tracks = artistAlbums.flatMap(a => (a.tracks || []).map(t => ({ ...t, albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id })))
          state.queue = tracks; state.queueIndex = 0; playCurrentTrack()
          return `Playing ${tracks.length} tracks by ${artistAlbums[0].artist} (${artistAlbums.length} album${artistAlbums.length !== 1 ? 's' : ''}).`
        }
        // Try album token match
        album = state.library.find(a => tokens.some(tok => (a.name || '').toLowerCase().includes(tok)))
        if (album) { playAlbum(album, 0); return `Playing "${album.name}" by ${album.artist}.` }
        // Try track token match
        for (const a of state.library) {
          const idx = (a.tracks || []).findIndex(t => tokens.every(tok => (t.title || '').toLowerCase().includes(tok)))
          if (idx >= 0) { playTrack(a, idx); return `Playing "${a.tracks[idx].title}" from "${a.name}" by ${a.artist}.` }
        }
      }

      return `"${input.query}" not found in library (${state.library.length} albums). Use auto_download to get it.`
    }

    case 'play_track': {
      const q = (input.query || '').toLowerCase().trim()
      // Handle "song by artist" format
      if (q.includes(' by ')) {
        const byIdx = q.lastIndexOf(' by ')
        const trackPart  = q.slice(0, byIdx).trim()
        const artistPart = q.slice(byIdx + 4).trim()
        for (const a of state.library) {
          if ((a.artist || '').toLowerCase().includes(artistPart)) {
            const idx = (a.tracks || []).findIndex(t => (t.title || '').toLowerCase().includes(trackPart))
            if (idx >= 0) { playTrack(a, idx); return `Playing "${a.tracks[idx].title}" from "${a.name}" by ${a.artist}.` }
          }
        }
      }
      for (const a of state.library) {
        const idx = (a.tracks || []).findIndex(t => (t.title || '').toLowerCase().includes(q))
        if (idx >= 0) { playTrack(a, idx); return `Playing "${a.tracks[idx].title}" from "${a.name}" by ${a.artist}.` }
      }
      // fallback: try album/artist match too
      const album = state.library.find(a => (a.name || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q))
      if (album) { playAlbum(album, 0); return `Playing "${album.name}" by ${album.artist}.` }
      return `"${input.query}" not found in library.`
    }

    case 'play_artist': {
      const q = (input.query || '').toLowerCase().trim()
      let albums = state.library.filter(a => (a.artist || '').toLowerCase().includes(q))
      if (!albums.length) {
        // Token fallback
        const STOP = new Set(['play','some','a','an','the','and','or','of','by','me','songs','song','music','artist'])
        const tokens = q.split(/\s+/).filter(t => t.length > 1 && !STOP.has(t))
        if (tokens.length) albums = state.library.filter(a => tokens.some(tok => (a.artist || '').toLowerCase().includes(tok)))
      }
      if (!albums.length) return `No music by "${input.query}" in library.`
      const tracks = albums.flatMap(a => (a.tracks || []).map(t => ({ ...t, albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id })))
      state.queue = tracks; state.queueIndex = 0; playCurrentTrack()
      return `Playing ${tracks.length} tracks by ${albums[0].artist} across ${albums.length} album${albums.length !== 1 ? 's' : ''}.`
    }

    case 'auto_download': {
      const q = input.query || ''
      const qLow = q.toLowerCase().trim()

      // Always check library before hitting Soulseek — with token fallback
      const STOP2 = new Set(['play','some','a','an','the','and','or','of','by','me','songs','song','music','album','artist','download'])
      const qTokens = qLow.split(/\s+/).filter(t => t.length > 1 && !STOP2.has(t))

      const libAlbum = state.library.find(a =>
        (a.name || '').toLowerCase().includes(qLow) || (a.artist || '').toLowerCase().includes(qLow) ||
        (qTokens.length && qTokens.some(tok => (a.artist || '').toLowerCase().includes(tok) || (a.name || '').toLowerCase().includes(tok)))
      )
      if (libAlbum) { playAlbum(libAlbum, 0); return `"${libAlbum.name}" by ${libAlbum.artist} is already in your library — playing it now.` }

      for (const a of state.library) {
        const idx = (a.tracks || []).findIndex(t => (t.title || '').toLowerCase().includes(qLow) ||
          (qTokens.length && qTokens.every(tok => (t.title || '').toLowerCase().includes(tok))))
        if (idx >= 0) {
          playTrack(a, idx)
          return `"${a.tracks[idx].title}" from "${a.name}" is already in your library — playing it now.`
        }
      }

      _addChatMsg('status', `Searching Soulseek for "${q}"…`)
      const variants = _buildSearchVariants(q)
      const seen = new Set(); const allResults = []
      await Promise.all(variants.map(v =>
        window.api.slskSearch({ query: v, timeoutMs: 45000 }).then(({ results }) => {
          for (const r of (results || [])) {
            const key = r.username + '\x00' + (r.files?.[0]?.filename || '')
            if (!seen.has(key)) { seen.add(key); allResults.push(r) }
          }
        }).catch(() => {})
      ))
      const saved = slsk.results; slsk.results = allResults
      const groups = _slskGroupByFolder(); slsk.results = saved
      if (!groups.length) return `Nothing found for "${q}" on Soulseek.`
      const best = groups.find(g => g.files.some(f => f.isFlac)) || groups[0]
      const isFlac = best.files.some(f => f.isFlac)
      let downloaded = 0
      for (const f of best.files) {
        const ok = await window.api.slskDownload({ username: best.username, filename: f.filename, size: f.size || 0 }).catch(() => null)
        if (ok) downloaded++
      }
      _scheduleLibRescan()
      return `Downloading "${best.folderName}" — ${downloaded} ${isFlac ? 'FLAC' : 'audio'} file${downloaded !== 1 ? 's' : ''} from ${best.username}. Check the Downloads tab.`
    }

    case 'search_and_download': {
      const q = input.query || ''
      _addChatMsg('status', `Searching for "${q}"…`)
      await _chatDoSearch(q)
      return `Search complete. Results shown above.`
    }

    case 'search_library': {
      const q = (input.query || '').toLowerCase().trim()
      const albumHits = state.library.filter(a =>
        (a.name || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q)
      ).slice(0, 8)

      const trackHits = []
      for (const a of state.library) {
        for (const t of (a.tracks || [])) {
          if ((t.title || '').toLowerCase().includes(q)) {
            trackHits.push(`"${t.title}" (${a.name} by ${a.artist})`)
            if (trackHits.length >= 5) break
          }
        }
        if (trackHits.length >= 5) break
      }

      if (!albumHits.length && !trackHits.length)
        return `Nothing matching "${input.query}" in library (${state.library.length} albums). It may need to be downloaded.`

      const parts = []
      if (albumHits.length) parts.push(`Albums/artists: ` + albumHits.map(a => `"${a.name}" by ${a.artist}`).join('; '))
      if (trackHits.length) parts.push(`Tracks: ` + trackHits.join('; '))
      return parts.join(' | ')
    }

    case 'control_playback': {
      const a = input.action
      if (a === 'play')  { audio.play().catch(() => {}); return 'Playing.' }
      if (a === 'pause') { audio.pause(); return 'Paused.' }
      if (a === 'stop')  { audio.pause(); audio.currentTime = 0; return 'Stopped.' }
      if (a === 'next')  { document.getElementById('btn-next')?.click(); return 'Skipped to next track.' }
      if (a === 'prev')  { document.getElementById('btn-prev')?.click(); return 'Went back to previous track.' }
      return `Unknown action: ${a}`
    }

    case 'set_volume': {
      const v = Math.max(0, Math.min(1, (input.level ?? 80) / 100))
      audio.volume = v; setVolDisplay(v)
      return `Volume set to ${Math.round(v * 100)}%.`
    }

    case 'add_to_queue': {
      const q = (input.query || '').toLowerCase()
      const match = state.library.find(a =>
        (a.name || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q)
      )
      if (!match) return `"${input.query}" not in library.`
      const tracks = match.tracks.map(t => ({ ...t, albumArtist: match.artist, artPath: match.artPath, albumName: match.name, albumId: match.id }))
      state.queue.push(...tracks)
      if (state.queueIndex < 0) { state.queueIndex = 0; playCurrentTrack() }
      else if (state.queuePanelOpen) renderQueuePanel()
      return `Added "${match.name}" (${tracks.length} tracks) to queue.`
    }

    case 'clear_queue': {
      state.queue = []; state.queueIndex = -1; state.isPlaying = false
      audio.pause(); audio.currentTime = 0
      updateNextPrefetch()
      updatePlayBtn?.(); updateNowPlaying?.(null)
      if (state.queuePanelOpen) renderQueuePanel()
      return 'Queue cleared.'
    }

    case 'shuffle_queue': {
      if (!state.queue.length) return 'Queue is empty.'
      const current = state.queue[state.queueIndex]
      const rest = state.queue.filter((_, i) => i !== state.queueIndex)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]]
      }
      state.queue = current ? [current, ...rest] : rest
      state.queueIndex = 0
      if (state.queuePanelOpen) renderQueuePanel()
      updateNextPrefetch()
      return `Queue shuffled — ${state.queue.length} tracks.`
    }

    case 'like_album': {
      let albumId = null
      if (input.query) {
        const q = input.query.toLowerCase()
        const match = state.library.find(a =>
          (a.name || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q)
        )
        albumId = match?.id
      } else {
        const cur = state.queue[state.queueIndex]
        albumId = cur?.albumId || state.currentAlbumId
      }
      if (!albumId) return 'Nothing is playing right now.'
      const album = state.library.find(a => a.id === albumId)
      toggleLike(albumId)
      const nowLiked = state.likedAlbums.includes(albumId)
      return `${nowLiked ? 'Liked' : 'Unliked'} "${album?.name || albumId}".`
    }

    case 'navigate': {
      navigate(input.page || 'home')
      return `Navigated to ${input.page}.`
    }

    case 'get_status': {
      const title  = document.getElementById('np-title')?.textContent?.trim()  || '—'
      const artist = document.getElementById('np-artist')?.textContent?.trim() || '—'
      const vol    = Math.round(audio.volume * 100)
      const qi     = state.queueIndex >= 0 ? `${state.queueIndex + 1}/${state.queue.length}` : 'stopped'
      const dur    = audio.duration ? `${Math.floor(audio.currentTime/60)}:${String(Math.floor(audio.currentTime%60)).padStart(2,'0')} / ${Math.floor(audio.duration/60)}:${String(Math.floor(audio.duration%60)).padStart(2,'0')}` : ''
      return `Playing: "${title}" by ${artist} (${qi})${dur ? ' at ' + dur : ''}. Vol: ${vol}%. Repeat: ${state.repeat}. Shuffle: ${state.shuffle ? 'on' : 'off'}. Speed: ${state.playbackSpeed || 1}x. Library: ${state.library.length} albums.`
    }

    case 'set_repeat': {
      const mode = input.mode || 'off'
      state.repeat = mode
      const isActive = mode !== 'off'
      document.getElementById('btn-repeat')?.classList.toggle('active', isActive)
      document.getElementById('np-modal-repeat')?.classList.toggle('active', isActive)
      updateNextPrefetch()
      return `Repeat set to ${mode}.`
    }

    case 'set_shuffle': {
      state.shuffle = !!input.enabled
      document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
      document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
      updateNextPrefetch()
      return `Shuffle ${state.shuffle ? 'on' : 'off'}.`
    }

    case 'set_speed': {
      const speed = input.speed || 1
      state.playbackSpeed = speed
      audio.playbackRate = speed
      document.getElementById('btn-speed')?.setAttribute('title', `Speed: ${speed}x`)
      return `Playback speed set to ${speed}x.`
    }

    case 'seek': {
      const secs = Math.max(0, Number(input.seconds) || 0)
      if (!audio.duration) return 'Nothing is playing.'
      audio.currentTime = Math.min(secs, audio.duration)
      return `Seeked to ${Math.floor(secs/60)}:${String(Math.floor(secs%60)).padStart(2,'0')}.`
    }

    case 'sleep_timer': {
      const mins = Number(input.minutes) || 0
      setSleepTimer(mins)
      return mins === 0 ? 'Sleep timer cancelled.' : `Sleep timer set — playback will stop in ${mins} minute${mins !== 1 ? 's' : ''}.`
    }

    case 'play_liked': {
      const liked = state.library.filter(a => state.likedAlbums.includes(a.id))
      if (!liked.length) return 'You have no liked albums yet. Like an album first.'
      const tracks = liked.flatMap(a => (a.tracks || []).map(t => ({ ...t, albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id })))
      state.queue = tracks; state.queueIndex = 0; playCurrentTrack()
      return `Playing ${tracks.length} tracks across ${liked.length} liked album${liked.length !== 1 ? 's' : ''}.`
    }

    case 'get_library': {
      const artists = {}
      for (const a of state.library) {
        if (!artists[a.artist]) artists[a.artist] = 0
        artists[a.artist]++
      }
      const top = Object.entries(artists).sort((a,b) => b[1]-a[1]).slice(0, 15)
        .map(([a, n]) => `${a} (${n})`).join(', ')
      return `Library: ${state.library.length} albums by ${Object.keys(artists).length} artists. Top artists: ${top}. Liked: ${state.likedAlbums.length} albums.`
    }

    case 'get_queue': {
      if (!state.queue.length) return 'Queue is empty.'
      const current = state.queue[state.queueIndex]
      const upcoming = state.queue.slice(state.queueIndex + 1, state.queueIndex + 6)
      const lines = [`Now: "${current?.title}" (${current?.albumName})`]
      if (upcoming.length) lines.push('Up next: ' + upcoming.map(t => `"${t.title}"`).join(', '))
      lines.push(`${state.queue.length} tracks total.`)
      return lines.join(' ')
    }

    case 'save_queue': {
      if (!state.queue.length) return 'Queue is empty — nothing to save.'
      const name = input.name || `Queue ${new Date().toLocaleDateString()}`
      const q = { id: `sq_${Date.now()}`, name, tracks: state.queue, savedAt: Date.now() }
      state.savedQueues = [q, ...state.savedQueues]
      window.api.saveQueue(q)
      return `Saved queue "${name}" with ${state.queue.length} tracks.`
    }

    case 'youtube_search': {
      const scope = input.scope === 'all' ? 'all' : 'music'
      const call = scope === 'all' ? window.api.ytSearch : window.api.ytMusicSearch
      const res = await call({ query: input.query })
      if (!res.ok) return `YouTube search failed: ${res.error}`
      if (!res.results.length) return `Nothing found on YouTube for "${input.query}"`
      return 'Top YouTube results:\n' + res.results.slice(0, 5).map((r, i) =>
        `${i + 1}. ${r.title} — ${r.artist} (${r.duration ? fmtDur(r.duration) : '?'}) [videoId: ${r.videoId}]`).join('\n')
    }

    case 'youtube_play': {
      const res = await window.api.ytMusicSearch({ query: input.query })
      if (!res.ok) return `YouTube search failed: ${res.error}`
      const r = res.results[0]
      if (!r) return `Nothing found on YouTube for "${input.query}"`
      state.queue = [_ytQueueItem(r)]
      state.queueIndex = 0
      playCurrentTrack()
      return `Streaming "${r.title}" by ${r.artist} from YouTube`
    }

    case 'youtube_download': {
      const res = await window.api.ytMusicSearch({ query: input.query })
      if (!res.ok) return `YouTube search failed: ${res.error}`
      const r = res.results[0]
      if (!r) return `Nothing found on YouTube for "${input.query}"`
      await window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
      return `Downloading "${r.title}" by ${r.artist} from YouTube (check Downloads page)`
    }

    default:
      return `Unknown tool: ${name}`
  }
}

// ── Main conversation loop ──────────────────────────────────────────────────
async function handleChatMessage(userMsg) {
  if (chatState.busy) return
  chatState.aborted = false
  _setChatBusy(true)
  if (!chatState.convStartedAt) chatState.convStartedAt = Date.now()

  _addChatMsg('user', userMsg)
  chatState.history.push({ role: 'user', content: userMsg })

  const thinkId = 'mcs-think-' + Date.now()
  _addChatMsg('agent', '…', { thinking: true, id: thinkId })

  try {
    // All providers now share the same tool-use loop.
    // Ollama returns { response } via its OpenAI-compat endpoint, with { ollamaFallback } as a safety net.
    const firstRes = await window.api.agentChat({ provider: chatState.provider, messages: chatState.history.slice(-12), tasteProfile: chatState.tasteProfile })

    if (firstRes.error) {
      _updateChatMsg(thinkId, firstRes.error, 'agent')

    } else if (firstRes.ollamaFallback) {
      // Fallback path: Ollama tool-calling failed, use simple intent
      const intent = firstRes.ollamaFallback
      _updateChatMsg(thinkId, intent.reply || '…')
      const i = intent.intent
      if      (i === 'search')       await _chatDoSearch(intent.query || userMsg)
      else if (i === 'download')     { const r = await _executeTool('auto_download',    { query: intent.query || userMsg }); _addChatMsg('agent', r) }
      else if (i === 'play')         { const r = await _executeTool('play_from_library',{ query: intent.query || userMsg }); _addChatMsg('agent', r) }
      else if (i === 'play_track')   { const r = await _executeTool('play_track',       { query: intent.query || userMsg }); _addChatMsg('agent', r) }
      else if (i === 'play_artist')  { const r = await _executeTool('play_artist',      { query: intent.query || userMsg }); _addChatMsg('agent', r) }
      else if (i === 'control')      { const r = await _executeTool('control_playback', { action: intent.action });          _addChatMsg('agent', r) }
      else if (i === 'volume')       { const r = await _executeTool('set_volume',       { level: intent.level });            _addChatMsg('agent', r) }
      else if (i === 'queue_add')    { const r = await _executeTool('add_to_queue',     { query: intent.query || userMsg }); _addChatMsg('agent', r) }
      else if (i === 'queue_clear')  { const r = await _executeTool('clear_queue',      {});                                 _addChatMsg('agent', r) }
      else if (i === 'queue_shuffle'){ const r = await _executeTool('shuffle_queue',    {});                                 _addChatMsg('agent', r) }
      else if (i === 'like')         { const r = await _executeTool('like_album',       {});                                 _addChatMsg('agent', r) }
      else if (i === 'navigate')     { const r = await _executeTool('navigate',         { page: intent.page });              _addChatMsg('agent', r) }
      else if (i === 'library')      { const r = await _executeTool('search_library',   { query: intent.query || userMsg }); _addChatMsg('agent', r) }
      else if (i === 'status')       { const r = await _executeTool('get_status',       {});                                 _addChatMsg('agent', r) }
      chatState.history.push({ role: 'assistant', content: intent.reply || '' })

    } else {
      // Full tool-use loop (Claude, OpenAI, and Ollama with tool-calling)
      let loopMsgs = [...chatState.history]
      let reply = ''

      // Process firstRes before looping
      let pendingRes = firstRes
      for (let iter = 0; iter < 8; iter++) {
        if (chatState.aborted) { _updateChatMsg(thinkId, 'Stopped.', 'agent'); break }
        const res = iter === 0 ? pendingRes : await window.api.agentChat({ provider: chatState.provider, messages: loopMsgs, tasteProfile: chatState.tasteProfile })
        if (chatState.aborted) { _updateChatMsg(thinkId, 'Stopped.', 'agent'); break }
        if (res.error) { _updateChatMsg(thinkId, res.error, 'agent'); break }

        const { response } = res
        const textBlocks = (response.content || []).filter(b => b.type === 'text')
        const toolBlocks = (response.content || []).filter(b => b.type === 'tool_use')
        const text = textBlocks.map(b => b.text).join('').trim()

        if (text) { _updateChatMsg(thinkId, text, 'agent'); reply = text }
        if (!toolBlocks.length || response.stop_reason === 'end_turn') break

        loopMsgs.push({ role: 'assistant', content: response.content })
        const toolResults = []
        for (const tb of toolBlocks) {
          if (chatState.aborted) break
          if (!text) _updateChatMsg(thinkId, `${tb.name.replace(/_/g,' ')}…`, 'agent')
          const result = await _executeTool(tb.name, tb.input)
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result })
        }
        if (chatState.aborted) { _updateChatMsg(thinkId, 'Stopped.', 'agent'); break }
        loopMsgs.push({ role: 'user', content: toolResults })
      }
      chatState.history.push({ role: 'assistant', content: reply || '(done)' })
    }
  } catch (err) {
    if (!chatState.aborted) _updateChatMsg(thinkId, `Error: ${err.message}`, 'agent')
  }
  _setChatBusy(false)
}

// ── UI helpers ──────────────────────────────────────────────────────────────
function _addChatMsg(role, text, opts = {}) {
  const msgs = document.getElementById('mcs-messages')
  if (!msgs) return null
  msgs.querySelector('.mcs-welcome')?.remove()
  const div = document.createElement('div')
  div.className = `mcs-msg ${role}${opts.thinking ? ' thinking' : ''}`
  div.textContent = text
  if (opts.id) div.id = opts.id
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
  return div
}

function _updateChatMsg(id, text, newRole) {
  const el   = document.getElementById(id)
  const msgs = document.getElementById('mcs-messages')
  if (!el) return
  if (newRole) el.className = `mcs-msg ${newRole}`
  el.textContent = text
  if (msgs) msgs.scrollTop = msgs.scrollHeight
}

async function _chatDoSearch(query) {
  const variants   = _buildSearchVariants(query)
  const seen       = new Set()
  const allResults = []
  const statusId   = 'mcs-srch-' + Date.now()
  _addChatMsg('status', `Searching ${variants.length} variant${variants.length > 1 ? 's' : ''} on Soulseek…`, { id: statusId })

  await Promise.all(variants.map(q =>
    window.api.slskSearch({ query: q, timeoutMs: 60000 })
      .then(({ results }) => {
        for (const r of (results || [])) {
          const key = (r.username || '') + '\x00' + (r.files?.[0]?.filename || '')
          if (!seen.has(key)) { seen.add(key); allResults.push(r) }
        }
      }).catch(() => {})
  ))

  const savedResults = slsk.results
  slsk.results = allResults
  const groups = _slskGroupByFolder()
  slsk.results = savedResults

  document.getElementById(statusId)?.remove()

  if (!groups.length) {
    _addChatMsg('agent', `Nothing found for "${query}" on Soulseek.`)
    return
  }

  const flacGroups = groups.filter(g => g.files.some(f => f.isFlac))
  const best       = flacGroups[0] || groups[0]
  const isLossless = best.files.some(f => f.isFlac)
  const qual       = _slskQualLabel(best.files)
  const trackCount = best.files.length
  const cardId     = 'mcs-card-' + Date.now()

  const msgs = document.getElementById('mcs-messages')
  if (!msgs) return
  const card = document.createElement('div')
  card.className = 'mcs-result-card'
  card.id = cardId
  card.innerHTML = `<strong>${esc(best.folderName)}</strong><br>
    <span class="mcs-rc-format">${isLossless ? 'LOSSLESS' : 'MP3'}</span>${qual ? ' · ' + esc(qual) : ''}<br>
    ${trackCount} track${trackCount !== 1 ? 's' : ''} · via ${esc(best.username)}<br>
    <span style="color:var(--text3);font-size:10px">${flacGroups.length} lossless · ${groups.length} total sources</span>
    <br><button class="mcs-result-dl-btn" id="${cardId}-dl">Download &amp; Play</button>`
  msgs.appendChild(card)
  msgs.scrollTop = msgs.scrollHeight

  document.getElementById(`${cardId}-dl`)?.addEventListener('click', async function () {
    this.disabled = true
    this.textContent = 'Downloading…'
    for (const f of best.files)
      await window.api.slskDownload({ username: best.username, filename: f.filename, size: f.size || 0 }).catch(() => {})
    this.textContent = 'Queued ✓'
    _scheduleLibRescan()
  })

  chatState.history.push({ role: 'assistant', content: `Found ${isLossless ? 'FLAC' : 'MP3'} · ${trackCount} tracks via ${best.username}` })
}

// ── Memory helpers ──────────────────────────────────────────────────────────
async function _saveCurrentConv() {
  if (chatState.history.length < 2) return
  const userMsgs  = chatState.history.filter(m => m.role === 'user')
  const title     = userMsgs[0]?.content?.slice(0, 60) || 'Conversation'
  const summary   = userMsgs.map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).slice(0, 3).join('; ')
  await window.api.agentSaveConv({ title, summary, messageCount: chatState.history.length }).catch(() => {})
}

async function _refreshProfile(force = false) {
  if (!force && chatState.history.length < 4) return
  const res = await window.api.agentUpdateProfile({ messages: chatState.history }).catch(() => null)
  if (res?.ok) _renderMemoryTab()
}

async function _renderMemoryTab(opts = {}) {
  const refreshBtn = document.getElementById('mcs-mem-refresh-btn')
  if (opts.loading && refreshBtn) { refreshBtn.textContent = '↻'; refreshBtn.classList.add('spinning') }

  const mem = await window.api.agentGetMemory().catch(() => ({ profile: null, recentConvs: [] }))

  if (refreshBtn) { refreshBtn.classList.remove('spinning'); refreshBtn.textContent = '↻' }

  const cards    = document.getElementById('mcs-mem-cards')
  const noProf   = document.getElementById('mcs-mem-no-profile')
  const convEl   = document.getElementById('mcs-mem-convs')
  const noHist   = document.getElementById('mcs-mem-no-history')
  const lastUpd  = document.getElementById('mcs-mem-last-updated')

  if (mem.profile?.insights?.length) {
    noProf.style.display = 'none'
    const iconMap = { taste: '♪', artists: '◈', habits: '◷', style: '◉', genres: '◈', other: '◆' }
    cards.innerHTML = mem.profile.insights.map(ins => `
      <div class="mcs-mem-card">
        <div class="mcs-mem-card-icon">${iconMap[ins.key] || '◆'}</div>
        <div class="mcs-mem-card-body">
          <div class="mcs-mem-card-key">${esc(ins.key)}</div>
          <div class="mcs-mem-card-text">${esc(ins.text)}</div>
        </div>
      </div>`).join('')
    if (lastUpd && mem.profile.updatedAt) {
      const d = new Date(mem.profile.updatedAt)
      lastUpd.textContent = 'Updated ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      lastUpd.style.display = ''
    }
  } else {
    noProf.style.display = ''
    cards.innerHTML = ''
    if (lastUpd) lastUpd.style.display = 'none'
  }

  if (mem.recentConvs?.length) {
    noHist.style.display = 'none'
    convEl.innerHTML = [...mem.recentConvs].reverse().map(c => {
      const d       = new Date(c.startedAt)
      const now     = Date.now()
      const diffMs  = now - c.startedAt
      const diffMin = Math.floor(diffMs / 60000)
      const dateStr = diffMin < 60
        ? `${diffMin}m ago`
        : diffMin < 1440
          ? `${Math.floor(diffMin / 60)}h ago`
          : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return `<div class="mcs-mem-conv">
        <span class="mcs-mem-conv-date">${dateStr}</span>
        <span class="mcs-mem-conv-title">${esc(c.title || 'Conversation')}</span>
        <span class="mcs-mem-conv-msgs">${c.messageCount ? c.messageCount + ' msgs' : ''}</span>
      </div>`
    }).join('')
  } else {
    noHist.style.display = ''
    convEl.innerHTML = ''
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────
function _switchMcsTab(tab) {
  chatState.activeTab = tab
  document.querySelectorAll('.mcs-tab-btn').forEach(b => b.classList.toggle('mcs-tab-active', b.dataset.tab === tab))
  document.querySelectorAll('.mcs-panel').forEach(p => p.classList.toggle('mcs-panel-hidden', !p.id.endsWith(tab)))
  if (tab === 'memory') _renderMemoryTab()
}

// ── Settings panel ───────────────────────────────────────────────────────────
async function _initSettingsPanel() {
  const saved = await window.api.getApiKeys().catch(() => ({ provider: 'ollama' }))
  chatState.provider = saved.provider || 'ollama'
  const sel = document.getElementById('mcs-provider-sel')
  if (sel) sel.value = chatState.provider
  _updateProviderRows(chatState.provider)

  // Show hint so the field isn't blank when a key is already stored
  const claudeInput = document.getElementById('mcs-claude-key')
  const openaiInput = document.getElementById('mcs-openai-key')
  if (claudeInput && saved.claudeSet) claudeInput.placeholder = 'Key saved ✓ — paste new one to change'
  if (openaiInput && saved.openaiSet) openaiInput.placeholder = 'Key saved ✓ — paste new one to change'

  sel?.addEventListener('change', e => _updateProviderRows(e.target.value))

  document.getElementById('agent-refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('agent-refresh-btn')
    btn?.classList.add('spinning')
    await _refreshOllamaModels()
    btn?.classList.remove('spinning')
  })
  document.getElementById('agent-model-select')?.addEventListener('change', e => window.api.saveAgentModel(e.target.value))

  document.getElementById('mcs-set-save-btn')?.addEventListener('click', async () => {
    const provider   = document.getElementById('mcs-provider-sel')?.value || 'ollama'
    const claudeKey  = document.getElementById('mcs-claude-key')?.value?.trim()
    const openaiKey  = document.getElementById('mcs-openai-key')?.value?.trim()
    const claudeModel = document.getElementById('mcs-claude-model')?.value
    const openaiModel = document.getElementById('mcs-openai-model')?.value
    const ollamaModel = document.getElementById('agent-model-select')?.value
    const modelToSave = provider === 'claude' ? claudeModel : provider === 'openai' ? openaiModel : ollamaModel
    if (modelToSave) window.api.saveAgentModel(modelToSave)
    await window.api.saveApiKeys({ provider, claudeKey, openaiKey })
    chatState.provider = provider
    // Refresh placeholders so inputs don't look empty after saving
    if (claudeInput && claudeKey) { claudeInput.value = ''; claudeInput.placeholder = 'Key saved ✓ — paste new one to change' }
    if (openaiInput && openaiKey) { openaiInput.value = ''; openaiInput.placeholder = 'Key saved ✓ — paste new one to change' }
    const btn = document.getElementById('mcs-set-save-btn')
    if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { btn.textContent = 'Save Settings' }, 1500) }
  })

  _refreshOllamaModels()
}

async function initPlaybackSettings() {
  const cfg = await window.api.playerGetConfig()
  const $ = id => document.getElementById(id)
  $('pb-output-mode').value = cfg.outputMode
  $('pb-mode').value = cfg.mode
  $('pb-cf-secs').value = cfg.crossfadeSecs
  $('pb-cf-label').textContent = `${cfg.crossfadeSecs}s`
  $('pb-replaygain').value = cfg.replaygain
  $('pb-channels').value = cfg.channels
  $('pb-boost').checked = !!cfg.boost
  $('pb-device-row').style.display = cfg.outputMode === 'exclusive' ? '' : 'none'
  $('pb-cf-row').style.display = cfg.mode === 'crossfade' ? '' : 'none'

  const devices = await window.api.playerListDevices()
  $('pb-alsa-device').innerHTML = devices
    .filter(d => d.name.startsWith('alsa/'))
    .map(d => `<option value="${d.name}" ${d.name === cfg.alsaDevice ? 'selected' : ''}>${d.description}</option>`)
    .join('')

  const apply = (partial) => window.api.playerSetConfig(partial)
  $('pb-output-mode').onchange = e => {
    $('pb-device-row').style.display = e.target.value === 'exclusive' ? '' : 'none'
    apply({ outputMode: e.target.value, alsaDevice: $('pb-alsa-device').value || null })
  }
  $('pb-alsa-device').onchange = e => apply({ alsaDevice: e.target.value })
  $('pb-mode').onchange = e => {
    $('pb-cf-row').style.display = e.target.value === 'crossfade' ? '' : 'none'
    apply({ mode: e.target.value })
  }
  $('pb-cf-secs').oninput = e => { $('pb-cf-label').textContent = `${e.target.value}s` }
  $('pb-cf-secs').onchange = e => apply({ crossfadeSecs: Number(e.target.value) })
  $('pb-replaygain').onchange = e => apply({ replaygain: e.target.value })
  $('pb-channels').onchange = e => apply({ channels: e.target.value })
  $('pb-boost').onchange = e => apply({ boost: e.target.checked })
}

function _updateProviderRows(provider) {
  document.getElementById('mcs-ollama-row')?.classList.toggle('mcs-set-hidden', provider !== 'ollama')
  document.getElementById('mcs-claude-row')?.classList.toggle('mcs-set-hidden', provider !== 'claude')
  document.getElementById('mcs-openai-row')?.classList.toggle('mcs-set-hidden', provider !== 'openai')
}

async function _refreshOllamaModels(preselect) {
  const dot  = document.getElementById('agent-status-dot')
  const hint = document.getElementById('agent-hint')
  const sel  = document.getElementById('agent-model-select')
  try {
    const res   = await window.api.checkOllama()
    const saved = preselect || await window.api.getAgentModel().catch(() => '')
    if (res.running && res.models.length) {
      dot?.setAttribute('class', 'agent-status-dot online')
      if (sel) sel.innerHTML = res.models.map(m => `<option value="${esc(m)}"${m===saved?' selected':''}>${esc(m)}</option>`).join('')
      if (hint) hint.textContent = `${res.models.length} model${res.models.length > 1 ? 's' : ''} available`
    } else if (res.running) {
      dot?.setAttribute('class', 'agent-status-dot online')
      if (sel) sel.innerHTML = '<option value="">No models — run: ollama pull qwen2.5:3b</option>'
      if (hint) hint.textContent = 'Ollama running — pull a model to start'
    } else {
      dot?.setAttribute('class', 'agent-status-dot offline')
      if (sel) sel.innerHTML = '<option value="">Offline</option>'
      if (hint) hint.textContent = 'Ollama not running'
    }
  } catch (_) { dot?.setAttribute('class', 'agent-status-dot offline') }
}

function toggleChatSidebar() {
  const wasOpen = chatState.open
  chatState.open = !chatState.open
  const mcs    = document.getElementById('mcs')
  const btn    = document.getElementById('btn-agent-chat')
  const layout = document.querySelector('.layout')
  mcs?.classList.toggle('open', chatState.open)
  mcs?.setAttribute('aria-hidden', String(!chatState.open))
  btn?.classList.toggle('active', chatState.open)
  layout?.classList.toggle('mcs-open', chatState.open)
  if (chatState.open) {
    document.getElementById('mcs-input')?.focus()
  } else if (wasOpen && chatState.history.length >= 2) {
    _saveCurrentConv()
    _refreshProfile()
    chatState.history = []
    chatState.convStartedAt = null
  }
}

function _renderTastePills() {
  const artists = chatState.tasteProfile.topArtists || []
  const wrap    = document.getElementById('mcs-taste')
  const pills   = document.getElementById('mcs-taste-artists')
  if (!artists.length || !wrap || !pills) return
  wrap.style.display = ''
  pills.innerHTML = artists.slice(0, 8).map(a =>
    `<span class="mcs-taste-pill" data-artist="${esc(a)}">${esc(a)}</span>`
  ).join('')
  pills.querySelectorAll('.mcs-taste-pill').forEach(p => {
    p.addEventListener('click', () => handleChatMessage(p.dataset.artist))
  })
}

async function initChatSidebar() {
  document.getElementById('btn-agent-chat')?.addEventListener('click', toggleChatSidebar)
  document.getElementById('mcs-close-btn')?.addEventListener('click', toggleChatSidebar)
  document.addEventListener('keydown', e => { if (e.ctrlKey && e.key === '/') { e.preventDefault(); toggleChatSidebar() } })

  // Tab buttons
  document.querySelectorAll('.mcs-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchMcsTab(btn.dataset.tab))
  })

  // Memory clear button
  document.getElementById('mcs-mem-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all agent memory? This cannot be undone.')) return
    await window.api.agentClearMemory()
    _renderMemoryTab()
  })

  // Memory refresh button — force profile update from current conversation
  document.getElementById('mcs-mem-refresh-btn')?.addEventListener('click', async () => {
    await _refreshProfile(true)
    _renderMemoryTab({ loading: true })
  })

  // Chat input
  const input   = document.getElementById('mcs-input')
  const sendBtn = document.getElementById('mcs-send-btn')
  const stopBtn = document.getElementById('mcs-stop-btn')
  const doSend  = () => {
    const msg = input?.value.trim()
    if (!msg || chatState.busy) return
    input.value = ''
    _switchMcsTab('chat')
    handleChatMessage(msg)
  }
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') doSend() })
  sendBtn?.addEventListener('click', doSend)
  stopBtn?.addEventListener('click', () => { chatState.aborted = true })

  await _initSettingsPanel()

  chatState.tasteProfile = await window.api.tasteGetProfile().catch(() => ({ totalPlays: 0, topArtists: [], recent: [] }))
  _renderTastePills()
  _initTasteTracking()
}

function _initTasteTracking() {
  let playedMs = 0
  let recorded = false
  let lastSrc  = ''
  let ticker   = null

  const tick = () => {
    if (!audio.paused && audio.src === lastSrc) playedMs += 500
    if (playedMs >= 30000 && !recorded) {
      recorded = true
      const artist = document.getElementById('np-artist')?.textContent?.trim() || ''
      const album  = document.getElementById('np-album')?.textContent?.trim()  || ''
      const title  = document.getElementById('np-title')?.textContent?.trim()  || ''
      if (artist && artist !== '—') {
        window.api.tasteRecordPlay({ artist, album, title }).catch(() => {})
        window.api.tasteGetProfile().then(p => {
          chatState.tasteProfile = p
          _renderTastePills()
        }).catch(() => {})
      }
    }
  }

  audio.addEventListener('play', () => {
    if (audio.src !== lastSrc) { lastSrc = audio.src; playedMs = 0; recorded = false }
    if (!ticker) ticker = setInterval(tick, 500)
  })
  audio.addEventListener('pause', () => { clearInterval(ticker); ticker = null })
  audio.addEventListener('ended', () => { clearInterval(ticker); ticker = null })
}

function showAddSourceDialog() {
  const existing = document.getElementById('qsrc-add-dialog')
  if (existing) { existing.remove(); return }
  const dlg = document.createElement('div')
  dlg.id = 'qsrc-add-dialog'
  dlg.className = 'dialog-overlay'
  dlg.innerHTML = `
    <div class="dialog-card">
      <h2>Add Quality Source</h2>
      <p>Enter a site name and its search URL. Use <code>{query}</code> where the search term goes.</p>
      <input class="dialog-input" id="qsrc-name-input"   type="text" placeholder="Site name (e.g. Monochrome)">
      <input class="dialog-input" id="qsrc-url-input"    type="text" placeholder="Search URL (e.g. https://site.com/search?q={query})">
      <div class="dialog-actions">
        <button class="dialog-cancel" id="qsrc-cancel-btn">Cancel</button>
        <button class="dialog-confirm" id="qsrc-confirm-btn">Add</button>
      </div>
    </div>`
  document.body.appendChild(dlg)
  document.getElementById('qsrc-cancel-btn').addEventListener('click', () => dlg.remove())
  document.getElementById('qsrc-confirm-btn').addEventListener('click', () => {
    const name = document.getElementById('qsrc-name-input').value.trim()
    const url  = document.getElementById('qsrc-url-input').value.trim()
    if (!name || !url || !url.includes('{query}')) return
    const id = `custom_${Date.now()}`
    state.qualitySources = [...state.qualitySources, { id, name, searchUrl: url, enabled: true }]
    window.api.saveQualitySources(state.qualitySources)
    renderQualitySources()
    dlg.remove()
  })
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove() })
}

async function discoverSources() {
  const btn = document.getElementById('qsrc-discover-btn')
  if (btn) { btn.textContent = 'Discovering…'; btn.disabled = true }
  try {
    const found = await window.api.probeKnownSources()
    const existing = new Set(state.qualitySources.map(s => s.id))
    const newSrcs = found.filter(f => !existing.has(f.id))
    if (newSrcs.length) {
      state.qualitySources = [...state.qualitySources, ...newSrcs.map(f => ({ ...f, enabled: true }))]
      window.api.saveQualitySources(state.qualitySources)
      renderQualitySources()
    }
    if (btn) btn.textContent = newSrcs.length ? `Added ${newSrcs.length}` : 'None found'
  } catch (_) {
    if (btn) btn.textContent = 'Error'
  }
  setTimeout(() => { if (btn) { btn.textContent = 'Discover'; btn.disabled = false } }, 3000)
}

function _restoreOnlineCache(query, sources) {
  const list = document.getElementById('online-search-results')
  if (!list) return
  const cached = _onlineCache.get(query)
  if (!cached) return
  for (const source of sources) {
    const entry = cached.get(source.id)
    if (!entry) continue
    const row = list.querySelector(`[data-source="${source.id}"]`)
    if (!row) continue
    _applyOnlineResult(row, source, query, entry.result, entry.url)
  }
}

function _applyOnlineResult(row, source, query, result, url) {
  if (result === null) {
    row.innerHTML = `<span class="osrc-name">${esc(source.name)}</span><span class="osrc-status error">Unreachable</span><button class="osrc-open-btn secondary" data-url="${esc(url)}">Try →</button>`
    row.querySelector('.osrc-open-btn')?.addEventListener('click', e => openSourceUrl(e.currentTarget.dataset.url))
    return
  }
  if (result.found) {
    row.innerHTML = `
      <span class="osrc-name">${esc(source.name)}</span>
      <span class="osrc-status found">Found</span>
      <button class="osrc-dl-btn" data-url="${esc(url)}" data-sid="${esc(source.id)}">↓ Download</button>
      <button class="osrc-open-btn secondary" data-url="${esc(url)}">Open</button>`
    row.querySelector('.osrc-dl-btn')?.addEventListener('click', async e => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Starting…'
      const res = await window.api.autoDownloadFromSource({ url: btn.dataset.url, sourceId: btn.dataset.sid })
      if (res.ok) { btn.textContent = '↓ Downloading'; btn.style.opacity = '0.6' }
      else { btn.disabled = false; btn.textContent = '↓ Download'; openSourceUrl(btn.dataset.url) }
    })
    row.querySelector('.osrc-open-btn')?.addEventListener('click', e => openSourceUrl(e.currentTarget.dataset.url))
    _markUpgradeHints(query, source, url)
  } else {
    row.innerHTML = `<span class="osrc-name">${esc(source.name)}</span><span class="osrc-status not-found">Not found</span><button class="osrc-open-btn secondary" data-url="${esc(url)}">Search →</button>`
    row.querySelector('.osrc-open-btn')?.addEventListener('click', e => openSourceUrl(e.currentTarget.dataset.url))
  }
}

async function runOnlineSearch(query, sources) {
  const list = document.getElementById('online-search-results')
  if (!list) return
  if (!_onlineCache.has(query)) _onlineCache.set(query, new Map())
  const queryCache = _onlineCache.get(query)

  await Promise.all(sources.map(async (source) => {
    const url = source.searchUrl.replace('{query}', encodeURIComponent(query))
    const row = list.querySelector(`[data-source="${source.id}"]`)
    try {
      const result = await window.api.searchOnlineSource({ url })
      queryCache.set(source.id, { result, url })
      if (row) _applyOnlineResult(row, source, query, result, url)
    } catch (_) {
      queryCache.set(source.id, { result: null, url })
      if (row) _applyOnlineResult(row, source, query, null, url)
    }
  }))
}

function openSourceUrl(url) {
  if (state.currentPage !== 'browse') navigate('browse')
  setTimeout(() => { window.api.showBrowser(''); window.api.browserNavigate(url) }, 150)
}

// ── Soulseek ─────────────────────────────────────────────────────────────────
function _slskGroupByFolder(queryHint) {
  const AUDIO = new Set(['flac','wav','aiff','mp3','ogg','m4a','aac','opus','ape','wv'])
  const LOSSLESS = new Set(['flac','wav','aiff','ape','wv'])
  const folders = new Map()
  for (const resp of slsk.results) {
    for (const f of resp.files || []) {
      const norm  = (f.filename || '').replace(/\//g, '\\')
      const parts = norm.split('\\')
      const folderPath = parts.slice(0, -1).join('\\')
      const ext   = parts[parts.length - 1].split('.').pop().toLowerCase()
      if (!AUDIO.has(ext)) continue
      const key   = `${resp.username}::${folderPath}`
      if (!folders.has(key)) {
        const folderName = parts[parts.length - 2] || parts[parts.length - 1] || folderPath
        folders.set(key, {
          username: resp.username, folderPath, folderName,
          uploadSpeed: resp.uploadSpeed || 0,
          freeUploadSlots: resp.freeUploadSlots || 0,
          files: [],
        })
      }
      folders.get(key).files.push({ ...f, ext, isFlac: LOSSLESS.has(ext) })
    }
  }

  // Relevance scoring against the current search query
  const qWords = (queryHint || slsk.lastQuery || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2)

  const score = (g) => {
    const nameL = (g.folderName || '').toLowerCase()
    const pathL = (g.folderPath || '').toLowerCase()
    const text  = nameL + ' ' + pathL
    let s = 0
    // Lossless bonus (FLAC/WAV/etc.)
    const flacCount = g.files.filter(f => f.isFlac).length
    s += flacCount * 8
    // Track count: albums with 3+ tracks rank higher than singles/samplers
    const trackCount = g.files.length
    s += Math.min(trackCount, 20) * 2
    // Query keyword match
    for (const w of qWords) if (text.includes(w)) s += 5
    // Peer availability (upload slots)
    if (g.freeUploadSlots > 0) s += 10
    // Upload speed (log scale so fast peers get a reasonable bonus)
    if (g.uploadSpeed > 0) s += Math.min(Math.log2(g.uploadSpeed / 1024 + 1) * 2, 12)
    // Penalize single-file results (likely not an album)
    if (trackCount === 1) s -= 5
    return s
  }

  return [...folders.values()]
    .filter(g => g.files.length > 0)
    .sort((a, b) => score(b) - score(a))
}

function _slskQualLabel(files) {
  const ref = files.find(f => f.isFlac) || files[0]
  if (!ref) return ''
  const parts = [
    ref.ext === 'flac' || ref.isFlac ? 'FLAC' : ref.ext?.toUpperCase(),
    ref.bitDepth   ? `${ref.bitDepth}-bit`                   : '',
    ref.sampleRate ? `${(ref.sampleRate/1000).toFixed(1)} kHz` : '',
    ref.bitRate && !ref.isFlac ? `${ref.bitRate} kbps`       : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

function renderSoulseekRow(query) {
  const s = slsk.status

  // Pure spinner when no results yet
  if (slsk.searching && !slsk.results.length) {
    const pending = slsk.pendingSearches || 0
    const hint = pending > 1
      ? `Searching ${pending} query variants…`
      : 'Searching P2P network…'
    return `<div class="slsk-container" id="slsk-row">
      <div class="slsk-header-row">
        <span class="osrc-name">Soulseek</span>
        <span class="osrc-status searching">${hint}</span>
      </div>
    </div>`
  }
  // When we have partial results but are still searching, fall through and render the grid

  if (!s.installed) {
    return `<div class="osrc-row slsk-row" id="slsk-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status" style="color:var(--text3)">Not installed</span>
      <button class="osrc-agent-btn" id="slsk-setup-btn">Install</button>
    </div>`
  }
  if (!s.configured) {
    return `<div class="osrc-row slsk-row" id="slsk-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status" style="color:#f0a500">Setup required</span>
      <button class="osrc-agent-btn" id="slsk-config-btn">Configure</button>
    </div>`
  }
  if (!s.connected) {
    return `<div class="osrc-row slsk-row" id="slsk-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status" style="color:var(--text3)">${s.running ? 'Connecting…' : 'Offline'}</span>
    </div>`
  }

  const rawGroups = _slskGroupByFolder()

  // Re-sort with query-relevance as a tiebreaker within the same FLAC-count tier
  const qWords = (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const _qScore = g => qWords.length
    ? qWords.filter(w => (g.folderName || '').toLowerCase().includes(w)).length / qWords.length
    : 0
  const groups = rawGroups.sort((a, b) => {
    const aF = a.files.filter(f => f.isFlac).length, bF = b.files.filter(f => f.isFlac).length
    if (bF !== aF) return bF - aF
    const qs = _qScore(b) - _qScore(a)
    if (Math.abs(qs) > 0.15) return qs
    if (b.files.length !== a.files.length) return b.files.length - a.files.length
    return b.uploadSpeed - a.uploadSpeed
  })

  if (!groups.length && slsk.searched) {
    return `<div class="slsk-container" id="slsk-row">
      <div class="slsk-header-row">
        <span class="osrc-name">Soulseek</span>
        <span class="osrc-status not-found">No results</span>
        <button class="slsk-retry-btn" id="slsk-retry-btn">↺ Retry</button>
      </div>
      <div class="slsk-nat-hint">
        Nothing found on the P2P network. The Soulseek network may still be warming up — click <strong>Retry</strong> to search again.
      </div>
    </div>`
  }
  if (!groups.length) {
    return `<div class="osrc-row slsk-row" id="slsk-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status not-found">Nothing found</span>
    </div>`
  }

  const flacGroups  = groups.filter(g => g.files.some(f => f.isFlac))
  const otherGroups = groups.filter(g => !g.files.some(f => f.isFlac))
  // FLAC/lossless groups first, then other formats — show up to 60 sources
  const displayList  = [...flacGroups, ...otherGroups].slice(0, 60)
  const isUpdating   = slsk.searching && slsk.results.length > 0
  const pending      = slsk.pendingSearches || 0
  const updateNote   = isUpdating ? ` <span class="slsk-updating">· scanning${pending > 0 ? ' ('+pending+' left)' : ''}…</span>` : ''
  const summary      = flacGroups.length
    ? `${flacGroups.length} lossless${otherGroups.length > 0 ? ` · ${otherGroups.length} other` : ''} source${groups.length !== 1 ? 's' : ''}${updateNote}`
    : `${groups.length} source${groups.length !== 1 ? 's' : ''}${updateNote}`

  return `<div class="slsk-container" id="slsk-row">
    <div class="slsk-header-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status found">${summary}</span>
      <button class="slsk-retry-btn" id="slsk-retry-btn" title="Search again" style="margin-left:auto">↺</button>
    </div>
    <div class="slsk-grid">
      ${displayList.map((g, gi) => {
        const qual    = _slskQualLabel(g.files)
        const hasFlac = g.files.some(f => f.isFlac)
        const hue     = Math.abs([...g.folderName].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
        return `<div class="slsk-card" data-gi="${gi}">
          <div class="slsk-card-art" style="background:linear-gradient(135deg,hsl(${hue},45%,16%),hsl(${(hue+40)%360},35%,10%))">
            ${hasFlac ? '<span class="slsk-card-lossless">LOSSLESS</span>' : ''}
            <svg class="slsk-card-note" viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
          </div>
          <div class="slsk-card-body">
            <div class="slsk-card-name" title="${esc(g.folderName)}">${esc(g.folderName)}</div>
            ${qual ? `<div class="slsk-card-qual">${esc(qual)}</div>` : ''}
            <div class="slsk-card-from">via <button class="slsk-user-link" data-gi="${gi}" data-username="${esc(g.username)}" title="Browse ${esc(g.username)}'s shared library">${esc(g.username)}</button></div>
            <div class="slsk-card-btns">
              <button class="slsk-play-btn slsk-card-action" data-gi="${gi}" title="Download &amp; play">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Play
              </button>
              <button class="slsk-dl-all-btn slsk-card-action" data-gi="${gi}" title="Download all files">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </button>
              <button class="slsk-expand-btn slsk-card-action" data-gi="${gi}" title="Show tracks">
                ${g.files.length} track${g.files.length !== 1 ? 's' : ''} ▾
              </button>
            </div>
          </div>
          <div class="slsk-track-list" id="slsk-tl-${gi}" style="display:none"></div>
        </div>`
      }).join('')}
    </div>
  </div>`
}

function _buildSearchVariants(query) {
  const raw = query.trim()

  // Normalize diacritics: é→e, ñ→n etc. (many Soulseek filenames strip accents)
  const ascii = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

  // Clean: strip (parens)/[brackets] content, collapse spaces — keep dashes for now
  const clean = raw
    .replace(/\s*[\(\[][^\)\]]{0,60}[\)\]]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Also clean without dashes (e.g. "Rock - 2004" → "Rock 2004")
  const cleanNoDash = clean.replace(/\s*[-–—]\s*/g, ' ').replace(/\s+/g, ' ').trim()

  const seen = new Set()
  const variants = []
  const add = (v) => {
    const t = (v || '').trim()
    if (t.length >= 2 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); variants.push(t) }
  }

  // 1. Cleaned full query (no dash stripping yet) — most literal
  add(clean)

  // 2. Raw if cleaning changed it (catches extra parens)
  if (raw.toLowerCase() !== clean.toLowerCase()) add(raw)

  const words = cleanNoDash.split(/\s+/)

  // 3. Dash-stripped version
  if (cleanNoDash.toLowerCase() !== clean.toLowerCase()) add(cleanNoDash)

  // 4. ASCII-normalized — for accented artist/album names
  if (ascii.toLowerCase() !== clean.toLowerCase()) add(ascii)

  // 5. Strip stop words: feat/ft/featuring/and/&/with — but KEEP "the/a/of" since they're
  //    often part of album titles ("The Wall", "Kind of Blue", "A Love Supreme")
  const STOP_FEAT = new Set(['feat','ft','featuring','and','&','with','vs','presents','pres'])
  const noFeat = words.filter(w => !STOP_FEAT.has(w.toLowerCase()))
  if (noFeat.length >= 2 && noFeat.length < words.length) add(noFeat.join(' '))

  // 6. Strip 4-digit years
  const noYear = words.filter(w => !/^\d{4}$/.test(w))
  if (noYear.length >= 2 && noYear.length < words.length) add(noYear.join(' '))

  // 7. For "Artist - Album" or "Artist, Album" patterns, try each half separately
  const dashSplit = raw.split(/\s+[-–—]\s+/)
  if (dashSplit.length === 2) { add(dashSplit[0].trim()); add(dashSplit[1].trim()) }
  const commaSplit = raw.split(/\s*,\s*/)
  if (commaSplit.length === 2) { add(commaSplit[0].trim()); add(commaSplit[1].trim()) }

  // 8. Drop first word (artist name often appears as folder prefix but not in filename)
  if (words.length >= 3) add(words.slice(1).join(' '))

  // 9. Last 3 words (usually the album/song title)
  if (words.length >= 5) add(words.slice(-3).join(' '))

  // 10. Last 2 words
  if (words.length >= 3) add(words.slice(-2).join(' '))

  // 11. Reversed for 2-word queries (both "Artist Title" and "Title Artist" orders exist)
  if (words.length === 2) add(words[1] + ' ' + words[0])

  return variants.slice(0, 8)  // up from 6
}

// Client-side cache invalidation — passes noCache:true to main process for all variants
const _nocacheQueries = new Set()
function _searchCache_invalidate(query) {
  _buildSearchVariants(query).forEach(v => _nocacheQueries.add(v.toLowerCase()))
  setTimeout(() => _buildSearchVariants(query).forEach(v => _nocacheQueries.delete(v.toLowerCase())), 60000)
}

async function runSlskSearch(query) {
  slsk.lastQuery = query
  const navQ = document.getElementById('nav-search-query')
  if (navQ) navQ.textContent = query

  // Show "Searching…" immediately — avoids flash while status is fetched
  slsk.searching = true
  slsk.searched  = false
  slsk.results   = []
  slsk.pendingSearches = 0
  const sectionEarly = document.getElementById('slsk-section')
  if (sectionEarly) { sectionEarly.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }

  await refreshSlskStatus()

  const section = document.getElementById('slsk-section')
  if (!section) return

  if (!slsk.status.connected) {
    slsk.searching = false
    section.innerHTML = renderSoulseekRow(query)
    return
  }

  section.innerHTML = renderSoulseekRow(query)

  const variants = _buildSearchVariants(query)
  slsk.pendingSearches = variants.length

  // Dedup key set shared across all parallel searches
  const seen = new Set()
  let _flushQueued = false

  const _flush = () => {
    if (_flushQueued) return
    _flushQueued = true
    requestAnimationFrame(() => {
      _flushQueued = false
      const sec = document.getElementById('slsk-section')
      if (sec) { sec.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }
    })
  }

  const _mergeResults = (results) => {
    for (const r of (results || [])) {
      const key = (r.username || '') + '\x00' + (r.files?.[0]?.filename || '')
      if (!seen.has(key)) { seen.add(key); slsk.results.push(r) }
    }
  }

  // Progressive results via push events — fires every ~2.5s from main process
  // This gives us intermediate results BEFORE the IPC invoke resolves
  window.api.off('slsk-progress')
  window.api.on('slsk-progress', (d) => {
    if (d.query && !variants.includes(d.query) && d.query.toLowerCase() !== query.toLowerCase()) return
    _mergeResults(d.results)
    _flush()
  })

  // Run all variants in parallel; each returns after 25s max (or earlier with enough results)
  const TIMEOUT = 25000
  await Promise.all(variants.map(q =>
    window.api.slskSearch({ query: q, timeoutMs: TIMEOUT, noCache: _nocacheQueries.has(q.toLowerCase()) }).then(({ results }) => {
      _mergeResults(results)
    }).catch(() => {}).finally(() => {
      slsk.pendingSearches = Math.max(0, slsk.pendingSearches - 1)
      if (slsk.pendingSearches === 0) {
        slsk.searching = false
        slsk.searched  = true
        window.api.off('slsk-progress')
      }
      _flush()
    })
  ))

  // Final cleanup in case some variant is still pending (shouldn't happen after Promise.all)
  window.api.off('slsk-progress')
  slsk.searching = false
  slsk.searched  = true
  _flush()
}

async function refreshSlskStatus() {
  try { slsk.status = await window.api.slskStatus() } catch (_) {}
}

function _scheduleLibRescan() {
  setTimeout(backgroundSync, 15_000)
  setTimeout(backgroundSync, 45_000)
  setTimeout(backgroundSync, 120_000)
}

// ── Downloads page ────────────────────────────────────────────────────────────
let _dlPollTimer        = null
let _dlPollInterval     = 6000
let _dlTab              = 'active'   // 'active' | 'completed' | 'failed'
let _dlLastFiles        = []
let _dlLastSig          = ''        // tracks current rendered structure to avoid full re-renders
let _dlDownloadDir      = ''        // local download directory, loaded once on page open
let _dlPrevActiveIds    = new Set() // IDs of files that were active on last poll
let _dlSyncTimer        = null      // debounce handle for post-download library sync
const _dlOpenGroups       = new Set() // folder names explicitly opened in completed tab
const _dlFailedOpenGroups = new Set() // folder names explicitly opened in failed tab
let _dlFilter             = ''        // current text filter for completed tab
let _dlCompletedGroups    = []        // flat group list from last completed render (for expand-all)

function _dlSig(tab, files) {
  return tab + '|' + files.map(f => f.id).join(',')
}

function startDownloadsPolling(interval = 6000) {
  if (_dlPollTimer && _dlPollInterval === interval) return
  if (_dlPollTimer) clearInterval(_dlPollTimer)
  _dlPollInterval = interval
  _pollAndRenderDownloads()
  _dlPollTimer = setInterval(_pollAndRenderDownloads, interval)
}

function stopDownloadsPolling() {
  if (_dlPollTimer) { clearInterval(_dlPollTimer); _dlPollTimer = null }
}

// ── Downloads context menu ───────────────────────────────────────────────────
// Native Electron context menu — bypasses all DOM event issues
// items: array of { action, label } or 'sep'; handlers: { [action]: fn }
async function _showDlCtxMenu(e, items, handlers) {
  e.preventDefault()
  e.stopPropagation()
  const action = await window.api.ctxMenuShow(items)
  if (action && handlers[action]) handlers[action]()
}

async function _pollAndRenderDownloads() {
  const raw = await window.api.slskGetTransfers().catch(() => [])
  const files = []
  for (const user of (raw || [])) {
    for (const dir of (user.directories || [])) {
      for (const f of (dir.files || [])) {
        files.push({ ...f, username: user.username })
      }
    }
  }
  _dlLastFiles = files

  // Detect transitions from active → succeeded and trigger a library sync
  const nowActive = new Set(files.filter(f => _dlCategory(f.state) === 'active').map(f => f.id))
  const justCompleted = [..._dlPrevActiveIds].some(id => {
    const f = files.find(x => x.id === id)
    return f && _dlCategory(f.state) === 'completed'
  })
  if (justCompleted) {
    clearTimeout(_dlSyncTimer)
    _dlSyncTimer = setTimeout(() => backgroundSync(), 3000)
  }
  _dlPrevActiveIds = nowActive

  const activeCount = files.filter(f => _dlCategory(f.state) === 'active').length
  const badge = document.getElementById('nav-dl-badge')
  if (badge) { badge.style.display = activeCount > 0 ? 'flex' : 'none'; badge.textContent = activeCount }

  const completedNow = files.filter(f => _dlCategory(f.state) === 'completed')
  if (_dlPrevActiveCount > 0 && activeCount === 0 && completedNow.length > 0) {
    const folder = completedNow[0] ? _dlFolderName(completedNow[0].filename) || 'your music' : 'your music'
    window.api.notifyDownloadComplete({ count: completedNow.length, albumName: folder })
  }
  _dlPrevActiveCount = activeCount

  if (state.currentPage !== 'downloads') return
  _updateDlTabCounts(files)
  _renderDlTab(files)
}

function _dlCategory(stateStr) {
  const parts = (stateStr || '').split(',').map(s => s.trim())
  if (parts.some(p => ['Requested','Queued','Initialising','InProgress'].includes(p))) return 'active'
  if (parts.includes('Succeeded')) return 'completed'
  return 'failed'
}

function _dlIsActive(stateStr) { return _dlCategory(stateStr) === 'active' }

function _dlStateLabel(stateStr) {
  const parts = (stateStr || '').split(',').map(s => s.trim())
  if (parts.includes('InProgress'))   return { label: 'Downloading', cls: 'dl2-tag-progress' }
  if (parts.includes('Queued'))       return { label: 'Queued',      cls: 'dl2-tag-queued'   }
  if (parts.includes('Initialising')) return { label: 'Connecting',  cls: 'dl2-tag-queued'   }
  if (parts.includes('Requested'))    return { label: 'Requested',   cls: 'dl2-tag-queued'   }
  if (parts.includes('Succeeded'))    return { label: 'Done',        cls: 'dl2-tag-done'     }
  if (parts.includes('TimedOut'))     return { label: 'Timed out',   cls: 'dl2-tag-failed'   }
  if (parts.includes('Failed'))       return { label: 'Failed',      cls: 'dl2-tag-failed'   }
  if (parts.includes('Cancelled'))    return { label: 'Cancelled',   cls: 'dl2-tag-failed'   }
  if (parts.includes('Aborted'))      return { label: 'Aborted',     cls: 'dl2-tag-failed'   }
  return { label: stateStr || '?', cls: '' }
}

function _fmtBytes(b) {
  if (!b) return '0 B'
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`
  return `${(b / 1073741824).toFixed(2)} GB`
}

function _fmtSpeed(bps) {
  if (!bps) return ''
  if (bps < 1048576) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1048576).toFixed(1)} MB/s`
}

function _fmtEta(s) {
  if (!s || s === '00:00:00') return ''
  const [h, m, sec] = s.split(':').map(Number)
  if (h > 0)  return `${h}h ${m}m`
  if (m > 0)  return `${m}m ${sec}s`
  return `${sec}s`
}

function _hmsToSecs(hms) {
  const [h, m, s] = (hms || '').split(':').map(Number)
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0)
}

function _fmtSecs(secs) {
  if (!secs) return ''
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  if (secs >= 60)   return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${secs}s`
}

function _dlFileName(filename) {
  const parts = (filename || '').replace(/\//g, '\\').split('\\')
  return parts[parts.length - 1] || filename
}

function _dlFolderName(filename) {
  const parts = (filename || '').replace(/\//g, '\\').split('\\')
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

function _cleanTrackName(filename, folder) {
  const fname = _dlFileName(filename)
  const fLower = fname.toLowerCase()
  const prefix = folder.toLowerCase()
  if (fLower.startsWith(prefix)) {
    const after = fname.slice(folder.length).replace(/^[\s\-_.()\[\]]+/, '')
    if (after.length > 4) return after
  }
  return fname
}

function _findAlbumArt(folder) {
  if (!state.library?.length) return null
  const fl = folder.toLowerCase()
  const match = state.library.find(a => {
    const nl = a.name.toLowerCase()
    const al = (a.artist || '').toLowerCase()
    return fl.includes(nl) || nl.includes(fl) || fl.includes(`${al} ${nl}`) || fl.includes(`${nl} ${al}`)
  })
  return match?.artPath || null
}

function _dlDateBucket(ts) {
  const d = Date.now() - ts
  const day = 86400000
  if (d < day)      return 'Today'
  if (d < 2 * day)  return 'Yesterday'
  if (d < 7 * day)  return 'This week'
  if (d < 30 * day) return 'This month'
  return 'Earlier'
}

function _truncUser(u) {
  return u && u.length > 16 ? u.slice(0, 13) + '…' : (u || '')
}

function _updateDlTabCounts(files) {
  const counts = { active: 0, completed: 0, failed: 0 }
  for (const f of files) counts[_dlCategory(f.state)]++
  for (const tab of ['active', 'completed', 'failed']) {
    const el = document.getElementById(`dl2-tab-count-${tab}`)
    if (el) { el.textContent = counts[tab]; el.style.display = counts[tab] > 0 ? 'inline-flex' : 'none' }
  }
}

function _renderTorrentSection() {
  const torrents = state._torrents ? [...state._torrents.values()] : []
  const badge = document.getElementById('dl2-tab-count-torrents')
  if (badge) { badge.textContent = torrents.length; badge.style.display = torrents.length ? 'inline' : 'none' }
  if (_dlTab !== 'torrents') return
  const container = document.getElementById('dl2-list')
  if (!container) return
  const actionBtn = document.getElementById('dl2-action-btn')
  if (actionBtn) actionBtn.style.display = 'none'
  const filterBar = document.getElementById('dl2-filter-bar')
  if (filterBar) filterBar.style.display = 'none'
  if (!torrents.length) {
    container.innerHTML = `<div class="dl2-empty"><svg viewBox="0 0 24 24"><path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z"/></svg><p>No active torrents.<br>Click a magnet link or download a .torrent file in the browser.</p></div>`
    return
  }
  container.innerHTML = torrents.map(t => {
    const pct = Math.round((t.progress || 0) * 100)
    const speed = t.speed ? `${(t.speed/1024/1024).toFixed(1)} MB/s` : ''
    const eta = t.eta && t.eta < 1e10 ? _fmtSecs(Math.round(t.eta/1000)) : ''
    return `<div class="torrent-row" data-hash="${esc(t.infoHash)}">
      <div class="torrent-name">${esc(t.name || t.infoHash)}</div>
      <div class="torrent-progress-row">
        <div class="torrent-bar-wrap"><div class="torrent-bar-fill" style="width:${pct}%"></div></div>
        <span class="torrent-pct">${pct}%</span>
        ${speed ? `<span class="torrent-speed">${speed}</span>` : ''}
        ${eta ? `<span class="torrent-eta">${eta}</span>` : ''}
        <button class="torrent-remove" data-hash="${esc(t.infoHash)}" title="Cancel">✕</button>
      </div>
    </div>`
  }).join('')
  container.querySelectorAll('.torrent-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.torrentRemove(btn.dataset.hash)
      state._torrents?.delete(btn.dataset.hash)
      _renderTorrentSection()
    })
  })
}

function _renderDlTab(files) {
  if (_dlTab === 'torrents') { _renderTorrentSection(); return }
  const subset = files.filter(f => _dlCategory(f.state) === _dlTab)

  const actionBtn = document.getElementById('dl2-action-btn')
  if (actionBtn) {
    actionBtn.textContent = _dlTab === 'active' ? 'Cancel All' : 'Clear All'
    actionBtn.style.display = subset.length ? 'block' : 'none'
    actionBtn.classList.toggle('dl2-action-btn-danger', _dlTab === 'failed')
  }

  // Filter bar: visible only on completed tab
  const filterBar = document.getElementById('dl2-filter-bar')
  if (filterBar) filterBar.style.display = _dlTab === 'completed' ? 'flex' : 'none'

  const container = document.getElementById('dl2-list')
  if (!container) return

  const sig = _dlSig(_dlTab, subset)

  // If file list unchanged: active tab → update values in-place, other tabs → skip entirely
  if (sig === _dlLastSig && subset.length > 0) {
    if (_dlTab === 'active') _updateActiveDlInPlace(subset, container)
    return
  }

  _dlLastSig = sig

  if (!subset.length) {
    const msgs = {
      active:    ['No active downloads', 'Search for music and click ↓ All to start downloading'],
      completed: ['No completed downloads', 'Finished downloads will appear here'],
      failed:    ['No failed downloads', 'Cancelled or failed downloads will appear here'],
    }
    const icons = {
      active:    'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
      completed: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
      failed:    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
    }
    container.innerHTML = `<div class="dl2-empty">
      <svg viewBox="0 0 24 24"><path d="${icons[_dlTab]}"/></svg>
      <p>${msgs[_dlTab][0]}</p><span>${msgs[_dlTab][1]}</span>
    </div>`
    return
  }

  if (_dlTab === 'active') _renderActiveTab(subset, container)
  else if (_dlTab === 'completed') _renderCompletedTab(subset, container)
  else _renderFailedTab(subset, container)
}

function _updateActiveDlInPlace(files, container) {
  // Global stats bar
  const totalSpeed     = files.reduce((s, f) => s + (f.averageSpeed || 0), 0)
  const totalRemaining = files.reduce((s, f) => s + (f.bytesRemaining || 0), 0)
  const inProgress     = files.filter(f => (f.state || '').includes('InProgress')).length
  const elDl    = document.getElementById('dl2-stat-dl');    if (elDl)    elDl.textContent = inProgress
  const elSpeed = document.getElementById('dl2-stat-speed'); if (elSpeed) elSpeed.textContent = _fmtSpeed(totalSpeed)
  const elRem   = document.getElementById('dl2-stat-rem');   if (elRem)   elRem.textContent = _fmtBytes(totalRemaining)

  // Per-file rows
  for (const f of files) {
    const row = container.querySelector(`.dl2-file[data-dl-id="${f.id}"]`)
    if (!row) continue
    const pct       = f.percentComplete != null ? Math.round(f.percentComplete) : 0
    const fill      = row.querySelector('.dl2-fill');       if (fill)    fill.style.width = `${pct}%`
    const pctEl     = row.querySelector('.dl2-pct');        if (pctEl)   pctEl.textContent = `${pct}%`
    const speedEl   = row.querySelector('.dl2-meta-speed'); if (speedEl) speedEl.textContent = _fmtSpeed(f.averageSpeed || 0)
    const etaEl     = row.querySelector('.dl2-meta-eta')
    if (etaEl) {
      const eta = _fmtEta(f.remainingTime || '')
      etaEl.textContent = eta ? `ETA ${eta}` : ''
    }
    const { label, cls } = _dlStateLabel(f.state)
    const tagEl  = row.querySelector('.dl2-tag')
    if (tagEl) { tagEl.textContent = label; tagEl.className = `dl2-tag ${cls}` }
    const iconEl = row.querySelector('.dl2-file-icon')
    if (iconEl) {
      const isDownloading = (f.state || '').includes('InProgress')
      iconEl.classList.toggle('dl2-icon-spin', isDownloading)
    }
  }

  // Album-level headers
  container.querySelectorAll('.dla-hdr').forEach(hdr => {
    const folder  = hdr.dataset.folder
    const user    = hdr.dataset.user
    const gFiles  = files.filter(f => f.username === user && _dlFolderName(f.filename) === folder)
    if (!gFiles.length) return

    const totalSz    = gFiles.reduce((s, f) => s + (f.size || 0), 0)
    const doneSz     = gFiles.reduce((s, f) => s + (f.percentComplete || 0) / 100 * (f.size || 0), 0)
    const albumPct   = totalSz ? Math.round(doneSz / totalSz * 100) : 0
    const albumSpeed = gFiles.filter(f => (f.state || '').includes('InProgress'))
                             .reduce((s, f) => s + (f.averageSpeed || 0), 0)
    const doneTracks = gFiles.filter(f => (f.percentComplete || 0) >= 100).length
    const maxEtaSecs = gFiles.filter(f => (f.state || '').includes('InProgress'))
                             .reduce((mx, f) => Math.max(mx, _hmsToSecs(f.remainingTime || '0')), 0)

    const fillEl  = hdr.querySelector('.dla-grp-fill');  if (fillEl)  fillEl.style.width = `${albumPct}%`
    const pctEl   = hdr.querySelector('.dla-grp-pct');   if (pctEl)   pctEl.textContent = `${albumPct}%`
    const spdEl   = hdr.querySelector('.dla-grp-speed'); if (spdEl)   spdEl.textContent = albumSpeed ? _fmtSpeed(albumSpeed) : ''
    const etaEl2  = hdr.querySelector('.dla-grp-eta');   if (etaEl2)  etaEl2.textContent = maxEtaSecs ? `ETA ${_fmtSecs(maxEtaSecs)}` : ''
    const cntEl   = hdr.querySelector('.dla-done-count'); if (cntEl)  cntEl.textContent = `${doneTracks}/${gFiles.length}`
  })
}

function _renderActiveTab(files, container) {
  const totalSpeed     = files.reduce((s, f) => s + (f.averageSpeed || 0), 0)
  const totalRemaining = files.reduce((s, f) => s + (f.bytesRemaining || 0), 0)
  const inProgress     = files.filter(f => (f.state || '').includes('InProgress')).length
  const queued         = files.length - inProgress

  // Total queue ETA (max remaining time across all active files)
  const maxEtaSecs = files
    .filter(f => (f.state || '').includes('InProgress'))
    .reduce((mx, f) => Math.max(mx, _hmsToSecs(f.remainingTime || '0')), 0)

  let html = `<div class="dl2-stats-bar">
    <div class="dl2-stat">
      <span class="dl2-stat-val" id="dl2-stat-dl">${inProgress}</span>
      <span class="dl2-stat-lbl">active</span>
    </div>
    ${queued > 0 ? `<div class="dl2-stat"><span class="dl2-stat-val">${queued}</span><span class="dl2-stat-lbl">queued</span></div>` : ''}
    <div class="dl2-stat dl2-stat-speed">
      <span class="dl2-stat-val" id="dl2-stat-speed">${_fmtSpeed(totalSpeed) || '—'}</span>
      <span class="dl2-stat-lbl">total speed</span>
    </div>
    <div class="dl2-stat">
      <span class="dl2-stat-val" id="dl2-stat-rem">${_fmtBytes(totalRemaining)}</span>
      <span class="dl2-stat-lbl">remaining</span>
    </div>
    ${maxEtaSecs ? `<div class="dl2-stat"><span class="dl2-stat-val">${_fmtSecs(maxEtaSecs)}</span><span class="dl2-stat-lbl">ETA</span></div>` : ''}
  </div>`

  // Group by album folder per user
  const byAlbum = new Map()
  for (const f of files) {
    const folder = _dlFolderName(f.filename) || f.username
    const key    = `${f.username}::${folder}`
    if (!byAlbum.has(key)) byAlbum.set(key, { folder, username: f.username, files: [] })
    byAlbum.get(key).files.push(f)
  }

  for (const g of byAlbum.values()) {
    const totalSz    = g.files.reduce((s, f) => s + (f.size || 0), 0)
    const doneSz     = g.files.reduce((s, f) => s + (f.percentComplete || 0) / 100 * (f.size || 0), 0)
    const albumPct   = totalSz ? Math.round(doneSz / totalSz * 100) : 0
    const albumSpeed = g.files.filter(f => (f.state || '').includes('InProgress'))
                               .reduce((s, f) => s + (f.averageSpeed || 0), 0)
    const doneTracks = g.files.filter(f => (f.percentComplete || 0) >= 100).length
    const maxEta2    = g.files.filter(f => (f.state || '').includes('InProgress'))
                               .reduce((mx, f) => Math.max(mx, _hmsToSecs(f.remainingTime || '0')), 0)
    const artPath    = _findAlbumArt(g.folder)
    const groupIds   = g.files.map(f => f.id).join(',')

    const artHtml = artPath
      ? `<img src="file://${artPath}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="dl2-group-album-art-fallback" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/></svg></div>`
      : `<div class="dl2-group-album-art-fallback"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/></svg></div>`

    const trackRows = g.files.map(f => {
      const pct          = f.percentComplete != null ? Math.round(f.percentComplete) : 0
      const { label, cls } = _dlStateLabel(f.state)
      const isDownloading  = (f.state || '').includes('InProgress')
      const cleanName      = _cleanTrackName(f.filename, g.folder)
      const eta            = isDownloading ? _fmtEta(f.remainingTime) : ''
      const speed          = isDownloading && f.averageSpeed ? _fmtSpeed(f.averageSpeed) : ''
      const sizeStr        = f.size ? _fmtBytes(f.size) : ''
      return `<div class="dl2-file" data-dl-id="${esc(f.id)}">
        <div class="dl2-file-row1">
          <div class="dl2-file-icon ${isDownloading ? 'dl2-icon-spin' : ''}">
            <svg viewBox="0 0 24 24">${isDownloading
              ? '<path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/>'
              : '<path d="M12 3C6.48 3 2 7.48 2 13s4.48 10 10 10 10-4.48 10-10S17.52 3 12 3zm0 2c.74 0 1.46.1 2.14.29L5.29 14.14A8 8 0 0 1 12 5zm0 16c-.74 0-1.46-.1-2.14-.29l8.85-8.85A8 8 0 0 1 12 21z"/>'}
            </svg>
          </div>
          <div class="dl2-file-info">
            <span class="dl2-file-name" title="${esc(f.filename)}">${esc(cleanName)}</span>
            <div class="dl2-file-meta">
              ${speed ? `<span class="dl2-meta-speed">${esc(speed)}</span>` : ''}
              ${sizeStr ? `<span class="dl2-meta-size">${esc(sizeStr)}</span>` : ''}
              ${eta ? `<span class="dl2-meta-eta">ETA ${esc(eta)}</span>` : ''}
            </div>
          </div>
          <div class="dl2-file-end">
            <span class="dl2-tag ${cls}">${label}</span>
            <button class="dl2-icon-btn dl2-cancel-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" title="Cancel">
              <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>
        <div class="dl2-progress-row">
          <div class="dl2-bar"><div class="dl2-fill" style="width:${pct}%"></div></div>
          <span class="dl2-pct">${pct}%</span>
        </div>
      </div>`
    }).join('')

    html += `<div class="dl2-group">
      <div class="dla-hdr" data-user="${esc(g.username)}" data-folder="${esc(g.folder)}">
        <div class="dl2-group-album-art">${artHtml}</div>
        <div class="dla-meta">
          <div class="dla-title-row">
            <span class="dl2-group-name">${esc(g.folder)}</span>
            <span class="dla-done-count">${doneTracks}/${g.files.length}</span>
          </div>
          <div class="dl2-group-sub-row">
            <button class="dl2-meta-user-btn dl2-hdr-user-btn" data-username="${esc(g.username)}" title="Browse ${esc(g.username)}'s library">
              <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
              ${esc(g.username)}
            </button>
          </div>
          <div class="dla-prog-row">
            <div class="dla-grp-bar"><div class="dla-grp-fill" style="width:${albumPct}%"></div></div>
            <span class="dla-grp-pct">${albumPct}%</span>
            ${albumSpeed ? `<span class="dla-grp-speed">${_fmtSpeed(albumSpeed)}</span>` : ''}
            ${maxEta2 ? `<span class="dla-grp-eta">ETA ${_fmtSecs(maxEta2)}</span>` : ''}
          </div>
        </div>
        <button class="dl2-icon-btn dl2-grp-btn dl2-cancel-btn dl2-cancel-group-btn" data-user="${esc(g.username)}" data-ids="${esc(groupIds)}" title="Cancel all in group">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      ${trackRows}
    </div>`
  }

  container.innerHTML = html

  // Per-file cancel (single files)
  _bindDlCancelBtns(container)

  // Cancel whole group (parallel)
  container.querySelectorAll('.dl2-cancel-group-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return
      btn.disabled = true
      const ids = btn.dataset.ids.split(',').filter(Boolean)
      await Promise.all(ids.map(id =>
        window.api.slskCancelTransfer({ username: btn.dataset.user, id }).catch(() => {})
      ))
      await _pollAndRenderDownloads()
    })
  })

  // User library browse
  container.querySelectorAll('.dl2-hdr-user-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const u = btn.dataset.username
      if (u) showSlskUserLibrary(u)
    })
  })

  // Right-click context menu on file rows
  container.querySelectorAll('.dl2-file').forEach(row => {
    const cancelBtn = row.querySelector('.dl2-cancel-btn')
    row.addEventListener('contextmenu', e => {
      _showDlCtxMenu(e, [{ action: 'cancel', label: 'Cancel download', cls: 'danger' }], {
        cancel: () => cancelBtn?.click(),
      })
    })
  })
}

function _renderCompletedTab(files, container) {
  // 1. Group by album folder, collecting unique peers per group
  const byAlbum = new Map()
  for (const f of files) {
    const folder = _dlFolderName(f.filename) || 'Downloads'
    if (!byAlbum.has(folder)) byAlbum.set(folder, { folder, files: [], users: new Set() })
    const entry = byAlbum.get(folder)
    entry.files.push(f)
    if (f.username) entry.users.add(f.username)
  }

  // 2. Sort: most recently completed first; compute latestEnd per group
  const allGroups = [...byAlbum.values()].map(g => {
    g.latestEnd = g.files.reduce((mx, f) => {
      const t = new Date(f.endedAt || 0).getTime()
      return t > mx ? t : mx
    }, 0)
    return g
  }).sort((a, b) => b.latestEnd - a.latestEnd)

  _dlCompletedGroups = allGroups

  // 3. Apply filter
  const filterQ = _dlFilter.toLowerCase().trim()
  const groups = filterQ ? allGroups.filter(g => g.folder.toLowerCase().includes(filterQ)) : allGroups

  // 4. Look up album art from library for each group
  for (const g of groups) g.artPath = _findAlbumArt(g.folder)

  // 5. Stats bar (always based on full unfiltered set)
  const totalAlbums = allGroups.length
  const totalTracks = files.length
  const totalBytes  = files.reduce((s, f) => s + (f.size || 0), 0)
  const statsHtml = `<div class="dl2-completed-stats">
    <span>${totalAlbums} album${totalAlbums !== 1 ? 's' : ''}</span>
    <span class="dl2-cstat-dot">·</span>
    <span>${totalTracks} track${totalTracks !== 1 ? 's' : ''}</span>
    <span class="dl2-cstat-dot">·</span>
    <span>${_fmtBytes(totalBytes)}</span>
  </div>`

  if (!groups.length) {
    container.innerHTML = statsHtml + `<div class="dl2-filter-empty">
      <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <p>No albums match "${esc(filterQ)}"</p>
    </div>`
    return
  }

  // 6. Build HTML with date-bucket section headers
  const DATE_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier']
  const byDate = new Map()
  for (const g of groups) {
    const bucket = _dlDateBucket(g.latestEnd)
    if (!byDate.has(bucket)) byDate.set(bucket, [])
    byDate.get(bucket).push(g)
  }

  // flat indexed list in render order (for play-all which uses gi index)
  const renderOrder = []

  const prevScroll = container.scrollTop
  let html = statsHtml

  for (const bucket of DATE_ORDER) {
    if (!byDate.has(bucket)) continue
    html += `<div class="dl2-date-bucket"><span class="dl2-date-bucket-label">${bucket}</span></div>`

    for (const g of byDate.get(bucket)) {
      const gi = renderOrder.length
      renderOrder.push(g)

      const totalSize = g.files.reduce((s, f) => s + (f.size || 0), 0)
      const isOpen    = _dlOpenGroups.has(g.folder)
      const usersStr  = [...g.users].map(_truncUser).join(', ')
      const firstUser = [...g.users][0] || ''

      const artHtml = g.artPath
        ? `<img src="file://${g.artPath}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="dl2-group-album-art-fallback" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/></svg></div>`
        : `<div class="dl2-group-album-art-fallback"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/></svg></div>`

      const userBtnHtml = firstUser
        ? `<button class="dl2-meta-user-btn dl2-hdr-user-btn" data-username="${esc(firstUser)}" title="Browse ${esc(firstUser)}'s library">
            <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
            ${esc(usersStr)}
          </button>`
        : ''

      const rows = g.files.map(f => {
        const cleanName = _cleanTrackName(f.filename, g.folder)
        const sizeStr   = f.size ? _fmtBytes(f.size) : ''
        return `<div class="dl2-file dl2-file-done">
          <div class="dl2-file-row1">
            <div class="dl2-file-icon dl2-icon-done">
              <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            </div>
            <div class="dl2-file-info">
              <span class="dl2-file-name" title="${esc(f.filename)}">${esc(cleanName)}</span>
              ${sizeStr ? `<div class="dl2-file-meta"><span class="dl2-meta-size">${esc(sizeStr)}</span></div>` : ''}
            </div>
            <div class="dl2-file-end">
              <button class="dl2-icon-btn dl2-play-btn" data-filename="${esc(f.filename)}" data-user="${esc(f.username)}" title="Play">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button class="dl2-icon-btn dl2-open-btn" data-filename="${esc(f.filename)}" data-user="${esc(f.username)}" title="Show in folder">
                <svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
              </button>
              <button class="dl2-icon-btn dl2-remove-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" title="Remove from list">
                <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
          </div>
        </div>`
      }).join('')

      html += `<div class="dl2-group" id="dl2-group-c-${gi}">
        <div class="dl2-group-header dl2-group-header-done dl2-group-toggle" data-gi="c-${gi}" data-folder="${esc(g.folder)}">
          <div class="dl2-group-album-art">${artHtml}</div>
          <div class="dl2-group-info">
            <span class="dl2-group-name">${esc(g.folder)}</span>
            <div class="dl2-group-sub-row">
              <span class="dl2-group-sub">${g.files.length} track${g.files.length !== 1 ? 's' : ''} · ${_fmtBytes(totalSize)}</span>
              ${userBtnHtml}
            </div>
          </div>
          <button class="dl2-icon-btn dl2-grp-btn dl2-play-btn dl2-play-all-btn" data-gi="${gi}" title="Play all">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <svg class="dl2-chevron${isOpen ? ' dl2-chevron-up' : ''}" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </div>
        <div class="dl2-group-files${isOpen ? ' dl2-group-files-open' : ''}" id="dl2-gfiles-c-${gi}">${rows}</div>
      </div>`
    }
  }

  container.innerHTML = html
  container.scrollTop = prevScroll

  // Toggle collapse / expand
  container.querySelectorAll('.dl2-group-toggle').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('.dl2-icon-btn') || e.target.closest('.dl2-meta-user-btn')) return
      const gi     = hdr.dataset.gi
      const folder = hdr.dataset.folder
      const list   = document.getElementById(`dl2-gfiles-${gi}`)
      const chev   = hdr.querySelector('.dl2-chevron')
      if (!list) return
      const isNowOpen = list.classList.toggle('dl2-group-files-open')
      chev?.classList.toggle('dl2-chevron-up', isNowOpen)
      if (folder) {
        if (isNowOpen) _dlOpenGroups.add(folder)
        else _dlOpenGroups.delete(folder)
      }
    })
  })

  // Peer username button in group header
  container.querySelectorAll('.dl2-hdr-user-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const u = btn.dataset.username
      if (u) showSlskUserLibrary(u)
    })
  })

  // Play all tracks in group
  container.querySelectorAll('.dl2-play-all-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const gi = parseInt(btn.dataset.gi)
      const g  = renderOrder[gi]
      if (!g) return
      const resolved = await Promise.all(
        g.files.map(f => window.api.slskResolveFile({ username: f.username, filename: f.filename }).catch(() => null))
      )
      const queue = g.files.map((f, i) => {
        const localPath = resolved[i]?.path
        if (!localPath) return null
        const title = _cleanTrackName(f.filename, g.folder).replace(/\.\w+$/, '').replace(/^\d+[\s._-]+/, '')
        return { filePath: localPath, title, artist: g.folder, albumName: g.folder, albumId: '', artPath: g.artPath || '' }
      }).filter(Boolean)
      if (!queue.length) return
      state.queue = queue; state.queueIndex = 0; playCurrentTrack()
    })
  })

  // Play single track
  container.querySelectorAll('.dl2-play-btn:not(.dl2-play-all-btn)').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const filename = btn.dataset.filename
      const username = btn.dataset.user
      const folder   = _dlFolderName(filename)
      const resolved = await window.api.slskResolveFile({ username, filename }).catch(() => null)
      const localPath = resolved?.path
      if (!localPath) return
      const title = _cleanTrackName(filename, folder).replace(/\.\w+$/, '').replace(/^\d+[\s._-]+/, '')
      state.queue = [{ filePath: localPath, title, artist: folder, albumName: folder, albumId: '', artPath: '' }]
      state.queueIndex = 0; playCurrentTrack()
    })
  })

  // Show in folder
  container.querySelectorAll('.dl2-open-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const resolved = await window.api.slskResolveFile({ username: btn.dataset.user, filename: btn.dataset.filename }).catch(() => null)
      const localPath = resolved?.path
      if (localPath) await window.api.slskShowInFolder(localPath).catch(() => {})
    })
  })

  // Remove from list
  container.querySelectorAll('.dl2-remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      btn.disabled = true
      await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id }).catch(() => {})
      await _pollAndRenderDownloads()
    })
  })

  // Right-click context menu
  container.querySelectorAll('.dl2-file-done').forEach(row => {
    const playBtn   = row.querySelector('.dl2-play-btn')
    const removeBtn = row.querySelector('.dl2-remove-btn')
    const filename  = playBtn?.dataset.filename
    const username  = playBtn?.dataset.user
    const folder    = _dlFolderName(filename || '')
    const gi = parseInt(row.closest('[id^="dl2-gfiles-"]')?.id.replace('dl2-gfiles-c-', ''))
    const group = isNaN(gi) ? null : renderOrder[gi]

    row.addEventListener('contextmenu', e => {
      const resolve = () => window.api.slskResolveFile({ username, filename }).catch(() => null)
      _showDlCtxMenu(e, [
        { action: 'play',        label: 'Play',              primary: true },
        { action: 'queue-add',   label: 'Add to queue' },
        group ? { action: 'play-album', label: 'Play album' } : null,
        'sep',
        { action: 'show-folder', label: 'Show in folder' },
        { action: 'copy-name',   label: 'Copy file name' },
        { action: 'copy-path',   label: 'Copy local path' },
        'sep',
        { action: 'remove',      label: 'Remove from list', cls: 'danger' },
      ].filter(Boolean), {
        play: async () => {
          const r = await resolve(); if (!r?.path) return
          const title = _cleanTrackName(filename, folder).replace(/\.\w+$/, '').replace(/^\d+[\s._-]+/, '')
          state.queue = [{ filePath: r.path, title, artist: folder, albumName: folder, albumId: '', artPath: '' }]
          state.queueIndex = 0; playCurrentTrack()
        },
        'queue-add': async () => {
          const r = await resolve(); if (!r?.path) return
          const title = _cleanTrackName(filename, folder).replace(/\.\w+$/, '').replace(/^\d+[\s._-]+/, '')
          state.queue.push({ filePath: r.path, title, artist: folder, albumName: folder, albumId: '', artPath: '' })
        },
        'play-album': async () => {
          if (!group) return
          const resolved2 = await Promise.all(group.files.map(f => window.api.slskResolveFile({ username: f.username, filename: f.filename }).catch(() => null)))
          const queue = group.files.map((f, i) => {
            const lp = resolved2[i]?.path; if (!lp) return null
            const t  = _cleanTrackName(f.filename, group.folder).replace(/\.\w+$/, '').replace(/^\d+[\s._-]+/, '')
            return { filePath: lp, title: t, artist: group.folder, albumName: group.folder, albumId: '', artPath: group.artPath || '' }
          }).filter(Boolean)
          if (queue.length) { state.queue = queue; state.queueIndex = 0; playCurrentTrack() }
        },
        'show-folder': async () => { const r = await resolve(); if (r?.path) window.api.slskShowInFolder(r.path).catch(() => {}) },
        'copy-name':   () => navigator.clipboard.writeText(_dlFileName(filename)).catch(() => {}),
        'copy-path':   async () => { const r = await resolve(); if (r?.path) navigator.clipboard.writeText(r.path).catch(() => {}) },
        remove:        () => removeBtn?.click(),
      })
    })
  })
}

function _renderFailedTab(files, container) {
  // Group by album folder
  const byAlbum = new Map()
  for (const f of files) {
    const folder = _dlFolderName(f.filename) || 'Unknown'
    if (!byAlbum.has(folder)) byAlbum.set(folder, { folder, files: [], users: new Set() })
    const entry = byAlbum.get(folder)
    entry.files.push(f)
    if (f.username) entry.users.add(f.username)
  }

  // Sort: most recently failed first
  const groups = [...byAlbum.values()].map(g => {
    g.latestEnd = g.files.reduce((mx, f) => {
      const t = new Date(f.endedAt || 0).getTime()
      return t > mx ? t : mx
    }, 0)
    g.artPath = _findAlbumArt(g.folder)
    return g
  }).sort((a, b) => b.latestEnd - a.latestEnd)

  // Stats bar
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0)
  let html = `<div class="dl2-completed-stats">
    <span>${groups.length} album${groups.length !== 1 ? 's' : ''}</span>
    <span class="dl2-cstat-dot">·</span>
    <span>${files.length} file${files.length !== 1 ? 's' : ''}</span>
    ${totalBytes ? `<span class="dl2-cstat-dot">·</span><span>${_fmtBytes(totalBytes)}</span>` : ''}
  </div>`

  // Tally failure reasons for summary
  const reasonCounts = {}
  for (const f of files) {
    const { label } = _dlStateLabel(f.state)
    reasonCounts[label] = (reasonCounts[label] || 0) + 1
  }
  const reasonSummary = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label.toLowerCase()}`)
    .join(' · ')
  if (reasonSummary) {
    html += `<div class="dl2-failed-reason-bar">${reasonSummary}</div>`
  }

  const prevScroll = container.scrollTop

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const isOpen    = _dlFailedOpenGroups.has(g.folder)
    const usersStr  = [...g.users].map(_truncUser).join(', ')
    const firstUser = [...g.users][0] || ''

    const artHtml = g.artPath
      ? `<img src="file://${g.artPath}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="dl2-group-album-art-fallback" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></div>`
      : `<div class="dl2-group-album-art-fallback"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></div>`

    const userBtnHtml = firstUser
      ? `<button class="dl2-meta-user-btn dl2-hdr-user-btn" data-username="${esc(firstUser)}" title="Browse ${esc(firstUser)}'s library">
          <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
          ${esc(usersStr)}
        </button>`
      : ''

    const groupIds = g.files.map(f => f.id).join(',')

    const rows = g.files.map(f => {
      const cleanName     = _cleanTrackName(f.filename, g.folder)
      const { label, cls } = _dlStateLabel(f.state)
      const sizeStr       = f.size ? _fmtBytes(f.size) : ''
      return `<div class="dl2-file dl2-file-failed">
        <div class="dl2-file-row1">
          <div class="dl2-file-icon dl2-icon-failed">
            <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          </div>
          <div class="dl2-file-info">
            <span class="dl2-file-name" title="${esc(f.filename)}">${esc(cleanName)}</span>
            <div class="dl2-file-meta">
              <span class="dl2-tag ${cls} dl2-tag-inline">${label}</span>
              ${sizeStr ? `<span class="dl2-meta-size">${esc(sizeStr)}</span>` : ''}
            </div>
          </div>
          <div class="dl2-file-end">
            <button class="dl2-icon-btn dl2-retry-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" data-filename="${esc(f.filename)}" data-size="${f.size || 0}" title="Retry">
              <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
            <button class="dl2-icon-btn dl2-remove-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" title="Remove">
              <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>
      </div>`
    }).join('')

    html += `<div class="dl2-group dl2-group-failed" id="dl2-group-f-${gi}">
      <div class="dl2-group-header dl2-group-header-failed dl2-group-toggle-failed" data-gi="f-${gi}" data-folder="${esc(g.folder)}">
        <div class="dl2-group-album-art">${artHtml}</div>
        <div class="dl2-group-info">
          <span class="dl2-group-name">${esc(g.folder)}</span>
          <div class="dl2-group-sub-row">
            <span class="dl2-group-sub">${g.files.length} file${g.files.length !== 1 ? 's' : ''}</span>
            ${userBtnHtml}
          </div>
        </div>
        <button class="dl2-icon-btn dl2-grp-btn dl2-retry-all-btn" data-gi="${gi}" data-user="${esc(firstUser)}" data-ids="${esc(groupIds)}" title="Retry all">
          <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        </button>
        <button class="dl2-icon-btn dl2-grp-btn dl2-clear-group-btn" data-user="${esc(firstUser)}" data-ids="${esc(groupIds)}" title="Clear group">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <svg class="dl2-chevron${isOpen ? ' dl2-chevron-up' : ''}" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </div>
      <div class="dl2-group-files${isOpen ? ' dl2-group-files-open' : ''}" id="dl2-gfiles-f-${gi}">${rows}</div>
    </div>`
  }

  container.innerHTML = html
  container.scrollTop = prevScroll

  // Toggle collapse / expand
  container.querySelectorAll('.dl2-group-toggle-failed').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('.dl2-icon-btn') || e.target.closest('.dl2-meta-user-btn')) return
      const gi     = hdr.dataset.gi
      const folder = hdr.dataset.folder
      const list   = document.getElementById(`dl2-gfiles-${gi}`)
      const chev   = hdr.querySelector('.dl2-chevron')
      if (!list) return
      const isNowOpen = list.classList.toggle('dl2-group-files-open')
      chev?.classList.toggle('dl2-chevron-up', isNowOpen)
      if (folder) {
        if (isNowOpen) _dlFailedOpenGroups.add(folder)
        else _dlFailedOpenGroups.delete(folder)
      }
    })
  })

  // Peer username button in header
  container.querySelectorAll('.dl2-hdr-user-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const u = btn.dataset.username
      if (u) showSlskUserLibrary(u)
    })
  })

  // Retry all files in a group
  container.querySelectorAll('.dl2-retry-all-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (btn.disabled) return
      btn.disabled = true
      const gi = parseInt(btn.dataset.gi)
      const g  = groups[gi]
      if (!g) return
      await Promise.all(g.files.map(f =>
        window.api.slskCancelTransfer({ username: f.username, id: f.id }).catch(() => {})
      ))
      await Promise.all(g.files.map(f =>
        window.api.slskDownload({ username: f.username, filename: f.filename, size: f.size || 0 }).catch(() => {})
      ))
      _dlTab = 'active'; _dlLastSig = ''
      document.querySelectorAll('.dl2-tab').forEach(b => b.classList.remove('active'))
      document.querySelector('.dl2-tab[data-tab="active"]')?.classList.add('active')
      await _pollAndRenderDownloads()
    })
  })

  // Clear all files in a group
  container.querySelectorAll('.dl2-clear-group-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (btn.disabled) return
      btn.disabled = true
      const ids = btn.dataset.ids.split(',').filter(Boolean)
      const user = btn.dataset.user
      await Promise.all(ids.map(id =>
        window.api.slskCancelTransfer({ username: user, id }).catch(() => {})
      ))
      await _pollAndRenderDownloads()
    })
  })

  // Retry single file
  container.querySelectorAll('.dl2-retry-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (btn.disabled) return
      btn.disabled = true
      await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id }).catch(() => {})
      await window.api.slskDownload({ username: btn.dataset.user, filename: btn.dataset.filename, size: Number(btn.dataset.size) }).catch(() => {})
      _dlTab = 'active'; _dlLastSig = ''
      document.querySelectorAll('.dl2-tab').forEach(b => b.classList.remove('active'))
      document.querySelector('.dl2-tab[data-tab="active"]')?.classList.add('active')
      await _pollAndRenderDownloads()
    })
  })

  // Remove single file
  container.querySelectorAll('.dl2-remove-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (btn.disabled) return
      btn.disabled = true
      await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id }).catch(() => {})
      await _pollAndRenderDownloads()
    })
  })

  // Right-click context menu
  container.querySelectorAll('.dl2-file-failed').forEach(row => {
    const retryBtn  = row.querySelector('.dl2-retry-btn')
    const removeBtn = row.querySelector('.dl2-remove-btn')
    row.addEventListener('contextmenu', e => {
      _showDlCtxMenu(e, [
        { action: 'retry',  label: 'Download again', primary: true },
        'sep',
        { action: 'remove', label: 'Remove from list', cls: 'danger' },
      ], {
        retry:  () => retryBtn?.click(),
        remove: () => removeBtn?.click(),
      })
    })
  })
}

function _bindDlCancelBtns(container) {
  container.querySelectorAll('.dl2-cancel-btn:not(.dl2-cancel-group-btn)').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
      await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id }).catch(() => {})
    })
  })
}

function _fmtRelTime(ms) {
  const diff = Date.now() - ms
  if (diff < 60000)   return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function _renderYtDownloadRows(box) {
  const items = [...state.ytDownloads.values()].reverse()
  const section = document.getElementById('yt-dl-section')
  if (section) section.style.display = items.length ? '' : 'none'
  box.innerHTML = items.map(d => `
    <div class="yt-row">
      <div class="yt-info">
        <div class="yt-title">${esc(d.title)} <span class="yt-badge">YT</span></div>
        <div class="yt-sub">${esc(d.artist || '')}</div>
      </div>
      ${d.state === 'downloading'
        ? `<div class="yt-dl-bar"><div class="yt-dl-fill" style="width:${d.percent}%"></div></div><span class="yt-dur">${Math.round(d.percent)}%</span>`
        : d.state === 'completed'
          ? `<span class="yt-dl-done">✓ Done</span>`
          : `<span class="yt-error" title="${esc(d.error || '')}">✗ Failed</span>`}
    </div>`).join('')
}

function renderDownloads() {
  setContent(`<div class="dl2-page">
    <div class="dl2-topbar">
      <div class="dl2-topbar-left">
        <h2 class="dl2-title">Downloads</h2>
        <button class="dl2-folder-btn" id="dl2-folder-btn" title="Change download folder">
          <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          <span id="dl2-folder-label">…</span>
        </button>
      </div>
      <button class="dl2-action-btn" id="dl2-action-btn" style="display:none">Clear All</button>
    </div>
    <div class="dl2-tabs" id="dl2-tabs">
      <button class="dl2-tab active" data-tab="active">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Downloading
        <span class="dl2-tab-count" id="dl2-tab-count-active" style="display:none">0</span>
      </button>
      <button class="dl2-tab" data-tab="completed">
        <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        Completed
        <span class="dl2-tab-count dl2-tab-count-green" id="dl2-tab-count-completed" style="display:none">0</span>
      </button>
      <button class="dl2-tab" data-tab="failed">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        Failed
        <span class="dl2-tab-count dl2-tab-count-red" id="dl2-tab-count-failed" style="display:none">0</span>
      </button>
      <button class="dl2-tab" data-tab="torrents">
        <svg viewBox="0 0 24 24"><path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z"/></svg>
        Torrents
        <span class="dl2-tab-count" id="dl2-tab-count-torrents" style="display:none">0</span>
      </button>
    </div>
    <div id="yt-dl-section" style="display:none">
      <div class="section-header" style="margin:16px 0 8px"><span class="section-title">YouTube</span></div>
      <div id="yt-dl-list"></div>
    </div>
    <div class="dl2-filter-bar" id="dl2-filter-bar" style="display:none">
      <svg class="dl2-filter-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <input class="dl2-filter-input" id="dl2-filter-input" type="text" placeholder="Filter albums…" autocomplete="off">
      <button class="dl2-ctrl-btn" id="dl2-collapse-all" title="Collapse all">
        <svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg>
      </button>
      <button class="dl2-ctrl-btn" id="dl2-expand-all" title="Expand all">
        <svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
      </button>
    </div>
    <div class="dl2-list" id="dl2-list">
      <div class="dl2-empty">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        <p>Loading…</p>
      </div>
    </div>
  </div>`)

  const ytBox = document.getElementById('yt-dl-list')
  if (ytBox) _renderYtDownloadRows(ytBox)

  // Tab switching
  document.querySelectorAll('.dl2-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dl2-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      _dlTab = btn.dataset.tab
      _dlLastSig = ''   // force full re-render on tab switch
      _renderDlTab(_dlLastFiles)
    })
  })

  // Action button (Cancel All / Clear All) — parallel for speed
  document.getElementById('dl2-action-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('dl2-action-btn')
    if (!btn || btn.disabled) return
    const subset = _dlLastFiles.filter(f => _dlCategory(f.state) === _dlTab)
    if (!subset.length) return
    const originalText = btn.textContent
    btn.disabled = true
    btn.textContent = _dlTab === 'active' ? 'Cancelling…' : 'Clearing…'
    await Promise.all(subset.map(f =>
      window.api.slskCancelTransfer({ username: f.username, id: f.id }).catch(() => {})
    ))
    await _pollAndRenderDownloads()
    if (btn) { btn.disabled = false; btn.textContent = originalText }
  })

  // Restore active tab to wherever user was
  const activeBtnForCurrentTab = document.querySelector(`.dl2-tab[data-tab="${_dlTab}"]`)
  if (activeBtnForCurrentTab) {
    document.querySelectorAll('.dl2-tab').forEach(b => b.classList.remove('active'))
    activeBtnForCurrentTab.classList.add('active')
  }

  // Load and display current download folder, also cache it for play buttons
  window.api.slskGetDownloadDir().then(dir => {
    _dlDownloadDir = dir
    const label = document.getElementById('dl2-folder-label')
    if (label) { label.textContent = dir.split('/').pop() || dir; label.title = dir }
  })

  document.getElementById('dl2-folder-btn')?.addEventListener('click', async () => {
    const res = await window.api.slskSetDownloadDir()
    if (res.ok) {
      _dlDownloadDir = res.downloadDir
      const label = document.getElementById('dl2-folder-label')
      if (label) {
        label.textContent = res.downloadDir.split('/').pop() || res.downloadDir
        label.title = res.downloadDir
      }
    }
  })

  // Filter input
  document.getElementById('dl2-filter-input')?.addEventListener('input', e => {
    _dlFilter = e.target.value
    _dlLastSig = ''
    _renderDlTab(_dlLastFiles)
  })

  // Collapse / expand all
  document.getElementById('dl2-collapse-all')?.addEventListener('click', () => {
    _dlOpenGroups.clear()
    _dlLastSig = ''
    _renderDlTab(_dlLastFiles)
  })
  document.getElementById('dl2-expand-all')?.addEventListener('click', () => {
    for (const g of _dlCompletedGroups) _dlOpenGroups.add(g.folder)
    _dlLastSig = ''
    _renderDlTab(_dlLastFiles)
  })

  _pollAndRenderDownloads()
}

function bindSlskSearchEvents(query) {
  const section = document.getElementById('slsk-section')
  if (!section) return

  section.querySelector('#slsk-setup-btn')?.addEventListener('click', async () => {
    const btn = section.querySelector('#slsk-setup-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Downloading…' }
    window.api.on('slsk-progress', d => { if (btn) btn.textContent = d.text })
    const res = await window.api.slskSetup()
    window.api.off('slsk-progress')
    if (res.ok) {
      await refreshSlskStatus()
      if (!slsk.status.configured) showSlskConfigModal(query)
    } else {
      alert('slskd install failed: ' + (res.error || 'unknown'))
    }
    section.innerHTML = renderSoulseekRow(query)
    bindSlskSearchEvents(query)
  })

  section.querySelector('#slsk-config-btn')?.addEventListener('click', () => showSlskConfigModal(query))

  section.querySelector('#slsk-retry-btn')?.addEventListener('click', () => {
    _searchCache_invalidate(query)  // force-fresh on manual retry
    runSlskSearch(query)
  })

  const groups = _slskGroupByFolder()

  // Download all files in a card
  // Shared helper: download ONE file and play it when ready
  async function _slskDownloadAndPlay(btn, g, targetFile) {
    const origHtml = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '<svg viewBox="0 0 24 24" style="animation:dl2Spin 1.2s linear infinite"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>'
    try {
      const title = (targetFile.filename||'').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '')
      const _playFile = (filePath) => {
        state.queue = [{ filePath, title, artist: g.username, albumArtist: g.username, artPath: null, albumName: g.folderName, albumId: `slsk_${g.username}_${btn.dataset.gi}` }]
        state.queueIndex = 0
        playCurrentTrack()
      }
      // Check if already on disk
      const existing = await window.api.slskResolveFile({ username: g.username, filename: targetFile.filename })
      if (existing?.path) { _playFile(existing.path); btn.innerHTML = origHtml; btn.disabled = false; return }
      // Queue download for this file only
      await window.api.slskDownload({ username: g.username, filename: targetFile.filename, size: targetFile.size })
      _scheduleLibRescan()
      // Poll until file appears on disk (max 3 min)
      const deadline = Date.now() + 180000
      let played = false
      while (Date.now() < deadline && !played) {
        await new Promise(r => setTimeout(r, 2000))
        const res = await window.api.slskResolveFile({ username: g.username, filename: targetFile.filename })
        if (res?.path) { _playFile(res.path); played = true; break }
        const raw = await window.api.slskGetTransfers().catch(() => [])
        const hit = raw.flatMap(u => (u.directories||[]).flatMap(d => d.files||[])).find(f => f.filename === targetFile.filename)
        if (hit?.state?.match(/Failed|Aborted|Cancelled/)) break
      }
    } catch (_) {}
    btn.innerHTML = origHtml
    btn.disabled = false
  }

  // Download all files in a card
  section.querySelectorAll('.slsk-dl-all-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const g = groups[parseInt(btn.dataset.gi)]
      if (!g) return
      const origHtml = btn.innerHTML
      btn.disabled = true
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
      try {
        for (const f of g.files)
          await window.api.slskDownload({ username: g.username, filename: f.filename, size: f.size })
        _scheduleLibRescan()
      } catch (_) { btn.disabled = false; btn.innerHTML = origHtml }
    })
  })

  // Play first (best) track in a card
  section.querySelectorAll('.slsk-play-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const g = groups[parseInt(btn.dataset.gi)]
      if (!g) return
      const sorted = [...g.files].sort((a, b) =>
        (b.isFlac ? 1 : 0) - (a.isFlac ? 1 : 0) || (a.filename||'').localeCompare(b.filename||''))
      const first = sorted[0]
      if (!first) return
      // Also queue remaining files in background after play starts
      const origHtml = btn.innerHTML
      await _slskDownloadAndPlay(btn, g, first)
      // Queue rest silently
      for (const f of sorted.slice(1))
        window.api.slskDownload({ username: g.username, filename: f.filename, size: f.size }).catch(() => {})
      btn.innerHTML = origHtml
      btn.disabled = false
    })
  })

  // Expand/collapse track list
  section.querySelectorAll('.slsk-expand-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const gi = parseInt(btn.dataset.gi)
      const tl = document.getElementById(`slsk-tl-${gi}`)
      if (!tl) return
      const open = tl.style.display !== 'none'
      if (!open && !tl.dataset.built) {
        // Lazily render track list on first open
        const g = groups[gi]
        if (g) {
          const sorted = [...g.files].sort((a, b) =>
            (b.isFlac ? 1 : 0) - (a.isFlac ? 1 : 0) || (a.filename||'').localeCompare(b.filename||''))
          tl.innerHTML = sorted.map((f, fi) => {
            const fname = (f.filename||'').replace(/\\/g, '/').split('/').pop()
            const fdisp = fname.replace(/\.[^.]+$/, '')
            const sizeMb = f.size ? `${(f.size/1048576).toFixed(1)} MB` : ''
            return `<div class="slsk-track-item">
              <span class="slsk-track-name" title="${esc(fname)}">${esc(fdisp)}</span>
              <span class="slsk-track-size">${sizeMb}</span>
              <button class="slsk-track-play" data-gi="${gi}" data-fi="${fi}" title="Play this track">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button class="slsk-track-dl" data-gi="${gi}" data-fi="${fi}" title="Download this track">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </button>
            </div>`
          }).join('')
          tl.dataset.built = '1'
          // Bind track buttons for just this card
          tl.querySelectorAll('.slsk-track-play').forEach(tb => {
            tb.addEventListener('click', async ev => {
              ev.stopPropagation()
              const g2 = groups[parseInt(tb.dataset.gi)]
              const sf = [...(g2?.files||[])].sort((a, b) =>
                (b.isFlac ? 1 : 0) - (a.isFlac ? 1 : 0) || (a.filename||'').localeCompare(b.filename||''))
              const f2 = sf[parseInt(tb.dataset.fi)]
              if (!g2 || !f2) return
              await _slskDownloadAndPlay(tb, g2, f2)
            })
          })
          tl.querySelectorAll('.slsk-track-dl').forEach(tb => {
            tb.addEventListener('click', async ev => {
              ev.stopPropagation()
              const g2 = groups[parseInt(tb.dataset.gi)]
              const sf = [...(g2?.files||[])].sort((a, b) =>
                (b.isFlac ? 1 : 0) - (a.isFlac ? 1 : 0) || (a.filename||'').localeCompare(b.filename||''))
              const f2 = sf[parseInt(tb.dataset.fi)]
              if (!g2 || !f2) return
              const origHtml = tb.innerHTML
              tb.disabled = true
              tb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
              try {
                await window.api.slskDownload({ username: g2.username, filename: f2.filename, size: f2.size || 0 })
                _scheduleLibRescan()
              } catch (_) { tb.disabled = false; tb.innerHTML = origHtml }
            })
          })
        }
      }
      tl.style.display = open ? 'none' : 'block'
      btn.classList.toggle('open', !open)
    })
  })

  // Browse user's shared library
  section.querySelectorAll('.slsk-user-link').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const username = btn.dataset.username
      if (username) showSlskUserLibrary(username)
    })
  })

}

async function showSlskUserLibrary(username) {
  hideContextMenu()
  const existing = document.getElementById('slsk-user-lib-modal')
  if (existing) existing.remove()

  const dlg = document.createElement('div')
  dlg.id = 'slsk-user-lib-modal'
  dlg.className = 'modal-overlay'
  dlg.innerHTML = `<div class="modal-box slsk-lib-box">
    <div class="modal-header-row">
      <div class="modal-title">${esc(username)}'s Library</div>
      <button class="modal-close-btn" id="slsk-lib-close">✕</button>
    </div>
    <input class="sq-name-input slsk-lib-filter" id="slsk-lib-filter" placeholder="Filter files…" autocomplete="off">
    <div class="slsk-lib-genre-bar" id="slsk-lib-genre-bar" style="display:none"></div>
    <div class="slsk-lib-body" id="slsk-lib-body">
      <div class="slsk-lib-loading">Loading library…</div>
    </div>
  </div>`
  document.body.appendChild(dlg)

  dlg.querySelector('#slsk-lib-close').addEventListener('click', () => dlg.remove())
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove() })

  const body = dlg.querySelector('#slsk-lib-body')
  const filterInput = dlg.querySelector('#slsk-lib-filter')

  let allDirs = []
  const PAGE_SIZE = 30

  const GENRE_KEYWORDS = ['rock','pop','jazz','classical','hip.hop','hip hop','r&b','rnb','country','electronic','dance','metal','punk','folk','blues','reggae','soul','funk','disco','house','techno','ambient','alternative','indie','latin','gospel','classical','opera','acoustic','grunge','edm','trap','lo.fi','lofi','world','experimental','post.rock','progressive','prog','synthwave','new wave','80s','90s','2000s']
  function _detectGenre(dirName) {
    const lc = (dirName || '').replace(/\\/g,'/').toLowerCase()
    for (const g of GENRE_KEYWORDS) {
      const re = new RegExp('(?:^|[/\\\\\\s_\\-\\(\\[])' + g.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\./g,'[.\\s]?') + '(?:[/\\\\\\s_\\-\\)\\]$]|$)')
      if (re.test(lc)) return g.replace(/[. ]/g,' ').split(' ').map(w => w[0].toUpperCase()+w.slice(1)).join(' ')
    }
    return null
  }

  function _dirHtml(dir) {
    const folderName = (dir.name || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/')
    const detectedGenre = _detectGenre(dir.name || '')
    const dirPrefix  = dir.name ? dir.name + '\\' : ''
    const audioFiles = (dir.files || []).filter(f => /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i.test(f.filename || ''))
    const allFiles   = dir.files || []
    const files      = audioFiles.length ? audioFiles : allFiles
    const filesHtml  = files.map(f => {
      const fname   = (f.filename || '').replace(/\\/g, '/').split('/').pop()
      const fdisp   = fname.replace(/\.[^.]+$/, '')
      const ext     = (fname.match(/\.([^.]+)$/) || [])[1] || ''
      const sizeMb  = f.size ? `${(f.size / 1048576).toFixed(1)} MB` : ''
      const isFlac  = /flac|wav|aiff|alac/i.test(ext)
      const fullPath = dirPrefix + f.filename  // full Soulseek path needed by slskd download API
      const isAudio = /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i.test(fname)
      return `<div class="slsk-lib-file">
        <span class="slsk-lib-file-name" title="${esc(fname)}">${esc(fdisp)}</span>
        ${detectedGenre ? `<span class="slsk-lib-genre-tag">${esc(detectedGenre)}</span>` : ''}
        ${isFlac ? `<span class="slsk-lib-ext lossless">${ext.toUpperCase()}</span>` : ext ? `<span class="slsk-lib-ext">${esc(ext.toUpperCase())}</span>` : ''}
        <span class="slsk-lib-size">${sizeMb}</span>
        ${isAudio ? `<button class="slsk-lib-play-btn" data-username="${esc(username)}" data-filename="${esc(fullPath)}" data-size="${f.size || 0}" data-title="${esc(fdisp)}" data-folder="${esc(dir.name || '')}" title="Play">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>` : ''}
        <button class="slsk-lib-dl-btn" data-username="${esc(username)}" data-filename="${esc(fullPath)}" data-size="${f.size || 0}" title="Download">
          <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
      </div>`
    }).join('')
    const totalCount = allFiles.length
    const audioCount = audioFiles.length
    const countLabel = audioCount < totalCount
      ? `${audioCount} audio · ${totalCount} total`
      : `${totalCount} file${totalCount !== 1 ? 's' : ''}`
    return `<div class="slsk-lib-dir" data-genre="${esc(detectedGenre || '')}">
      <div class="slsk-lib-dir-header">
        <span class="slsk-lib-dir-name" title="${esc(dir.name || '')}">${esc(folderName || dir.name || '(root)')}</span>
        ${detectedGenre ? `<span class="slsk-lib-genre-tag">${esc(detectedGenre)}</span>` : ''}
        <span class="slsk-lib-dir-count">${countLabel}</span>
        <button class="slsk-lib-dl-all-btn" data-dir="${esc(dir.name || '')}" title="Download all audio files in this folder">
          <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> All
        </button>
      </div>
      <div class="slsk-lib-files">${filesHtml}</div>
    </div>`
  }

  const SPIN_SVG = '<svg viewBox="0 0 24 24" style="animation:dl2Spin 1s linear infinite"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>'
  const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'

  // Single delegated listener on body — catches clicks on all buttons including
  // those added dynamically via Show More, without needing rebinding.
  body.addEventListener('click', async e => {
    const dlBtn   = e.target.closest('.slsk-lib-dl-btn')
    const playBtn = e.target.closest('.slsk-lib-play-btn')
    const allBtn  = e.target.closest('.slsk-lib-dl-all-btn')
    if (!dlBtn && !playBtn && !allBtn) return
    e.stopPropagation()

    if (dlBtn) {
      if (dlBtn.disabled) return
      const u = dlBtn.dataset.username
      const filename = dlBtn.dataset.filename
      const size = Number(dlBtn.dataset.size)
      console.log('[lib-dl] user:', u, 'file:', filename)
      const orig = dlBtn.innerHTML
      dlBtn.disabled = true
      dlBtn.innerHTML = SPIN_SVG
      try {
        await window.api.slskDownload({ username: u, filename, size })
        dlBtn.innerHTML = CHECK_SVG
        _scheduleLibRescan()
      } catch (err) {
        console.error('[lib-dl] error:', err)
        dlBtn.disabled = false
        dlBtn.innerHTML = orig
        dlBtn.title = 'Failed: ' + (err?.message || 'error')
      }
    }

    if (playBtn) {
      if (playBtn.disabled) return
      const u        = playBtn.dataset.username
      const filename = playBtn.dataset.filename
      const size     = Number(playBtn.dataset.size)
      const title    = playBtn.dataset.title || filename
      const folder   = playBtn.dataset.folder || ''
      const orig = playBtn.innerHTML
      playBtn.disabled = true
      playBtn.innerHTML = SPIN_SVG
      try {
        const existing = await window.api.slskResolveFile({ username: u, filename })
        if (existing?.path) {
          state.queue = [{ filePath: existing.path, title, artist: u, albumArtist: u, artPath: null, albumName: folder, albumId: `slsk_lib_${u}` }]
          state.queueIndex = 0
          playCurrentTrack()
          playBtn.innerHTML = orig; playBtn.disabled = false
          return
        }
        await window.api.slskDownload({ username: u, filename, size })
        _scheduleLibRescan()
        const deadline = Date.now() + 120000
        const poll = async () => {
          if (Date.now() > deadline) { playBtn.innerHTML = orig; playBtn.disabled = false; return }
          const found = await window.api.slskResolveFile({ username: u, filename })
          if (found?.path) {
            state.queue = [{ filePath: found.path, title, artist: u, albumArtist: u, artPath: null, albumName: folder, albumId: `slsk_lib_${u}` }]
            state.queueIndex = 0
            playCurrentTrack()
            playBtn.innerHTML = orig; playBtn.disabled = false
          } else { setTimeout(poll, 3000) }
        }
        setTimeout(poll, 3000)
      } catch (err) {
        playBtn.disabled = false; playBtn.innerHTML = orig
        playBtn.title = 'Failed: ' + (err?.message || 'error')
      }
    }

    if (allBtn) {
      if (allBtn.disabled) return
      const dirName = allBtn.dataset.dir
      const dir = allDirs.find(d => d.name === dirName)
      if (!dir) return
      const dirPrefix  = dirName ? dirName + '\\' : ''
      const audioFiles = (dir.files || []).filter(f => /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i.test(f.filename || ''))
      const filesToDl  = audioFiles.length ? audioFiles : (dir.files || [])
      if (!filesToDl.length) return
      allBtn.disabled = true
      allBtn.innerHTML = SPIN_SVG + ' Queuing…'
      let queued = 0
      for (const f of filesToDl) {
        try {
          await window.api.slskDownload({ username, filename: dirPrefix + f.filename, size: f.size || 0 })
          queued++
        } catch (_) {}
      }
      allBtn.innerHTML = CHECK_SVG + ` ${queued} queued`
      _scheduleLibRescan()
    }
  })

  function bindDlButtons(_container) { /* no-op: handled by delegated listener */ }

  let _rendered = 0
  let _currentFiltered = []
  let _activeGenreFilter = ''

  function buildGenreBar() {
    const bar = dlg.querySelector('#slsk-lib-genre-bar')
    if (!bar) return
    const genres = [...new Set(allDirs.map(d => _detectGenre(d.name || '')).filter(Boolean))].sort()
    if (!genres.length) { bar.style.display = 'none'; return }
    bar.style.display = 'flex'
    bar.innerHTML = `<button class="genre-chip${!_activeGenreFilter ? ' active' : ''}" data-g="">All</button>` +
      genres.map(g => `<button class="genre-chip${_activeGenreFilter === g ? ' active' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')
    bar.querySelectorAll('.genre-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeGenreFilter = btn.dataset.g || ''
        buildGenreBar()
        renderDirs(filterInput.value)
      })
    })
  }

  function renderDirs(filter) {
    const q = filter.trim().toLowerCase()
    let filtered = q
      ? allDirs.map(d => ({
          ...d,
          files: (d.files || []).filter(f => (f.filename || '').toLowerCase().includes(q) || (d.name || '').toLowerCase().includes(q))
        })).filter(d => d.files.length > 0)
      : allDirs
    _currentFiltered = _activeGenreFilter
      ? filtered.filter(d => _detectGenre(d.name || '') === _activeGenreFilter)
      : filtered

    if (!_currentFiltered.length) {
      body.innerHTML = `<div class="slsk-lib-empty">${q ? 'No matches.' : 'Library is empty.'}</div>`
      _rendered = 0
      return
    }

    _rendered = Math.min(PAGE_SIZE, _currentFiltered.length)
    const frag = document.createDocumentFragment()
    const wrap = document.createElement('div')
    wrap.id = 'slsk-lib-dirs'
    wrap.innerHTML = _currentFiltered.slice(0, _rendered).map(_dirHtml).join('')
    frag.appendChild(wrap)

    if (_currentFiltered.length > _rendered) {
      const more = document.createElement('button')
      more.id = 'slsk-lib-more'
      more.className = 'slsk-lib-more-btn'
      more.textContent = `Show more (${_currentFiltered.length - _rendered} remaining)`
      frag.appendChild(more)
    }

    body.innerHTML = ''
    body.appendChild(frag)
    bindDlButtons(body)

    document.getElementById('slsk-lib-more')?.addEventListener('click', loadMore)
  }

  function loadMore() {
    const start = _rendered
    const end   = Math.min(_rendered + PAGE_SIZE, _currentFiltered.length)
    const wrap  = document.getElementById('slsk-lib-dirs')
    if (!wrap) return
    const tmp = document.createElement('div')
    tmp.innerHTML = _currentFiltered.slice(start, end).map(_dirHtml).join('')
    bindDlButtons(tmp)
    while (tmp.firstChild) wrap.appendChild(tmp.firstChild)
    _rendered = end

    const moreBtn = document.getElementById('slsk-lib-more')
    if (_rendered >= _currentFiltered.length) {
      moreBtn?.remove()
    } else if (moreBtn) {
      moreBtn.textContent = `Show more (${_currentFiltered.length - _rendered} remaining)`
    }
  }

  let _filterTimer = null
  filterInput.addEventListener('input', () => {
    clearTimeout(_filterTimer)
    _filterTimer = setTimeout(() => renderDirs(filterInput.value), 150)
  })

  const res = await window.api.slskBrowseUser({ username })
  if (!res.ok) {
    body.innerHTML = `<div class="slsk-lib-empty">Failed to load library: ${esc(res.error || 'unknown error')}</div>`
    return
  }
  allDirs = (res.directories || []).filter(d => (d.files || []).length > 0)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  buildGenreBar()
  renderDirs('')
  filterInput.focus()
}

function showSlskConfigModal(query) {
  const existing = document.getElementById('slsk-config-modal')
  if (existing) existing.remove()
  const dlg = document.createElement('div')
  dlg.id = 'slsk-config-modal'
  dlg.className = 'modal-overlay'
  dlg.innerHTML = `<div class="modal-box" style="max-width:380px">
    <div class="modal-title">Soulseek Account</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:16px">
      Enter your Soulseek credentials. Create a free account at
      <a href="#" id="slsk-signup-link" style="color:var(--accent)">soulseekqt.net</a> if you don't have one.
    </p>
    <label class="sq-label">Username</label>
    <input id="slsk-cfg-user" class="sq-name-input" type="text" placeholder="soulseek username" value="${esc(slsk.status.username || '')}">
    <label class="sq-label" style="margin-top:10px">Password</label>
    <input id="slsk-cfg-pass" class="sq-name-input" type="password" placeholder="password">
    <div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">
      <button class="secondary" id="slsk-cfg-cancel">Cancel</button>
      <button id="slsk-cfg-save">Save &amp; Connect</button>
    </div>
  </div>`
  document.body.appendChild(dlg)
  dlg.querySelector('#slsk-signup-link')?.addEventListener('click', e => {
    e.preventDefault()
    window.api.showBrowser('')
    window.api.browserNavigate('https://www.slsknet.org/news/')
  })
  dlg.querySelector('#slsk-cfg-cancel')?.addEventListener('click', () => dlg.remove())
  dlg.querySelector('#slsk-cfg-save')?.addEventListener('click', async () => {
    const username = dlg.querySelector('#slsk-cfg-user')?.value.trim()
    const password = dlg.querySelector('#slsk-cfg-pass')?.value
    if (!username || !password) { alert('Username and password are required'); return }
    const saveBtn = dlg.querySelector('#slsk-cfg-save')
    saveBtn.disabled = true
    saveBtn.textContent = 'Connecting…'
    await window.api.slskConfigure({ username, password })
    dlg.remove()
    // Poll in background until Soulseek login completes (takes ~5-20s), then auto-search
    ;(async () => {
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 2000))
        await refreshSlskStatus()
        const section = document.getElementById('slsk-section')
        if (!section) break
        section.innerHTML = renderSoulseekRow(query)
        bindSlskSearchEvents(query)
        if (slsk.status.connected) { runSlskSearch(query); break }
      }
    })()
  })
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove() })
}

function _markUpgradeHints(query, source, searchUrl) {
  const q = query.toLowerCase()
  const candidates = state.library.filter(a =>
    !a.isHiRes && (
      a.name.toLowerCase().includes(q) ||
      a.artist.toLowerCase().includes(q) ||
      a.tracks.some(t => t.title.toLowerCase().includes(q))
    )
  )
  for (const album of candidates) {
    if (!state.upgradeHints.has(album.id)) state.upgradeHints.set(album.id, [])
    const hints = state.upgradeHints.get(album.id)
    if (!hints.find(h => h.source.id === source.id)) hints.push({ source, searchUrl })
  }
  // Refresh album grids if visible to show badges
  document.querySelectorAll('.album-card').forEach(card => {
    const albumId = card.dataset.album
    if (state.upgradeHints.has(albumId) && !card.querySelector('.album-upgrade-btn')) {
      const album = state.library.find(a => a.id === albumId)
      if (album) card.outerHTML = albumCard(album)
    }
  })
  // Re-bind upgrade buttons
  document.querySelectorAll('.album-upgrade-btn').forEach(btn => {
    if (!btn._bound) {
      btn._bound = true
      btn.addEventListener('click', e => {
        e.stopPropagation()
        const albumId = btn.dataset.album
        const hints = state.upgradeHints.get(albumId)
        const url = hints?.[0]?.searchUrl
        if (url) openSourceUrl(url)
      })
    }
  })
}

function saveCurrentQueue(name) {
  if (!state.queue.length || !name.trim()) return
  const q = { id: `sq_${Date.now()}`, name: name.trim(), tracks: [...state.queue], savedAt: Date.now() }
  state.savedQueues = [q, ...state.savedQueues]
  window.api.saveQueue(q)
  renderSavedQueues()
}

// ── Event listeners ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// SEARCH HISTORY
// ══════════════════════════════════════════════════════════════════════════════
function initSearchHistory() {
  const HISTORY_KEY = 'pa_search_history'
  const MAX_ITEMS   = 30
  const input       = document.getElementById('tb-search')
  const dropdown    = document.getElementById('search-history-dropdown')
  if (!input || !dropdown) return

  let history       = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  let activeIdx     = -1   // which row is highlighted by keyboard
  let blurTimer     = null

  function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }

  function addToHistory(query) {
    history = [query, ...history.filter(h => h.toLowerCase() !== query.toLowerCase())].slice(0, MAX_ITEMS)
    saveHistory()
  }

  function removeFromHistory(query) {
    history = history.filter(h => h !== query)
    saveHistory()
    renderDropdown(input.value)
  }

  function highlight(text, filter) {
    if (!filter) return esc(text)
    const idx = text.toLowerCase().indexOf(filter.toLowerCase())
    if (idx < 0) return esc(text)
    return esc(text.slice(0, idx))
      + `<mark>${esc(text.slice(idx, idx + filter.length))}</mark>`
      + esc(text.slice(idx + filter.length))
  }

  function renderDropdown(filter) {
    const q = (filter || '').trim().toLowerCase()
    const matches = q
      ? history.filter(h => h.toLowerCase().includes(q))
      : history

    if (!matches.length) { hideDropdown(); return }

    dropdown.innerHTML = matches.slice(0, 10).map((h, i) => `
      <div class="sh-item" data-idx="${i}" data-query="${esc(h)}">
        <svg class="sh-item-icon" viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
        <span class="sh-item-text">${highlight(h, filter)}</span>
        <button class="sh-item-del" data-query="${esc(h)}" title="Remove">&#10005;</button>
      </div>`).join('')

    // Bind remove buttons
    dropdown.querySelectorAll('.sh-item-del').forEach(btn => {
      btn.addEventListener('mousedown', e => {
        e.preventDefault() // prevent blur on input
        removeFromHistory(btn.dataset.query)
      })
    })

    // Bind item clicks
    dropdown.querySelectorAll('.sh-item').forEach(row => {
      row.addEventListener('mousedown', e => {
        if (e.target.closest('.sh-item-del')) return
        e.preventDefault()
        const q = row.dataset.query
        input.value = q
        hideDropdown()
        commitSearch(q)
      })
    })

    activeIdx = -1
    dropdown.classList.add('open')
  }

  function hideDropdown() {
    dropdown.classList.remove('open')
    dropdown.innerHTML = ''
    activeIdx = -1
  }

  function setActive(idx) {
    const rows = dropdown.querySelectorAll('.sh-item')
    rows.forEach(r => r.classList.remove('active'))
    activeIdx = Math.max(-1, Math.min(idx, rows.length - 1))
    if (activeIdx >= 0) {
      rows[activeIdx].classList.add('active')
      input.value = rows[activeIdx].dataset.query
    }
  }

  function commitSearch(q) {
    if (!q) { navigate('home'); return }
    addToHistory(q)
    navigate('search', q)
    input.blur()
  }

  input.addEventListener('focus', () => {
    clearTimeout(blurTimer)
    renderDropdown(input.value)
  })

  input.addEventListener('input', () => {
    activeIdx = -1
    renderDropdown(input.value)
  })

  input.addEventListener('keydown', e => {
    const rows = dropdown.querySelectorAll('.sh-item')
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(activeIdx + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (activeIdx <= 0) { activeIdx = -1; input.value = input.dataset.typed || input.value }
      else setActive(activeIdx - 1)
    } else if (e.key === 'Enter') {
      const q = input.value.trim()
      hideDropdown()
      commitSearch(q)
    } else if (e.key === 'Escape') {
      input.value = ''
      hideDropdown()
      input.blur()
    } else {
      input.dataset.typed = input.value
    }
  })

  input.addEventListener('blur', () => {
    blurTimer = setTimeout(hideDropdown, 150)
  })

  // Close on click outside
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#tb-search-wrap')) hideDropdown()
  })
}

function setupListeners() {
  // Global delegation: track artist name → navigate to artist page
  document.getElementById('content')?.addEventListener('click', e => {
    const artistEl = e.target.closest('.track-artist[data-artist]')
    if (artistEl && artistEl.dataset.artist) {
      e.stopPropagation()
      navigate('artist', artistEl.dataset.artist)
    }
  })

  // Shortcuts modal close button and backdrop
  document.getElementById('shortcuts-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('shortcuts-modal')) toggleShortcutsModal()
  })
  document.querySelector('#shortcuts-modal .shortcuts-close')?.addEventListener('click', toggleShortcutsModal)

  // Saved queues
  document.getElementById('sq-save-btn')?.addEventListener('click', () => {
    if (!state.queue.length) return
    const form = document.getElementById('sq-save-form')
    const input = document.getElementById('sq-name-input')
    if (!form) return
    const isOpen = form.style.display !== 'none'
    form.style.display = isOpen ? 'none' : 'flex'
    if (!isOpen) { input.value = ''; input.focus() }
  })
  document.getElementById('sq-confirm-btn')?.addEventListener('click', () => {
    const input = document.getElementById('sq-name-input')
    if (input?.value.trim()) {
      saveCurrentQueue(input.value)
      document.getElementById('sq-save-form').style.display = 'none'
    }
  })
  document.getElementById('sq-name-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { document.getElementById('sq-confirm-btn')?.click(); e.preventDefault() }
    if (e.key === 'Escape') { document.getElementById('sq-save-form').style.display = 'none' }
  })

  // Window controls
  document.getElementById('btn-min')?.addEventListener('click', () => window.api.minimize())
  document.getElementById('btn-max')?.addEventListener('click', () => window.api.maximize())
  document.getElementById('btn-close')?.addEventListener('click', () => window.api.close())

  // Nav history buttons
  document.getElementById('tb-back')?.addEventListener('click', navigateBack)
  document.getElementById('tb-fwd')?.addEventListener('click', navigateForward)

  // Titlebar search with history
  initSearchHistory()

  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.page === 'search') {
        if (slsk.lastQuery) navigate('search', slsk.lastQuery)
        else document.getElementById('tb-search')?.focus()
      } else {
        navigate(el.dataset.page)
      }
    })
  })

  // Art fetch cancel
  document.getElementById('art-status-cancel')?.addEventListener('click', () => { artFetchCancelled = true })

  // Add site
  document.getElementById('add-site-btn')?.addEventListener('click', () => {
    document.getElementById('add-site-dialog').style.display = 'flex'
    document.getElementById('site-url-input').focus()
  })
  const closeDialog = () => {
    document.getElementById('add-site-dialog').style.display = 'none'
    document.getElementById('site-url-input').value = ''
    document.getElementById('site-name-input').value = ''
  }
  document.getElementById('dialog-cancel')?.addEventListener('click', closeDialog)
  document.getElementById('add-site-dialog')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeDialog() })
  document.getElementById('dialog-confirm')?.addEventListener('click', async () => {
    const url  = document.getElementById('site-url-input').value.trim()
    const name = document.getElementById('site-name-input').value.trim()
    if (!url) return
    const fullUrl = url.startsWith('http') ? url : `https://${url}`
    state.savedSites = await window.api.saveSite({ url: fullUrl, name: name || fullUrl })
    renderSavedSites()
    closeDialog()
  })

  // Setup overlay
  document.getElementById('choose-folder-btn')?.addEventListener('click', async () => {
    const folders = await window.api.addMusicFolder()
    if (folders) {
      state.musicFolders = folders
      renderFolders()
      document.getElementById('setup-overlay').style.display = 'none'
      showLoading()
      await fullScan()
    }
  })

  // Quality sources sidebar buttons
  document.getElementById('qsrc-add-btn')?.addEventListener('click', showAddSourceDialog)
  document.getElementById('qsrc-discover-btn')?.addEventListener('click', discoverSources)

  // Add folder
  document.getElementById('add-folder-btn')?.addEventListener('click', async () => {
    const folders = await window.api.addMusicFolder()
    if (folders) {
      state.musicFolders = folders
      renderFolders()
      await fullScan()
    }
  })

  // Player controls
  document.getElementById('btn-play')?.addEventListener('click', togglePlay)
  document.getElementById('btn-next')?.addEventListener('click', playNext)
  document.getElementById('btn-prev')?.addEventListener('click', playPrev)

  document.getElementById('btn-shuffle')?.addEventListener('click', function() {
    state.shuffle = !state.shuffle
    this.classList.toggle('active', state.shuffle)
    document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
    updateNextPrefetch()
  })

  document.getElementById('btn-repeat')?.addEventListener('click', function() {
    const states = ['off', 'all', 'one']
    state.repeat = states[(states.indexOf(state.repeat) + 1) % 3]
    const isActive = state.repeat !== 'off'
    this.classList.toggle('active', isActive)
    this.title = state.repeat === 'one' ? 'Repeat: one' : state.repeat === 'all' ? 'Repeat: all' : 'Repeat (R)'
    document.getElementById('np-modal-repeat')?.classList.toggle('active', isActive)
    updateNextPrefetch()
  })

  // Like button (player bar)
  document.getElementById('btn-like')?.addEventListener('click', function() {
    const albumId = this.dataset.album
    if (albumId) {
      toggleLike(albumId)
      this.classList.remove('heart-pulse'); void this.offsetWidth; this.classList.add('heart-pulse')
      this.addEventListener('animationend', () => this.classList.remove('heart-pulse'), { once: true })
    }
  })

  // Lyrics drawer toggle button
  document.getElementById('btn-lyrics')?.addEventListener('click', () => toggleLyricsDrawer())

  // Lyrics drawer buttons
  document.getElementById('lyrics-drawer-search')?.addEventListener('click', () => searchAndSaveLyrics())
  document.getElementById('lyrics-drawer-close')?.addEventListener('click', () => closeLyricsDrawer())
  document.getElementById('lyrics-drawer-expand')?.addEventListener('click', () => {
    closeLyricsDrawer()
    const artWrap = document.getElementById('np-art-wrap')
    if (artWrap) artWrap.click() // open full-screen now-playing modal with lyrics tab
  })

  // Add-to-playlist from player bar
  document.getElementById('btn-addpl-bar')?.addEventListener('click', () => {
    const track = state.queue[state.queueIndex]
    if (track) showAddToPlaylistModal([track])
  })

  // Clickable now-playing meta
  document.getElementById('np-title')?.addEventListener('click', () => {
    const track = state.queue[state.queueIndex]
    if (!track || !track.title || track.title === '—') return
    const albumId = track.albumId || document.getElementById('np-title')?.dataset.albumId
    if (albumId) navigate('album', albumId)
    else navigate('search', track.title)
  })
  document.getElementById('np-artist')?.addEventListener('click', () => {
    const track = state.queue[state.queueIndex]
    if (!track) return
    const artist = track.albumArtist || track.artist
    if (artist && artist !== '—') navigate('artist', artist)
  })
  document.getElementById('np-album')?.addEventListener('click', () => {
    const track = state.queue[state.queueIndex]
    if (!track) return
    const albumId = track.albumId || document.getElementById('np-album')?.dataset.albumId
    if (albumId) navigate('album', albumId)
    else if (track.albumName) navigate('search', track.albumName)
  })

  // Progress bar
  makeDraggable(
    document.getElementById('progress-track'),
    document.getElementById('progress-fill'),
    document.getElementById('progress-thumb'),
    ratio => { if (audio.duration) audio.currentTime = ratio * audio.duration }
  )

  // Progress bar hover tooltip
  const progressTrack = document.getElementById('progress-track')
  const progressTooltip = document.getElementById('progress-tooltip')
  if (progressTrack && progressTooltip) {
    progressTrack.addEventListener('mousemove', e => {
      if (!audio.duration) return
      const rect = progressTrack.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const time = ratio * audio.duration
      progressTooltip.textContent = fmtDur(time)
      progressTooltip.style.display = 'block'
      progressTooltip.style.left = `${e.clientX - rect.left}px`
    })
    progressTrack.addEventListener('mouseleave', () => {
      progressTooltip.style.display = 'none'
    })
  }

  // Volume bar
  makeDraggable(
    document.getElementById('vol-track'),
    document.getElementById('vol-fill'),
    document.getElementById('vol-thumb'),
    ratio => {
      audio.volume = ratio; state.lastVolume = ratio
      setVolDisplay(ratio)
      clearTimeout(_volSaveTimer)
      _volSaveTimer = setTimeout(() => window.api.saveVolume(ratio), 300)
    }
  )

  // Volume scroll with mouse wheel
  document.getElementById('vol-track')?.addEventListener('wheel', e => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 0.05 : -0.05
    audio.volume = Math.max(0, Math.min(1, audio.volume + delta))
    state.lastVolume = audio.volume
    setVolDisplay(audio.volume)
    clearTimeout(_volSaveTimer)
    _volSaveTimer = setTimeout(() => window.api.saveVolume(audio.volume), 300)
  }, { passive: false })

  // Karaoke lyrics toggle
  document.getElementById('np-modal-lyrics-toggle')?.addEventListener('click', () => {
    const modal = document.getElementById('np-modal')
    if (!modal) return
    modal.classList.toggle('lyrics-mode')
    const isKaraoke = modal.classList.contains('lyrics-mode')
    const track = state.queue[state.queueIndex]
    if (isKaraoke && track) {
      const titleEl = document.getElementById('np-modal-lyrics-title')
      const artistEl = document.getElementById('np-modal-lyrics-artist')
      if (titleEl) titleEl.textContent = track.title || '—'
      if (artistEl) artistEl.textContent = track.albumArtist || track.artist || '—'
    }
  })

  // Radio context menu
  document.getElementById('ctx-radio')?.addEventListener('click', () => {
    if (!ctxTarget) return
    const track = ctxTarget.type === 'track' ? ctxTarget.track : null
    const album = state.library.find(a => a.id === ctxTarget.albumId)
    const artist = ctxTarget.artist || album?.artist || track?.albumArtist
    const genre = album?.genre || (track ? state.library.find(a => a.id === track.albumId)?.genre : null)
    startRadio(track, artist, genre)
    hideContextMenu()
  })

  // Playback speed
  document.getElementById('btn-speed')?.addEventListener('click', cycleSpeed)

  // Sleep timer
  document.getElementById('btn-sleep')?.addEventListener('click', () => {
    const panel = document.getElementById('sleep-panel')
    panel?.classList.toggle('open')
  })
  document.querySelectorAll('.sleep-option').forEach(btn => {
    btn.addEventListener('click', () => {
      setSleepTimer(parseInt(btn.dataset.mins))
      document.getElementById('sleep-panel')?.classList.remove('open')
    })
  })
  document.addEventListener('click', e => {
    if (!e.target.closest('#sleep-panel') && !e.target.closest('#btn-sleep'))
      document.getElementById('sleep-panel')?.classList.remove('open')
  })

  // Queue panel
  document.getElementById('btn-queue')?.addEventListener('click', toggleQueuePanel)
  document.getElementById('queue-close-btn')?.addEventListener('click', () => {
    state.queuePanelOpen = false
    document.getElementById('queue-panel').classList.remove('open')
    document.getElementById('btn-queue')?.classList.remove('active')
  })

  // Now playing art → open modal
  document.getElementById('np-art-wrap')?.addEventListener('click', () => {
    if (state.queue.length) showNowPlayingModal()
  })

  // Now playing modal controls
  document.getElementById('np-modal-close')?.addEventListener('click', hideNowPlayingModal)
  document.getElementById('np-modal-play')?.addEventListener('click', togglePlay)
  document.getElementById('np-modal-prev')?.addEventListener('click', playPrev)
  document.getElementById('np-modal-next')?.addEventListener('click', playNext)
  document.getElementById('np-modal-shuffle')?.addEventListener('click', function() {
    state.shuffle = !state.shuffle
    this.classList.toggle('active', state.shuffle)
    document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
    updateNextPrefetch()
  })
  document.getElementById('np-modal-repeat')?.addEventListener('click', function() {
    const states = ['off','all','one']
    state.repeat = states[(states.indexOf(state.repeat)+1)%3]
    const isActive = state.repeat !== 'off'
    this.classList.toggle('active', isActive)
    document.getElementById('btn-repeat')?.classList.toggle('active', isActive)
    updateNextPrefetch()
  })

  // Context menu actions
  document.getElementById('ctx-play')?.addEventListener('click', () => {
    if (!ctxTarget) return
    if (ctxTarget.type === 'album') {
      const album = state.library.find(a => a.id === ctxTarget.albumId)
      if (album) playAlbum(album, 0)
    } else if (ctxTarget.type === 'track' && ctxTarget.track) {
      const album = state.library.find(a => a.id === ctxTarget.albumId)
      if (album) {
        const idx = album.tracks.findIndex(t => t.filePath === ctxTarget.track.filePath)
        if (idx >= 0) playTrack(album, idx)
      }
    }
    hideContextMenu()
  })
  document.getElementById('ctx-queue')?.addEventListener('click', () => {
    if (!ctxTarget) return
    const album = state.library.find(a => a.id === ctxTarget.albumId)
    if (!album) { hideContextMenu(); return }
    if (ctxTarget.type === 'track' && ctxTarget.track) {
      const t = ctxTarget.track
      addToQueue(album, [{ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name }])
    } else {
      addToQueue(album)
    }
    hideContextMenu()
  })
  document.getElementById('ctx-addpl')?.addEventListener('click', () => {
    if (!ctxTarget) { hideContextMenu(); return }
    const album = state.library.find(a => a.id === ctxTarget.albumId)
    let tracks = []
    if (ctxTarget.type === 'track' && ctxTarget.track) {
      const t = ctxTarget.track
      tracks = [{ ...t, albumArtist: album?.artist || t.artist, artPath: album?.artPath || t.artPath, albumName: album?.name || t.albumName }]
    } else if (album) {
      tracks = album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name }))
    }
    hideContextMenu()
    if (tracks.length) showAddToPlaylistModal(tracks)
  })
  document.getElementById('ctx-artist')?.addEventListener('click', () => {
    if (!ctxTarget?.artist) return
    navigate('artist', ctxTarget.artist)
    hideContextMenu()
  })
  document.getElementById('ctx-like')?.addEventListener('click', () => {
    if (ctxTarget?.albumId) toggleLike(ctxTarget.albumId)
    hideContextMenu()
  })
  document.getElementById('ctx-play-next')?.addEventListener('click', () => {
    if (!ctxTarget) return
    const album = state.library.find(a => a.id === ctxTarget.albumId)
    if (!album) { hideContextMenu(); return }
    let tracks = []
    if (ctxTarget.type === 'track' && ctxTarget.track) {
      const t = ctxTarget.track
      tracks = [{ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }]
    } else {
      tracks = album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }))
    }
    const insertIdx = state.queueIndex >= 0 ? state.queueIndex + 1 : 0
    state.queue.splice(insertIdx, 0, ...tracks)
    if (state.queuePanelOpen) renderQueuePanel()
    showToast(`Up next: ${tracks[0].title || 'track'}`)
    hideContextMenu()
  })
  document.getElementById('ctx-show-folder')?.addEventListener('click', () => {
    const filePath = ctxTarget?.track?.filePath
    if (filePath) window.api.slskShowInFolder(filePath)
    hideContextMenu()
  })
  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu')) hideContextMenu()
  })
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('.album-card') && !e.target.closest('.track-row')) hideContextMenu()
  })

  // Browser nav
  const urlBar = document.getElementById('url-bar')
  const doNav = () => { const url = urlBar?.value.trim(); if (url) loadBrowserUrl(url) }
  document.getElementById('bnav-go')?.addEventListener('click', doNav)
  urlBar?.addEventListener('keydown', e => { if (e.key === 'Enter') doNav() })
  document.getElementById('bnav-back')?.addEventListener('click', () => window.api.browserBack())
  document.getElementById('bnav-fwd')?.addEventListener('click', () => window.api.browserForward())
  document.getElementById('bnav-refresh')?.addEventListener('click', () => {
    if (state.browserLoading) window.api.browserStop()
    else window.api.browserRefresh()
  })
  document.getElementById('bnav-zoom-out')?.addEventListener('click', () => window.api.browserZoomOut())
  document.getElementById('bnav-zoom-in')?.addEventListener('click', () => window.api.browserZoomIn())
  document.getElementById('bnav-zoom-label')?.addEventListener('click', () => window.api.browserZoomReset())
  document.getElementById('bnav-devtools')?.addEventListener('click', () => window.api.openBrowserDevtools())
  document.getElementById('bnav-dl-toggle')?.addEventListener('click', toggleDlPanel)
  document.getElementById('dl-panel-clear')?.addEventListener('click', () => {
    for (const [id, dl] of _downloads.entries()) { if (dl.state !== 'active') _downloads.delete(id) }
    renderDlPanel()
  })
  document.getElementById('save-site-btn')?.addEventListener('click', async () => {
    const url = state.currentUrl
    if (!url) return
    try {
      const hostname = new URL(url).hostname
      const name = prompt('Name for this site:', hostname)
      if (name !== null) {
        state.savedSites = await window.api.saveSite({ url, name: name || url })
        renderSavedSites()
      }
    } catch (_) {}
  })
  document.getElementById('bnav-close')?.addEventListener('click', () => { hideBrowser(); navigate('home') })

  // Cache persistent player-bar elements once — avoids getElementById on every tick
  _dom.fill     = document.getElementById('progress-fill')
  _dom.thumb    = document.getElementById('progress-thumb')
  _dom.timeCur  = document.getElementById('time-cur')
  _dom.modalFill  = document.getElementById('np-modal-fill')
  _dom.modalThumb = document.getElementById('np-modal-thumb')
  _dom.modalCur   = document.getElementById('np-modal-cur')

  let _lastSavedSec = -1

  // Audio events
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return
    const ct = audio.currentTime
    const ratio = ct / audio.duration

    // ── Always-run (background-safe) ──────────────────────────────────────
    // Position autosave every 5s, but only once per second boundary
    const intSec = Math.floor(ct)
    if (intSec !== _lastSavedSec && intSec % 5 === 0) {
      _lastSavedSec = intSec
      const track = state.queue[state.queueIndex]
      if (track) window.api.savePlaybackState({ filePath: track.filePath, position: ct })
    }

    // ── Skip all DOM updates when app is hidden ───────────────────────────
    if (!_appVisible) return

    const pct = `${ratio * 100}%`
    if (_dom.fill)  _dom.fill.style.width = pct
    if (_dom.thumb) _dom.thumb.style.left = pct
    if (_dom.timeCur) _dom.timeCur.textContent = fmtDur(ct)
    if (state.modalOpen) {
      if (_dom.modalFill)  _dom.modalFill.style.width = pct
      if (_dom.modalThumb) _dom.modalThumb.style.left  = pct
      if (_dom.modalCur)   _dom.modalCur.textContent = fmtDur(ct)
    }
    updateLyricsHighlight()
    updateLyricsDrawerHighlight()
  })
  audio.addEventListener('loadedmetadata', () => {
    document.getElementById('time-total').textContent = fmtDur(audio.duration)
    const mt = document.getElementById('np-modal-total')
    if (mt) mt.textContent = fmtDur(audio.duration)
  })
  audio.addEventListener('ended', () => {
    playNext()
  })
  audio.addEventListener('autoadvanced', (e) => {
    // mpv already switched tracks gaplessly — sync UI state without reloading
    const idx = state.queue.findIndex(t => t.filePath === e.detail)
    if (idx === -1) return
    state.queueIndex = idx
    const track = state.queue[idx]
    state.isPlaying = true
    updatePlayBtn()
    updateNowPlaying(track)
    updateTrackHighlight()
    updatePlayerLikeBtn()
    if (state.queuePanelOpen) renderQueuePanel()
    if (state.modalOpen) { updateNowPlayingModal(); syncModalPlayBtn() }
    window.api.savePlaybackState({ filePath: track.filePath, position: 0 })
    state.playCounts[track.filePath] = (state.playCounts[track.filePath] || 0) + 1
    window.api.incrementPlayCount(track.filePath)
    _lyrics = null
    renderLyricsPanel()
    updateLyricsDrawer()
    fetchLyrics(track).then(lines => { _lyrics = lines; renderLyricsPanel(); updateLyricsDrawer() })
    syncExtension()
    updateNextPrefetch()
  })
  audio.addEventListener('audioparams', (e) => {
    const el = document.getElementById('np-format')
    if (!el) return
    const p = e.detail
    el.textContent = p?.samplerate ? `${(p.format || '').toUpperCase()} ${Math.round(p.samplerate / 1000)}kHz` : ''
  })
  audio.addEventListener('error', e => {
    console.error('Audio error:', e)
    const t = state.queue[state.queueIndex]
    if (!t || !/^https?:\/\//.test(t.filePath)) return
    // Dead/region-locked YouTube stream — tell the user and move on
    const titleEl = document.getElementById('np-title')
    if (titleEl) {
      const orig = titleEl.textContent
      titleEl.textContent = 'Stream unavailable — skipping'
      setTimeout(() => { titleEl.textContent = orig }, 2500)
    }
    if (state.queue.length > 1) playNext()
  })

  // IPC events
  window.api.on('dl-started', ({ id, filename, total, isMusic }) => {
    _downloads.set(id, { filename, total, received: 0, isMusic, state: 'active' })
    renderDlPanel()
    // Briefly show panel on new download
    const panel = document.getElementById('dl-panel')
    if (panel && panel.style.display === 'none') {
      panel.style.display = 'flex'
      setTimeout(() => { if (document.getElementById('dl-panel')?.style.display !== 'none') document.getElementById('dl-panel').style.display = 'none' }, 2500)
    }
  })
  window.api.on('dl-progress', ({ id, received, total }) => {
    const dl = _downloads.get(id)
    if (dl) { dl.received = received; dl.total = total; renderDlPanel() }
  })
  window.api.on('dl-complete', ({ id, isMusic }) => {
    const dl = _downloads.get(id)
    if (dl) { dl.state = 'done'; dl.received = dl.total; renderDlPanel() }
    if (isMusic) setTimeout(() => backgroundSync(), 800)
  })
  window.api.on('dl-cancelled', ({ id }) => {
    const dl = _downloads.get(id); if (dl) { dl.state = 'cancelled'; renderDlPanel() }
  })
  window.api.on('dl-failed', ({ id }) => {
    const dl = _downloads.get(id); if (dl) { dl.state = 'failed'; renderDlPanel() }
  })

  // Torrent events
  window.api.on('torrent-started', () => { if (state.currentPage === 'downloads') navigate('downloads') })
  window.api.on('torrent-progress', snap => {
    state._torrents = state._torrents || new Map()
    state._torrents.set(snap.infoHash, snap)
    if (state.currentPage === 'downloads') _renderTorrentSection()
  })
  window.api.on('torrent-done', ({ infoHash, name }) => {
    state._torrents?.delete(infoHash)
    if (state.currentPage === 'downloads') _renderTorrentSection()
    backgroundSync()
  })
  window.api.on('do-lib-rescan', () => backgroundSync())

  window.api.on('yt-dl-progress', dl => {
    const prev = state.ytDownloads.get(dl.id)
    state.ytDownloads.set(dl.id, dl)
    if (dl.state === 'completed' && prev?.state !== 'completed') {
      _scheduleLibRescan()
      window.api.notifyDownloadComplete({ count: 1, albumName: `${dl.artist ? dl.artist + ' — ' : ''}${dl.title}` })
    }
    const box = document.getElementById('yt-dl-list')
    if (box) _renderYtDownloadRows(box)
  })
  window.api.ytGetDownloads().then(list => {
    for (const d of (list || [])) state.ytDownloads.set(d.id, d)
  }).catch(() => {})

  window.api.on('browser-url', url => {
    state.currentUrl = url
    const bar = document.getElementById('url-bar')
    if (bar && document.activeElement !== bar) bar.value = url
  })
  window.api.on('browser-title', title => {
    document.title = title ? `${title} — Papa Audio` : 'Papa Audio'
  })
  window.api.on('browser-loading', loading => {
    state.browserLoading = loading
    const refreshBtn = document.getElementById('bnav-refresh')
    if (refreshBtn) {
      const r = refreshBtn.querySelector('.icon-refresh')
      const s = refreshBtn.querySelector('.icon-stop')
      if (r) r.style.display = loading ? 'none' : ''
      if (s) s.style.display = loading ? '' : 'none'
    }
    const lb = document.getElementById('bnav-loading-bar')
    if (lb) lb.style.display = loading ? 'block' : 'none'
  })
  window.api.on('browser-zoom', pct => {
    const label = document.getElementById('bnav-zoom-label')
    if (label) label.textContent = `${pct}%`
  })
  window.api.on('browser-load-error', ({ desc }) => {
    console.warn('Browser load error:', desc)
  })
  window.api.on('media-key', key => {
    if (key === 'play-pause') togglePlay()
    else if (key === 'next')  playNext()
    else if (key === 'prev')  playPrev()
  })

  window.api.on('ext-cmd', cmd => {
    if (cmd === 'play-pause') { togglePlay(); return }
    if (cmd === 'next')       { playNext();   return }
    if (cmd === 'prev')       { playPrev();   return }
    if (cmd === 'shuffle') {
      state.shuffle = !state.shuffle
      document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
      document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
      updateNextPrefetch()
      syncExtension()
      return
    }
    if (cmd === 'repeat') {
      document.getElementById('btn-repeat')?.click()
      syncExtension()
      return
    }
    if (cmd.startsWith('seek:')) {
      const pos = parseFloat(cmd.slice(5))
      if (!isNaN(pos) && audio.duration) {
        audio.currentTime = Math.max(0, Math.min(audio.duration, pos))
        syncExtension()
      }
      return
    }
    if (cmd.startsWith('volume:')) {
      const vol = parseFloat(cmd.slice(7))
      if (!isNaN(vol)) {
        audio.volume = Math.max(0, Math.min(1, vol))
        state.lastVolume = audio.volume
        setVolDisplay(audio.volume)
        window.api.saveVolume(audio.volume)
        syncExtension()
      }
      return
    }
    if (cmd.startsWith('jump:')) {
      const idx = parseInt(cmd.slice(5))
      if (!isNaN(idx) && idx >= 0 && idx < state.queue.length) {
        state.queueIndex = idx
        playCurrentTrack()
      }
      return
    }
    if (cmd.startsWith('play-album:')) {
      const rest = cmd.slice(11)
      const sep  = rest.indexOf(':')
      // play-album:albumId  OR  play-album:albumId:filePath
      const albumId = sep >= 0 ? rest.slice(0, sep) : rest
      const fp      = sep >= 0 ? rest.slice(sep + 1) : null
      const album   = state.library.find(a => a.id === albumId)
      if (album) {
        const startIdx = fp ? album.tracks.findIndex(t => t.filePath === fp) : 0
        playAlbum(album, Math.max(0, startIdx))
        navigate('album', albumId)
      }
      return
    }
    if (cmd.startsWith('queue-album:')) {
      const album = state.library.find(a => a.id === cmd.slice(12))
      if (album) addToQueue(album)
      return
    }
    if (cmd.startsWith('queue-track:')) {
      // format: queue-track:albumId:filePath (filePath may contain colons)
      const rest = cmd.slice(12)
      const sep = rest.indexOf(':')
      if (sep >= 0) {
        const album = state.library.find(a => a.id === rest.slice(0, sep))
        const fp = rest.slice(sep + 1)
        if (album) {
          const track = album.tracks.find(t => t.filePath === fp)
          if (track) addToQueue(album, [{ ...track, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }])
        }
      }
      return
    }
    if (cmd.startsWith('remove-queue:')) {
      const idx = parseInt(cmd.slice(13))
      if (!isNaN(idx) && idx >= 0 && idx < state.queue.length) {
        state.queue.splice(idx, 1)
        if (idx < state.queueIndex) state.queueIndex--
        else if (idx === state.queueIndex) {
          if (state.queue.length) playCurrentTrack()
          else { audio.pause(); state.isPlaying = false; state.queueIndex = -1; updatePlayBtn(); updateNowPlaying(null) }
        }
        syncExtension()
        if (state.queuePanelOpen) renderQueuePanel()
      }
      return
    }
    if (cmd === 'clear-queue') {
      audio.pause()
      state.queue = []; state.queueIndex = -1; state.isPlaying = false
      updateNextPrefetch()
      updatePlayBtn(); updateNowPlaying(null)
      if (state.queuePanelOpen) renderQueuePanel()
      syncExtension()
      return
    }
    if (cmd.startsWith('move-queue:')) {
      const parts = cmd.slice(11).split(':').map(Number)
      const [from, to] = parts
      if (!isNaN(from) && !isNaN(to) && from !== to &&
          from >= 0 && from < state.queue.length &&
          to >= 0 && to < state.queue.length) {
        const [moved] = state.queue.splice(from, 1)
        state.queue.splice(to, 0, moved)
        if (from === state.queueIndex) state.queueIndex = to
        else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--
        else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++
        syncExtension()
        if (state.queuePanelOpen) renderQueuePanel()
      }
      return
    }
  })

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'

    // Ctrl+K → focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      document.getElementById('tb-search')?.focus()
      return
    }

    // Ctrl+L → focus URL bar (browser mode)
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      if (state.browserActive) {
        e.preventDefault()
        const bar = document.getElementById('url-bar')
        if (bar) { bar.focus(); bar.select() }
      }
      return
    }

    // Ctrl+Shift+I → browser devtools
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
      if (state.browserActive) { e.preventDefault(); window.api.openBrowserDevtools() }
      return
    }

    // Escape
    if (e.key === 'Escape') {
      const sm = document.getElementById('shortcuts-modal')
      if (sm && sm.style.display !== 'none') { sm.style.display = 'none'; return }
      if (_lyricsDrawerOpen) { closeLyricsDrawer(); return }
      if (state.modalOpen) { hideNowPlayingModal(); return }
      if (state.browserActive) { hideBrowser(); navigate('home'); return }
      const d = document.getElementById('add-site-dialog')
      if (d && d.style.display !== 'none') { d.style.display = 'none'; return }
      if (!document.getElementById('ctx-menu').style.display === 'none') hideContextMenu()
      return
    }

    if (inInput) return

    // App navigation
    if (e.key === 'ArrowLeft' && e.altKey)  { e.preventDefault(); navigateBack();    return }
    if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); navigateForward(); return }

    // Playback
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return }

    // Seek ±10s
    if (e.key === 'ArrowRight' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10)
      return
    }
    if (e.key === 'ArrowLeft' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      audio.currentTime = Math.max(0, audio.currentTime - 10)
      return
    }

    // Volume
    if (e.key === '=' || e.key === '+') {
      audio.volume = Math.min(1, audio.volume + 0.05)
      state.lastVolume = audio.volume
      setVolDisplay(audio.volume)
      window.api.saveVolume(audio.volume)
      return
    }
    if (e.key === '-') {
      audio.volume = Math.max(0, audio.volume - 0.05)
      state.lastVolume = audio.volume
      setVolDisplay(audio.volume)
      window.api.saveVolume(audio.volume)
      return
    }
    if (e.key === 'm' || e.key === 'M') {
      if (audio.volume > 0) {
        state.lastVolume = audio.volume
        audio.volume = 0
      } else {
        audio.volume = state.lastVolume || 0.8
      }
      setVolDisplay(audio.volume)
      window.api.saveVolume(audio.volume)
      return
    }

    // Fullscreen now-playing
    if (e.key === 'f' || e.key === 'F') {
      if (state.queue.length && state.queueIndex >= 0) { showNowPlayingModal(); return }
    }
    // Queue toggle
    if (e.key === 'q' || e.key === 'Q') { toggleQueuePanel(); return }
    // Shuffle
    if (e.key === 's' || e.key === 'S') {
      state.shuffle = !state.shuffle
      document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
      updateNextPrefetch()
      return
    }
    // Repeat
    if (e.key === 'r' || e.key === 'R') {
      document.getElementById('btn-repeat')?.click()
      return
    }
    // Playback speed cycle
    if (e.key === 'x' || e.key === 'X') { cycleSpeed(); return }
    // Lyrics drawer toggle
    if (e.key === 'l' || e.key === 'L') { if (state.queue.length) { toggleLyricsDrawer(); return } }
    // Keyboard shortcuts modal
    if (e.key === '?') { toggleShortcutsModal(); return }
  })

  // ── Sidebar resize ────────────────────────────────────────────────────────
  const sidebarResizer = document.getElementById('sidebar-resizer')
  if (sidebarResizer) {
    let _resizerDragging = false
    let _resizerStartX = 0
    let _resizerStartW = 0
    sidebarResizer.addEventListener('mousedown', e => {
      _resizerDragging = true
      _resizerStartX = e.clientX
      _resizerStartW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 220
      sidebarResizer.classList.add('resizing')
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
    })
    document.addEventListener('mousemove', e => {
      if (!_resizerDragging) return
      const delta = e.clientX - _resizerStartX
      const newW = Math.max(160, Math.min(340, _resizerStartW + delta))
      document.documentElement.style.setProperty('--sidebar-w', newW + 'px')
    })
    document.addEventListener('mouseup', () => {
      if (!_resizerDragging) return
      _resizerDragging = false
      sidebarResizer.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    })
  }
}

function toggleShortcutsModal() {
  const m = document.getElementById('shortcuts-modal')
  if (!m) return
  const isHidden = m.style.display === 'none' || !m.style.display
  m.style.display = isHidden ? 'flex' : 'none'
}

// ── Extension sync ────────────────────────────────────────────────────────────
let _syncExtTimer = null
function syncExtension() {
  clearTimeout(_syncExtTimer)
  _syncExtTimer = setTimeout(_syncExtensionNow, 150)
}
function _syncExtensionNow() {
  const track = state.queue[state.queueIndex]
  if (!track) { window.api.updateNowPlaying({ playing: false }); return }
  window.api.updateNowPlaying({
    title:         track.title || '',
    artist:        track.albumArtist || track.artist || '',
    album:         track.albumName || '',
    artPath:       track.artPath || null,
    playing:       state.isPlaying,
    position:      audio.currentTime || 0,
    duration:      audio.duration || 0,
    volume:        audio.volume,
    shuffle:       state.shuffle,
    repeat:        state.repeat,
    queueIndex:    state.queueIndex,
    sampleRate:    track.sampleRate    || 0,
    bitsPerSample: track.bitsPerSample || 0,
    queue:      state.queue.map(t => ({
      title:         t.title || '',
      artist:        t.albumArtist || t.artist || '',
      artPath:       t.artPath || null,
      sampleRate:    t.sampleRate    || 0,
      bitsPerSample: t.bitsPerSample || 0,
      albumId:       t.albumId       || '',
      filePath:      t.filePath      || '',
    })),
  })
}

function syncLibraryExt() {
  window.api.updateLibraryExt(state.library)
}

// Sync position every second while playing
setInterval(() => { if (state.isPlaying) syncExtension() }, 1000)

// ── Start ───────────────────────────────────────────────────────────────────
init()
