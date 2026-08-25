// ── State ──────────────────────────────────────────────────────────────────
const state = {
  library: [],
  musicFolders: [],
  recentlyPlayed: [],
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
  browserLoading: false,
  libSort: 'alpha',
  libSearch: '',
  libLikedOnly: false,
  queuePanelOpen: false,
  lastVolume: 0.8,
  modalOpen: false,
  playbackSpeed: 1,
  sleepTimerEnd: null,
  savedQueues: [],
   libTab: 'albums',
  libGenre: null,
  statsRange: 'month',
  libYear: '',
  libFormat: '',
  libDecade: '',
  libSurround: '',
  libView: 'grid',
  libFolder: null,
  playlists: [],
  playlistFolders: [],   // persisted to localStorage: papa-playlist-folders
  smartPlaylists: [],
  currentPlaylistId: null,
  playlistSort: 'alpha',
  likedTracks: [],
  playCounts: {},
  playHistory: [],
  followedArtists: [],
  ytLiked: [],
  ytFollowed: [],
  ytSavedAlbums: [],
  ytRecent: [],
  downloadWishlist: [],
  _plSearch: '',
  stopAfterTrack: false,
  skipShortTracks: false,
  skipShortSecs: 30,
  skipInterludes: false,
  connectionStatus: { slskd: 'unknown', youtube: 'unknown' },
  isOnline: navigator.onLine !== false,
  albumRatings: {},
  albumNotes: {},
  searchSort: 'relevance',
}
try { state.albumRatings = JSON.parse(localStorage.getItem('papa-album-ratings') || '{}') } catch (_) { state.albumRatings = {} }
try { state.albumNotes = JSON.parse(localStorage.getItem('papa-album-notes') || '{}') } catch (_) { state.albumNotes = {} }

const slsk = {
  status: { installed: false, running: false, connected: false, configured: false },
  searching: false,
  searched: false,
  results: [],
  lastQuery: '',
  pendingSearches: 0,
  searchStart: 0,
  filter: 'all',
  sort: 'relevance',
  error: null,
}
// Repaint just the Soulseek section. Used by the failure paths, which
// previously wrote into #slsk-results -- an element that does not exist.
function _slskRepaint(query) {
  var sec = document.getElementById('slsk-section')
  if (!sec) return
  sec.innerHTML = renderSoulseekRow(query)
  bindSlskSearchEvents(query)
}

// Turn an IPC/daemon failure into something worth showing a person. Electron
// wraps renderer-side IPC errors as "Error invoking remote method '...': ...",
// which is noise to the user.
function _slskErrText(e) {
  var m = String((e && e.message) || e || 'Unknown error')
  m = m.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
  if (/not connected/i.test(m)) return 'Soulseek is not connected.'
  if (/\b401\b|unauthor/i.test(m)) return 'slskd rejected our login — check its username and password.'
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(m)) return 'Could not reach the slskd daemon.'
  if (/abort|timeout|timed out/i.test(m)) return 'slskd did not respond in time.'
  // Seen in practice after several searches in quick succession.
  if (/\b429\b/.test(m)) return 'slskd is rate-limiting searches — wait a moment and retry.'
  if (/\b5\d\d\b/.test(m)) return 'slskd hit an internal error (' + m + ').'
  return m
}

// The exact array the cards were rendered from. data-gi indexes THIS, so the
// click handlers must read it too -- see the comment where it is assigned.
var _slskRendered = []
var _slskTimer = null

var _playlistSorts = {}
const navHistory = []
const navFuture  = []
let _playCountTimer = null
let _shuffleHistory = []
let _skipShortGuard = 0
const audio = window.__papaPlayer
let _volSaveTimer = null
let _homeClockInterval = null
let _allTracksCache = null
let _allTracksCacheRef = null
let _oldQueue = null
let _suggCache = { trackFp: null, pool: [] }
const _scrollMemory = new Map()
var _undoStack = []
var _libPresets = []
try {
  var _lp = JSON.parse(localStorage.getItem('papa-lib-presets') || '[]')
  // JSON.parse succeeds for "null", "{}", "5" -- none of which have .length or
  // .map, so an unvalidated value made renderLibrary() throw and the whole tab
  // render as nothing, permanently, with no way back from the UI.
  if (Array.isArray(_lp)) _libPresets = _lp.filter(function (x) { return x && typeof x.name === 'string' })
} catch (_) {}
var timeDisplay = localStorage.getItem('papa_time_display') || 'elapsed'

// All three time modes used to render as an identical bare number in the same
// slot, so a stray right-click could leave the player showing "remaining" (or
// a whole album's length) as if it were elapsed time, permanently and with no
// way to tell. Each mode now labels itself.
function _fmtTimeCur(ct) {
  if (timeDisplay === 'total') return '\u03a3 ' + fmtDur(_albumTotalDuration())
  if (timeDisplay === 'remaining') return '-' + fmtDur(Math.max(0, audio.duration - ct))
  return fmtDur(ct)
}
function _timeCurTitle() {
  return timeDisplay === 'total' ? 'Total album duration (click to cycle)'
    : timeDisplay === 'remaining' ? 'Time remaining (click to cycle)'
    : 'Time elapsed (click to cycle)'
}


// ── Keyboard shortcut configuration ─────────────────────────────────────────
var DEFAULT_SHORTCUTS = {
  'playPause': 'Space',
  'nextTrack': 'ArrowRight',
  'prevTrack': 'ArrowLeft',
  'seekForward': 'Shift+ArrowRight',
  'seekBackward': 'Shift+ArrowLeft',
  'volumeUp': '=',
  'volumeDown': '-',
  'toggleMute': 'm',
  'toggleShuffle': 's',
  'cycleRepeat': 'r',
  'cycleSpeed': 'x',
  'fullscreen': 'f',
  'toggleQueue': 'q',
  'toggleLyrics': 'l',
  'focusSearch': 'Control+k',
  'commandPalette': 'Control+Shift+p',
  'likeTrack': 'Control+Shift+l',
  'sleepTimer': 'Control+Shift+s',
  'saveQueue': 'Control+s',
  'addToQueue': 'Control+q',
  'undo': 'Control+z',
  'skipShort': 'Control+Shift+k',
  'stopAfter': 'Control+Shift+t',
  'toggleAgent': 'Control+/',
  'shortcuts': 'F1',
}

var _shortcuts = {}
try {
  var _savedShortcuts = JSON.parse(localStorage.getItem('papa-shortcuts') || '{}')
  _shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, _savedShortcuts)
} catch (_) {
  _shortcuts = Object.assign({}, DEFAULT_SHORTCUTS)
}

function getShortcut(action) { return _shortcuts[action] || DEFAULT_SHORTCUTS[action] }

function saveShortcuts() {
  localStorage.setItem('papa-shortcuts', JSON.stringify(_shortcuts))
}

function resetShortcuts() {
  _shortcuts = Object.assign({}, DEFAULT_SHORTCUTS)
  saveShortcuts()
  showSnackbar('Shortcuts reset to defaults')
}

// ── Playlist import ──────────────────────────────────────────────────────────
var fileInput = document.createElement('input')
fileInput.type = 'file'
fileInput.accept = '.m3u,.m3u8'
fileInput.style.display = 'none'
document.body.appendChild(fileInput)

var _plCollapsedFolders = {}
try {
  var _pc = JSON.parse(localStorage.getItem('papa-pl-collapsed') || '{}')
  if (_pc && typeof _pc === 'object' && !Array.isArray(_pc)) _plCollapsedFolders = _pc
} catch (_) {}

// ── Undo ──────────────────────────────────────────────────────────────────────
function pushUndo(label, undoFn) {
  var entry = { label: label, fn: undoFn, done: false }
  _undoStack.push(entry)
  showSnackbar(label, 'Undo', function() {
    // Undo THIS action, not whatever happens to be on top of the stack. The
    // old pop() meant two undoable actions within the snackbar window crossed
    // wires: the older snackbar ran the newer undo.
    if (entry.done) return
    entry.done = true
    var at = _undoStack.indexOf(entry)
    if (at !== -1) _undoStack.splice(at, 1)
    entry.fn()
  })
}

function undoLastAction() {
  while (_undoStack.length) {
    var item = _undoStack.pop()
    if (item && !item.done) { item.done = true; item.fn(); return }
  }
}

// ── Visibility & power management ───────────────────────────────────────────
let _appVisible = !document.hidden
const _dom = {}  // cached refs for hot-path elements (populated in init)

const SPEEDS = [1, 1.25, 1.5, 2, 0.75]

var ALL_SHORTCUTS = [
  { category: 'Playback', keys: ['Space'], desc: 'Play/Pause' },
  { category: 'Playback', keys: ['← / →'], desc: 'Seek ±10s' },
  { category: 'Playback', keys: ['X'], desc: 'Cycle speed (1x→1.25x→1.5x→2x→0.75x)' },
  { category: 'Playback', keys: ['S'], desc: 'Toggle shuffle' },
  { category: 'Playback', keys: ['R'], desc: 'Cycle repeat (off/one/all)' },
  { category: 'Playback', keys: ['M'], desc: 'Mute/Unmute' },
  { category: 'Playback', keys: ['+ / -'], desc: 'Volume ±5%' },
  { category: 'Playback', keys: ['F'], desc: 'Fullscreen now playing' },
  { category: 'Navigation', keys: ['Ctrl+K'], desc: 'Focus search' },
  { category: 'Navigation', keys: ['Ctrl+Shift+P'], desc: 'Command palette' },
  { category: 'Navigation', keys: ['Alt+←'], desc: 'Go back' },
  { category: 'Navigation', keys: ['Alt+→'], desc: 'Go forward' },
  { category: 'Navigation', keys: ['Q'], desc: 'Toggle queue panel' },
  { category: 'Navigation', keys: ['L'], desc: 'Toggle lyrics drawer' },
  { category: 'Navigation', keys: ['? / F1'], desc: 'Keyboard shortcuts' },
  { category: 'Navigation', keys: ['F6 / Ctrl+Tab'], desc: 'Jump between sidebar, content, player' },
  { category: 'Navigation', keys: ['Ctrl+1'], desc: 'Go to Home' },
  { category: 'Navigation', keys: ['Ctrl+2'], desc: 'Go to Library' },
  { category: 'Navigation', keys: ['Ctrl+3'], desc: 'Go to Search' },
  { category: 'Navigation', keys: ['Ctrl+4'], desc: 'Go to Downloads' },
  { category: 'Navigation', keys: ['Ctrl+5'], desc: 'Go to Playlists' },
  { category: 'Actions', keys: ['Ctrl+Shift+L'], desc: 'Like current track' },
  { category: 'Actions', keys: ['Ctrl+Shift+S'], desc: '30-min sleep timer' },
  { category: 'Actions', keys: ['Ctrl+S'], desc: 'Save current queue' },
  { category: 'Actions', keys: ['Ctrl+Q'], desc: 'Add to queue (current track)' },
  { category: 'Actions', keys: ['Ctrl+Z'], desc: 'Undo last action' },
  { category: 'Actions', keys: ['Ctrl+Shift+K'], desc: 'Toggle auto-skip short tracks' },
  { category: 'Actions', keys: ['Ctrl+Shift+I'], desc: 'Toggle skip interludes' },
  { category: 'Actions', keys: ['Esc'], desc: 'Close modal/overlay' },
  { category: 'Window', keys: ['Ctrl+/'], desc: 'Toggle agent chat' },
  { category: 'Mouse', keys: ['Middle click'], desc: 'Play track/album standalone' },
  { category: 'Mouse', keys: ['Right click vol'], desc: 'Exact volume input' },
  { category: 'Mouse', keys: ['Click time'], desc: 'Toggle elapsed/remaining/total' },
]

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
    startDownloadsPolling(state.currentPage === 'downloads' ? 2000 : 20000)
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
  let bestScore = -1, br = 142, bg = 68, bb = 173
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2]
    const max = Math.max(r,g,b), min = Math.min(r,g,b)
    const sat = max === 0 ? 0 : (max - min) / max
    const lum = (max + min) / 510
    const s = Math.min(1, sat * 1.5)
    let penalty = 1
    if (lum < 0.15 || lum > 0.85) penalty = 0.5
    if (sat < 0.2) penalty = 0.3
    const score = sat * (1 - Math.abs(lum - 0.45)) * s * penalty
    if (score > bestScore) {
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
// The countdown in the tooltip/label is only true for the instant it is written,
// so it has to be re-rendered while the timer runs.
let _sleepTick = null
function setSleepTimer(mins) {
  if (_sleepTimeout) { clearTimeout(_sleepTimeout); _sleepTimeout = null }
  if (_sleepTick) { clearInterval(_sleepTick); _sleepTick = null }
  state.sleepTimerEnd = null
  if (!Number.isFinite(mins) || mins <= 0) { updateSleepBtn(); return }
  _sleepTick = setInterval(function () {
    if (!state.sleepTimerEnd) { clearInterval(_sleepTick); _sleepTick = null; return }
    updateSleepBtn()
  }, 30000)
  state.sleepTimerEnd = Date.now() + mins * 60000
  _sleepTimeout = setTimeout(() => {
    audio.pause(); state.isPlaying = false
    updatePlayBtn(); updateTrackHighlight()
    if (state.modalOpen) syncModalPlayBtn()
    state.sleepTimerEnd = null
    if (_sleepTick) { clearInterval(_sleepTick); _sleepTick = null }
    updateSleepBtn()
  }, mins * 60000)
  updateSleepBtn()
}

// One place that paints repeat state, because the main bar and the modal each
// used to do it themselves and had already drifted apart. "All" and "One" must
// stay tellable apart at rest -- the snackbar is gone after 1.5s.
function updateRepeatBtns() {
  var active = state.repeat !== 'off'
  var one = state.repeat === 'one'
  var title = one ? 'Repeat: one' : active ? 'Repeat: all' : 'Repeat (R)'
  var ids = ['btn-repeat', 'np-modal-repeat']
  for (var i = 0; i < ids.length; i++) {
    var b = document.getElementById(ids[i])
    if (!b) continue
    b.classList.toggle('active', active)
    b.classList.toggle('repeat-one', one)
    b.title = title
    b.setAttribute('aria-pressed', active ? 'true' : 'false')
    b.setAttribute('aria-label', title)
  }
}

function updateSleepBtn() {
  const btn = document.getElementById('btn-sleep')
  if (!btn) return
  const active = !!state.sleepTimerEnd
  btn.classList.toggle('active', active)
  var remaining = active ? Math.max(0, Math.round((state.sleepTimerEnd - Date.now()) / 60000)) : 0
  btn.title = active
    ? `Sleep timer: ${remaining}m remaining`
    : 'Sleep timer'
  var label = btn.querySelector('.sleep-label')
  if (active) {
    if (!label) {
      label = document.createElement('span')
      label.className = 'sleep-label'
      btn.appendChild(label)
    }
    label.textContent = remaining + 'm'
  } else {
    if (label) label.remove()
  }
}

function updateStopAfterBtn() {
  const btn = document.getElementById('btn-stop-after')
  if (!btn) return
  btn.classList.toggle('active', state.stopAfterTrack)
}

function updateFormatBadge(track) {
  const el = document.getElementById('np-format')
  if (!el) return
  const sr = track?.sampleRate || 0
  const bd = track?.bitsPerSample || 0
  if (track && track.filePath && track.filePath.startsWith('http')) { el.textContent = 'Stream'; el.className = 'np-format'; el.style.background = 'rgba(255,0,0,.1)'; el.style.color = 'var(--color-yt,#f00)'; return }
  if (!sr && !bd) { el.textContent = ''; el.className = 'np-format'; return }
  el.textContent = fmtSpec(bd, sr)
  const isMaster = bd >= 24 && sr >= 176400  // 24-bit / 176.4kHz+
  const isHiRes  = bd >= 24 && sr > 48000
  el.className = 'np-format' + (isMaster ? ' hi-res master' : isHiRes ? ' hi-res' : '')
}

function updateBitPerfectBadge() {
  var el = document.getElementById('np-bitperfect')
  if (!el) return
  var track = state.queue[state.queueIndex]
  if (!track) { el.style.display = 'none'; return }
  var settings = state._playerSettings || {}
  var isBitPerfect = settings.outputMode === 'exclusive' && track.sampleRate && track.bitsPerSample
  var noEffects = state.playbackSpeed === 1 && (!settings.replaygain || settings.replaygain === 'off')
  if (isBitPerfect && noEffects) {
    el.textContent = 'BIT-PERFECT'
    el.style.display = ''
    el.style.background = 'rgba(29,185,84,.15)'
    el.style.color = '#1db954'
  } else if (track.filePath && track.filePath.startsWith('http')) {
    el.style.display = 'none'
  } else {
    el.textContent = 'LOSSLESS'
    el.style.display = ''
    el.style.background = 'rgba(255,255,255,.08)'
    el.style.color = 'var(--text2)'
  }
}

function updateCrossfadeBadge() {
  const el = document.getElementById('np-crossfade')
  if (!el) return
  if (state._playerSettings && state._playerSettings.mode === 'crossfade') {
    el.textContent = 'CF ' + (state._playerSettings.crossfadeSecs || 4) + 's'
    el.style.display = ''
  } else {
    el.style.display = 'none'
  }
}

// ── Context menu target ─────────────────────────────────────────────────────
let ctxTarget = null  // { type: 'album'|'track', albumId, track, artist }

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const [info, liked, savedQueues, playlists, likedTracks, playCounts, playHistory, followedArtists, ytLiked, ytFollowed, ytSavedAlbums, ytRecent] = await Promise.all([
    window.api.getAppInfo(), window.api.getLiked(),
    window.api.getSavedQueues(),
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
  try { _playlistSorts = JSON.parse(localStorage.getItem('papa-pl-sorts') || '{}') } catch (_) { _playlistSorts = {} }
  try { var savedSmart = JSON.parse(localStorage.getItem('papa-smart-playlists') || 'null') } catch (_) { savedSmart = null }
  if (savedSmart) state.smartPlaylists = savedSmart
  try {
    var savedFolders = JSON.parse(localStorage.getItem('papa-playlist-folders') || '[]')
    if (Array.isArray(savedFolders)) state.playlistFolders = savedFolders.filter(function (f) { return typeof f === 'string' && f })
  } catch (_) {}
  state.savedQueues = savedQueues || []
  state.musicFolders   = info.musicFolders   || []
  state.recentlyPlayed = info.recentlyPlayed || []
  state.likedAlbums    = liked || []
  state.downloadWishlist = info.wishlist || []
  audio.volume = info.volume ?? 0.8
  state.lastVolume = audio.volume
  setVolDisplay(audio.volume)

  renderFolders()
  renderSavedQueues()
  initChatSidebar()
  initPlaybackSettings()
  var formatEl = document.getElementById('np-format')
  if (formatEl && !document.getElementById('np-bitperfect')) {
    var bp = document.createElement('span')
    bp.id = 'np-bitperfect'
    bp.className = 'np-format'
    formatEl.parentNode.insertBefore(bp, formatEl.nextSibling)
  }
  _setupCP()
  if (!document.getElementById('highlight-css')) {
    var hs = document.createElement('style')
    hs.id = 'highlight-css'
    hs.textContent = 'mark{background:rgba(29,185,84,.2);color:inherit;border-radius:2px;padding:0 2px}'
    document.head.appendChild(hs)
  }
  if (!document.getElementById('yt-health-css')) {
    var s = document.createElement('style')
    s.id = 'yt-health-css'
    s.textContent = '.yt-health-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}.yt-health-idle{background:var(--text3)}.yt-health-searching{background:#c4a747;animation:pulse 1s infinite}.yt-health-ok{background:#1db954}.yt-health-error{background:#e05c5c}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}'
    document.head.appendChild(s)
  }
  if (!document.getElementById('related-css')) {
    var s = document.createElement('style')
    s.id = 'related-css'
    s.textContent = '.related-chip{padding:8px 16px;border-radius:100px;background:var(--glass);border:1px solid var(--glass-border);color:var(--text2);font-size:12px;cursor:pointer;transition:background .12s}.related-chip:hover{background:var(--bg3);color:var(--text)}'
    document.head.appendChild(s)
  }
  updateYtHealth('idle')
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
    var session = await window.api.getSessionState()
    navigate(session && session.page ? session.page : 'home', session && session.page ? session.navId : null, { skipHistory: true, restoreScroll: true })
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
  showSnackbar('Library scan complete: ' + state.library.length + ' albums found')
}

// Album ids alone missed per-track deletes inside a surviving album, so a
// deleted song stayed on screen until you navigated away and back.
function _libSig(lib) {
  return window.PapaLibrarySig
    ? window.PapaLibrarySig.librarySignature(lib)
    : (lib || []).length + ':' + (lib || []).map(a => a.id).join('')
}

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

// Re-render in place after the library changes underneath us. Deliberately
// conservative: a re-render tears down the DOM, so it must not fire while a
// modal is open (it would rip out a confirmation the user is reading) and it
// must put the scroll position back.
var _pendingLibraryUpdate = null

function _modalIsOpen() {
  return !!document.querySelector('.modal-overlay, .addpl-overlay')
}

function applyLibraryUpdate(payload) {
  var albums = (payload && payload.albums) || null
  if (!albums) return
  if (_libSig(albums) === _libSig(state.library)) return

  // An open modal OR an active multi-selection is work in progress. Re-rendering
  // under either one destroys #content and silently throws it away -- a
  // selection just vanishes mid-action with no feedback. Hold the update; it is
  // replayed when the modal closes or the selection is cleared.
  if (_modalIsOpen() || _sel.selected.length) {
    _pendingLibraryUpdate = payload
    return
  }
  _pendingLibraryUpdate = null

  var content = document.getElementById('content')
  var scrollTop = content ? content.scrollTop : 0
  state.library = albums
  navigate(state.currentPage, _currentNavId(), { skipHistory: true })
  if (content) {
    var restore = document.getElementById('content')
    if (restore) restore.scrollTop = scrollTop
  }
  syncLibraryExt()
}

// A file vanished under playback: say so, take it out of the queue, and keep
// going. Silence here reads as "the app broke", which is how it used to feel.
function dropMissingTrack(filePath, track) {
  var R = window.PapaQueueRepair
  var name = (track && track.title) || (filePath || '').split('/').pop() || 'That track'
  if (!R) { if (state.queue.length > 1) playNext(); return }

  var res = R.repairQueue({
    queue: state.queue, queueIndex: state.queueIndex, removedPaths: [filePath],
  })
  state.queue = res.queue
  state.queueIndex = res.queueIndex

  if (res.empty) {
    // Same stop sequence the queue-removal path uses (renderer.js ~4658);
    // there is no stopPlayback() helper in this codebase.
    audio.pause()
    state.isPlaying = false
    state.queueIndex = -1
    updatePlayBtn()
    updateNowPlaying(null)
    showSnackbar(name + ' is missing — playback stopped')
  } else if (res.removedCurrent) {
    showSnackbar(name + ' is missing — skipped')
    playCurrentTrack()
  } else {
    showSnackbar(name + ' is missing — removed from the queue')
  }
  renderQueuePanel()
}

function flushPendingLibraryUpdate() {
  if (!_pendingLibraryUpdate) return
  var p = _pendingLibraryUpdate
  _pendingLibraryUpdate = null
  applyLibraryUpdate(p)
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
  audio.src = `file://${saved.filePath}`
  const resumePos = saved.position || 0
  if (resumePos > 1) {
    setTimeout(function() { audio.currentTime = resumePos }, 500)
  }
  state.isPlaying = false
  updatePlayBtn()
  updateNowPlaying(state.queue[idx])
  updateTrackHighlight()
  updateLikeBtn()
  syncExtension()

  var queues = await window.api.getSavedQueues()
  var autoQueue = queues.find(function(q) { return q.id === '_auto' })
  if (autoQueue && autoQueue.tracks && autoQueue.tracks.length) {
    state.queue = autoQueue.tracks
    // Older saves were written with an unclamped index against a truncated
    // tracks[], so don't trust it even now that the writer clamps.
    state.queueIndex = Math.min(Math.max(0, autoQueue.index || 0), autoQueue.tracks.length - 1)
    state._restoredFromQueue = true
    if (state.queuePanelOpen) renderQueuePanel()
    showSnackbar('Previous queue restored (' + autoQueue.tracks.length + ' tracks)', 'Clear', function() {
      state.queue = []; state.queueIndex = -1
      if (state.queuePanelOpen) renderQueuePanel()
    })
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────
function navigate(page, navId, opts = {}) {
  // Save scroll position of page we're leaving
  const contentEl = document.getElementById('content')
  if (contentEl && state.currentPage) {
    _scrollMemory.set(`${state.currentPage}:${_currentNavId() ?? ''}`, contentEl.scrollTop)
  }
  if (!opts.skipHistory) {
    // The first navigate() of the session has no page to come back to, and
    // pushing that empty entry left Back permanently enabled (and a second
    // press navigating to an undefined page, which renders nothing).
    if (state.currentPage) navHistory.push({ page: state.currentPage, navId: _currentNavId() })
    navFuture.length = 0
  }

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page)
  })

  state.currentPage        = page
  state.currentAlbumId     = page === 'album'  ? navId : null
  state.currentArtistName  = page === 'artist' ? navId : ''
  state.currentSearchQuery = page === 'search' ? navId : ''
  state.currentPlaylistId  = page === 'playlist' ? navId : null
  if (page !== 'playlist') state._plSearch = ''

  if (page === 'home')    renderHome()
  else if (page === 'library')   renderLibrary()
  else if (page === 'artists')   renderArtists()
  else if (page === 'album')     renderAlbum(navId)
  else if (page === 'artist')    renderArtist(navId)
  else if (page === 'search')    renderSearch(navId)
  else if (page === 'downloads') renderDownloads()
  else if (page === 'playlists') renderPlaylists()
  else if (page === 'playlist')  renderPlaylist(navId)
  else if (page === 'manage')    renderManage()
  else if (page === 'stats')     renderStats()
  else if (page === 'liked')     renderLikedSongs()
  else if (page === 'yt-album')  renderYtAlbum(navId)
  else if (page === 'yt-artist') renderYtArtist(navId)
  else if (page === 'yt-see-all')  renderYtSeeAll(navId)
  else if (page === 'yt-playlist') renderYtPlaylist(navId)
  else if (page === 'explore')     renderExplore()

  if (page === 'downloads') startDownloadsPolling(2000)
  else { _dlLastSig = ''; startDownloadsPolling(20000) }

  updateNavBtns()
  hideContextMenu()

  if (opts.restoreScroll && contentEl) {
    const savedScroll = _scrollMemory.get(`${page}:${navId ?? ''}`) || 0
    requestAnimationFrame(() => { contentEl.scrollTop = savedScroll })
  }

  window.api.saveSessionState({ page: page, navId: navId || null, scrollTop: contentEl ? contentEl.scrollTop || 0 : 0 })
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
  const section = list.closest('.sidebar-section')
  if (!state.musicFolders.length) {
    if (section) section.style.display = 'none'
    document.getElementById('setup-overlay').style.display = 'flex'
    return
  }
  if (section) section.style.display = ''
  list.innerHTML = state.musicFolders.map(f => `
    <li class="site-item" title="${esc(f)}">
      <span>${esc(shortPath(f))}</span>
      <button class="site-item-del" data-folder="${esc(f)}" title="Remove">&#10005;</button>
    </li>`).join('')
  list.querySelectorAll('.site-item-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      _confirmRemoveMusicFolder(btn.dataset.folder)
    })
  })
}

function shortPath(p) {
  const home = '/home/' + (p.split('/')[2] || '')
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}

// Removing a folder never touches the files themselves -- it just stops the
// app watching them -- but everything keyed off those paths (likes, playlists,
// history, queues) would otherwise dangle silently, so this routes through the
// same prune/undo discipline as a real delete instead of the old bare filter.
function _confirmRemoveMusicFolder(folder) {
  var prefix = folder.replace(/\/+$/, '') + '/'
  var affected = []
  for (var i = 0; i < state.library.length; i++) {
    var tracks = state.library[i].tracks || []
    for (var j = 0; j < tracks.length; j++) {
      var fp = tracks[j].filePath
      if (fp === folder || (fp && fp.indexOf(prefix) === 0)) affected.push(fp)
    }
  }
  var body = '<p class="mg-confirm-sum" style="margin-top:0">' + esc(shortPath(folder)) + '</p>' +
    (affected.length
      ? '<p class="mg-confirm-warn">' + affected.length + ' track' + (affected.length === 1 ? '' : 's') +
        ' will disappear from your library. Likes, playlists, history and queues referencing them will be cleaned up.</p>'
      : '<p class="mg-confirm-sum">No tracks in your library are under this folder right now.</p>') +
    '<p class="mg-confirm-note">The files themselves are not touched — only unwatched.</p>'

  _mgConfirm('Stop watching this folder?', body, 'Remove folder', async function () {
    state.musicFolders = await window.api.removeMusicFolder(folder)
    var prune = await window.api.libraryPruneState({ removed: affected, renamed: [] }).catch(function () { return null })
    renderFolders()
    await fullScan()

    var P = window.PapaLibraryPrune
    var extra = (P && prune && prune.summary) ? P.describeSummary(prune.summary) : ''
    var msg = 'Folder removed' + (extra ? '. ' + extra : '')

    showSnackbar(msg, 'Undo', async function () {
      state.musicFolders = await window.api.addMusicFolderPath(folder)
      if (prune && prune.snapshot) {
        await window.api.libraryRestoreState({ snapshot: prune.snapshot }).catch(function () {})
        await reloadPersistedState()
      }
      renderFolders()
      await fullScan()
      showSnackbar('Folder restored')
    }, 12000)
  })
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
  var src = `file://${artPath}`
  document.querySelectorAll(`.album-card[data-album="${esc(albumId)}"]`).forEach(card => {
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
  document.querySelectorAll(`.quick-card[data-album="${esc(albumId)}"]`).forEach(card => {
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
var _greetingAnimated = false
function renderHome() {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  var subtitles = [
    'Ready to discover something new?',
    'Your library is waiting.',
    'What genre today?',
    'Music never stops.',
    'Find your next favorite album.',
    'Soulseek is your superpower.',
    'Lossless sounds better.',
    'Your collection, your rules.',
    'Press Ctrl+Shift+P for quick actions.',
    'Ask the agent to find anything.',
  ]
  var subtitle = subtitles[Math.floor(Math.random() * subtitles.length)]
  // setContent() rebuilds #content wholesale, so the CSS animation restarts on
  // every visit to Home. It is a launch flourish, not a per-navigation one.
  var greetingCls = _greetingAnimated ? 'greeting-static' : 'greeting-fade-in'
  _greetingAnimated = true
  var greetingHTML = '<div class="' + greetingCls + '"><div class="greeting">' + greeting + '<div class="greeting-sub">' + subtitle + '</div></div></div>'
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

  const jumpBackHTML = (state.queue.length && state.queueIndex >= 0 && state.queueIndex < state.queue.length) ? '<div class="jumpback-card" id="jumpback-card"><div class="jumpback-art">' + artImg(state.queue[state.queueIndex].artPath, 'jumpback-art-img', 'jumpback-art-fallback') + '</div><div class="jumpback-info"><div class="jumpback-label">Continue listening</div><div class="jumpback-title">' + esc(state.queue[state.queueIndex].title || 'Unknown') + '</div><div class="jumpback-artist">' + esc(state.queue[state.queueIndex].artist || '') + '</div></div><button class="jumpback-play" id="jumpback-play" aria-label="Resume where you left off"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button></div>' : ''

  const quickHTML = quickAlbums.length ? `
    <div class="quick-grid">${quickAlbums.map(a => `
      <div class="quick-card" data-album="${esc(a.id)}">
        ${artImg(a.artPath, 'quick-card-art', 'quick-card-art-fallback')}
        <span class="quick-card-name">${esc(a.name)}</span>
        <button class="quick-card-play" data-play="${esc(a.id)}" aria-label="Play ${esc(a.name || 'album')}">
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

  const followingHTML = (state.followedArtists.length > 0 || state.ytFollowed.length > 0) ? `
    <div class="section-header">
      <span class="section-title">Following</span>
    </div>
    <div class="scroll-row">${ytFollowingCards}${state.followedArtists.map(name => {
      const ap = (state.library.find(a => a.artist === name || a.albumArtist === name) || {}).artPath
      const ct = _artistAlbumCount(name)
      return `<div class="artist-card following-card" data-follow-artist="${esc(name)}">
        <div class="artist-card-art">
          ${ap ? `<img src="${esc('file://' + ap)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
          <div class="artist-card-art-fallback" ${ap ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
        </div>
        <div class="artist-card-name">${esc(name)}</div>
        <div class="artist-card-meta">${ct} album${ct !== 1 ? 's' : ''}</div>
      </div>`
    }).join('')}</div>` : ''

  // One index, one pass. This used to scan the whole library (and every track
  // in it) once per history entry, twice, on every single visit to Home.
  var thirtyDaysAgo = Date.now() - 30 * 86400000
  var albumOfPath = {}
  for (var _li = 0; _li < state.library.length; _li++) {
    var _a = state.library[_li]
    if (!_a.tracks) continue
    for (var _tj = 0; _tj < _a.tracks.length; _tj++) albumOfPath[_a.tracks[_tj].filePath] = _a.id
  }
  var recents = {}
  var pcount = {}
  state.playHistory.forEach(function(p) {
    var id = albumOfPath[p.filePath]
    if (id === undefined) return
    if (p.ts > thirtyDaysAgo) recents[id] = true
    pcount[id] = (pcount[id] || 0) + 1
  })
  var backAlbums = state.library.filter(function(a) { return !recents[a.id] && (pcount[a.id] || 0) >= 10 }).sort(function(a, b) { return (pcount[b.id] || 0) - (pcount[a.id] || 0) }).slice(0, 6)
  var backHTML = backAlbums.length ? '<div class="section-header"><span class="section-title">Back in rotation</span></div><div class="scroll-row">' + backAlbums.map(albumCard).join('') + '</div>' : ''

  var genreCounts = {}
  state.library.forEach(function(a) { if (a.genre) { genreCounts[a.genre] = (genreCounts[a.genre] || 0) + 1 } })
  var topGenres = Object.keys(genreCounts).sort(function(a, b) { return (genreCounts[b] || 0) - (genreCounts[a] || 0) }).slice(0, 6)
  var mixColors = [['#5038a0','#3850a0'],['#a04038','#a07038'],['#2d7a4a','#1a5a7a'],['#6b38a0','#5038a0'],['#3850a0','#6b38a0'],['#a07038','#a04038']]
  if (topGenres.length === 0) topGenres = ['Your Mix 1','Your Mix 2','Your Mix 3','Your Mix 4','Your Mix 5','Your Mix 6']
  var dailyMixHTML = '<div class="section-header"><span class="section-title">Made for you</span></div><div class="scroll-row">' + topGenres.map(function(g, i) {
    return '<div class="daily-mix-card" style="background:linear-gradient(135deg,' + (mixColors[i] ? mixColors[i][0] : '#333') + ',' + (mixColors[i] ? mixColors[i][1] : '#555') + ')" data-mix-genre="' + esc(g || '') + '"><span class="daily-mix-num">' + esc(g) + ' Mix</span><span class="daily-mix-sub">Based on your taste</span></div>'
  }).join('') + '</div>'

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
    <div class="home-header"><div class="home-header-left"><canvas class="home-clock" id="home-clock" width="56" height="56"></canvas>${greetingHTML}</div>${artBtnHTML}</div>
    ${jumpBackHTML}${quickHTML}${followingHTML}${recentHTML}${addedHTML}${backHTML}${dailyMixHTML}${allHTML}
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

// ── Explore page: full personalized YT feed + account connect ───────────────
function _ytConnectBanner() {
  return `<div class="yt-connect-banner" id="yt-connect-banner">
    <div class="yt-connect-text">
      <div class="yt-connect-title">Connect your YouTube account</div>
      <div class="yt-connect-sub">Get recommendations, mixes and quick picks based on your taste.</div>
    </div>
    <button class="yt-connect-btn" id="yt-connect-btn">Connect</button>
  </div>`
}

function _exploreSection(sec, si) {
  var header = `<div class="section-header" style="margin-top:26px">
    <span class="section-title">${esc(sec.title)}</span>
  </div>`
  if (sec.kind === 'songs') {
    return `${header}<div class="explore-song-grid yt-home-songs" data-si="${si}">${_ytSongRows(sec.items)}</div>`
  }
  const card = sec.kind === 'albums' ? _ytAlbumCard : _ytPlaylistCard
  return `${header}<div class="album-grid">${sec.items.map(card).join('')}</div>`
}

function _bindExploreSections(root, sections) {
  root.querySelectorAll('.yt-home-songs').forEach(box => {
    bindYtEvents(sections[parseInt(box.dataset.si)].items, box)
  })
  root.querySelectorAll('.yt-album-card').forEach(c => c.addEventListener('click', () => navigate('yt-album', c.dataset.browse)))
  root.querySelectorAll('.yt-playlist-card').forEach(c => c.addEventListener('click', () => navigate('yt-playlist', c.dataset.playlist)))
}

async function renderExplore() {
  setContent(`<div class="page">${Array(3).fill(0).map(() => '<div class="skeleton skeleton-card"></div>').join('')}</div>`)
  var moods = [
    { name:'Energetic', emoji:'⚡', color:'#e8484a' },
    { name:'Chill', emoji:'🌊', color:'#3850a0' },
    { name:'Focus', emoji:'🎯', color:'#2d7a4a' },
    { name:'Happy', emoji:'😊', color:'#a07038' },
    { name:'Melancholy', emoji:'🌧️', color:'#5038a0' },
    { name:'Romantic', emoji:'💝', color:'#a0405a' },
    { name:'Dark', emoji:'🌑', color:'#1a1a2a' },
    { name:'Epic', emoji:'🏔️', color:'#6b38a0' },
  ]
  var moodHTML = '<div class="section-header" style="margin-top:0"><span class="section-title">How are you feeling?</span></div><div class="mood-grid">' + moods.map(function(m) { return '<div class="mood-card" style="background:' + m.color + '" data-mood="' + m.name.toLowerCase() + '"><div class="mood-card-emoji">' + m.emoji + '</div><div class="mood-card-label">' + m.name + '</div></div>' }).join('') + '</div>'
  const status = await window.api.ytAuthStatus().catch(() => ({ ok: false }))
  if (state.currentPage !== 'explore') return
  const signedIn = !!(status.ok && status.signedIn)

  var decades = ['1950s','1960s','1970s','1980s','1990s','2000s','2010s','2020s']
  var eraHTML = '<div class="section-header"><span class="section-title">Time machine</span></div><div class="era-timeline">' + decades.map(function(d) { return '<button class="era-chip" data-era="' + d + '">' + d + '</button>' }).join('') + '</div>'

  var discoveryHTML = '<div class="section-header"><span class="section-title">Discover</span></div><div class="discovery-swipe" id="discovery-swipe">' + state.library.slice(0, 10).map(function(a, i) { return '<div class="discovery-swipe-card" data-album="' + esc(a.id) + '" title="' + esc(a.artist + ' — ' + a.name) + '" style="cursor:pointer;z-index:' + (10 - i) + '"><div style="width:100%;height:100%;background:var(--bg3);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px">' + artImg(a.artPath, '', '') + '<div style="font-size:14px;font-weight:600;padding:0 16px;text-align:center">' + esc(a.name) + '</div><div style="font-size:12px;color:var(--text2)">' + esc(a.artist) + '</div></div></div>' }).join('') + '</div>'

  setContent(`<div class="page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
      <h1 class="section-title">Explore</h1><span class="yt-badge">YT</span>
      <button class="sort-btn" id="explore-refresh-btn" style="margin-left:auto">Refresh</button>
      ${signedIn ? `<button class="sort-btn" id="yt-signout-btn">Signed in ✓ · Sign out</button>` : ''}
    </div>
    ${moodHTML}
    ${signedIn ? '' : _ytConnectBanner()}
    ${eraHTML}
    <div id="explore-feed"><div class="yt-status">Loading recommendations…</div></div>
    ${discoveryHTML}
  </div>`)

  document.getElementById('explore-refresh-btn')?.addEventListener('click', () => {
    _ytHomeCache = null
    renderExplore()
  })
  document.getElementById('yt-signout-btn')?.addEventListener('click', async () => {
    await window.api.ytAuthSignOut().catch(() => {})
    _ytHomeCache = null
    renderExplore()
  })
  document.getElementById('yt-connect-btn')?.addEventListener('click', _startYtConnect)

  if (!_ytHomeCache) {
    const res = await window.api.ytHome().catch(e => ({ ok: false, error: String(e) }))
    if (state.currentPage !== 'explore') return
    if (!res.ok || !res.sections?.length) {
      const feed = document.getElementById('explore-feed')
      if (feed) feed.innerHTML = `<div class="yt-status yt-error">Couldn't load recommendations${res.error ? ': ' + esc(res.error) : ''}</div>`
      return
    }
    _ytHomeCache = res.sections
  }
  const feed = document.getElementById('explore-feed')
  if (!feed) return
  feed.innerHTML = _ytHomeCache.map((sec, si) => _exploreSection(sec, si)).join('')
  _bindExploreSections(feed, _ytHomeCache)
}

function _startYtConnect() {
  const banner = document.getElementById('yt-connect-banner')
  if (!banner) return
  banner.innerHTML = `<div class="yt-connect-text">
    <div class="yt-connect-title">Sign in to Google</div>
    <div class="yt-connect-sub" id="yt-connect-status">A Google sign-in window just opened — log in with your YouTube account there. This page updates automatically when you're done.</div>
  </div>`
  window.api.ytAuthStart().then(res => {
    _ytHomeCache = null
    if (res?.ok) {
      if (state.currentPage === 'explore') renderExplore()
      return
    }
    const el = document.getElementById('yt-connect-status')
    if (el) {
      el.innerHTML = `Sign-in didn't finish: ${esc(res?.error || 'unknown error')} <button class="yt-connect-btn" id="yt-connect-retry" style="margin-left:10px">Try again</button>`
      document.getElementById('yt-connect-retry')?.addEventListener('click', () => {
        if (state.currentPage === 'explore') renderExplore()
      })
    }
  })
}

// ── YT radio + autoplay ──────────────────────────────────────────────────────
async function startYtRadio(seed) {
  let vid = seed.videoId || null
  if (!vid) {
    const f = await window.api.ytFindVideo({ artist: seed.artist || '', title: seed.title || '' }).catch(() => null)
    vid = f?.ok ? f.videoId : null
  }
  if (!vid) return false
  const res = await window.api.ytRadio({ videoId: vid }).catch(() => null)
  if (!res?.ok || !res.tracks?.length) return false
  const seedItem = _ytQueueItem({
    videoId: vid, title: seed.title, artist: seed.artist,
    thumbnailUrl: seed.thumbnailUrl || null, duration: seed.duration || 0,
    album: seed.album || null,
  })
  state.queue = [seedItem, ...res.tracks.map(_ytQueueItem)]
  state.queueIndex = 0
  playCurrentTrack()
  if (state.queuePanelOpen) renderQueuePanel()
  return true
}

function autoplayEnabled() { return localStorage.getItem('autoplay') !== '0' }
function setAutoplay(on) { localStorage.setItem('autoplay', on ? '1' : '0') }

let _autoplayBusy = false
async function tryAutoplayContinue() {
  if (_autoplayBusy || !state.queue.length) return
  _autoplayBusy = true
  const last = state.queue[state.queue.length - 1]
  try {
    let vid = last.videoId || null
    if (!vid && isHttpPath(last.filePath)) vid = (last.filePath.match(/[?&]v=([\w-]{11})/) || [])[1] || null
    if (!vid) {
      const f = await window.api.ytFindVideo({ artist: last.albumArtist || last.artist || '', title: last.title || '' })
      vid = f?.ok ? f.videoId : null
    }
    if (!vid) throw new Error('no seed')
    const res = await window.api.ytRadio({ videoId: vid })
    if (!res?.ok || !res.tracks?.length) throw new Error('no radio')
    const have = new Set(state.queue.map(t => t.filePath))
    const fresh = res.tracks.map(_ytQueueItem).filter(t => !have.has(t.filePath))
    if (!fresh.length) throw new Error('nothing new')
    const at = state.queue.length
    state.queue.push(...fresh)
    state.queueIndex = at
    playCurrentTrack()
    if (state.queuePanelOpen) renderQueuePanel()
  } catch {
    audio.pause(); state.isPlaying = false; updatePlayBtn(); syncExtension()
  } finally {
    _autoplayBusy = false
  }
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
  const HOME_SECTIONS = 3
  el.innerHTML = _ytHomeCache.slice(0, HOME_SECTIONS).map((sec, si) => `
    <div class="section-header" style="margin-top:28px">
      <span class="section-title">${esc(sec.title)} <span class="yt-badge">YT</span></span>
      <button class="section-see-all" id="yt-home-explore-${si}">More in Explore</button>
    </div>
    ${sec.kind === 'songs'
      ? `<div class="yt-home-songs explore-song-grid" data-si="${si}">${_ytSongRows(sec.items)}</div>`
      : `<div class="scroll-row">${sec.items.map(sec.kind === 'playlists' ? _ytPlaylistCard : _ytAlbumCard).join('')}</div>`}
  `).join('')
  el.querySelectorAll('.yt-home-songs').forEach(box => {
    bindYtEvents(_ytHomeCache[parseInt(box.dataset.si)].items, box)
  })
  el.querySelectorAll('.yt-album-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-album', card.dataset.browse)
  }))
  el.querySelectorAll('.yt-playlist-card').forEach(card => card.addEventListener('click', () => {
    navigate('yt-playlist', card.dataset.playlist)
  }))
  el.querySelectorAll('[id^="yt-home-explore-"]').forEach(btn => btn.addEventListener('click', () => navigate('explore')))
}

function renderArtists() {
  const artistMap = new Map()
  for (const album of state.library) {
    // Group by the SAME rule the artist page and _artistAlbumCount() use
    // (artist OR albumArtist). Grouping on album.artist alone meant a card
    // could say "2 albums" and the page it opened say "5", and albums tagged
    // with a per-track artist but a proper albumArtist were filed under the
    // featured guest. A blank artist is bucketed rather than left as a dead,
    // unclickable card that still offered "Trash everything by this artist".
    const names = []
    if (album.artist && String(album.artist).trim()) names.push(album.artist)
    if (album.albumArtist && String(album.albumArtist).trim() && album.albumArtist !== album.artist) names.push(album.albumArtist)
    if (!names.length) names.push('Unknown Artist')
    for (const key of names) {
    if (!artistMap.has(key)) {
      artistMap.set(key, { name: key, albums: [], artPath: null })
    }
    const entry = artistMap.get(key)
    entry.albums.push(album)
    if (!entry.artPath && album.artPath) entry.artPath = album.artPath
    }
  }
  const artists = [...artistMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (!artists.length && !state.ytFollowed.length) { navigate('library'); return }

  setContent(`<div class="page">
    <div class="page-header">
      <h1 class="section-title" style="margin-bottom:20px">Artists</h1>
      <div class="library-search-wrap">
        <input class="library-search" id="artist-search" type="text" placeholder="Search artists…">
      </div>
    </div>
    <div class="artist-grid" id="artist-grid">${artists.map(ar => `
      <div class="artist-card" data-artist="${esc(ar.name)}" style="position:relative">
        <div class="artist-card-art">
          ${ar.artPath
            ? `<img src="${esc('file://' + ar.artPath)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="artist-card-art-fallback" ${ar.artPath ? 'style="display:none"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </div>
        </div>
        <div class="artist-card-name">${esc(ar.name)}<span style="font-size:10px;color:${state.followedArtists.indexOf(ar.name) !== -1 ? 'var(--accent)' : 'var(--text3)'}">${state.followedArtists.indexOf(ar.name) !== -1 ? ' Following' : ''}</span></div>
        <div class="artist-card-meta">${ar.albums.length} album${ar.albums.length !== 1 ? 's' : ''}</div>
        <button class="artist-play-btn" data-play-artist="${esc(ar.name)}" title="Play this artist" aria-label="Play this artist">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#000"><path d="M8 5v14l11-7z"/></svg>
        </button>
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

  // Surfaces that previously had no context menu at all.
  document.querySelectorAll('.artist-card[data-artist]').forEach(card => {
    if (card.dataset.channel) return   // YouTube artists have no local files
    card.addEventListener('contextmenu', e => {
      const artist = card.dataset.artist
      const albums = state.library.filter(a => a.artist === artist || a.albumArtist === artist)
      const paths = albums.flatMap(a => (a.tracks || []).map(t => t.filePath)).filter(Boolean)
      showContextMenu(e, { type: 'artist', kind: 'artist', artist, paths,
        label: artist + ' — ' + albums.length + ' album' + (albums.length === 1 ? '' : 's') })
    })
  })

  document.querySelectorAll('.quick-card[data-album]').forEach(card => {
    card.addEventListener('contextmenu', e => {
      const album = state.library.find(a => a.id === card.dataset.album)
      showContextMenu(e, { type: 'album', kind: 'album', albumId: card.dataset.album,
        artist: album && album.artist })
    })
  })

  document.querySelectorAll('.folder-tree-item[data-folder]').forEach(el => {
    el.addEventListener('contextmenu', e => {
      showContextMenu(e, { type: 'folder', kind: 'folder-node',
        paths: [el.dataset.folder], label: el.dataset.folder })
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

function saveLibPreset() {
  var name = prompt('Preset name:')
  if (!name) return
  var preset = {
    name: name,
    genre: state.libGenre,
    year: state.libYear,
    format: state.libFormat,
    decade: state.libDecade,
    likedOnly: state.libLikedOnly,
    sort: state.libSort,
    view: state.libView,
    // These three were missing, so a preset restored a different result set
    // than the one that was saved.
    surround: state.libSurround,
    folder: state.libFolder,
    search: state.libSearch,
  }
  var existing = _libPresets.findIndex(function(p) { return p.name === name })
  if (existing !== -1 && !confirm('A preset named "' + name + '" already exists. Replace it?')) return
  if (existing !== -1) _libPresets[existing] = preset
  else _libPresets.push(preset)
  localStorage.setItem('papa-lib-presets', JSON.stringify(_libPresets))
  showSnackbar('Preset "' + name + (existing !== -1 ? '" replaced' : '" saved'))
  renderLibrary()
}

function loadLibPreset(name) {
  var preset = _libPresets.find(function(p) { return p.name === name })
  if (!preset) return
  state.libGenre = preset.genre
  state.libYear = preset.year
  state.libFormat = preset.format
  state.libDecade = preset.decade
  state.libLikedOnly = preset.likedOnly
  state.libSort = preset.sort
  state.libView = preset.view
  // Restored explicitly, including when absent from an older preset -- leaving
  // a stale surround/folder/search filter applied made the preset look broken.
  state.libSurround = preset.surround || ''
  state.libFolder = preset.folder || null
  state.libSearch = preset.search || ''
  renderLibrary()
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
    if (state.libYear) albums = albums.filter(a => String(a.year) === state.libYear)
    // Judge by ALL tracks, not tracks[0]. A mixed album (e.g. 18 tracks where
    // the first is mp3 and the rest flac) was classified by one file, so the
    // FLAC filter hid albums that genuinely contain FLAC.
    if (state.libFormat) albums = albums.filter(function(a) {
      return (a.tracks || []).some(function(t) {
        return t.filePath && t.filePath.toLowerCase().endsWith('.' + state.libFormat)
      })
    })
    if (state.libDecade) { var d = parseInt(state.libDecade); albums = albums.filter(function(a) { return a.year >= d && a.year < d + 10 }) }
    if (state.libFolder) albums = albums.filter(function(a) { return _inFolder(a, state.libFolder) })
    // Surround filter. Channel counts come from the scanner (ffprobe-backed for
    // the container formats the tag parser gets wrong), so this filters on what
    // the files ARE, not on what their folder names claim.
    if (state.libSurround) {
      albums = albums.filter(function(a) {
        var ch = a.maxChannels || 0
        switch (state.libSurround) {
          case 'any':    return ch >= 4
          case 'atmos':  return !!a.atmos
          case '71':     return ch >= 8
          case '51':     return ch >= 6 && ch < 8
          case 'quad':   return ch >= 4 && ch < 6
          case 'stereo': return ch > 0 && ch < 4
          default:       return true
        }
      })
    }
    var searchQ = state.libSearch || ''
    if (searchQ) { var sq = searchQ.toLowerCase(); albums = albums.filter(function(a) { return (a.name && a.name.toLowerCase().indexOf(sq) !== -1) || (a.artist && a.artist.toLowerCase().indexOf(sq) !== -1) }) }
    if (state.libSort === 'alpha')  return albums.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    if (state.libSort === 'artist') return albums.sort((a, b) => String(a.artist || '').localeCompare(String(b.artist || '')))
    if (state.libSort === 'year')   return albums.sort((a, b) => (b.year || 0) - (a.year || 0))
    if (state.libSort === 'recent') {
      // One rank lookup per album instead of two indexOf() calls per comparison,
      // and the un-played tail keeps a stable alphabetical order rather than
      // whatever the comparator happened to leave behind.
      var rank = {}
      state.recentlyPlayed.forEach(function (rid, n) { if (rank[rid] === undefined) rank[rid] = n })
      var played = albums.filter(function (a) { return rank[a.id] !== undefined })
        .sort(function (a, b) { return rank[a.id] - rank[b.id] })
      var rest = albums.filter(function (a) { return rank[a.id] === undefined })
        .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')) })
      return played.concat(rest)
    }
    if (state.libSort === 'added') return albums.filter(a => a.addedAt).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).concat(albums.filter(a => !a.addedAt).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))))
    if (state.libSort === 'genre') return albums.sort((a, b) => (a.genre || 'zzz').localeCompare(b.genre || 'zzz'))
    // Most channels first, Atmos ahead of plain 5.1 at the same count.
    if (state.libSort === 'channels') return albums.sort(function(a, b) {
      var d = (b.maxChannels || 0) - (a.maxChannels || 0)
      if (d) return d
      var at = (b.atmos ? 1 : 0) - (a.atmos ? 1 : 0)
      return at || a.name.localeCompare(b.name)
    })
    return albums
  }

  var sortedAlbums = getSorted()
  var fmtCounts = { flac: 0, mp3: 0, other: 0 }
  // Counted per album over ALL its tracks, so a mixed album is reported under
  // every format it actually contains rather than whichever happened to be
  // first. The buckets can therefore overlap, which is the honest answer.
  sortedAlbums.forEach(function(a) {
    var seen = {}
    ;(a.tracks || []).forEach(function(t) {
      if (!t.filePath) return
      var ext = t.filePath.split('.').pop().toLowerCase()
      seen[ext === 'flac' ? 'flac' : ext === 'mp3' ? 'mp3' : 'other'] = true
    })
    if (seen.flac) fmtCounts.flac++
    if (seen.mp3) fmtCounts.mp3++
    if (seen.other) fmtCounts.other++
  })
  var fmtBreak = '<span style="font-size:11px;color:var(--text3);margin-left:12px">' + fmtCounts.flac + ' FLAC, ' + fmtCounts.mp3 + ' MP3, ' + fmtCounts.other + ' other</span>'

  const sortBtns = [
    { key: 'alpha', label: 'A–Z' },
    { key: 'artist', label: 'Artist' },
    { key: 'year', label: 'Year' },
    { key: 'genre', label: 'Genre' },
    { key: 'channels', label: 'Channels' },
    { key: 'recent', label: 'Recently played' },
    { key: 'added', label: 'Recently added' },
  ].map(s => `<button class="sort-btn${state.libSort === s.key ? ' active' : ''}" data-sort="${s.key}">${s.label}</button>`).join('')

  var viewToggle = `<button class="sort-btn${state.libView === 'folders' ? ' active' : ''}" id="lib-view-folders" title="${state.libView === 'folders' ? 'Back to the album grid' : 'Browse by folder'}" aria-pressed="${state.libView === 'folders'}">${state.libView === 'folders' ? '▦ Grid' : '📁 Folders'}</button>`
  var likedBtn = `<button class="sort-btn${state.libLikedOnly ? ' active' : ''}" id="liked-filter-btn" style="margin-left:auto">♥ Liked only</button>`

  const genres = [...new Set(state.library.map(a => a.genre).filter(Boolean))].sort()
  const genreChips = genres.length ? `<div class="genre-chip-bar">
    <button class="genre-chip${!state.libGenre ? ' active' : ''}" data-genre="">All</button>
    ${genres.map(g => `<button class="genre-chip${state.libGenre === g ? ' active' : ''}" data-genre="${esc(g)}" title="${state.library.filter(function(a){return a.genre===g}).length} albums in your library — Alt-click to play a random one">${esc(g)}</button>`).join('')}
  </div>` : ''

  // This list and the Reset handler must stay in step. They had drifted:
  // genre was COUNTED but never cleared (Reset left the badge showing "1 filter
  // active" and the grid still filtered), while surround was cleared but never
  // counted (an active surround filter showed no badge at all).
  var activeFilterCount = 0
  if (state.libGenre) activeFilterCount++
  if (state.libYear) activeFilterCount++
  if (state.libFormat) activeFilterCount++
  if (state.libDecade) activeFilterCount++
  if (state.libSurround) activeFilterCount++
  if (state.libFolder) activeFilterCount++
  if (state.libLikedOnly) activeFilterCount++
  if (state.libSearch) activeFilterCount++
  var filterBadge = activeFilterCount > 0 ? '<span style="display:inline-block;margin-left:8px;padding:2px 8px;background:var(--accent);color:#000;border-radius:100px;font-size:11px;font-weight:600">' + activeFilterCount + ' filter' + (activeFilterCount > 1 ? 's' : '') + ' active</span>' : ''

  var filterIndicator = ''
  if (state.libDecade) filterIndicator = '<div style="display:inline-flex;align-items:center;gap:6px;margin-left:12px;padding:3px 10px;background:var(--accent);color:#000;border-radius:100px;font-size:11px;font-weight:600">' + state.libDecade + 's<button style="background:none;border:none;color:#000;cursor:pointer;font-size:14px;line-height:1" id="clear-decade-filter">&times;</button></div>'

  // Folder membership: an album belongs to every directory that holds ANY of
  // its tracks, so a multi-disc album stored as Album/CD1 + Album/CD2 is no
  // longer attributed entirely to CD1. Matching is boundary-aware -- a bare
  // prefix test made /music/Rock also match /music/Rockabilly.
  function _albumFolders(a) {
    var out = {}
    ;(a.tracks || []).forEach(function (t) {
      if (!t.filePath) return
      var parts = t.filePath.split('/'); parts.pop()
      var dir = parts.join('/')
      if (dir) out[dir] = true
    })
    return Object.keys(out)
  }
  function _inFolder(a, folder) {
    var pre = String(folder).replace(/\/+$/, '') + '/'
    return (a.tracks || []).some(function (t) {
      return t.filePath && (t.filePath.indexOf(pre) === 0)
    })
  }

  function buildFolderTree() {
    // Built from the FILTERED set, so a folder's count matches what clicking it
    // actually shows. It used to be built from the whole library, so with a
    // genre filter on a folder could claim "37 albums" and open showing 2.
    var scope = sortedAlbums
    var folders = [...new Set([].concat.apply([], scope.map(_albumFolders)))].sort()

    if (state.libFolder) {
      var folderBreadcrumb = '<div class="folder-breadcrumb" id="folder-back-btn" tabindex="0" role="button"><span class="folder-back-arrow">←</span> Back to folders</div>'
      return folderBreadcrumb + (sortedAlbums.length
        ? '<div class="album-grid" id="lib-grid">' + sortedAlbums.map(function(a, i) { return albumCard(a, i, state.libSort) }).join('') + '</div>'
        : '<div class="empty-wrap"><h2>Nothing here</h2><p>No albums in this folder match your filters.</p></div>')
    }

    if (!folders.length) {
      return '<div class="empty-wrap"><h2>No folders match</h2><p>Try clearing a filter or two.</p></div>'
    }

    return '<div class="folder-tree">' + folders.map(function(f) {
      var name = f.split('/').pop() || f
      var count = scope.filter(function(a) { return _inFolder(a, f) }).length
      return '<div class="folder-tree-item" data-folder="' + esc(f) + '"><span class="folder-icon">📁</span><span class="folder-name">' + esc(name) + '</span><span class="folder-count">' + count + ' albums</span></div>'
    }).join('') + '</div>'
  }

  var totalTrackCount = 0, totalLibDur = 0, flacCount = 0, hiresCount = 0
  state.library.forEach(function(a) {
    if (a.tracks) {
      totalTrackCount += a.tracks.length
      a.tracks.forEach(function(t) {
        totalLibDur += t.duration || 0
        if (t.filePath && t.filePath.toLowerCase().endsWith('.flac')) flacCount++
        if (t.bitsPerSample >= 24 || t.sampleRate >= 96000) hiresCount++
      })
    }
  })
  // This used to be a SECOND full library x tracks loop immediately after the
  // one above, over exactly the same data. Merged; `filteredSize` is what the
  // header shows, because reporting the whole library's size next to a filtered
  // grid put two numbers that disagreed on the same line.
  var totalSize = 0, formatCounts = {}
  state.library.forEach(function(a) {
    if (!a.tracks) return
    a.tracks.forEach(function(t) {
      totalSize += (t.fileSize || t.size || 0)
      var ext = (t.filePath || '').toLowerCase().split('.').pop() || 'other'
      formatCounts[ext] = (formatCounts[ext] || 0) + 1
    })
  })
  var filteredSize = 0
  sortedAlbums.forEach(function(a) {
    ;(a.tracks || []).forEach(function(t) { filteredSize += (t.fileSize || t.size || 0) })
  })
  var fmtPcts = Object.keys(formatCounts).sort(function(a, b) { return (formatCounts[b] || 0) - (formatCounts[a] || 0) })
  var fmtBreakdownHTML = ''
  if (fmtPcts.length > 0 && totalTrackCount > 0) {
    fmtBreakdownHTML = '<div style="padding:0 28px 20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<span style="font-size:12px;color:var(--text3);font-weight:600">Formats:</span>' +
      fmtPcts.map(function(fmt) {
        var pct = Math.round(formatCounts[fmt] / totalTrackCount * 100)
        return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text2);background:var(--bg3);padding:3px 8px;border-radius:6px">' + fmt.toUpperCase() + ' <strong>' + pct + '%</strong></span>'
      }).join('') + '</div>'
  }
  var summaryHTML = '<div class="section-header"><span class="section-title">Library Stats</span></div><div style="display:flex;gap:12px;padding:0 28px 20px;flex-wrap:wrap">' +
    '<div class="liked-stat"><div class="liked-stat-val">' + state.library.length + '</div><div class="liked-stat-lbl">Albums</div></div>' +
    '<div class="liked-stat"><div class="liked-stat-val">' + totalTrackCount + '</div><div class="liked-stat-lbl">Tracks</div></div>' +
    '<div class="liked-stat"><div class="liked-stat-val">' + fmtDur(totalLibDur) + '</div><div class="liked-stat-lbl">Duration</div></div>' +
    '<div class="liked-stat"><div class="liked-stat-val">' + _fmtBytes(totalSize) + '</div><div class="liked-stat-lbl">Storage</div></div>' +
    '<div class="liked-stat"><div class="liked-stat-val">' + flacCount + '</div><div class="liked-stat-lbl">FLAC</div></div>' +
    '<div class="liked-stat"><div class="liked-stat-val">' + hiresCount + '</div><div class="liked-stat-lbl">Hi-Res</div></div>' +
    '</div>' + fmtBreakdownHTML

  setContent(`<div class="page">
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <h1 class="section-title">Your Library</h1>
        <span class="lib-count">${sortedAlbums.length === (state.library.length + state.ytSavedAlbums.length)
          ? sortedAlbums.length + ' albums'
          : sortedAlbums.length + ' of ' + (state.library.length + state.ytSavedAlbums.length) + ' albums'}</span><span class="lib-count" style="margin-left:8px">${_fmtBytes(filteredSize)}</span>${filterBadge}${fmtBreak}${filterIndicator}
        <button class="rescan-btn" id="lib-rescan-btn" title="Rescan music folders">
          <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
          Rescan
        </button>
      </div>
      <div class="library-search-wrap">
        <input class="library-search" id="lib-search" type="text" placeholder="Search albums or artists…" value="${esc(state.libSearch || '')}">
      </div>
      <div class="sort-bar">${sortBtns}${viewToggle}${likedBtn}</div>
      ${genreChips}
      <div class="lib-advanced-bar">
        <select class="lib-select" id="lib-year-filter" title="Filter by release year"><option value="">Year: All</option>${(()=>{var y=[...new Set(state.library.map(function(a){return a.year}).filter(Boolean))].sort(function(a,b){return a-b});return y.map(function(v){return '<option value="'+esc(v)+'"'+(String(state.libYear)===String(v)?' selected':'')+'>'+esc(v)+'</option>'}).join('')})()}</select>
        <select class="lib-select" id="lib-format-filter"><option value="">Format: All</option>${(()=>{var f=[...new Set([].concat.apply([], state.library.map(function(a){return (a.tracks||[]).map(function(t){return t.filePath?t.filePath.split('.').pop().toLowerCase():null})})).filter(Boolean))].sort();return f.map(function(v){return '<option value="'+esc(v)+'"'+(state.libFormat===v?' selected':'')+'>'+esc(v).toUpperCase()+'</option>'}).join('')})()}</select>
        <select class="lib-select" id="lib-decade-filter"><option value="">Decade: All</option><option value="1950"${state.libDecade==='1950'?' selected':''}>1950s</option><option value="1960"${state.libDecade==='1960'?' selected':''}>1960s</option><option value="1970"${state.libDecade==='1970'?' selected':''}>1970s</option><option value="1980"${state.libDecade==='1980'?' selected':''}>1980s</option><option value="1990"${state.libDecade==='1990'?' selected':''}>1990s</option><option value="2000"${state.libDecade==='2000'?' selected':''}>2000s</option><option value="2010"${state.libDecade==='2010'?' selected':''}>2010s</option><option value="2020"${state.libDecade==='2020'?' selected':''}>2020s</option></select>
        <select class="lib-select" id="lib-surround-filter" title="Filter by how many channels the files actually have">
          ${(() => {
            const lib = state.library
            const n = (f) => lib.filter(f).length
            const opts = [
              ['',       'Surround: All',      lib.length],
              ['any',    'Any surround',       n(a => (a.maxChannels || 0) >= 4)],
              ['atmos',  'Dolby Atmos',        n(a => a.atmos)],
              ['71',     '7.1',                n(a => (a.maxChannels || 0) >= 8)],
              ['51',     '5.1',                n(a => (a.maxChannels || 0) >= 6 && (a.maxChannels || 0) < 8)],
              ['quad',   'Quad / 4.0',         n(a => (a.maxChannels || 0) >= 4 && (a.maxChannels || 0) < 6)],
              ['stereo', 'Stereo only',        n(a => (a.maxChannels || 0) > 0 && (a.maxChannels || 0) < 4)],
            ]
            return opts.filter(o => o[0] === '' || o[2] > 0)
              .map(o => `<option value="${o[0]}"${state.libSurround === o[0] ? ' selected' : ''}>${o[1]} (${o[2]})</option>`)
              .join('')
          })()}
        </select>
        <button class="lib-reset-btn" id="lib-reset-filters">Reset</button>
        <button class="lib-reset-btn" id="lib-save-preset" style="margin-left:12px">💾 Save preset</button>
        ${_libPresets.length > 0 ? '<select class="lib-select" id="lib-preset-select" style="margin-left:8px"><option value="">Load preset…</option>' + _libPresets.map(function(p) { return '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>' }).join('') + '</select>' +
          // This button used to be emitted BEFORE </select>. A <select> may only
          // contain <option>/<optgroup>, so the parser discarded it: presets
          // could never be deleted and both handlers below were dead code.
          '<button class="lib-reset-btn" id="lib-delete-preset" title="Delete the selected preset" aria-label="Delete the selected preset" style="display:none;margin-left:4px">✕</button>' : ''}
      </div>
    </div>
    ${state.libView === 'folders' ? buildFolderTree() : (sortedAlbums.length ? `<div class="album-grid" id="lib-grid">${sortedAlbums.map(function(a, i) { return albumCard(a, i, state.libSort) }).join('')}</div>` : `<div class="empty-wrap"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg><h2>No albums match</h2><p>${activeFilterCount ? 'Try clearing a filter or two.' : 'Your library is empty. Add a music folder to get started.'}</p>${activeFilterCount ? '<button class="lib-reset-btn" id="lib-empty-reset">Clear all filters</button>' : ''}</div>`)}
    ${summaryHTML}
  </div>`)

  // NOTE: there used to be a second, immediate `input` handler here that
  // rewrote #lib-grid directly. Its arrow function was mis-closed, so
  // bindContentEvents() -- and a #results-filter binding belonging to
  // renderSearch() -- sat INSIDE the callback. Every keystroke therefore
  // re-bound every card, row and nav element in the page: after typing 8
  // characters one click on an album fired navigate() nine times and Back
  // needed nine presses. It also meant the Search page's "Filter results…"
  // box was only ever bound by typing in the LIBRARY search box, i.e. never.
  // The debounced handler below is the single owner of this input now; the
  // #results-filter binding moved to bindContentEvents() where it belongs.

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
    btn.addEventListener('click', e => {
      // The random-play shortcut used to be on dblclick, which could never fire:
      // this click handler re-renders and replaces the chip node, so the second
      // click landed on a different element. Alt/Cmd-click is one event, so it
      // survives -- and the chip's title now says so.
      var genre = btn.dataset.genre
      if ((e.altKey || e.metaKey) && genre) {
        e.preventDefault()
        var albums = state.library.filter(function(a) { return a.genre === genre })
        if (!albums.length) return
        playAlbum(albums[Math.floor(Math.random() * albums.length)], 0)
        return
      }
      state.libGenre = genre || null
      renderLibrary()
    })
  })

  document.getElementById('lib-rescan-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('lib-rescan-btn')
    if (!btn) return
    btn.disabled = true
    btn.innerHTML = '<svg viewBox="0 0 24 24" style="animation:dl2Spin 1s linear infinite"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg> Scanning…'
    try {
      const data = await window.api.scanLibrary()
      state.library = data.albums || []
      // The delete path prunes orphaned album likes; a rescan replaced the whole
      // library without doing so, leaving ids that match nothing -- "Liked only"
      // then claims N liked albums and renders fewer, with nothing to click.
      // Only prune when the scan actually returned a library, so an empty or
      // failed scan (unplugged drive) can never wipe every like.
      if (state.library.length) {
        var known = {}
        state.library.forEach(function (a) { known[a.id] = true })
        var keep = state.likedAlbums.filter(function (id) { return known[id] || /^pl_/.test(id) })
        if (keep.length !== state.likedAlbums.length) {
          state.likedAlbums = keep
          window.api.saveLiked(keep)
        }
      }
      // Don't yank the user back to Library if they navigated away mid-scan.
      if (state.currentPage === 'library') renderLibrary()
      syncLibraryExt()
      showSnackbar('Library scan complete: ' + state.library.length + ' albums found')
    } catch (err) {
      // Unguarded, a failed scan (unplugged drive, permission error) left the
      // button disabled and spinning with no message and no way to retry.
      showSnackbar('Library scan failed' + (err && err.message ? ' — ' + err.message : ''))
    } finally {
      var again = document.getElementById('lib-rescan-btn')
      if (again) { again.disabled = false }
    }
  })

  document.getElementById('lib-year-filter')?.addEventListener('change', function() { state.libYear = this.value; renderLibrary() })
  document.getElementById('lib-format-filter')?.addEventListener('change', function() { state.libFormat = this.value; renderLibrary() })
  document.getElementById('lib-decade-filter')?.addEventListener('change', function() { state.libDecade = this.value; renderLibrary() })
  document.getElementById('lib-surround-filter')?.addEventListener('change', function() { state.libSurround = this.value; renderLibrary() })
  document.getElementById('lib-empty-reset')?.addEventListener('click', function() {
    state.libYear = ''; state.libFormat = ''; state.libDecade = ''; state.libSurround = ''
    state.libGenre = null; state.libFolder = null; state.libLikedOnly = false; state.libSearch = ''
    renderLibrary()
  })
  document.getElementById('lib-reset-filters')?.addEventListener('click', function() {
    state.libYear = ''; state.libFormat = ''; state.libDecade = ''; state.libSurround = ''
    state.libGenre = null; state.libFolder = null; state.libLikedOnly = false; state.libSearch = ''
    renderLibrary()
  })
  document.getElementById('lib-save-preset')?.addEventListener('click', function() { saveLibPreset() })
  document.getElementById('lib-preset-select')?.addEventListener('change', function() { var v = this.value; var d = document.getElementById('lib-delete-preset'); if (d) d.style.display = v ? 'inline-block' : 'none'; if (v) loadLibPreset(v) })
  document.getElementById('lib-delete-preset')?.addEventListener('click', function() { var sel = document.getElementById('lib-preset-select'); var v = sel && sel.value; if (v && confirm('Delete preset "' + v + '"?')) { _libPresets = _libPresets.filter(function(p) { return p.name !== v }); localStorage.setItem('papa-lib-presets', JSON.stringify(_libPresets)); showSnackbar('Preset "' + v + '" deleted'); renderLibrary() } })
  document.getElementById('lib-view-folders')?.addEventListener('click', function() {
    state.libView = state.libView === 'folders' ? 'grid' : 'folders'
    state.libFolder = null
    renderLibrary()
  })
  document.querySelectorAll('.folder-tree-item').forEach(function(item) {
    item.addEventListener('click', function() {
      state.libFolder = item.dataset.folder
      renderLibrary()
    })
  })
  document.getElementById('folder-back-btn')?.addEventListener('click', function() {
    state.libFolder = null
    renderLibrary()
  })
  var libSearch = document.getElementById('lib-search')
  if (libSearch) {
    var searchTimeout
    libSearch.addEventListener('input', function() {
      state.libSearch = this.value
      clearTimeout(searchTimeout)
      searchTimeout = setTimeout(function () {
        // setContent() replaces the input, so carry focus and caret across or
        // the box silently stops accepting keystrokes mid-word.
        var was = document.getElementById('lib-search')
        var hadFocus = document.activeElement === was
        var caret = was ? was.selectionStart : null
        renderLibrary()
        if (!hadFocus) return
        var now = document.getElementById('lib-search')
        if (!now) return
        now.focus()
        if (caret != null) { try { now.setSelectionRange(caret, caret) } catch (_) {} }
      }, 150)
    })
  }
}

function editField(field, currentValue, callback) {
  var newVal = prompt('Edit ' + field + ':', currentValue)
  if (newVal && newVal !== currentValue) {
    callback(newVal)
    showSnackbar(field + ' updated (visual only — save to file coming soon)')
  }
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
      <div class="track-row ${isPlaying ? 'playing' : ''}" data-file="${esc(t.filePath)}" data-idx="${i}" data-album="${esc(albumId)}" data-no-album-nav="1">
        <span class="track-num">${isPlaying
          ? '<div class="playing-bars"><span></span><span></span><span></span></div>'
          : (t.trackNumber || i + 1)}</span>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}${t.explicit ? '<span class="track-explicit">E</span>' : ''}${surroundBadge(t.channels)}</div>
          <div class="track-artist" data-artist="${esc(t.artist || album.artist)}">${esc(t.artist || album.artist)}${t.bpm ? `<span class="track-bpm">${t.bpm} BPM</span>` : ''}</div>
        </div>
        ${plays > 0 ? `<span class="track-plays">${plays}</span>` : '<span class="track-plays"></span>'}
        <button class="track-like-btn ${tLiked ? 'liked' : ''}" data-like="${esc(t.filePath)}" title="${tLiked ? 'Unlike' : 'Like'}">${tLiked ? '♥' : '♡'}</button>
        <div class="hover-actions">
          <button class="hover-action-btn" data-action="playnext" data-file="${esc(t.filePath)}" data-album="${esc(albumId)}" title="Play next">&#9654;+</button>
          <button class="hover-action-btn" data-action="queue" data-file="${esc(t.filePath)}" data-album="${esc(albumId)}" title="Add to queue">+</button>
        </div>
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
      <img class="album-hero-art" src="${album.artPath ? esc('file://' + album.artPath) : ''}" alt="" ${!album.artPath ? 'style="display:none"' : ''} onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="album-hero-art-fallback" ${album.artPath ? 'style="display:none"' : ''}><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Album</div>
        <div class="album-hero-title">${esc(album.name)}</div>
        <div class="album-hero-meta">
          <span class="hero-artist clickable-meta" data-artist="${esc(album.artist)}">${esc(album.artist)}</span>
          &bull; <span class="hero-year clickable-meta">${esc(album.year || '')}</span> &bull; ${album.tracks.length} songs, ${fmtTime(totalDur)}
          ${album.isHiRes ? `&bull; <span class="hero-hires-badge">${fmtSpec(album.maxBitsPerSample, album.maxSampleRate)}</span>` : ''}
          ${formatBadgeHtml(album, 'hero-surround') ? `&bull; ${formatBadgeHtml(album, 'hero-surround')}` : ''}
          ${album.genre ? `&bull; <span class="genre-badge">${esc(album.genre)}</span>` : ''}
          ${drBadge(computeAlbumDR(album)) ? `&bull; ${drBadge(computeAlbumDR(album))}` : ''}
        </div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="album-play-btn" aria-label="Play this album">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn album-shuffle-btn" id="album-shuffle-btn" title="Shuffle play">
        <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
      </button>
      <button class="ctrl-btn album-like-btn like-btn ${isLiked ? 'liked' : ''}" id="album-like-btn" data-album="${esc(albumId)}" title="${isLiked ? 'Unlike' : 'Like'}">
        <svg class="heart-outline" viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09A5.99 5.99 0 0 0 7.5 3C4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>
        <svg class="heart-filled" viewBox="0 0 24 24" style="display:none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
      <button class="ctrl-btn album-addpl-btn" id="album-addpl-btn" title="Add album to playlist">
        <svg viewBox="0 0 24 24"><path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm14-2v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z"/></svg>
      </button>
    </div>
    <div class="stars-row">${(() => {
      var r = state.albumRatings[albumId] || 0
      var s = ''
      for (var i = 1; i <= 5; i++) {
        s += '<button class="star-btn' + (i <= r ? ' active' : '') + '" data-star="' + i + '">' + (i <= r ? '★' : '☆') + '</button>'
      }
      return s
    })()}</div>
    <div class="album-notes${state.albumNotes[albumId] ? '' : ' empty'}">${state.albumNotes[albumId] ? esc(state.albumNotes[albumId]) : 'Add notes...'}</div>
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

  // Clicking a track row now plays that track. Previously the only row handler
  // was the generic one in bindContentEvents(), whose data-album pointed at the
  // album you were already on -- so a click silently re-rendered the page,
  // jumped the scroll to the top and pushed a duplicate history entry, and
  // nothing played.
  document.querySelectorAll('#content .track-row[data-idx]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('.track-more-btn, .track-like-btn, .hover-actions, [data-action]')) return
      if (typeof _selHandleClick === 'function' && _selHandleClick(e, row)) return
      var idx = parseInt(row.dataset.idx, 10)
      if (!Number.isInteger(idx) || !album.tracks[idx]) return
      playAlbum(album, idx)
    })
  })

  document.getElementById('album-play-btn')?.addEventListener('click', () => playAlbum(album, 0))
  document.getElementById('album-shuffle-btn')?.addEventListener('click', function() {
    var tracks = album.tracks.slice().sort(function() { return Math.random() - 0.5 })
    tracks = tracks.map(function(t) { return Object.assign({}, t, { albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }) })
    state.queue = tracks
    state.queueIndex = 0
    _oldQueue = null
    window.api.saveRecentlyPlayed(album.id)
    state.recentlyPlayed = [album.id, ...state.recentlyPlayed.filter(x => x !== album.id)].slice(0, 20)
    playCurrentTrack()
    showSnackbar('Shuffling ' + tracks.length + ' tracks')
  })
  document.getElementById('album-like-btn')?.addEventListener('click', () => toggleLike(albumId))
  document.getElementById('album-addpl-btn')?.addEventListener('click', () => {
    showAddToPlaylistModal(album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name })))
  })
  document.querySelector('.section-see-all[data-artist]')?.addEventListener('click', e => {
    navigate('artist', e.currentTarget.dataset.artist)
  })
  wireTrackLikeButtons()
  renderAlbumCredits(album)

  if (!document.getElementById('album-notes-css')) {
    var style = document.createElement('style')
    style.id = 'album-notes-css'
    style.textContent = '.star-btn { background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:2px } .star-btn.active { color:#c4a747 } .stars-row { margin:8px 0;padding:0 24px } .album-notes { font-size:12px;color:var(--text2);margin:8px 24px;cursor:pointer;font-style:italic } .album-notes.empty { color:var(--text3) }'
    document.head.appendChild(style)
  }

  document.querySelectorAll('.star-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var star = parseInt(btn.dataset.star)
      state.albumRatings[albumId] = star
      localStorage.setItem('papa-album-ratings', JSON.stringify(state.albumRatings))
      renderAlbum(albumId)
    })
  })

  var notesEl = document.querySelector('.album-notes')
  if (notesEl) notesEl.addEventListener('click', function() {
    var existing = state.albumNotes[albumId] || ''
    var note = prompt('Notes for ' + album.name + ':', existing)
    if (note !== null) {
      state.albumNotes[albumId] = note
      localStorage.setItem('papa-album-notes', JSON.stringify(state.albumNotes))
      renderAlbum(albumId)
    }
  })

  document.querySelector('.album-hero-title')?.addEventListener('click', () => {
    editField('Album title', album.name, function(v) { album.name = v; renderAlbum(albumId) })
  })
  document.querySelector('.hero-artist')?.addEventListener('click', e => {
    e.stopPropagation()
    editField('Artist', album.artist, function(v) { album.artist = v; renderAlbum(albumId) })
  })
  document.querySelector('.hero-year')?.addEventListener('click', e => {
    e.stopPropagation()
    editField('Year', String(album.year || ''), function(v) {
      // Was `parseInt(v, 10) || v`, which kept arbitrary text on non-numeric
      // input and fed it to two unescaped sinks. A year is a number or nothing.
      var yr = parseInt(v, 10)
      if (!Number.isInteger(yr) || yr < 1 || yr > 9999) { showSnackbar('Year must be a number'); return }
      album.year = yr
      renderAlbum(albumId)
    })
  })

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
    album.year     ? `<div class="credit-item"><div class="credit-role">Released</div><div class="credit-name">${esc(album.year)}</div></div>` : '',
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

function wireTrackLikeButtons(root) {
  // Document-wide and called from BOTH renderAlbum and renderQueuePanel -- and
  // the queue panel re-renders on every track change. Playing five tracks with
  // an album page open left its hearts with six handlers each, so one click
  // toggled the like six times and an even count looked like nothing happened.
  // Elements are recreated on re-render, so a per-element marker is enough.
  ;(root || document).querySelectorAll('.track-like-btn[data-like]').forEach(btn => {
    if (btn._likeBound) return
    btn._likeBound = true
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
  if (liked) {
    var likeHistory = JSON.parse(localStorage.getItem('papa_like_history') || '[]')
    likeHistory.push({ path: filePath, ts: Date.now() })
    if (likeHistory.length > 500) likeHistory = likeHistory.slice(-500)
    localStorage.setItem('papa_like_history', JSON.stringify(likeHistory))
  }
  if (!liked) {
    var fp = filePath
    showSnackbar('Removed from Liked Songs', 'Undo', function() {
      state.likedTracks.push(fp)
      window.api.saveLikedTracks(state.likedTracks)
      navigate(state.currentPage, _currentNavId(), { skipHistory: true })
    })
  }
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
  // " " is truthy but means nothing: it used to fall through to the results
  // path where the needle became '' and String.includes('') matched the entire
  // library, presenting it as search results.
  if (typeof query === 'string' && !query.trim()) query = ''
  query = (query || '').normalize('NFC')
  if (!query) {
    // Genre browse landing
    const libGenres = [...new Set(state.library.map(a => a.genre).filter(Boolean))]
    const displayGenres = libGenres.length > 0 ? libGenres : Object.keys(GENRE_COLORS)
    const tiles = displayGenres.slice(0, 20).map(g => {
      const bg = GENRE_COLORS[g] || `linear-gradient(135deg,hsl(${Math.abs(g.charCodeAt(0)*7)%360},55%,28%),hsl(${Math.abs(g.charCodeAt(0)*7+40)%360},45%,18%))`
      return `<div class="genre-tile" style="background:${bg}" data-genre="${esc(g)}">${esc(g)}</div>`
    }).join('')
    var surpriseStyle = document.getElementById('surprise-style')
    if (!surpriseStyle) {
      surpriseStyle = document.createElement('style')
      surpriseStyle.id = 'surprise-style'
      surpriseStyle.textContent = '.surprise-btn{padding:12px 32px;border-radius:100px;background:linear-gradient(135deg,var(--accent),#1db954);border:none;color:#000;font-size:16px;font-weight:600;cursor:pointer;transition:transform .15s,box-shadow .15s}.surprise-btn:hover{transform:scale(1.05);box-shadow:0 4px 16px rgba(29,185,84,.3)}'
      document.head.appendChild(surpriseStyle)
    }
    var recentSearches = []
  try {
    var _hist = JSON.parse(localStorage.getItem('pa_search_history') || '[]')
    if (Array.isArray(_hist)) recentSearches = _hist.filter(function (h) { return typeof h === 'string' && h }).slice(0, 6)
  } catch (_) {}
    var recentHTML = ''
    if (recentSearches.length) {
      var css = '.recent-search-card{flex:0 0 140px;height:100px;border-radius:var(--r);cursor:pointer;transition:transform .15s}.recent-search-card:hover{transform:scale(1.03)}'
      var recentStyleEl = document.getElementById('recent-search-style')
      if (!recentStyleEl) {
        recentStyleEl = document.createElement('style')
        recentStyleEl.id = 'recent-search-style'
        recentStyleEl.textContent = css
        document.head.appendChild(recentStyleEl)
      }
      recentHTML = '<div class="section-header"><span class="section-title">Recently searched</span></div>'
      recentHTML += '<div class="scroll-row">'
      recentSearches.forEach(function(h) {
        var q = typeof h === 'string' ? h : h.query
        recentHTML += '<div class="recent-search-card" data-query="' + esc(q) + '">' +
          '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:var(--bg3);border-radius:var(--r)">' +
          '<svg viewBox="0 0 24 24" style="width:24px;height:24px;fill:var(--text3)"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
          '<div style="font-size:13px;font-weight:600;text-align:center;padding:0 8px">' + esc(q) + '</div>' +
          '</div></div>'
      })
      recentHTML += '</div>'
    }
    setContent(`<div class="page">
      <div style="text-align:center;padding:20px 0"><button class="surprise-btn" id="surprise-btn">🎲 Surprise me</button></div>
      ${recentHTML}
      <div class="section-header"><span class="section-title">Browse by genre</span></div>
      <div class="genre-grid">${tiles}</div>
    </div>`)
    var searchInput = document.getElementById('tb-search')
    var commitFn = searchInput && searchInput._commitSearch
    document.querySelectorAll('.recent-search-card').forEach(function(card) {
      card.addEventListener('click', function() {
        if (commitFn) commitFn(card.dataset.query)
        else navigate('search', card.dataset.query)
      })
    })
    document.querySelectorAll('.genre-tile[data-genre]').forEach(tile => {
      tile.addEventListener('click', () => {
        state.libGenre = tile.dataset.genre
        navigate('library')
      })
    })
    document.getElementById('surprise-btn')?.addEventListener('click', function() {
      if (!state.library.length) return
      var album = state.library[Math.floor(Math.random() * state.library.length)]
      if (album.tracks && album.tracks.length) {
        var track = album.tracks[Math.floor(Math.random() * album.tracks.length)]
        state.queue = [track]
        state.queueIndex = 0
        playCurrentTrack()
        showSnackbar('🎲 Playing: ' + track.title + ' — ' + (track.artist || album.artist))
      }
    })
    return
  }
  var filters = _parseSearchOperators(query)
  var hasOperators = filters.operators.length > 0
  var searchText = filters.text
  const q = searchText.normalize('NFC').toLowerCase()
  var matchAlbums, matchTracks, artistSet, matchArtists, didYouMean

  var useCache = false
  if (state._lastSearch && state._lastSearch.query === query &&
      state._lastSearch.libRef === state.library &&
      (Date.now() - state._lastSearch.timestamp) < 30000) {
    useCache = true
    matchAlbums = state._lastSearch.localResults.albums
    artistSet = new Set(state._lastSearch.localResults.artists)
    matchArtists = state._lastSearch.localResults.artists
    matchTracks = state._lastSearch.localResults.tracks
    didYouMean = state._lastSearch.didYouMean
  }

  if (!useCache) {
    matchAlbums = state.library.filter(a =>
      (a.name || '').normalize('NFC').toLowerCase().includes(q) || (a.artist || '').normalize('NFC').toLowerCase().includes(q)
    )
    artistSet = new Set()
    state.library.forEach(a => { if ((a.artist || '').normalize('NFC').toLowerCase().includes(q)) artistSet.add(a.artist) })
    matchArtists = [...artistSet]
    matchTracks = state.library.flatMap(a =>
      a.tracks.filter(t => (t.title || '').normalize('NFC').toLowerCase().includes(q))
        .map(t => ({ ...t, albumId: a.id, albumArtist: a.artist, artPath: a.artPath }))
    )

  if (filters.artist) {
    matchAlbums = matchAlbums.filter(function(a) { return (a.artist || '').normalize('NFC').toLowerCase().indexOf(filters.artist.normalize('NFC').toLowerCase()) !== -1 })
    matchTracks = matchTracks.filter(function(t) { return (t.albumArtist || t.artist || '').normalize('NFC').toLowerCase().indexOf(filters.artist.normalize('NFC').toLowerCase()) !== -1 })
  }
  if (filters.yearMin) matchAlbums = matchAlbums.filter(function(a) { return a.year >= filters.yearMin })
  if (filters.yearMax) matchAlbums = matchAlbums.filter(function(a) { return a.year <= filters.yearMax })
  if (filters.format) {
    var fmt = filters.format.toLowerCase()
    matchTracks = matchTracks.filter(function(t) { return t.filePath && t.filePath.toLowerCase().endsWith('.' + fmt) })
    matchAlbums = matchAlbums.filter(function(a) { return a.tracks && a.tracks[0] && a.tracks[0].filePath && a.tracks[0].filePath.toLowerCase().endsWith('.' + fmt) })
  }
  if (filters.album) matchAlbums = matchAlbums.filter(function(a) { return (a.name || '').normalize('NFC').toLowerCase().indexOf(filters.album.normalize('NFC').toLowerCase()) !== -1 })
  if (filters.genre) matchAlbums = matchAlbums.filter(function(a) { return (a.genre || '').toLowerCase() === filters.genre.toLowerCase() })
  if (filters.is === 'liked') { matchTracks = matchTracks.filter(function(t) { return state.likedTracks.indexOf(t.filePath) !== -1 }); matchAlbums = matchAlbums.filter(function(a) { return state.likedAlbums.indexOf(a.id) !== -1 }) }
  if (filters.is === 'downloaded') { matchTracks = matchTracks.filter(function(t) { return t.filePath && (state.musicFolders || []).some(function (r) { return t.filePath.indexOf(r) === 0 }) }) }
  if (filters.is === 'flac') { matchTracks = matchTracks.filter(function(t) { return t.filePath && t.filePath.toLowerCase().endsWith('.flac') }) }
  if (filters.is === 'lossy') { matchTracks = matchTracks.filter(function(t) { var fp = (t.filePath||'').toLowerCase(); return fp.endsWith('.mp3') || fp.endsWith('.m4a') || fp.endsWith('.aac') }) }
  if (filters.playsMin) matchTracks = matchTracks.filter(function(t) { return (state.playCounts[t.filePath] || 0) > filters.playsMin })
  if (filters.durMax) matchTracks = matchTracks.filter(function(t) { return (t.duration || 0) < filters.durMax })
  if (filters.durMin) matchTracks = matchTracks.filter(function(t) { return (t.duration || 0) > filters.durMin })

  didYouMean = null
  if (!matchAlbums.length && !matchTracks.length && !artistSet.size && searchText.length > 2) {
    var candidates = state.library.map(function(a) { return a.artist + ' \u2014 ' + a.name })
    didYouMean = _fuzzyFind(searchText, candidates, 3)
  }

  state._lastSearch = {
    query: query,
    libRef: state.library,
    localResults: { albums: matchAlbums, artists: [...artistSet], tracks: matchTracks },
    didYouMean: didYouMean,
    timestamp: Date.now()
  }
  }

  // Sorting happens AFTER the cache branch so the dropdown works on a cache hit
  // too, and on a copy so the cached array is never reordered underneath it.
  if (state.searchSort === 'alpha') {
    matchTracks = matchTracks.slice().sort(function(a, b) { return String(a.title || '').localeCompare(String(b.title || '')) })
  } else if (state.searchSort === 'duration') {
    matchTracks = matchTracks.slice().sort(function(a, b) { return (a.duration || 0) - (b.duration || 0) })
  }

  // Display cap. Applied here, not before the filters, so an operator search
  // reports what it actually matched rather than what survived an arbitrary
  // 20-row window.
  var matchTracksTotal = matchTracks.length
  if (matchTracks.length > 20) matchTracks = matchTracks.slice(0, 20)

  var dymHTML = didYouMean && didYouMean.length ? '<div class="did-you-mean">Did you mean: ' + didYouMean.map(function(d, i) { return '<span class="dym-link" data-dym-idx="' + i + '">' + esc(d) + '</span>' + (i < didYouMean.length - 1 ? ', ' : '') }).join('') + '?</div>' : ''

  const hasLocal = matchAlbums.length || matchArtists.length || matchTracks.length
  ytSearchState.showTopResult = !hasLocal

  var sortOptions = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'alpha', label: 'A-Z' },
    { value: 'duration', label: 'Duration' }
  ]
  var currentSort = state.searchSort || 'relevance'

  const tabs = ['All', 'Songs', 'Albums', 'Artists', 'Playlists']
  var html = `<div class="page">
    <div class="search-tabs" id="search-tabs" role="tablist" aria-label="Search result categories">
      ${tabs.map(t => `<button class="search-tab${t==='All'?' active':''}" role="tab" aria-selected="${t==='All'}" data-tab="${t}">${t}</button>`).join('')}
    </div>
    ${query ? '<div style="padding:4px 0 8px 0;display:flex;align-items:center;gap:12px"><button class="save-search-btn" id="save-search-btn" title="Save as smart playlist">+ Save search</button><div class="search-sort"><select id="search-sort-select">' + sortOptions.map(function(o) { return '<option value="' + o.value + '"' + (o.value === currentSort ? ' selected' : '') + '>' + o.label + '</option>' }).join('') + '</select></div></div>' : ''}
    ${dymHTML}
    <div class="results-filter-wrap"><input class="results-filter" id="results-filter" placeholder="Filter results…"></div>
    ${hasOperators ? '<div class="active-filters"><span>Filters active:</span>' + filters.operators.map(function(op) { return '<span class="filter-chip">' + op.key + ':' + op.value + '<button class="filter-chip-x" data-key="' + esc(op.key) + '">×</button></span>' }).join('') + '<button class="clear-filters-btn" id="clear-filters-btn">Clear all</button></div>' : ''}`

  if (hasLocal) {
    // Top result — best matching album or artist
    const topAlbum = matchAlbums[0]
    if (topAlbum) {
      const hue = _cardHue((topAlbum.artist||'') + (topAlbum.name||''))
      const artStyle = topAlbum.artPath
        ? `background:url('${esc('file://' + topAlbum.artPath)}') center/cover no-repeat`
        : `background:linear-gradient(135deg,hsl(${hue},55%,28%) 0%,hsl(${(hue+40)%360},45%,18%) 100%)`
      html += `<div class="search-section" data-section="All"><div class="search-top-row">
        <div class="search-top-result" data-album="${esc(topAlbum.id)}">
          <div class="str-label">Top Result</div>
          <div class="str-art" style="${artStyle}">
            ${!topAlbum.artPath ? `<svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:rgba(255,255,255,.5)"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>` : ''}
          </div>
          <div class="str-name">${highlightMatch(topAlbum.name, searchText)}</div>
          <div class="str-artist">${highlightMatch(topAlbum.artist, searchText)} · Album</div>
          <button class="str-play album-card-play" data-play="${esc(topAlbum.id)}">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>`

      if (matchTracks.length) {
        html += `<div class="search-top-tracks">`
        html += matchTracks.slice(0, 4).map((t, i) => {
          const trackHue = _cardHue(t.albumArtist + t.title)
          const artThumb = t.artPath
            ? `<img src="${esc('file://' + t.artPath)}" class="str-track-thumb" alt="" onerror="this.style.display='none'">`
            : `<div class="str-track-thumb" style="background:linear-gradient(135deg,hsl(${trackHue},50%,22%),hsl(${(trackHue+40)%360},40%,14%))"></div>`
          return `<div class="str-track track-row search-animate-in" data-file="${esc(t.filePath)}" data-idx="${i}" data-album="${t.albumId}">
            ${artThumb}
            <div class="str-track-info">
              <div class="str-track-title">${highlightMatch(t.title, searchText)}</div>
              <div class="str-track-artist">${highlightMatch(t.albumArtist, searchText)}</div>
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
        <div class="section-header"><span class="section-title">Albums · ${matchAlbums.length - (topAlbum ? 1 : 0)}</span></div>
        <div class="album-grid">${matchAlbums.slice(startIdx, startIdx + 8).map(function(a) { return albumCard(a, 0, '', searchText).replace('class="album-card"', 'class="album-card search-animate-in"') }).join('')}</div>
      </div>`
    }
    if (matchArtists.length) {
      html += `<div class="search-section" data-section="Artists">
        <div class="section-header"><span class="section-title">Artists · ${matchArtists.length}</span></div>
        <div class="artist-pill-list">${matchArtists.map(a => `<div class="artist-pill" data-artist="${esc(a)}">${esc(a)}</div>`).join('')}</div>
      </div>`
    }
    if (matchTracks.length > 4 || (!topAlbum && matchTracks.length)) {
      const startIdx = topAlbum ? 4 : 0
      html += `<div class="search-section" data-section="Songs">
        <div class="section-header"><span class="section-title">Songs · ${matchTracksTotal > matchTracks.length ? matchTracks.length + ' of ' + matchTracksTotal : matchTracks.length}</span></div>
        <div class="track-list">
        <div class="track-list-header"><span>#</span><span>Title</span><span style="text-align:right">Duration</span></div>`
      html += matchTracks.slice(startIdx).map((t, i) => `
        <div class="track-row search-animate-in" data-file="${esc(t.filePath)}" data-idx="${i + startIdx}" data-album="${t.albumId}">
          <span class="track-num">${i + startIdx + 1}</span>
          <div class="track-info">
            <div class="track-title">${highlightMatch(t.title, searchText)}</div>
            <div class="track-artist" data-artist="${esc(t.albumArtist)}">${highlightMatch(t.albumArtist, searchText)}</div>
          </div>
          <div class="hover-actions">
            <button class="hover-action-btn" data-action="playnext" data-file="${esc(t.filePath)}" data-album="${esc(t.albumId || '')}" title="Play next">&#9654;+</button>
            <button class="hover-action-btn" data-action="queue" data-file="${esc(t.filePath)}" data-album="${t.albumId}" title="Add to queue">+</button>
          </div>
          <span class="track-dur">${fmtDur(t.duration)}</span>
        </div>`).join('')
      html += `</div></div>`
    }
  } else {
    html += '<div class="empty-wrap" style="padding:60px 20px;text-align:center">' +
      '<svg viewBox="0 0 24 24" style="width:64px;height:64px;fill:var(--text3);margin-bottom:16px;opacity:.4"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
      '<h2>No results for "' + esc(searchText || query) + '"</h2>' +
      '<p>Try different keywords, check spelling, or use Soulseek search.</p>' +
      '<p style="font-size:11px;color:var(--text3);margin-top:8px">Try operators: artist:"name", year:2020, format:flac, is:liked, genre:rock</p>' +
      '</div>'
  }

  // YouTube section (async — filled by runYtSearch)
  html += `<div class="search-section" data-section="YouTube" id="yt-section">
    <div class="section-header">
      <span class="section-title"><span class="yt-health-dot" id="yt-health-dot" title="YouTube status"></span>YouTube</span>
      <div class="yt-scope-tabs">
        <button class="yt-scope${ytSearchState.scope === 'music' ? ' active' : ''}" data-scope="music">Music</button>
        <button class="yt-scope${ytSearchState.scope === 'all' ? ' active' : ''}" data-scope="all">All of YouTube</button>
      </div>
    </div>
    <div id="yt-results"><div class="yt-status">Searching YouTube…</div></div>
  </div>`

  // Soulseek section
  html += `<div class="online-search-section">
    <div id="slsk-section">${renderSoulseekRow(query)}</div>
  </div>`

  // Related searches from matched artists
  if (matchAlbums.length > 0) {
    var relatedArtists = new Set()
    matchAlbums.slice(0, 3).forEach(function(a) {
      if (a.artist) relatedArtists.add(a.artist)
    })
    var genres = new Set()
    matchAlbums.forEach(function(a) { if (a.genre) genres.add(a.genre) })
    var related = []
    state.library.forEach(function(a) {
      if (a.genre && genres.has(a.genre) && !matchAlbums.includes(a)) {
        related.push(a.artist + ' \u2014 ' + a.name)
      }
    })
    related = [...new Set(related)].slice(0, 8)

    if (related.length) {
      html += '<div class="section-header" style="margin-top:24px"><span class="section-title">Related searches</span></div>'
      html += '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 28px">'
      related.forEach(function(r) {
        html += '<button class="related-chip" data-query="' + esc(r) + '">' + esc(r) + '</button>'
      })
      html += '</div>'
    }
  }

  html += `</div>`
  setContent(html)   // already calls bindContentEvents() as its last statement

  document.querySelectorAll('.related-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      commitSearchQuery(chip.dataset.query)
    })
  })

  document.getElementById('save-search-btn')?.addEventListener('click', function() {
    var ops = _parseSearchOperators(query)
    var cleanQuery = ops.text || query
    var rules = []
    if (cleanQuery && cleanQuery !== query) rules.push({ field: 'title', op: 'contains', value: cleanQuery })
    ops.operators.forEach(function(op) {
      rules.push({ field: op.field, op: op.op || 'is', value: op.value })
    })
    var sp = {
      id: 'sp_' + Date.now(),
      name: 'Search: ' + query.slice(0, 40),
      rules: rules.length ? rules : [{ field: 'title', op: 'contains', value: query }],
    }
    state.smartPlaylists.unshift(sp)
    try {
      localStorage.setItem('papa-smart-playlists', JSON.stringify(state.smartPlaylists))
    } catch (_) {}
    showSnackbar('Smart playlist saved: ' + sp.name)
  })

  document.getElementById('clear-filters-btn')?.addEventListener('click', function() {
    var cleanQuery = filters.text
    if (cleanQuery) {
      commitSearchQuery(cleanQuery)
    } else {
      navigate('search')
    }
  })

  document.querySelectorAll('.filter-chip-x').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      var keyToRemove = btn.dataset.key
      var remaining = filters.operators.filter(function(op) { return op.key !== keyToRemove })
      var newQuery = filters.text
      remaining.forEach(function(op) { newQuery += ' ' + op.key + ':' + op.value })
      if (newQuery.trim()) { commitSearchQuery(newQuery.trim()) }
      else { navigate('search') }
    })
  })

  document.querySelectorAll('.dym-link').forEach(function(link) {
    link.addEventListener('click', function() {
      var idx = parseInt(link.dataset.dymIdx)
      if (didYouMean && didYouMean[idx]) { navigate('search', didYouMean[idx]) }
    })
  })

  document.getElementById('search-sort-select')?.addEventListener('change', function() {
    state.searchSort = this.value
    renderSearch(query)
  })

  // Wire up filter tabs
  document.querySelectorAll('#search-tabs .search-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _setActiveTab('#search-tabs .search-tab', tab)
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
      try { localStorage.setItem('papa-yt-scope', tab.dataset.scope) } catch (_) {}
      runYtSearch(query, tab.dataset.scope)
    })
  })

  const sameQuery  = slsk.lastQuery === query
  const hasResults = slsk.results.length > 0
  bindSlskSearchEvents(query)
  if (slsk.status.connected) {
    if (!sameQuery || !slsk.searched || (!slsk.searching && !hasResults)) {
      runSlskSearch(query)
    } else {
      const navQ = document.getElementById('nav-search-query')
      if (navQ) navQ.textContent = query
      const section = document.getElementById('slsk-section')
      if (section) { section.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }
    }
  } else {
    const section = document.getElementById('slsk-section')
    if (section) { section.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }
  }
  runYtSearch(query, ytSearchState.scope)
}

// ── YouTube search section ──────────────────────────────────────────────────
// Pause every animation while the window is unfocused. See main.js: this
// machine renders in software, so animation costs a full CPU core.
if (window.api && window.api.onWindowFocus) {
  window.api.onWindowFocus(on => document.body.classList.toggle('app-unfocused', !on))
}
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('app-unfocused', document.hidden)
})

const ytSearchState = { scope: 'music', cache: new Map(), lastQuery: null, showTopResult: false, surroundOnly: false }
try {
  var savedScope = localStorage.getItem('papa-yt-scope')
  if (savedScope === 'all' || savedScope === 'music') ytSearchState.scope = savedScope
} catch (_) {}

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

function updateYtHealth(status) {
  var dot = document.getElementById('yt-health-dot')
  if (!dot) return
  dot.className = 'yt-health-dot yt-health-' + status
}

async function runYtSearch(query, scope) {
  ytSearchState.scope = scope
  ytSearchState.lastQuery = query
  const box = document.getElementById('yt-results')
  if (!box) return
  if (!state.isOnline) {
    box.innerHTML = '<div class="yt-status yt-error">You are offline — YouTube unavailable</div>'
    return
  }
  var cacheKey = `${scope}::${query}`
  if (ytSearchState.cache.has(cacheKey)) {
    renderYtResults(ytSearchState.cache.get(cacheKey), query)
    updateYtHealth('ok')
    return
  }
  updateYtHealth('searching')
  box.innerHTML = '<div class="yt-status">Searching YouTube…</div><div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div></div><div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div></div><div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div></div>'
  var slowTimer = setTimeout(function() {
    var cur = document.getElementById('yt-results')
    if (cur && ytSearchState.lastQuery === query) {
      cur.innerHTML = '<div class="yt-status yt-slow">Taking longer than expected… <button class="yt-retry" id="yt-cancel-btn">Cancel</button></div>'
      document.getElementById('yt-cancel-btn')?.addEventListener('click', function() {
        ytSearchState.lastQuery = null
        cur.innerHTML = '<div class="yt-status">Search cancelled</div>'
      })
    }
  }, 8000)
  const call = scope === 'music' ? window.api.ytMusicSearchFull : window.api.ytSearch
  const res = await call({ query }).catch(e => ({ ok: false, error: String(e) }))
  clearTimeout(slowTimer)
  // Stale response guard — user typed a new query or switched scope meanwhile
  if (ytSearchState.lastQuery !== query || ytSearchState.scope !== scope) return
  if (res.ok) ytSearchState.retries = 0
  if (!res.ok) {
    updateYtHealth('error')
    const cur = document.getElementById('yt-results')
    if (cur) cur.innerHTML = `<div class="yt-status yt-error">YouTube search failed: ${esc(res.error || 'unknown error')} <button class="yt-retry" id="yt-retry-btn">Retry</button></div>`
    setTimeout(function() {
      // Also stop when the user has left the search page, and give up after a
      // few attempts: this used to retry forever, from any page.
      if (state.currentPage !== 'search') return
      ytSearchState.retries = (ytSearchState.retries || 0) + 1
      if (ytSearchState.retries > 3) return
      if (ytSearchState.lastQuery === query && ytSearchState.scope === scope) {
        var cur2 = document.getElementById('yt-results')
        if (cur2) cur2.innerHTML = '<div class="yt-status">Retrying YouTube…</div>'
        runYtSearch(query, scope)
      }
    }, 3000)
    return
  }
  updateYtHealth('ok')
  ytSearchState.cache.set(cacheKey, res.results)
  renderYtResults(res.results, query)
  // Pre-resolve audio URLs for top YouTube results so playback is instant
  var videoIds = []
  if (res.results.songs) videoIds = res.results.songs.slice(0, 5).map(function(r) { return r.videoId }).filter(Boolean)
  else if (Array.isArray(res.results)) videoIds = res.results.slice(0, 5).map(function(r) { return r.videoId }).filter(Boolean)
  if (videoIds.length) window.api.preResolveYtUrls(videoIds).catch(function() {})
}

function _ytArtistSpan(r, query) {
  if (!r.artist) return ''
  var artistHtml = query ? highlightMatch(r.artist, query) : esc(r.artist)
  return r.channelId
    ? `<span class="yt-link" data-yt-channel="${esc(r.channelId)}">${artistHtml}</span>`
    : `<span class="yt-link" data-yt-name="${esc(r.artist)}">${artistHtml}</span>`
}

// initSearchHistory() owns the real commitSearch and exposes it on the input.
// Anything outside that closure must go through here.
function commitSearchQuery(q) {
  var input = document.getElementById('tb-search')
  var fn = input && input._commitSearch
  if (fn) { fn(q); return }
  if (input) input.value = q
  navigate('search', q)
}

function isInLibrary(artist, album) {
  if (!artist || !album) return false
  var aLower = artist.toLowerCase()
  var bLower = album.toLowerCase()
  return state.library.some(function(a) {
    var ar = String(a.artist || '').toLowerCase()
    var nm = String(a.name || '').toLowerCase()
    if (!ar || !nm) return false
    return (ar.includes(aLower) || aLower.includes(ar)) &&
           (nm.includes(bLower) || bLower.includes(nm))
  })
}

// YouTube serves stereo to every desktop client - verified against yt-dlp, where
// even "Official Dolby 5.1" uploads offer nothing but 2-channel Opus and AAC.
// So this badge reports what the uploader CLAIMS, and says so on hover. It is
// there to help find surround-labelled uploads, not to promise surround audio.
function _ytSurround(r) {
  const D = window.PapaSurround
  if (!D) return null
  return D.detectSurround(`${r.title || ''} ${r.album || ''} ${r.artist || ''}`)
}

function _ytSurroundBadge(r) {
  const s = _ytSurround(r)
  return s ? `<span class="yt-surround-badge" title="Uploader labels this ${esc(s.label)} - YouTube still streams stereo">${esc(s.label)}</span>` : ''
}

function _ytSongRows(songs, query) {
  return `<div class="yt-list">${songs.map((r, i) => {
    var inLib = isInLibrary(r.artist, r.album)
    var badge = inLib ? '<span class="in-lib-badge" style="background:rgba(29,185,84,.15);color:#1db954;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px">In Library</span>' : ''
    var sur = _ytSurround(r)
    return `<div class="yt-row search-animate-in" data-i="${i}"${sur ? ' data-surround="1"' : ''}>
      ${r.thumbnailUrl
        ? `<img class="yt-thumb" src="${esc(r.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="yt-thumb yt-thumb-empty"></div>`}
      <div class="yt-info">
        <div class="yt-title">${query ? highlightMatch(r.title, query) : esc(r.title)} <span class="yt-badge">YT</span>${_ytSurroundBadge(r)}${badge}</div>
        <div class="yt-sub-line">${_ytArtistSpan(r, query)}${r.album ? ' · ' + (r.albumBrowseId ? `<span class="yt-link" data-yt-albumbrowse="${esc(r.albumBrowseId)}">${esc(r.album)}</span>` : esc(r.album)) : ''}${r.viewCount ? ' · ' + esc(r.viewCount) : ''}</div>
      </div>
      <span class="yt-dur">${r.duration ? fmtDur(r.duration) : ''}</span>
      <div class="yt-actions">
        <button class="yt-btn yt-play" data-i="${i}" title="Stream now" aria-label="Stream now">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="yt-btn yt-queue" data-i="${i}" title="Add to queue" aria-label="Add to queue">+</button>
        <button class="yt-btn yt-like${isYtLiked(r.videoId) ? ' liked' : ''}" data-i="${i}" title="${isYtLiked(r.videoId) ? 'Unlike' : 'Like'}" aria-label="${isYtLiked(r.videoId) ? 'Unlike' : 'Like'}">${isYtLiked(r.videoId) ? '♥' : '♡'}</button>
        <button class="yt-btn yt-dl" data-i="${i}" title="Download" aria-label="Download">
          <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
      </div>
    </div>`
  }).join('')}</div>`
}

function _ytAlbumCard(a, query) {
  const hue = _cardHue((a.artist || '') + (a.title || ''))
  var inLib = isInLibrary(a.artist, a.title)
  var badge = inLib ? '<span class="in-lib-badge" style="background:rgba(29,185,84,.15);color:#1db954;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px">In Library</span>' : ''
  return `<div class="album-card yt-album-card search-animate-in" data-browse="${esc(a.browseId)}">
    <div class="album-card-art-wrap">
      ${a.thumbnailUrl
        ? `<img class="album-card-art" src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-card-art-fallback" ${a.thumbnailUrl ? 'style="display:none"' : `style="background:linear-gradient(135deg,hsl(${hue},55%,22%) 0%,hsl(${(hue+40)%360},45%,14%) 100%)"`}>
        <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
      </div>
      <span class="yt-badge yt-card-badge">YT</span>
    </div>
    <div class="album-card-name">${query ? highlightMatch(a.title, query) : esc(a.title)}${badge}</div>
    <div class="album-card-meta">${esc(a.year || '')}${a.year && a.artist ? ' · ' : ''}${query ? highlightMatch(a.artist || '', query) : esc(a.artist || '')}</div>
  </div>`
}

function _ytArtistCard(a) {
  return `<div class="artist-card yt-artist-card search-animate-in" data-channel="${esc(a.channelId)}">
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

function _ytSurroundBar(n) {
  // Still render the bar when the filter is ON but nothing matched, otherwise
  // the results vanish with no way to switch it back off.
  if (!n && !ytSearchState.surroundOnly) return ''
  if (!n) {
    return `<div class="yt-surround-bar">
      <button class="yt-surround-toggle active" id="yt-surround-toggle">
        Surround only<span class="yt-surround-n">0</span>
      </button>
      <span class="yt-surround-hint">No surround-labelled uploads in these results — click to show everything</span>
    </div>`
  }
  const on = ytSearchState.surroundOnly
  return `<div class="yt-surround-bar">
    <button class="yt-surround-toggle${on ? ' active' : ''}" id="yt-surround-toggle">
      Surround only<span class="yt-surround-n">${n}</span>
    </button>
    <span class="yt-surround-hint">Uploader labels - YouTube streams stereo regardless</span>
  </div>`
}

function _bindYtSurroundToggle(box) {
  box.querySelector('#yt-surround-toggle')?.addEventListener('click', () => {
    ytSearchState.surroundOnly = !ytSearchState.surroundOnly
    const results = document.getElementById('yt-results')
    results?.classList.toggle('surround-only', ytSearchState.surroundOnly)
    box.querySelector('#yt-surround-toggle')?.classList.toggle('active', ytSearchState.surroundOnly)
  })
  if (ytSearchState.surroundOnly) document.getElementById('yt-results')?.classList.add('surround-only')
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
    const surN = results.filter(r => _ytSurround(r)).length
    box.innerHTML = _ytSurroundBar(surN) + `<div class="yt-sub" data-sub="Songs">
      <div class="yt-sub-header">Videos · ${results.length} <button class="yt-see-all" data-query="${esc(query)}" data-kind="video">See all</button></div>
      ${_ytSongRows(results, query)}</div>`
    bindYtEvents(results)
    _bindYtSurroundToggle(box)
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
  let html = _ytSurroundBar(songs.filter(r => _ytSurround(r)).length)
  if (ytSearchState.showTopResult) {
    html += `<div class="yt-sub yt-top-wrap" data-sub="All">${_ytTopResultCard(results, query)}</div>`
  }
  if (songs.length) {
    html += `<div class="yt-sub" data-sub="Songs">
      <div class="yt-sub-header">Songs · ${songs.length} <button class="yt-see-all" data-query="${esc(query)}" data-kind="song">See all</button></div>
      ${_ytSongRows(songs, query)}
    </div>`
  }
  if (artists.length) {
    html += `<div class="yt-sub" data-sub="Artists">
      <div class="yt-sub-header">Artists · ${artists.length} <button class="yt-see-all" data-query="${esc(query)}" data-kind="artist">See all</button></div>
      <div class="artist-grid yt-artist-grid">${artists.map(_ytArtistCard).join('')}</div>
    </div>`
  }
  if (albums.length) {
    html += `<div class="yt-sub" data-sub="Albums">
      <div class="yt-sub-header">Albums · ${albums.length} <button class="yt-see-all" data-query="${esc(query)}" data-kind="album">See all</button></div>
      <div class="album-grid">${albums.map(function(a) { return _ytAlbumCard(a, query) }).join('')}</div>
    </div>`
  }
  if (playlists.length) {
    html += `<div class="yt-sub" data-sub="Playlists">
      <div class="yt-sub-header">Playlists · ${playlists.length} <button class="yt-see-all" data-query="${esc(query)}" data-kind="playlist">See all</button></div>
      <div class="album-grid">${playlists.map(_ytPlaylistCard).join('')}</div>
    </div>`
  }
  box.innerHTML = html
  _bindYtSurroundToggle(box)
  bindYtEvents(songs)
  _bindYtEntityEvents(results)
  _bindYtSeeAll(box)
  _applyYtFilter()
}

function _bindYtSeeAll(box) {
  box.querySelectorAll('.yt-see-all').forEach(btn => btn.addEventListener('click', () => {
    // Use the query this section was rendered from. The global is mutated by a
    // newer search and set to null by the Cancel button.
    const q = btn.dataset.query || ytSearchState.lastQuery
    if (!q) { showSnackbar('Search again to see all results'); return }
    navigate('yt-see-all', `${btn.dataset.kind}::${q}`)
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
    { label: 'Start radio', action: 'radio' },
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
  else if (action === 'radio') startYtRadio(r)
  else if (action === 'addpl') showAddToPlaylistModal([_ytQueueItem(r)])
  else if (action === 'goalbum') navigate('yt-album', r.albumBrowseId)
  else if (action === 'goartist') navigate('yt-artist', r.channelId)
  else if (action === 'download') window.api.ytDownload({ videoId: r.videoId, title: r.title, artist: r.artist })
  return action
}

// Resolve "artist name only" → channel page via first artist search hit.
async function openYtArtistByName(name) {
  if (!name) return
  const res = await window.api.ytSearchPage({ kind: 'artist', query: name, next: false }).catch(() => null)
  const hit = res?.ok ? res.items?.[0] : null
  if (hit?.channelId) navigate('yt-artist', hit.channelId)
  else showToast(`Couldn't find "${name}" on YouTube Music`)
}

// Clickable artist/album names inside any container of YT rows or heroes.
function bindYtEntityLinks(container) {
  if (!container) return
  container.querySelectorAll('[data-yt-channel]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation()
    navigate('yt-artist', el.dataset.ytChannel)
  }))
  container.querySelectorAll('[data-yt-name]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation()
    openYtArtistByName(el.dataset.ytName)
  }))
  container.querySelectorAll('[data-yt-albumbrowse]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation()
    navigate('yt-album', el.dataset.ytAlbumbrowse)
  }))
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
  bindYtEntityLinks(box)
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
  else setContent(`<div class="page"><div class="skeleton skeleton-header"></div>${Array(6).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>`)
  const res = await window.api.ytAlbum({ browseId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-album') return
  if (!res.ok) {
    if (!snap) setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load album: ${esc(res.error || 'unknown error')} <button class="yt-retry" id="yt-album-retry">Retry</button></div></div>`)
    bindYtAlbumRetry(browseId)
    return
  }
  const changed = !snap
    || JSON.stringify({ ...snap, savedAt: 0 }) !== JSON.stringify({ ...res.album, savedAt: 0 })
  if (changed) _paintYtAlbum(res.album)
}

function bindYtAlbumRetry(browseId) {
  document.getElementById('yt-album-retry')?.addEventListener('click', () => renderYtAlbum(browseId))
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
      <button class="yt-btn yt-track-dl" data-i="${i}" title="Download" aria-label="Download">
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
          <span class="yt-link" data-yt-name="${esc(al.artist)}">${esc(al.artist)}</span>
          ${al.year ? `&bull; ${esc(al.year)}` : ''} ${al.summary ? `&bull; ${esc(al.summary)}` : ''}
        </div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="yt-album-play-btn" title="Play all">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn yt-album-shuffle-btn" id="yt-album-shuffle-btn" title="Shuffle play">
        <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
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
  document.getElementById('yt-album-shuffle-btn')?.addEventListener('click', function() {
    var tracks = al.tracks.slice().map(function(t) { return _ytAlbumTrackItem(al, t) }).sort(function() { return Math.random() - 0.5 })
    state.queue = tracks
    state.queueIndex = 0
    playCurrentTrack()
    showSnackbar('Shuffling ' + tracks.length + ' tracks')
  })
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
  bindYtEntityLinks(document.querySelector('.album-hero'))
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
  setContent(`<div class="page"><div class="skeleton skeleton-header"></div>${Array(8).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>`)
  const res = await window.api.ytPlaylist({ playlistId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-playlist') return
  if (!res.ok) {
    setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load playlist: ${esc(res.error || 'unknown error')} <button class="yt-retry" id="yt-pl-retry">Retry</button></div></div>`)
    document.getElementById('yt-pl-retry')?.addEventListener('click', () => renderYtPlaylist(playlistId))
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
    <div id="yt-seeall-body">${Array(8).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>
    <div id="yt-seeall-more"></div>
  </div>`)

  async function loadPage(next) {
    const res = await window.api.ytSearchPage({ kind, query, next }).catch(e => ({ ok: false, error: String(e) }))
    if (state.currentPage !== 'yt-see-all') return
    const body = document.getElementById('yt-seeall-body')
    const moreBox = document.getElementById('yt-seeall-more')
    if (!body) return
    if (!res.ok) {
      var note = `<div class="yt-status yt-error">Couldn't load${next ? ' more' : ''}: ${esc(res.error || 'unknown')} <button class="yt-retry" id="yt-seeall-retry">Retry</button></div>`
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
      body.innerHTML = _ytSongRows(items, query)
      bindYtEvents(items, body)
    } else if (kind === 'album') {
      body.innerHTML = `<div class="album-grid">${items.map(function(a) { return _ytAlbumCard(a, query) }).join('')}</div>`
      body.querySelectorAll('.yt-album-card').forEach(c => c.addEventListener('click', () => navigate('yt-album', c.dataset.browse)))
    } else {
      const card = kind === 'artist' ? _ytArtistCard : _ytPlaylistCard
      body.innerHTML = `<div class="${kind === 'artist' ? 'artist-grid yt-artist-grid' : 'album-grid'}">${items.map(card).join('')}</div>`
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
  setContent(`<div class="page"><div class="skeleton skeleton-header"></div>${Array(6).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>`)
  const res = await window.api.ytArtist({ channelId }).catch(e => ({ ok: false, error: String(e) }))
  if (state.currentPage !== 'yt-artist') return
  if (!res.ok) {
    setContent(`<div class="page"><div class="yt-status yt-error">Couldn't load artist: ${esc(res.error || 'unknown error')} <button class="yt-retry" id="yt-ar-retry">Retry</button></div></div>`)
    document.getElementById('yt-ar-retry')?.addEventListener('click', () => renderYtArtist(channelId))
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
      ${ar.topSongs.length ? `<button class="follow-btn" id="yt-artist-radio-btn" title="Play a radio seeded from this artist">Radio</button>` : ''}
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
  document.getElementById('yt-artist-radio-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('yt-artist-radio-btn')
    if (btn) btn.textContent = 'Radio…'
    startYtRadio(ar.topSongs[0]).then(ok => { if (btn) btn.textContent = ok ? 'Radio ▸' : 'Radio' })
  })
}

function renderArtist(artistName) {
  const artistAlbums = state.library.filter(a => a.artist === artistName || a.albumArtist === artistName)
  if (!artistAlbums.length) {
    // Reached by clicking a followed artist whose files were removed or
    // retagged. It used to just become Home, with no message and no way to
    // unfollow the now-unreachable entry.
    const wasFollowed = state.followedArtists.indexOf(artistName) !== -1
    navigate('home', null, { skipHistory: true })
    showSnackbar('No albums found for "' + artistName + '"',
      wasFollowed ? 'Unfollow' : '',
      wasFollowed ? function () { toggleFollowArtist(artistName) } : function () {})
    return
  }
  var totalTracks = 0, totalDur = 0
  artistAlbums.forEach(function(a) { totalTracks += (a.tracks || []).length; (a.tracks || []).forEach(function(t) { totalDur += t.duration || 0 }) })
  var artistHours = Math.floor(totalDur / 3600), artistMins = Math.floor((totalDur % 3600) / 60)
  var isFollowed = state.followedArtists.indexOf(artistName) !== -1
  var heroHTML = '<div class="artist-hero"><div class="artist-hero-art">' + (artistAlbums[0] && artistAlbums[0].artPath ? '<img src="' + esc('file://' + artistAlbums[0].artPath) + '" alt="">' : '<div style="width:100%;height:100%;background:var(--bg4);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:var(--text3)"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>') + '</div><div class="artist-hero-info"><div class="artist-hero-name">' + esc(artistName) + '</div><div class="artist-hero-meta">' + artistAlbums.length + ' albums &middot; ' + totalTracks + ' tracks &middot; ' + artistHours + 'h ' + artistMins + 'm</div><button class="follow-btn' + (isFollowed ? ' following' : '') + '" id="artist-follow-btn">' + (isFollowed ? 'Following' : 'Follow') + '</button></div></div>'

  var albums = [], eps = [], singles = []
  // Newest first, then alphabetical. Unsorted, the discography reordered itself
  // after every rescan because it followed raw scanner order.
  artistAlbums.slice().sort(function (a, b) {
    return (b.year || 0) - (a.year || 0) || String(a.name || '').localeCompare(String(b.name || ''))
  }).forEach(function(a) {
    var tc = (a.tracks || []).length
    if (tc <= 3) singles.push(a)
    else if (tc <= 6) eps.push(a)
    else albums.push(a)
  })

  var discogHTML = ''
  if (albums.length) discogHTML += '<div class="discography-section"><div class="discography-section-title">Albums</div><div class="album-grid">' + albums.map(albumCard).join('') + '</div></div>'
  // `singles` is rendered inside this same section, so gating on eps alone
  // meant an artist whose releases are ALL <=3 tracks got a completely blank
  // discography -- and the all-empty fallback below could never fire either.
  if (eps.length || singles.length) discogHTML += '<div class="discography-section"><div class="discography-section-title">EPs & Singles</div><div class="album-grid">' + eps.concat(singles).map(albumCard).join('') + '</div></div>'
  if (!albums.length && !eps.length && !singles.length) discogHTML += '<div class="album-grid">' + artistAlbums.map(albumCard).join('') + '</div>'

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
        return `<div class="artist-card artist-related-card" data-artist="${esc(a.artist)}" style="cursor:pointer">
          <div class="artist-card-art">${artImg(a.artPath, 'artist-card-art-img', 'artist-card-art-fallback')}</div>
          <div class="artist-card-name">${esc(a.artist)}</div>
          <div class="artist-card-meta">${ct} album${ct!==1?'s':''}</div>
        </div>`
      }).join('')}</div>
    </div>` : ''

  setContent(`${heroHTML}<div class="page" style="padding-top:16px">
      <div class="artist-bio" id="artist-bio"><div class="artist-bio-skeleton"></div></div>
      ${discogHTML}
      ${relatedHTML}
    </div>`)

  document.getElementById('artist-follow-btn')?.addEventListener('click', function() {
    var followed = toggleFollowArtist(artistName)
    this.textContent = followed ? 'Following' : 'Follow'
    this.classList.toggle('following', followed)
  })
  // Scoped to the related cards. It used to be document-wide, so it also bound
  // a SECOND handler to every .album-card-artist[data-artist] inside the
  // discography (bindContentEvents already handles those) -- one click pushed
  // two history entries.
  document.querySelectorAll('.artist-related-card[data-artist]').forEach(card => {
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
  // A hung connection (captive portal, DNS blackhole) left the shimmering
  // skeleton up forever, because nothing ever resolved to replace it.
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  var bioTimer = setTimeout(function () { if (ctrl) ctrl.abort() }, 8000)
  try {
    const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(artistName),
      ctrl ? { signal: ctrl.signal } : undefined)
    if (!res.ok) throw new Error('no bio')
    const json = await res.json()
    // A disambiguation page is never a biography -- "Air", "Bush", "Muse" and
    // "Chicago" all resolve to one, and we used to print it as fact.
    const isDisambig = json.type === 'disambiguation' ||
      /may refer to|disambiguation/i.test(String(json.extract || '').slice(0, 120))
    const data = isDisambig
      ? { extract: null, thumbnail: null }
      : { extract: json.extract || null, thumbnail: json.thumbnail?.source || null }
    _bioCache.set(artistName, data)
    if (state.currentPage === 'artist' && state.currentArtistName === artistName) render(data)
  } catch (_) {
    // Don't cache a network failure forever: going offline once used to mean
    // that artist had no bio for the rest of the session, even after recovery.
    if (state.isOnline !== false) _bioCache.set(artistName, null)
    if (state.currentPage === 'artist' && state.currentArtistName === artistName) render(null)
  } finally {
    clearTimeout(bioTimer)
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
  var note = `<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
  if (!paths.length) {
    const hue = _cardHue(pl.name || pl.id)
    return `<div class="${cls} pl-collage-empty" style="background:linear-gradient(135deg,hsl(${hue},55%,24%),hsl(${(hue+40)%360},45%,15%))">${note}</div>`
  }
  // Feeds background:url('...'), so it must survive a quote in the path.
  const artUrl = p => esc(isHttpPath(p) ? p : `file://${p}`)
  if (paths.length < 4) {
    return `<div class="${cls}" style="background:url('${artUrl(paths[0])}') center/cover no-repeat"></div>`
  }
  return `<div class="${cls} pl-collage-grid">${paths.slice(0,4).map(p => `<div style="background:url('${artUrl(p)}') center/cover no-repeat"></div>`).join('')}</div>`
}

function _plTotalDur(pl) {
  return (pl.tracks || []).reduce((s, t) => s + (t.duration || 0), 0)
}

function renderPlaylists() {
  var sorted = [...state.playlists, ...state.smartPlaylists]
  if (state.playlistSort === 'recent') {
    sorted.sort(function(a, b) {
      var aLatest = 0, bLatest = 0
      var aPaths = new Set((a.tracks || []).map(function(t) { return t.filePath }))
      var bPaths = new Set((b.tracks || []).map(function(t) { return t.filePath }))
      for (var i = 0; i < state.playHistory.length; i++) { var p = state.playHistory[i]; if (aPaths.has(p.filePath) && p.ts > aLatest) aLatest = p.ts; if (bPaths.has(p.filePath) && p.ts > bLatest) bLatest = p.ts }
      return bLatest - aLatest
    })
  }

  var folders = {}
  var uncategorized = []
  sorted.forEach(function(pl) {
    var f = pl.folder || null
    if (f) {
      if (!folders[f]) folders[f] = []
      folders[f].push(pl)
    } else {
      uncategorized.push(pl)
    }
  })

  function _plCard(pl) {
    return `<div class="pl-card" data-pl="${esc(pl.id)}">
      <button class="pl-rename-btn" data-pl-id="${esc(pl.id)}" title="Rename" style="position:absolute;top:4px;right:4px;background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px">&#9998;</button>
      <button class="pl-dup-btn" data-pl-id="${esc(pl.id)}" title="Duplicate" style="position:absolute;top:4px;right:28px;background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px">&#128203;</button>
      <span class="pl-folder-badge" title="Folder: ${esc(pl.folder || '')}" style="position:absolute;top:4px;right:52px;font-size:10px;color:var(--text3);opacity:.6">${pl.folder ? '📁' : ''}</span>
      ${_plCollage(pl, 'pl-card-art')}
      <div class="pl-card-name">${esc(pl.name)}</div>
      <div class="pl-card-meta">${pl.type === 'smart' ? _evalSmartPlaylist(pl).length : (pl.tracks || []).length} song${(pl.type === 'smart' ? _evalSmartPlaylist(pl).length : (pl.tracks || []).length) !== 1 ? 's' : ''}</div>
    </div>`
  }

  function _folderSection(folderName, pls, collapsed) {
    if (collapsed === undefined) collapsed = !!_plCollapsedFolders[folderName]
    return `<div class="pl-folder-section">
      <div class="pl-folder-header" data-folder="${esc(folderName)}">
        <span class="pl-folder-chevron">${collapsed ? '▸' : '▾'}</span>
        <span class="pl-folder-name">${esc(folderName)}</span>
        <span class="pl-folder-count">${pls.length} playlist${pls.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="pl-folder-body${collapsed ? ' pl-folder-collapsed' : ''}">
        <div class="pl-grid">${pls.map(_plCard).join('')}</div>
      </div>
    </div>`
  }

  var folderSections = Object.keys(folders).sort().map(function(f) {
    return _folderSection(f, folders[f])
  })

  var contentSections = folderSections.join('')

  if (uncategorized.length && Object.keys(folders).length > 0) {
    contentSections += _folderSection('Uncategorized', uncategorized)
  }

  setContent(`<div class="page">
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
        <h1 class="section-title">Playlists</h1>
        <span class="lib-count">${sorted.length} playlist${sorted.length !== 1 ? 's' : ''}</span>
        <button class="rescan-btn" id="pl-new-folder-btn">
          <svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2z"/></svg>
          New folder
        </button>
        <button class="rescan-btn" id="pl-new-btn" style="margin-left:auto">
          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          New playlist
        </button>
        <button class="rescan-btn" id="new-smart-pl-btn">
          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          + New Smart Playlist
        </button>
        <button class="new-pl-btn" id="import-pl-btn">📥 Import</button>
        <button class="sort-btn" id="pl-sort-btn">${state.playlistSort === 'recent' ? 'Sort: Recent' : 'Sort: A-Z'}</button>
      </div>
    </div>
    ${sorted.length
      ? (Object.keys(folders).length === 0 && uncategorized.length > 0
        ? `<div class="pl-grid">${uncategorized.map(_plCard).join('')}</div>`
        : contentSections)
      : `<div class="pl-empty-state">
          <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
          <p>No playlists yet. Create one to get started.</p>
        </div>`}
  </div>`)

  document.getElementById('pl-new-folder-btn')?.addEventListener('click', function() {
    showNameInputModal('New folder', 'Folder name…', function(name) {
      if (state.playlistFolders.indexOf(name) === -1) { state.playlistFolders.push(name); _persistPlaylistFolders() }
      renderPlaylists()
      showSnackbar('Folder "' + name + '" created')
    })
  })

  document.getElementById('pl-new-btn')?.addEventListener('click', function() {
    _showNewPlaylistWithFolder()
  })

  // Folder header collapse/expand
  document.querySelectorAll('.pl-folder-header').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var body = hdr.nextElementSibling
      var chevron = hdr.querySelector('.pl-folder-chevron')
      var collapsed = body.classList.toggle('pl-folder-collapsed')
      chevron.textContent = collapsed ? '▸' : '▾'
      // Remember it: this used to be DOM-only, so every re-render expanded
      // every folder again.
      _plCollapsedFolders[hdr.dataset.folder] = collapsed
      try { localStorage.setItem('papa-pl-collapsed', JSON.stringify(_plCollapsedFolders)) } catch (_) {}
    })
  })

  // Right-click context menu on playlist cards
  document.querySelectorAll('.pl-card[data-pl]').forEach(function(card) {
    card.addEventListener('click', function() { navigate('playlist', card.dataset.pl) })
    card.addEventListener('contextmenu', async function(e) {
      e.preventDefault()
      e.stopPropagation()
      var plId = card.dataset.pl
      var pl = state.playlists.find(function(p) { return p.id === plId })
      if (!pl) return
      var items = [
        { label: 'Rename', action: 'rename' },
        { label: 'Duplicate', action: 'dup' },
        { label: pl.folder ? 'Move out of folder' : 'Move to folder…', action: 'move' },
      ]
      if (pl.folder) items.push({ label: 'Remove from folder', action: 'unfolder' })
      var existingFolders = [].concat(Object.keys(folders), state.playlistFolders).filter(function(v, i, a) { return a.indexOf(v) === i })
      var folderItems = existingFolders.map(function(f, fi) { return { label: '▸ ' + f, action: 'movefolder:' + fi } })
      var showFolderSub = false
      var action = await window.api.ctxMenuShow(items)
      if (action === 'rename') {
        showNameInputModal('Rename playlist', pl.name, function(newName) {
          pl.name = newName
          window.api.savePlaylist(pl)
          renderPlaylists()
        })
      } else if (action === 'dup') {
        var dup = JSON.parse(JSON.stringify(pl))
        dup.id = 'dup_' + Date.now()
        dup.name = pl.name + ' (copy)'
        dup.createdAt = Date.now()
        state.playlists.push(dup)
        window.api.savePlaylist(dup)
        renderPlaylists()
        showSnackbar('Playlist duplicated')
      } else if (action === 'move') {
        var subItems = [{ label: '+ New folder…', action: 'move_new' }].concat(folderItems)
        var subAction = await window.api.ctxMenuShow(subItems)
        if (subAction === 'move_new') {
          showNameInputModal('New folder', 'Folder name…', function(folderName) {
            if (state.playlistFolders.indexOf(folderName) === -1) { state.playlistFolders.push(folderName); _persistPlaylistFolders() }
            pl.folder = folderName
            window.api.savePlaylist(pl)
            renderPlaylists()
            showSnackbar('Moved to "' + folderName + '"')
          })
        } else if (subAction && subAction.indexOf('movefolder:') === 0) {
          var targetFolder = existingFolders[parseInt(subAction.slice(11), 10)]
          if (!targetFolder) return
          pl.folder = targetFolder
          window.api.savePlaylist(pl)
          renderPlaylists()
          showSnackbar('Moved to "' + targetFolder + '"')
        }
      } else if (action === 'unfolder') {
        pl.folder = null
        window.api.savePlaylist(pl)
        renderPlaylists()
        showSnackbar('Removed from folder')
      }
    })
  })
}

function _showNewPlaylistWithFolder() {
  var existingFolders = state.playlistFolders.slice()
  state.playlists.forEach(function(pl) { if (pl.folder && existingFolders.indexOf(pl.folder) === -1) existingFolders.push(pl.folder) })

  var overlay = document.createElement('div')
  overlay.id = 'new-pl-folder-modal'
  overlay.className = 'addpl-overlay'
  overlay.innerHTML = `
    <div class="addpl-card" style="max-width:360px">
      <div class="addpl-header">
        <span>New playlist</span>
        <button class="addpl-close" id="npfm-close">&#10005;</button>
      </div>
      <div style="padding:16px">
        <input id="npfm-name" class="sq-name-input" style="width:100%;box-sizing:border-box" type="text" placeholder="Playlist name…" maxlength="80" autofocus>
        <div style="margin-top:12px">
          <label style="font-size:12px;color:var(--text3);display:block;margin-bottom:4px">Folder (optional)</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="npfm-folder-select" style="flex:1;padding:6px 8px;border-radius:6px;background:var(--bg2);color:var(--text);border:1px solid var(--border);font-size:13px">
              <option value="">No folder</option>
              ${existingFolders.map(function(f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>' }).join('')}
            </select>
            <button id="npfm-new-folder-btn" style="padding:6px 10px;border-radius:6px;background:var(--bg3);color:var(--text2);border:1px solid var(--border);cursor:pointer;font-size:18px;line-height:1" title="New folder">+</button>
          </div>
        </div>
        <div id="npfm-new-folder-row" style="display:none;margin-top:8px">
          <input id="npfm-new-folder-input" class="sq-name-input" style="width:100%;box-sizing:border-box" type="text" placeholder="Folder name…" maxlength="40">
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button class="secondary" id="npfm-cancel">Cancel</button>
          <button id="npfm-ok">Create</button>
        </div>
      </div>
    </div>`
  document.body.appendChild(overlay)

  var nameInput = overlay.querySelector('#npfm-name')
  var folderSelect = overlay.querySelector('#npfm-folder-select')
  var newFolderRow = overlay.querySelector('#npfm-new-folder-row')
  var newFolderInput = overlay.querySelector('#npfm-new-folder-input')
  var close = function() { overlay.remove() }

  var confirm = function() {
    var name = (nameInput.value || '').trim()
    if (!name) { nameInput.focus(); return }
    var folder = null
    if (newFolderRow.style.display !== 'none' && newFolderInput.value.trim()) {
      folder = newFolderInput.value.trim()
      if (state.playlistFolders.indexOf(folder) === -1) { state.playlistFolders.push(folder); _persistPlaylistFolders() }
    } else if (folderSelect.value) {
      folder = folderSelect.value
    }
    close()
    var pl = { id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: name, tracks: [], createdAt: Date.now(), folder: folder }
    state.playlists.unshift(pl)
    window.api.savePlaylist(pl)
    navigate('playlist', pl.id)
  }

  overlay.querySelector('#npfm-close')?.addEventListener('click', close)
  overlay.querySelector('#npfm-cancel')?.addEventListener('click', close)
  overlay.querySelector('#npfm-ok')?.addEventListener('click', confirm)
  overlay.querySelector('#npfm-new-folder-btn')?.addEventListener('click', function() {
    newFolderRow.style.display = ''
    folderSelect.disabled = true
    newFolderInput.focus()
  })
  overlay.addEventListener('click', function(e) { if (e.target === overlay) close() })
  nameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') close() })
  newFolderInput?.addEventListener('keydown', function(e) { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') close() })
  setTimeout(function() { nameInput.focus() }, 50)
}

function renderPlaylist(id, sortKey) {
  if (sortKey) { _playlistSorts[id] = sortKey; localStorage.setItem('papa-pl-sorts', JSON.stringify(_playlistSorts)) }
  sortKey = sortKey || _playlistSorts[id] || 'default'
  const pl = state.playlists.find(p => p.id === id) ||
             state.smartPlaylists.find(p => p.id === id)
  if (!pl) { navigate('playlists', null, { skipHistory: true }); return }
  let tracks = pl.type === 'smart' ? _evalSmartPlaylist(pl) : [...(pl.tracks || [])]
  if (sortKey === 'title') tracks.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  else if (sortKey === 'artist') tracks.sort((a, b) => (a.albumArtist || a.artist || '').localeCompare(b.albumArtist || b.artist || ''))
  if (state._plSearch) {
    var q = state._plSearch
    tracks = tracks.filter(function(t) {
      return (t.title || '').toLowerCase().includes(q) ||
             (t.artist || '').toLowerCase().includes(q) ||
             (t.albumName || '').toLowerCase().includes(q)
    })
  }
  const totalDur = tracks.reduce((s, t) => s + (t.duration || 0), 0)
  const plTotalDur = (pl.tracks || []).reduce((s, t) => s + (t.duration || 0), 0)
  const durStr = fmtDur(plTotalDur)
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
  // `tracks` can be a FILTERED view holding the same object references as
  // pl.tracks, so the visible index is not the index in pl.tracks. Emitting the
  // visible index made Remove/Move-up delete or swap a completely different
  // track whenever the filter box had anything in it.
  const realIndexOf = new Map()
  ;(pl.tracks || []).forEach((t, n) => { if (!realIndexOf.has(t)) realIndexOf.set(t, n) })
  const plLen = (pl.tracks || []).length
  const trackRows = tracks.map((t, i) => {
    const ri = realIndexOf.has(t) ? realIndexOf.get(t) : i
    const isPlaying = isCurrentTrack(t.filePath)
    // In default order: use position index for up/down/remove (maps to pl.tracks)
    // In sorted view: hide reorder buttons, use filePath for remove
    const actions = isSorted
      ? `<button class="pl-track-btn" data-pl-remove-fp="${esc(t.filePath)}" title="Remove">
           <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
         </button>`
      : `<button class="pl-track-btn" data-pl-up="${ri}" title="Move up" ${ri === 0 ? 'disabled' : ''}>
           <svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5z"/></svg>
         </button>
         <button class="pl-track-btn" data-pl-down="${ri}" title="Move down" ${ri === plLen - 1 ? 'disabled' : ''}>
           <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
         </button>
         <button class="pl-track-btn" data-pl-remove="${ri}" title="Remove">
           <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
         </button>`
    return `
      <div class="track-row pl-track-row ${isPlaying ? 'playing' : ''}" data-pl-idx="${i}" data-idx="${i}" data-file="${esc(t.filePath)}" data-album="${esc(t.albumId || '')}" data-no-album-nav="1">
        <span class="track-num">${isPlaying
          ? '<div class="playing-bars"><span></span><span></span><span></span></div>'
          : (i + 1)}</span>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}${isHttpPath(t.filePath) ? ' <span class="yt-badge">YT</span>' : ''}</div>
          ${isHttpPath(t.filePath)
    ? `<div class="track-artist">${_ytArtistSpan({ artist: t.albumArtist || t.artist || '', channelId: t.channelId || null })}</div>`
    : `<div class="track-artist" data-artist="${esc(t.albumArtist || t.artist || '')}">${esc(t.albumArtist || t.artist || '')}</div>`}
        </div>
        <span class="track-dur">${fmtDur(t.duration)}</span>
        <div class="hover-actions">
          <button class="hover-action-btn" data-action="playnext" data-file="${esc(t.filePath)}" data-album="${t.albumId || ''}" title="Play next">&#9654;+</button>
          <button class="hover-action-btn" data-action="queue" data-file="${esc(t.filePath)}" data-album="${t.albumId || ''}" title="Add to queue">+</button>
        </div>
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

  var plLiked = state.likedAlbums.indexOf('pl_' + id) !== -1

  setContent(`
    <div class="album-hero pl-hero" style="background: linear-gradient(${color}cc, var(--bg) 100%)">
      ${_plCollage(pl, 'album-hero-art pl-hero-art')}
      <div class="album-hero-info">
        <div class="album-hero-type">Playlist</div>
        <div class="album-hero-title">${esc(pl.name)}</div>
        <div class="album-hero-meta">${tracks.length === (pl.tracks || []).length
          ? `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${durStr}`
          : `${tracks.length} of ${(pl.tracks || []).length} tracks · ${fmtDur(totalDur)} of ${durStr}`}</div>
      </div>
    </div>
    <div class="album-controls">
      <button class="album-play-btn" id="pl-play-btn" aria-label="Play this playlist" ${!tracks.length ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl-btn" id="pl-rename-btn" title="Rename">
        <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      </button>
      <button class="ctrl-btn" id="pl-delete-btn" title="Delete playlist">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
      <button class="ctrl-btn${plLiked ? ' active' : ''}" id="pl-fav-btn" title="Favorite playlist">♥</button>
      <button class="pl-action-btn" id="pl-export-btn">Export</button>
    </div>
    <div class="pl-sort-row">
      <span class="pl-sort-label">Sort:</span>
      <button class="pl-sort-btn${sortKey==='default'?' active':''}" data-sort="default">Default</button>
      <button class="pl-sort-btn${sortKey==='title'?' active':''}" data-sort="title">Title</button>
      <button class="pl-sort-btn${sortKey==='artist'?' active':''}" data-sort="artist">Artist</button>
    </div>
    <div class="pl-search-wrap"><input class="pl-search" id="pl-search" placeholder="Filter tracks..." value="${esc(state._plSearch || '')}"></div>
    <div class="track-list">
      ${tracks.length
        ? trackRows
        : '<div class="pl-empty-state" style="padding:40px 0"><p>This playlist is empty. Add songs from albums or the context menu.</p></div>'}
    </div>
    ${recHTML}`)

  var searchInput = document.getElementById('pl-search')
  if (searchInput) {
    var _plSearchTimer
    searchInput.addEventListener('input', function() {
      state._plSearch = this.value.toLowerCase()
      var caret = this.selectionStart
      clearTimeout(_plSearchTimer)
      _plSearchTimer = setTimeout(function () {
        renderPlaylist(id)
        var now = document.getElementById('pl-search')
        if (!now) return
        now.focus()
        try { now.setSelectionRange(caret, caret) } catch (_) {}
      }, 150)
    })
    // Only take focus if the user is actually filtering. It used to focus on
    // every render, so merely opening a playlist yanked focus into this box.
    if (state._plSearch) {
      searchInput.value = state._plSearch
      searchInput.focus()
      try { searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length) } catch (_) {}
    }
  }

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

  document.getElementById('pl-fav-btn')?.addEventListener('click', () => {
    toggleLike('pl_' + id)
    renderPlaylist(id)
  })

  document.getElementById('pl-delete-btn')?.addEventListener('click', () => {
    if (!confirm('Delete the playlist "' + pl.name + '"?\n\nThe tracks themselves are not touched.')) return
    var deletedPl = JSON.parse(JSON.stringify(pl))
    state.playlists = state.playlists.filter(p => p.id !== id)
    window.api.deletePlaylist(id)
    navigate('playlists', null, { skipHistory: true })
    showSnackbar('Playlist deleted', 'Undo', function() {
      state.playlists.push(deletedPl)
      window.api.savePlaylist(deletedPl)
      renderPlaylists()
    })
  })

  bindYtEntityLinks(document.querySelector('.track-list'))
  document.querySelectorAll('.pl-track-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.pl-track-actions')) return
      const idx = parseInt(row.dataset.plIdx, 10)
      if (!tracks[idx]) return
      // Queue the WHOLE playlist and point at the clicked track, rather than
      // slicing it off -- Previous could never reach the earlier songs.
      state.queue = tracks.map(t => ({ ...t }))
      state.queueIndex = idx
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
      var i = parseInt(btn.dataset.plRemove, 10)
      // Undo used to splice `removedTrack` back in unconditionally; with a bad
      // index that value is undefined and Undo injected a hole into the
      // playlist that later threw on esc(t.title).
      if (!Number.isInteger(i) || i < 0 || i >= pl.tracks.length) return
      var removedTrack = pl.tracks[i]
      if (!removedTrack) return
      pl.tracks.splice(i, 1)
      window.api.savePlaylist(pl)
      renderPlaylist(id)
      showSnackbar('Track removed', 'Undo', function() {
        var at = Math.min(Math.max(0, i), pl.tracks.length)
        pl.tracks.splice(at, 0, removedTrack)
        window.api.savePlaylist(pl)
        renderPlaylist(id)
      })
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
      if ((pl.tracks || []).some(function (x) { return x && x.filePath === track.filePath })) {
        showSnackbar('Already in this playlist'); return
      }
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
      <div class="track-row liked-track-row ${isPlaying ? 'playing' : ''}" data-liked-idx="${i}" data-idx="${i}" data-file="${esc(t.filePath)}" data-album="${esc(t.albumId || '')}" data-no-album-nav="1">
        <span class="track-num">${isPlaying
          ? '<div class="playing-bars"><span></span><span></span><span></span></div>'
          : (i + 1)}</span>
        <div class="track-info">
          <div class="track-title">${esc(t.title)}${t.explicit ? '<span class="track-explicit">E</span>' : ''}${surroundBadge(t.channels)}</div>
          <div class="track-artist" data-artist="${esc(t.albumArtist || t.artist || '')}">${esc(t.albumArtist || t.artist || '')}${t.bpm ? `<span class="track-bpm">${t.bpm} BPM</span>` : ''}</div>
        </div>
        ${plays > 0 ? `<span class="track-plays">${plays}</span>` : '<span class="track-plays"></span>'}
        <button class="track-like-btn liked" data-like="${esc(t.filePath)}" title="Unlike">♥</button>
        <div class="hover-actions">
          <button class="hover-action-btn" data-action="playnext" data-file="${esc(t.filePath)}" data-album="${t.albumId}" title="Play next">&#9654;+</button>
          <button class="hover-action-btn" data-action="queue" data-file="${esc(t.filePath)}" data-album="${esc(t.albumId || '')}" title="Add to queue">+</button>
          <button class="track-more-btn" title="More options" aria-label="More options for ${esc(t.title)}">&#8942;</button>
        </div>
        <span class="track-dur">${fmtDur(t.duration)}</span>
      </div>`
  }).join('')

  var totalLikedLocal = state.likedTracks.length
  var totalLikedYT = state.ytLiked.length
  var likedArtists = {}
  state.likedTracks.forEach(function(fp) {
    for (var i = 0; i < state.library.length; i++) {
      var a = state.library[i]
      if (!a.tracks) continue
      for (var j = 0; j < a.tracks.length; j++) {
        if (a.tracks[j].filePath === fp) { likedArtists[a.artist] = (likedArtists[a.artist] || 0) + 1; break }
      }
    }
  })
  var uniqueLikedArtists = Object.keys(likedArtists).length
  var likedTotalTime = 0
  state.likedTracks.forEach(function(fp) {
    for (var i = 0; i < state.library.length; i++) {
      var a = state.library[i]
      if (!a.tracks) continue
      for (var j = 0; j < a.tracks.length; j++) {
        if (a.tracks[j].filePath === fp) { likedTotalTime += (a.tracks[j].duration || 0); break }
      }
    }
  })
  var likedHours = Math.floor(likedTotalTime / 3600)
  var likedMins = Math.floor((likedTotalTime % 3600) / 60)
  var likedAvgDur = totalLikedLocal > 0 ? Math.round(likedTotalTime / totalLikedLocal) : 0
  var likedAvgMin = Math.floor(likedAvgDur / 60)
  var likedAvgSec = likedAvgDur % 60
  var analyticsHTML = '<div class="liked-analytics"><div class="liked-stat"><div class="liked-stat-val">' + totalLikedLocal + '</div><div class="liked-stat-lbl">Local Likes</div></div><div class="liked-stat"><div class="liked-stat-val">' + totalLikedYT + '</div><div class="liked-stat-lbl">YT Likes</div></div><div class="liked-stat"><div class="liked-stat-val">' + uniqueLikedArtists + '</div><div class="liked-stat-lbl">Unique Artists</div></div><div class="liked-stat"><div class="liked-stat-val">' + likedHours + 'h ' + likedMins + 'm</div><div class="liked-stat-lbl">Total Time</div></div><div class="liked-stat"><div class="liked-stat-val">' + likedAvgMin + ':' + (likedAvgSec < 10 ? '0' : '') + likedAvgSec + '</div><div class="liked-stat-lbl">Avg Length</div></div></div>'

  var likeHistory = JSON.parse(localStorage.getItem('papa_like_history') || '[]')
  var likedByDay = {}
  likeHistory.forEach(function(e) { var d = new Date(e.ts).toDateString(); likedByDay[d] = (likedByDay[d] || 0) + 1 })
  var calHTML = '<div class="liked-calendar"><div style="font-size:12px;font-weight:600;margin-bottom:8px">Like History</div><div class="liked-calendar-grid">'
  var now = new Date()
  for (var w = 11; w >= 0; w--) {
    for (var d = 6; d >= 0; d--) {
      var day = new Date(now - ((w*7+d)*86400000))
      var key = day.toDateString()
      var count = likedByDay[key] || 0
      var lvl = count >= 5 ? 'l4' : count >= 3 ? 'l3' : count >= 2 ? 'l2' : count > 0 ? 'l1' : ''
      calHTML += '<div class="liked-calendar-day' + (lvl ? ' ' + lvl : '') + '" title="' + key + ': ' + count + ' like' + (count !== 1 ? 's' : '') + '"></div>'
    }
  }
  calHTML += '</div></div>'

  setContent(`
    <div class="album-hero" style="background: linear-gradient(#5038a0cc, var(--bg) 100%)">
      <div class="album-hero-art-fallback" style="display:flex;background:linear-gradient(135deg,#4338a0,#a0387a)"><svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>
      <div class="album-hero-info">
        <div class="album-hero-type">Auto Playlist</div>
        <div class="album-hero-title">Liked Songs</div>
        <div class="album-hero-meta">${totalCount} song${totalCount !== 1 ? 's' : ''}${totalCount ? `, ${fmtTime(totalDur)}` : ''}</div>
      </div>
    </div>
    ${analyticsHTML}
    ${calHTML}
    <div class="album-controls">
      <button class="album-play-btn" id="liked-play-btn" aria-label="Play liked songs" ${!totalCount ? 'disabled' : ''}>
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
              <div class="track-artist">${_ytArtistSpan(t)}</div>
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
    bindYtEntityLinks(ytList)
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
  const recent = (state.playHistory || []).filter(function(h) { return (h.ts || 0) >= cutoff })

  let totalSecs = 0
  for (const h of recent) {
    const t = byPath.get(h.filePath)
    if (t) totalSecs += (t.duration || 0)
  }
  const hours = Math.floor(totalSecs / 3600)
  const mins  = Math.floor((totalSecs % 3600) / 60)

  // History written before duration was recorded has none, so fall back to the
  // library's duration for that path. Without this the all-time figure read
  // "0h 0m" for every user, forever.
  var _durByPath = {}
  state.library.forEach(function (a) {
    ;(a.tracks || []).forEach(function (t) { if (t.filePath) _durByPath[t.filePath] = t.duration || 0 })
  })
  var _histDur = function (p) { return p.duration || _durByPath[p.filePath] || 0 }

  var totalAllTime = 0
  state.playHistory.forEach(function(p) { totalAllTime += _histDur(p) })
  var totalDays = Math.floor(totalAllTime / 86400)
  var totalHrs = Math.floor((totalAllTime % 86400) / 3600)
  var totalAllTimeStr = totalDays > 0 ? totalDays + 'd ' + totalHrs + 'h' : totalHrs + 'h ' + Math.floor((totalAllTime % 3600) / 60) + 'm'

  var rangeStart = new Date(cutoff).toLocaleDateString()
  var rangeText = state.statsRange === 'all' ? 'All time' : rangeStart + ' — Today'
  var rangeLabel = state.statsRange === 'week' ? 'This Week' : state.statsRange === 'month' ? 'This Month' : state.statsRange === 'year' ? 'This Year' : 'All Time'

  const artistCounts = {}
  for (const h of recent) {
    const a = h.artist || (byPath.get(h.filePath)?.albumArtist) || 'Unknown'
    artistCounts[a] = (artistCounts[a] || 0) + 1
  }
  const topArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)

  // All-time, unlike the 30-day sections around it: playCounts carries no
  // timestamps to window on. Labelled in the UI so the two are not read as
  // comparable.
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
      ${ap ? `<img class="stats-rank-art" src="${esc('file://' + ap)}" alt="">` : '<div class="stats-rank-art"></div>'}
      <div class="stats-rank-info"><div class="stats-rank-name">${esc(name)}</div></div>
      <span class="stats-rank-count">${count} play${count !== 1 ? 's' : ''}</span>
    </div>`
  }).join('') || '<div class="stats-rank-sub" style="padding:8px 0">No plays yet this month.</div>'

  const trackRows = topTracks.map(({ track, count }, i) => `
    <div class="stats-rank-row" data-stats-album="${esc(track.albumId || '')}">
      <span class="stats-rank-num">${i + 1}</span>
      ${track.artPath ? `<img class="stats-rank-art" src="${esc('file://' + track.artPath)}" alt="">` : '<div class="stats-rank-art"></div>'}
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

  // Built from ALL history, not the 30-day window, so a 40-day streak no longer
  // reports 30. And the walk may start at YESTERDAY: keying off today alone
  // meant that at 00:01, before you had played anything, the streak read 0 and
  // "Dedicated (7-day streak)" un-earned itself every midnight.
  var daysSet = {}
  state.playHistory.forEach(function (p) { daysSet[new Date(p.ts).toDateString()] = true })
  var currentStreak = 0
  var checkDay = new Date()
  if (!daysSet[checkDay.toDateString()]) checkDay.setDate(checkDay.getDate() - 1)
  while (daysSet[checkDay.toDateString()]) { currentStreak++; checkDay.setDate(checkDay.getDate() - 1) }

  var achievements = [
    { id:'century', icon:'💯', name:'Century', desc:'100 albums played', check:function() { var ids = {}; recent.forEach(function(p) { for (var i = 0; i < state.library.length; i++) { var a = state.library[i]; if (a.tracks) for (var j = 0; j < a.tracks.length; j++) { if (a.tracks[j].filePath === p.filePath) { ids[a.id] = true } } } }); return Object.keys(ids).length >= 100 } },
    { id:'marathon', icon:'🏃', name:'Marathon', desc:'5+ hours in one day', check:function() { var byDay = {}; recent.forEach(function(p) { var d = new Date(p.ts).toDateString(); byDay[d] = (byDay[d] || 0) + (p.duration || 0) }); return Object.values(byDay).some(function(s) { return s >= 18000 }) } },
    { id:'explorer', icon:'🌍', name:'Explorer', desc:'50 different artists', check:function() { var artists = {}; recent.forEach(function(p) { artists[p.artist || 'Unknown'] = true }); return Object.keys(artists).length >= 50 } },
    { id:'nightowl', icon:'🦉', name:'Night Owl', desc:'Most listening after midnight', check:function() { var night = 0, day = 0; recent.forEach(function(p) { var h = new Date(p.ts).getHours(); if (h >= 0 && h < 6) night++; else day++ }); return night > day && recent.length > 10 } },
    { id:'completist', icon:'✅', name:'Completionist', desc:'Finished 20 albums', check:function() { var byAlbum = {}; recent.forEach(function(p) { for (var i = 0; i < state.library.length; i++) { var a = state.library[i]; if (a.tracks) { var ti = -1; for (var j = 0; j < a.tracks.length; j++) { if (a.tracks[j].filePath === p.filePath) { ti = j; break } } if (ti >= 0) byAlbum[a.id] = Math.max(byAlbum[a.id] || 0, ti + 1) } } }); var count = 0; Object.keys(byAlbum).forEach(function(id) { var a = state.library.find(function(x) { return x.id === id }); if (a && a.tracks && byAlbum[id] >= a.tracks.length) count++ }); return count >= 20 } },
    { id:'firstplay', icon:'🎵', name:'First Play', desc:'Played your first track', check:function() { return recent.length > 0 } },
    { id:'collector', icon:'📚', name:'Collector', desc:'200+ albums in library', check:function() { return state.library.length >= 200 } },
    { id:'dedicated', icon:'🔥', name:'Dedicated', desc:'7-day listening streak', check:function() { return currentStreak >= 7 } },
    { id:'earlybird', icon:'🌅', name:'Early Bird', desc:'Most listening before 9 AM', check:function() { var am=0,pm=0; recent.forEach(function(p){var h=new Date(p.ts).getHours();if(h>=5&&h<9)am++;else pm++});return am>pm&&recent.length>10} },
    { id:'binger', icon:'📺', name:'Binge Listener', desc:'10+ hours in one day', check:function() { var byDay={};recent.forEach(function(p){var d=new Date(p.ts).toDateString();byDay[d]=(byDay[d]||0)+_histDur(p)});return Object.values(byDay).some(function(s){return s>=36000})} },
    { id:'variety', icon:'🎨', name:'Variety Listener', desc:'20+ genres explored', check:function() { var genres={};recent.forEach(function(p){for(var i=0;i<state.library.length;i++){var a=state.library[i];if(!a.tracks)continue;for(var j=0;j<a.tracks.length;j++){if(a.tracks[j].filePath===p.filePath&&a.genre){genres[a.genre]=true}}} });return Object.keys(genres).length>=20} },
    { id:'throwback', icon:'📼', name:'Throwback', desc:'Most listening is pre-2000', check:function() { var old=0,nu=0;recent.forEach(function(p){for(var i=0;i<state.library.length;i++){var a=state.library[i];if(!a.tracks)continue;for(var j=0;j<a.tracks.length;j++){if(a.tracks[j].filePath===p.filePath){if((a.year||0)>0&&a.year<2000)old++;else nu++;break}}}});return old>nu&&recent.length>10} },
    { id:'globetrotter', icon:'🗺️', name:'Globetrotter', desc:'Music from 10+ countries', check:function() { var countries={};recent.forEach(function(p){for(var i=0;i<state.library.length;i++){var a=state.library[i];if(!a.tracks)continue;for(var j=0;j<a.tracks.length;j++){if(a.tracks[j].filePath===p.filePath){var parts=(a.tracks[j].filePath||'').split('/');countries[parts[3]||parts[2]||'']=true;break}}}});return Object.keys(countries).length>=10} },
    { id:'newbie', icon:'👋', name:'Newbie', desc:'First day listening', check:function() { return recent.length > 0 && state.playHistory.length <= 50 } },
    { id:'hundred', icon:'💯', name:'Century+', desc:'1000+ tracks played', check:function() { return state.playHistory.length >= 1000 } },
    { id:'library50', icon:'📀', name:'Growing Library', desc:'50+ albums', check:function() { return state.library.length >= 50 } },
    { id:'library100', icon:'💿', name:'Serious Collector', desc:'100+ albums', check:function() { return state.library.length >= 100 } },
    { id:'library500', icon:'🏛️', name:'Archive', desc:'500+ albums', check:function() { return state.library.length >= 500 } },
    { id:'flac50', icon:'🎧', name:'Audiophile', desc:'50+ FLAC albums', check:function() { return state.library.filter(function(a){return a.tracks&&a.tracks[0]&&a.tracks[0].filePath&&a.tracks[0].filePath.toLowerCase().endsWith('.flac')}).length >= 50 } },
    { id:'liked100', icon:'❤️', name:'Lover', desc:'100+ liked tracks', check:function() { return state.likedTracks.length >= 100 } },
    { id:'liked500', icon:'💕', name:'Devoted', desc:'500+ liked tracks', check:function() { return state.likedTracks.length >= 500 } },
    { id:'artist10', icon:'🎤', name:'Fan', desc:'10+ followed artists', check:function() { return (state.followedArtists||[]).length >= 10 } },
    { id:'playlist5', icon:'📋', name:'Curator', desc:'5+ playlists', check:function() { return (state.playlists||[]).length >= 5 } },
    { id:'insomniac', icon:'😴', name:'Insomniac', desc:'Listening at 3-5 AM', check:function() { var late=0,total=0;recent.forEach(function(p){var h=new Date(p.ts).getHours();if(h>=3&&h<5)late++;total++});return total>0&&(late/total)>.1} },
    { id:'weekend', icon:'🎉', name:'Weekend Warrior', desc:'Most listening on Fri/Sat', check:function() { var wknd=0,wkdy=0;recent.forEach(function(p){var d=new Date(p.ts).getDay();if(d===5||d===6)wknd++;else wkdy++});return wknd>wkdy&&recent.length>20} },
    { id:'lunchbreak', icon:'🍽️', name:'Lunch Break', desc:'Most listening at noon', check:function() { var noon=0,other=0;recent.forEach(function(p){var h=new Date(p.ts).getHours();if(h===12)noon++;else other++});return noon>other&&recent.length>10} },
    { id:'diversegenre', icon:'🌈', name:'Genre Explorer', desc:'5+ different genres this week', check:function() { var weekAgo=Date.now()-604800000;var genres={};recent.filter(function(p){return p.ts>weekAgo}).forEach(function(p){for(var i=0;i<state.library.length;i++){var a=state.library[i];if(!a.tracks)continue;for(var j=0;j<a.tracks.length;j++){if(a.tracks[j].filePath===p.filePath&&a.genre){genres[a.genre]=true}}}});return Object.keys(genres).length>=5} },
    { id:'longesttrack', icon:'📏', name:'Long Haul', desc:'Played a track >15 min', check:function() { return recent.some(function(p){for(var i=0;i<state.library.length;i++){var a=state.library[i];if(!a.tracks)continue;for(var j=0;j<a.tracks.length;j++){if(a.tracks[j].filePath===p.filePath&&(a.tracks[j].duration||0)>900)return true}};return false})} },
    { id:'shortesttrack', icon:'⚡', name:'Quick Hit', desc:'Played a track <30 sec', check:function() { return recent.some(function(p){for(var i=0;i<state.library.length;i++){var a=state.library[i];if(!a.tracks)continue;for(var j=0;j<a.tracks.length;j++){if(a.tracks[j].filePath===p.filePath&&(a.tracks[j].duration||0)>0&&(a.tracks[j].duration||0)<30)return true}};return false})} },
    { id:'repeatlistener', icon:'🔂', name:'On Repeat', desc:'Same track 3+ times in one day', check:function() { var byDay={};recent.forEach(function(p){var d=new Date(p.ts).toDateString();byDay[d]=byDay[d]||{};byDay[d][p.filePath]=(byDay[d][p.filePath]||0)+1});return Object.values(byDay).some(function(day){return Object.values(day).some(function(c){return c>=3})})} },
    { id:'skiphappy', icon:'⏭️', name:'Skip Happy', _needsPosition:true, desc:'Average track plays <60%', check:function() { var total=0,full=0;recent.forEach(function(p){total++;if((_histDur(p)||0)>0){var playPct=(p.position||0)/(p.duration||0);if(playPct>.8)full++}});return total>10&&(full/total)<.6} },
    { id:'completelistener', icon:'✅', name:'Completionist+', _needsPosition:true, desc:'Finish 80%+ of tracks', check:function() { var total=0,full=0;recent.forEach(function(p){total++;if((_histDur(p)||0)>0){if((p.position||0)/(p.duration||0)>.8)full++}});return total>10&&(full/total)>.8} },
    { id:'happyhour', icon:'🍸', name:'Happy Hour', desc:'Most listening 5-7 PM', check:function() { var hh=0,other=0;recent.forEach(function(p){var h=new Date(p.ts).getHours();if(h>=17&&h<19)hh++;else other++});return hh>other&&recent.length>10} },
  ]
  // Nothing records how far into a track playback got, so any achievement that
  // needs it cannot be judged. They used to resolve anyway -- "Skip Happy" was
  // awarded to every user with more than 10 plays, purely because the missing
  // field made its ratio 0.
  var _hasPosition = state.playHistory.some(function (p) { return p.position != null })
  var earned = achievements.filter(function(a) {
    if (a._needsPosition && !_hasPosition) return false
    return a.check()
  })
  var achHTML = earned.length ? '<div class="stats-section"><div class="section-title">Achievements</div><div class="stats-achievements">' + earned.map(function(a) { return '<div class="ach-badge earned"><div class="ach-icon">' + a.icon + '</div><div class="ach-name">' + a.name + '</div><div class="ach-desc">' + a.desc + '</div></div>' }).join('') + '</div></div>' : ''

  // Build a day -> play-count map from ALL history, not the 30-day `recent`
  // window. The grid spans 53 weeks, so keying it off `recent` left eleven of
  // twelve months permanently blank AND captioned "no plays" -- actively wrong.
  // Counting here also replaces a full history re-scan per lit cell below.
  var dayCounts = {}
  state.playHistory.forEach(function (p) {
    var k = new Date(p.ts).toDateString()
    dayCounts[k] = (dayCounts[k] || 0) + 1
  })
  var calHTML = '<div class="stats-section"><div class="section-title">Listening Calendar</div><div class="stats-calendar"><div class="stats-calendar-grid">'
  var now = new Date()
  for (var w = 52; w >= 0; w--) {
    for (var d = 6; d >= 0; d--) {
      var day = new Date(now - ((w * 7 + d) * 86400000))
      var key = day.toDateString()
      var level = 0
      var dayPlays = dayCounts[key] || 0
      if (dayPlays) {
        if (dayPlays >= 16) level = 4
        else if (dayPlays >= 6) level = 3
        else if (dayPlays >= 2) level = 2
        else level = 1
      }
      calHTML += '<div class="stats-calendar-day d' + level + '" title="' + key + ': ' + (dayPlays ? dayPlays + ' play' + (dayPlays !== 1 ? 's' : '') : 'no plays') + '"></div>'
    }
  }
  calHTML += '</div></div></div>'

  var weekMs = 7 * 86400000
  var monthMs = 30 * 86400000
  var weekSecs = 0
  state.playHistory.forEach(function(p) {
    if (p.ts > Date.now() - weekMs) weekSecs += _histDur(p)
  })
  var weekHours = Math.floor(weekSecs / 3600)
  var weekMins = Math.floor((weekSecs % 3600) / 60)

  var monthArtistCounts = {}
  state.playHistory.forEach(function(p) {
    if (p.ts > Date.now() - monthMs && p.artist) {
      monthArtistCounts[p.artist] = (monthArtistCounts[p.artist] || 0) + 1
    }
  })
  var topMonthArtists = Object.entries(monthArtistCounts).sort(function(a, b) { return b[1] - a[1] }).slice(0, 5)
  var maxMonthArtist = topMonthArtists.length ? topMonthArtists[0][1] : 1

  var libGenreCounts = {}
  state.library.forEach(function(a) {
    if (a.genre) libGenreCounts[a.genre] = (libGenreCounts[a.genre] || 0) + 1
  })
  var topLibGenres = Object.entries(libGenreCounts).sort(function(a, b) { return b[1] - a[1] }).slice(0, 8)
  var maxLibGenre = topLibGenres.length ? topLibGenres[0][1] : 1

  var hourlyData = new Array(24).fill(0)
  recent.forEach(function(p) { var h = new Date(p.ts).getHours(); hourlyData[h]++ })
  var maxHourly = Math.max.apply(null, hourlyData) || 1
  var hourLabels = ['12a','1a','2a','3a','4a','5a','6a','7a','8a','9a','10a','11a','12p','1p','2p','3p','4p','5p','6p','7p','8p','9p','10p','11p']
  var heatmapHTML = '<div class="stats-section"><div class="section-title">Listening by Hour</div><div style="display:flex;align-items:flex-end;gap:1px;height:80px;padding:0 28px;margin-bottom:20px">'
  hourlyData.forEach(function(count, h) {
    var height = Math.max(2, Math.round((count / maxHourly) * 80))
    var tooltip = hourLabels[h] + ': ' + count + ' plays'
    heatmapHTML += '<div style="flex:1;background:var(--accent);height:' + height + 'px;border-radius:1px 1px 0 0;opacity:' + (0.3 + (count/maxHourly)*0.7) + '" title="' + tooltip + '"></div>'
  })
  heatmapHTML += '</div></div>'

  setContent(`<div class="stats-page">
    <div class="stats-toolbar" style="display:flex;gap:8px;margin-bottom:16px;padding:0 28px">
      <button id="export-json-btn" class="secondary" style="padding:6px 14px;font-size:12px">Export JSON</button>
      <button id="export-csv-btn" class="secondary" style="padding:6px 14px;font-size:12px">Export CSV</button>
    </div>
    <div class="stats-hero">Listening time (${rangeLabel})<span>${hours}h ${mins}m</span><div style="font-size:12px;color:var(--text3);margin-top:4px">All time: ${totalAllTimeStr}</div><div style="font-size:11px;color:var(--text3);margin-top:4px">${rangeText}</div></div>
    <div class="stats-section">
      <h2>This Week</h2>
      <div class="stats-hero" style="margin:0;padding:16px 20px;font-size:13px">Listening time<span>${weekHours}h ${weekMins}m</span></div>
    </div>
    <div class="stats-section">
      <h2>Top Artist This Month</h2>
      ${topMonthArtists.length ? topMonthArtists.map(function (entry, i) {
        var ap = artFor(entry[0])
        return '<div class="stats-rank-row" data-stats-artist="' + esc(entry[0]) + '">' +
          '<span class="stats-rank-num">' + (i + 1) + '</span>' +
          (ap ? '<img class="stats-rank-art" src="' + esc('file://' + ap) + '" alt="">' : '<div class="stats-rank-art"></div>') +
          '<div class="stats-rank-info"><div class="stats-rank-name">' + esc(entry[0]) + '</div></div>' +
          '<span class="stats-rank-count">' + entry[1] + ' play' + (entry[1] !== 1 ? 's' : '') + '</span>' +
          '</div>'
      }).join('') : '<div class="stats-rank-sub" style="padding:8px 0">No plays yet this month.</div>'}
    </div>
    <div class="stats-section">
      <h2>Library Genres</h2>
      ${topLibGenres.length ? topLibGenres.map(function (entry) {
        return '<div class="stats-genre-bar">' +
          '<span class="stats-genre-name">' + esc(entry[0]) + '</span>' +
          '<div class="stats-genre-track"><div class="stats-genre-fill" style="width:' + Math.round(entry[1] / maxLibGenre * 100) + '%"></div></div>' +
          '<span class="stats-genre-ct">' + entry[1] + '</span>' +
          '</div>'
      }).join('') : '<div class="stats-rank-sub">No genre data yet.</div>'}
    </div>
    ${achHTML}${calHTML}${heatmapHTML}
    <div class="stats-section">
      <h2>Top Artists</h2>
      ${artistRows}
    </div>
    <div class="stats-section">
      <h2>Top Tracks <span class="stats-range-note">all time</span></h2>
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
  var exportJsonBtn = document.getElementById('export-json-btn')
  var exportCsvBtn = document.getElementById('export-csv-btn')
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', function() { exportStats('json') })
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', function() { exportStats('csv') })
}

function exportStats(format) {
  var data = {
    generated: new Date().toISOString(),
    totalTracks: 0,
    totalAlbums: state.library.length,
    totalDuration: 0,
    topArtists: [],
    topGenres: [],
    playHistory: (state.playHistory || []).slice(0, 100),
  }

  state.library.forEach(function(a) {
    if (!a.tracks) return
    data.totalTracks += a.tracks.length
    a.tracks.forEach(function(t) { data.totalDuration += t.duration || 0 })
  })

  var artistCounts = {}
  state.playHistory.forEach(function(p) {
    if (p.artist) artistCounts[p.artist] = (artistCounts[p.artist] || 0) + 1
  })
  data.topArtists = Object.entries(artistCounts).sort(function(a, b) { return b[1] - a[1] }).slice(0, 10).map(function(entry) { return { name: entry[0], count: entry[1] } })

  var genreCounts = {}
  state.library.forEach(function(a) {
    if (a.genre) genreCounts[a.genre] = (genreCounts[a.genre] || 0) + 1
  })
  data.topGenres = Object.entries(genreCounts).sort(function(a, b) { return b[1] - a[1] }).slice(0, 10).map(function(entry) { return { name: entry[0], count: entry[1] } })

  var content = format === 'csv' ? jsonToCsv(data) : JSON.stringify(data, null, 2)
  var blob = new Blob([content], { type: format === 'csv' ? 'text/csv' : 'application/json' })
  var url = URL.createObjectURL(blob)
  var a = document.createElement('a')
  a.href = url
  a.download = 'papa-audio-stats.' + format
  a.click()
  URL.revokeObjectURL(url)
}

function jsonToCsv(data) {
  // RFC 4180: wrap anything containing a comma, quote or newline, and double
  // the inner quotes. "Crosby, Stills & Nash" used to shift every later column.
  function q(v) {
    var s = String(v == null ? '' : v)
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  var lines = []
  lines.push('Generated,' + data.generated)
  lines.push('Total Albums,' + data.totalAlbums)
  lines.push('Total Tracks,' + data.totalTracks)
  lines.push('Total Hours,' + (data.totalDuration / 3600).toFixed(1))
  lines.push('')
  lines.push('Top Artists')
  for (var i = 0; i < data.topArtists.length; i++) {
    lines.push(q(data.topArtists[i].name) + ',' + data.topArtists[i].count)
  }
  lines.push('')
  lines.push('Top Genres')
  for (var j = 0; j < data.topGenres.length; j++) {
    lines.push(q(data.topGenres[j].name) + ',' + data.topGenres[j].count)
  }
  lines.push('')
  lines.push('Play History (last 100)')
  lines.push('Artist,Title,Time')
  for (var k = 0; k < data.playHistory.length; k++) {
    var p = data.playHistory[k]
    lines.push(q(p.artist) + ',' + q(p.title) + ',' + (p.ts ? new Date(p.ts).toISOString() : ''))
  }
  return lines.join('\n')
}

function showNameInputModal(title, placeholder, onConfirm, confirmLabel) {
  // The button always said "Create", including from the three "Rename playlist"
  // call sites. Derive it from the title when the caller does not say.
  confirmLabel = confirmLabel || (/rename/i.test(String(title)) ? 'Rename' : 'Create')
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
          <button id="nim-ok">${esc(confirmLabel)}</button>
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

function showSmartPlaylistDialog(existing) {
  var fields = ['artist', 'album', 'genre', 'year', 'format', 'playCount']
  var ops = ['is', 'contains', 'gt', 'lt', 'gte', 'lte']

  var html = '<div class="modal-overlay" id="smart-pl-modal"><div class="modal-box">' +
    '<h3 style="margin:0 0 12px">' + (existing ? 'Edit' : 'New') + ' Smart Playlist</h3>' +
    '<input id="sp-name" placeholder="Playlist name" value="' + esc((existing && existing.name) || '') + '" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:14px">' +
    '<div id="sp-rules" style="display:flex;flex-direction:column;gap:6px">' +
    ((existing && existing.rules) || [{field:'genre',op:'is',value:''}]).map(function(r, i) {
      return '<div class="sp-rule" style="display:flex;gap:6px;align-items:center">' +
        '<select class="sp-field" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">' + fields.map(function(f) { return '<option' + (r.field===f?' selected':'') + '>' + f + '</option>' }).join('') + '</select>' +
        '<select class="sp-op" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">' + ops.map(function(o) { return '<option' + (r.op===o?' selected':'') + '>' + o + '</option>' }).join('') + '</select>' +
        '<input class="sp-val" value="' + esc(r.value) + '" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">' +
        '<button class="sp-remove-rule" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:2px 6px">&times;</button></div>'
    }).join('') + '</div>' +
    '<button id="sp-add-rule" style="margin-top:8px;background:none;border:1px dashed var(--border);color:var(--text2);cursor:pointer;padding:6px 12px;border-radius:8px;font-size:13px;width:100%">+ Add rule</button>' +
    '<div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">' +
    '<button id="sp-cancel">Cancel</button>' +
    '<button id="sp-save" class="primary">Save</button></div></div></div>'

  var overlay = document.createElement('div')
  overlay.innerHTML = html
  document.body.appendChild(overlay)

  document.getElementById('sp-add-rule').addEventListener('click', function() {
    var container = document.getElementById('sp-rules')
    var div = document.createElement('div')
    div.className = 'sp-rule'
    div.style.cssText = 'display:flex;gap:6px;align-items:center'
    div.innerHTML = '<select class="sp-field" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">' + fields.map(function(f) { return '<option>' + f + '</option>' }).join('') + '</select>' +
      '<select class="sp-op" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">' + ops.map(function(o) { return '<option>' + o + '</option>' }).join('') + '</select>' +
      '<input class="sp-val" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">' +
      '<button class="sp-remove-rule" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:2px 6px">&times;</button>'
    container.appendChild(div)
  })

  document.getElementById('sp-save').addEventListener('click', function() {
    var name = document.getElementById('sp-name').value.trim()
    if (!name) { document.getElementById('sp-name').focus(); return }
    var rules = []
    document.querySelectorAll('.sp-rule').forEach(function(row) {
      rules.push({
        field: row.querySelector('.sp-field').value,
        op: row.querySelector('.sp-op').value,
        value: row.querySelector('.sp-val').value.trim()
      })
    })
    if (existing) {
      var idx = state.smartPlaylists.indexOf(existing)
      if (idx !== -1) {
        existing.name = name
        existing.rules = rules
        state.smartPlaylists[idx] = existing
      }
    } else {
      state.smartPlaylists.push({ id: 'sp_' + Date.now(), name: name, type: 'smart', rules: rules, createdAt: Date.now() })
    }
    localStorage.setItem('papa-smart-playlists', JSON.stringify(state.smartPlaylists))
    renderPlaylists()
    document.getElementById('smart-pl-modal').remove()
  })

  document.getElementById('sp-cancel').addEventListener('click', function() {
    document.getElementById('smart-pl-modal').remove()
  })

  document.getElementById('sp-rules').addEventListener('click', function(e) {
    if (e.target.classList.contains('sp-remove-rule')) {
      e.target.closest('.sp-rule').remove()
    }
  })

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay && e.target.className === 'modal-overlay') {
      overlay.remove()
    }
  })
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
    // Adding the same track twice used to silently double it, with no feedback
    // at all -- from Home you could not tell the add had happened.
    const have = new Set(pl.tracks.map(t => t && t.filePath).filter(Boolean))
    const fresh = slim.filter(t => !t.filePath || !have.has(t.filePath))
    const dupes = slim.length - fresh.length
    pl.tracks.push(...fresh)
    window.api.savePlaylist(pl)
    close()
    showSnackbar(fresh.length
      ? 'Added ' + fresh.length + ' track' + (fresh.length === 1 ? '' : 's') + ' to "' + pl.name + '"' +
        (dupes ? ' (' + dupes + ' already there)' : '')
      : 'Already in "' + pl.name + '"')
    if (state.currentPage === 'playlist' && state.currentPlaylistId === pl.id) renderPlaylist(pl.id)
    if (state.currentPage === 'playlists') renderPlaylists()
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  const onEsc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) } }
  document.addEventListener('keydown', onEsc)
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
  const likeBtn = document.getElementById('btn-like')
  const currentTrack = state.queue[state.queueIndex]
  const album = currentTrack && state.library.find(a => a.tracks.some(t => t.filePath === currentTrack.filePath))
  if (!likeBtn) return
  if (!album) {
    likeBtn.classList.remove('liked')
    delete likeBtn.dataset.album
    return
  }
  likeBtn.classList.toggle('liked', state.likedAlbums.includes(album.id))
  likeBtn.dataset.album = album.id
}

// ── Queue panel ─────────────────────────────────────────────────────────────
function toggleQueuePanel() {
  state.queuePanelOpen = !state.queuePanelOpen
  updateAriaToggles()
  const panel = document.getElementById('queue-panel')
  const btn   = document.getElementById('btn-queue')
  panel.classList.toggle('open', state.queuePanelOpen)
  if (btn) btn.classList.toggle('active', state.queuePanelOpen)
  if (state.queuePanelOpen) renderQueuePanel()
}

function renderQueuePanel() {
  var qBtn = document.getElementById('btn-queue')
  if (qBtn) qBtn.title = state.queue.length + ' tracks in queue'
  const list = document.getElementById('queue-list')
  if (!list) return
  const curTrack = state.queue[state.queueIndex]
  const fromName = curTrack?.albumName || ''
  var autoHtml = `<div class="queue-autoplay-row">
    <span>Autoplay similar when queue ends</span>
    <button class="queue-autoplay-toggle${autoplayEnabled() ? ' on' : ''}" id="queue-autoplay-toggle">${autoplayEnabled() ? 'On' : 'Off'}</button>
  </div>`
  var queueInfo = state._restoredFromQueue ? '<div style="padding:6px 12px;font-size:11px;color:var(--text3);text-align:center">Restored from previous session</div>' : ''
  const fromHtml = autoHtml + queueInfo + (fromName
    ? `<div class="queue-from">Playing from <span class="queue-from-name">${esc(fromName)}</span></div>`
    : '')
  var qp = document.getElementById('queue-panel')
  var st = qp ? qp.scrollTop : 0
  if (!state.queue.length) {
    list.innerHTML = fromHtml + `<div style="padding:20px 16px; color:var(--text3); font-size:13px;">Nothing in queue</div>`
    document.getElementById('queue-autoplay-toggle')?.addEventListener('click', () => {
      setAutoplay(!autoplayEnabled())
      renderQueuePanel()
    })
    var qp2 = document.getElementById('queue-panel')
    if (qp2) qp2.scrollTop = st
    return
  }

  var dragHandleSvg = `<svg viewBox="0 0 24 24"><path d="M9 4h2v2H9zm4 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zM9 14h2v2H9zm4 0h2v2h-2z"/></svg>`
  var removeSvg     = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`

  var totalQD = state.queue.reduce(function(s, t) { return s + (t.duration || 0) }, 0)
  var totalQDstr = fmtDur(totalQD)

  list.innerHTML = fromHtml + '<div style="padding:12px;font-size:13px;font-weight:600;display:flex;justify-content:space-between"><span>Queue (' + state.queue.length + ')</span><span style="font-size:11px;color:var(--text3);font-weight:400">' + totalQDstr + '</span></div>' + state.queue.map((t, i) => {
    const isPlaying = i === state.queueIndex
    const art = t.artPath
      ? `<img class="queue-row-art" src="${esc('file://' + t.artPath)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
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
    if (state.queue.length === 0) return
    // Was a native confirm(), which blocks the renderer and mpv's IPC
    // callbacks in a frameless app that uses its own dialogs everywhere else.
    // This action is already undoable, so the prompt bought nothing.
    var savedQueue = state.queue.slice(), savedIdx = state.queueIndex
    audio.pause()
    state.queue = []; state.queueIndex = -1; state.isPlaying = false
    state._restoredFromQueue = false
    updateNextPrefetch()
    updatePlayBtn(); updateNowPlaying(null)
    renderQueuePanel()
    pushUndo('Queue cleared', function() {
      state.queue = savedQueue; state.queueIndex = savedIdx
      if (state.queuePanelOpen) renderQueuePanel()
    })
  })
  list.appendChild(clearBtn)

  // Autoplay toggle
  document.getElementById('queue-autoplay-toggle')?.addEventListener('click', () => {
    setAutoplay(!autoplayEnabled())
    renderQueuePanel()
  })

  // Click to play
  // Queue rows had no context menu; "Remove from queue" belongs here, and must
  // read as removing from the queue, not deleting the file.
  list.querySelectorAll('.queue-row').forEach(row => {
    row.addEventListener('contextmenu', e => {
      const t = state.queue[parseInt(row.dataset.queueIdx)]
      if (!t) return
      showContextMenu(e, { type: 'track', kind: 'queue-item', albumId: t.albumId,
        track: t, artist: t.albumArtist || t.artist, queueIdx: parseInt(row.dataset.queueIdx) })
    })
  })

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
      var idx = parseInt(btn.dataset.removeIdx, 10)
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.queue.length) return
      var removedQTrack = state.queue[idx]
      var prevIndex = state.queueIndex
      state.queue.splice(idx, 1)
      if (idx < state.queueIndex) state.queueIndex--
      else if (idx === state.queueIndex) {
        // Removing the LAST track while it was playing left queueIndex pointing
        // past the end: playCurrentTrack() found undefined and returned
        // silently, so the old track kept playing, the player bar still showed
        // it, and the panel highlighted nothing. Clamp before deciding.
        if (state.queueIndex >= state.queue.length) state.queueIndex = state.queue.length - 1
        if (state.queue.length && state.queue[state.queueIndex]) playCurrentTrack()
        else { audio.pause(); state.isPlaying = false; state.queueIndex = -1; updatePlayBtn(); updateNowPlaying(null) }
      }
      // The shuffle prefetch caches an INDEX and hands mpv a file; removing a
      // track can leave the removed file itself queued as "next".
      _pendingShuffle = null
      updateNextPrefetch()
      renderQueuePanel()
      pushUndo('Removed from queue', function() {
        state.queue.splice(idx, 0, removedQTrack)
        // Restore where playback was pointing, not just the array.
        state.queueIndex = prevIndex
        _pendingShuffle = null
        updateNextPrefetch()
        if (state.queuePanelOpen) renderQueuePanel()
      })
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
      // computeNextIndex() caches _pendingShuffle as an INDEX and mpv has
      // already been handed that file. After a reorder that index points at a
      // different track, so the wrong song plays next while the highlight says
      // otherwise. The Clear handler already does this; reorder did not.
      _pendingShuffle = null
      updateNextPrefetch()
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
              ? `<img class="queue-suggestion-art" src="${esc('file://' + t.artPath)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="queue-suggestion-art-fb" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>`
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
  var qp3 = document.getElementById('queue-panel')
  if (qp3) qp3.scrollTop = st
}

function addToQueue(album, tracksOverride) {
  _oldQueue = null
  state._restoredFromQueue = false
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
  modal.classList.remove('art-expanded')
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

  if (!modal._tooltipWired) {
    modal._tooltipWired = true
    const modalTrack = document.getElementById('np-modal-track')
    if (modalTrack) {
      modalTrack.addEventListener('mousemove', function(e) {
        if (!audio.duration) return
        const rect = modalTrack.getBoundingClientRect()
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const tooltip = document.getElementById('progress-tooltip')
        if (tooltip) {
          tooltip.textContent = fmtDur(audio.duration * pct)
          tooltip.style.position = 'fixed'
          tooltip.style.display = 'block'
          tooltip.style.left = (e.clientX - 50) + 'px'
          tooltip.style.top  = (rect.top - 24) + 'px'
        }
      })
      modalTrack.addEventListener('mouseleave', function() {
        const tooltip = document.getElementById('progress-tooltip')
        if (tooltip) {
          tooltip.style.display = 'none'
          tooltip.style.position = ''
        }
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
      artBgEl.src = /^https?:\/\//.test(track.artPath) ? track.artPath : `file://${track.artPath}`
      artBgEl.style.display = 'block'
    } else {
      artBgEl.style.display = 'none'
    }
  }
  const artImg = document.getElementById('np-modal-art-img')
  const artFb  = document.getElementById('np-modal-art-fb')
  if (artImg) {
    if (track?.artPath) {
      artImg.src = /^https?:\/\//.test(track.artPath) ? track.artPath : `file://${track.artPath}`
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
  updateRepeatBtns()
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
// Icons live here, not in the model — the model decides WHAT is offered, the
// renderer decides how it looks.
var CTX_ICONS = {
  'ctx-play':        '<path d="M8 5v14l11-7z"/>',
  'ctx-queue':       '<path d="M4 6h16v2H4zm4 5h12v2H8zm4 5h8v2h-8z"/>',
  'ctx-play-next':   '<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>',
  'ctx-radio':       '<path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8c0-1.1-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM12 19a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm7-11a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>',
  'ctx-addpl':       '<path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm14-2v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z"/>',
  'ctx-wishlist':    '<path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>',
  'ctx-artist':      '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  'ctx-copy-path':   '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
  'ctx-show-folder': '<path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>',
  'ctx-trash':       '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  'ctx-like':        '<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09A5.99 5.99 0 0 0 7.5 3C4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/>',
  'ctx-remove-playlist': '<path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19-2h-8v2h8v-2z"/>',
  'ctx-remove-queue':    '<path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19-2h-8v2h8v-2z"/>',
  'ctx-unlike':          '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09A5.99 5.99 0 0 1 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>',
}

// The menu is rebuilt on every open from the model, so a surface can never show
// an action that makes no sense there.
function _ctxBuildMenu(menu, ctx) {
  var M = window.PapaCtxMenu
  if (!M) return []
  var items = M.menuItemsFor(ctx)
  var html = ''
  for (var i = 0; i < items.length; i++) {
    var it = items[i]
    if (it.separatorBefore && i > 0) html += '<div class="ctx-separator"></div>'
    html += '<button class="ctx-item' + (it.danger ? ' ctx-item-danger' : '') + '"' +
      ' id="' + it.id + '" data-ctx-id="' + it.id + '">' +
      '<svg viewBox="0 0 24 24">' + (CTX_ICONS[it.id] || '') + '</svg> ' + esc(it.label) +
      '</button>'
  }
  menu.innerHTML = html
  return items
}

function _ctxKindForRow(row) {
  if (!row || !row.classList) return 'track'
  if (row.classList.contains('queue-row')) return 'queue-item'
  if (row.classList.contains('pl-track-row')) return 'playlist-track'
  if (row.classList.contains('liked-track-row')) return 'liked-track'
  if (row.classList.contains('yt-row') || row.classList.contains('yt-track-row')) return 'yt-track'
  if (state.currentPage === 'playlist') return 'playlist-track'
  if (state.currentPage === 'liked') return 'liked-track'
  if (state.currentPage === 'search') return 'search-result'
  return 'track'
}

function _ctxTargetForRow(row) {
  var kind = _ctxKindForRow(row)
  var album = state.library.find(function (a) { return a.id === row.dataset.album })
  var track = album && album.tracks.find(function (t) { return t.filePath === row.dataset.file })
  // Fall back to the list's own copy — a playlist can hold a track whose album
  // is no longer in the library, and the menu must still work there.
  if (!track && row.dataset.file) {
    if (kind === 'playlist-track') {
      var pl = state.playlists.find(function (p) { return p.id === state.currentPlaylistId })
      track = pl && pl.tracks.find(function (t) { return t.filePath === row.dataset.file })
    } else if (kind === 'queue-item') {
      track = state.queue.find(function (t) { return t.filePath === row.dataset.file })
    }
    if (!track) track = { filePath: row.dataset.file }
  }
  var listName = null
  if (kind === 'playlist-track') {
    var cur = state.playlists.find(function (p) { return p.id === state.currentPlaylistId })
    listName = cur && cur.name
  }
  return {
    type: 'track', kind: kind, albumId: row.dataset.album, track: track,
    artist: (album && album.artist) || (track && (track.albumArtist || track.artist)) || null,
    listName: listName,
  }
}

function showContextMenu(e, target) {
  e.preventDefault()
  ctxTarget = target || {}
  var menu = document.getElementById('ctx-menu')
  if (!menu) return

  // Right-clicking a row that is part of an active multi-selection acts on the
  // WHOLE selection. It used to build the menu around that one row and silently
  // drop the rest, so "Move to Trash…" on 3 selected tracks deleted exactly one.
  if (_sel.selected.length > 1 && e.target && e.target.closest) {
    var _row = e.target.closest('.track-row, .album-card, .folder-node')
    var _at = _row ? _sel.rows.indexOf(_row) : -1
    if (_at !== -1 && _sel.selected.indexOf(_at) !== -1) {
      var _paths = _selPaths()
      if (_paths.length) {
        ctxTarget.paths = _paths
        ctxTarget.label = _sel.selected.length + ' ' + _sel.noun +
          (_sel.selected.length === 1 ? '' : 's') + ' selected'
        ctxTarget.multi = true
      }
    }
  }

  // Fill in what the model needs to decide, from what the caller knows.
  var album = ctxTarget.albumId
    ? state.library.find(function (a) { return a.id === ctxTarget.albumId })
    : null
  var track = ctxTarget.track
  var path = (track && track.filePath) || (album && album.tracks && album.tracks[0] && album.tracks[0].filePath)
  ctxTarget.kind = ctxTarget.kind || ctxTarget.type || 'track'
  // An artist or a folder node has no single track; it carries its paths.
  if (!path && ctxTarget.paths && ctxTarget.paths.length) path = ctxTarget.paths[0]
  ctxTarget.hasPath = !!path && !/^https?:\/\//.test(path)
  ctxTarget.isLiked = ctxTarget.albumId ? state.likedAlbums.indexOf(ctxTarget.albumId) !== -1 : false

  _ctxBuildMenu(menu, ctxTarget)

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

// The menu is rebuilt on every open, so per-button listeners would be lost.
// Handlers register by id once and a single delegated listener dispatches.
var _ctxHandlers = {}
function _ctxOn(id, fn) { _ctxHandlers[id] = fn }

document.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('#ctx-menu [data-ctx-id]') : null
  if (!btn) return
  var fn = _ctxHandlers[btn.getAttribute('data-ctx-id')]
  if (fn) fn()
})

function hideContextMenu() {
  document.getElementById('ctx-menu').style.display = 'none'
  ctxTarget = null
}

// ── Player ──────────────────────────────────────────────────────────────────
function playAlbum(album, startIndex) {
  _oldQueue = null
  state.queue = album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }))
  state.queueIndex = startIndex
  window.api.saveRecentlyPlayed(album.id)
  state.recentlyPlayed = [album.id, ...state.recentlyPlayed.filter(x => x !== album.id)].slice(0, 20)
  playCurrentTrack()
}

function playTrack(album, trackIdx) {
  _oldQueue = null
  if (!album.tracks[trackIdx]) return
  state.queue = album.tracks.slice(trackIdx).map(t => ({
    ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id,
  }))
  state.queueIndex = 0
  window.api.saveRecentlyPlayed(album.id)
  state.recentlyPlayed = [album.id, ...state.recentlyPlayed.filter(x => x !== album.id)].slice(0, 20)
  playCurrentTrack()
}

function playItemStandalone(track) {
  _oldQueue = { queue: [...state.queue], index: state.queueIndex }
  state.queue = [track]
  state.queueIndex = 0
  playCurrentTrack()
}

function playAlbumStandalone(album) {
  _oldQueue = { queue: [...state.queue], index: state.queueIndex }
  state.queue = album.tracks.map(t => ({ ...t, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }))
  state.queueIndex = 0
  playCurrentTrack()
}

function restoreOldQueue() {
  if (!_oldQueue) return
  state.queue = _oldQueue.queue
  state.queueIndex = _oldQueue.index
  _oldQueue = null
  playCurrentTrack()
}

// Mirror of playNext()'s selection, without side effects — used for gapless prefetch
// Deciding the shuffle pick lazily at end-of-track meant there was never a next
// file for mpv to prefetch, so every shuffle transition reloaded from scratch
// and the gap was audible. Committing to the pick in advance costs nothing -
// it is the same random choice, made a few minutes earlier - and is the only
// way shuffle can be gapless at all.
let _pendingShuffle = null

function computeNextIndex() {
  if (state.repeat === 'one') return state.queueIndex
  if (state.shuffle && state.queue.length > 1) {
    if (_pendingShuffle == null || _pendingShuffle >= state.queue.length) {
      _pendingShuffle = pickShuffleIndex(state.queue, _shuffleHistory.slice(-3))
    }
    return _pendingShuffle
  }
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
  const isStream = /^https?:\/\//.test(track.filePath)

  function onStarted() {
    extractAlbumColor(/^https?:\/\//.test(track.artPath || '') ? null : (track.artPath || null))
    state.isPlaying = true
    updatePlayBtn()
    updateNowPlaying(track)
    updateTrackHighlight()
    updatePlayerLikeBtn()
    if (state.queuePanelOpen) renderQueuePanel()
    if (state.modalOpen) { updateNowPlayingModal(); syncModalPlayBtn() }
    window.api.savePlaybackState({ filePath: track.filePath, position: 0 })
    // tracks[] is truncated, so index must be clamped to it or a restore lands
    // out of bounds. Keep the in-memory copy in sync too: the sidebar reads
    // state.savedQueues, which was otherwise only ever loaded at startup and
    // showed a launch-time snapshot for the rest of the session.
    var _autoTracks = state.queue.slice(0, 100)
    var _autoQ = {
      id: '_auto',
      name: 'Previous Session',
      tracks: _autoTracks,
      index: Math.min(Math.max(0, state.queueIndex), Math.max(0, _autoTracks.length - 1)),
      savedAt: Date.now(),
    }
    window.api.saveQueue(_autoQ)
    var _autoAt = state.savedQueues.findIndex(function (q) { return q.id === '_auto' })
    if (_autoAt >= 0) state.savedQueues[_autoAt] = _autoQ
    else state.savedQueues.push(_autoQ)
    renderSavedQueues()
    window.api.notifyTrack({ title: track.title, artist: track.albumArtist || track.artist || '', artPath: track.artPath || null })
    _shuffleHistory.push(state.queueIndex)
    if (_shuffleHistory.length > 10) _shuffleHistory.shift()
    clearTimeout(_playCountTimer)
    _playCountTimer = setTimeout(() => {
      state.playCounts[track.filePath] = (state.playCounts[track.filePath] || 0) + 1
      window.api.incrementPlayCount(track.filePath)
      // duration was never written, so every stat derived from it read zero.
      window.api.addPlayHistory({ filePath: track.filePath, title: track.title, artist: track.albumArtist || track.artist, album: track.albumName, artPath: track.artPath || null, duration: track.duration || 0, ts: Date.now() })
    }, 30000)
    loadLyricsFor(track)
    syncExtension()
    updateNextPrefetch()
  }

  function onError(e) {
    console.error('Playback error:', e)
    state.isPlaying = false
    updatePlayBtn()
    const titleEl = document.getElementById('np-title')
    if (titleEl) {
      const orig = titleEl.textContent
      titleEl.textContent = 'File not available'
      setTimeout(() => { titleEl.textContent = orig }, 2500)
    }
  }

  // Streaming tracks: use atomic switch (pause→resolve→load→play) to avoid
  // the old track continuing during yt-dlp resolution.
  if (isStream) {
    state.isPlaying = true
    updatePlayBtn()
    updateNowPlaying(track)
    updateTrackHighlight()
    if (state.queuePanelOpen) renderQueuePanel()
    audio.switchToTrack(track.filePath).then(onStarted).catch(onError)
    return
  }

  // Local files: existing fast path
  if (!audio.paused && !audio.ended) audio.pause()
  audio.src = `file://${track.filePath}`
  audio.play().then(onStarted).catch(onError)
}

// Home's "Continue listening" card is built by renderHome(), so it froze on
// whatever was playing when Home was last rendered. Keep it live instead.
function refreshJumpbackCard() {
  var card = document.getElementById('jumpback-card')
  if (!card) return
  var t = state.queue[state.queueIndex]
  if (!t) { card.remove(); return }
  var titleEl = card.querySelector('.jumpback-title')
  var artistEl = card.querySelector('.jumpback-artist')
  var artWrap = card.querySelector('.jumpback-art')
  if (titleEl) titleEl.textContent = t.title || 'Unknown'
  if (artistEl) artistEl.textContent = t.artist || ''
  if (artWrap) artWrap.innerHTML = artImg(t.artPath, 'jumpback-art-img', 'jumpback-art-fallback')
}

function updateNowPlaying(track) {
  refreshJumpbackCard()
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
  var npArtWrap = document.getElementById('np-art-wrap')
  if (npArtWrap && track) {
    var tt = track.title + ' — ' + (track.albumArtist || track.artist) + ' · ' + (track.albumName || '')
    if (track.bitsPerSample || track.sampleRate) tt += ' · ' + fmtSpec(track.bitsPerSample, track.sampleRate)
    npArtWrap.title = tt
  }
  var npImg = document.getElementById('np-art')
  if (npImg && npImg.src && npImg.src.startsWith('file://')) {
    npImg.setAttribute('draggable', 'true')
    if (!npImg._dragSetup) {
      npImg._dragSetup = true
      npImg.addEventListener('dragstart', function(e) {
        e.dataTransfer.setData('DownloadURL', 'image/jpeg:' + npImg.src.replace('file://', '').split('/').pop() + ':' + npImg.src)
      })
    }
  } else if (npImg) {
    npImg.removeAttribute('draggable')
  }
  updateFormatBadge(track)
  updateBitPerfectBadge()
  updateCrossfadeBadge()
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
  var _pb = document.getElementById('btn-play')
  if (_pb) _pb.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play')
  updateAriaToggles()
  updateSecondaryPlayIcons()
  window.api.setPowerSave(state.isPlaying)
}

// Toggle state lives in .active/.liked classes, which assistive tech cannot
// see. Mirror it onto aria-pressed so a screen-reader user can tell whether
// shuffle/mute/like are currently on.
function updateAriaToggles() {
  function press(id, on) {
    var el = document.getElementById(id)
    if (el) el.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  press('btn-shuffle', state.shuffle)
  press('btn-stop-after', state.stopAfterTrack)
  press('btn-sleep', !!state.sleepTimerEnd)
  press('btn-vol', audio && audio.volume === 0)
  var like = document.getElementById('btn-like')
  if (like) like.setAttribute('aria-pressed', like.classList.contains('liked') ? 'true' : 'false')
  var q = document.getElementById('btn-queue')
  if (q) q.setAttribute('aria-expanded', state.queuePanelOpen ? 'true' : 'false')
}

var _ICON_PLAY_PATH = 'M8 5v14l11-7z'
var _ICON_PAUSE_PATH = 'M6 4h4v16H6zm8 0h4v16h-4z'

// Is the album the currently-playing track belongs to?
function _albumIsPlaying(albumId) {
  var t = state.queue[state.queueIndex]
  if (!t || !state.isPlaying) return false
  var album = state.library.find(function (a) { return a.id === albumId })
  if (!album || !album.tracks) return false
  return album.tracks.some(function (x) { return x.filePath === t.filePath })
}

// The jumpback and quick-grid buttons hardcoded a play triangle, so the one
// album actually playing still looked paused and clicking it restarted the
// album from the top instead of pausing.
function updateSecondaryPlayIcons() {
  document.querySelectorAll('.quick-card-play').forEach(function (btn) {
    var p = btn.querySelector('path')
    if (!p) return
    var playing = _albumIsPlaying(btn.dataset.play)
    p.setAttribute('d', playing ? _ICON_PAUSE_PATH : _ICON_PLAY_PATH)
    btn.title = playing ? 'Pause' : 'Play'
  })
  var jb = document.getElementById('jumpback-play')
  if (jb) {
    var jp = jb.querySelector('path')
    if (jp) jp.setAttribute('d', state.isPlaying ? _ICON_PAUSE_PATH : _ICON_PLAY_PATH)
    jb.title = state.isPlaying ? 'Pause' : 'Play'
  }
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

function _isInterlude(track) {
  if (!track || track.duration == null || track.duration >= 60) return false
  var album = state.library.find(function(a) {
    return a.tracks && a.tracks.some(function(t) { return t.filePath === track.filePath })
  })
  if (!album || !album.tracks) return false
  var tIdx = album.tracks.findIndex(function(t) { return t.filePath === track.filePath })
  if (tIdx <= 0 || tIdx >= album.tracks.length - 1) return false
  return true
}

function playNext() {
  if (state.stopAfterTrack) {
    state.stopAfterTrack = false
    state.isPlaying = false
    audio.pause()
    updatePlayBtn()
    updateStopAfterBtn()
    syncExtension()
    return
  }
  if (!state.queue.length) return
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return }
  if (state.shuffle) {
    // Use the pick already prefetched, or mpv played one file while we advance
    // to a different one.
    const committed = (_pendingShuffle != null && _pendingShuffle < state.queue.length)
      ? _pendingShuffle : pickShuffleIndex(state.queue, _shuffleHistory.slice(-3))
    _pendingShuffle = null
    state.queueIndex = committed
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length
  }
  if (state.queueIndex === 0 && state.repeat === 'off') {
    // Queue finished — restore prior queue if standalone play was active
    if (_oldQueue) { restoreOldQueue(); return }
    // Spotify-style autoplay keeps going with similar tracks
    if (autoplayEnabled() && !state.shuffle) { tryAutoplayContinue(); return }
    audio.pause(); state.isPlaying = false; updatePlayBtn(); syncExtension(); return
  }
  if (state.skipShortTracks && state.queue.length > 1) {
    const track = state.queue[state.queueIndex]
    if (track && track.duration != null && track.duration < state.skipShortSecs) {
      _skipShortGuard++
      if (_skipShortGuard > 20) { _skipShortGuard = 0; playCurrentTrack(); return }
      showSnackbar('Skipped short track: ' + (track.title || track.filePath))
      playNext()
      return
    }
  }
  if (state.skipInterludes && state.queue.length > 1 && _isInterlude(state.queue[state.queueIndex])) {
    var interludeTrack = state.queue[state.queueIndex]
    showSnackbar('Skipped interlude: ' + (interludeTrack.title || interludeTrack.filePath))
    playNext()
    return
  }
  _skipShortGuard = 0
  playCurrentTrack()
}

function pickShuffleIndex(queue, recentIndices) {
  if (queue.length <= 1) return 0
  const recentArtists = new Set(recentIndices.map(i => queue[i]?.albumArtist || queue[i]?.artist).filter(Boolean))
  for (let attempt = 0; attempt < 10; attempt++) {
    const idx = Math.floor(Math.random() * queue.length)
    if (idx === state.queueIndex) continue
    const artist = queue[idx]?.albumArtist || queue[idx]?.artist
    if (!recentArtists.has(artist) || attempt >= 8) return idx
  }
  return Math.floor(Math.random() * queue.length)
}

function playPrev() {
  if (!state.queue.length) return
  if (audio.currentTime > 3) { audio.currentTime = 0; return }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length
  playCurrentTrack()
}

// ── Lyrics ──────────────────────────────────────────────────────────────────
async function fetchLyrics(track, force = false) {
  if (!track) return null
  // Fetched in the main process (lyrics.js): renderer CSP blocks direct
  // lrclib.net requests, and main adds search + YouTube fallbacks + caching.
  const res = await window.api.getLyrics({
    force,
    artist: track.albumArtist || track.artist || '',
    title: track.title || '',
    album: track.albumName || '',
    duration: Math.round(track.duration || audio.duration || 0),
    videoId: track.videoId || null,
    filePath: track.filePath || null,
  }).catch(() => null)
  if (!res?.ok) return null
  if (res.synced?.length) return res.synced.filter(l => l.text)
  if (res.plain) {
    const paras = res.plain.split('\n').map(s => s.trim()).filter(Boolean)
    if (!paras.length) return null
    const dur = track.duration || audio.duration || paras.length
    const step = dur / paras.length
    return paras.map((text, i) => ({ time: i * step, text }))
  }
  return null
}

// Single entry point for track changes. The staleness guard matters: the
// LRCLIB search fallback can take seconds, so a response for a track the
// user already skipped must never overwrite the current track's lyrics.
function loadLyricsFor(track) {
  _lyrics = null
  renderLyricsPanel()
  updateLyricsDrawer()
  fetchLyrics(track).then(lines => {
    if (state.queue[state.queueIndex]?.filePath !== track.filePath) return
    _lyrics = lines
    renderLyricsPanel()
    updateLyricsDrawer()
  })
}

// Scroll only the lyrics container — scrollIntoView() also scrolls every
// scrollable ancestor and yanks the whole page around during playback.
function _scrollLineIntoView(container, el) {
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  const delta = (eRect.top + eRect.height / 2) - (cRect.top + cRect.height / 2)
  container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' })
}

function _bindLyricsSeek(container, lineSelector) {
  container.querySelectorAll(lineSelector).forEach(el => {
    el.addEventListener('click', () => {
      const t = parseFloat(el.dataset.time)
      if (!isNaN(t)) audio.currentTime = t
    })
  })
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
  _bindLyricsSeek(panel, '.lyrics-line')
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
      _scrollLineIntoView(panel, el)
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
  _bindLyricsSeek(body, '.lyrics-drawer-line')
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
      _scrollLineIntoView(body, el)
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
    const fetched = await fetchLyrics(track, true) // force: bypass a cached miss
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
    if (filePath && !isHttpPath(filePath)) {
      const result = await window.api.saveLyrics({ filePath, lrcContent: lrcLines })
      if (result.ok) {
        _lyrics = fetched
        renderLyricsPanel()
        updateLyricsDrawer()
        showToast('Lyrics saved next to the file ✓')
        if (btn) btn.classList.add('saved')
        setTimeout(() => btn?.classList.remove('saved'), 3000)
      } else {
        showToast('Could not save: ' + (result.error || 'unknown error'))
      }
    } else {
      _lyrics = fetched
      renderLyricsPanel()
      updateLyricsDrawer()
      showToast('Lyrics loaded (streams have no file to save to)')
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
  // Row indices are only meaningful for the rows currently on screen.
  if (typeof _sel !== 'undefined') {
    // applyLibraryUpdate() defers a background refresh to protect an active
    // selection, but the user's own filter/sort clicks came through here and
    // dropped it with no feedback at all. Say so rather than silently losing it.
    if (_sel.selected.length > 1) {
      var _lost = _sel.selected.length
      setTimeout(function () { showSnackbar(_lost + ' ' + _sel.noun + 's deselected') }, 0)
    }
    _sel.selected = []; _sel.anchor = null; _sel.rows = []
  }
  var bar = document.getElementById('sel-bar')
  if (bar) bar.style.display = 'none'
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

  canvas.title = now.toLocaleTimeString()
}

function bindContentEvents() {
  // Belongs to renderSearch(). It used to be bound inside renderLibrary()'s
  // search callback, so it only ran when you typed in the Library box -- by
  // which point this element does not exist. The filter never worked.
  document.getElementById('results-filter')?.addEventListener('input', function () {
    var q = this.value.toLowerCase()
    // Scoped to #content: unscoped this also hid rows in the queue panel and
    // any open modal, which share these class names.
    document.querySelectorAll('#content .track-row, #content .album-card, #content .artist-pill, #content .yt-row, #content .yt-album-card, #content .str-track, #content .yt-artist-card, #content .yt-playlist-card').forEach(function (el) {
      var text = (el.textContent || '').toLowerCase()
      el.style.display = q && !text.includes(q) ? 'none' : ''
    })
  })

  document.querySelectorAll('#content .album-card,#content .quick-card,#content .artist-card,#content .daily-mix-card,#content .jumpback-card,#content .folder-tree-item,#content .pl-card,#content .pl-folder-header,#content .genre-tile,#content .mood-card,#content .recent-search-card,#content .artist-pill,#content .discovery-swipe-card,#content .yt-row,#content .yt-album-card,#content .yt-artist-card,#content .yt-playlist-card,#content .dl2-group-toggle,#content .dl2-group-toggle-failed,#content .pl-track-row')
    .forEach(function (c) {
      if (c.hasAttribute('tabindex')) return
      c.setAttribute('tabindex', '0')
      c.setAttribute('role', 'button')
    })
  if (document.getElementById('home-clock')) {
    if (_homeClockInterval) { clearInterval(_homeClockInterval); _homeClockInterval = null }
    _drawHomeClock()
    _homeClockInterval = setInterval(_drawHomeClock, 1000)
  }

  document.getElementById('find-art-btn')?.addEventListener('click', () => {
    document.getElementById('find-art-btn').remove()
    fetchMissingArtwork()
  })

  document.getElementById('yt-retry-btn')?.addEventListener('click', () => {
    runYtSearch(ytSearchState.lastQuery, ytSearchState.scope)
  })

  document.getElementById('jumpback-play')?.addEventListener('click', function () {
    // Already loaded? Then this is a pause/resume, not a restart-from-zero.
    var t = state.queue[state.queueIndex]
    if (t && audio.src && audio.src.indexOf(t.filePath) !== -1) { togglePlay(); return }
    playCurrentTrack()
  })
  document.getElementById('jumpback-card')?.addEventListener('click', function(e) {
    if (!e.target.closest('.jumpback-play')) playCurrentTrack()
  })

  document.querySelectorAll('.album-card[data-album]').forEach(el => {
    if ((el.dataset.album || '').indexOf('yt_') === 0) return
    el.addEventListener('click', e => { _selHandleClick(e, el) }, true)
  })
  document.querySelectorAll('.album-card').forEach(el => {
    // YT entity cards bind their own navigation (browse/channel/playlist ids)
    if (el.dataset.browse || el.dataset.channel || el.dataset.playlist) return
    el.addEventListener('dblclick', function(e) {
      e.preventDefault()
      var id = el.dataset.album
      if (id && id.startsWith('yt_')) return
      var album = state.library.find(function(a) { return a.id === id })
      if (album) playAlbum(album, 0)
    })
    el.addEventListener('click', e => {
      if (e.target.closest('.album-card-play') || e.target.closest('.album-card-artist')) return
      const id = el.dataset.album
      if (id && id.startsWith('yt_')) { navigate('yt-album', id.slice(3)); return }
      navigate('album', id)
    })
    if (!(el.dataset.album || '').startsWith('yt_')) {
      el.addEventListener('contextmenu', e =>
        showContextMenu(e, { type: 'album', kind: 'album', albumId: el.dataset.album,
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
      // If this album is the one already playing, act as pause -- restarting it
      // from track 1 is never what the click meant.
      if (_albumIsPlaying(btn.dataset.play)) { togglePlay(); return }
      const album = state.library.find(a => a.id === btn.dataset.play)
      if (album) playAlbum(album, 0)
    })
  })
  document.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.track-more-btn') || e.target.closest('.track-like-btn')) return
      if (_selHandleClick(e, row)) return
      // Surfaces that own their row click (playlists) opt out of album
      // navigation. Playlist rows carry BOTH .track-row and .pl-track-row plus
      // a data-album, so this generic handler and renderPlaylist's own handler
      // both fired: clicking a track started playback AND yanked you to the
      // album page. Multi-select above still applies to those rows.
      if (row.dataset.noAlbumNav) return
      if (e.target.closest('.track-num')) {
        const album = state.library.find(a => a.id === row.dataset.album)
        if (!album) return
        const idx = album.tracks.findIndex(t => t.filePath === row.dataset.file)
        if (idx >= 0) playAlbum(album, idx)
        return
      }
      const albumId = row.dataset.album
      if (albumId) navigate('album', albumId)
    })
    row.addEventListener('contextmenu', e => showContextMenu(e, _ctxTargetForRow(row)))
    row.querySelector('.track-more-btn')?.addEventListener('click', e => {
      e.stopPropagation()
      showContextMenu(e, _ctxTargetForRow(row))
    })
  })
  document.querySelectorAll('.artist-link, .artist-pill').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation()
      navigate('artist', el.dataset.artist || el.textContent)
    })
  })

  document.querySelectorAll('.artist-play-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      var artistName = btn.dataset.playArtist
      var albums = state.library.filter(function(a) { return a.artist === artistName || a.albumArtist === artistName })
      if (albums.length) playAlbum(albums[0], 0)
    })
  })

  document.querySelectorAll('.search-top-result').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.album-card-play')) return
      navigate('album', el.dataset.album)
    })
  })

  var swipeEl = document.getElementById('discovery-swipe')
  if (swipeEl) {
    // Delegated on the container, so every card works -- not just the first
    // one. It used to bind mousedown/mouseup on querySelector('.card') once and
    // then remove that node, leaving the remaining nine cards inert. A swipe
    // also did nothing at all, so a plain click now opens the album.
    var _swipeStartX = 0
    var _swipeCard = null
    swipeEl.addEventListener('mousedown', function(e) {
      _swipeCard = e.target.closest('.discovery-swipe-card')
      _swipeStartX = e.clientX
    })
    swipeEl.addEventListener('mouseup', function(e) {
      var card = e.target.closest('.discovery-swipe-card')
      if (!card || card !== _swipeCard) { _swipeCard = null; return }
      var diff = e.clientX - _swipeStartX
      _swipeCard = null
      if (Math.abs(diff) > 80) {
        card.classList.add(diff > 0 ? 'swipe-right' : 'swipe-left')
        setTimeout(function() { card.remove() }, 300)
        return
      }
      // Not a swipe: treat it as a click and actually go somewhere.
      if (card.dataset.album) navigate('album', card.dataset.album)
    })
  }

  document.querySelectorAll('.era-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.era-chip').forEach(function(c) { c.classList.remove('active') })
      this.classList.add('active')
      state.libDecade = this.dataset.era.slice(0, 4)
      navigate('library')
    })
  })

  document.getElementById('clear-decade-filter')?.addEventListener('click', function() { state.libDecade = ''; renderLibrary() })

  document.querySelectorAll('.mood-card').forEach(function(card) {
    card.addEventListener('click', function() {
      var mood = card.dataset.mood
      var genreMap = { energetic:'rock', chill:'ambient', focus:'classical', happy:'pop', melancholy:'blues', romantic:'jazz', dark:'metal', epic:'soundtrack' }
      var genre = genreMap[mood] || mood
      var known = state.library.find(function (a) {
        return a.genre && a.genre.toLowerCase() === genre.toLowerCase()
      })
      if (known) {
        state.libGenre = known.genre
        state.libSearch = ''
        navigate('library')
      } else {
        navigate('search', genre)
      }
    })
  })

  document.querySelectorAll('.daily-mix-card[data-mix-genre]').forEach(function(card) {
    card.addEventListener('click', function() {
      var genre = card.dataset.mixGenre
      if (genre) { state.libGenre = genre; navigate('library') }
    })
  })

  document.getElementById('new-smart-pl-btn')?.addEventListener('click', function() {
    showSmartPlaylistDialog()
  })

  document.querySelectorAll('.wishlist-search-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var w = state.downloadWishlist[parseInt(btn.dataset.wlIdx)]
      if (w) { navigate('search', w.query) }
    })
  })
  document.querySelectorAll('.wishlist-remove-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      state.downloadWishlist.splice(parseInt(btn.dataset.wlIdx), 1)
      renderDownloads()
      window.api.saveDownloadWishlist(state.downloadWishlist)
      showSnackbar('Removed from wishlist')
    })
  })

  document.querySelectorAll('.album-card-art').forEach(function(img) {
    img.addEventListener('contextmenu', function(e) {
      e.preventDefault()
      e.stopPropagation()
      var src = img.src || ''
      if (src.startsWith('file://')) {
        navigator.clipboard.writeText(src.replace('file://', '')).then(function() {
          showSnackbar('Path copied')
        })
      }
    })
  })

  document.querySelectorAll('.pl-rename-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      var plId = btn.dataset.plId
      var pl = state.playlists.find(function(p) { return p.id === plId })
      if (!pl) {
        var sp = state.smartPlaylists.find(function(p) { return p.id === plId })
        if (sp) pl = sp; else return
      }
      showNameInputModal('Rename playlist', pl.name, function(newName) {
        pl.name = newName
        _persistPlaylist(pl)
        renderPlaylists()
      })
    })
  })

  document.getElementById('pl-sort-btn')?.addEventListener('click', function() {
    state.playlistSort = state.playlistSort === 'recent' ? 'alpha' : 'recent'
    renderPlaylists()
  })

  document.querySelectorAll('.pl-dup-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      var plId = btn.dataset.plId
      var pl = state.playlists.find(function(p) { return p.id === plId })
      if (!pl) {
        var sp = state.smartPlaylists.find(function(p) { return p.id === plId })
        if (sp) pl = sp; else return
      }
      var dup = JSON.parse(JSON.stringify(pl))
      // Date.now() alone collides on a double-click; two other creation paths
      // already add a random suffix.
      dup.id = (pl.type === 'smart' ? 'sp_' : 'dup_') + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      dup.name = pl.name + ' (copy)'
      dup.createdAt = Date.now()
      if (pl.type === 'smart') { state.smartPlaylists.push(dup); _persistSmartPlaylists() }
      else { state.playlists.push(dup); window.api.savePlaylist(dup) }
      renderPlaylists()
      showSnackbar('Playlist duplicated')
    })
  })

  document.getElementById('pl-export-btn')?.addEventListener('click', function() {
    var id = state.currentPlaylistId
    var pl = state.playlists.find(function(p) { return p.id === id })
    if (!pl || !pl.tracks || !pl.tracks.length) return
    var m3u = '#EXTM3U\n#PLAYLIST:' + pl.name + '\n'
    pl.tracks.forEach(function(t, i) {
      m3u += '#EXTINF:' + Math.round(t.duration || 0) + ',' + (t.albumArtist || t.artist || '') + ' - ' + (t.title || '') + '\n'
      m3u += (t.filePath || '') + '\n'
    })
    var blob = new Blob([m3u], { type: 'audio/x-mpegurl' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = (pl.name || 'playlist').replace(/[/\\?%*:|"<>]/g, '_') + '.m3u'
    a.click()
    URL.revokeObjectURL(url)
    showSnackbar('Exported ' + pl.tracks.length + ' tracks')
  })

  document.getElementById('import-pl-btn')?.addEventListener('click', function() { fileInput.click() })
  // Bound exactly once: this element is module-level, but bindContentEvents()
  // runs on EVERY setContent, so the listener accumulated and importing one
  // .m3u after N navigations created N identical playlists.
  if (!fileInput._bound) { fileInput._bound = true
  fileInput.addEventListener('change', function() {
    var file = this.files[0]
    if (!file) return
    var reader = new FileReader()
    reader.onload = function() {
      var lines = reader.result.split('\n').filter(function(l) { return l.trim() && !l.startsWith('#') })
      var tracks = []
      // Was: a substring match on the basename, breaking only the INNER loop --
      // so "01.flac" matched once per album across the whole library and the
      // import produced dozens of false positives per line. Now: exact path
      // first, then an exact basename match, and stop at the first hit.
      // Tracks are enriched the way _allLibraryTracks() does, or imported rows
      // render with no artist and no cover.
      var byPath = {}, byBase = {}
      state.library.forEach(function (a) {
        ;(a.tracks || []).forEach(function (t) {
          if (!t.filePath) return
          var enriched = Object.assign({}, t, {
            albumArtist: a.artist, artPath: a.artPath, albumName: a.name, albumId: a.id,
          })
          byPath[t.filePath] = enriched
          var base = t.filePath.split('/').pop()
          if (base && !byBase[base]) byBase[base] = enriched
        })
      })
      var seen = {}
      lines.forEach(function(line) {
        var fp = line.trim()
        var hit = byPath[fp] || byBase[fp.replace(/^.*[\\/]/, '')]
        if (!hit || seen[hit.filePath]) return
        seen[hit.filePath] = true
        tracks.push(hit)
      })
      if (tracks.length) {
        var pl = { id: 'import_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: file.name.replace(/\.m3u8?$/i, ''), tracks: tracks, createdAt: Date.now() }
        state.playlists.push(pl)
        window.api.savePlaylist(pl)
        renderPlaylists()
        showSnackbar('Imported ' + tracks.length + ' tracks from ' + file.name)
      } else {
        showSnackbar('No matching tracks found in library')
      }
    }
    reader.readAsText(file)
    // Reset on the INPUT, not on the FileReader (`this` inside onload is the
    // reader), or selecting the same file again fires no change event.
    fileInput.value = ''
  })
  }

}


function _cardHue(str) {
  return Math.abs([...str].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
}

function albumCard(album, idx, sortMode, query) {
  const hiResTag = album.isHiRes
    ? `<span class="album-hires-badge">${fmtSpec(album.maxBitsPerSample, album.maxSampleRate)}</span>`
    : ''
  // Was `idx < 20`, so on a library where fewer than 20 albums carry addedAt
  // the badge landed on old albums in the un-dated tail -- and the 20 oldest
  // additions stayed "NEW" forever. Tie it to a real 14-day window.
  const newBadge = (sortMode === 'added' && album.addedAt && (Date.now() - album.addedAt) < 14 * 86400000)
    ? '<span class="new-badge">NEW</span>' : ''
  const hue = _cardHue((album.artist || '') + (album.name || ''))
  var fallbackStyle = `background:linear-gradient(135deg,hsl(${hue},55%,22%) 0%,hsl(${(hue+40)%360},45%,14%) 100%)`
  return `<div class="album-card" data-album="${esc(album.id)}">
    <div class="album-card-art-wrap">
      ${album.artPath
        ? `<img class="album-card-art" src="${isHttpPath(album.artPath) ? esc(album.artPath) : esc(`file://${album.artPath}`)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="album-card-art-fallback" ${album.artPath ? 'style="display:none"' : `style="${fallbackStyle}"`}>
        <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
      </div>
      ${album.isYt ? '<span class="yt-badge yt-card-badge">YT</span>' : ''}
      ${hiResTag}
      ${formatBadgeHtml(album) ? `<div class="fmt-stack">${formatBadgeHtml(album)}</div>` : ''}
      ${newBadge}
      ${drBadge(computeAlbumDR(album))}
      <button class="album-card-play" data-play="${esc(album.id)}" aria-label="Play ${esc(album.name || 'album')}">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
    </div>
    <div class="album-card-name">${query ? highlightMatch(album.name, query) : esc(album.name)}</div>
    <div class="album-card-artist" data-artist="${esc(album.artist)}">${query ? highlightMatch(album.artist, query) : esc(album.artist)}</div>
  </div>`
}

function fmtSpec(bd, sr) {
  const srLabel = sr >= 1000 ? `${sr % 1000 === 0 ? sr / 1000 : (sr / 1000).toFixed(1)}kHz` : `${sr}Hz`
  return bd ? `${bd}bit · ${srLabel}` : srLabel
}

function artImg(artPath, imgClass, fallbackClass) {
  var musicNote = `<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
  if (artPath) {
    const src = /^https?:\/\//.test(artPath) ? artPath : `file://${artPath}`
    return `<img class="${imgClass}" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="${fallbackClass}" style="display:none">${musicNote}</div>`
  }
  return `<div class="${fallbackClass}">${musicNote}</div>`
}

function computeDR(track) {
  if (!track.replaygainTrackPeak || !track.replayGainTrack) return null
  var peak = parseFloat(track.replaygainTrackPeak)
  var gain = parseFloat(track.replayGainTrack)
  if (isNaN(peak) || isNaN(gain)) return null
  var dr = 20 * Math.log10(peak) - gain
  return Math.round(dr)
}

function computeAlbumDR(album) {
  if (!album.tracks || !album.tracks.length) return null
  var drs = album.tracks.map(computeDR).filter(function(d) { return d != null })
  if (!drs.length) return null
  return Math.round(drs.reduce(function(s, d) { return s + d }, 0) / drs.length)
}

function drBadge(dr) {
  if (dr == null) return ''
  var color = dr >= 14 ? '#1db954' : dr >= 10 ? '#c4a747' : '#e05c5c'
  return '<span class="dr-badge" style="background:' + color + '20;color:' + color + ';border:1px solid ' + color + '40">DR' + dr + '</span>'
}

function esc(str) {
  // ' is escaped too: several sinks are CSS url('...') and single-quoted
  // attributes, where a bare apostrophe in a filename breaks out.
  return String(str == null ? '' : str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
function highlightMatch(text, query) {
  if (!query || !text) return esc(text)
  var escaped = esc(text)
  var escapedQuery = esc(query)
  var regex = new RegExp('(' + escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi')
  return escaped.replace(regex, '<mark>$1</mark>')
}
// Multichannel label for a track or album. Stereo and mono get nothing —
// a badge on almost every row would carry no information.
// format-badges.js owns this, and formatBadges() calls it as a bare global.
// Declaring a second copy here silently rebound that call to this file's
// version -- harmless only while the two happened to be identical.
function surroundLabelOf(channels) {
  return window.PapaFormat ? window.PapaFormat.surroundLabel(channels) : ''
}

function surroundBadge(channels, cls) {
  const label = surroundLabelOf(channels)
  return label ? `<span class="surround-badge${cls ? ' ' + cls : ''}" title="${label} multichannel audio">${label}</span>` : ''
}

// Badge rules live in format-badges.js so tests and UI share one implementation.
function formatBadgeHtml(src, cls) {
  const badges = (window.PapaFormat ? window.PapaFormat.formatBadges(src) : [])
  return badges
    .map(b => `<span class="fmt-badge fmt-${b.kind}${cls ? ' ' + cls : ''}" title="${esc(b.title)}">${b.label}</span>`)
    .join('')
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
function _albumTotalDuration() {
  return state.queue.reduce(function(s, t) { return s + (t.duration || 0) }, 0)
}
var _lastVolDisplay = -1
function setVolDisplay(vol) {
  var pct = `${Math.round(vol * 100)}%`
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
  var volIcon = document.querySelector('.vol-icon')
  if (volIcon) volIcon.title = Math.round(vol * 100) + '%'

  if (vol <= 0.01 && _lastVolDisplay > 0.01) {
    showSnackbar('Muted', 'Unmute', function() { audio.volume = state.lastVolume || 0.8; setVolDisplay(audio.volume) }, 2000)
  }
  if (vol >= 0.99 && _lastVolDisplay < 0.99) {
    showSnackbar('Volume max', null, null, 1500)
  }
  _lastVolDisplay = vol
  var volIcon = document.querySelector('.vol-icon')
  if (volIcon) { volIcon.classList.add('pulse'); setTimeout(function() { volIcon.classList.remove('pulse') }, 400) }
}

// ── Saved sites ─────────────────────────────────────────────────────────────
// ── Saved queues ─────────────────────────────────────────────────────────────
function renderSavedQueues() {
  const section = document.querySelector('.saved-queues-section')
  const list = document.getElementById('saved-queues-list')
  if (!list) return
  if (!state.savedQueues.length) {
    if (section) section.style.display = 'none'
    return
  }
  if (section) section.style.display = ''
  list.innerHTML = state.savedQueues.map(q => {
    const firstArt = q.tracks?.find(t => t.artPath)?.artPath
    const artHtml = firstArt
      ? `<img class="sq-item-art" src="${esc('file://' + firstArt)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
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
      var deletedQ = null
      for (var i = 0; i < state.savedQueues.length; i++) { if (state.savedQueues[i].id === btn.dataset.qid) { deletedQ = JSON.parse(JSON.stringify(state.savedQueues[i])); break } }
      state.savedQueues = state.savedQueues.filter(function(x) { return x.id !== btn.dataset.qid })
      window.api.deleteSavedQueue(btn.dataset.qid)
      renderSavedQueues()
      showSnackbar('Queue deleted', 'Undo', function() {
        if (!deletedQ) return
        state.savedQueues.push(deletedQ)
        window.api.saveQueue(deletedQ)   // the delete hit disk, so undo must too
        renderSavedQueues()
      })
    })
  })
}

// ── Quality Sources ──────────────────────────────────────────────────────────
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
      const artistName = albums[0].artist
      state.queue = tracks; state.queueIndex = 0; playCurrentTrack()
      showSnackbar('Agent: Playing ' + artistName)
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
      showSnackbar('Agent: Download started')
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
      showSnackbar('Agent: Volume set to ' + input.level + '%')
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
      showSnackbar('Agent: Added to queue')
      return `Added "${match.name}" (${tracks.length} tracks) to queue.`
    }

    case 'clear_queue': {
      state.queue = []; state.queueIndex = -1; state.isPlaying = false
      state._restoredFromQueue = false
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
      showSnackbar('Agent: Album liked', 'View', function() { navigate('liked') })
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
      updateRepeatBtns()
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
      showSnackbar('Agent: Queue saved')
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
  state._playerSettings = cfg
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
    // mpv reports these verbatim from the driver; a description containing a
    // quote would break out of the attribute.
    .map(d => `<option value="${esc(d.name)}" ${d.name === cfg.alsaDevice ? 'selected' : ''}>${esc(d.description)}</option>`)
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
    var mode = e.target.value
    showSnackbar('Playback mode: ' + (mode === 'gapless' ? 'Gapless' : 'Crossfade'))
  }
  $('pb-cf-secs').oninput = e => { $('pb-cf-label').textContent = `${e.target.value}s` }
  $('pb-cf-secs').onchange = e => apply({ crossfadeSecs: Number(e.target.value) })
  $('pb-replaygain').onchange = e => apply({ replaygain: e.target.value })
  $('pb-channels').onchange = e => apply({ channels: e.target.value })
  $('pb-boost').onchange = e => apply({ boost: e.target.checked })

  await _initEqSettings(cfg, apply)
}

// Ten-band EQ. The sliders write straight through to mpv's filter chain, so
// dragging one is audible immediately — no apply button, no reload.
async function _initEqSettings(cfg, apply) {
  const $ = id => document.getElementById(id)
  const { bands, presets, limit } = await window.api.eqInfo()
  const group = $('eq-settings')
  const bandsEl = $('eq-bands')
  const fmtHz = hz => (hz >= 1000 ? `${hz / 1000}k` : String(hz))

  let eq = {
    enabled: false,
    preamp: 0,
    gains: new Array(bands.length).fill(0),
    ...(cfg.eq || {}),
  }
  // A stored curve from an older build may be short; pad rather than crash.
  eq.gains = bands.map((_, i) => Number(eq.gains?.[i]) || 0)

  // Built from the preset table rather than hardcoded markup, so adding a
  // preset in eq.js is all it takes to make it appear here.
  const groups = {}
  for (const [key, p] of Object.entries(presets)) {
    (groups[p.group] = groups[p.group] || []).push([key, p])
  }
  $('eq-preset').innerHTML = '<option value="custom">Custom</option>' +
    Object.entries(groups).map(([group, items]) =>
      `<optgroup label="${group}">` +
      items.map(([key, p]) => `<option value="${key}">${p.label}</option>`).join('') +
      '</optgroup>').join('')

  bandsEl.innerHTML = bands.map((hz, i) => `
    <div class="eq-band">
      <span class="eq-band-gain" id="eq-gain-label-${i}"></span>
      <input type="range" id="eq-gain-${i}" min="${-limit}" max="${limit}" step="1" value="${eq.gains[i]}">
      <span class="eq-band-freq">${fmtHz(hz)}</span>
    </div>`).join('')

  const paint = () => {
    $('eq-enabled').checked = eq.enabled
    group.classList.toggle('eq-off', !eq.enabled)
    $('eq-preamp').value = eq.preamp
    $('eq-preamp-label').textContent = `${eq.preamp > 0 ? '+' : ''}${eq.preamp} dB`
    eq.gains.forEach((g, i) => {
      $(`eq-gain-${i}`).value = g
      $(`eq-gain-label-${i}`).textContent = g === 0 ? '' : `${g > 0 ? '+' : ''}${g}`
    })
    // Any hand-edit stops matching a named preset; say so rather than lie.
    const match = Object.keys(presets).find(n =>
      presets[n].gains.every((g, i) => g === eq.gains[i]))
    $('eq-preset').value = match || 'custom'
  }

  const push = () => { state._playerSettings = { ...state._playerSettings, eq }; apply({ eq }) }

  $('eq-enabled').onchange = e => { eq.enabled = e.target.checked; paint(); push() }
  $('eq-preamp').oninput = e => {
    eq.preamp = Number(e.target.value)
    $('eq-preamp-label').textContent = `${eq.preamp > 0 ? '+' : ''}${eq.preamp} dB`
  }
  $('eq-preamp').onchange = () => push()

  bands.forEach((_, i) => {
    const slider = $(`eq-gain-${i}`)
    slider.oninput = e => {
      eq.gains[i] = Number(e.target.value)
      $(`eq-gain-label-${i}`).textContent = eq.gains[i] === 0 ? '' : `${eq.gains[i] > 0 ? '+' : ''}${eq.gains[i]}`
      $('eq-preset').value = 'custom'
    }
    slider.onchange = () => { paint(); push() }
  })

  $('eq-preset').onchange = async e => {
    const preset = await window.api.eqPreset(e.target.value)
    if (!preset) return
    eq = { ...preset, enabled: true }
    paint(); push()
    showSnackbar(`EQ preset: ${presets[e.target.value]?.label || e.target.value}`)
  }

  $('eq-reset').onclick = () => {
    eq = { enabled: eq.enabled, preamp: 0, gains: bands.map(() => 0) }
    paint(); push()
    showSnackbar('Equalizer reset to flat')
  }

  paint()
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
      var key   = `${resp.username}::${folderPath}`
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

// Folder names and file sizes are guesses. Once the files are on disk ffprobe
// reports the real channel count, so a download that promised surround and
// arrived stereo gets caught instead of quietly joining the library.
async function _verifySurroundWhenDone(g, plan, label) {
  const first = plan[0]
  if (!first) return
  const deadline = Date.now() + 15 * 60 * 1000
  const poll = async () => {
    if (Date.now() > deadline) return
    const found = await window.api.slskResolveFile({
      username: first.username, filename: first.filename }).catch(() => null)
    if (!found || !found.path) { setTimeout(poll, 15000); return }
    const dir = found.path.replace(/[^/]+$/, '')
    const res = await window.api.verifySurroundFolder({ dir }).catch(() => null)
    if (!res || res.ok === null) return
    if (res.ok) {
      showSnackbar(`Verified: all ${res.total} tracks are surround`)
    } else if (res.mixed) {
      showSnackbar(`Warning: only ${res.surround} of ${res.total} tracks are surround`, 'Show', () => {
        alert(`Labelled ${label}, but these tracks are not surround:\n\n` +
          res.offenders.map(o => `  ${o.name} — ${o.channels} channel${o.channels === 1 ? '' : 's'}`).join('\n'))
      })
    } else {
      showSnackbar(`Warning: labelled ${label} but no track is surround`, 'Show', () => {
        alert(res.offenders.map(o => `  ${o.name} — ${o.channels} channels`).join('\n'))
      })
    }
  }
  setTimeout(poll, 20000)
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

  const _slskElapsed = slsk.searchStart ? Math.floor((Date.now() - slsk.searchStart) / 1000) : 0
  const _slskElapsedStr = _slskElapsed > 0 ? ` (${_slskElapsed}s)` : ''

  // Pure spinner when no results yet
  if (slsk.searching && !slsk.results.length) {
    const pending = slsk.pendingSearches || 0
    const hint = pending > 1
      ? `Searching ${pending} query variants…${_slskElapsedStr}`
      : `Searching P2P network…${_slskElapsedStr}`
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
      <button class="osrc-agent-btn" id="slsk-connect-btn">Connect</button>
    </div>`
  }

  const rawGroups = _slskGroupByFolder()

  // Re-sort with query-relevance as a tiebreaker within the same FLAC-count tier
  const qWords = (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const _qScore = g => qWords.length
    ? qWords.filter(w => (g.folderName || '').toLowerCase().includes(w)).length / qWords.length
    : 0
  const groups = rawGroups.sort((a, b) => {
    // Surround first, always. It is the rarest thing in these results and the
    // whole reason for searching; a lossless stereo rip ranking above a 5.1 one
    // buries the only copy worth having.
    const SF = window.PapaSlskFilters
    if (SF) {
      const aS = SF.groupSurround(a) ? 1 : 0, bS = SF.groupSurround(b) ? 1 : 0
      if (aS !== bS) return bS - aS
    }
    const aF = a.files.filter(f => f.isFlac).length, bF = b.files.filter(f => f.isFlac).length
    if (bF !== aF) return bF - aF
    const qs = _qScore(b) - _qScore(a)
    if (Math.abs(qs) > 0.15) return qs
    if (b.files.length !== a.files.length) return b.files.length - a.files.length
    return b.uploadSpeed - a.uploadSpeed
  })

  if (!groups.length && slsk.searched) {
    // Same rule as the compact row: say what actually happened. Retrying a
    // search against a daemon that is down or unauthenticated fails forever,
    // and the old copy actively encouraged exactly that.
    const failed = !!slsk.error
    return `<div class="slsk-container" id="slsk-row">
      <div class="slsk-header-row">
        <span class="osrc-name">Soulseek</span>
        <span class="osrc-status ${failed ? 'error' : 'not-found'}">${failed ? esc(slsk.error) : 'No results'}</span>
        <button class="slsk-retry-btn" id="slsk-retry-btn">↺ Retry</button>
      </div>
      <div class="slsk-nat-hint">
        ${failed
          ? 'Nothing was searched — the error above needs fixing first. Check that slskd is running and connected.'
          : 'Nothing found on the P2P network. The Soulseek network may still be warming up — click <strong>Retry</strong> to search again.'}
      </div>
    </div>`
  }
  if (!groups.length) {
    // An actual failure must never render as "nothing found" -- that sends the
    // user off retrying a search that cannot succeed. .osrc-status.error has
    // had a CSS rule all along; nothing could ever trigger it until now.
    if (slsk.error) {
      return `<div class="osrc-row slsk-row" id="slsk-row">
        <span class="osrc-name">Soulseek</span>
        <span class="osrc-status error">${esc(slsk.error)}</span>
        <button class="slsk-retry-btn" id="slsk-retry-btn" title="Search again">↺ Retry</button>
      </div>`
    }
    return `<div class="osrc-row slsk-row" id="slsk-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status not-found">Nothing found</span>
    </div>`
  }

  const flacGroups  = groups.filter(g => g.files.some(f => f.isFlac))
  const otherGroups = groups.filter(g => !g.files.some(f => f.isFlac))
  // FLAC/lossless groups first, then other formats — show up to 60 sources
  const ordered      = [...flacGroups, ...otherGroups]
  const SF           = window.PapaSlskFilters
  const filtered     = SF ? SF.applyFilterSort(ordered, { filter: slsk.filter, sort: slsk.sort }) : ordered
  const surroundCount = SF ? ordered.filter(g => SF.groupSurround(g)).length : 0
  const hiresCount    = SF ? ordered.filter(g => SF.isHiResGroup(g)).length : 0
  const displayList   = filtered.slice(0, 60)
  // data-gi is an index into displayList, which is FLAC-partitioned,
  // surround-sorted, filtered and capped at 60. bindSlskSearchEvents used to
  // rebuild its own array from _slskGroupByFolder(), which has none of that --
  // so every handler indexed a different folder from a different peer.
  _slskRendered = displayList
  const filteredNote  = slsk.filter !== 'all'
    ? ` · <span class="slsk-filter-note">${filtered.length} match${filtered.length !== 1 ? 'es' : ''}</span>` : ''
  const isUpdating   = slsk.searching && slsk.results.length > 0
  const pending      = slsk.pendingSearches || 0
  const updateNote   = isUpdating ? ` <span class="slsk-updating">· scanning${pending > 0 ? ' ('+pending+' left)' : ''}${_slskElapsed > 0 ? ' ('+_slskElapsed+'s)' : ''}…</span>` : ''
  const summary      = flacGroups.length
    ? `${flacGroups.length} lossless${otherGroups.length > 0 ? ` · ${otherGroups.length} other` : ''} source${groups.length !== 1 ? 's' : ''}${filteredNote}${updateNote}`
    : `${groups.length} source${groups.length !== 1 ? 's' : ''}${updateNote}`

  return `<div class="slsk-container" id="slsk-row">
    <div class="slsk-header-row">
      <span class="osrc-name">Soulseek</span>
      <span class="osrc-status found">${summary}</span>
      <button class="slsk-retry-btn" id="slsk-saved-btn" title="Saved libraries" style="margin-left:auto">★</button>
      <button class="slsk-retry-btn" id="slsk-retry-btn" title="Search again">↺</button>
    </div>
    <div class="slsk-filterbar">
      ${[['all', 'All', ordered.length],
         ['surround', '5.1 / Surround', surroundCount],
         ['hires', 'Hi-Res', hiresCount],
         ['lossless', 'Lossless', flacGroups.length]]
        .map(([k, label, n]) => `<button class="slsk-chip${slsk.filter === k ? ' active' : ''}"
              data-slsk-filter="${k}"${n === 0 && k !== 'all' ? ' disabled' : ''}
              title="${n} source${n !== 1 ? 's' : ''}">${label}<span class="slsk-chip-n">${n}</span></button>`).join('')}
      <label class="slsk-sort-wrap">Sort
        <select class="slsk-sort" id="slsk-sort">
          ${[['relevance', 'Best match'], ['sampleRate', 'Sample rate'], ['bitDepth', 'Bit depth'],
             ['tracks', 'Track count'], ['speed', 'Upload speed'], ['size', 'File size']]
            .map(([k, l]) => `<option value="${k}"${slsk.sort === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="slsk-grid">
      ${displayList.map((g, gi) => {
        const qual    = _slskQualLabel(g.files)
        const hasFlac = g.files.some(f => f.isFlac)
        const hue     = Math.abs([...g.folderName].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 360
        var slskInLib = state.library.some(function(a) {
          var fn = g.folderName.toLowerCase()
          return a.name && (a.name.toLowerCase().includes(fn) || fn.includes(a.name.toLowerCase()))
        })
        var slskBadge = slskInLib ? '<span class="in-lib-badge" style="background:rgba(29,185,84,.15);color:#1db954;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px">In Library</span>' : ''
        return `<div class="slsk-card" data-gi="${gi}">
          <div class="slsk-card-art" style="background:linear-gradient(135deg,hsl(${hue},45%,16%),hsl(${(hue+40)%360},35%,10%))">
            ${hasFlac ? '<span class="slsk-card-lossless">LOSSLESS</span>' : ''}
            ${(() => { const sd = window.PapaSlskFilters && window.PapaSlskFilters.groupSurround(g)
                       return sd ? `<span class="slsk-card-surround" title="Labelled ${esc(sd.label)} by the uploader">${esc(sd.label)}</span>` : '' })()}
            <svg class="slsk-card-note" viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
          </div>
          <div class="slsk-card-body">
            <div class="slsk-card-name" title="${esc(g.folderName)}">${highlightMatch(g.folderName, query)}${slskBadge} <span style="font-size:11px;color:var(--text3);font-weight:400">(${g.files.length} files)</span></div>
            ${qual ? `<div class="slsk-card-qual">${esc(qual)}</div>` : ''}
            <div class="slsk-card-from">via <button class="slsk-user-link" data-gi="${gi}" data-username="${esc(g.username)}" title="Browse ${esc(g.username)}'s shared library">${esc(g.username)}</button></div>
            <div class="slsk-card-btns">
              <button class="slsk-play-btn slsk-card-action" data-gi="${gi}" title="Download &amp; play">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Play
              </button>
              <button class="slsk-dl-all-btn slsk-card-action" data-gi="${gi}" title="Download all files">
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> ${g.files.length}
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

  // Surround-targeted variants ("<album> 5.1", "<album> SACD") were tried here
  // and measured zero responses on the live network, while the plain query
  // returned 250 responses containing 287 surround-labelled files from 17
  // peers. Soulseek matches filename tokens, and the surround wording lives in
  // folder names rather than the tokens a query is matched against - so the
  // base query already finds them and the extra searches only burn search
  // slots, which is what clogged the queue before. Filtering the results is the
  // approach that works; searching for the label is not.
  return variants.slice(0, 8)
}

// Client-side cache invalidation — passes noCache:true to main process for all variants
const _nocacheQueries = new Set()
function _searchCache_invalidate(query) {
  _buildSearchVariants(query).forEach(v => _nocacheQueries.add(v.toLowerCase()))
  setTimeout(() => _buildSearchVariants(query).forEach(v => _nocacheQueries.delete(v.toLowerCase())), 60000)
}

async function runSlskSearch(query) {
  slsk.lastQuery = query
  slsk.error = null
  if (!state.isOnline) {
    // #slsk-results does not exist -- the container is #slsk-section. This wrote
    // into null and the user was shown the previous results with no message.
    slsk.error = 'You are offline — Soulseek is unavailable.'
    slsk.searching = false
    slsk.searched = true
    _slskRepaint(query)
    return
  }
  const navQ = document.getElementById('nav-search-query')
  if (navQ) navQ.textContent = query

  // Show "Searching…" immediately — avoids flash while status is fetched
  slsk.searching = true
  slsk.searched  = false
  slsk.results   = []
  slsk.pendingSearches = 0
  slsk.searchStart = Date.now()
  const sectionEarly = document.getElementById('slsk-section')
  if (sectionEarly) { sectionEarly.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }

  await refreshSlskStatus()

  const section = document.getElementById('slsk-section')
  if (!section) return

  if (!slsk.status.connected) {
    slsk.searching = false
    if (_slskTimer) { clearInterval(_slskTimer); _slskTimer = null }
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
      const content = document.getElementById('content')
      const st = content ? content.scrollTop : 0
      const sec = document.getElementById('slsk-section')
      if (sec) { sec.innerHTML = renderSoulseekRow(query); bindSlskSearchEvents(query) }
      if (content && st > 0) content.scrollTop = st
    })
  }

  // Start 1s timer for elapsed-time display
  if (_slskTimer) clearInterval(_slskTimer)
  _slskTimer = setInterval(_flush, 1000)

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
    }).catch((e) => {
      // Was `.catch(() => {})`, so a dead daemon, a 401 or a timeout was
      // indistinguishable from a genuinely empty search: the user was told
      // "Nothing found on the P2P network" and invited to Retry forever.
      slsk.error = _slskErrText(e)
    }).finally(() => {
      slsk.pendingSearches = Math.max(0, slsk.pendingSearches - 1)
      if (slsk.pendingSearches === 0) {
        slsk.searching = false
        slsk.searched  = true
        window.api.off('slsk-progress')
        if (_slskTimer) { clearInterval(_slskTimer); _slskTimer = null }
      }
      _flush()
    })
  ))

  // Final cleanup in case some variant is still pending (shouldn't happen after Promise.all)
  window.api.off('slsk-progress')
  slsk.searching = false
  slsk.searched  = true
  if (_slskTimer) { clearInterval(_slskTimer); _slskTimer = null }
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
let _dlDaemonDown       = false

// Amber sub-label for a row the local scheduler is holding back (it has not
// been sent to slskd yet). Was called from _renderActiveTab but never defined,
// which threw on every render of the Downloading tab.
function _dlWaitLabel(f) {
  if (!f || !f.scheduled) return ''
  var bits = []
  if (f.sourceCount > 1) bits.push(f.sourceCount + ' sources')
  if (f.attempts > 0) bits.push('retry ' + f.attempts)
  return bits.length ? 'Waiting \u00b7 ' + bits.join(' \u00b7 ') : 'Waiting for a slot'
}
let _dlLastSig          = ''        // tracks current rendered structure to avoid full re-renders
let _dlDownloadDir      = ''        // local download directory, loaded once on page open
let _dlPrevActiveIds    = new Set() // IDs of files that were active on last poll
let _dlSyncTimer        = null      // debounce handle for post-download library sync
const _dlOpenGroups       = new Set() // folder names explicitly opened in completed tab
const _dlFailedOpenGroups = new Set() // folder names explicitly opened in failed tab
let _dlFilter             = ''        // current text filter for completed tab
let _dlCompletedGroups    = []        // flat group list from last completed render (for expand-all)

// Keeps aria-selected in step with the .active class. Stale ARIA is worse than
// none: it actively tells a screen-reader user the wrong tab is current.
function _setActiveTab(selector, activeEl) {
  document.querySelectorAll(selector).forEach(function (b) {
    var on = b === activeEl
    b.classList.toggle('active', on)
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', on ? 'true' : 'false')
  })
}

function _dlSig(tab, files) {
  // Rolling hash rather than joining every id: the Completed tab can hold
  // thousands of rows and this runs on every poll tick.
  var h = 0
  for (var i = 0; i < files.length; i++) {
    var id = String(files[i].id)
    for (var j = 0; j < id.length; j++) h = (h * 31 + id.charCodeAt(j)) | 0
  }
  return tab + '|' + files.length + '|' + h
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

let _dlPollInFlight = false
const _dlJustFinished = new Set()
async function _pollAndRenderDownloads() {
  // Re-entrancy guard: an older response landing after a newer one used to
  // write stale _dlLastFiles, flickering cancelled rows back into the list.
  if (_dlPollInFlight) return
  _dlPollInFlight = true
  try {
  return await _pollAndRenderDownloadsInner()
  } finally { _dlPollInFlight = false }
}

async function _pollAndRenderDownloadsInner() {
  var _dlReachable = true
  const raw = await window.api.slskGetTransfers().catch(function () { _dlReachable = false; return [] })
  _dlDaemonDown = !_dlReachable
  const files = []
  for (const user of (raw || [])) {
    for (const dir of (user.directories || [])) {
      for (const f of (dir.files || [])) {
        files.push({ ...f, username: user.username })
      }
    }
  }

  // Files the scheduler is holding are real, pending work — show them here or
  // they read as lost. slskd only knows about what has actually been sent.
  if (window.api.slskSchedulerQueue) {
    const sched = await window.api.slskSchedulerQueue().catch(() => null)
    if (sched) {
      const known = new Set(files.map(f => f.filename))
      for (const f of (sched.files || [])) {
        if (!known.has(f.filename)) files.push(f)
      }
      _dlPaintSchedulerStats(sched.stats)
    }
  }
  _dlLastFiles = files

  // Detect transitions from active → succeeded and trigger a library sync
  const nowActive = new Set(files.filter(f => _dlCategory(f.state) === 'active').map(f => f.id))
  const prevActive = new Set(_dlPrevActiveIds)
  const justCompleted = new Set(files.filter(f => prevActive.has(f.id) && _dlCategory(f.state) === 'completed').map(f => f.id))
  if (justCompleted.size) {
    clearTimeout(_dlSyncTimer)
    _dlSyncTimer = setTimeout(() => backgroundSync(), 3000)
    for (const f of files) {
      // Set lookup, not Array.includes inside a loop over the whole history.
      if (justCompleted.has(f.id)) {
        _dlJustFinished.add(f.id)
        window.api.slskVerifyFile({ username: f.username, filename: f.filename }).catch(() => {})
      }
    }
  }
  _dlPrevActiveIds = nowActive

  const activeCount = files.filter(function(f) { return _dlIsActive(f.state) }).length
  var _startOfToday = new Date(); _startOfToday.setHours(0, 0, 0, 0)
  var _todayMs = _startOfToday.getTime()
  var todayDone = files.filter(function(f) {
    if (_dlCategory(f.state) !== 'completed') return false
    var t = new Date(f.endedAt || 0).getTime()
    return t >= _todayMs
  }).length
  const badge = document.getElementById('nav-dl-badge')
  if (badge) { badge.style.display = (activeCount > 0 || todayDone > 0) ? 'flex' : 'none'; badge.textContent = activeCount > 0 ? activeCount : todayDone; badge.title = activeCount + ' active, ' + todayDone + ' completed' }

  // Only what just finished this session, not slskd's entire memory.
  const completedNow = files.filter(f => _dlCategory(f.state) === 'completed' && _dlJustFinished.has(f.id))
  if (_dlPrevActiveCount > 0 && activeCount === 0 && completedNow.length > 0) {
    const folder = completedNow[0] ? _dlFolderName(completedNow[0].filename) || 'your music' : 'your music'
    window.api.notifyDownloadComplete({ count: completedNow.length, albumName: folder })
    // Reset, so the next batch reports its own count rather than accumulating.
    _dlJustFinished.clear()
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
  if (parts.includes('Scheduled'))    return { label: 'Waiting',     cls: 'dl2-tag-waiting'  }
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
  // An artist+album hit is unambiguous, so it wins outright. A bare name match
  // needs to be long enough to mean something -- an album called "1" used to
  // match almost any folder and stamp its cover over half the Completed tab.
  let loose = null
  for (const a of state.library) {
    const nl = String(a.name || '').toLowerCase()
    if (!nl) continue
    const al = String(a.artist || '').toLowerCase()
    if (al && (fl.includes(`${al} ${nl}`) || fl.includes(`${nl} ${al}`))) return a.artPath || null
    if (!loose && nl.length >= 5 && (fl.includes(nl) || nl.includes(fl))) loose = a
  }
  return loose?.artPath || null
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
        <button class="torrent-remove" data-hash="${esc(t.infoHash)}" title="Cancel" aria-label="Cancel">✕</button>
      </div>
    </div>`
  }).join('')
  container.querySelectorAll('.torrent-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return
      const t = state._torrents?.get(btn.dataset.hash)
      const pct = t && t.progress ? Math.round(t.progress * 100) : 0
      if (!confirm('Remove this torrent?' + (pct ? '\n\nIt is ' + pct + '% complete.' : ''))) return
      btn.disabled = true
      let ok = true
      await window.api.torrentRemove(btn.dataset.hash).catch(() => { ok = false })
      if (!ok) {
        // Was dropped from local state regardless, so a failed remove left the
        // row gone from the UI while the torrent kept running.
        btn.disabled = false
        showSnackbar("Couldn't remove that torrent")
        return
      }
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
    // "slskd is unreachable" and "you have no downloads" used to render the
    // exact same friendly empty state, so a dead daemon looked like an idle one.
    container.innerHTML = _dlDaemonDown
      ? `<div class="dl2-empty">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <p>Can't reach the Soulseek daemon</p>
          <span>slskd isn't responding, so downloads can't be listed. Check that it's running, then retry.</span>
          <button class="dl2-action-btn" id="dl2-daemon-retry" style="margin-top:12px">Retry</button>
        </div>`
      : `<div class="dl2-empty">
          <svg viewBox="0 0 24 24"><path d="${icons[_dlTab]}"/></svg>
          <p>${msgs[_dlTab][0]}</p><span>${msgs[_dlTab][1]}</span>
        </div>`
    container.querySelector('#dl2-daemon-retry')?.addEventListener('click', function () {
      this.disabled = true
      this.textContent = 'Retrying…'
      _pollAndRenderDownloads()
    })
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

  var html = `<div class="dl2-stats-bar">
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
    var key    = `${f.username}::${folder}`
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
      ? `<img src="${esc('file://' + artPath)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="dl2-group-album-art-fallback" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/></svg></div>`
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
              ${_dlWaitLabel(f) ? `<span class="dl2-meta-wait">${esc(_dlWaitLabel(f))}</span>` : ''}
            </div>
          </div>
          <div class="dl2-file-end">
            <span class="dl2-tag ${cls}">${label}</span>
            <button class="dl2-icon-btn dl2-cancel-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" title="Cancel" aria-label="Cancel">
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
            ${/^searching/i.test(String(g.username || '')) ? `<span class="dl2-group-sub">Looking for a source…</span>` : `<button class="dl2-meta-user-btn dl2-hdr-user-btn" data-username="${esc(g.username)}" title="Browse ${esc(g.username)}'s library">
              <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
              ${esc(g.username)}
            </button>`}
          </div>
          <div class="dla-prog-row">
            <div class="dla-grp-bar"><div class="dla-grp-fill" style="width:${albumPct}%"></div></div>
            <span class="dla-grp-pct">${albumPct}%</span>
            ${albumSpeed ? `<span class="dla-grp-speed">${_fmtSpeed(albumSpeed)}</span>` : ''}
            ${maxEta2 ? `<span class="dla-grp-eta">ETA ${_fmtSecs(maxEta2)}</span>` : ''}
          </div>
        </div>
        <button class="dl2-icon-btn dl2-grp-btn dl2-cancel-btn dl2-cancel-group-btn" data-user="${esc(g.username)}" data-ids="${esc(groupIds)}" title="Cancel all in group" aria-label="Cancel all in group">
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
      if (u) showSlskUserExplorer(u)
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
  var statsHtml = `<div class="dl2-completed-stats">
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
        ? `<img src="${esc('file://' + g.artPath)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="dl2-group-album-art-fallback" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V5h4V3h-6z"/></svg></div>`
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
              <button class="dl2-icon-btn dl2-play-btn" data-filename="${esc(f.filename)}" data-user="${esc(f.username)}" title="Play" aria-label="Play">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button class="dl2-icon-btn dl2-open-btn" data-filename="${esc(f.filename)}" data-user="${esc(f.username)}" title="Show in folder" aria-label="Show in folder">
                <svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
              </button>
              <button class="dl2-icon-btn dl2-remove-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" title="Remove from list" aria-label="Remove from list">
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
          <button class="dl2-icon-btn dl2-grp-btn dl2-play-btn dl2-play-all-btn" data-gi="${gi}" title="Play all" aria-label="Play all">
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
      if (u) showSlskUserExplorer(u)
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
  var html = `<div class="dl2-completed-stats">
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
      ? `<img src="${esc('file://' + g.artPath)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="dl2-group-album-art-fallback" style="display:none"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></div>`
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
            <button class="dl2-icon-btn dl2-retry-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" data-filename="${esc(f.filename)}" data-size="${f.size || 0}" title="Retry" aria-label="Retry">
              <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
            <button class="dl2-icon-btn dl2-remove-btn" data-id="${esc(f.id)}" data-user="${esc(f.username)}" title="Remove" aria-label="Remove">
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
        <button class="dl2-icon-btn dl2-grp-btn dl2-retry-all-btn" data-gi="${gi}" data-user="${esc(firstUser)}" data-ids="${esc(groupIds)}" title="Retry all" aria-label="Retry all">
          <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        </button>
        <button class="dl2-icon-btn dl2-grp-btn dl2-clear-group-btn" data-pairs="${esc(JSON.stringify(g.files.map(function (f) { return [f.username, f.id] })))}" title="Clear group" aria-label="Clear group">
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
      if (u) showSlskUserExplorer(u)
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
      _setActiveTab('.dl2-tab', document.querySelector('.dl2-tab[data-tab="active"]'))
      await _pollAndRenderDownloads()
    })
  })

  // Clear all files in a group
  container.querySelectorAll('.dl2-clear-group-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (btn.disabled) return
      btn.disabled = true
      // Each file carries its own peer: a folder group can span several.
      var pairs = []
      try { pairs = JSON.parse(btn.dataset.pairs || '[]') } catch (_) {}
      var results = await Promise.all(pairs.map(function (p) {
        return window.api.slskCancelTransfer({ username: p[0], id: p[1] })
          .then(function () { return true }).catch(function () { return false })
      }))
      var failed = results.filter(function (ok) { return !ok }).length
      if (failed) showSnackbar(failed + ' of ' + results.length + " couldn't be cleared")
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
      _setActiveTab('.dl2-tab', document.querySelector('.dl2-tab[data-tab="active"]'))
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
      if (btn.disabled) return
      const original = btn.innerHTML
      btn.disabled = true
      let ok = true
      await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id })
        .catch(() => { ok = false })
      if (!ok) {
        // Restore rather than leaving a tick over a download that is still running.
        btn.innerHTML = original
        btn.disabled = false
        showSnackbar("Couldn't cancel that download")
        return
      }
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
      _pollAndRenderDownloads()
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
    <div class="yt-row" data-ytdl-row="${esc(d.id)}">
      <div class="yt-info">
        <div class="yt-title">${esc(d.title)} <span class="yt-badge">YT</span></div>
        <div class="yt-sub">${esc(d.artist || '')}</div>
      </div>
      ${d.state === 'downloading'
        // `d.percent` can be absent on the first event: width:undefined% is
        // invalid (the bar collapses) and the label read "NaN%".
        ? `<div class="yt-dl-bar"><div class="yt-dl-fill" style="width:${Math.max(0, Math.min(100, Number(d.percent) || 0))}%"></div></div><span class="yt-dur">${Math.round(Number(d.percent) || 0)}%</span>`
        : d.state === 'completed'
          ? `<span class="yt-dl-done">✓ Done</span>`
          : `<span class="yt-error" title="${esc(d.error || '')}">✗ Failed</span>`}
      ${d.state === 'downloading'
        ? ''
        // Finished rows had no way to be dismissed and failed ones no way to be
        // retried, so they accumulated for the whole session.
        : `<button class="yt-btn yt-dl-dismiss" data-ytdl="${esc(d.id)}" title="Dismiss" aria-label="Dismiss">✕</button>`}
    </div>`).join('')

  box.querySelectorAll('.yt-dl-dismiss').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      state.ytDownloads.delete(btn.dataset.ytdl)
      _renderYtDownloadRows(box)
    })
  })
}

function renderDownloads() {
  var totalDl = 0, activeDl = 0, completedDl = 0, failedDl = 0
  // Reads the array the poll actually writes. state._dlFiles is never assigned
  // anywhere, so these four headline numbers were permanently 0/0/0/0 while the
  // tab counts right below them showed the real values.
  ;(_dlLastFiles || []).forEach(function(f) {
    totalDl++
    var cat = _dlCategory(f.state || '')
    if (cat === 'active') activeDl++
    else if (cat === 'completed') completedDl++
    else if (cat === 'failed') failedDl++
  })
  var dashHTML = '<div class="dl-dashboard"><div class="dl-stat-card"><div class="dl-stat-value">' + activeDl + '</div><div class="dl-stat-label">Active</div></div><div class="dl-stat-card"><div class="dl-stat-value">' + completedDl + '</div><div class="dl-stat-label">Completed</div></div><div class="dl-stat-card"><div class="dl-stat-value">' + failedDl + '</div><div class="dl-stat-label">Failed</div></div><div class="dl-stat-card"><div class="dl-stat-value">' + totalDl + '</div><div class="dl-stat-label">Total</div></div></div>'
  var batchBtns = '<div style="display:flex;gap:8px;padding:12px 28px"><button class="dl-action-btn" id="dl-pause-all">\u23f8 Pause All</button><button class="dl-action-btn" id="dl-resume-all">\u25b6 Resume All</button></div>'
  var wishlistHTML = state.downloadWishlist && state.downloadWishlist.length ? '<div class="section-header"><span class="section-title">Wishlist</span></div>' + state.downloadWishlist.map(function(w, i) { return '<div class="wishlist-row"><span>' + esc(w.query) + '</span><button class="wishlist-search-btn" data-wl-idx="' + i + '">Search</button><button class="wishlist-remove-btn" data-wl-idx="' + i + '">Remove</button></div>' }).join('') : '<div class="section-header"><span class="section-title">Wishlist</span></div><div style="padding:8px 28px;color:var(--text3);font-size:12px">Add albums to wishlist from any search result to auto-download them when available.</div>'

  setContent(`<div class="dl2-page">
    <div class="dl2-topbar">
      <div class="dl2-topbar-left">
        <h2 class="dl2-title">Downloads</h2>
        <button class="dl2-folder-btn" id="dl2-folder-btn" title="Change download folder">
          <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
          <span id="dl2-folder-label">…</span>
        </button>
      </div>
      <div class="dl2-topbar-right">
        <span class="dl2-sched" id="dl2-sched" role="status" aria-live="polite" title="Files metered out across peers by the download scheduler"></span>
        <button class="dl2-action-btn" id="dl2-rebalance-btn" title="Pull deep per-peer queues back and spread them across sources">Rebalance</button>
        <button class="dl2-action-btn" id="dl2-action-btn" style="display:none">Clear All</button>
      </div>
    </div>
    ${dashHTML}
    ${batchBtns}
    ${wishlistHTML}
    <div class="dl2-tabs" id="dl2-tabs" role="tablist" aria-label="Download categories">
      <button class="dl2-tab active" role="tab" aria-selected="true" data-tab="active">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Downloading
        <span class="dl2-tab-count" id="dl2-tab-count-active" style="display:none">0</span>
      </button>
      <button class="dl2-tab" role="tab" aria-selected="false" data-tab="completed">
        <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        Completed
        <span class="dl2-tab-count dl2-tab-count-green" id="dl2-tab-count-completed" style="display:none">0</span>
      </button>
      <button class="dl2-tab" role="tab" aria-selected="false" data-tab="failed">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        Failed
        <span class="dl2-tab-count dl2-tab-count-red" id="dl2-tab-count-failed" style="display:none">0</span>
      </button>
      <button class="dl2-tab" role="tab" aria-selected="false" data-tab="torrents">
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
      <input class="dl2-filter-input" id="dl2-filter-input" type="text" placeholder="Filter albums…" autocomplete="off" value="${esc(_dlFilter || '')}">
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
      _setActiveTab('.dl2-tab', btn)
      _dlTab = btn.dataset.tab
      _dlLastSig = ''   // force full re-render on tab switch
      _renderDlTab(_dlLastFiles)
    })
  })

  // Scheduler: live spread readout + manual rebalance
  _dlPaintSchedulerStats()
  if (window.api && window.api.slskSchedulerStats) {
    window.api.slskSchedulerStats().then(_dlPaintSchedulerStats).catch(function() {})
  }
  document.getElementById('dl2-rebalance-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('dl2-rebalance-btn')
    if (!btn || btn.disabled) return
    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = 'Rebalancing…'
    const res = await window.api.slskRespreadBacklog({}).catch(function() { return null })
    if (res && res.ok) {
      showSnackbar(`Re-spread ${res.respread} queued file${res.respread === 1 ? '' : 's'}, cleared ${res.purged} dead`)
      _dlPaintSchedulerStats(res.stats)
    } else {
      showSnackbar('Rebalance failed: ' + ((res && res.error) || 'slskd unreachable'))
    }
    btn.textContent = orig
    btn.disabled = false
  })

  // Action button (Cancel All / Clear All) — parallel for speed
  document.getElementById('dl2-action-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('dl2-action-btn')
    if (!btn || btn.disabled) return
    const subset = _dlLastFiles.filter(f => _dlCategory(f.state) === _dlTab)
    if (!subset.length) return
    if (_dlTab === 'active' && !confirm(
      'Cancel ' + subset.length + ' download' + (subset.length === 1 ? '' : 's') + '?\n\n' +
      'Soulseek cannot resume — these have to be queued again.')) return
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
    _setActiveTab('.dl2-tab', activeBtnForCurrentTab)
  }

  // Load and display current download folder, also cache it for play buttons
  window.api.slskGetDownloadDir().catch(function () { return null }).then(dir => {
    if (!dir) {
      var lbl = document.getElementById('dl2-folder-label')
      if (lbl) { lbl.textContent = 'Not set'; lbl.title = 'Could not read the download folder from slskd' }
      return
    }
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

  document.getElementById('dl-pause-all')?.addEventListener('click', function() {
    var active = (_dlLastFiles || []).filter(function(f) { return _dlCategory(f.state) === 'active' })
    if (!active.length) { showSnackbar('Nothing is downloading'); return }
    // This calls slskCancelTransfer: Soulseek has no resume, so "pause" really
    // aborts and loses queue position on every peer. It used to do it silently
    // against an array that was always empty, so it also always did nothing.
    if (!confirm('Stop ' + active.length + ' download' + (active.length === 1 ? '' : 's') +
      '?\n\nSoulseek cannot resume — these will have to be queued again.')) return
    active.forEach(function(f) {
      window.api.slskCancelTransfer({ username: f.username, id: f.id })
    })
    showSnackbar('Stopped ' + active.length + ' download' + (active.length === 1 ? '' : 's'))
  })

  document.getElementById('dl-resume-all')?.addEventListener('click', function() {
    showSnackbar('Resume not yet supported \u2014 re-queue downloads')
  })

  _pollAndRenderDownloads()
}

// Re-render the results in place from data already fetched.
function _rerenderSlskSection(query) {
  const sec = document.getElementById('slsk-section')
  if (!sec) return
  sec.innerHTML = renderSoulseekRow(query)
  bindSlskSearchEvents(query)
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

  section.querySelector('#slsk-connect-btn')?.addEventListener('click', async () => {
    await refreshSlskStatus()
    if (slsk.status.connected) {
      runSlskSearch(query)
    } else {
      showSlskConfigModal(query)
    }
  })

  section.querySelector('#slsk-saved-btn')?.addEventListener('click', () => showSlskSavedUsers())

  section.querySelector('#slsk-retry-btn')?.addEventListener('click', () => {
    _searchCache_invalidate(query)  // force-fresh on manual retry
    runSlskSearch(query)
  })

  // Filter and sort are pure view state: re-render, never re-search. A repeat
  // network search to narrow results already in hand would be slow and rude to
  // the peers serving them.
  section.querySelectorAll('[data-slsk-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      slsk.filter = btn.getAttribute('data-slsk-filter')
      _rerenderSlskSection(query)
    })
  })
  section.querySelector('#slsk-sort')?.addEventListener('change', e => {
    slsk.sort = e.target.value
    _rerenderSlskSection(query)
  })

  // Must be the array the cards were rendered from, not a fresh regroup:
  // data-gi indexes displayList. This also avoids a second full regroup of
  // every response on every one-second flush.
  const groups = _slskRendered

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
        // Every file from one peer means waiting in that peer's queue once per
        // file - they grant one or two upload slots, and our own download slots
        // are already unlimited. Sourcing tracks from several peers that have
        // the same release is the only thing that genuinely runs them in
        // parallel. Size matching keeps a stereo rip from completing a
        // surround album.
        const S = window.PapaSpread
        const SF2 = window.PapaSlskFilters
        const anchorSur = SF2 ? SF2.groupSurround(g) : null
        const alternates = S ? groups.filter(o => {
          if (!o.folderName || !g.folderName) return false
          if (o.folderName.toLowerCase() !== g.folderName.toLowerCase()) return false
          // If the chosen release is surround, every alternate must be too.
          // Size matching alone would let an unlabelled stereo rip through
          // whenever its tracks happened to land in the tolerance window.
          if (anchorSur && SF2 && !SF2.groupSurround(o)) return false
          return true
        }) : []
        const plan = (S && alternates.length > 1)
          ? S.planSpread(alternates, { anchor: g, maxPerUser: 2 })
          : g.files.map(f => ({ username: g.username, filename: f.filename, size: f.size }))

        const peers = S ? S.planPeers(plan) : 1
        if (peers > 1) showSnackbar(`Downloading from ${peers} sources in parallel`)

        await _slskEnqueue(plan)
        _scheduleLibRescan()
        if (anchorSur) _verifySurroundWhenDone(g, plan, anchorSur.label)
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
      _slskEnqueue(sorted.slice(1).map(f =>
        ({ username: g.username, filename: f.filename, size: f.size })))
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
      if (username) showSlskUserExplorer(username)
    })
  })

}


// ── Soulseek user library: file explorer ─────────────────────────────────────
// The old view was a flat list of every folder path with a text filter, which
// is unusable for a user sharing thousands of directories. This walks the tree
// one level at a time with back/forward/up, breadcrumbs and per-folder actions.
async function showSlskUserExplorer(username) {
  hideContextMenu()
  document.getElementById('slsk-user-lib-modal')?.remove()

  const T = window.PapaSlskTree
  const dlg = document.createElement('div')
  dlg.id = 'slsk-user-lib-modal'
  dlg.className = 'modal-overlay'
  dlg.innerHTML = `<div class="modal-box slsk-lib-box">
    <div class="modal-header-row">
      <div class="modal-title">${esc(username)}</div>
      <button class="slskx-star" id="slskx-star" title="Save this library">☆</button>
      <button class="modal-close-btn" id="slsk-lib-close">✕</button>
    </div>
    <div class="slskx-toolbar">
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
              title="List every surround-labelled folder in this library">5.1 only</button>
    </div>
    <div class="slskx-actionbar" id="slskx-actionbar"></div>
    <div class="slsk-lib-body" id="slsk-lib-body">
      <div class="slsk-lib-loading">Loading ${esc(username)}'s library…</div>
    </div>
    <div class="slskx-statusbar" id="slskx-status"></div>
  </div>`
  document.body.appendChild(dlg)

  const body    = dlg.querySelector('#slsk-lib-body')
  const crumbs  = dlg.querySelector('#slskx-crumbs')
  const status  = dlg.querySelector('#slskx-status')
  const actions = dlg.querySelector('#slskx-actionbar')
  const search  = dlg.querySelector('#slskx-search')

  const close = () => { document.removeEventListener('keydown', onKey); dlg.remove() }
  dlg.querySelector('#slsk-lib-close').addEventListener('click', close)
  dlg.addEventListener('click', e => { if (e.target === dlg) close() })

  let tree = null
  const hist = new T.NavHistory('')
  let sort = 'name'
  let audioOnly = true
  let searching = ''
  let surroundOnly = false

  function fmtSize(n) {
    n = Number(n) || 0
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
    if (n >= 1048576)    return (n / 1048576).toFixed(0) + ' MB'
    if (n >= 1024)       return (n / 1024).toFixed(0) + ' KB'
    return n + ' B'
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

    const audioHere = l.files.filter(f => T.AUDIO_RE.test(f.name))
    actions.innerHTML = audioHere.length
      ? `<button class="slskx-act" id="slskx-dl-folder">Download folder (${audioHere.length})</button>
         <button class="slskx-act" id="slskx-play-first">Play first track</button>`
      : (l.node.fileCount
          ? `<button class="slskx-act" id="slskx-dl-tree">Download everything below (${l.node.fileCount})</button>` : '')

    const rows = []
    for (const d of l.dirs) {
      rows.push(`<div class="slskx-row slskx-dir" data-path="${esc(d.path)}">
        <span class="slskx-ico">📁</span>
        <span class="slskx-name">${esc(d.name)}</span>
        <span class="slskx-meta">${d.subdirCount ? d.subdirCount + ' folders · ' : ''}${d.fileCount} files</span>
        <span class="slskx-size">${fmtSize(d.totalSize)}</span>
      </div>`)
    }
    l.files.forEach((f, i) => {
      const isAudio = T.AUDIO_RE.test(f.name)
      rows.push(`<div class="slskx-row slskx-file${isAudio ? '' : ' dim'}" data-fi="${i}">
        <span class="slskx-ico">${isAudio ? '🎵' : '📄'}</span>
        <span class="slskx-name">${esc(f.name)}</span>
        <span class="slskx-meta">${f.bitDepth ? f.bitDepth + '-bit ' : ''}${f.sampleRate ? (f.sampleRate/1000).toFixed(1) + 'kHz' : ''}</span>
        <span class="slskx-size">${fmtSize(f.size)}</span>
        <span class="slskx-rowbtns">
          ${isAudio ? `<button class="slskx-mini" data-act="play" data-fi="${i}" title="Download &amp; play">▶</button>` : ''}
          <button class="slskx-mini" data-act="dl" data-fi="${i}" title="Download">↓</button>
        </span>
      </div>`)
    })

    body.innerHTML = rows.length ? rows.join('') : `<div class="slsk-lib-empty">This folder is empty.</div>`
    status.textContent = `${l.dirs.length} folder${l.dirs.length !== 1 ? 's' : ''} · ${l.files.length} file${l.files.length !== 1 ? 's' : ''} · ${fmtSize(l.node.totalSize)} below this point`
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
      ? hits.map(h => `<div class="slskx-row slskx-dir" data-path="${esc(h.node.path)}">
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
    body.querySelectorAll('.slskx-dir').forEach(r =>
      r.addEventListener('click', () => { surroundOnly = false; navTo(r.dataset.path) }))
  }

  function renderSearch() {
    const hits = T.searchTree(tree, searching)
    actions.innerHTML = ''
    body.innerHTML = hits.length
      ? hits.map(h => h.type === 'dir'
          ? `<div class="slskx-row slskx-dir" data-path="${esc(h.path)}">
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
    } catch (e) {
      btn.textContent = '✕'; btn.title = 'Failed: ' + (e?.message || 'error')
      setTimeout(() => { btn.innerHTML = orig; btn.disabled = false }, 2500)
    }
  }

  function bindRows(l) {
    body.querySelectorAll('.slskx-dir').forEach(r =>
      r.addEventListener('click', () => navTo(r.dataset.path)))

    body.querySelectorAll('.slskx-mini').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation()
        const f = l.files[parseInt(btn.dataset.fi)]
        if (!f) return
        if (btn.dataset.act === 'dl') return dlFile(btn, f)
        // play: queue the download, then poll for the finished file
        btn.disabled = true; btn.textContent = '…'
        try {
          await window.api.slskDownload({ username, filename: f.fullPath, size: f.size || 0 })
          _scheduleLibRescan()
          const deadline = Date.now() + 120000
          const poll = async () => {
            if (Date.now() > deadline) { btn.textContent = '▶'; btn.disabled = false; return }
            const found = await window.api.slskResolveFile({ username, filename: f.fullPath })
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
      const files = l.files.filter(f => T.AUDIO_RE.test(f.name))
      ev.target.disabled = true
      ev.target.textContent = `Queuing ${files.length}…`
      await _slskEnqueue(files.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
      ev.target.textContent = `${files.length} queued`
      _scheduleLibRescan()
    })

    dlg.querySelector('#slskx-play-first')?.addEventListener('click', () => {
      const first = body.querySelector('.slskx-mini[data-act="play"]')
      if (first) first.click()
    })

    dlg.querySelector('#slskx-dl-tree')?.addEventListener('click', async ev => {
      // Walk every descendant folder, not just this one.
      const collect = (n, out = []) => {
        for (const f of n.files) if (T.AUDIO_RE.test(f.name)) out.push(f)
        for (const c of n.dirs.values()) collect(c, out)
        return out
      }
      const files = collect(l.node)
      ev.target.disabled = true
      ev.target.textContent = `Queuing ${files.length}…`
      await _slskEnqueue(files.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
      ev.target.textContent = `${files.length} queued`
      _scheduleLibRescan()
    })
  }

  function onKey(e) {
    if (!document.getElementById('slsk-user-lib-modal')) return
    if (e.key === 'Escape') return close()
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
    render()
  })
  dlg.querySelector('#slskx-sort').addEventListener('change', e => { sort = e.target.value; render() })
  dlg.querySelector('#slskx-audio-only').addEventListener('change', e => { audioOnly = e.target.checked; render() })
  let _st = null
  search.addEventListener('input', () => {
    clearTimeout(_st)
    _st = setTimeout(() => { searching = search.value.trim(); render() }, 180)
  })

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

  const res = await window.api.slskBrowseUser({ username })
  if (!res.ok) {
    body.innerHTML = `<div class="slsk-lib-empty">Could not load this library: ${esc(res.error || 'unknown error')}</div>`
    return
  }
  tree = T.buildTree(res.directories || [])
  // Skip past a single wrapper folder so the first view is useful, not one row.
  let start = ''
  for (let i = 0; i < 3; i++) {
    const l = T.listDir(tree, start, { audioOnly })
    if (l && l.dirs.length === 1 && !l.files.length) start = l.dirs[0].path
    else break
  }
  if (start) hist.go(start)
  render()
  search.focus()

  // Keep a saved entry's counts and last-visited time current.
  if (window.PapaSavedUsers.isSaved(savedList, username)) {
    savedList = await window.api.slskTouchUser({
      username, fileCount: tree.fileCount, dirCount: tree.dirs.size }).catch(() => savedList)
  }
}

// ── Saved libraries ──────────────────────────────────────────────────────────
async function showSlskSavedUsers() {
  document.getElementById('slsk-saved-modal')?.remove()
  const list = await window.api.slskSavedUsers().catch(() => [])
  const dlg = document.createElement('div')
  dlg.id = 'slsk-saved-modal'
  dlg.className = 'modal-overlay'
  const rows = list.length
    ? list.map(u => `<div class="slskx-saved-row" data-user="${esc(u.username)}">
        <span class="slskx-ico">★</span>
        <span class="slskx-name">${esc(u.username)}</span>
        <span class="slskx-meta">${u.fileCount ? u.fileCount.toLocaleString() + ' files' : ''}${
          u.note ? ' · ' + esc(u.note) : ''}</span>
        <button class="slskx-mini" data-remove="${esc(u.username)}" title="Remove">✕</button>
      </div>`).join('')
    : `<div class="slsk-lib-empty">No saved libraries yet.<br>
         Open any user's library and click ☆ to keep it here.</div>`
  dlg.innerHTML = `<div class="modal-box slsk-lib-box">
    <div class="modal-header-row">
      <div class="modal-title">Saved Libraries</div>
      <button class="modal-close-btn" id="slsk-saved-close">✕</button>
    </div>
    <div class="slsk-lib-body">${rows}</div>
  </div>`
  document.body.appendChild(dlg)
  dlg.querySelector('#slsk-saved-close').addEventListener('click', () => dlg.remove())
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove() })
  dlg.querySelectorAll('.slskx-saved-row').forEach(r => {
    r.addEventListener('click', e => {
      if (e.target.hasAttribute('data-remove')) return
      dlg.remove()
      showSlskUserExplorer(r.dataset.user)
    })
  })
  dlg.querySelectorAll('[data-remove]').forEach(b => {
    b.addEventListener('click', async e => {
      e.stopPropagation()
      await window.api.slskUnsaveUser({ username: b.dataset.remove })
      dlg.remove()
      showSlskSavedUsers()
    })
  })
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
    window.api.openExternal('https://www.slsknet.org/news/')
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

  let history       = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]').map(function(h) { return typeof h === 'string' ? { query: h, ts: Date.now() - 86400000 } : h })
  let activeIdx     = -1   // which row is highlighted by keyboard
  let blurTimer     = null
  var _searchTimeout = null
  var _liveResultsVisible = false

  function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }

  function addToHistory(query) {
    history = history.filter(function(h) { return (typeof h === 'string' ? h : h.query).toLowerCase() !== query.toLowerCase() })
    history.unshift({ query: query, ts: Date.now() })
    if (history.length > MAX_ITEMS) history.pop()
    saveHistory()
  }

  function removeFromHistory(query) {
    history = history.filter(function(h) { return (typeof h === 'string' ? h : h.query) !== query })
    saveHistory()
    renderDropdown(input.value)
  }

  function relativeTime(ts) {
    if (!ts) return ''
    var diff = Date.now() - ts
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
    if (diff < 172800000) return 'yesterday'
    return Math.floor(diff / 86400000) + 'd ago'
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
      ? history.filter(function(h) { var t = typeof h === 'string' ? h : h.query; return t.toLowerCase().includes(q) })
      : history

    if (!matches.length) { hideDropdown(); return }

    var filtered = matches.slice(0, 10)
    dropdown.innerHTML = filtered.map(function(h, i) {
      var qtext = typeof h === 'string' ? h : h.query
      var ts = h.ts ? relativeTime(h.ts) : ''
      return '<div class="sh-item' + (i === activeIdx ? ' active' : '') + '" data-idx="' + i + '" data-query="' + esc(qtext) + '">' +
        '<svg class="sh-icon" viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>' +
        '<span class="sh-text">' + highlight(qtext, filter) + '</span>' +
        (ts ? '<span class="sh-time">' + ts + '</span>' : '') +
        '<button class="sh-item-del" data-query="' + esc(qtext) + '" title="Remove">&#10005;</button></div>'
    }).join('')

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
  input._commitSearch = commitSearch

  input.addEventListener('focus', () => {
    clearTimeout(blurTimer)
    renderDropdown(input.value)
  })

  input.addEventListener('input', () => {
    var val = input.value
    var chip = document.getElementById('search-source-chip')
    var sourceMatch = val.match(/^source:(\S+)/i)

    if (sourceMatch) {
      var source = sourceMatch[1].toLowerCase()
      var sourceLabel = source.charAt(0).toUpperCase() + source.slice(1)
      if (!chip) {
        chip = document.createElement('span')
        chip.id = 'search-source-chip'
        chip.style.cssText = 'position:absolute;left:12px;top:50%;transform:translateY(-50%);background:rgba(29,185,84,.15);color:#1db954;font-size:11px;padding:2px 8px;border-radius:8px;font-weight:600;pointer-events:none;z-index:1'
        var wrap = document.getElementById('tb-search-wrap')
        wrap.style.position = 'relative'
        wrap.appendChild(chip)
      }
      chip.textContent = sourceLabel
      chip.style.display = ''
      input.style.paddingLeft = (chip.offsetWidth + 20) + 'px'
    } else {
      if (chip) { chip.style.display = 'none'; input.style.paddingLeft = '' }
    }

    activeIdx = -1
    renderDropdown(input.value)
    clearTimeout(_searchTimeout)
    var q = input.value.trim()
    if (!q) { hideLiveResults(); return }
    _searchTimeout = setTimeout(function() { showLiveResults(q) }, 300)
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
      var sourceMatch = q.match(/^source:(\S+)/i)
      if (sourceMatch) {
        var clean = q.replace(/^source:\S+\s*/i, '').trim()
        hideDropdown()
        hideLiveResults()
        if (clean) { addToHistory(clean); navigate('search', clean) }
        else { navigate('home') }
        input.blur()
        return
      }
      hideDropdown()
      hideLiveResults()
      var cp = document.getElementById('cmd-palette')
      if (cp && cp.style.display === 'flex') toggleCommandPalette()
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
    blurTimer = setTimeout(function() { hideDropdown(); hideLiveResults() }, 150)
  })

  // Close on click outside
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#tb-search-wrap')) { hideDropdown(); hideLiveResults() }
  })

  // Clear-search button
  var searchWrap = document.getElementById('tb-search-wrap')
  if (searchWrap) {
    var clearBtn = document.createElement('button')
    clearBtn.className = 'tb-search-clear'
    clearBtn.innerHTML = '&times;'
    clearBtn.style.display = 'none'
    clearBtn.addEventListener('click', function() { input.value = ''; clearBtn.style.display = 'none'; input.focus() })
    searchWrap.appendChild(clearBtn)
    input.addEventListener('input', function() { clearBtn.style.display = this.value ? 'flex' : 'none' })

    // Mic button for voice search
    if (!document.getElementById('tb-mic-css')) {
      var s = document.createElement('style')
      s.id = 'tb-mic-css'
      s.textContent = '.tb-mic{background:none;border:none;color:var(--text3);cursor:pointer;padding:4px;display:flex;align-items:center}.tb-mic:hover{color:var(--text)}.tb-mic.listening{color:#e05c5c;animation:pulse 1s infinite}'
      document.head.appendChild(s)
    }

    var micBtn = document.createElement('button')
    micBtn.id = 'tb-mic'
    micBtn.className = 'tb-mic'
    micBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path fill="currentColor" d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>'
    micBtn.title = 'Voice search'
    searchWrap.appendChild(micBtn)

    micBtn.addEventListener('click', function() {
      if (micBtn._recognition) {
        micBtn._recognition.stop()
        micBtn._recognition = null
        micBtn.classList.remove('listening')
        return
      }
      if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        showSnackbar('Voice search not supported in this browser')
        return
      }
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      var recognition = new SpeechRecognition()
      recognition.lang = 'en-US'
      recognition.interimResults = false
      recognition.maxAlternatives = 1

      micBtn._recognition = recognition
      micBtn.classList.add('listening')
      recognition.start()

      recognition.onresult = function(event) {
        var transcript = event.results[0][0].transcript
        input.value = transcript
        input.focus()
        commitSearch(transcript)
        micBtn.classList.remove('listening')
      }
      recognition.onerror = function() {
        micBtn.classList.remove('listening')
        showSnackbar('Voice search failed — try typing instead')
      }
      recognition.onend = function() {
        micBtn._recognition = null
        micBtn.classList.remove('listening')
      }
    })
  }

  function showLiveResults(q) {
    var albums = state.library.filter(function(a) {
      return (a.name && a.name.toLowerCase().includes(q.toLowerCase())) ||
             (a.artist && a.artist.toLowerCase().includes(q.toLowerCase()))
    }).slice(0, 5)
    var artists = {}
    state.library.forEach(function(a) {
      if (a.artist && a.artist.toLowerCase().includes(q.toLowerCase()) && !artists[a.artist]) {
        artists[a.artist] = 1
      }
    })
    var topArtists = Object.keys(artists).slice(0, 3)

    if (!albums.length && !topArtists.length) {
      hideLiveResults()
      return
    }

    var dd = document.getElementById('live-search-dd')
    if (!dd) {
      dd = document.createElement('div')
      dd.id = 'live-search-dd'
      dd.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:var(--bg2);border:1px solid var(--glass-border);border-radius:var(--r);z-index:100;max-height:300px;overflow-y:auto;margin-top:4px;box-shadow:0 8px 24px rgba(0,0,0,.4)'
      input.parentNode.style.position = 'relative'
      input.parentNode.appendChild(dd)
    }

    var html = ''
    if (topArtists.length) {
      html += '<div style="padding:6px 12px;font-size:11px;color:var(--text3);text-transform:uppercase">Artists</div>'
      topArtists.forEach(function(a) {
        html += '<div class="live-item" data-query="' + esc(a) + '" style="padding:6px 12px;cursor:pointer;font-size:13px">' + esc(a) + '</div>'
      })
    }
    if (albums.length) {
      html += '<div style="padding:6px 12px;font-size:11px;color:var(--text3);text-transform:uppercase">Albums</div>'
      albums.forEach(function(a) {
        html += '<div class="live-item" data-album="' + a.id + '" style="padding:6px 12px;cursor:pointer;font-size:13px;display:flex;gap:8px;align-items:center">' +
          '<div style="width:28px;height:28px;border-radius:4px;overflow:hidden">' + (a.artPath ? '<img src="' + esc('file://' + a.artPath) + '" style="width:100%;height:100%;object-fit:cover">' : '<div style="width:100%;height:100%;background:var(--bg3)"></div>') + '</div>' +
          '<span>' + esc(a.name) + '<span style="color:var(--text3);font-size:11px"> — ' + esc(a.artist) + '</span></span>' +
          '</div>'
      })
    }
    html += '<div class="live-item" data-query="' + esc(q) + '" style="padding:6px 12px;cursor:pointer;font-size:13px;border-top:1px solid var(--glass-border);color:var(--accent)">Search: ' + esc(q) + '</div>'

    dd.innerHTML = html
    dd.style.display = 'block'
    _liveResultsVisible = true

    dd.querySelectorAll('.live-item[data-album]').forEach(function(item) {
      item.addEventListener('mousedown', function(e) { e.preventDefault(); navigate('album', item.dataset.album); hideLiveResults() })
    })
    dd.querySelectorAll('.live-item[data-query]').forEach(function(item) {
      item.addEventListener('mousedown', function(e) { e.preventDefault(); commitSearch(item.dataset.query); hideLiveResults() })
    })
    dd.querySelectorAll('.live-item').forEach(function(item) {
      item.addEventListener('mouseenter', function() { item.style.background = 'var(--glass)' })
      item.addEventListener('mouseleave', function() { item.style.background = '' })
    })

    if (q.length >= 3) {
      window.api.ytMusicSearch({ query: q }).then(function(res) {
        var dd = document.getElementById('live-search-dd')
        if (!dd || !_liveResultsVisible) return
        if (!res.ok || !res.results || !res.results.length) return

        var existing = dd.querySelector('.live-yt-section')
        if (existing) existing.remove()

        var ytHtml = '<div class="live-yt-section"><div style="padding:6px 12px;font-size:11px;color:var(--text3);text-transform:uppercase">YouTube <span class="yt-badge" style="font-size:9px">YT</span></div>'
        res.results.slice(0, 3).forEach(function(r) {
          ytHtml += '<div class="live-item live-yt-item" data-videoid="' + r.videoId + '" style="padding:6px 12px;cursor:pointer;font-size:13px;display:flex;gap:8px;align-items:center">' +
            (r.thumbnailUrl ? '<div style="width:28px;height:28px;border-radius:4px;overflow:hidden;flex-shrink:0"><img src="' + esc(r.thumbnailUrl) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'"></div>' : '') +
            '<div><div>' + esc(r.title) + '</div><div style="font-size:11px;color:var(--text3)">' + esc(r.artist) + '</div></div></div>'
        })
        ytHtml += '</div>'

        var ytDiv = document.createElement('div')
        ytDiv.innerHTML = ytHtml
        dd.appendChild(ytDiv.firstChild)

        dd.querySelectorAll('.live-yt-item').forEach(function(item) {
          item.addEventListener('mousedown', function(e) {
            e.preventDefault()
            var videoId = item.dataset.videoid
            var r = res.results.find(function(x) { return x.videoId === videoId })
            if (r) {
              state.queue = [_ytQueueItem(r)]
              state.queueIndex = 0
              playCurrentTrack()
            }
            hideLiveResults()
          })
          item.addEventListener('mouseenter', function() { item.style.background = 'var(--glass)' })
          item.addEventListener('mouseleave', function() { item.style.background = '' })
        })
      }).catch(function() {})
    }
  }

  function hideLiveResults() {
    var dd = document.getElementById('live-search-dd')
    if (dd) { dd.style.display = 'none'; dd.innerHTML = '' }
    _liveResultsVisible = false
  }
}

function initResizableQueue() {
  var panel = document.getElementById('queue-panel')
  if (!panel || document.getElementById('queue-resize-handle')) return

  var saved = localStorage.getItem('papa-queue-width')
  if (saved) panel.style.width = saved

  var handle = document.createElement('div')
  handle.id = 'queue-resize-handle'
  handle.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:4px;cursor:col-resize;z-index:10'
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault()
    var startX = e.clientX
    var startWidth = panel.offsetWidth
    function onMove(ev) {
      var newWidth = startWidth - (ev.clientX - startX)
      newWidth = Math.max(240, Math.min(500, newWidth))
      panel.style.width = newWidth + 'px'
    }
    function onUp() {
      localStorage.setItem('papa-queue-width', panel.style.width)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
  panel.appendChild(handle)
}

function setupListeners() {
  // Make major UI regions focusable for keyboard navigation
  document.getElementById('content')?.setAttribute('tabindex', '0')
  document.getElementById('player-bar')?.setAttribute('tabindex', '0')

  // Global delegation: track artist name → navigate to artist page
  document.getElementById('content')?.addEventListener('click', e => {
    const artistEl = e.target.closest('.track-artist[data-artist]')
    if (artistEl && artistEl.dataset.artist) {
      e.stopPropagation()
      navigate('artist', artistEl.dataset.artist)
    }
  })

  // Cards are divs with a click listener; give them a real keyboard path.
  document.getElementById('content')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const card = e.target.closest('.album-card,.quick-card,.artist-card,.daily-mix-card,.jumpback-card,.folder-tree-item,.pl-card,.pl-folder-header,.genre-tile,.mood-card,.recent-search-card,.artist-pill,.discovery-swipe-card,.yt-row,.yt-album-card,.yt-artist-card,.yt-playlist-card,.dl2-group-toggle,.dl2-group-toggle-failed,.pl-track-row')
    if (!card || e.target.closest('button')) return
    e.preventDefault()
    card.click()
  })

  // Global delegation: plain mouse wheel scrolls .scroll-row rows horizontally
  document.getElementById('content')?.addEventListener('wheel', e => {
    const row = e.target.closest('.scroll-row')
    if (!row) return
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    if (row.scrollWidth <= row.clientWidth) return
    row.scrollLeft += e.deltaY
    e.preventDefault()
  }, { passive: false })

  // Global delegation: hover action buttons (play next / add to queue)
  document.getElementById('content')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    const album = state.library.find(a => a.id === btn.dataset.album)
    if (!album) return
    const track = album.tracks.find(t => t.filePath === btn.dataset.file)
    if (!track) return
    const queueTrack = { ...track, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id }
    if (action === 'playnext') {
      e.stopPropagation()
      const insertIdx = state.queueIndex >= 0 ? state.queueIndex + 1 : 0
      state.queue.splice(insertIdx, 0, queueTrack)
      if (state.queuePanelOpen) renderQueuePanel()
      showToast('Up next: ' + (track.title || 'track'))
    } else if (action === 'queue') {
      e.stopPropagation()
      state.queue.push(queueTrack)
      updateNextPrefetch()
      if (state.queuePanelOpen) renderQueuePanel()
      showToast('Added to queue: ' + (track.title || 'track'))
    }
  })

  // Middle-click on track/album/quick-card: play standalone without affecting queue
  document.getElementById('content')?.addEventListener('mousedown', e => {
    if (e.button !== 1) return
    const trackRow = e.target.closest('.track-row')
    if (trackRow) {
      e.preventDefault()
      const album = state.library.find(a => a.id === trackRow.dataset.album)
      if (!album) return
      const track = album.tracks.find(t => t.filePath === trackRow.dataset.file)
      if (track) playItemStandalone({ ...track, albumArtist: album.artist, artPath: album.artPath, albumName: album.name, albumId: album.id })
      return
    }
    const albumCard = e.target.closest('.album-card')
    if (albumCard && !albumCard.dataset.browse && !albumCard.dataset.channel && !albumCard.dataset.playlist) {
      e.preventDefault()
      const id = albumCard.dataset.album
      if (id && !id.startsWith('yt_')) {
        const album = state.library.find(a => a.id === id)
        if (album) playAlbumStandalone(album)
      }
      return
    }
    const quickCard = e.target.closest('.quick-card')
    if (quickCard) {
      e.preventDefault()
      const album = state.library.find(a => a.id === quickCard.dataset.album)
      if (album) playAlbumStandalone(album)
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
    var name = input?.value.trim()
    if (name) {
      saveCurrentQueue(name)
      document.getElementById('sq-save-form').style.display = 'none'
      showSnackbar('Queue saved as "' + name + '"')
    }
  })
  document.getElementById('sq-name-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { document.getElementById('sq-confirm-btn')?.click(); e.preventDefault() }
    if (e.key === 'Escape') { document.getElementById('sq-save-form').style.display = 'none' }
  })

  // Window controls
  document.getElementById('btn-min')?.addEventListener('click', () => window.api.minimize())
  document.getElementById('btn-max')?.addEventListener('click', () => window.api.maximize())
  document.getElementById('btn-close')?.addEventListener('click', () => {
    if (state.isPlaying) {
      showSnackbar('Music is playing. Close anyway?', 'Close', () => window.api.close(), 4000)
    } else {
      window.api.close()
    }
  })

  // Nav history buttons
  document.getElementById('tb-back')?.addEventListener('click', navigateBack)
  document.getElementById('tb-fwd')?.addEventListener('click', navigateForward)

  // Titlebar search with history
  initSearchHistory()
  // Search operator hint bar — show/hide on focus/blur
  var searchInput = document.getElementById('tb-search')
  var hintBar = document.getElementById('search-operator-hint')
  if (searchInput && hintBar) {
    searchInput.addEventListener('focus', function() { hintBar.style.display = 'block' })
    searchInput.addEventListener('blur', function() { setTimeout(function() { hintBar.style.display = 'none' }, 200) })
  }

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
  _pendingShuffle = null
    this.classList.toggle('active', state.shuffle)
    document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
    updateNextPrefetch()
    showSnackbar(state.shuffle ? 'Shuffle on' : 'Shuffle off', '', function(){}, 1500)
  })

  document.getElementById('btn-repeat')?.addEventListener('click', function() {
    const states = ['off', 'all', 'one']
    state.repeat = states[(states.indexOf(state.repeat) + 1) % 3]
    updateRepeatBtns()
    updateNextPrefetch()
    showSnackbar(state.repeat === 'one' ? 'Repeat: One' : state.repeat === 'all' ? 'Repeat: All' : 'Repeat: Off', '', function(){}, 1500)
  })

  document.getElementById('btn-stop-after')?.addEventListener('click', function() {
    state.stopAfterTrack = !state.stopAfterTrack
    updateStopAfterBtn()
  })

  document.getElementById('btn-vol')?.addEventListener('click', function() {
    if (audio.volume > 0) {
      state.lastVolume = audio.volume
      audio.volume = 0
    } else {
      audio.volume = state.lastVolume || 0.8
    }
    setVolDisplay(audio.volume)
    window.api.saveVolume(audio.volume)
    updateAriaToggles()
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

  // Recently played dropdown button
  var likeBtn = document.getElementById('btn-like')
  if (likeBtn && !document.getElementById('btn-recent')) {
    var recentBtn = document.createElement('button')
    recentBtn.id = 'btn-recent'
    recentBtn.className = 'ctrl-btn'
    recentBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>'
    recentBtn.title = 'Recently played'
    likeBtn.parentNode.insertBefore(recentBtn, likeBtn)

    recentBtn.addEventListener('click', function(e) {
      e.stopPropagation()
      var existing = document.getElementById('recent-dropdown')
      if (existing) { existing.remove(); return }
      var dd = document.createElement('div')
      dd.id = 'recent-dropdown'
      dd.style.cssText = 'position:absolute;bottom:100%;right:0;background:var(--bg2);border:1px solid var(--glass-border);border-radius:var(--r);padding:8px;min-width:200px;z-index:100;margin-bottom:8px;box-shadow:0 8px 24px rgba(0,0,0,.4)'
      var tracks = state.playHistory.slice(0, 5)
      if (!tracks.length) { dd.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text3)">No recent plays</div>' }
      else {
        dd.innerHTML = tracks.map(function(t, i) {
          return '<div class="recent-item" data-ri="' + i + '" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.title) + ' &mdash; ' + esc(t.artist) + '</div>'
        }).join('')
        dd.querySelectorAll('.recent-item').forEach(function(item) {
          item.addEventListener('mouseenter', function() { item.style.background = 'var(--glass)' })
          item.addEventListener('mouseleave', function() { item.style.background = '' })
          item.addEventListener('click', function() {
            var t = tracks[parseInt(item.dataset.ri)]
            if (t && t.filePath) {
              state.queue = [{ filePath: t.filePath, title: t.title, artist: t.artist, albumArtist: t.artist, albumName: t.album || '', albumId: '', artPath: t.artPath || '', duration: 0 }]
              state.queueIndex = 0
              playCurrentTrack()
            }
            dd.remove()
          })
        })
      }
      recentBtn.parentNode.style.position = 'relative'
      recentBtn.parentNode.appendChild(dd)
      setTimeout(function() {
        document.addEventListener('click', function close() { if (dd.parentNode) dd.remove(); document.removeEventListener('click', close) }, { once: true })
      }, 100)
    })
  }

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
    if (isHttpPath(track.filePath)) {
      if (track.channelId) navigate('yt-artist', track.channelId)
      else if (artist && artist !== '—') openYtArtistByName(artist)
      return
    }
    if (artist && artist !== '—') navigate('artist', artist)
  })
  document.getElementById('np-album')?.addEventListener('click', () => {
    const track = state.queue[state.queueIndex]
    if (!track) return
    if (isHttpPath(track.filePath)) {
      if (track.albumBrowseId) navigate('yt-album', track.albumBrowseId)
      else if (track.albumName && track.albumName !== 'YouTube') navigate('search', track.albumName)
      return
    }
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
      const timeVal = timeDisplay === 'remaining' ? audio.duration - (ratio * audio.duration) : timeDisplay === 'total' ? _albumTotalDuration() : ratio * audio.duration
      progressTooltip.textContent = fmtDur(Math.abs(timeVal))
      progressTooltip.style.display = 'block'
      progressTooltip.style.left = `${e.clientX - rect.left}px`
    })
    progressTrack.addEventListener('mouseleave', () => {
      progressTooltip.style.display = 'none'
    })
    function _cycleTimeDisplay() {
      timeDisplay = timeDisplay === 'elapsed' ? 'remaining' : timeDisplay === 'remaining' ? 'total' : 'elapsed'
      localStorage.setItem('papa_time_display', timeDisplay)
      showSnackbar(timeDisplay === 'total' ? 'Showing total album duration'
        : timeDisplay === 'remaining' ? 'Showing time remaining' : 'Showing time elapsed')
    }
    document.getElementById('time-cur')?.addEventListener('click', _cycleTimeDisplay)
    progressTrack.addEventListener('contextmenu', function(e) {
      e.preventDefault()
      _cycleTimeDisplay()
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

  document.getElementById('vol-track')?.addEventListener('contextmenu', function(e) {
    e.preventDefault()
    var v = prompt('Volume (0-100)', Math.round(audio.volume * 100))
    if (v !== null && !isNaN(v)) {
      audio.volume = Math.max(0, Math.min(100, parseInt(v)) / 100)
      state.lastVolume = audio.volume
      setVolDisplay(audio.volume)
      clearTimeout(_volSaveTimer)
      _volSaveTimer = setTimeout(function() { window.api.saveVolume(audio.volume) }, 300)
    }
  })

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
  _ctxOn('ctx-radio', () => {
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
  initResizableQueue()

  // Sidebar right-click → toggle compact mode
  document.querySelector('.sidebar')?.addEventListener('contextmenu', function(e) {
    e.preventDefault()
    var sidebar = this
    sidebar.style.width = sidebar.style.width === '60px' ? '' : '60px'
    localStorage.setItem('papa_compact_sidebar', sidebar.style.width === '60px' ? '1' : '0')
  })

  // Now playing art → open modal
  document.getElementById('np-art-wrap')?.addEventListener('click', () => {
    if (state.queue.length) showNowPlayingModal()
  })

  // Double-click album art → navigate to album page
  var npArtImg = document.getElementById('np-art')
  if (npArtImg) {
    npArtImg.addEventListener('dblclick', function() {
      var track = state.queue[state.queueIndex]
      if (!track) return
      if (track.albumId && track.albumId.startsWith('yt_')) {
        navigate('yt-album', track.albumBrowseId || track.albumId.replace('yt_', ''))
      } else if (track.albumId && !track.albumId.startsWith('file://')) {
        navigate('album', track.albumId)
      }
    })
  }

  // Now playing art → right-click/long-press to show recent
  document.getElementById('np-art-wrap')?.addEventListener('contextmenu', function(e) {
    e.preventDefault()
    var recent = state.playHistory.slice(0, 5).map(function(p) {
      for (var i = 0; i < state.library.length; i++) {
        var a = state.library[i]
        if (a.tracks) {
          for (var j = 0; j < a.tracks.length; j++) {
            if (a.tracks[j].filePath === p.filePath) return { title: a.tracks[j].title, artist: a.artist, filePath: p.filePath }
          }
        }
      }
      return { title: p.title || 'Unknown', artist: p.artist || '', filePath: p.filePath }
    }).filter(function(t) { return t.filePath })

    showSnackbar(recent.map(function(t, i) { return (i+1) + '. ' + t.title + ' — ' + t.artist }).join(' | '), '', function(){}, 4000)
  })

  // Draggable album art — copy/save to file manager
  if (npArtImg) {
    npArtImg.draggable = true
    npArtImg.addEventListener('dragstart', function(e) {
      var track = state.queue[state.queueIndex]
      if (!track || !track.artPath) return
      var path = track.artPath
      if (path && !path.startsWith('http')) {
        e.dataTransfer.setData('DownloadURL', 'image/jpeg:' + path.split('/').pop() + ':file://' + path)
      }
    })
  }

  // Now playing modal controls
  document.getElementById('np-modal-close')?.addEventListener('click', hideNowPlayingModal)
  document.getElementById('np-modal-full-art')?.addEventListener('click', function() {
    var modal = document.getElementById('np-modal')
    modal.classList.toggle('art-expanded')
    var icon = this.querySelector('svg')
    if (icon) icon.innerHTML = modal.classList.contains('art-expanded')
      ? '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>'
      : '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>'
  })
  document.getElementById('np-modal-art-box')?.addEventListener('click', function(e) {
    var modal = document.getElementById('np-modal')
    if (modal.classList.contains('art-expanded')) {
      modal.classList.remove('art-expanded')
      var btn = document.getElementById('np-modal-full-art')
      if (btn) {
        var icon = btn.querySelector('svg')
        if (icon) icon.innerHTML = '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>'
      }
    }
  })
  document.getElementById('np-modal-play')?.addEventListener('click', togglePlay)
  document.getElementById('np-modal-prev')?.addEventListener('click', playPrev)
  document.getElementById('np-modal-next')?.addEventListener('click', playNext)
  document.getElementById('np-modal-shuffle')?.addEventListener('click', function() {
    state.shuffle = !state.shuffle
    this.classList.toggle('active', state.shuffle)
    document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
    updateNextPrefetch()
    showSnackbar(state.shuffle ? 'Shuffle on' : 'Shuffle off', '', function(){}, 1500)
  })
  document.getElementById('np-modal-repeat')?.addEventListener('click', function() {
    const states = ['off','all','one']
    state.repeat = states[(states.indexOf(state.repeat)+1)%3]
    updateRepeatBtns()
    updateNextPrefetch()
    showSnackbar(state.repeat === 'one' ? 'Repeat: One' : state.repeat === 'all' ? 'Repeat: All' : 'Repeat: Off', '', function(){}, 1500)
  })

  // Context menu actions
  _ctxOn('ctx-play', () => {
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
  _ctxOn('ctx-queue', () => {
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
  _ctxOn('ctx-addpl', () => {
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
  _ctxOn('ctx-artist', () => {
    if (!ctxTarget?.artist) return
    navigate('artist', ctxTarget.artist)
    hideContextMenu()
  })
  _ctxOn('ctx-like', () => {
    if (ctxTarget?.albumId) toggleLike(ctxTarget.albumId)
    hideContextMenu()
  })
  _ctxOn('ctx-wishlist', () => {
    if (!ctxTarget) return
    state.downloadWishlist.push({ query: ctxTarget.artist + ' ' + (ctxTarget.track ? ctxTarget.track.album : ctxTarget.albumId), addedAt: Date.now() })
    window.api.saveDownloadWishlist(state.downloadWishlist)
    showSnackbar('Added to wishlist')
    hideContextMenu()
  })
  _ctxOn('ctx-play-next', () => {
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
  _ctxOn('ctx-trash', () => {
    if (!ctxTarget) return
    var album = state.library.find(function(a) { return a.id === ctxTarget.albumId })
    // A track deletes just that file; an album deletes only the files the
    // library actually knows about, never a whole folder that may hold more.
    var paths = ctxTarget.paths && ctxTarget.paths.length
      ? ctxTarget.paths.slice()
      : ctxTarget.track
        ? [ctxTarget.track.filePath]
        : (album ? album.tracks.map(function(t) { return t.filePath }).filter(Boolean) : [])
    var what = ctxTarget.label
      || (ctxTarget.track ? (ctxTarget.track.title || _mgBaseName(paths[0]))
      : (album ? album.artist + ' — ' + album.name : ''))
    hideContextMenu()
    if (paths.length) _mgTrashPaths(paths, what)
  })
  _ctxOn('ctx-edit-tags', () => editTags())
  _ctxOn('ctx-artwork', () => setAlbumArtwork())
  _ctxOn('ctx-rename', () => libraryRenameFolder())
  _ctxOn('ctx-move', () => libraryMoveFolder())
  _ctxOn('ctx-show-folder', () => {
    // Falls back to the album's first track — this used to no-op on albums.
    const album = state.library.find(a => a.id === ctxTarget?.albumId)
    const filePath = ctxTarget?.track?.filePath || album?.tracks?.[0]?.filePath
    if (filePath) window.api.slskShowInFolder(filePath)
    hideContextMenu()
  })
  _ctxOn('ctx-copy-path', () => {
    if (!ctxTarget) return
    var fp = ctxTarget.track ? ctxTarget.track.filePath : (state.library.find(function(a) { return a.id === ctxTarget.albumId })?.tracks?.[0]?.filePath)
    if (fp) {
      navigator.clipboard.writeText(fp).then(function() {
        showSnackbar('Path copied: ' + fp.split('/').pop())
      })
    }
    hideContextMenu()
  })
  // Removing from a list. Deliberately separate from ctx-trash: these touch
  // only the list, never the disk.
  _ctxOn('ctx-remove-playlist', () => {
    const t = ctxTarget?.track
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId)
    hideContextMenu()
    if (!t || !pl) return
    const idx = pl.tracks.findIndex(x => x.filePath && x.filePath === t.filePath)
    if (idx < 0) return
    const removed = pl.tracks.splice(idx, 1)[0]
    window.api.savePlaylist(pl)
    renderPlaylist(pl.id)
    pushUndo('Removed from ' + pl.name, function () {
      pl.tracks.splice(idx, 0, removed)
      window.api.savePlaylist(pl)
      renderPlaylist(pl.id)
    })
  })

  _ctxOn('ctx-remove-queue', () => {
    const t = ctxTarget?.track
    const known = ctxTarget?.queueIdx
    hideContextMenu()
    if (!t) return
    const idx = (typeof known === 'number' && !isNaN(known))
      ? known
      : state.queue.findIndex(x => x.filePath && x.filePath === t.filePath)
    if (idx < 0 || idx >= state.queue.length) return
    const removed = state.queue.splice(idx, 1)[0]
    if (idx < state.queueIndex) state.queueIndex--
    else if (idx === state.queueIndex) {
      if (state.queue.length) playCurrentTrack()
      else { audio.pause(); state.isPlaying = false; state.queueIndex = -1; updatePlayBtn(); updateNowPlaying(null) }
    }
    renderQueuePanel()
    pushUndo('Removed from queue', function () {
      state.queue.splice(idx, 0, removed)
      if (idx <= state.queueIndex) state.queueIndex++
      renderQueuePanel()
    })
  })

  _ctxOn('ctx-unlike', () => {
    const t = ctxTarget?.track
    hideContextMenu()
    if (!t || !t.filePath) return
    const idx = state.likedTracks.indexOf(t.filePath)
    if (idx < 0) return
    state.likedTracks.splice(idx, 1)
    // saveLiked() writes the likedALBUMS store. Sending likedTracks through it
    // replaced every liked album with a list of file paths AND never persisted
    // the unlike, so the track came back on restart while the albums were gone.
    window.api.saveLikedTracks(state.likedTracks)
    if (state.currentPage === 'liked') renderLikedSongs()
    pushUndo('Removed from Liked Songs', function () {
      state.likedTracks.splice(idx, 0, t.filePath)
      window.api.saveLikedTracks(state.likedTracks)
      if (state.currentPage === 'liked') renderLikedSongs()
    })
  })

  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu')) hideContextMenu()
  })
  var CTX_SURFACES = '.album-card, .track-row, .artist-card, .quick-card, .folder-tree-item, .queue-row'
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest(CTX_SURFACES)) hideContextMenu()
  })

  // Browser nav

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

    var pct = `${ratio * 100}%`
    if (_dom.fill)  _dom.fill.style.width = pct
    if (_dom.thumb) _dom.thumb.style.left = pct
    if (_dom.timeCur) { _dom.timeCur.textContent = _fmtTimeCur(ct); _dom.timeCur.title = _timeCurTitle() }
    if (state.modalOpen) {
      if (_dom.modalFill)  _dom.modalFill.style.width = pct
      if (_dom.modalThumb) _dom.modalThumb.style.left  = pct
      if (_dom.modalCur) { _dom.modalCur.textContent = _fmtTimeCur(ct); _dom.modalCur.title = _timeCurTitle() }
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
    const finishedTrack = state.queue[state.queueIndex]
    if (finishedTrack) {
      window.api.scrobbleTrack({
        artist: finishedTrack.albumArtist || finishedTrack.artist || '',
        title: finishedTrack.title || '',
        album: finishedTrack.albumName || '',
      })
    }
    playNext()
  })
  audio.addEventListener('autoadvanced', (e) => {
    // Scrobble the track that just finished before updating the index
    const finishedTrack = state.queue[state.queueIndex]
    if (finishedTrack) {
      window.api.scrobbleTrack({
        artist: finishedTrack.albumArtist || finishedTrack.artist || '',
        title: finishedTrack.title || '',
        album: finishedTrack.albumName || '',
      })
    }
    if (state.stopAfterTrack) {
      state.stopAfterTrack = false
      state.isPlaying = false
      audio.pause()
      updatePlayBtn()
      updateStopAfterBtn()
      return
    }
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
    loadLyricsFor(track)
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
    if (!t) return
    const isStream = /^https?:\/\//.test(t.filePath || '')

    if (isStream) {
      // Dead/region-locked YouTube stream — tell the user and move on
      const titleEl = document.getElementById('np-title')
      if (titleEl) {
        const orig = titleEl.textContent
        titleEl.textContent = 'Stream unavailable — skipping'
        setTimeout(() => { titleEl.textContent = orig }, 2500)
      }
      if (state.queue.length > 1) playNext()
      return
    }

    // A local file that will not load is almost always one that was deleted or
    // moved. This used to `return` here, so playback simply stopped with no
    // message and the dead entry stayed in the queue forever.
    const failed = (e && e.detail && e.detail.src) || t.filePath
    dropMissingTrack(failed, t)
  })

  // Library changed in main (a mutation, or the folder watcher). Until now this
  // event had no listener at all, so the UI silently kept showing stale data.
  window.api.on('library-updated', (payload) => {
    applyLibraryUpdate(payload)
  })

  // IPC events
  // Torrent events
  window.api.on('torrent-started', () => {
    if (state.currentPage !== 'downloads') return
    if (_dlTab === 'torrents') _renderTorrentSection()
    else _updateDlTabCounts(_dlLastFiles || [])
  })
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
      showSnackbar('Download complete: ' + dl.title, null, null, 3000)
      _scheduleLibRescan()
      window.api.notifyDownloadComplete({ count: 1, albumName: `${dl.artist ? dl.artist + ' — ' : ''}${dl.title}` })
    }
    const box = document.getElementById('yt-dl-list')
    if (!box) return
    // Only the percentage moved: nudge the existing nodes instead of rebuilding
    // the whole list, which flickered and dropped any text selection.
    if (prev && prev.state === dl.state && dl.state === 'downloading') {
      const pct = Math.max(0, Math.min(100, Number(dl.percent) || 0))
      const row = box.querySelector(`[data-ytdl-row="${CSS.escape(String(dl.id))}"]`)
      if (row) {
        const fill = row.querySelector('.yt-dl-fill')
        const lbl  = row.querySelector('.yt-dur')
        if (fill) fill.style.width = pct + '%'
        if (lbl)  lbl.textContent = Math.round(pct) + '%'
        return
      }
    }
    _renderYtDownloadRows(box)
  })
  window.api.ytGetDownloads().then(list => {
    for (const d of (list || [])) state.ytDownloads.set(d.id, d)
  }).catch(() => {})

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
      if (state.queue.length === 0) return
      if (!confirm('Clear all ' + state.queue.length + ' tracks from the queue?')) return
      audio.pause()
      state.queue = []; state.queueIndex = -1; state.isPlaying = false
      state._restoredFromQueue = false
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

    // Ctrl+Z → undo last destructive action
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z' && !inInput) {
      e.preventDefault()
      undoLastAction()
      return
    }

    // Ctrl+K → focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      document.getElementById('tb-search')?.focus()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
      e.preventDefault(); toggleCommandPalette(); return
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'L') {
      e.preventDefault()
      var currentTrack = state.queue[state.queueIndex]
      if (currentTrack && currentTrack.filePath) toggleTrackLike(currentTrack.filePath)
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
      e.preventDefault()
      setSleepTimer(30)
      showSnackbar('Sleep timer: 30 min')
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault()
      state.skipShortTracks = !state.skipShortTracks
      showSnackbar('Auto-skip short tracks: ' + (state.skipShortTracks ? 'on' : 'off'))
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
      e.preventDefault()
      state.skipInterludes = !state.skipInterludes
      showSnackbar('Skip interludes: ' + (state.skipInterludes ? 'on' : 'off'))
      return
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
      e.preventDefault()
      var name = 'Queue ' + new Date().toLocaleTimeString()
      saveCurrentQueue(name)
      showSnackbar('Queue saved: ' + name)
      return
    }

    // F6 / Ctrl+Tab → cycle focus between major regions
    if (e.key === 'F6' || (e.ctrlKey && e.key === 'Tab')) {
      e.preventDefault()
      var regions = ['#sidebar', '#content', '#player-bar']
      var current = document.activeElement
      var idx = regions.findIndex(function(r) { return current.closest(r) })
      idx = (idx + 1) % regions.length
      var target = document.querySelector(regions[idx])
      if (target) {
        target.setAttribute('tabindex', '0')
        target.focus({ preventScroll: false })
      }
      return
    }

    // Ctrl+1–5 → page shortcuts
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      var pageMap = { '1': 'home', '2': 'library', '3': 'search', '4': 'downloads', '5': 'playlists' }
      var page = pageMap[e.key]
      if (page) {
        e.preventDefault()
        var input = document.getElementById('tb-search')
        if (document.activeElement === input) { input.blur() }
        navigate(page, page === 'search' ? null : null)
        return
      }
    }

    // Escape
    if (e.key === 'Escape') {
      if (document.activeElement === document.getElementById('tb-search')) {
        document.getElementById('tb-search').value = ''
        document.getElementById('tb-search').blur()
        return
      }
      // Return focus to content if sidebar or player is focused
      if (document.activeElement === document.getElementById('sidebar') ||
          document.activeElement?.closest('#sidebar') ||
          document.activeElement === document.getElementById('player-bar') ||
          document.activeElement?.closest('#player-bar')) {
        document.getElementById('content')?.focus({ preventScroll: false })
        return
      }
      var cp = document.getElementById('cmd-palette')
      if (cp && cp.style.display === 'flex') { toggleCommandPalette(); return }
      const sm = document.getElementById('shortcuts-modal')
      if (sm && sm.style.display !== 'none') { sm.style.display = 'none'; return }
      const sc = document.getElementById('shortcuts-config-modal')
      if (sc && sc.style.display === 'flex') { toggleShortcutsConfig(); return }
      if (_lyricsDrawerOpen) { closeLyricsDrawer(); return }
      if (state.modalOpen) { hideNowPlayingModal(); return }
      // Was `!el.style.display === 'none'` -- `!` binds tighter than `===`, so
      // this read `false === 'none'` and was ALWAYS false. Escape has never
      // closed the context menu.
      var cm = document.getElementById('ctx-menu')
      if (cm && cm.style.display !== 'none') hideContextMenu()
      return
    }

    // Space: play/pause (works in search input when empty)
    if (e.code === 'Space') {
      if (inInput && e.target.id === 'tb-search' && e.target.value.trim() === '') {
        e.preventDefault(); togglePlay(); return
      }
      if (!inInput) { e.preventDefault(); togglePlay(); return }
    }

    if (inInput) return

    // App navigation
    if (e.key === 'ArrowLeft' && e.altKey)  { e.preventDefault(); navigateBack();    return }
    if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); navigateForward(); return }

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
    if ((e.ctrlKey || e.metaKey) && e.key === 'q') {
      e.preventDefault()
      var t = state.queue[state.queueIndex]
      if (t) { state.queue.push(t); showSnackbar('Added to queue again') }
      return
    }
    // Shuffle
    if (e.key === 's' || e.key === 'S') {
      state.shuffle = !state.shuffle
      document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
      document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
      updateNextPrefetch()
      showSnackbar(state.shuffle ? 'Shuffle on' : 'Shuffle off', '', function(){}, 1500)
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
    // Ctrl+Shift+, → shortcuts config
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === ',') {
      e.preventDefault(); toggleShortcutsConfig(); return
    }
    // Keyboard shortcuts modal
    if (e.key === '?' || e.key === 'F1') { e.preventDefault(); toggleShortcutsModal(); return }
  })

  // ── Connection status bar ─────────────────────────────────────────────────
  var sidebar = document.getElementById('sidebar')
  if (sidebar && !document.getElementById('conn-status')) {
    var bar = document.createElement('div')
    bar.id = 'conn-status'
    bar.style.cssText = 'padding:8px 16px;font-size:11px;display:flex;gap:12px;border-top:1px solid var(--glass-border);margin-top:auto;color:var(--text2)'
    bar.innerHTML = '<span id="conn-slskd" style="display:flex;align-items:center;gap:4px"><span class="conn-dot"></span> Soulseek</span><span id="conn-yt" style="display:flex;align-items:center;gap:4px"><span class="conn-dot"></span> YouTube</span>'
    sidebar.appendChild(bar)
    setInterval(checkConnections, 30000)
    checkConnections()
  }

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

  // ── Collapsible sidebar sections ──────────────────────────────────────────
  function _makeCollapsible(headerEl, contentEls, storageKey) {
    headerEl.addEventListener('click', function(e) {
      if (e.target.closest('button')) return
      var collapsed = headerEl.classList.toggle('collapsed')
      contentEls.forEach(function(el) { el.style.display = collapsed ? 'none' : '' })
      localStorage.setItem('sidebar-collapse-' + storageKey, collapsed ? '1' : '0')
    })
    if (localStorage.getItem('sidebar-collapse-' + storageKey) === '1') {
      headerEl.classList.add('collapsed')
      contentEls.forEach(function(el) { el.style.display = 'none' })
    }
  }

  var sidebarEl = document.getElementById('sidebar')
  if (sidebarEl) {
    var navList = sidebarEl.querySelector('.nav-list')
    if (navList) {
      var libHeader = document.createElement('div')
      libHeader.className = 'sidebar-collapsible-header'
      libHeader.textContent = 'Library'
      navList.parentNode.insertBefore(libHeader, navList)
      _makeCollapsible(libHeader, [navList], 'library')
    }

    var sqSection = sidebarEl.querySelector('.saved-queues-section')
    if (sqSection) {
      var sqHeader = sqSection.querySelector('.sidebar-section-header')
      if (sqHeader) {
        sqHeader.classList.add('sidebar-collapsible-header')
        var sqContent = []
        var next = sqHeader.nextElementSibling
        while (next) { sqContent.push(next); next = next.nextElementSibling }
        _makeCollapsible(sqHeader, sqContent, 'saved-queues')
      }
    }

    var mfSection = sidebarEl.querySelector('.sidebar-section:not(.saved-queues-section):not(.quality-sources-section)')
    if (mfSection) {
      var mfTitle = mfSection.querySelector('.sidebar-section-title')
      if (mfTitle) {
        mfTitle.classList.add('sidebar-collapsible-header')
        var mfContent = []
        var n = mfTitle.nextElementSibling
        while (n) { mfContent.push(n); n = n.nextElementSibling }
        _makeCollapsible(mfTitle, mfContent, 'music-folders')
      }
    }
  }
}

async function checkConnections() {
  try {
    var s = await window.api.slskStatus().catch(function() { return null })
    state.connectionStatus.slskd = (s && s.connected) ? 'connected' : 'disconnected'
  } catch (_) { state.connectionStatus.slskd = 'disconnected' }

  try {
    var y = await window.api.ytAuthStatus().catch(function() { return null })
    state.connectionStatus.youtube = (y && y.ok) ? 'connected' : 'disconnected'
  } catch (_) { state.connectionStatus.youtube = 'disconnected' }

  var slskdEl = document.getElementById('conn-slskd')
  var ytEl = document.getElementById('conn-yt')
  if (slskdEl) {
    var dot = slskdEl.querySelector('.conn-dot')
    var isConnected = state.connectionStatus.slskd === 'connected'
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;display:inline-block;background:' + (isConnected ? '#1db954' : '#e74c3c')
    slskdEl.style.color = isConnected ? 'var(--text1)' : 'var(--text3)'
    slskdEl.childNodes[slskdEl.childNodes.length - 1].textContent = isConnected ? ' Soulseek' : ' Soulseek offline'
  }
  if (ytEl) {
    var dot2 = ytEl.querySelector('.conn-dot')
    var isConnected2 = state.connectionStatus.youtube === 'connected'
    dot2.style.cssText = 'width:7px;height:7px;border-radius:50%;display:inline-block;background:' + (isConnected2 ? '#1db954' : '#e74c3c')
    ytEl.style.color = isConnected2 ? 'var(--text1)' : 'var(--text3)'
    ytEl.childNodes[ytEl.childNodes.length - 1].textContent = isConnected2 ? ' YouTube' : ' YouTube offline'
  }

  // Drag-and-drop audio files/folders to enqueue
  document.addEventListener('dragover', function(e) { e.preventDefault() })
  document.addEventListener('drop', function(e) {
    e.preventDefault()
    var droppedFiles = Array.from(e.dataTransfer.files || [])
    if (!droppedFiles.length) return
    var audioExt = /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i
    var audioFiles = droppedFiles.filter(function(f) {
      var p = f.path || f.name
      return audioExt.test(p)
    })
    if (!audioFiles.length) return
    var tracks = audioFiles.map(function(f) {
      var fp = f.path || f.name
      var name = fp.split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '')
      return {
        filePath: fp,
        title: name,
        artist: '',
        albumArtist: '',
        albumName: '',
        albumId: '',
        artPath: '',
        duration: 0,
      }
    })
    state.queue.push.apply(state.queue, tracks)
    updateNextPrefetch()
    showSnackbar('Added ' + tracks.length + ' files to queue')
  })

  var waveformProgressRow = document.querySelector('.progress-row')
  if (waveformProgressRow && !document.getElementById('waveform-canvas')) {
    var canvas = document.createElement('canvas')
    canvas.id = 'waveform-canvas'
    canvas.style.cssText = 'width:100%;height:24px;margin-bottom:4px;border-radius:2px;opacity:0.3'
    waveformProgressRow.parentNode.insertBefore(canvas, waveformProgressRow)

    function drawWaveform() {
      var ctx = canvas.getContext('2d')
      var w = canvas.offsetWidth, h = canvas.offsetHeight
      canvas.width = w; canvas.height = h
      ctx.clearRect(0, 0, w, h)
      var bars = Math.floor(w / 3)
      var progress = audio.duration ? audio.currentTime / audio.duration : 0
      for (var i = 0; i < bars; i++) {
        var barH = Math.random() * h * 0.8 + h * 0.1
        var x = i * (w / bars)
        ctx.fillStyle = i / bars < progress ? 'rgba(29,185,84,0.5)' : 'rgba(255,255,255,0.15)'
        ctx.fillRect(x, (h - barH) / 2, w / bars - 1, barH)
      }
    }
    setInterval(drawWaveform, 1000)
    drawWaveform()
  }
}

function renderShortcuts() {
  var grid = document.getElementById('shortcuts-grid')
  if (!grid) return
  var byCategory = {}
  ALL_SHORTCUTS.forEach(function(s) {
    if (!byCategory[s.category]) byCategory[s.category] = []
    byCategory[s.category].push(s)
  })
  var categories = Object.keys(byCategory)
  var mid = Math.ceil(categories.length / 2)
  var cols = [categories.slice(0, mid), categories.slice(mid)]
  grid.innerHTML = cols.map(function(colCats) {
    return '<div class="shortcuts-col">' + colCats.map(function(cat) {
      return '<div class="shortcuts-section-title">' + esc(cat) + '</div>' +
        byCategory[cat].map(function(s) {
          return '<div class="shortcut-row"><kbd>' + esc(s.keys.join(' / ')) + '</kbd><span>' + esc(s.desc) + '</span></div>'
        }).join('')
    }).join('') + '</div>'
  }).join('')
}

function toggleShortcutsModal() {
  const m = document.getElementById('shortcuts-modal')
  if (!m) return
  const isHidden = m.style.display === 'none' || !m.style.display
  if (isHidden) renderShortcuts()
  m.style.display = isHidden ? 'flex' : 'none'
}

function renderShortcutsConfig() {
  var grid = document.getElementById('shortcuts-config-grid')
  if (!grid) return
  var keys = Object.keys(DEFAULT_SHORTCUTS)
  grid.innerHTML = '<div class="shortcuts-col">' + keys.map(function(action) {
    return '<div class="shortcut-row"><kbd>' + esc(DEFAULT_SHORTCUTS[action]) + '</kbd><span>' + esc(action) + '</span></div>'
  }).join('') + '</div>'
}

function toggleShortcutsConfig() {
  var m = document.getElementById('shortcuts-config-modal')
  if (m) { m.style.display = m.style.display === 'flex' ? 'none' : 'flex'; renderShortcutsConfig(); return }
  m = document.createElement('div')
  m.id = 'shortcuts-config-modal'
  m.className = 'modal-overlay'
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:10001'
  m.innerHTML = '<div class="modal-content" style="background:var(--bg2,#1a1a1a);border-radius:12px;padding:24px;max-width:500px;width:90%;max-height:80vh;overflow:auto;color:var(--text1,#fff)">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
    '<h2 style="margin:0;font-size:18px;font-weight:600">Configure Shortcuts</h2>' +
    '<button id="shortcuts-config-close" style="background:none;border:none;color:var(--text2,#aaa);font-size:20px;cursor:pointer;padding:4px 8px">&times;</button>' +
    '</div>' +
    '<div id="shortcuts-config-grid"></div>' +
    '<div style="margin-top:16px;display:flex;gap:8px">' +
    '<button id="shortcuts-config-reset" style="background:var(--bg3,#333);border:none;color:var(--text1,#fff);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px">Reset to Defaults</button>' +
    '</div>' +
    '</div>'
  document.body.appendChild(m)
  m.addEventListener('click', function(e) { if (e.target === m) toggleShortcutsConfig() })
  m.querySelector('#shortcuts-config-close').addEventListener('click', toggleShortcutsConfig)
  m.querySelector('#shortcuts-config-reset').addEventListener('click', function() { resetShortcuts(); renderShortcutsConfig() })
  renderShortcutsConfig()
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

// ── Snackbar ─────────────────────────────────────────────────────────────────
function showSnackbar(msg, actionLabel, actionCallback, duration) {
  duration = duration || 5000
  var container = document.getElementById('snackbar-container')
  if (!container) return
  var el = document.createElement('div')
  el.className = 'snackbar'
  // Text, never markup: user-typed preset and folder names land here, and this
  // renderer has window.api on it. Callers must NOT pre-escape.
  var msgEl = document.createElement('span')
  msgEl.className = 'snackbar-msg'
  msgEl.textContent = String(msg == null ? '' : msg)
  el.appendChild(msgEl)
  if (actionLabel) {
    var actEl = document.createElement('button')
    actEl.className = 'snackbar-action'
    actEl.textContent = String(actionLabel)
    el.appendChild(actEl)
  }
  var dismissEl = document.createElement('button')
  dismissEl.className = 'snackbar-dismiss'
  dismissEl.innerHTML = '&times;'
  el.appendChild(dismissEl)

  el.addEventListener('click', function(e) {
    if (!e.target.closest('.snackbar-action')) {
      clearTimeout(el._timeout)
      el.classList.remove('show')
      setTimeout(function() { el.remove() }, 300)
    }
  })

  var dismissBtn = el.querySelector('.snackbar-dismiss')
  if (dismissBtn) dismissBtn.addEventListener('click', function(e) { e.stopPropagation() })
  var actionBtn = el.querySelector('.snackbar-action')
  if (actionBtn) actionBtn.addEventListener('click', function(e) { e.stopPropagation(); if (actionCallback) actionCallback(); clearTimeout(el._timeout); el.classList.remove('show'); setTimeout(function() { el.remove() }, 300) })

  container.appendChild(el)
  requestAnimationFrame(function() { el.classList.add('show') })
  el._timeout = setTimeout(function() { el.classList.remove('show'); setTimeout(function() { el.remove() }, 300) }, duration)
}

// ── Command palette wrapper functions ─────────────────────────────────────
function toggleShuffleWrap() {
  state.shuffle = !state.shuffle
  document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
  document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
  showSnackbar(state.shuffle ? 'Shuffle on' : 'Shuffle off', '', function(){}, 1500)
}
function cycleRepeatWrap() {
  state.repeat = state.repeat === 'one' ? 'off' : state.repeat === 'all' ? 'one' : 'all'
  updateRepeatBtns()
  var lbl = state.repeat === 'one' ? 'Repeat: One' : state.repeat === 'all' ? 'Repeat: All' : 'Repeat: Off'
  showSnackbar(lbl, '', function(){}, 1500)
}

// ── Command palette ──────────────────────────────────────────────────────────
var _commands = [
  { id:'nav-home', label:'Go to Home', action:function() { navigate('home') } },
  { id:'nav-library', label:'Go to Library', action:function() { navigate('library') } },
  { id:'nav-search', label:'Go to Search', action:function() { navigate('search') } },
  { id:'nav-downloads', label:'Go to Downloads', action:function() { navigate('downloads') } },
  { id:'nav-liked', label:'Go to Liked Songs', action:function() { navigate('liked') } },
  { id:'nav-stats', label:'Go to Stats', action:function() { navigate('stats') } },
  { id:'nav-explore', label:'Go to Explore', action:function() { navigate('explore') } },
  { id:'nav-artists', label:'Go to Artists', action:function() { navigate('artists') } },
  { id:'nav-playlists', label:'Go to Playlists', action:function() { navigate('playlists') } },
  { id:'player-play', label:'Play / Pause', action:togglePlay },
  { id:'player-next', label:'Next Track', action:playNext },
  { id:'player-prev', label:'Previous Track', action:playPrev },
  { id:'player-shuffle', label:'Toggle Shuffle', keys:'S', action:toggleShuffleWrap },
  { id:'player-repeat', label:'Cycle Repeat', keys:'R', action:cycleRepeatWrap },
]
var _cpIdx = 0

function toggleCommandPalette() {
  var el = document.getElementById('cmd-palette')
  if (!el) return
  var showing = el.style.display === 'flex'
  el.style.display = showing ? 'none' : 'flex'
  if (!showing) {
    var input = document.getElementById('cmd-palette-input')
    if (input) { input.value = ''; _cpIdx = 0; _filterCP(''); input.focus() }
  }
}
function _filterCP(q) {
  q = (q || '').toLowerCase()
  var results = _commands.filter(function(c) { return c.label.toLowerCase().indexOf(q) !== -1 })
  var c = document.getElementById('cmd-palette-results')
  if (!c) return
  _cpIdx = Math.min(_cpIdx, Math.max(0, results.length - 1))
  if (results.length) {
    c.innerHTML = results.map(function(x, i) {
      return '<div class="cmd-item' + (i === _cpIdx ? ' active' : '') + '" data-idx="' + i + '"><span>' + x.label + '</span></div>'
    }).join('')
  } else {
    c.innerHTML = '<div class="cmd-empty">No matching commands</div>'
  }
}
function _execCP(idx) {
  var el = document.querySelector('.cmd-item[data-idx="' + idx + '"]')
  if (!el) return
  var cmd = _commands[parseInt(idx)]
  if (!cmd) return
  toggleCommandPalette()
  cmd.action()
}
function _setupCP() {
  var cp = document.getElementById('cmd-palette')
  if (!cp) return
  cp.addEventListener('click', function(e) { if (e.target === cp) toggleCommandPalette() })
  var inp = document.getElementById('cmd-palette-input')
  if (inp) {
    inp.addEventListener('input', function(e) { _filterCP(e.target.value) })
    inp.addEventListener('keydown', function(e) {
      var results = document.querySelectorAll('.cmd-item')
      if (e.key === 'ArrowDown') { e.preventDefault(); _cpIdx = Math.min(_cpIdx + 1, results.length - 1); _filterCP(inp.value) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); _cpIdx = Math.max(_cpIdx - 1, 0); _filterCP(inp.value) }
      else if (e.key === 'Enter') { e.preventDefault(); _execCP(_cpIdx) }
      else if (e.key === 'Escape') toggleCommandPalette()
    })
  }
  var results = document.getElementById('cmd-palette-results')
  if (results) results.addEventListener('click', function(e) { var item = e.target.closest('.cmd-item'); if (item) _execCP(parseInt(item.dataset.idx)) })
}

// ── Search operator parser ──────────────────────────────────────────────────
function _parseSearchOperators(query) {
  var result = { text: query, artist: null, yearMin: null, yearMax: null, format: null, album: null, genre: null, is: null, playsMin: null, durMin: null, durMax: null, source: null }
  var text = (query || '').trim()
  if (!text) return result

  var sourceRx = /^source:(\S+)/i
  var sourceMatch = text.match(sourceRx)
  if (sourceMatch) {
    result.source = sourceMatch[1].toLowerCase()
    text = text.replace(sourceMatch[0], '').trim()
  }

  var artistRx = /\bartist:"([^"]+)"|\bartist:(\S+)/i
  var artistMatch = text.match(artistRx)
  if (artistMatch) {
    // group 1 = quoted form, group 2 = bare word
    result.artist = artistMatch[1] || artistMatch[2]
    text = text.replace(artistMatch[0], '').trim()
  }

  var yearRx = /\byear:(\d{4})(?:-(\d{4}))?\b/i
  var yearMatch = text.match(yearRx)
  if (yearMatch) {
    result.yearMin = parseInt(yearMatch[1])
    result.yearMax = yearMatch[2] ? parseInt(yearMatch[2]) : parseInt(yearMatch[1])
    text = text.replace(yearMatch[0], '').trim()
  } else {
    var yearMaxRx = /\byear:-(\d{4})\b/i
    var yearMaxMatch = text.match(yearMaxRx)
    if (yearMaxMatch) {
      result.yearMax = parseInt(yearMaxMatch[1])
      text = text.replace(yearMaxMatch[0], '').trim()
    }
  }

  var formatRx = /\bformat:(\S+)/i
  var formatMatch = text.match(formatRx)
  if (formatMatch) {
    result.format = formatMatch[1]
    text = text.replace(formatMatch[0], '').trim()
  }

  var m5 = text.match(/\balbum:"([^"]+)"|\balbum:(\S+)/i); if (m5) { result.album = m5[1] || m5[2]; text = text.replace(m5[0], '').trim() }
  var m6 = text.match(/\bgenre:"([^"]+)"|\bgenre:(\S+)/i); if (m6) { result.genre = m6[1] || m6[2]; text = text.replace(m6[0], '').trim() }
  var m7 = text.match(/\bis:(liked|downloaded|flac|lossy)\b/); if (m7) { result.is = m7[1]; text = text.replace(m7[0], '').trim() }
  var m8 = text.match(/\bplays:>(\d+)\b/); if (m8) { result.playsMin = parseInt(m8[1]); text = text.replace(m8[0], '').trim() }
  var m9 = text.match(/\bduration:<(\d+)\b/); if (m9) { result.durMax = parseInt(m9[1]); text = text.replace(m9[0], '').trim() }
  var m10 = text.match(/\bduration:>(\d+)\b/); if (m10) { result.durMin = parseInt(m10[1]); text = text.replace(m10[0], '').trim() }
  var m11 = text.match(/\byear:>(\d{4})\b/); if (m11) { result.yearMin = parseInt(m11[1]); text = text.replace(m11[0], '').trim() }
  var m12 = text.match(/\byear:<(\d{4})\b/); if (m12) { result.yearMax = parseInt(m12[1]); text = text.replace(m12[0], '').trim() }

  var operators = []
  if (result.artist) operators.push({ key: 'artist', field: 'artist', op: 'is', value: result.artist })
  if (result.yearMin && result.yearMax && result.yearMin !== result.yearMax) operators.push({ key: 'year', field: 'year', op: 'range', value: result.yearMin + '-' + result.yearMax })
  else if (result.yearMin) operators.push({ key: 'year', field: 'year', op: '>', value: result.yearMin })
  else if (result.yearMax) operators.push({ key: 'year', field: 'year', op: '<', value: result.yearMax })
  if (result.format) operators.push({ key: 'format', field: 'format', op: 'is', value: result.format })
  if (result.album) operators.push({ key: 'album', field: 'album', op: 'is', value: result.album })
  if (result.genre) operators.push({ key: 'genre', field: 'genre', op: 'is', value: result.genre })
  if (result.is) operators.push({ key: 'is', field: 'is', op: 'is', value: result.is })
  if (result.playsMin) operators.push({ key: 'plays', field: 'plays', op: '>', value: result.playsMin })
  if (result.durMax) operators.push({ key: 'duration', field: 'duration', op: '<', value: result.durMax })
  if (result.durMin) operators.push({ key: 'duration', field: 'duration', op: '>', value: result.durMin })
  result.operators = operators
  result.text = text
  return result
}

// ── Fuzzy matching ───────────────────────────────────────────────────────────
function _fuzzyFind(text, candidates, limit) {
  limit = limit || 3
  var lower = text.toLowerCase()
  var scored = candidates.map(function(c) {
    var dist = _levenshtein(lower, c.toLowerCase())
    if (c.toLowerCase().indexOf(lower) !== -1) dist = Math.max(0, dist - 100)
    return { text: c, dist: dist }
  })
  scored.sort(function(a, b) { return a.dist - b.dist })
  return scored.slice(0, limit).filter(function(s) { return s.dist < Math.max(5, s.text.length / 2) }).map(function(s) { return s.text })
}

function _levenshtein(a, b) {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  var matrix = []
  for (var i = 0; i <= b.length; i++) { matrix[i] = [i] }
  for (var j = 0; j <= a.length; j++) { matrix[0][j] = j }
  for (var i = 1; i <= b.length; i++) {
    for (var j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1))
      }
    }
  }
  return matrix[b.length][a.length]
}

// The rule editor offers artist/album/genre/year/format/playCount, but track
// objects only carry artist/genre/year directly. `album` is `albumName`,
// `format` is not stored at all, and playCount lives in a separate map -- so
// `t[rule.field]` was undefined for those three and the rule silently matched
// nothing, forever.
function _smartFieldValue(t, field) {
  switch (field) {
    case 'album':     return t.albumName
    case 'artist':    return t.albumArtist || t.artist
    case 'format':    return (t.filePath || '').split('.').pop().toLowerCase()
    case 'playCount': return state.playCounts[t.filePath] || 0
    default:          return t[field]
  }
}

// Smart playlists live in localStorage under papa-smart-playlists, regular
// ones in the electron-store via IPC. Rename/duplicate used savePlaylist() for
// both, so a renamed smart playlist was UNSHIFTED into the regular store: the
// rename appeared to work, then a restart brought the old name back alongside a
// permanent duplicate, and repeat renames piled up more copies.
function _persistPlaylistFolders() {
  try { localStorage.setItem('papa-playlist-folders', JSON.stringify(state.playlistFolders)) } catch (_) {}
}

function _persistSmartPlaylists() {
  try { localStorage.setItem('papa-smart-playlists', JSON.stringify(state.smartPlaylists)) } catch (_) {}
}

function _persistPlaylist(pl) {
  if (pl && pl.type === 'smart') _persistSmartPlaylists()
  else window.api.savePlaylist(pl)
}

function _evalSmartPlaylist(pl) {
  var all = _allLibraryTracks()
  // A rule set that is empty, or whose every rule has a blank value, used to
  // match the WHOLE library ('' is a substring of everything). An
  // unconfigured smart playlist is empty, not everything.
  var rules = (pl.rules || []).filter(function (r) {
    return r && r.field && String(r.value == null ? '' : r.value).trim() !== ''
  })
  if (!rules.length) return []
  return all.filter(function(t) {
    return rules.every(function(rule) {
      var val = _smartFieldValue(t, rule.field)
      if (val === undefined || val === null) return false
      switch (rule.op) {
        case 'is': return String(val).toLowerCase() === String(rule.value).toLowerCase()
        case 'contains': return String(val).toLowerCase().indexOf(String(rule.value).toLowerCase()) !== -1
        case 'gt': return Number(val) > Number(rule.value)
        case 'lt': return Number(val) < Number(rule.value)
        case 'gte': return Number(val) >= Number(rule.value)
        case 'lte': return Number(val) <= Number(rule.value)
        default: return true
      }
    })
  })
}

// ── Online/offline detection ─────────────────────────────────────────────────
window.addEventListener('online', () => { state.isOnline = true })
window.addEventListener('offline', () => { state.isOnline = false })

// ── Library manager ─────────────────────────────────────────────────────────
// Deleting music is irreversible from the user's point of view even when the
// files go to Trash, so this view never pre-selects anything, never hides why
// a copy is or is not safe to remove, and always names the exact files and
// total size before it touches the disk.

var _mgState = { groups: [], picked: {}, busy: false, tab: 'duplicates', trash: null }

function _mgTracksFromLibrary() {
  var out = []
  for (var i = 0; i < state.library.length; i++) {
    var a = state.library[i]
    for (var j = 0; j < (a.tracks || []).length; j++) {
      var t = a.tracks[j]
      if (!t.filePath) continue
      out.push({
        filePath: t.filePath,
        title: t.title || null,
        trackNumber: t.trackNumber || 0,
        channels: t.channels || 0,
        fileSize: t.fileSize || 0,
        codec: t.codec || null,
        bitsPerSample: t.bitsPerSample || 0,
        sampleRate: t.sampleRate || 0,
        album: a.name,
        albumArtist: a.artist,
        artist: t.artist || a.artist,
      })
    }
  }
  return out
}

function _mgFmtBytes(n) {
  if (!n) return '0 MB'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB'
  return Math.round(n / 1e6) + ' MB'
}

function _mgPickedPaths() {
  var out = []
  for (var k in _mgState.picked) {
    if (Object.prototype.hasOwnProperty.call(_mgState.picked, k) && _mgState.picked[k]) out.push(k)
  }
  return out
}

function _mgTabsHtml() {
  var t = _mgState.tab
  return '<div class="mg-tabs">' +
    '<button class="mg-tab' + (t === 'duplicates' ? ' active' : '') + '" data-mgtab="duplicates">Duplicates</button>' +
    '<button class="mg-tab' + (t === 'health' ? ' active' : '') + '" data-mgtab="health">Health</button>' +
    '<button class="mg-tab' + (t === 'storage' ? ' active' : '') + '" data-mgtab="storage">Storage</button>' +
    '<button class="mg-tab' + (t === 'trash' ? ' active' : '') + '" data-mgtab="trash">Recently Deleted</button>' +
    '</div>'
}

function _mgBindTabs() {
  document.querySelectorAll('[data-mgtab]').forEach(function (b) {
    b.addEventListener('click', function () {
      _mgState.tab = b.dataset.mgtab
      renderManage()
    })
  })
}

function renderManage() {
  if (_mgState.tab === 'trash') return renderManageTrash()
  if (_mgState.tab === 'health') return renderManageHealth()
  if (_mgState.tab === 'storage') return renderManageStorage()
  return renderManageDuplicates()
}

function _mgShell(inner, sub) {
  return '<div class="page mg-page">' +
    '<div class="mg-head"><h2 class="mg-title">Manage Library</h2>' +
    (sub ? '<div class="mg-sub">' + sub + '</div>' : '') + '</div>' +
    _mgTabsHtml() + inner + '</div>'
}

// Everything here reports what it found and hands the fix to the same delete
// funnel the rest of the app uses — so a "Fix" click still gets the file list,
// the confirmation, the state pruning and the undo.
async function renderManageHealth() {
  var _tabAtStart = _mgState.tab
  setContent(_mgShell('<div class="mg-empty">Scanning the library…</div>'))
  _mgBindTabs()

  var extras = await window.api.libraryScanExtras().catch(function () { return null })
  // The scan takes seconds. If you switched sub-tab (or left Manage entirely)
  // while it ran, the late result used to overwrite whatever you were now
  // looking at.
  if (_mgState.tab !== _tabAtStart || state.currentPage !== 'manage') return
  var H = window.PapaLibraryHealth
  if (!H) { setContent(_mgShell('<div class="mg-empty">Health tools failed to load.</div>')); _mgBindTabs(); return }

  if (!extras) {
    setContent(_mgShell('<div class="mg-empty">Could not scan the library, so nothing was checked. ' +
      'Make sure the music folder is reachable, then try again.</div>', 'Scan failed'))
    _mgBindTabs()
    return
  }
  var findings = H.assessLibrary(state.library, extras)
  _mgState.findings = findings
  var reclaim = H.reclaimable(findings)

  if (!findings.length) {
    setContent(_mgShell('<div class="mg-empty">Nothing wrong found. Library looks clean.</div>',
      'No problems detected'))
    _mgBindTabs()
    return
  }

  var html = ''
  for (var i = 0; i < findings.length; i++) {
    var f = findings[i]
    var sample = f.paths.slice(0, 6).map(function (p) {
      return '<div class="mg-health-path">' + esc(_mgBaseName(p) || p) + '</div>'
    }).join('')
    html += '<div class="mg-group mg-sev-' + f.severity + '">' +
      '<div class="mg-group-head">' +
        '<span class="mg-group-title">' + esc(f.title) + '</span>' +
        '<span class="mg-group-meta">' + f.count + ' item' + (f.count === 1 ? '' : 's') +
          (f.bytes ? ' · ' + _mgFmtBytes(f.bytes) : '') + '</span>' +
      '</div>' +
      '<div class="mg-health-detail">' + esc(f.detail) + '</div>' +
      sample +
      (f.paths.length > 6 ? '<div class="mg-health-path">…and ' + (f.paths.length - 6) + ' more</div>' : '') +
      (f.fixAction
        ? '<div class="mg-health-actions"><button class="mg-btn mg-btn-danger mg-btn-sm" data-fix="' + esc(f.id) + '">Review &amp; remove…</button></div>'
        : '<div class="mg-health-actions"><span class="mg-health-note">Nothing is removed for this — it needs a decision from you.</span></div>') +
      '</div>'
  }

  if (extras && !extras.partialsChecked) {
    html = '<div class="mg-warn">Soulseek is not reachable, so unfinished downloads were not checked ' +
      '— nothing is guessed at here.</div>' + html
  }

  setContent(_mgShell(html, findings.length + ' finding' + (findings.length === 1 ? '' : 's') +
    (reclaim ? ' · up to ' + _mgFmtBytes(reclaim) + ' reclaimable' : '')))
  _mgBindTabs()
  document.querySelectorAll('[data-fix]').forEach(function (b) {
    b.addEventListener('click', function () {
      var f = (_mgState.findings || []).filter(function (x) { return x.id === b.dataset.fix })[0]
      if (f && f.fixAction) libraryMutate({ kind: 'trash', paths: f.fixAction.paths, label: f.title })
    })
  })
}

async function renderManageStorage() {
  setContent(_mgShell('<div class="mg-empty">Measuring…</div>'))
  _mgBindTabs()
  var rep = await window.api.libraryStorageReport().catch(function () { return null })
  if (!rep) { setContent(_mgShell('<div class="mg-empty">Could not read storage.</div>')); _mgBindTabs(); return }

  var rows = (rep.roots || []).map(function (r) {
    return '<div class="mg-store-row"><span class="mg-store-label">' + esc(r.path) + '</span>' +
      '<span class="mg-store-val">' + _mgFmtBytes(r.bytes) + '</span></div>'
  }).join('')
  rows += '<div class="mg-store-row"><span class="mg-store-label">Cached artwork</span>' +
    '<span class="mg-store-val">' + _mgFmtBytes(rep.artworkBytes) + '</span></div>'
  rows += '<div class="mg-store-row"><span class="mg-store-label">Trash (recoverable, still using space)</span>' +
    '<span class="mg-store-val">' + _mgFmtBytes(rep.trashBytes) + '</span></div>'
  if (rep.free != null) {
    rows += '<div class="mg-store-row mg-store-total"><span class="mg-store-label">Free on drive</span>' +
      '<span class="mg-store-val">' + _mgFmtBytes(rep.free) +
      (rep.total ? ' of ' + _mgFmtBytes(rep.total) : '') + '</span></div>'
  }
  setContent(_mgShell('<div class="mg-store">' + rows + '</div>' +
    '<div class="mg-note">Trash counts against your free space until it is emptied — see Recently Deleted.</div>'))
  _mgBindTabs()
}

// Files here have left the library but not the drive. Because the Trash sits on
// the SAME volume as the music, this is the only place that actually frees
// space — so it says so plainly rather than letting the user assume otherwise.
async function renderManageTrash() {
  setContent('<div class="page mg-page"><div class="mg-head"><h2 class="mg-title">Manage Library</h2></div>' +
    _mgTabsHtml() + '<div class="mg-empty">Reading Trash…</div></div>')
  _mgBindTabs()

  var data = await window.api.libraryTrashList().catch(function () { return null })
  if (!data) {
    setContent('<div class="page mg-page"><div class="mg-head"><h2 class="mg-title">Manage Library</h2></div>' +
      _mgTabsHtml() + '<div class="mg-empty">Could not read the Trash.</div></div>')
    _mgBindTabs()
    return
  }
  _mgState.trash = data

  var loc = (data.volumes || []).map(function (v) {
    return '<div class="mg-trash-vol"><code>' + esc(v.trashDir) + '</code>' +
      (v.free != null ? '<span class="mg-trash-free">' + _mgFmtBytes(v.free) + ' free on ' + esc(v.mount) + '</span>' : '') +
      '</div>'
  }).join('')

  var rows = (data.items || []).map(function (it) {
    return '<div class="mg-trash-row">' +
      '<label class="mg-pick"><input type="checkbox" class="mg-tcheck" data-name="' + esc(it.name) + '" data-payload="' + esc(it.payload || '') + '"></label>' +
      '<div class="mg-folder-body">' +
        '<div class="mg-folder-name" title="' + esc(it.original || it.payload) + '">' + esc(it.name) + '</div>' +
        '<div class="mg-folder-meta">' +
          '<span>' + _mgFmtBytes(it.bytes) + '</span>' +
          (it.isDir ? '<span>folder</span>' : '') +
          (it.deletedAt ? '<span>deleted ' + esc(String(it.deletedAt).replace('T', ' ').slice(0, 16)) + '</span>' : '') +
        '</div>' +
        (it.original ? '<div class="mg-verdict mg-keep">was ' + esc(it.original) + '</div>' : '') +
      '</div>' +
      (it.original ? '<button class="mg-btn mg-btn-sm" data-restore="' + esc(it.original) + '">Restore</button>' : '') +
      '</div>'
  }).join('')

  setContent('<div class="page mg-page">' +
    '<div class="mg-head"><h2 class="mg-title">Manage Library</h2>' +
      '<div class="mg-sub">' + (data.items || []).length + ' item' + ((data.items || []).length === 1 ? '' : 's') +
      ' in Trash · ' + _mgFmtBytes(data.totalBytes) + '</div></div>' +
    _mgTabsHtml() +
    '<div class="mg-note">Your music drive holds its own Trash, so deleting moved these files but did ' +
      '<strong>not</strong> free any space. Emptying the Trash is what frees it — and cannot be undone.' +
      loc + '</div>' +
    (rows || '<div class="mg-empty">Trash is empty.</div>') +
    '</div>' +
    ((data.items || []).length
      ? '<div class="mg-bar" id="mg-trash-bar">' +
          '<span id="mg-trash-text">' + _mgFmtBytes(data.totalBytes) + ' recoverable</span>' +
          '<div class="sel-bar-actions">' +
            '<button class="mg-btn" id="mg-restore-sel">Restore selected</button>' +
            '<button class="mg-btn mg-btn-danger" id="mg-empty-trash">Empty Trash…</button>' +
          '</div></div>'
      : ''))
  _mgBindTabs()
  _mgBindTrash()
}

function _mgSelectedTrashNames() {
  return Array.prototype.map.call(document.querySelectorAll('.mg-tcheck:checked'), function (c) { return c.dataset.name })
}

// Bare basenames are ambiguous across trash volumes -- two drives can each hold
// a "Greatest Hits". The payload path identifies exactly one entry.
function _mgSelectedTrashPayloads() {
  return Array.prototype.map.call(document.querySelectorAll('.mg-tcheck:checked'), function (c) { return c.dataset.payload })
    .filter(Boolean)
}

function _mgBindTrash() {
  document.querySelectorAll('[data-restore]').forEach(function (b) {
    b.addEventListener('click', async function () {
      b.disabled = true
      b.textContent = 'Restoring…'
      var r = await window.api.libraryRestoreTrashed({ paths: [b.dataset.restore] }).catch(function () { return null })
      showSnackbar(r && r.restored ? 'Restored' : 'Could not restore — ' +
        ((r && r.results && r.results[0] && r.results[0].error) || 'unknown reason'))
      _scheduleLibRescan()
      renderManageTrash()
    })
  })

  document.getElementById('mg-restore-sel')?.addEventListener('click', async function () {
    var names = _mgSelectedTrashNames()
    var items = (_mgState.trash.items || []).filter(function (i) { return names.indexOf(i.name) !== -1 && i.original })
    if (!items.length) { showSnackbar('Select something to restore first'); return }
    var r = await window.api.libraryRestoreTrashed({ paths: items.map(function (i) { return i.original }) })
      .catch(function () { return null })
    showSnackbar(r ? (r.restored + ' restored' + (r.failed ? ', ' + r.failed + ' failed' : '')) : 'Restore failed')
    _scheduleLibRescan()
    renderManageTrash()
  })

  document.getElementById('mg-empty-trash')?.addEventListener('click', function () {
    var names = _mgSelectedTrashNames()
    var items = (_mgState.trash.items || [])
    var target = names.length ? items.filter(function (i) { return names.indexOf(i.name) !== -1 }) : items
    var bytes = target.reduce(function (n, i) { return n + i.bytes }, 0)
    // Emptying everything is the one action in this app with no way back, and
    // a stray click should not be able to reach it. Typing the word is the
    // cheapest way to make it deliberate.
    var needsTyping = !names.length
    _mgConfirm(
      names.length ? 'Permanently delete ' + target.length + ' item' + (target.length === 1 ? '' : 's') + '?'
                   : 'Empty the whole Trash?',
      '<p class="mg-confirm-warn">This cannot be undone. There is no second copy.</p>' +
      '<p class="mg-confirm-sum">' + target.length + ' item' + (target.length === 1 ? '' : 's') + ' · ' +
        _mgFmtBytes(bytes) + ' will be permanently removed, freeing that space on your drive.</p>' +
      (needsTyping
        ? '<p class="mg-confirm-sum">Type <strong>EMPTY</strong> to confirm:</p>' +
          '<input id="mg-empty-confirm" class="sq-name-input" style="width:100%;box-sizing:border-box" autocomplete="off">'
        : ''),
      'Delete permanently',
      async function () {
        if (needsTyping) {
          var typed = (document.getElementById('mg-empty-confirm') || {}).value
          if (String(typed).trim().toUpperCase() !== 'EMPTY') {
            showSnackbar('Not emptied — type EMPTY to confirm')
            return
          }
        }
        var _payloads = _mgSelectedTrashPayloads()
        var r = await window.api.libraryEmptyTrash({
          names: names.length ? names : null,
          payloads: _payloads.length ? _payloads : null,
        })
          .catch(function () { return null })
        showSnackbar(r ? (r.removed + ' permanently deleted · ' + _mgFmtBytes(r.freed) + ' freed')
                       : 'Could not empty the Trash')
        renderManageTrash()
      }
    )
  })
}

function renderManageDuplicates() {
  var L = window.PapaLibraryManage
  if (!L) { setContent('<div class="page"><p>Library tools failed to load.</p></div>'); return }
  _mgState.groups = L.findDuplicates(_mgTracksFromLibrary())
  _mgState.picked = {}

  var groups = _mgState.groups
  var reclaimable = groups.reduce(function (n, g) { return n + g.deletableBytes }, 0)

  var html = '<div class="page mg-page">' +
    '<div class="mg-head">' +
      '<h2 class="mg-title">Manage Library</h2>' +
      '<div class="mg-sub">' + groups.length + ' album' + (groups.length === 1 ? '' : 's') +
        ' with more than one copy · up to ' + _mgFmtBytes(reclaimable) + ' safely reclaimable</div>' +
    '</div>' +
    _mgTabsHtml() +
    '<div class="mg-note">Nothing is selected for you. Removed files go to your drive\'s Trash, so a wrong call is recoverable — see Recently Deleted to restore or free the space.</div>'

  if (!groups.length) {
    html += '<div class="mg-empty">No duplicate albums found.</div></div>'
    setContent(html)
    _mgBindTabs()
    return
  }

  for (var i = 0; i < groups.length; i++) {
    var g = groups[i]
    html += '<div class="mg-group' + (g.reliable ? '' : ' mg-group-unsafe') + '">' +
      '<div class="mg-group-head">' +
        '<span class="mg-group-title">' + esc(g.artist || 'Unknown artist') + ' — ' + esc(g.album || 'Unknown album') + '</span>' +
        '<span class="mg-group-meta">' + g.folders.length + ' copies · ' + _mgFmtBytes(g.totalBytes) + '</span>' +
      '</div>'
    for (var w = 0; w < g.warnings.length; w++) {
      html += '<div class="mg-warn">' + esc(g.warnings[w]) + '</div>'
    }
    for (var f = 0; f < g.folders.length; f++) {
      var fo = g.folders[f]
      var name = L.baseOf(fo.dir) || fo.dir
      html += '<div class="mg-folder' + (fo.safeToDelete ? '' : ' mg-folder-keep') + '">' +
        '<label class="mg-pick">' +
          '<input type="checkbox" class="mg-check' + (fo.safeToDelete ? '' : ' mg-check-risky') +
          '" data-path="' + esc(fo.dir) + '" data-risky="' + (fo.safeToDelete ? '0' : '1') + '"' +
          ' title="' + esc(fo.safeToDelete ? 'Fully covered by another copy' : fo.blockers.join('; ')) + '">' +
        '</label>' +
        '<div class="mg-folder-body">' +
          '<div class="mg-folder-name" title="' + esc(fo.dir) + '">' + esc(name) + '</div>' +
          '<div class="mg-folder-meta">' +
            '<span class="mg-chip mg-ch-' + (fo.maxChannels >= 6 ? 'sur' : 'st') + '">' + esc(fo.channelLabel) + '</span>' +
            '<span>' + fo.trackCount + ' track' + (fo.trackCount === 1 ? '' : 's') + '</span>' +
            '<span>' + _mgFmtBytes(fo.bytes) + '</span>' +
            (fo.partCount > 1 ? '<span>' + fo.partCount + ' discs</span>' : '') +
            (fo.maxBitDepth ? '<span>' + fo.maxBitDepth + '-bit</span>' : '') +
          '</div>' +
          (fo.safeToDelete
            ? '<div class="mg-verdict mg-ok">Fully covered by ' + esc(L.baseOf(fo.supersededBy)) + '</div>'
            : '<div class="mg-verdict mg-keep">Keep — ' + esc(fo.blockers.join('; ')) + '</div>') +
        '</div>' +
        '<button class="mg-reveal" data-reveal="' + esc(fo.files[0] || '') + '" title="Show in file manager">⤢</button>' +
      '</div>'
    }
    html += '</div>'
  }
  html += '</div>' +
    '<div class="mg-bar" id="mg-bar" style="display:none">' +
      '<span id="mg-bar-text"></span>' +
      '<button class="mg-btn mg-btn-danger" id="mg-delete-btn">Move to Trash…</button>' +
    '</div>'
  setContent(html)
  _mgBindTabs()
  _mgBind()
}

function _mgBind() {
  document.querySelectorAll('.mg-check').forEach(function (cb) {
    cb.addEventListener('change', function () {
      _mgState.picked[cb.dataset.path] = cb.checked
      _mgUpdateBar()
    })
  })
  document.querySelectorAll('[data-reveal]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.reveal) window.api.slskShowInFolder(b.dataset.reveal)
    })
  })
  document.getElementById('mg-delete-btn')?.addEventListener('click', _mgConfirmDelete)
}

function _mgUpdateBar() {
  var picked = _mgPickedPaths()
  var bar = document.getElementById('mg-bar')
  if (!bar) return
  if (!picked.length) { bar.style.display = 'none'; return }
  var bytes = 0
  for (var i = 0; i < _mgState.groups.length; i++) {
    var fs2 = _mgState.groups[i].folders
    for (var j = 0; j < fs2.length; j++) {
      if (picked.indexOf(fs2[j].dir) !== -1) bytes += fs2[j].bytes
    }
  }
  bar.style.display = 'flex'
  var risky = document.querySelectorAll('.mg-check:checked[data-risky="1"]').length
  document.getElementById('mg-bar-text').innerHTML =
    esc(picked.length + ' folder' + (picked.length === 1 ? '' : 's') + ' selected · ' + _mgFmtBytes(bytes)) +
    (risky ? ' <span class="mg-bar-warn">' + risky + ' not fully covered</span>' : '')
}

function _mgBaseName(p) {
  var s = String(p == null ? '' : p)
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

// Shared by the Manage view and the right-click menu, so a delete started from
// anywhere gets the same inspection, the same confirmation and the same Trash.
// No generic confirm dialog exists in this app, and a destructive action is
// the wrong place to reuse the playlist-name prompt.
function _mgConfirm(title, bodyHtml, confirmLabel, onConfirm) {
  document.getElementById('mg-confirm-modal')?.remove()
  var dlg = document.createElement('div')
  dlg.id = 'mg-confirm-modal'
  dlg.className = 'modal-overlay'
  dlg.innerHTML = '<div class="modal-box mg-confirm-box">' +
    '<div class="modal-header-row">' +
      '<div class="modal-title">' + esc(title) + '</div>' +
      '<button class="modal-close-btn" id="mg-cf-x">✕</button>' +
    '</div>' +
    '<div class="mg-confirm-body">' + bodyHtml + '</div>' +
    '<div class="mg-confirm-actions">' +
      '<button class="mg-btn" id="mg-cf-cancel">Cancel</button>' +
      '<button class="mg-btn mg-btn-danger" id="mg-cf-ok">' + esc(confirmLabel) + '</button>' +
    '</div></div>'
  document.body.appendChild(dlg)
  function close() { dlg.remove(); document.removeEventListener('keydown', onKey); flushPendingLibraryUpdate() }
  function onKey(e) { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  // Enter submits from a text field, as it does everywhere else in the app.
  // Scoped to inputs on purpose: a confirm with no input focuses Cancel, and
  // Enter must not become a one-key path to a destructive action.
  dlg.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return
    var t = e.target
    if (!t || t.tagName !== 'INPUT' || t.type === 'checkbox' || t.type === 'radio') return
    e.preventDefault()
    dlg.querySelector('#mg-cf-ok')?.click()
  })
  dlg.addEventListener('click', function (e) { if (e.target === dlg) close() })
  dlg.querySelector('#mg-cf-x').addEventListener('click', close)
  dlg.querySelector('#mg-cf-cancel').addEventListener('click', close)
  dlg.querySelector('#mg-cf-ok').addEventListener('click', async function () {
    var btn = dlg.querySelector('#mg-cf-ok')
    btn.disabled = true
    btn.textContent = 'Working…'
    try { await onConfirm() } finally { close() }
  })
  dlg.querySelector('#mg-cf-cancel').focus()
}

// Bulk delete from the Manage view's checkbox selection.
async function _mgConfirmDelete() {
  if (_mgState.busy) return
  var picked = _mgPickedPaths()
  if (!picked.length) return

  // Carry the reason each risky folder was flagged into the confirmation, so
  // the decision is made with the warning in front of you rather than a count.
  var warnings = []
  for (var i = 0; i < _mgState.groups.length; i++) {
    var fs2 = _mgState.groups[i].folders
    for (var j = 0; j < fs2.length; j++) {
      if (picked.indexOf(fs2[j].dir) === -1 || fs2[j].safeToDelete) continue
      warnings.push(window.PapaLibraryManage.baseOf(fs2[j].dir) + ' — ' + fs2[j].blockers.join('; '))
    }
  }

  _mgState.busy = true
  try {
    await libraryMutate({
      kind: 'trash',
      paths: picked,
      label: picked.length + ' folder' + (picked.length === 1 ? '' : 's') + ' from Duplicates',
      warnings: warnings,
    })
  } finally {
    _mgState.busy = false
  }
}

// ── Tag editing ─────────────────────────────────────────────────────────────
// Fixing tags is the thing that makes duplicate detection and album grouping
// trustworthy, so it has to be pleasant AND it has to carry the album identity
// across — otherwise tidying up costs you your likes, ratings and cover art.

var _tagState = { tracks: [], before: null }

var _TAG_LABELS = {
  title: 'Title', artist: 'Artist', album: 'Album', albumartist: 'Album artist',
  date: 'Year', genre: 'Genre', track: 'Track #', disc: 'Disc #', composer: 'Composer',
}

// Library tracks use camelCase; the writer and the tag module use tag names.
function _tagsFromTrack(t, album) {
  return {
    filePath: t.filePath,
    title: t.title || '',
    artist: t.artist || '',
    album: (album && album.name) || t.albumName || '',
    albumartist: (album && album.artist) || t.albumArtist || '',
    date: t.year ? String(t.year) : '',
    genre: t.genre || '',
    track: t.trackNumber ? String(t.trackNumber) : '',
    disc: t.discNumber ? String(t.discNumber) : '',
    composer: t.composer || '',
    albumArtist: (album && album.artist) || t.albumArtist || '',
  }
}

function _tagTargets() {
  var album = state.library.find(function (a) { return a.id === (ctxTarget && ctxTarget.albumId) })
  if (ctxTarget && ctxTarget.track && ctxTarget.kind !== 'album') {
    return { tracks: [_tagsFromTrack(ctxTarget.track, album)], scope: 'track', album: album }
  }
  if (album) {
    return {
      tracks: (album.tracks || []).map(function (t) { return _tagsFromTrack(t, album) }),
      scope: 'album', album: album,
    }
  }
  return { tracks: [], scope: 'none', album: null }
}

function editTags(explicitTracks, scopeLabel) {
  var TE = window.PapaTagEdit
  var target = explicitTracks
    ? { tracks: explicitTracks, scope: 'selection', album: null }
    : _tagTargets()
  hideContextMenu()
  if (!target.tracks.length) { showSnackbar('Nothing to edit'); return }

  var common = TE.commonTags(target.tracks)
  _tagState = { tracks: target.tracks, before: common, album: target.album }

  var rows = TE.FIELDS.map(function (f) {
    // Per-track fields make no sense to bulk-set across a whole album.
    var perTrack = (f === 'title' || f === 'track')
    if (perTrack && target.tracks.length > 1) return ''
    return '<label class="tag-row">' +
      '<span class="tag-label">' + esc(_TAG_LABELS[f] || f) + '</span>' +
      '<input class="tag-input sq-name-input" data-tag="' + f + '" value="' + esc(common[f] || '') + '"' +
      ' autocomplete="off">' +
      '</label>'
  }).join('')

  var renumber = target.tracks.length > 1
    ? '<label class="tag-check"><input type="checkbox" id="tag-renumber"> ' +
      'Renumber tracks 1–' + target.tracks.length + ' in this order</label>'
    : ''

  _mgConfirm(
    target.tracks.length === 1 ? 'Edit tags' : 'Edit tags — ' + target.tracks.length + ' tracks',
    '<p class="mg-confirm-sum" style="margin-top:0">' +
      esc(scopeLabel || (target.album ? target.album.artist + ' — ' + target.album.name
                                      : target.tracks.length + ' files')) + '</p>' +
    (target.tracks.length > 1
      ? '<p class="mg-confirm-note">Fields that differ across the selection show ' + esc(TE.MIXED) +
        ' — leave them and they stay as they are.</p>'
      : '') +
    '<div class="tag-form">' + rows + '</div>' + renumber +
    '<p class="mg-confirm-note">Files are rewritten losslessly; the original is only replaced once the ' +
      'write succeeds.</p>',
    'Save tags',
    _applyTagEdit)
}

async function _applyTagEdit() {
  var TE = window.PapaTagEdit
  var patch = {}
  document.querySelectorAll('.tag-input').forEach(function (i) { patch[i.dataset.tag] = i.value })
  var renumber = !!(document.getElementById('tag-renumber') || {}).checked

  var writes = TE.bulkApply(_tagState.tracks, patch, { renumber: renumber })
  if (!writes.length) { showSnackbar('Nothing changed'); return }

  // Work out whether the album identity moves BEFORE the files change.
  var first = _tagState.tracks[0]
  var oldKey = TE.albumKeyOf({ albumArtist: first.albumartist, artist: first.artist, album: first.album })
  var newKey = TE.albumKeyAfter(
    { albumArtist: first.albumartist, artist: first.artist, album: first.album }, patch)

  var res = await window.api.libraryWriteTags({ files: writes }).catch(function () { return null })
  if (!res) { showSnackbar('Could not write tags'); return }
  if (!res.written) {
    var err = (res.results || [])[0]
    showSnackbar('No tags written' + (err && err.error ? ' — ' + err.error : ''))
    return
  }

  if (oldKey !== newKey) {
    var m = await window.api.libraryMigrateAlbumId({ oldKey: oldKey, newKey: newKey })
      .catch(function () { return null })
    if (m && m.migrated) _tagMigrateLocalKeys(m.oldId, m.newId)
  }

  showSnackbar(res.written + ' file' + (res.written === 1 ? '' : 's') + ' updated' +
    (res.failed ? ', ' + res.failed + ' failed' : '') +
    (oldKey !== newKey ? ' · album details carried over' : ''))
  _scheduleLibRescan()
}

// Ratings and notes live in the renderer's localStorage, so main cannot move
// them; it hands back the ids and this finishes the job.
function _tagMigrateLocalKeys(oldId, newId) {
  if (!oldId || !newId) return
  try {
    if (state.albumRatings && state.albumRatings[oldId] !== undefined) {
      state.albumRatings[newId] = state.albumRatings[oldId]
      delete state.albumRatings[oldId]
      localStorage.setItem('papa-album-ratings', JSON.stringify(state.albumRatings))
    }
    if (state.albumNotes && state.albumNotes[oldId] !== undefined) {
      state.albumNotes[newId] = state.albumNotes[oldId]
      delete state.albumNotes[oldId]
      localStorage.setItem('papa-album-notes', JSON.stringify(state.albumNotes))
    }
    if (state.likedAlbums) {
      var i = state.likedAlbums.indexOf(oldId)
      if (i >= 0) state.likedAlbums[i] = newId
    }
  } catch (_) {}
}

// ── Album artwork ───────────────────────────────────────────────────────────
// Writing the cache is enough for the app to show a cover. Embedding it into
// every audio file is a separate, opt-in choice because it rewrites each one.

async function setAlbumArtwork() {
  var album = state.library.find(function (a) { return a.id === (ctxTarget && ctxTarget.albumId) })
  hideContextMenu()
  if (!album) { showSnackbar('Could not work out which album that is'); return }

  var picked = await window.api.libraryPickArtwork().catch(function () { return null })
  if (!picked || !picked.ok) return           // cancelled: say nothing

  var files = (album.tracks || []).map(function (t) { return t.filePath }).filter(Boolean)

  _mgConfirm('Set artwork',
    '<p class="mg-confirm-sum" style="margin-top:0">' +
      esc(album.artist + ' — ' + album.name) + '</p>' +
    '<div class="art-preview"><img src="file://' + esc(picked.path) + '" alt=""></div>' +
    '<p class="mg-confirm-note">' + esc(_mgBaseName(picked.path)) + '</p>' +
    '<label class="tag-check"><input type="checkbox" id="art-embed"> ' +
      'Also embed it into all ' + files.length + ' audio file' + (files.length === 1 ? '' : 's') +
      '</label>' +
    '<p class="mg-confirm-note">Embedding rewrites every file on the album, which takes a while on ' +
      'large FLACs. The cover shows in Papa Audio either way — embedding is for other players.</p>',
    'Set artwork',
    async function () {
      var embed = !!(document.getElementById('art-embed') || {}).checked
      var res = await window.api.librarySetArtwork({
        albumId: album.id, sourcePath: picked.path, embed: embed, filePaths: files,
      }).catch(function () { return null })
      if (!res || !res.ok) {
        showSnackbar('Could not set artwork' + (res && res.error ? ' — ' + res.error : ''))
        return
      }
      showSnackbar('Artwork set' +
        (res.embedded ? ' · embedded in ' + res.embedded + ' file' + (res.embedded === 1 ? '' : 's') : '') +
        (res.embedFailed ? ' · ' + res.embedFailed + ' failed' : ''))
      // The cached file kept its name, so force the browser to re-read it.
      album.artPath = res.artPath
      _artCacheBust(album.id, res.artPath)
      _scheduleLibRescan()
    })
}

// Same path, same filename, new bytes — without this the old cover stays on
// screen until the app restarts.
function _artCacheBust(albumId, artPath) {
  var stamp = '?v=' + Date.now()
  document.querySelectorAll('img[src*="' + albumId + '"]').forEach(function (img) {
    img.src = 'file://' + artPath + stamp
  })
  document.querySelectorAll('.album-hero-art img, .album-card img').forEach(function (img) {
    if (img.src.indexOf(artPath) !== -1) img.src = 'file://' + artPath + stamp
  })
}

// ── Rename and move ─────────────────────────────────────────────────────────
// Both are planned in full before anything is touched, and both feed their
// per-file remaps to the pruner — otherwise playlists, likes and play counts
// keep pointing at the old paths and quietly stop working.

function _dirOfPath(p) {
  var s = String(p || '')
  var i = s.lastIndexOf('/')
  return i > 0 ? s.slice(0, i) : ''
}

// Every folder the library knows about, for sibling and destination checks.
function _allLibraryFolders() {
  var seen = {}
  for (var i = 0; i < state.library.length; i++) {
    var tr = state.library[i].tracks || []
    for (var j = 0; j < tr.length; j++) {
      var d = _dirOfPath(tr[j].filePath)
      if (d) seen[d] = true
    }
  }
  return Object.keys(seen)
}

function _filesUnder(dir) {
  var out = []
  var prefix = dir + '/'
  for (var i = 0; i < state.library.length; i++) {
    var tr = state.library[i].tracks || []
    for (var j = 0; j < tr.length; j++) {
      var fp = tr[j].filePath
      if (fp && fp.indexOf(prefix) === 0) out.push(fp)
    }
  }
  return out
}

// An album whose tracks live in more than one folder has no single folder to
// rename, so say so rather than picking one and moving half the album.
function _folderForTarget() {
  if (ctxTarget && ctxTarget.paths && ctxTarget.paths.length === 1) return { dir: ctxTarget.paths[0] }
  var album = state.library.find(function (a) { return a.id === (ctxTarget && ctxTarget.albumId) })
  if (!album) return { error: 'Could not work out which folder this is.' }
  var dirs = {}
  for (var i = 0; i < (album.tracks || []).length; i++) {
    var d = _dirOfPath(album.tracks[i].filePath)
    if (d) dirs[d] = true
  }
  var list = Object.keys(dirs)
  if (!list.length) return { error: 'This album has no files on disk.' }
  if (list.length > 1) {
    return { error: 'This album\'s tracks are spread across ' + list.length +
      ' folders, so there is no single folder to act on.' }
  }
  return { dir: list[0], album: album }
}

async function _applyPathPlan(plan, verb) {
  var res = await window.api.libraryMovePath({ from: plan.from, to: plan.to })
    .catch(function () { return null })
  if (!res || !res.ok) {
    showSnackbar(verb + ' failed — ' + ((res && res.error) || 'unknown reason'))
    return
  }
  // The files moved; everything that referenced them has to follow.
  var prune = await window.api.libraryPruneState({ removed: [], renamed: plan.remaps })
    .catch(function () { return null })
  var P = window.PapaLibraryPrune
  var extra = (P && prune && prune.summary && prune.summary.renamed)
    ? ' · ' + prune.summary.renamed + ' reference' + (prune.summary.renamed === 1 ? '' : 's') + ' updated'
    : ''
  showSnackbar(verb + ' to “' + window.PapaPathPlan.baseOf(plan.to) + '”' + extra)
  _scheduleLibRescan()
}

function libraryRenameFolder() {
  var PP = window.PapaPathPlan
  var t = _folderForTarget()
  hideContextMenu()
  if (t.error) { showSnackbar(t.error); return }

  var dir = t.dir
  var current = PP.baseOf(dir)
  var siblings = _allLibraryFolders().filter(function (d) { return _dirOfPath(d) === _dirOfPath(dir) })

  _mgConfirm('Rename folder',
    '<p class="mg-confirm-sum" style="margin-top:0">' + esc(dir) + '</p>' +
    '<input id="mg-rename-input" class="sq-name-input" style="width:100%;box-sizing:border-box" ' +
      'value="' + esc(current) + '" autocomplete="off">' +
    '<p class="mg-confirm-sum" id="mg-rename-note">' +
      _filesUnder(dir).length + ' file(s) will move with it.</p>',
    'Rename',
    async function () {
      var val = (document.getElementById('mg-rename-input') || {}).value
      var plan = PP.renamePlan({ dir: dir, newName: val, files: _filesUnder(dir), siblings: siblings })
      if (!plan.ok) {
        showSnackbar(PP.describePlan(plan) +
          (plan.suggestion ? ' Try “' + esc(plan.suggestion) + '”.' : ''))
        return
      }
      await _applyPathPlan(plan, 'Renamed')
    })
  setTimeout(function () {
    var i = document.getElementById('mg-rename-input')
    if (i) { i.focus(); i.select() }
  }, 50)
}

function libraryMoveFolder() {
  var PP = window.PapaPathPlan
  var t = _folderForTarget()
  hideContextMenu()
  if (t.error) { showSnackbar(t.error); return }

  var dir = t.dir
  var roots = (state.musicFolders || []).slice()
  if (!roots.length) { showSnackbar('No music folders configured to move into'); return }

  var opts = roots.map(function (r) {
    return '<option value="' + esc(r) + '">' + esc(r) + '</option>'
  }).join('')

  _mgConfirm('Move folder',
    '<p class="mg-confirm-sum" style="margin-top:0">' + esc(dir) + '</p>' +
    '<p class="mg-confirm-sum">Move into:</p>' +
    '<select id="mg-move-dest" class="sq-name-input" style="width:100%;box-sizing:border-box">' + opts + '</select>' +
    '<p class="mg-confirm-sum">' + _filesUnder(dir).length + ' file(s) will move. ' +
      'The app checks there is room before starting.</p>',
    'Move',
    async function () {
      var dest = (document.getElementById('mg-move-dest') || {}).value
      var plan = PP.movePlan({
        dir: dir, destRoot: dest, files: _filesUnder(dir), existing: _allLibraryFolders(),
      })
      if (!plan.ok) { showSnackbar(PP.describePlan(plan)); return }
      await _applyPathPlan(plan, 'Moved')
    })
}

// ── Row selection ───────────────────────────────────────────────────────────
// Plain clicks keep playing the track, exactly as before. Selection is only
// entered with Shift or Ctrl/Cmd held, so nothing about normal use changes.

var _sel = { rows: [], selected: [], anchor: null, noun: 'track' }

function _selRowsInView() {
  var content = document.getElementById('content')
  if (!content) return []
  var rows = content.querySelectorAll('.track-row')
  if (rows.length) { _sel.noun = 'track'; return Array.prototype.slice.call(rows) }
  var cards = content.querySelectorAll('.album-card[data-album]')
  _sel.noun = 'album'
  return Array.prototype.slice.call(cards).filter(function (c) {
    return c.dataset.album && c.dataset.album.indexOf('yt_') !== 0
  })
}

function _selClear() {
  var had = _sel.selected.length
  _sel.selected = []
  _sel.anchor = null
  _selPaint()
  // A library refresh may have been held back while this selection was live.
  if (had) flushPendingLibraryUpdate()
}

function _selPaint() {
  var M = window.PapaMultiSelect
  for (var i = 0; i < _sel.rows.length; i++) {
    _sel.rows[i].classList.toggle('row-selected', M ? M.isSelected(_sel.selected, i) : false)
  }
  var bar = document.getElementById('sel-bar')
  if (!bar) return
  if (!_sel.selected.length) { bar.style.display = 'none'; return }
  bar.style.display = 'flex'
  document.getElementById('sel-bar-text').textContent =
    M ? M.describe(_sel.selected.length, _sel.noun) : _sel.selected.length + ' selected'
  // Deleting albums and deleting tracks are both fine; queueing a set of
  // albums is not something this bar tries to express.
  var q = document.getElementById('sel-queue')
  if (q) q.style.display = _sel.noun === 'track' ? '' : 'none'
}

function _selHandleClick(e, row) {
  var M = window.PapaMultiSelect
  if (!M) return false
  var ctrl = e.ctrlKey || e.metaKey
  if (!e.shiftKey && !ctrl) return false     // ordinary click — leave it alone
  e.preventDefault()
  // stopPropagation only stops ANCESTOR listeners. Track rows carry two click
  // handlers on the SAME element -- the album page binds its own, and
  // bindContentEvents binds a generic .track-row one -- and both reached here.
  // A single Ctrl-click therefore ran applyClick twice: toggle on, toggle off,
  // so the selection was always empty. Shift only looked fine because applying
  // the same range twice is idempotent.
  e.stopImmediatePropagation()
  e.stopPropagation()
  // Belt and braces: listener order is not guaranteed, and a third binding on
  // these rows would reintroduce the double-toggle silently.
  if (e._papaSelHandled) return true
  e._papaSelHandled = true

  _sel.rows = _selRowsInView()
  var index = _sel.rows.indexOf(row)
  if (index < 0) return false

  var res = M.applyClick({
    index: index, shift: e.shiftKey, ctrl: ctrl,
    selected: _sel.selected, anchor: _sel.anchor,
  })
  _sel.selected = res.selected
  _sel.anchor = res.anchor
  _selPaint()
  return true
}

// Paths behind the current selection, whatever kind of row it is.
function _selPaths() {
  var out = []
  for (var i = 0; i < _sel.selected.length; i++) {
    var el = _sel.rows[_sel.selected[i]]
    if (!el) continue
    if (el.dataset.file) { out.push(el.dataset.file); continue }
    if (el.dataset.album) {
      var album = state.library.find(function (a) { return a.id === el.dataset.album })
      if (album) {
        for (var j = 0; j < (album.tracks || []).length; j++) {
          if (album.tracks[j].filePath) out.push(album.tracks[j].filePath)
        }
      }
    }
  }
  return out
}

function _selTracks() {
  var out = []
  var paths = _selPaths()
  for (var i = 0; i < paths.length; i++) {
    var found = null
    for (var a = 0; a < state.library.length && !found; a++) {
      var tr = state.library[a].tracks || []
      for (var b = 0; b < tr.length; b++) {
        if (tr[b].filePath === paths[i]) {
          found = Object.assign({}, tr[b], {
            albumArtist: state.library[a].artist,
            albumName: state.library[a].name,
            albumId: state.library[a].id,
            artPath: state.library[a].artPath,
          })
          break
        }
      }
    }
    if (found) out.push(found)
  }
  return out
}

function _selBindBar() {
  document.getElementById('sel-clear')?.addEventListener('click', _selClear)

  document.getElementById('sel-addpl')?.addEventListener('click', function () {
    var tracks = _selTracks()
    if (!tracks.length) return
    showAddToPlaylistModal(tracks)
    // The other two actions on this bar clear afterwards; this one left stale
    // highlighted rows behind.
    _selClear()
  })

  document.getElementById('sel-queue')?.addEventListener('click', function () {
    var tracks = _selTracks()
    if (!tracks.length) return
    for (var i = 0; i < tracks.length; i++) state.queue.push(tracks[i])
    updateNextPrefetch()
    renderQueuePanel()
    showSnackbar(tracks.length + ' added to queue')
    _selClear()
  })

  document.getElementById('sel-trash')?.addEventListener('click', function () {
    var paths = _selPaths()
    if (!paths.length) return
    var label = window.PapaMultiSelect
      ? window.PapaMultiSelect.describe(_sel.selected.length, _sel.noun)
      : paths.length + ' items'
    _selClear()
    libraryMutate({ kind: 'trash', paths: paths, label: label })
  })
}

// ── The mutation funnel ─────────────────────────────────────────────────────
// Every destructive action in the app goes through here. Written once so that
// each new delete surface inherits the same inspection, confirmation, playback
// handling, state pruning and undo — instead of re-implementing them and
// getting one of them wrong.
async function _mgTrashPaths(paths, whatLabel) {
  return libraryMutate({ kind: 'trash', paths: paths, label: whatLabel })
}

function _mgQueueImpact(paths) {
  var R = window.PapaQueueRepair
  if (!R) return { count: 0, playingHit: false, hits: [] }
  // The confirm needs to know about queue entries whose FILES are going, which
  // for a folder delete means matching by prefix as well as exact path.
  var doomed = {}
  for (var i = 0; i < paths.length; i++) doomed[paths[i]] = true
  var expanded = []
  for (var j = 0; j < state.queue.length; j++) {
    var fp = state.queue[j] && state.queue[j].filePath
    if (!fp) continue
    if (doomed[fp]) { expanded.push(fp); continue }
    for (var k = 0; k < paths.length; k++) {
      if (fp.indexOf(paths[k] + '/') === 0) { expanded.push(fp); break }
    }
  }
  return R.queueImpact(state.queue, state.queueIndex, expanded)
}

async function libraryMutate(op) {
  var paths = (op && op.paths) || []
  if (!paths.length) return

  // 1. What is actually there, read from disk — not from the library index,
  //    which can be stale in exactly the ways that matter here.
  var res = await window.api.libraryInspectPaths({ paths: paths }).catch(function () { return null })
  if (!res) { showSnackbar('Could not read those files'); return }
  var entries = res.entries || []
  var usable = entries.filter(function (e) { return e.allowed && e.exists })
  if (!usable.length) {
    showSnackbar('Nothing to remove — files are missing or outside your music folders')
    return
  }

  var bytes = entries.reduce(function (n, e) { return n + e.bytes }, 0)
  // fileCount is authoritative; files[] is capped for very large deletes.
  var fileCount = entries.reduce(function (n, e) { return n + (e.fileCount != null ? e.fileCount : e.files.length) }, 0)
  var impact = _mgQueueImpact(paths)

  // 2. Say plainly what will happen, including the things people forget.
  var list = ''
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    var bad = !e.allowed || !e.exists
    list += '<div class="mg-confirm-row' + (bad ? ' mg-confirm-bad' : '') + '">' +
      '<div class="mg-confirm-path">' + esc(e.path) + '</div>' +
      (function () {
        // A multi-disc release is grouped under its PARENT folder, so the path
        // being trashed can hold more than the album -- other formats, scans, a
        // second album sharing the folder. The disk count comes from
        // libraryInspectPaths; compare it with what the library actually knows
        // about under that path and say so when they disagree.
        if (!e.allowed || !e.exists) return ''
        var known = 0, pre = String(e.path).replace(/\/+$/, '') + '/'
        for (var li = 0; li < state.library.length; li++) {
          var tr = state.library[li].tracks || []
          for (var tj = 0; tj < tr.length; tj++) {
            if (tr[tj].filePath && tr[tj].filePath.indexOf(pre) === 0) known++
          }
        }
        var onDisk = e.fileCount != null ? e.fileCount : e.files.length
        if (known && onDisk > known) {
          return '<div class="mg-confirm-meta mg-confirm-warn">Contains ' + (onDisk - known) +
                 ' file' + ((onDisk - known) === 1 ? '' : 's') + ' your library does not track — they go too</div>'
        }
        return ''
      })() +
      (!e.exists ? '<div class="mg-confirm-meta">No longer on disk — will be skipped</div>'
        : !e.allowed ? '<div class="mg-confirm-meta">Outside your music folders — refused</div>'
        : '<div class="mg-confirm-meta">' + (e.fileCount != null ? e.fileCount : e.files.length) +
          ' file' + ((e.fileCount != null ? e.fileCount : e.files.length) === 1 ? '' : 's') +
          ' · ' + _mgFmtBytes(e.bytes) + '</div>') +
      '</div>'
  }

  var warn = ''
  if (op.warnings && op.warnings.length) {
    warn += '<p class="mg-confirm-warn"><strong>Not fully covered by another copy:</strong><br>' +
      op.warnings.map(function (w) { return esc(w) }).join('<br>') +
      '<br><br>Deleting these means losing those tracks unless you have them somewhere else.</p>'
  }
  if (impact.playingHit) {
    warn += '<p class="mg-confirm-warn">This is playing right now. Playback will skip to the next track.</p>'
  } else if (impact.count) {
    warn += '<p class="mg-confirm-warn">' + impact.count + ' track' + (impact.count === 1 ? '' : 's') +
      ' in your queue will be removed.</p>'
  }

  _mgConfirm(
    'Move ' + usable.length + ' item' + (usable.length === 1 ? '' : 's') + ' to Trash?',
    (op.label ? '<p class="mg-confirm-sum" style="margin-top:0">' + esc(op.label) + '</p>' : '') +
    warn +
    '<div class="mg-confirm-list">' + list + '</div>' +
    '<p class="mg-confirm-sum">' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ' · ' +
      _mgFmtBytes(bytes) + ' will go to your system Trash.<br>' +
      '<span class="mg-confirm-note">Your music is on the same drive as the Trash, so this ' +
      'will not free space until you empty it.</span></p>',
    'Move to Trash',
    function () { return _libraryMutateApply(op, paths, entries, impact) }
  )
}

async function _libraryMutateApply(op, paths, entries, impact) {
  // 3. Get out of the way of playback BEFORE the files disappear, so mpv is
  //    never asked to keep reading something that has just been moved.
  var allFiles = []
  var truncated = false
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].filesTruncated) truncated = true
    for (var j = 0; j < entries[i].files.length; j++) allFiles.push(entries[i].files[j])
  }
  // A capped listing would prune only the first 2000 paths and silently leave
  // the rest dangling, so fall back to every known library path under the
  // folders being removed.
  if (truncated) {
    var prefixes = paths.slice()
    for (var a = 0; a < state.library.length; a++) {
      var tr = state.library[a].tracks || []
      for (var b = 0; b < tr.length; b++) {
        var fp = tr[b].filePath
        if (!fp) continue
        for (var c = 0; c < prefixes.length; c++) {
          if (fp === prefixes[c] || fp.indexOf(prefixes[c] + '/') === 0) { allFiles.push(fp); break }
        }
      }
    }
  }
  var R = window.PapaQueueRepair
  if (R && impact.count) {
    var rep = R.repairQueue({ queue: state.queue, queueIndex: state.queueIndex, removedPaths: allFiles })
    var wasPlaying = state.isPlaying
    state.queue = rep.queue
    state.queueIndex = rep.queueIndex
    if (rep.empty) {
      audio.pause()
      state.isPlaying = false
      state.queueIndex = -1
      updatePlayBtn()
      updateNowPlaying(null)
    } else if (rep.removedCurrent && wasPlaying) {
      playCurrentTrack()
    }
    renderQueuePanel()
  }

  // 4. Move the files.
  var out = await window.api.libraryTrashPaths({ paths: paths }).catch(function () { return null })
  if (!out) { showSnackbar('Delete failed'); return }
  var okPaths = (out.results || []).filter(function (r) { return r.ok }).map(function (r) { return r.path })
  if (!okPaths.length) {
    var firstErr = (out.results || [])[0]
    showSnackbar('Nothing was removed' + (firstErr && firstErr.error ? ' — ' + firstErr.error : ''))
    return
  }

  // 5. Prune every saved reference, in one transaction, and keep the snapshot
  //    so undo can put the app's state back as well as the files.
  //
  //    Only the files that ACTUALLY moved. This used to prune `allFiles`, i.e.
  //    everything inspected -- so when one folder failed (permissions, or
  //    "outside your music folders"), that album's tracks were still stripped
  //    from playlists, likes and play counts while the files sat untouched on
  //    disk. The snackbar said "2 moved, 1 failed" while the state said all 3.
  var _okPrefixes = okPaths.map(function (p2) { return String(p2).replace(/\/+$/, '') })
  var prunedFiles = allFiles.filter(function (f) {
    return _okPrefixes.some(function (pre) { return f === pre || f.indexOf(pre + '/') === 0 })
  })
  var prune = await window.api.libraryPruneState({ removed: prunedFiles, renamed: [] })
    .catch(function () { return null })

  // Album-level likes are keyed by album id, not by path, so libraryPruneState
  // -- which is entirely path-based -- never touches them. Deleting an album
  // therefore left its like dangling forever: "Liked only" would claim N liked
  // albums and render fewer, with nothing to click. Drop the like only for
  // albums whose every known track just went away, so an album that merely lost
  // a track keeps its like.
  var _removedSet = {}
  // prunedFiles, not allFiles: an album whose delete FAILED must keep its like.
  for (var _r = 0; _r < prunedFiles.length; _r++) _removedSet[prunedFiles[_r]] = true
  var _goneAlbumIds = state.library.filter(function (a) {
    var tr = a.tracks || []
    return tr.length && tr.every(function (t) { return _removedSet[t.filePath] })
  }).map(function (a) { return a.id })
  var _likedBefore = state.likedAlbums.slice()
  if (_goneAlbumIds.length) {
    state.likedAlbums = state.likedAlbums.filter(function (id) { return _goneAlbumIds.indexOf(id) === -1 })
    if (state.likedAlbums.length !== _likedBefore.length) window.api.saveLiked(state.likedAlbums)
  }

  // 6. Offer it back. Undo has to restore BOTH the files and the state.
  var P = window.PapaLibraryPrune
  var extra = (P && prune && prune.summary) ? P.describeSummary(prune.summary) : ''
  var msg = okPaths.length + ' moved to Trash' + (out.failed ? ', ' + out.failed + ' failed' : '')
  if (extra) msg += '. ' + extra

  showSnackbar(msg, 'Undo', async function () {
    var back = await window.api.libraryRestoreTrashed({ paths: okPaths }).catch(function () { return null })
    if (prune && prune.snapshot) {
      await window.api.libraryRestoreState({ snapshot: prune.snapshot }).catch(function () {})
      await reloadPersistedState()
    }
    if (_likedBefore.length !== state.likedAlbums.length) {
      state.likedAlbums = _likedBefore
      window.api.saveLiked(state.likedAlbums)
    }
    showSnackbar(back && back.restored
      ? back.restored + ' restored'
      : 'Could not restore from Trash')
    _scheduleLibRescan()
  }, 12000)

  _scheduleLibRescan()
  if (state.currentPage === 'manage') setTimeout(renderManage, 1500)
}

// Undo rewrote the stores, so the renderer's copies have to be re-read.
async function reloadPersistedState() {
  try {
    // getLiked() is the liked-ALBUMS store; liked TRACKS come from
    // getLikedTracks(). Loading albums into state.likedTracks replaced every
    // liked song with an album-id string, and the next heart-click persisted
    // that to disk via saveLikedTracks. init() at line ~446 gets this right;
    // only this reload path did not.
    state.likedAlbums = await window.api.getLiked()
    state.likedTracks = await window.api.getLikedTracks()
    state.playCounts  = await window.api.getPlayCounts()
    state.playlists   = await window.api.getPlaylists()
    state.savedQueues = await window.api.getSavedQueues()
  } catch (_) {}
  renderSavedQueues()
}

// ── Download scheduling ─────────────────────────────────────────────────────
// Hand files to the main-process scheduler rather than POSTing each one, so a
// folder does not land as one deep queue on a single peer.
function _slskEnqueue(items) {
  var list = (items || []).filter(function(it) { return it && it.filename && it.username })
  if (!list.length) return Promise.resolve(null)
  if (!window.api || !window.api.slskEnqueueDownloads) {
    return Promise.all(list.map(function(it) {
      return window.api.slskDownload({ username: it.username, filename: it.filename, size: it.size || 0 })
        .catch(function() {})
    }))
  }
  return window.api.slskEnqueueDownloads({ items: list }).catch(function() { return null })
}

// Scheduler readout: how wide the download spread currently is.
var _dlSchedStats = null

function _dlPaintSchedulerStats(stats) {
  if (stats) _dlSchedStats = stats
  var el = document.getElementById('dl2-sched')
  if (!el) return
  var s = _dlSchedStats
  // Blanking made "scheduler idle" and "stats never arrived / scheduler
  // broken" look identical.
  if (!s || (!s.pending && !s.inflight)) { el.textContent = 'Scheduler idle'; return }
  var txt = s.inflight + ' active across ' + s.peers + ' peer' + (s.peers === 1 ? '' : 's')
  if (s.pending) txt += ' · ' + s.pending + ' waiting'
  if (s.benched && s.benched.length) txt += ' · ' + s.benched.length + ' benched'
  el.textContent = txt
}

function initDownloadScheduler() {
  if (!window.api || !window.api.onSlskSchedulerStats) return
  window.api.onSlskSchedulerStats(function(stats) { _dlPaintSchedulerStats(stats) })
  if (window.api.slskSchedulerStats) {
    window.api.slskSchedulerStats().then(_dlPaintSchedulerStats).catch(function() {})
  }
}

// ── Soulseek friends sidebar ────────────────────────────────────────────────
// Saved peers, sorted with whoever is reachable right now on top. Presence is
// pushed from the main process; this only paints what it is told.
var _slskFriends = {
  users: [],
  statuses: [],
  bound: false,
  started: false,
  refreshing: false,
}

function _slskFriendRows() {
  var P = window.PapaSlskPresence
  if (!P) return []
  return P.sortFriends(P.mergeStatuses(_slskFriends.users, _slskFriends.statuses))
}

function renderSlskFriends() {
  var list = document.getElementById('slsk-friends-list')
  if (!list) return
  var rows = _slskFriendRows()
  var countEl = document.getElementById('slskf-count')
  if (countEl) {
    var online = window.PapaSlskPresence ? window.PapaSlskPresence.countOnline(rows) : 0
    countEl.textContent = rows.length ? online + '/' + rows.length : ''
    countEl.classList.toggle('live', online > 0)
  }
  if (!rows.length) {
    list.innerHTML = '<li class="slskf-empty">No saved peers yet. Open a Soulseek user’s library and tap ☆ to keep them here.</li>'
    return
  }
  var html = ''
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    var meta = r.presenceText
    if (r.fileCount) meta += ' · ' + r.fileCount.toLocaleString() + ' files'
    if (r.note) meta += ' · ' + r.note
    html += '<li class="slskf-row" data-presence="' + r.presence + '" data-user="' + esc(r.username) + '"' +
      ' title="' + esc(r.username + ' — ' + meta) + '">' +
      '<span class="slskf-dot"></span>' +
      '<span class="slskf-name">' + esc(r.username) + '</span>' +
      '<button class="slskf-remove" data-remove="' + esc(r.username) + '" title="Remove from saved">✕</button>' +
      '</li>'
  }
  list.innerHTML = html
}

function _slskFriendsApplyStatuses(payload) {
  if (!payload) return
  if (Array.isArray(payload.statuses)) _slskFriends.statuses = payload.statuses
  renderSlskFriends()
}

function _slskFriendsSetRefreshing(on) {
  _slskFriends.refreshing = !!on
  document.getElementById('slskf-refresh-btn')?.classList.toggle('spin', !!on)
}

function refreshSlskFriendStatuses() {
  if (_slskFriends.refreshing) return Promise.resolve()
  if (!window.api || !window.api.slskRefreshUserStatuses) return Promise.resolve()
  _slskFriendsSetRefreshing(true)
  return window.api.slskRefreshUserStatuses()
    .then(function(res) { _slskFriendsApplyStatuses(res) })
    .catch(function() {})
    .then(function() { _slskFriendsSetRefreshing(false) })
}

function reloadSlskFriends() {
  if (!window.api || !window.api.slskSavedUsers) return Promise.resolve()
  return window.api.slskSavedUsers()
    .then(function(users) {
      _slskFriends.users = users || []
      renderSlskFriends()
    })
    .catch(function() {})
}

function _slskFriendsBind() {
  if (_slskFriends.bound) return
  var list = document.getElementById('slsk-friends-list')
  if (!list) return
  _slskFriends.bound = true

  list.addEventListener('click', function(e) {
    var rm = e.target.closest ? e.target.closest('[data-remove]') : null
    if (rm) {
      e.stopPropagation()
      var gone = rm.getAttribute('data-remove')
      window.api.slskUnsaveUser({ username: gone })
        .then(function(users) { _slskFriends.users = users || []; renderSlskFriends() })
        .catch(function() {})
      if (typeof showSnackbar === 'function') showSnackbar('Removed ' + gone)
      return
    }
    var row = e.target.closest ? e.target.closest('.slskf-row') : null
    if (!row) return
    var name = row.getAttribute('data-user')
    if (name && typeof showSlskUserExplorer === 'function') showSlskUserExplorer(name)
  })

  document.getElementById('slskf-refresh-btn')?.addEventListener('click', function(e) {
    e.stopPropagation()
    refreshSlskFriendStatuses()
  })
}

function initSlskFriends() {
  if (_slskFriends.started) return
  if (!window.api || !window.api.slskSavedUsers) return
  _slskFriends.started = true
  _slskFriendsBind()

  if (window.api.onSlskUserStatus) window.api.onSlskUserStatus(_slskFriendsApplyStatuses)
  if (window.api.onSlskSavedUsersChange) {
    window.api.onSlskSavedUsersChange(function(users) {
      _slskFriends.users = users || []
      renderSlskFriends()
    })
  }

  reloadSlskFriends().then(function() {
    if (window.api.slskUserStatuses) {
      window.api.slskUserStatuses().then(_slskFriendsApplyStatuses).catch(function() {})
    }
  })

  // Coming back to the window is the moment a stale list is most visible.
  if (window.api.onWindowFocus) {
    window.api.onWindowFocus(function(on) { if (on) refreshSlskFriendStatuses() })
  }
}

// ── Start ───────────────────────────────────────────────────────────────────
init()
initSlskFriends()
initDownloadScheduler()
_selBindBar()
