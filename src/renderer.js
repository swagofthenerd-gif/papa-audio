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
state.albumRatings = window.PapaLocal.readObject('papa-album-ratings')
state.albumNotes = window.PapaLocal.readObject('papa-album-notes')

const slsk = {
  status: { installed: false, running: false, connected: false, configured: false },
  searching: false,
  searched: false,
  results: [],
  lastQuery: '',
  // Non-zero while a throttle backoff is in progress, so the UI can say the
  // search is waiting rather than that it found nothing.
  throttledUntil: 0,
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

function _slskIsThrottleError(e) {
  var m = String((e && e.message) || e || '')
  return /\b429\b/.test(m) || /rate-limit/i.test(m) || /SLSKD_THROTTLED/.test(m)
}

// One retry per search, not one per variant: six variants all firing again is
// how the throttle was earned in the first place.
var _slskThrottleRetry = null
var _slskThrottleRetriedFor = ''
const SLSK_THROTTLE_RETRY_MS = 8000

function _slskScheduleThrottleRetry(query) {
  if (_slskThrottleRetriedFor === query) return   // already had its one retry
  if (_slskThrottleRetry) return
  _slskThrottleRetriedFor = query
  slsk.throttledUntil = Date.now() + SLSK_THROTTLE_RETRY_MS
  slsk.error = 'slskd is throttling searches — retrying in ' +
    Math.round(SLSK_THROTTLE_RETRY_MS / 1000) + 's'
  _slskThrottleRetry = setTimeout(function () {
    _slskThrottleRetry = null
    slsk.throttledUntil = 0
    // Only if the user is still looking at this search.
    if (slsk.lastQuery !== query || state.currentPage !== 'search') return
    slsk.error = ''
    runSlskSearch(query)
  }, SLSK_THROTTLE_RETRY_MS)
}

// A new search clears the one-retry latch: the next query deserves its own.
function _slskResetThrottleRetry() {
  clearTimeout(_slskThrottleRetry)
  _slskThrottleRetry = null
  _slskThrottleRetriedFor = ''
  slsk.throttledUntil = 0
}

// The exact array the cards were rendered from. data-gi indexes THIS, so the
// click handlers must read it too -- see the comment where it is assigned.
var _slskRendered = []
// Every runSlskSearch takes a ticket. Its callbacks do nothing once a newer
// search has taken one: without this, search A's variants kept merging into
// search B's results, and A's finally() flipped B's spinner off and killed B's
// refresh timer, so B rendered "No results" while still fetching.
var _slskRun = 0
var _slskTimer = null
// The live slsk-progress subscription's own unsubscribe function, so tearing it
// down cannot take somebody else's listener on the same channel with it.
var _slskProgressOff = null
// How many source groups the results grid shows. Extended by Show more; reset
// for every new search, so one long list does not make the next one enormous.
const SLSK_SHOW_STEP = 60
var _slskShowLimit = SLSK_SHOW_STEP
// Interval handles. An interval with no handle can never be stopped or
// superseded; several of these restarted without clearing the previous one.
var _connCheckTimer = null
var _waveformTimer = null

var _playlistSorts = {}
// Bounded. These only ever grow unless the user presses Back, so a long session
// of browsing accumulates one entry per navigation for as long as the app is
// open — and each holds a navId, which for a search page is the whole query
// string. Found by the soak: the renderer's memory floor rose monotonically
// across a hundred-minute run, and these were the only module-scope collections
// with nothing bounding them.
//
// Two hundred is far more than anyone reaches for with a Back button, and the
// oldest entry is the one nobody is going to want.
const NAV_HISTORY_CAP = 200
const navHistory = []
const navFuture  = []

function _pushNavHistory(entry) {
  navHistory.push(entry)
  if (navHistory.length > NAV_HISTORY_CAP) navHistory.shift()
}
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
// Bounded and LRU. One entry per page ever visited, written on every
// navigation away and never pruned -- keyed by page:navId, so a long session
// browsing albums accumulated one per album. Small entries, but unbounded.
const SCROLL_MEMORY_CAP = 200
const _scrollMemory = new Map()
var _undoStack = []
var _libPresets = []
try {
  var _lp = window.PapaLocal.readArray('papa-lib-presets')
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
// The keydown handler used to test literal keys and never consult this table,
// so every value in it was decorative: "Configure Shortcuts" listed keys the
// app did not read, and getShortcut was referenced nowhere. Two entries also
// described the opposite of the behaviour -- the plain arrows seek, they have
// never changed track -- and nextTrack, prevTrack and stopAfter had no binding
// at all. Every test in the handler now goes through matchesShortcut().
var DEFAULT_SHORTCUTS = {
  'playPause': 'Space',
  'nextTrack': 'Shift+ArrowRight',
  'prevTrack': 'Shift+ArrowLeft',
  'seekForward': 'ArrowRight',
  'seekBackward': 'ArrowLeft',
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
  'skipInterludes': 'Control+Shift+i',
  'shortcuts': 'F1',
}

// What each one does, for the dialog. An action with no label here would show
// its camelCase identifier, which is what the old dialog did for all of them.
var SHORTCUT_LABELS = {
  playPause: 'Play / pause',
  nextTrack: 'Next track',
  prevTrack: 'Previous track',
  seekForward: 'Seek forward 10s',
  seekBackward: 'Seek back 10s',
  volumeUp: 'Volume up',
  volumeDown: 'Volume down',
  toggleMute: 'Mute',
  toggleShuffle: 'Shuffle',
  cycleRepeat: 'Repeat mode',
  cycleSpeed: 'Playback speed',
  fullscreen: 'Full-screen now playing',
  toggleQueue: 'Show queue',
  toggleLyrics: 'Show lyrics',
  focusSearch: 'Search',
  commandPalette: 'Command palette',
  likeTrack: 'Like this track',
  sleepTimer: 'Sleep timer (30 min)',
  saveQueue: 'Save the queue',
  addToQueue: 'Queue this track again',
  undo: 'Undo',
  skipShort: 'Auto-skip short tracks',
  stopAfter: 'Stop after this track',
  toggleAgent: 'Assistant',
  skipInterludes: 'Skip interludes',
  shortcuts: 'Keyboard shortcuts',
}

var _shortcuts = {}
try {
  var _savedShortcuts = window.PapaLocal.readObject('papa-shortcuts')
  _shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, _savedShortcuts)
} catch (_) {
  _shortcuts = Object.assign({}, DEFAULT_SHORTCUTS)
}

function getShortcut(action) { return _shortcuts[action] || DEFAULT_SHORTCUTS[action] }

// One canonical spelling for a key combination, so a stored binding and a live
// event can be compared as strings. Modifiers in a fixed order; letters always
// lowercase, because Shift+p arrives as 'P' and a binding written 'Control+
// Shift+p' must still match it.
var SHORTCUT_KEY_ALIASES = {
  ' ': 'Space', 'Spacebar': 'Space',
  '+': '=',              // Shift+= on most layouts
  'Esc': 'Escape',
  'Left': 'ArrowLeft', 'Right': 'ArrowRight', 'Up': 'ArrowUp', 'Down': 'ArrowDown',
}

function normalizeShortcutKey(key) {
  if (key == null) return ''
  var k = String(key)
  if (SHORTCUT_KEY_ALIASES[k]) k = SHORTCUT_KEY_ALIASES[k]
  // Single characters normalize to lower case; named keys keep their spelling.
  return k.length === 1 ? k.toLowerCase() : k
}

function normalizeShortcut(combo) {
  if (!combo) return ''
  var parts = String(combo).split('+')
  var key = normalizeShortcutKey(parts.pop())
  var mods = {}
  parts.forEach(function (p) {
    var m = p.trim().toLowerCase()
    if (m === 'ctrl' || m === 'control' || m === 'cmd' || m === 'meta' || m === 'command') mods.control = true
    else if (m === 'alt' || m === 'option') mods.alt = true
    else if (m === 'shift') mods.shift = true
  })
  var out = []
  if (mods.control) out.push('Control')
  if (mods.alt) out.push('Alt')
  if (mods.shift) out.push('Shift')
  out.push(key)
  return out.join('+')
}

// Control and Meta are folded together: the same binding should work for a
// user on a keyboard where Cmd is the modifier.
function comboFromEvent(e) {
  var out = []
  if (e.ctrlKey || e.metaKey) out.push('Control')
  if (e.altKey) out.push('Alt')
  if (e.shiftKey) out.push('Shift')
  // e.code for the space bar: e.key is ' ', which is invisible in a binding.
  var key = e.code === 'Space' ? 'Space' : normalizeShortcutKey(e.key)
  // A modifier pressed on its own is not a combination.
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return ''
  out.push(key)
  return out.join('+')
}

function matchesShortcut(action, e) {
  var want = normalizeShortcut(getShortcut(action))
  if (!want) return false
  return comboFromEvent(e) === want
}

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
  var _pc = window.PapaLocal.readObject('papa-pl-collapsed')
  if (_pc && typeof _pc === 'object' && !Array.isArray(_pc)) _plCollapsedFolders = _pc
} catch (_) {}

// ── Undo ──────────────────────────────────────────────────────────────────────
// An entry used to leave the stack only if the user clicked Undo or pressed
// Ctrl+Z. Ignore both and it stayed forever -- so Ctrl+Z in a long session
// reverted whatever destructive action had last been left un-undone, however
// long ago, with no confirmation and no indication of what it was about to do.
// Each retained closure also held its snapshot, and the library operations
// snapshot liked tracks, play counts, play history, playlists and saved queues.
//
// An undo is now only offered while its snackbar could still plausibly be on
// screen, it says WHAT it is undoing, and the stack is capped so a burst cannot
// pin a run of snapshots in memory.
const UNDO_WINDOW_MS = 30000
const UNDO_STACK_CAP = 10

function _pruneUndoStack() {
  const now = Date.now()
  for (let i = _undoStack.length - 1; i >= 0; i--) {
    const e = _undoStack[i]
    // Dropping the entry drops its closure, and with it the snapshot.
    if (e.done || now - e.at > UNDO_WINDOW_MS) _undoStack.splice(i, 1)
  }
  while (_undoStack.length > UNDO_STACK_CAP) _undoStack.shift()
}

function pushUndo(label, undoFn) {
  _pruneUndoStack()
  var entry = { label: label, fn: undoFn, done: false, at: Date.now() }
  _undoStack.push(entry)
  while (_undoStack.length > UNDO_STACK_CAP) _undoStack.shift()
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
  _pruneUndoStack()
  var item = null
  while (_undoStack.length) {
    var candidate = _undoStack.pop()
    if (candidate && !candidate.done) { item = candidate; break }
  }
  if (!item) {
    // Said out loud: silence here reads as a broken keyboard shortcut.
    showSnackbar('Nothing recent to undo', null, null, 2500)
    return
  }
  item.done = true
  item.fn()
  // Naming it is the point: Ctrl+Z used to revert something the user could no
  // longer see, without saying what.
  showSnackbar('Undone: ' + item.label, null, null, 4000)
}

// ── Visibility & power management ───────────────────────────────────────────
let _appVisible = !document.hidden
// The id main stamps on every line of the daily log. Held here so anything the
// user copies out of a failure card can be lined up against it — the two streams
// had nothing shared at all.
var _sessionId = null
var _appVersion = null
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
// Bounded, least-recently-used. Three caches in this file held a full payload
// per unique key for the life of the process, with no TTL and no cap: the
// YouTube search cache (a whole result set per scope::query), artist bios, and
// album colours. A Map keeps insertion order, so touching an entry on read is
// enough to make eviction least-recently-used rather than oldest-inserted.
function _cacheGet(map, key) {
  if (!map.has(key)) return undefined
  const v = map.get(key)
  map.delete(key)
  map.set(key, v)
  return v
}

function _cacheSet(map, key, value, cap) {
  map.delete(key)
  map.set(key, value)
  while (map.size > cap) map.delete(map.keys().next().value)
  return value
}

const _bioCache = new Map()
const _BIO_CACHE_CAP = 100

document.addEventListener('visibilitychange', () => {
  _appVisible = !document.hidden
  if (!_appVisible) {
    retuneDownloadsPolling()
    if (_homeClockInterval) { clearInterval(_homeClockInterval); _homeClockInterval = null }
  } else {
    retuneDownloadsPolling()
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
  // Was oldest-inserted; least-recently-used keeps the covers actually in view.
  _cacheSet(_colorCache, _colorImg._artPath, [br, bg, bb], 200)
  setAccent(`rgb(${br},${bg},${bb})`, `rgba(${br},${bg},${bb},0.85)`, `${br},${bg},${bb}`)
}

function extractAlbumColor(artPath) {
  if (!artPath) { setAccent('#1db954', '#1ed760'); return }
  const cached = _cacheGet(_colorCache, artPath)
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
  _playlistSorts = window.PapaLocal.readObject('papa-pl-sorts')
  // readArray always returns an array, so the old `if (savedSmart)` guard —
  // which was there because the parse could yield null — is now always true and
  // says nothing. state.smartPlaylists starts as [] anyway.
  state.smartPlaylists = window.PapaLocal.readArray('papa-smart-playlists')
  state.playlistFolders = window.PapaLocal.readArray('papa-playlist-folders',
    function (f) { return typeof f === 'string' && f })
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

  window.api.on('player-event', ({ type, data }) => {
    if (type === 'mpvMissing') showEngineBlocker('mpvMissing', null)
    else if (type === 'engineFailed') showEngineBlocker('engineFailed', data)
  })
  const playerStatus = await window.api.playerGetStatus()
  // "Unavailable" covers both a missing mpv and an mpv that would not start.
  // Telling the user to install what they already have is the bug in item 7.
  if (!playerStatus.available) {
    showEngineBlocker(playerStatus.mpvAvailable ? 'engineFailed' : 'mpvMissing',
      playerStatus.mpvAvailable ? { reason: 'start-error' } : null)
  }
  document.getElementById('mpv-recheck-btn').onclick = async () => {
    const msg = document.getElementById('mpv-recheck-msg')
    const wasMissing = _engineBlockerReason === 'mpvMissing'
    msg.textContent = 'Checking…'
    const r = await window.api.playerRecheck()
    if (r.available) { hideEngineBlocker(); msg.textContent = ''; setEngineState('', false) }
    else {
      msg.textContent = wasMissing
        ? 'Still not found. Install mpv, then try again.'
        : 'Still failing. The lines above are mpv\u2019s own report.'
    }
  }
  // Album ids stopped depending on tag padding, so ratings and notes — which the
  // renderer keys by album id in localStorage — have to follow the ids that moved.
  window.api.getAlbumIdRemap()
    .then(remap => {
      if (!remap || !Object.keys(remap).length) return
      let moved = 0
      for (const store of ['albumRatings', 'albumNotes']) {
        const key = store === 'albumRatings' ? 'papa-album-ratings' : 'papa-album-notes'
        const obj = window.PapaLocal.readObject(key)
        let changed = false
        for (const [oldId, newId] of Object.entries(remap)) {
          if (obj[oldId] === undefined || obj[newId] !== undefined) continue
          obj[newId] = obj[oldId]
          delete obj[oldId]
          changed = true
          moved++
        }
        if (changed) { window.PapaLocal.write(key, obj); state[store] = obj }
      }
      if (moved) console.log(`[papa] remapped ${moved} rating/note key(s) onto the new album ids`)
    })
    .catch(e => console.error('[papa] album id remap failed:', String(e && e.message || e)))

  // Fetched once, early, so a failure card later has it.
  window.api.getSessionId()
    .then(info => {
      _sessionId = (info && info.sessionId) || null
      _appVersion = (info && info.appVersion) || null
      console.log('[papa] renderer session ' + _sessionId +
        ' (app ' + _appVersion + ', electron ' + ((info && info.electron) || '?') + ')' +
        ' — main stamps the same id on every log line')
    })
    .catch(e => console.error('[papa] could not read the session id:', String(e && e.message || e)))

  document.getElementById('notice-badge')?.addEventListener('click', showNoticeHistory)

  // Local preferences that were being written and never read back.
  restoreSidebarPrefs()
  restoreStatsRange()
  restoreDiscoverDismissals()
  restoreHoverTrailerPref()
  restoreHideSeenPref()

  window.api.slskStatus().then(s => { slsk.status = s }).catch(() => {})
  // The rate is decided in one place; at startup nothing is known to be active
  // yet, so this starts slow and the first poll re-tunes it.
  retuneDownloadsPolling()

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
  // A failed scan returns an empty array, and `|| []` cannot tell that apart
  // from a genuinely empty folder — so this used to blank the library AND then
  // report "Library scan complete: 0 albums found" as if that were the answer.
  if (data && data.failed) {
    console.error('[papa] library scan failed:', data.error || '')
    showSnackbar('The library scan failed — nothing was changed. See the log for why.',
      '', function () {}, 8000)
    return
  }
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
  // This runs from 19 call sites via the rescan scheduler, so a transient scan
  // failure during any download used to blank the library on screen.
  if (data && data.failed) {
    console.error('[papa] background library sync failed; keeping what we have:', data.error || '')
    return
  }
  const fresh = data.albums || []
  const changed = _libSig(fresh) !== _libSig(state.library)
  if (!changed) return
  state.library = fresh
  setTimeout(fetchMissingArtwork, 600)
  syncLibraryExt()
  // A rescan landing while you are reading a page used to rebuild it under you
  // unconditionally. applyLibraryUpdate already knows how to do this properly:
  // it holds the update while a modal is open or a multi-selection is active,
  // replays it afterwards, and puts the scroll position back.
  applyLibraryUpdate({ albums: fresh, reason: 'backgroundSync' })
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
  // A failed scan returns an empty array, and [] is truthy — so without this a
  // scan error blanked the whole library in the UI while the cache on disk was
  // untouched, which looks exactly like losing the library.
  if (payload && payload.failed) {
    console.error('[papa] ignoring a library update from a failed scan:', payload.error || '')
    return
  }
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
// One retry per file per session. A file that fails twice is not transient, and
// retrying forever would loop on a genuinely broken file.
const _loadRetried = new Set()

async function handleLoadError(filePath, track) {
  const name = (track && track.title) || (filePath || '').split('/').pop() || 'That track'
  let verdict = { checked: false, exists: true, reason: 'not asked' }
  try {
    verdict = await window.api.trackExists(filePath)
  } catch (e) {
    console.error('[papa] could not check whether the file exists:', String(e && e.message || e))
  }

  const P = window.PapaLoadError
  const decision = P
    ? P.decide({ verdict, alreadyRetried: _loadRetried.has(filePath), queueLength: state.queue.length })
    // If the policy module failed to load, the safe default is the one that
    // cannot lose the user's queue.
    : { action: 'skip', reason: 'policy-module-missing' }
  console.error('[papa] load failed:', filePath, '->', decision.action, `(${decision.reason})`)

  if (decision.action === 'drop') {
    _loadRetried.delete(filePath)
    dropMissingTrack(filePath, track)
    return
  }

  if (decision.action === 'retry') {
    _loadRetried.add(filePath)
    showSnackbar(name + ' would not load — retrying')
    playCurrentTrack()
    return
  }

  // 'skip' and 'stop' both leave the queue exactly as it was: the track is not
  // missing, so removing it would be losing the user's data to work around a
  // playback problem.
  showSnackbar(name + ' would not play — skipped, but kept in the queue', '', function () {}, 6000)
  if (decision.action === 'skip') playNext()
  else {
    state.isPlaying = false
    updatePlayBtn()
  }
}

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
// Picks up where an unclean shutdown left off. restorePlaybackState already
// rebuilds the queue and seeks; this is that, plus actually playing.
async function resumeFromSavedState(saved) {
  await restorePlaybackState({ force: true })
  const pos = Number(saved && saved.position) || 0
  const idx = state.queue.findIndex(t => t.filePath === (saved && saved.filePath))
  if (idx < 0) {
    showSnackbar('That track is no longer in the library', '', function () {}, 5000)
    return
  }
  state.queueIndex = idx
  playCurrentTrack()
  if (pos > 1) audio.currentTime = pos
}

// opts.force is for the explicit "resume where you left off" card, where the
// user has asked for exactly this and the guards below would be wrong.
async function restorePlaybackState(opts) {
  opts = opts || {}
  const gen = _playbackIntent
  // Abandoned rather than merged: half-restoring over a queue the user built
  // would be worse than not restoring at all.
  const superseded = () => !opts.force && (_playbackIntent !== gen || state.isPlaying)
  if (!opts.force && (state.queue.length || state.isPlaying)) return

  const saved = await window.api.getPlaybackState()
  if (superseded()) return
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
    // This fires 500ms later on its own and used to seek whatever was loaded by
    // then -- including a track the user had just picked.
    setTimeout(function() {
      if (superseded()) return
      if (audio.src !== 'file://' + saved.filePath) return
      audio.currentTime = resumePos
    }, 500)
  }
  state.isPlaying = false
  updatePlayBtn()
  updateNowPlaying(state.queue[idx])
  updateTrackHighlight()
  updateLikeBtn()
  syncExtension()

  var queues = await window.api.getSavedQueues()
  if (superseded()) return
  var autoQueue = queues.find(function(q) { return q.id === '_auto' })
  if (autoQueue && autoQueue.tracks && autoQueue.tracks.length) {
    state.queue = autoQueue.tracks
    // Older saves were written with an unclamped index against a truncated
    // tracks[], so don't trust it even now that the writer clamps.
    state.queueIndex = Math.min(Math.max(0, autoQueue.index || 0), autoQueue.tracks.length - 1)
    state._restoredFromQueue = true
    if (state.queuePanelOpen) renderQueuePanel()
    // Say when the restored queue is not the queue that was saved. It used to
    // report the truncated count as though that were the whole thing.
    var _msg = 'Previous queue restored (' + autoQueue.tracks.length + ' tracks)'
    if (autoQueue.truncatedFrom) {
      _msg = 'Previous queue restored — first ' + autoQueue.tracks.length +
        ' of ' + autoQueue.truncatedFrom + ' tracks'
    }
    showSnackbar(_msg, 'Clear', function() {
      state.queue = []; state.queueIndex = -1
      if (state.queuePanelOpen) renderQueuePanel()
    }, autoQueue.truncatedFrom ? 8000 : 5000)
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────
const VIDEO_PAGES = new Set(['video', 'browse', 'person', 'video-detail', 'shelf', 'diary'])

function navigate(page, navId, opts = {}) {
  // Save scroll position of page we're leaving
  const contentEl = document.getElementById('content')
  if (contentEl && state.currentPage) {
    const _sk = `${state.currentPage}:${_currentNavId() ?? ''}`
    _scrollMemory.delete(_sk)          // re-insert, so this key is newest
    _scrollMemory.set(_sk, contentEl.scrollTop)
    while (_scrollMemory.size > SCROLL_MEMORY_CAP) {
      _scrollMemory.delete(_scrollMemory.keys().next().value)
    }
  }
  if (!opts.skipHistory) {
    // The first navigate() of the session has no page to come back to, and
    // pushing that empty entry left Back permanently enabled (and a second
    // press navigating to an undefined page, which renders nothing).
    if (state.currentPage) _pushNavHistory({ page: state.currentPage, navId: _currentNavId() })
    navFuture.length = 0
  }

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page)
  })

  state.currentPage        = page
  // The music bar has no business on the video pages: it is the wrong medium,
  // and it sat across the bottom of the episode list. Driven by which page is
  // open rather than by whether a video is playing, so it is gone the moment
  // Movies is opened and not only once something starts.
  document.body.classList.toggle('video-page', VIDEO_PAGES.has(page))
  state.currentAlbumId     = page === 'album'  ? navId : null
  state.currentArtistName  = page === 'artist' ? navId : ''
  state.currentSearchQuery = page === 'search' ? navId : ''
  state.currentPlaylistId  = page === 'playlist' ? navId : null
  if (page !== 'playlist') state._plSearch = ''

  // Wrapped so one bad record cannot leave the app on a blank page with no way
  // back. Everything above -- nav highlight, history, state.currentPage -- has
  // already been applied, so the shell stays consistent either way.
  try {
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
  else if (page === 'video')       renderVideo()
  else if (page === 'browse')      renderBrowse()
  else if (page === 'person')      renderPerson(navId)
  else if (page === 'video-detail') renderVideoDetail(navId)
  else if (page === 'shelf')        renderShelf(navId)
  else if (page === 'diary')        renderDiary(navId)
  } catch (err) {
    _renderFailure(page, err)
  }

  if (page !== 'downloads') _dlLastSig = ''
  retuneDownloadsPolling()

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
  // Forward is capped for the same reason, and it is cleared on any new
  // navigation anyway, so it only grows while someone holds Back down.
  navFuture.push({ page: state.currentPage, navId: _currentNavId() })
  if (navFuture.length > NAV_HISTORY_CAP) navFuture.shift()
  const prev = navHistory.pop()
  navigate(prev.page, prev.navId, { skipHistory: true, restoreScroll: true })
}

function navigateForward() {
  if (!navFuture.length) return
  _pushNavHistory({ page: state.currentPage, navId: _currentNavId() })
  const next = navFuture.pop()
  navigate(next.page, next.navId, { skipHistory: true, restoreScroll: true })
}

function updateNavBtns() {
  const back = document.getElementById('tb-back')
  const fwd  = document.getElementById('tb-fwd')
  if (back) back.disabled = navHistory.length === 0
  if (fwd)  fwd.disabled  = navFuture.length  === 0
}

// ── Papa Video: Movies / TV / Anime ──────────────────────────────────────────
var _videoDetailTicket = 0
var _videoCatalogTicket = 0
var _videoSearchTicket = 0
// Bumped on every season/episode change so a slow response for the season the
// user just left cannot overwrite the one they are now looking at.
var _videoSeasonTicket = 0
var _videoDetail = null
var _videoState = { season: null, episode: 1, sub: true }
var _videoStreams = []
var _videoUiReady = false

// ── Keyboard: browsing ──────────────────────────────────────────────────────
// The theatre owns the keyboard while it is open (see video-player.js). This
// handles the browsing surfaces, where the useful actions are different: focus
// the search box, move across the grid, open what is focused.
//
// Bound once, on document, and inert unless a video page is showing — the same
// discipline the player handler needed after playback shortcuts started
// swallowing characters typed into the app's search box.
var _videoKeysBound = false

function _bindBrowseKeys() {
  if (_videoKeysBound) return
  _videoKeysBound = true
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const page = state.currentPage
    if (page !== 'video' && page !== 'browse' && page !== 'person' && page !== 'video-detail' && page !== 'diary') return
    // The theatre is modal; while it is open its own keys apply.
    const theatre = document.getElementById('vtheatre')
    if (theatre && !theatre.classList.contains('hidden')) return

    const tag = String(e.target && e.target.tagName || '').toUpperCase()
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      (e.target && e.target.isContentEditable === true)

    if (typing) {
      // Escape gets you out of the search box without reaching for the mouse.
      if (e.key === 'Escape') { e.target.blur(); e.preventDefault() }
      return
    }

    if (e.key === '/') {
      const input = document.getElementById('video-search-input')
      if (input) { input.focus(); input.select?.(); e.preventDefault() }
      return
    }
    if (e.key === 'b' || e.key === 'B') {
      if (page !== 'browse') { _videoTab = 'browse'; navigate('browse'); e.preventDefault() }
      return
    }
    if (e.key === 'Enter') {
      const el = document.activeElement
      if (el && el.classList && el.classList.contains('vcard')) { el.click(); e.preventDefault() }
      return
    }
    if (e.key.startsWith('Arrow')) _moveCardFocus(e)
  })
}

// Grid-aware arrow movement. Left and right step through the cards in order;
// up and down move by a row, worked out from the cards' own positions rather
// than assumed, because the grid is responsive and the column count changes
// with the window.
function _moveCardFocus(e) {
  const cards = Array.prototype.slice.call(document.querySelectorAll('.vcard'))
  if (!cards.length) return
  const active = document.activeElement
  let index = cards.indexOf(active)

  if (index === -1) {
    // Nothing focused yet: the first arrow press enters the grid.
    cards[0].focus()
    e.preventDefault()
    return
  }

  let next = index
  if (e.key === 'ArrowRight') next = Math.min(cards.length - 1, index + 1)
  else if (e.key === 'ArrowLeft') next = Math.max(0, index - 1)
  else {
    // Column count from the first row: every card sharing the first card's
    // top offset is on row one.
    const firstTop = cards[0].getBoundingClientRect().top
    let perRow = cards.findIndex(function (c) { return c.getBoundingClientRect().top > firstTop + 4 })
    if (perRow <= 0) perRow = cards.length
    next = e.key === 'ArrowDown'
      ? Math.min(cards.length - 1, index + perRow)
      : Math.max(0, index - perRow)
  }
  if (next !== index) {
    cards[next].focus()
    cards[next].scrollIntoView({ block: 'nearest' })
  }
  e.preventDefault()
}

// ── Person page ─────────────────────────────────────────────────────────────
// Reachable from any cast photo or crew name. TMDB gives a combined credit
// list; the catalog already de-duplicates it and sorts newest first, because
// one person is frequently writer and director on the same title.
var _personTicket = 0

async function renderPerson(personId) {
  _initVideoUI()
  const ticket = ++_personTicket
  if (!personId) return navigate('video')

  setContent('<div class="page vpage cinema">' +
    '<div class="vperson-head">' +
      '<div class="vskel vperson-photo"></div>' +
      '<div><div class="vskel vskel-line" style="width:220px;height:22px"></div>' +
      '<div class="vskel vskel-line short" style="margin-top:8px"></div></div>' +
    '</div>' +
    '<div class="vrows" id="vperson-rows"></div>' +
  '</div>')

  const res = await window.api.videoPerson({ id: personId })
    .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  if (_personTicket !== ticket || state.currentPage !== 'person') return

  const rows = document.getElementById('vperson-rows')
  if (!res.ok) {
    if (rows) rows.innerHTML = '<div class="vrow-msg err">' + esc(_videoErrorText(res.error)) + '</div>'
    return
  }
  const credits = Array.isArray(res.credits) ? res.credits : []

  // The person's own details are not a separate request: everything needed to
  // head the page is already on the credit that led here.
  const head = document.querySelector('.vperson-head')
  const name = _personName(personId)
  if (head) {
    head.innerHTML =
      (name.photo
        ? '<img class="vperson-photo" src="' + esc(name.photo) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="vperson-photo vcast-photo-fallback">' + esc(String(name.name || '?').charAt(0)) + '</div>') +
      '<div><div class="vperson-name">' + esc(name.name || 'Filmography') + '</div>' +
      '<div class="vperson-role">' + credits.length + ' credit' + (credits.length === 1 ? '' : 's') + '</div></div>'
  }

  if (!credits.length) {
    if (rows) rows.innerHTML = '<div class="vempty"><div class="vempty-title">No credits found</div></div>'
    return
  }

  // Split by type, because a director's films and their television work are
  // different things a viewer is looking for.
  const films = credits.filter(function (c) { return c.type === 'movie' })
  const series = credits.filter(function (c) { return c.type === 'tv' })

  // A filmography is the one place where the order is the question. TMDB
  // returns credits in its own order, which is neither chronological nor
  // ranked; the plan asks for ranked, so the control offers both and defaults
  // to newest, which is what someone looking up a director expects to see.
  _person = { films: films, series: series, sort: 'newest' }
  _paintPersonRows()
}

var _person = { films: [], series: [], sort: 'newest' }

function _paintPersonRows() {
  const rows = document.getElementById('vperson-rows')
  if (!rows) return
  const films = _vSortItems(_person.films, _person.sort)
  const series = _vSortItems(_person.series, _person.sort)
  let html = '<div class="vperson-sort">' + _vSortControlHtml(_person.sort, 'vperson-sort-select') + '</div>'
  if (films.length) html += _vRowShell('person-movies', 'Films', films.length)
  if (series.length) html += _vRowShell('person-tv', 'Television', series.length)
  rows.innerHTML = html
  if (films.length) _fillRow('person-movies', films)
  if (series.length) _fillRow('person-tv', series)
  // Re-bound on every paint because innerHTML above discarded the old control.
  document.getElementById('vperson-sort-select')?.addEventListener('change', function () {
    _person.sort = this.value || ''
    _paintPersonRows()
  })
}

// The name and photo of the person just clicked. Carried across navigation
// rather than refetched: the credit that linked here already had both.
var _lastPerson = {}
function _personName(id) {
  return _lastPerson && String(_lastPerson.id) === String(id) ? _lastPerson : {}
}

// ── Browse ──────────────────────────────────────────────────────────────────
// The filter state is one plain object so it can be serialised into the nav id
// and compared cheaply. `genres` holds included ids; `exclude` holds the ones
// clicked a second time.
function _emptyFilters() {
  return {
    catalog: 'movie',
    genres: [], exclude: [], tags: [],
    yearFrom: null, yearTo: null,
    minRating: null, sort: 'popularity',
    runtimeFrom: null, runtimeTo: null,
    season: null, seasonYear: null, format: null, status: null,
    country: null,
  }
}

var _browse = {
  filters: _emptyFilters(),
  page: 1, results: [], total: 0, totalPages: 1,
  loading: false, ticket: 0, observer: null,
  // Genre names from a parsed query, awaiting the vocabulary that turns them
  // into the ids TMDB wants.
  pendingGenreNames: null,
}
var _browseVocab = { genres: {}, tags: null, countries: null }

// Presets worth shipping. "Hidden gems" is the one a streaming service could
// never offer: well rated but not widely voted on, which is precisely what
// their popularity-driven rows bury.
var _BROWSE_PRESETS = [
  { name: 'Hidden gems', filters: { minRating: 7.5, sort: 'rating' } },
  { name: 'Recent & great', filters: { minRating: 7, yearFrom: new Date().getFullYear() - 3, sort: 'rating' } },
  { name: 'Short films', filters: { runtimeTo: 90, sort: 'rating' }, catalog: 'movie' },
  { name: 'This season', filters: { seasonYear: new Date().getFullYear(), sort: 'popularity' }, catalog: 'anime' },
]

var _BROWSE_SORTS = [
  { key: 'popularity', label: 'Popular' },
  { key: 'rating', label: 'Top rated' },
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'title', label: 'A–Z' },
]
var _ANIME_FORMATS = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL']
var _ANIME_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
var _ANIME_STATUS = [
  { key: 'RELEASING', label: 'Airing' },
  { key: 'FINISHED', label: 'Finished' },
  { key: 'NOT_YET_RELEASED', label: 'Upcoming' },
]

// Only the filters that differ from empty, as removable chips.
function _activeFilterChips(f) {
  const out = []
  const genreName = id => {
    const list = _browseVocab.genres[f.catalog] || []
    const hit = list.find(g => String(g.id) === String(id))
    return hit ? hit.name : String(id)
  }
  for (const id of f.genres) out.push({ key: 'genre:' + id, label: genreName(id) })
  for (const id of f.exclude) out.push({ key: 'exclude:' + id, label: 'not ' + genreName(id) })
  for (const t of f.tags) out.push({ key: 'tag:' + t, label: t })
  if (f.yearFrom || f.yearTo) {
    out.push({ key: 'years', label: (f.yearFrom || '…') + '–' + (f.yearTo || '…') })
  }
  if (f.minRating) out.push({ key: 'rating', label: '★ ' + f.minRating + '+' })
  if (f.country) {
    const list = _browseVocab.countries || []
    const hit = list.find(function (c) { return c.code === f.country })
    out.push({ key: 'country', label: hit ? hit.name : f.country })
  }
  if (f.runtimeFrom || f.runtimeTo) {
    out.push({ key: 'runtime', label: (f.runtimeFrom || 0) + '–' + (f.runtimeTo || '…') + ' min' })
  }
  if (f.season) out.push({ key: 'season', label: f.season[0] + f.season.slice(1).toLowerCase() })
  if (f.seasonYear) out.push({ key: 'seasonYear', label: String(f.seasonYear) })
  if (f.format) out.push({ key: 'format', label: f.format })
  if (f.status) {
    const hit = _ANIME_STATUS.find(x => x.key === f.status)
    out.push({ key: 'status', label: hit ? hit.label : f.status })
  }
  return out
}

function _clearFilterKey(f, key) {
  const [kind, value] = String(key).split(':')
  if (kind === 'genre') f.genres = f.genres.filter(g => String(g) !== value)
  else if (kind === 'exclude') f.exclude = f.exclude.filter(g => String(g) !== value)
  else if (kind === 'tag') f.tags = f.tags.filter(t => t !== value)
  else if (kind === 'years') { f.yearFrom = null; f.yearTo = null }
  else if (kind === 'rating') f.minRating = null
  else if (kind === 'runtime') { f.runtimeFrom = null; f.runtimeTo = null }
  else if (kind === 'season') f.season = null
  else if (kind === 'seasonYear') f.seasonYear = null
  else if (kind === 'format') f.format = null
  else if (kind === 'status') f.status = null
  else if (kind === 'country') f.country = null
}

// The request the backend expects, with the anime vocabulary swapped in for
// the anime catalog. Genres are ids for TMDB and names for AniList, which the
// vocab endpoint already unified.
function _browseRequest(f, page) {
  const base = { catalog: f.catalog, page: page, sort: f.sort }
  if (f.catalog === 'anime') {
    return Object.assign(base, {
      genres: f.genres.slice(), tags: f.tags.slice(),
      minRating: f.minRating, seasonYear: f.seasonYear || f.yearFrom || null,
      season: f.season, formats: f.format ? [f.format] : [], status: f.status,
    })
  }
  return Object.assign(base, {
    genres: f.genres.slice(), excludeGenres: f.exclude.slice(),
    yearFrom: f.yearFrom, yearTo: f.yearTo, minRating: f.minRating,
    runtimeFrom: f.runtimeFrom, runtimeTo: f.runtimeTo,
    country: f.country,
  })
}

async function renderBrowse() {
  _initVideoUI()
  const ticket = ++_videoCatalogTicket
  setContent('<div class="page vpage cinema">' + _vHeadHtml() +
    '<div class="vbrowse">' +
      '<aside class="vfilters" id="vfilters" aria-label="Filters"></aside>' +
      '<section class="vresults">' +
        '<div class="vres-head"><div class="vres-count" id="vres-count">Loading…</div>' +
          _hideSeenToggleHtml('vbrowse-hide-seen') + '</div>' +
        '<div class="vactive" id="vactive"></div>' +
        '<div class="vgrid" id="vgrid"></div>' +
        '<div class="vgrid-more" id="vgrid-more"></div>' +
      '</section>' +
    '</div>' +
  '</div>')
  _bindVideoHead()
  document.getElementById('vbrowse-hide-seen')?.addEventListener('change', function () {
    setHideSeen(this.checked)
    _paintBrowseGrid()
  })
  // The filters may already be set — arriving from a genre chip, or coming
  // back to a query that was left mid-scroll.
  await _loadBrowseVocab(_browse.filters.catalog)
  _resolvePendingGenreNames()
  if (_videoCatalogTicket !== ticket) return
  _renderFilterRail()
  _runBrowse(true)
}

// Vocabularies are fetched once per catalog and cached in main for a week, so
// switching tabs back and forth costs nothing.
// Genre names to the ids TMDB's with_genres needs, using the vocabulary the
// filter rail already fetched. A name that is not in the vocabulary is dropped
// rather than passed through: an unknown genre id returns an empty grid, and an
// empty grid for a query that was mostly understood is worse than the same
// query without its genre.
function _resolvePendingGenreNames() {
  const names = _browse.pendingGenreNames
  _browse.pendingGenreNames = null
  if (!Array.isArray(names) || !names.length) return
  const vocab = _browseVocab.genres[_browse.filters.catalog] || []
  const ids = []
  const missed = []
  for (const name of names) {
    const want = String(name).toLowerCase()
    const hit = vocab.find(function (g) { return String(g.name || '').toLowerCase() === want })
    if (hit) ids.push(hit.id)
    else missed.push(name)
  }
  if (ids.length) _browse.filters.genres = ids
  if (missed.length) {
    // Said out loud, because the grid will not be the answer they asked for.
    showSnackbar('Could not filter by ' + missed.join(', '), null, null, 4000)
  }
}

async function _loadBrowseVocab(catalog) {
  if (!_browseVocab.genres[catalog]) {
    const res = await window.api.videoGenres({ catalog: catalog }).catch(function () { return { ok: false } })
    _browseVocab.genres[catalog] = (res && res.ok && res.genres) ? res.genres : []
  }
  if (catalog === 'anime' && !_browseVocab.tags) {
    const res = await window.api.videoTags().catch(function () { return { ok: false } })
    _browseVocab.tags = (res && res.ok && res.tags) ? res.tags : []
  }
  // Anime is filtered by AniList, which has no country of origin, so the list
  // is only fetched for the catalogs that can use it.
  if (catalog !== 'anime' && !_browseVocab.countries && window.api.videoCountries) {
    const res = await window.api.videoCountries().catch(function () { return { ok: false } })
    _browseVocab.countries = (res && res.ok && res.countries) ? res.countries : []
  }
}

function _renderFilterRail() {
  const rail = document.getElementById('vfilters')
  if (!rail) return
  const f = _browse.filters
  const anime = f.catalog === 'anime'
  const genres = _browseVocab.genres[f.catalog] || []
  const thisYear = new Date().getFullYear()

  const group = (label, body) =>
    '<div class="vf-group"><div class="vf-label">' + esc(label) + '</div>' + body + '</div>'

  const catalogChips = ['movie', 'tv', 'anime'].map(function (c) {
    const name = c === 'movie' ? 'Movies' : c === 'tv' ? 'TV' : 'Anime'
    return '<button class="vf-chip' + (f.catalog === c ? ' on' : '') + '" data-catalog="' + c + '">' + name + '</button>'
  }).join('')

  // A genre chip has three states: off, included, excluded. Clicking cycles.
  const genreChips = genres.map(function (g) {
    const inc = f.genres.some(x => String(x) === String(g.id))
    const exc = f.exclude.some(x => String(x) === String(g.id))
    return '<button class="vf-chip' + (inc ? ' on' : exc ? ' off' : '') + '"' +
      ' data-genre="' + esc(g.id) + '"' +
      ' aria-pressed="' + (inc || exc) + '"' +
      ' title="' + (inc ? 'Included — click to exclude' : exc ? 'Excluded — click to clear' : 'Click to include') + '">' +
      esc(g.name) + '</button>'
  }).join('')

  const presets = _BROWSE_PRESETS.filter(function (p) { return !p.catalog || p.catalog === f.catalog })
  const saved = _savedPresets()
  let html = group('Catalog', '<div class="vf-chips">' + catalogChips + '</div>')
  if (presets.length || saved.length) {
    html += group('Presets', '<div class="vf-chips">' +
      presets.map(function (p, i) {
        return '<button class="vf-chip" data-preset="' + i + '">' + esc(p.name) + '</button>'
      }).join('') +
      saved.map(function (p, i) {
        return '<button class="vf-chip" data-saved="' + i + '" title="Saved preset — right-click to delete">' + esc(p.name) + '</button>'
      }).join('') +
      '</div>')
  }
  html += group('Sort', '<select class="vf-select" id="vf-sort">' +
    _BROWSE_SORTS.map(function (o) {
      return '<option value="' + o.key + '"' + (f.sort === o.key ? ' selected' : '') + '>' + o.label + '</option>'
    }).join('') + '</select>')
  html += group(genres.length ? 'Genres' : 'Genres (unavailable)', '<div class="vf-chips">' + genreChips + '</div>')

  html += group('Minimum rating',
    '<input class="vf-range" id="vf-rating" type="range" min="0" max="9" step="0.5" value="' + (f.minRating || 0) + '">' +
    '<div class="vf-value" id="vf-rating-value">' + (f.minRating ? '★ ' + f.minRating + ' and above' : 'Any') + '</div>')

  if (anime) {
    html += group('Season', '<div class="vf-row">' +
      '<select class="vf-select" id="vf-season">' +
        '<option value="">Any</option>' +
        _ANIME_SEASONS.map(function (x) {
          return '<option value="' + x + '"' + (f.season === x ? ' selected' : '') + '>' + x[0] + x.slice(1).toLowerCase() + '</option>'
        }).join('') + '</select>' +
      '<input class="vf-input" id="vf-seasonyear" type="number" placeholder="Year" min="1940" max="' + (thisYear + 2) + '" value="' + (f.seasonYear || '') + '">' +
    '</div>')
    html += group('Format', '<div class="vf-chips">' + _ANIME_FORMATS.map(function (x) {
      return '<button class="vf-chip' + (f.format === x ? ' on' : '') + '" data-format="' + x + '">' + x + '</button>'
    }).join('') + '</div>')
    html += group('Status', '<div class="vf-chips">' + _ANIME_STATUS.map(function (x) {
      return '<button class="vf-chip' + (f.status === x.key ? ' on' : '') + '" data-status="' + x.key + '">' + x.label + '</button>'
    }).join('') + '</div>')
    // 361 tags, grouped and searchable. A flat list would be unusable, and no
    // streaming service offers this vocabulary at all.
    html += group('Themes', '<input class="vf-input vf-tagsearch" id="vf-tagsearch" type="search" placeholder="Search themes…">' +
      '<div class="vf-tags-scroll" id="vf-tags">' + _tagChipsHtml('') + '</div>')
  } else {
    // 251 countries, so this is a search rather than a wall of chips. The
    // handful of major film-producing countries are offered without typing,
    // because someone who wants Iranian cinema should not have to know that
    // Iran is in the list before they can find out.
    html += group('Country',
      '<input class="vf-input vf-tagsearch" id="vf-countrysearch" type="search" placeholder="Search countries…">' +
      '<div class="vf-tags-scroll" id="vf-countries">' + _countryChipsHtml('') + '</div>')
    html += group('Year', '<div class="vf-row">' +
      '<input class="vf-input" id="vf-yearfrom" type="number" placeholder="From" min="1900" max="' + (thisYear + 2) + '" value="' + (f.yearFrom || '') + '">' +
      '<span class="vf-sep">–</span>' +
      '<input class="vf-input" id="vf-yearto" type="number" placeholder="To" min="1900" max="' + (thisYear + 2) + '" value="' + (f.yearTo || '') + '">' +
    '</div>')
    if (f.catalog === 'movie') {
      html += group('Runtime (minutes)', '<div class="vf-row">' +
        '<input class="vf-input" id="vf-runfrom" type="number" placeholder="Min" min="0" max="600" value="' + (f.runtimeFrom || '') + '">' +
        '<span class="vf-sep">–</span>' +
        '<input class="vf-input" id="vf-runto" type="number" placeholder="Max" min="0" max="600" value="' + (f.runtimeTo || '') + '">' +
      '</div>')
    }
  }

  html += '<button class="vf-clear" id="vf-save" style="margin-bottom:6px">Save this filter set</button>'
  html += '<button class="vf-clear" id="vf-clear">Clear all filters</button>'
  rail.innerHTML = html
  _bindFilterRail()
}

// Shown before anyone types: the countries with catalogues deep enough that
// choosing one returns a shelf rather than a handful. Everything else is one
// search away.
var _COUNTRY_SHORTLIST = ['US', 'GB', 'FR', 'IT', 'JP', 'KR', 'IN', 'IR', 'CN', 'HK',
  'TW', 'DE', 'ES', 'SE', 'DK', 'RU', 'MX', 'BR', 'AR', 'PL', 'TR', 'TH', 'AU', 'CA']

function _countryChipsHtml(query) {
  const all = _browseVocab.countries
  if (!all) return '<div class="vf-value">Loading countries…</div>'
  const q = String(query || '').trim().toLowerCase()
  const chosen = _browse.filters.country
  let list
  if (q) {
    list = all.filter(function (c) { return c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q })
  } else {
    const rank = {}
    _COUNTRY_SHORTLIST.forEach(function (c, i) { rank[c] = i })
    list = all.filter(function (c) { return rank[c.code] !== undefined })
      .sort(function (a, b) { return rank[a.code] - rank[b.code] })
    // A country already chosen stays visible even when it is not on the
    // shortlist, or clearing it means finding it again first.
    if (chosen && !rank[chosen]) {
      const c = all.find(function (x) { return x.code === chosen })
      if (c) list = [c].concat(list)
    }
  }
  if (!list.length) return '<div class="vf-value">No countries match</div>'
  return '<div class="vf-chips">' + list.map(function (c) {
    return '<button class="vf-chip' + (chosen === c.code ? ' on' : '') + '" data-country="' + esc(c.code) + '">' +
      esc(c.name) + '</button>'
  }).join('') + '</div>'
}

function _tagChipsHtml(query) {
  const groups = _browseVocab.tags || []
  const q = String(query || '').trim().toLowerCase()
  const f = _browse.filters
  let out = ''
  for (const g of groups) {
    const tags = q ? g.tags.filter(t => t.toLowerCase().includes(q)) : g.tags
    if (!tags.length) continue
    out += '<div class="vf-tagcat"><div class="vf-tagcat-name">' + esc(g.category) + '</div><div class="vf-chips">' +
      tags.map(function (t) {
        return '<button class="vf-chip' + (f.tags.indexOf(t) !== -1 ? ' on' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + '</button>'
      }).join('') + '</div></div>'
  }
  return out || '<div class="vf-value">No themes match</div>'
}

function _bindFilterRail() {
  const f = _browse.filters
  const rerun = function (rebuild) {
    if (rebuild) _renderFilterRail()
    _runBrowse(true)
  }

  document.querySelectorAll('[data-catalog]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (f.catalog === b.dataset.catalog) return
      // Genre ids are per catalog and the anime vocabulary is different
      // entirely, so those are dropped; the numeric filters carry over,
      // because "rated 7+, since 2015" means the same thing everywhere.
      f.catalog = b.dataset.catalog
      f.genres = []; f.exclude = []; f.tags = []
      f.season = null; f.seasonYear = null; f.format = null; f.status = null
      await _loadBrowseVocab(f.catalog)
      rerun(true)
    })
  })

  // Off → included → excluded → off.
  document.querySelectorAll('[data-genre]').forEach(function (b) {
    b.addEventListener('click', function () {
      const id = b.dataset.genre
      const inc = f.genres.some(x => String(x) === id)
      const exc = f.exclude.some(x => String(x) === id)
      f.genres = f.genres.filter(x => String(x) !== id)
      f.exclude = f.exclude.filter(x => String(x) !== id)
      // AniList genres are names, TMDB's are numeric ids.
      const value = f.catalog === 'anime' ? id : Number(id)
      if (!inc && !exc) f.genres.push(value)
      else if (inc && f.catalog !== 'anime') f.exclude.push(value)
      rerun(true)
    })
  })

  document.querySelectorAll('[data-format]').forEach(function (b) {
    b.addEventListener('click', function () {
      f.format = f.format === b.dataset.format ? null : b.dataset.format
      rerun(true)
    })
  })
  document.querySelectorAll('[data-status]').forEach(function (b) {
    b.addEventListener('click', function () {
      f.status = f.status === b.dataset.status ? null : b.dataset.status
      rerun(true)
    })
  })
  document.getElementById('vf-tags')?.addEventListener('click', function (e) {
    const b = e.target.closest('[data-tag]')
    if (!b) return
    const t = b.dataset.tag
    const i = f.tags.indexOf(t)
    if (i === -1) f.tags.push(t); else f.tags.splice(i, 1)
    b.classList.toggle('on', i === -1)
    _runBrowse(true)
  })
  // Filtering the tag list must not re-render the rail, or the search box
  // would lose focus on every keystroke.
  document.getElementById('vf-tagsearch')?.addEventListener('input', function (e) {
    const box = document.getElementById('vf-tags')
    if (box) box.innerHTML = _tagChipsHtml(e.target.value)
  })

  document.getElementById('vf-countries')?.addEventListener('click', function (e) {
    const b = e.target.closest('[data-country]')
    if (!b) return
    // One country at a time: the catalogue's origin filter is an AND, so
    // picking two would ask for films made in both and return almost nothing.
    // Clicking the chosen one again clears it.
    const code = b.dataset.country
    f.country = f.country === code ? null : code
    const box = document.getElementById('vf-countries')
    const search = document.getElementById('vf-countrysearch')
    if (box) box.innerHTML = _countryChipsHtml(search ? search.value : '')
    _runBrowse(true)
  })
  // Filtering the list must not re-render the rail, or the search box would
  // lose focus on every keystroke.
  document.getElementById('vf-countrysearch')?.addEventListener('input', function (e) {
    const box = document.getElementById('vf-countries')
    if (box) box.innerHTML = _countryChipsHtml(e.target.value)
  })

  document.getElementById('vf-sort')?.addEventListener('change', function (e) {
    f.sort = e.target.value
    _runBrowse(true)
  })

  const rating = document.getElementById('vf-rating')
  rating?.addEventListener('input', function (e) {
    const v = Number(e.target.value)
    f.minRating = v > 0 ? v : null
    const out = document.getElementById('vf-rating-value')
    if (out) out.textContent = f.minRating ? '★ ' + f.minRating + ' and above' : 'Any'
  })
  rating?.addEventListener('change', function () { _runBrowse(true) })

  // Numbers commit on change rather than input: re-querying on every digit of
  // "2015" would fire four times, three of them for nonsense years.
  const num = function (id, apply) {
    const el = document.getElementById(id)
    el?.addEventListener('change', function (e) {
      const v = e.target.value === '' ? null : Number(e.target.value)
      apply(Number.isFinite(v) ? v : null)
      _runBrowse(true)
    })
  }
  num('vf-yearfrom', v => { f.yearFrom = v })
  num('vf-yearto', v => { f.yearTo = v })
  num('vf-runfrom', v => { f.runtimeFrom = v })
  num('vf-runto', v => { f.runtimeTo = v })
  num('vf-seasonyear', v => { f.seasonYear = v })
  document.getElementById('vf-season')?.addEventListener('change', function (e) {
    f.season = e.target.value || null
    _runBrowse(true)
  })

  document.querySelectorAll('[data-preset]').forEach(function (b) {
    b.addEventListener('click', function () {
      const p = _BROWSE_PRESETS.filter(function (x) { return !x.catalog || x.catalog === f.catalog })[Number(b.dataset.preset)]
      if (!p) return
      const catalog = f.catalog
      _browse.filters = Object.assign(_emptyFilters(), { catalog: catalog }, p.filters)
      rerun(true)
    })
  })
  document.querySelectorAll('[data-saved]').forEach(function (b) {
    b.addEventListener('click', function () {
      const p = _savedPresets()[Number(b.dataset.saved)]
      if (!p) return
      _browse.filters = Object.assign(_emptyFilters(), p.filters)
      rerun(true)
    })
    // Right-click deletes, so a saved set is removable without a separate
    // management screen.
    b.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      const list = _savedPresets()
      const p = list[Number(b.dataset.saved)]
      if (!p) return
      list.splice(Number(b.dataset.saved), 1)
      _writePresets(list)
      showToast('Removed “' + p.name + '”')
      _renderFilterRail()
    })
  })

  document.getElementById('vf-save')?.addEventListener('click', function () {
    const chips = _activeFilterChips(f)
    if (!chips.length) return showToast('Set some filters first')
    const name = chips.slice(0, 3).map(function (c) { return c.label }).join(' · ')
    const list = _savedPresets()
    if (list.some(function (p) { return p.name === name })) return showToast('Already saved')
    list.unshift({ name: name, filters: JSON.parse(JSON.stringify(f)) })
    _writePresets(list.slice(0, 12))
    showToast('Saved “' + name + '”')
    _renderFilterRail()
  })

  document.getElementById('vf-clear')?.addEventListener('click', function () {
    const catalog = f.catalog
    _browse.filters = _emptyFilters()
    _browse.filters.catalog = catalog
    rerun(true)
  })
}

// Saved filter sets. Kept in the same validated localStorage reader the rest
// of the renderer uses, so a corrupt value degrades to none rather than
// throwing on every render of the rail.
function _savedPresets() {
  try {
    const list = window.PapaLocal && window.PapaLocal.readArray
      ? window.PapaLocal.readArray('papaVideoPresets', function (p) { return p && p.name && p.filters })
      : []
    return Array.isArray(list) ? list : []
  } catch (_) { return [] }
}

function _writePresets(list) {
  try {
    if (window.PapaLocal && window.PapaLocal.write) window.PapaLocal.write('papaVideoPresets', list)
  } catch (_) { /* a full store must not break browsing */ }
}

// Debounced and ticketed: a filter change mid-request must never render the
// previous query's results.
var _browseTimer = null
function _runBrowse(reset) {
  clearTimeout(_browseTimer)
  _browseTimer = setTimeout(function () { _fetchBrowse(reset) }, 350)
  if (reset) _paintActiveFilters()
}

async function _fetchBrowse(reset) {
  const ticket = ++_browse.ticket
  if (reset) { _browse.page = 1; _browse.results = [] }
  _browse.loading = true

  const grid = document.getElementById('vgrid')
  const more = document.getElementById('vgrid-more')
  const count = document.getElementById('vres-count')
  if (reset && grid) grid.innerHTML = _vGridSkeleton()
  if (more) more.textContent = ''
  if (reset && count) count.textContent = 'Searching…'

  const res = await window.api.videoDiscover(_browseRequest(_browse.filters, _browse.page))
    .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  if (_browse.ticket !== ticket || state.currentPage !== 'browse') return
  _browse.loading = false

  if (!res.ok) {
    if (grid) grid.innerHTML = ''
    if (count) count.innerHTML = ''
    if (more) more.innerHTML = '<div class="vrow-msg err">' + esc(_videoErrorText(res.error)) + '</div>'
    return
  }

  _browse.total = res.totalResults || 0
  _browse.totalPages = res.totalPages || 1
  _browse.results = _browse.results.concat(res.results || [])

  if (count) {
    count.innerHTML = _browse.total
      ? '<b>' + _browse.total.toLocaleString() + '</b> ' + (_browse.total === 1 ? 'title' : 'titles')
      : ''
  }

  if (!_browse.results.length) {
    if (grid) grid.innerHTML = ''
    if (more) more.innerHTML = _browseEmptyHtml()
    _bindBrowseEmpty()
    return
  }

  _paintBrowseGrid()
  _armBrowseObserver()
}

// Extracted so the hide-what-I-have-seen toggle can repaint without refetching:
// what you have watched is not part of the query, and asking TMDB again for the
// same page to apply a local filter would be a request for nothing.
function _paintBrowseGrid() {
  const grid = document.getElementById('vgrid')
  if (!grid) return
  const vis = _hideSeenApply(_browse.results)
  grid.innerHTML = _hideSeenNote(vis.hidden) + vis.shown.map(_videoCard).join('')
  _bindVideoCards(grid)
}

function _vGridSkeleton() {
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += '<div><div class="vskel vskel-card"></div><div class="vskel vskel-line"></div><div class="vskel vskel-line short"></div></div>'
  }
  return out
}

// An empty result is almost always one filter set too tight. Naming the likely
// culprit is the difference between a dead end and an obvious next move.
function _browseEmptyHtml() {
  const f = _browse.filters
  let culprit = null
  if (f.minRating && f.minRating >= 8) culprit = { key: 'rating', text: 'a rating of ' + f.minRating + ' and above is very high' }
  else if (f.tags.length > 2) culprit = { key: 'tags', text: 'combining ' + f.tags.length + ' themes narrows this a lot' }
  else if (f.genres.length > 2) culprit = { key: 'genres', text: 'a title has to match all ' + f.genres.length + ' genres' }
  else if (f.yearFrom && f.yearTo && f.yearTo - f.yearFrom < 3) culprit = { key: 'years', text: 'that year range is narrow' }
  else if (f.minRating) culprit = { key: 'rating', text: 'the rating filter may be too high' }

  return '<div class="vempty">' +
    '<div class="vempty-icon">◍</div>' +
    '<div class="vempty-title">Nothing matches all of that</div>' +
    '<div class="vempty-text">' +
      (culprit ? esc(culprit.text[0].toUpperCase() + culprit.text.slice(1)) + '.' : 'Try removing a filter or two.') +
    '</div>' +
    (culprit ? '<button class="vbtn vbtn-primary" id="vempty-relax" data-relax="' + culprit.key + '">Remove that filter</button> ' : '') +
    '<button class="vbtn" id="vempty-clear">Clear all filters</button>' +
  '</div>'
}

function _bindBrowseEmpty() {
  document.getElementById('vempty-relax')?.addEventListener('click', function (e) {
    const f = _browse.filters
    const key = e.currentTarget.dataset.relax
    if (key === 'rating') f.minRating = null
    else if (key === 'tags') f.tags = []
    else if (key === 'genres') f.genres = []
    else if (key === 'years') { f.yearFrom = null; f.yearTo = null }
    _renderFilterRail()
    _runBrowse(true)
  })
  document.getElementById('vempty-clear')?.addEventListener('click', function () {
    const catalog = _browse.filters.catalog
    _browse.filters = _emptyFilters()
    _browse.filters.catalog = catalog
    _renderFilterRail()
    _runBrowse(true)
  })
}

function _paintActiveFilters() {
  const box = document.getElementById('vactive')
  if (!box) return
  const chips = _activeFilterChips(_browse.filters)
  box.innerHTML = chips.map(function (c) {
    return '<span class="vactive-chip">' + esc(c.label) +
      '<button data-drop="' + esc(c.key) + '" aria-label="Remove ' + esc(c.label) + '">&#10005;</button></span>'
  }).join('')
  box.querySelectorAll('[data-drop]').forEach(function (b) {
    b.addEventListener('click', function () {
      _clearFilterKey(_browse.filters, b.dataset.drop)
      _renderFilterRail()
      _runBrowse(true)
    })
  })
}

// Infinite scroll. The sentinel is re-observed after every page because the
// grid is re-rendered wholesale.
function _armBrowseObserver() {
  const more = document.getElementById('vgrid-more')
  if (!more) return
  if (_browse.observer) { _browse.observer.disconnect(); _browse.observer = null }
  if (_browse.page >= _browse.totalPages) {
    more.textContent = _browse.results.length ? 'That is everything' : ''
    return
  }
  more.textContent = 'Loading more…'
  if (typeof IntersectionObserver !== 'function') return
  _browse.observer = new IntersectionObserver(function (entries) {
    if (!entries.some(e => e.isIntersecting) || _browse.loading) return
    if (_browse.page >= _browse.totalPages) return
    _browse.page++
    _fetchBrowse(false)
  }, { rootMargin: '600px' })
  _browse.observer.observe(more)
}

// The shelves the catalogue serves directly, and every one of them is
// requested — a row the backend can serve but nothing asks for is dead code
// that looks like a feature.
//
// The film "popular" row is gone, backend case included: it returned nearly the
// same titles as Trending, so the page repeated itself while appearing to offer
// variety. Its place is taken by the curated shelves below.
var _videoRows = [
  { key: 'trending-movies', label: 'Trending Movies',  tabs: ['all', 'movie'] },
  { key: 'trending-tv',     label: 'Trending TV',      tabs: ['all', 'tv'] },
  // Television keeps its second row. Only the film tabs gain curated shelves,
  // so dropping this one would leave TV with a single row.
  { key: 'popular-tv',      label: 'Popular TV',       tabs: ['tv'] },
  { key: 'trending-anime',  label: 'Trending Anime',   tabs: ['all', 'anime'] },
  { key: 'popular-anime',   label: 'Popular Anime',    tabs: ['anime'] },
  { key: 'season-anime',    label: 'This Season',      tabs: ['anime'] },
]

// The curated shelves, which is where cinema older than this year finally
// reaches the page. Each is a query in catalog/shelves.js; the label and the
// line underneath come back with the results, so the copy lives with the query
// that justifies it rather than being restated here.
//
// Decades rotate rather than all appearing at once: eight decade rows would
// bury everything else, and a home page that shows you the same eight rows
// forever stops being worth opening.
function _curatedRows(tab) {
  if (tab !== 'all' && tab !== 'movie') return []
  const decades = [1950, 1960, 1970, 1980, 1990, 2000, 2010]
  // Stable within a day, different tomorrow: discovery should feel like the
  // page has been arranged for today, not generated afresh on every render.
  const day = Math.floor(Date.now() / 86400000)
  const decade = decades[day % decades.length]
  const movements = ['french-new-wave', 'new-hollywood', 'italian-neorealism', 'japanese-golden-age']
  const themes = ['neo-noir', 'heist', 'coming-of-age', 'unreliable-narrator']
  // Iran, Taiwan and Argentina belong here as much as France does; the reason
  // they were missing is that the vote floor was set for Hollywood.
  const countries = ['IR', 'KR', 'JP', 'TW', 'FR', 'IT', 'AR', 'HK']
  const studios = [41077, 10342, 3]
  return [
    { key: 'canon' },
    // Resolved server-side from a rotating name, so the renderer does not hold
    // a person id either.
    { key: 'director-of-the-day' },
    { key: 'world-cinema' },
    { key: 'decade-' + decade },
    { key: 'movement-' + movements[day % movements.length] },
    { key: 'hidden-gems' },
    { key: 'theme-' + themes[day % themes.length] },
    { key: 'country-' + countries[day % countries.length] },
    { key: 'studio-' + studios[day % studios.length] },
    { key: 'runtime-under-90' },
  ]
}

var _videoTabs = [
  { key: 'all',   label: 'All' },
  { key: 'movie', label: 'Movies' },
  { key: 'tv',    label: 'TV' },
  { key: 'anime', label: 'Anime' },
  { key: 'browse', label: 'Browse' },
  { key: 'diary', label: 'Diary' },
  { key: 'list',  label: 'My List' },
]

var _videoTab = 'all'
var _videoHero = { items: [], index: 0, timer: null }

// The watch store lands with the engine work. Until it does, every call has to
// degrade to "nothing saved" rather than throwing — Continue Watching and My
// List simply do not appear.
function _vStore() {
  return (typeof window !== 'undefined' && window.PapaVideoStore) || null
}
function _vFmt() {
  return (typeof window !== 'undefined' && window.PapaVideoFormat) || null
}

// SVG is inlined rather than loaded, matching the rest of the renderer.
var _VICON = {
  play:   '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  plus:   '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
  check:  '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  info:   '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/></svg>',
  left:   '<svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>',
  right:  '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>',
}

// Binds the theatre chrome and the one shared video-event channel
// subscription. Idempotent: the panel lives in index.html and outlives every
// page, so this must not double-subscribe on each navigation.
// The theatre replaces the old corner panel. Bound once: the markup lives in
// index.html and outlives every page, so this must not re-subscribe per render.
var _player = null

// What is currently playing, for the watch store. Set when the theatre opens
// and cleared when it closes, so a state tick after a stop cannot write a
// position against the previous title.
var _watch = { key: null, meta: null, savedAt: 0, resumed: false }

// Cards are enriched only when they reach the screen. Everything about this is
// about not spending twenty requests on a shelf the user scrolls straight past:
// see src/video-enrich.js for the queue itself.
var _enricher = null
function _videoEnricher() {
  if (_enricher) return _enricher
  if (typeof PapaVideoEnrich === 'undefined' || !window.api || !window.api.videoEnrich) return null
  _enricher = PapaVideoEnrich.createEnricher({
    // The module deliberately touches no DOM API, so the real observer is
    // supplied here. Without one it observes nothing at all — which is exactly
    // what happened first time: every card registered, the queue stayed empty,
    // and not a single request was made.
    observerFactory: function (cb, opts) {
      return new IntersectionObserver(cb, {
        // The page scrolls inside #content, not the window, so that is the
        // frame a card is near or far from.
        root: document.getElementById('content') || null,
        rootMargin: (opts && opts.rootMargin) || '400px 600px',
        threshold: 0,
      })
    },
    fetchDetail: function (key) {
      const at = key.indexOf(':')
      const type = key.slice(0, at)
      const id = key.slice(at + 1)
      return window.api.videoEnrich({ type: type, id: id }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'no metadata')
        return res.meta
      })
    },
  })
  return _enricher
}

// Paints what arrived into the slots the card already reserved, so nothing
// moves when metadata lands.
function _applyCardMeta(el, meta) {
  if (!el || !meta) return
  const credit = el.querySelector('[data-credit]')
  if (credit) credit.innerHTML = _vCreditHtml(meta)
  const rates = el.querySelector('[data-rates]')
  if (rates) rates.outerHTML = _vRatesHtml(meta)
}

// Releases the outgoing page's cards from the enrichment queue.
//
// unobserve() drops the element from the queue's own bookkeeping and from its
// IntersectionObserver, and deliberately leaves the metadata cache alone — that
// is keyed by title, not by element, so the same film on the next page still
// paints instantly from it.
function _releaseObservedCards() {
  if (!_enricher) return
  const root = document.getElementById('content')
  if (!root) return
  const cards = root.querySelectorAll('.vcard[data-enrich-observed="1"]')
  for (const card of cards) {
    try { _enricher.unobserve(card) } catch (_) { /* already gone */ }
  }
}

// Every card that has just been added to the page joins the queue.
function _observeCards(root) {
  const e = _videoEnricher()
  if (!e || !root) return
  const cards = root.querySelectorAll ? root.querySelectorAll('.vcard[data-video]') : []
  for (const card of cards) {
    const key = card.getAttribute('data-video')
    if (!key || card.dataset.enrichObserved === '1') continue
    card.dataset.enrichObserved = '1'
    e.observe(card, key, function (meta) { _applyCardMeta(card, meta) })
  }
}

function _initVideoUI() {
  if (_videoUiReady) return
  _videoUiReady = true
  _bindBrowseKeys()
  if (window.PapaVideoPlayer) {
    _player = window.PapaVideoPlayer.create({
      onExit: function () {
        _persistPosition(true)
        _watch = { key: null, meta: null, savedAt: 0, resumed: false }
        window.api.videoStop().catch(function () {})
      },
      onNext: _playNextEpisode,
      onState: _onVideoStateTick,
    })
    _player.bind()
  }
  window.api.onVideoEvent(function (payload) { _handleVideoEvent(payload || {}) })
}

// ── The film diary ──────────────────────────────────────────────────────────
// taste-store.js has held ratings, viewings, notes, favourites and lists since
// phase 1, and taste-panel.js has been able to render all of it since phase 5.
// Neither was reachable from the app: no script tag, no mount, no page. This is
// the wiring, and nothing else — every decision about how a rating looks or what
// a delete confirms lives in the panel.
//
// The keys are the same _watchKey() shapes the player already uses, so a film
// marked seen here is the film the resume position belongs to.

var _tasteP = null

function _taste() {
  if (_tasteP) return _tasteP
  if (!window.PapaTasteStore || !window.PapaTastePanel) return null
  _tasteP = window.PapaTastePanel.createTastePanel({
    store: window.PapaTasteStore,
    labelFor: _tasteLabelFor,
    metaFor: _tasteMetaForKey,
    // Every mutation lands here. Re-rendering the whole surface rather than
    // patching it: the panels are interdependent -- rating a film changes the
    // profile, the year in review and possibly the diary line above it -- and a
    // partial repaint is how those drift apart.
    onChange: function (event) { _onTasteChange(event) },
  })
  return _tasteP
}

// A diary entry carries a snapshot of the film's facts, so the diary can name
// and summarise a viewing logged years ago with no network and no cache. This
// walks the diary oldest-first so a later snapshot wins: the metadata for a
// title improves as TMDB fills in, and the most recent sitting has the best
// version of it.
// Memoised, because the naive version was quadratic.
//
// _tasteLabelFor() calls this to turn one key into one title, and the panel
// calls labelFor once per diary row and four times per favourite. Rebuilding
// the whole map each time meant a diary of N entries did N walks of N entries
// to render N rows: a thousand-film diary is a million iterations per render,
// plus sixteen more full walks for the favourites.
//
// Invalidated two ways, deliberately. Explicitly on every mutation, since they
// all pass through _onTasteChange — and by diary length as a backstop, so a
// write that somehow bypassed that is still noticed. Length alone would miss an
// edit that changes a note or a date without adding an entry, which is why both
// are needed rather than either.
var _tasteMetaCache = { map: null, len: -1 }

function _invalidateTasteMeta() {
  _tasteMetaCache = { map: null, len: -1 }
}

function _tasteMetaMap() {
  const store = window.PapaTasteStore
  if (!store) return {}
  const diary = store.diary()
  if (_tasteMetaCache.map && _tasteMetaCache.len === diary.length) return _tasteMetaCache.map
  const out = {}
  // Oldest first, so a later snapshot wins: the metadata for a title improves
  // as TMDB fills in, and the most recent sitting has the best version of it.
  const entries = diary.slice().reverse()
  for (const e of entries) {
    if (!e || !e.key || !e.meta) continue
    out[e.key] = Object.assign({}, out[e.key], e.meta)
  }
  _tasteMetaCache = { map: out, len: diary.length }
  return out
}

function _tasteLabelFor(key) {
  const meta = _tasteMetaMap()[key]
  if (meta && meta.title) {
    return meta.year ? meta.title + ' (' + meta.year + ')' : meta.title
  }
  // Better the key than an empty row: a diary that hides what it recorded is
  // worse than an ugly one.
  return key
}

// The facts worth freezing into a viewing. Runtime is what makes "hours watched"
// possible; directors, countries and languages are what the taste profile is
// built from.
function _tasteMetaOf(type, d) {
  if (!d) return null
  const crew = Array.isArray(d.crew) ? d.crew : []
  const directors = crew
    .filter(function (c) { return String(c.job || '').toLowerCase() === 'director' })
    .map(function (c) { return c.name })
    .filter(Boolean)
  const meta = {
    title: d.title || null,
    year: d.year != null ? Number(d.year) : null,
    type: type,
    poster: d.poster || null,
    runtime: Number(d.runtime) || 0,
  }
  if (directors.length) meta.directors = directors
  else if (d.director) meta.directors = [d.director]
  if (Array.isArray(d.countries) && d.countries.length) meta.countries = d.countries.slice()
  if (Array.isArray(d.languages) && d.languages.length) meta.languages = d.languages.slice()
  else if (d.language) meta.languages = [d.language]
  return meta
}

// The key for whatever the detail page is currently showing. A series is keyed
// per show rather than per episode here: a diary is about "I watched Andrei
// Rublev", and per-episode rows would bury a film log under a season of TV.
// Only the page currently open knows the facts about the film on it. Anything
// else -- a key from the diary page, a stale key from a previous detail view --
// gets whatever the diary already froze, which is the right answer: it must not
// overwrite a good old snapshot with an empty new one.
function _tasteMetaForKey(key) {
  const open = _tasteKeyOfDetail()
  if (open && open === key) {
    const fresh = _tasteMetaOf(_videoDetail.type, _videoDetail.d)
    if (fresh) return fresh
  }
  return _tasteMetaMap()[key] || null
}

function _tasteKeyOfDetail() {
  if (!_videoDetail || !_videoDetail.d) return null
  return _videoDetail.type + ':' + _videoDetail.d.id
}

function _onTasteChange(event) {
  // Before anything reads it: every mutation can change a title's metadata.
  _invalidateTasteMeta()
  // The detail page and the diary page both show taste, and both are live.
  if (state.currentPage === 'diary') return _renderDiaryBody()
  if (state.currentPage === 'video-detail') return _renderTasteSection()
  // A rating or a seen mark changes what the grids should hide, so a browse
  // page left behind is stale the moment it is returned to. Cheap to mark.
  _browseTasteDirty = true
  if (event && event.type === 'unsee') _browseTasteDirty = true
}

var _browseTasteDirty = false

// ── the detail page's own record of a film ─────────────────────────────────

function _renderTasteSection() {
  const mount = document.getElementById('vtaste')
  const panel = _taste()
  const key = _tasteKeyOfDetail()
  if (!mount || !panel || !key) return
  const store = window.PapaTasteStore
  const count = store.watchCount(key)
  mount.innerHTML =
    '<section class="vsec tp-section" id="vtaste-inner">' +
      '<h2 class="vsec-title">Your record</h2>' +
      '<div class="tp-record">' +
        '<div class="tp-record-main">' +
          panel.renderRating(key) +
          panel.renderSeen(key) +
          // This film's own viewings sit under the rating rather than below both
          // columns: the rating and the seen state are short, the form beside
          // them is tall, and the leftover space was simply blank.
          (count ? '<div class="tp-record-diary">' + panel.renderDiary({ key: key }) + '</div>' : '') +
        '</div>' +
        '<div class="tp-record-side">' +
          panel.renderDiaryForm(key) +
        '</div>' +
      '</div>' +
      '<div class="tp-record-lists">' + panel.renderLists({ key: key }) + '</div>' +
    '</section>'
  panel.mount(document.getElementById('vtaste-inner'))
}

// ── the diary page ─────────────────────────────────────────────────────────
// Everything the store holds, on one page: the profile, a year, the four
// favourites, the lists and the whole diary. The panel builds all of it; this
// decides the order and which year is showing.

var _diaryYear = null
var _diaryView = 'all'

function renderDiary() {
  _initVideoUI()
  _videoTab = 'diary'
  setContent('<div class="page vpage cinema">' + _vHeadHtml() +
    '<div class="tp-page" id="tp-page">' +
      '<div class="tp-page-head">' +
        '<h1 class="tp-title">Diary</h1>' +
        '<div class="tp-years" id="tp-years"></div>' +
      '</div>' +
      '<div class="tp-body" id="tp-body"></div>' +
    '</div>' +
  '</div>')
  _bindVideoHead()
  if (!window.PapaTasteStore || !window.PapaTastePanel) {
    // Said out loud rather than rendering an empty page: this only happens if a
    // script failed to load, and a blank diary looks identical to no history.
    const body = document.getElementById('tp-body')
    if (body) body.innerHTML = '<div class="tp-empty">The diary could not be loaded.</div>'
    return
  }
  _renderDiaryBody()
}

function _renderDiaryYears() {
  const box = document.getElementById('tp-years')
  if (!box) return
  const years = window.PapaTasteStore.diaryYears()
  // Only offered when there is more than one: a single-year picker is a control
  // that cannot do anything.
  if (years.length < 2) { box.innerHTML = ''; return }
  box.innerHTML = '<button class="tp-year-btn' + (_diaryView === 'all' ? ' is-on' : '') +
      '" data-diary-year="all">All time</button>' +
    years.map(function (y) {
      return '<button class="tp-year-btn' + (_diaryView === 'year' && _diaryYear === y.year ? ' is-on' : '') +
        '" data-diary-year="' + y.year + '" title="' + y.viewings +
        (y.viewings === 1 ? ' viewing' : ' viewings') + '">' + y.year + '</button>'
    }).join('')
  box.querySelectorAll('[data-diary-year]').forEach(function (b) {
    b.addEventListener('click', function () {
      const v = b.dataset.diaryYear
      if (v === 'all') { _diaryView = 'all'; _diaryYear = null }
      else { _diaryView = 'year'; _diaryYear = Number(v) }
      _renderDiaryBody()
    })
  })
}

function _renderDiaryBody() {
  const body = document.getElementById('tp-body')
  const panel = _taste()
  if (!body || !panel) return
  const meta = _tasteMetaMap()
  const store = window.PapaTasteStore

  // A year that has since been emptied must not leave the page showing a year
  // that no longer exists.
  if (_diaryView === 'year') {
    const years = store.diaryYears().map(function (y) { return y.year })
    if (!years.includes(_diaryYear)) { _diaryView = 'all'; _diaryYear = null }
  }

  const summary = _diaryView === 'year'
    ? panel.renderYearInReview(_diaryYear, meta)
    : panel.renderProfile(meta)

  body.innerHTML =
    '<div class="tp-cols">' +
      '<div class="tp-col-main">' +
        '<section class="tp-block">' + summary + '</section>' +
        '<section class="tp-block">' +
          '<h3 class="tp-h">' + (_diaryView === 'year' ? esc(String(_diaryYear)) : 'Everything') + '</h3>' +
          // One query, one renderer. The year view differs from all-time only in
          // the filter it passes.
          panel.renderDiary(_diaryView === 'year' ? { year: _diaryYear } : {}) +
        '</section>' +
      '</div>' +
      '<aside class="tp-col-side">' +
        '<section class="tp-block">' + panel.renderFavourites(null) + '</section>' +
        '<section class="tp-block">' + panel.renderLists(null) + '</section>' +
      '</aside>' +
    '</div>'

  panel.mount(body)
  _renderDiaryYears()
  _bindDiaryLinks()
}

// A diary row names a film; the name should take you to it. The row carries its
// entry id and not its key, so the key comes from the store rather than from a
// data attribute that does not exist.
function _bindDiaryLinks() {
  const store = window.PapaTasteStore
  if (!store) return
  const byId = new Map()
  for (const e of store.diary()) byId.set(e.id, e.key)

  document.querySelectorAll('.tp-entry[data-tp-id]').forEach(function (row) {
    const title = row.querySelector('.tp-entry-title')
    if (!title || title.dataset.diaryLinked === '1') return
    const key = byId.get(row.dataset.tpId)
    if (!key) return
    title.dataset.diaryLinked = '1'
    title.setAttribute('role', 'link')
    title.setAttribute('tabindex', '0')
    title.classList.add('tp-linked')
    const go = function () {
      const parts = String(key).split(':')
      // Only the two shapes the detail page can open. An episode key
      // ("tv:1396:s1e2") resolves to its show, which is where the episode is.
      if (parts.length >= 2) navigate('video-detail', parts[0] + ':' + parts[1])
    }
    title.addEventListener('click', go)
    title.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() }
    })
  })
}

// The identity a position is stored against. An episode is keyed per episode,
// a film per film, so a series remembers where you are in each one.
function _watchKey(type, id, season, episode) {
  if (type === 'movie') return 'movie:' + id
  if (type === 'tv') return 'tv:' + id + ':s' + season + 'e' + episode
  return 'anime:' + id + ':e' + episode
}

// Called on every state tick (~4/s). Writing that often would thrash
// localStorage for no benefit, so it is throttled to once every five seconds
// and on stop.
function _onVideoStateTick(st) {
  if (!st || !_watch.key) return
  if (!st.duration || st.paused) return
  const now = Date.now()
  if (now - _watch.savedAt < 5000) return
  _watch.savedAt = now
  _persistPosition(false, st)
}

function _persistPosition(final, st) {
  const store = _vStore()
  if (!store || !_watch.key) return
  const state = st || (_player && _player._state())
  if (!state || !state.duration) return
  try {
    store.setPosition(_watch.key, _watch.meta || {}, state.position, state.duration)
  } catch (_) { /* a full or broken store must never interrupt playback */ }
  void final
}

// Offered rather than applied: silently jumping into the middle of a film is
// disorienting when it is not what you wanted, and there is no undo once mpv
// has seeked.
function _offerResume(state) {
  const store = _vStore()
  if (!store || !_watch.key || _watch.resumed) return
  _watch.resumed = true
  let saved = null
  try { saved = store.get(_watch.key) } catch (_) { return }
  if (!saved || saved.watched) return
  const pos = Number(saved.position) || 0
  const dur = Number(saved.duration) || Number(state && state.duration) || 0
  if (!dur || pos < 30 || pos / dur > 0.95) return
  const label = _player && _player.fmtTime ? _player.fmtTime(pos) : Math.round(pos) + 's'
  showToast('Resuming from ' + label)
  window.api.videoControl('seek', { seconds: pos, mode: 'absolute' }).catch(function () {})
}

function _videoStopAndHide() {
  window.api.videoStop().catch(function () {})
  if (_player) _player.close()
}

// The theatre shows lifecycle on the stage, because until mpv is actually
// playing there is nothing behind the deck to look at. Once it is playing the
// message is cleared so the video is unobstructed.
function _handleVideoEvent(payload) {
  if (!_player) return
  if (payload.kind === 'audio') return   // badges come from the state stream

  // The mouse moved over the picture. Only the theatre cares, and only to know
  // the viewer is still watching rather than gone.
  if (payload.kind === 'activity') { _player.noteActivity(); return }

  // A key pressed inside the video window. mpv owns the keyboard while it has
  // focus, so it forwards the actions that belong to the app.
  // The episodes inside the season pack now streaming.
  if (payload.kind === 'pack') {
    _player.setPack(payload.files || [], _switchPackEpisode)
    return
  }

  if (payload.kind === 'key') {
    if (payload.action === 'skip') _player.skipNow()
    else if (payload.action === 'next') _playNextEpisode()
    // Double-clicking the picture. The click lands on mpv, never on the page,
    // so mpv relays it and the app expands — rather than mpv fullscreening the
    // embedded surface alone and burying the deck under it.
    else if (payload.action === 'fullscreen') _player.toggleFullscreen()
    return
  }

  if (payload.kind === 'buffering') {
    const pct = payload.percent != null ? Math.round(payload.percent * 100) : null
    const mbps = payload.speed ? (payload.speed / 125000).toFixed(1) + ' Mb/s' : null
    const peers = payload.peers != null ? payload.peers + ' peers' : null
    // 'connecting' means the first deadline passed while peers were connected —
    // it is taking a while, not failing, and saying so beats a stuck spinner.
    const label = payload.phase === 'connecting'
      ? 'Still connecting'
      : (payload.phase === 'prebuffer' ? 'Buffering' : 'Downloading')
    const detail = [mbps, peers].filter(Boolean).join(' · ')
    _player.setStageMessage('<div class="spin"></div><div>' +
      esc(label + (pct != null ? ' ' + pct + '%' : '…')) + '</div>' +
      (detail ? '<div style="opacity:.6">' + esc(detail) + '</div>' : ''))
  } else if (payload.kind === 'playing') {
    _player.setStageMessage('')
    _loadSkipSegments()
    _offerResume(_player._state())
    _setUpNextInfo()
    // Resolving the next episode's sources now means advancing later is
    // instant instead of a fresh round-trip to five indexers.
    _prefetchNextSources()
  } else if (payload.kind === 'error') {
    _player.setStageMessage('<div style="color:var(--color-error)">' +
      esc(_videoErrorText(payload.message || 'Playback error')) + '</div>')
  }
}

// Segments are asked for once playback starts, because the cheap layers need
// the file's real duration and chapter list, which only exist by then.
async function _loadSkipSegments() {
  if (!_player || !_videoDetail || !_videoDetail.d) return
  const d = _videoDetail.d
  const store = _vStore()
  const seasonKey = _videoDetail.type === 'tv'
    ? 'tv:' + d.id + ':s' + _videoState.season
    : _videoDetail.type + ':' + d.id
  let manual = []
  let prefs = {}
  try {
    if (store) {
      manual = store.skip(seasonKey) || []
      prefs = store.prefs(_videoDetail.type + ':' + d.id) || {}
    }
  } catch (_) { /* a broken store must not stop playback */ }
  _player.setPrefs(prefs)

  const state = _player._state()
  const res = await window.api.videoSkipSegments({
    type: _videoDetail.type,
    id: d.id,
    malId: d.idMal || null,
    episode: _videoState.episode,
    duration: state ? state.duration : 0,
    manual: manual,
  }).catch(function () { return { ok: false, segments: [] } })
  _player.setSegments(res && res.ok ? res.segments : [])
}

// Sources for the next episode, resolved while the current one plays so
// advancing is instant rather than a fresh round-trip to five indexers.
// Keyed by the episode it belongs to, so a season change invalidates it.
var _prefetch = { key: null, streams: null, inflight: false }

function _prefetchKey(next) {
  return next ? (next.season == null ? 'e' : 's' + next.season + 'e') + next.episode : null
}

async function _prefetchNextSources() {
  if (!_videoDetail || !_videoDetail.d) return
  const next = _nextEpisodeOf(_videoDetail, _videoState)
  const key = _prefetchKey(next)
  if (!key || _prefetch.key === key || _prefetch.inflight) return
  _prefetch = { key: key, streams: null, inflight: true }

  // The request is the one we would make after advancing, with the episode
  // moved on. Building it by hand avoids mutating _videoState, which the UI
  // is still rendering from.
  const d = _videoDetail.d
  const req = {
    type: _videoDetail.type, title: d.title, year: d.year,
    tmdbId: _videoDetail.type === 'tv' ? d.id : undefined,
    imdbId: d.imdbId || null,
    anilistId: _videoDetail.type === 'anime' ? d.id : undefined,
    titles: d.titles || null,
    season: next.season != null ? next.season : undefined,
    episode: next.episode,
    // Ask for the language actually being watched. _videoState.sub tracks the
    // Dub checkbox, which is not touched when a dubbed source is picked
    // straight out of the list.
    sub: _playing.dub === true ? false : true,
    dub: _playing.dub === true,
  }
  const res = await window.api.videoStreams(req).catch(function () { return { ok: false } })
  if (_prefetch.key !== key) return   // season changed while we were waiting
  _prefetch.inflight = false
  _prefetch.streams = res && res.ok && Array.isArray(res.streams) && res.streams.length ? res.streams : null
}

// Tells the theatre what is coming, so the Up Next card can show the real
// episode rather than a generic "next".
function _setUpNextInfo() {
  if (!_player || !_videoDetail || !_videoDetail.d) return
  const next = _nextEpisodeOf(_videoDetail, _videoState)
  if (!next) return _player.setUpNext(null)
  const d = _videoDetail.d
  let title = 'Episode ' + next.episode
  let still = null
  if (_videoDetail.type === 'tv' && Array.isArray(d.seasons)) {
    const season = d.seasons.find(function (x) { return x.seasonNumber === next.season })
    const ep = season && Array.isArray(season.episodes)
      ? season.episodes.find(function (e) { return e.episodeNumber === next.episode })
      : null
    if (ep) {
      if (ep.name) title = ep.name
      still = ep.still || null
    }
  }
  _player.setUpNext({
    title: title,
    subtitle: _videoDetail.type === 'tv'
      ? 'Season ' + next.season + ' · Episode ' + next.episode
      : d.title,
    still: still,
  })
}

// Picks the next episode's source to match what is already playing, rather
// than taking whatever ranked first. Language is the part a viewer notices
// immediately, so it outranks quality and seeds; the indexer and quality are
// weaker preferences on top.
var _QUALITY_ORDER = ['480p', '720p', '1080p', '2160p']

// Distance between two resolutions in steps, so an exact match wins, one step
// away is a near miss, and unknown is worst. Falling from 1080p to 720p is a
// far smaller insult than falling to an unlabelled release.
function _qualityDistance(a, b) {
  const ia = _QUALITY_ORDER.indexOf(a)
  const ib = _QUALITY_ORDER.indexOf(b)
  if (ia === -1 || ib === -1) return 9
  return Math.abs(ia - ib)
}

function _pickMatchingStream(streams, want) {
  const list = Array.isArray(streams) ? streams : []
  if (!list.length) return null
  if (!want || (want.dub == null && !want.quality)) return list[0]
  const scored = list.map(function (s, i) {
    let score = 0
    // Language is what a viewer notices in the first second, so it outranks
    // everything else and can never be outvoted by resolution or seeds.
    if (want.dub != null && (s.dub === true) === want.dub) score += 1000
    // Resolution is the next thing they notice. Scored by closeness rather
    // than exact match, so 1080p -> 720p beats 1080p -> unlabelled.
    if (want.quality) score += Math.max(0, 100 - _qualityDistance(want.quality, s.quality) * 25)
    // The indexer is only a tiebreaker: it says nothing about how it looks.
    if (want.source && s.source === want.source) score += 10
    return { s: s, score: score, i: i }
  })
  scored.sort(function (a, b) { return b.score - a.score || a.i - b.i })
  return scored[0].s
}

// ── Binge: advancing to the next episode ────────────────────────────────────
// Films have no next; a series advances within the season, then rolls into the
// next one. Returns null at the end of the last season rather than wrapping.
function _nextEpisodeOf(detail, stateNow) {
  if (!detail || !detail.d || detail.type === 'movie') return null
  const d = detail.d
  if (detail.type === 'anime') {
    const total = Number(d.episodeCount) || 0
    const next = (Number(stateNow.episode) || 1) + 1
    if (total && next > total) return null
    return { season: null, episode: next }
  }
  const seasons = Array.isArray(d.seasons) ? d.seasons.filter(function (x) { return x.seasonNumber != null } ) : []
  const cur = seasons.find(function (x) { return x.seasonNumber === stateNow.season })
  const count = cur ? Number(cur.episodeCount) || 0 : 0
  const nextEp = (Number(stateNow.episode) || 1) + 1
  if (!count || nextEp <= count) return { season: stateNow.season, episode: nextEp }
  // End of the season: roll into the next real season, skipping specials (0).
  const later = seasons.filter(function (x) { return x.seasonNumber > stateNow.season && x.seasonNumber >= 1 })
  if (!later.length) return null
  return { season: later[0].seasonNumber, episode: 1 }
}

// Resolves sources for the next episode and starts the best one. The source
// list is already ranked, so "best" is simply the first entry.
async function _playNextEpisode() {
  if (!_videoDetail || !_videoDetail.d) return
  const next = _nextEpisodeOf(_videoDetail, _videoState)
  if (!next) {
    showToast('That was the last episode')
    return
  }
  _persistPosition(true)
  const store = _vStore()
  // Finishing an episode by advancing counts as having watched it.
  try { if (store && _watch.key) store.markWatched(_watch.key) } catch (_) {}

  if (next.season != null) _videoState.season = next.season
  _videoState.episode = next.episode

  _player.setSegments([])
  _player.setStageMessage('<div class="spin"></div><div>Finding sources for episode ' + next.episode + '…</div>')
  _player.open({
    title: _videoDetail.d.title,
    subtitle: _videoDetail.type === 'tv'
      ? 'Season ' + _videoState.season + ' · Episode ' + _videoState.episode
      : 'Episode ' + _videoState.episode,
  })

  // Use what was resolved during the credits when it matches this episode.
  const wantKey = _prefetchKey(next)
  const res = (_prefetch.key === wantKey && _prefetch.streams)
    ? { ok: true, streams: _prefetch.streams }
    : await window.api.videoStreams(_videoStreamRequest())
        .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  _prefetch = { key: null, streams: null, inflight: false }
  if (!res.ok || !Array.isArray(res.streams) || !res.streams.length) {
    _player.setStageMessage('<div style="color:var(--color-error)">' +
      esc(res.ok ? 'No sources found for episode ' + next.episode : _videoErrorText(res.error)) + '</div>')
    return
  }
  _videoStreams = res.streams
  const pick = _pickMatchingStream(res.streams, _playing)
  // Say so when the match had to be compromised, rather than quietly handing
  // over something different from what was being watched.
  const notes = []
  if (_playing.dub != null && pick && (pick.dub === true) !== _playing.dub) {
    notes.push(_playing.dub ? 'no dub available' : 'no subbed release')
  }
  if (_playing.quality && pick && pick.quality !== _playing.quality) {
    notes.push((pick.quality || 'unknown quality') + ' instead of ' + _playing.quality)
  }
  if (notes.length) showToast('Episode ' + next.episode + ': ' + notes.join(' · '))
  _videoPlayResult(pick)
  // The detail page behind the theatre should reflect where we now are.
  if (_videoDetail.type === 'tv') _renderVideoControls('tv')
}

// The characteristics of the source actually playing. Picking the next
// episode's "best" source ignores this: a viewer watching a dub does not want
// the next episode in Japanese because that release happened to have more
// seeds.
var _playing = { dub: null, source: null, quality: null }

// Switching episode inside the pack that is already streaming. No new search,
// no new torrent, no waiting on peers — the file is already being served.
async function _switchPackEpisode(index) {
  if (!_player) return
  _player.setStageMessage('<div class="spin"></div><div>Switching episode…</div>')
  const res = await window.api.videoPackSelect({ index: index })
    .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  if (!res.ok) {
    _player.setStageMessage('<div style="color:var(--color-error)">' + esc(_videoErrorText(res.error)) + '</div>')
    return
  }
  _player.setStageMessage('')
  _player.setPack(res.files || [], _switchPackEpisode)

  // Keep the rest of the app in step: the episode being watched drives the
  // watch store, the skip segments and what counts as next.
  const chosen = (res.files || []).find(function (f) { return f.current })
  if (chosen && chosen.episode != null) {
    _videoState.episode = chosen.episode
    const d = _videoDetail && _videoDetail.d
    if (d) {
      _watch = {
        key: _watchKey(_videoDetail.type, d.id, _videoState.season, _videoState.episode),
        meta: {
          type: _videoDetail.type, id: d.id, title: d.title, poster: d.poster || null,
          season: _videoDetail.type === 'tv' ? _videoState.season : null,
          episode: _videoState.episode,
        },
        savedAt: 0, resumed: true,
      }
    }
    _player.setSegments([])
    _loadSkipSegments()
  }
}

function _videoPlayResult(result) {
  if (!result) return
  _initVideoUI()
  // The source does not know which episode was asked for, and a season pack
  // contains them all — so the request's episode travels with it.
  if (_videoDetail && _videoDetail.type !== 'movie') {
    result = Object.assign({}, result, {
      season: _videoDetail.type === 'tv' ? _videoState.season : null,
      episode: _videoState.episode,
    })
  }
  _playing = {
    dub: result.dub === true,
    source: result.source || null,
    quality: result.quality || null,
  }
  const d = _videoDetail && _videoDetail.d
  const isEpisode = _videoDetail && _videoDetail.type !== 'movie'

  // Identify the title for the watch store before anything starts, so the very
  // first state tick already has somewhere to write.
  if (d) {
    _watch = {
      key: _watchKey(_videoDetail.type, d.id, _videoState.season, _videoState.episode),
      meta: {
        type: _videoDetail.type, id: d.id, title: d.title, poster: d.poster || null,
        season: _videoDetail.type === 'tv' ? _videoState.season : null,
        episode: isEpisode ? _videoState.episode : null,
      },
      savedAt: 0, resumed: false,
    }
  }

  _player.open({
    hasNext: !!_nextEpisodeOf(_videoDetail, _videoState),
    title: d ? d.title : 'Video',
    subtitle: isEpisode
      ? (_videoDetail.type === 'tv'
          ? 'Season ' + _videoState.season + ' · Episode ' + _videoState.episode
          : 'Episode ' + _videoState.episode)
      : (d && d.year ? String(d.year) : ''),
  })
  _handleVideoEvent({ kind: 'buffering' })
  // Wait until main knows the stage rectangle. Starting playback first shows
  // the mpv window at its creation size, floating over the app as a separate
  // window before any bounds arrive.
  Promise.resolve(_player.ready ? _player.ready() : null).then(function () {
  window.api.videoPlay({ result }).then(function (res) {
    // The handler rejects unplayable sources (no magnet, no URL) with ok:false
    // rather than throwing, so this has to be checked, not just caught.
    if (res && res.ok === false) _handleVideoEvent({ kind: 'error', message: res.error })
  }).catch(function (e) {
    _handleVideoEvent({ kind: 'error', message: String((e && e.message) || e) })
  })
  })
}


function _videoErrorText(message) {
  const msg = String(message || 'Something went wrong')
  if (/401|api key/i.test(msg)) return 'TMDB API key missing or invalid — set it in Settings → Video.'
  if (/timed out|timeout|abort/i.test(msg)) return 'The source timed out. Check your connection and try again.'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(msg)) return 'Could not reach the service. Check your connection.'
  // The streamer already words these for a person, and says which of the two
  // happened: nobody sharing at all, or peers found but slow to start. Passing
  // them through beats overwriting them with something vaguer.
  if (/Nobody is sharing|did not start within/i.test(msg)) return msg + ' — try another source below.'
  return msg
}

function _videoError(message) {
  const raw = message || 'Something went wrong'
  // _videoErrorText exists precisely to turn these into something a person can
  // act on, and this was the one place that skipped it — so a dropped
  // connection showed the literal string "fetch failed".
  const msg = _videoErrorText(raw)
  const hint = /TMDB API key|401/i.test(raw)
    ? '<div class="video-error-hint">Set your TMDB API key in Settings → Video.</div>'
    : ''
  setContent('<div class="page"><div class="video-error">' +
    '<div class="video-error-title">Couldn\'t load this</div>' +
    '<div class="video-error-message">' + esc(msg) + '</div>' +
    hint +
    '<div class="video-error-actions">' +
      // Most failures here are a blip. Without this the only way back to the
      // title was to leave the page and find it again.
      '<button id="video-error-retry">Try again</button>' +
      '<button class="secondary" id="video-error-back">Back to Movies &amp; TV</button>' +
    '</div>' +
  '</div></div>')
  document.getElementById('video-error-back')?.addEventListener('click', function () { navigate('video') })
  document.getElementById('video-error-retry')?.addEventListener('click', function () {
    navigate(state.currentPage, _currentNavId(), { skipHistory: true })
  })
}

// A shelf opened out. The rail shows twenty because a rail is a preview; the
// canon runs to a thousand and the point of curation is that there is more
// behind it than fits on one screen.
var _shelfPage = { key: null, page: 1, items: [], loading: false, done: false, ticket: 0 }

// ── Recommendations from your own diary ─────────────────────────────────────
// The taste store has held directors, decades and countries since phase 1 and
// nothing ever asked it a question. This is the question.
//
// The renderer sends conclusions, not history: one director, one decade, one
// country, already ranked. main turns whichever is strongest into a discover
// query. Sending the diary itself would put taste logic in two places, and the
// store is the place.
//
// A short diary has no taste in it yet, and the row says so rather than showing
// an empty rail under a confident heading.
const TASTE_ROW_MIN_TITLES = 5

function _tasteSignals() {
  const store = window.PapaTasteStore
  if (!store) return null
  const meta = _tasteMetaMap()
  const p = store.profile(meta)
  if (!p || p.titles < TASTE_ROW_MIN_TITLES) {
    return { enough: false, titles: (p && p.titles) || 0 }
  }
  const top = list => (Array.isArray(list) && list.length ? list[0].name : null)
  return {
    enough: true,
    titles: p.titles,
    director: top(p.topDirectors),
    // The store keeps a decade as a number; main wants the same.
    decade: top(p.decades),
    // A country name is what the diary stored, and TMDB's discover wants a
    // language code. Only pass it when it already looks like one.
    country: _tasteLanguageCode(p.topLanguages),
  }
}

// The diary stores whatever the detail page gave it — "Japanese", not "ja". The
// discover query needs a code, so a name that cannot be turned into one is
// dropped rather than guessed at: a wrong code returns a confident shelf of the
// wrong cinema.
const TASTE_LANGUAGE_CODES = {
  japanese: 'ja', korean: 'ko', french: 'fr', italian: 'it', spanish: 'es',
  german: 'de', mandarin: 'zh', cantonese: 'zh', chinese: 'zh', hindi: 'hi',
  persian: 'fa', farsi: 'fa', russian: 'ru', swedish: 'sv', danish: 'da',
  polish: 'pl', portuguese: 'pt', english: 'en', thai: 'th', turkish: 'tr',
  arabic: 'ar', hebrew: 'he', czech: 'cs', hungarian: 'hu', dutch: 'nl',
}

function _tasteLanguageCode(list) {
  if (!Array.isArray(list) || !list.length) return null
  for (const entry of list) {
    const raw = String((entry && entry.name) || '').trim()
    if (!raw) continue
    // Already a code.
    if (/^[a-z]{2}$/.test(raw)) return raw
    const hit = TASTE_LANGUAGE_CODES[raw.toLowerCase()]
    if (hit) return hit
  }
  return null
}

async function _renderTasteRow(ticket) {
  const mount = document.getElementById('vtaste-row')
  if (!mount) return
  const sig = _tasteSignals()
  if (!sig) { mount.innerHTML = ''; return }

  if (!sig.enough) {
    // Said plainly, and only once there is something to build on: an empty
    // promise on a first run is worse than no row.
    mount.innerHTML = sig.titles
      ? '<div class="vrow-head"><h2 class="vrow-title">From your diary</h2></div>' +
        '<p class="vrow-note">' + sig.titles +
        (sig.titles === 1 ? ' film logged' : ' films logged') +
        ' so far. This fills in at ' + TASTE_ROW_MIN_TITLES + '.</p>'
      : ''
    return
  }

  mount.innerHTML = _vRowShell('taste', 'From your diary', 0)
  const res = await window.api.videoTasteShelf({
    director: sig.director, decade: sig.decade, country: sig.country,
  }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  if (_videoCatalogTicket !== ticket) return
  const box = document.getElementById('vtaste-row')
  if (!box) return
  if (!res.ok) {
    box.innerHTML = '<div class="vrow-msg err">' + esc(_videoErrorText(res.error)) + '</div>'
    return
  }
  const items = Array.isArray(res.results) ? res.results : []
  if (!items.length) { box.innerHTML = ''; return }
  // The heading says WHY, which is the whole difference between a
  // recommendation and a row of posters.
  box.innerHTML = _vRowShell('taste', res.reason || 'From your diary', items.length)
  _fillRow('taste', items)
}

// ── Hide what you have seen ─────────────────────────────────────────────────
// The store has always had unwatchedFilter() and nothing called it. It is a
// view filter, not a query one: TMDB does not know what you have watched, so
// the filtering happens after the results arrive.
//
// Consequences worth stating, because a hidden card is easy to mistake for a
// missing one:
//   - the count says how many were hidden, rather than quietly showing fewer;
//   - it is off by default, because a first-time user has seen nothing and a
//     toggle that appears to do nothing is worse than no toggle;
//   - it does not affect the diary or a person's filmography, where the whole
//     point is the films you have seen.
const HIDE_SEEN_KEY = 'papa_hide_seen'
var _hideSeen = false

function restoreHideSeenPref() {
  try { _hideSeen = localStorage.getItem(HIDE_SEEN_KEY) === '1' } catch (_) { _hideSeen = false }
}

function setHideSeen(on) {
  _hideSeen = !!on
  try { localStorage.setItem(HIDE_SEEN_KEY, _hideSeen ? '1' : '0') } catch (_) {}
}

// A card's key is the same _watchKey shape the diary stores, so "seen" here and
// "seen" in the diary cannot disagree.
function _cardKey(item) {
  if (!item) return ''
  return (item.type || 'movie') + ':' + (item.id == null ? '' : item.id)
}

function _hideSeenApply(items) {
  const list = Array.isArray(items) ? items : []
  if (!_hideSeen || !window.PapaTasteStore) return { shown: list, hidden: 0 }
  const shown = list.filter(function (i) { return !window.PapaTasteStore.hasSeen(_cardKey(i)) })
  return { shown: shown, hidden: list.length - shown.length }
}

function _hideSeenToggleHtml(id) {
  return '<label class="vhide-seen"><input type="checkbox" id="' + id + '"' +
    (_hideSeen ? ' checked' : '') + '> <span>Hide what I have seen</span></label>'
}

// Says what it did. A grid that silently drops rows reads as a broken query.
function _hideSeenNote(hidden) {
  if (!hidden) return ''
  return '<div class="vhide-seen-note">' + hidden +
    (hidden === 1 ? ' title you have seen is hidden' : ' titles you have seen are hidden') + '</div>'
}

// ── Sorting a loaded grid ───────────────────────────────────────────────────
// A curated shelf's order IS the curation: The Canon is rating-first by design,
// and asking TMDB for a different order would make it a different shelf. So
// this sorts what has been loaded, and the control says so rather than implying
// the whole shelf was re-queried.
//
// Kept as one table and one comparator because the shelf page and the see-all
// grids both need it, and two copies of a sort drift on the tie-break first.
const VSORTS = [
  { key: '', label: 'Default order' },
  { key: 'rating', label: 'Best first' },
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'title', label: 'A\u2013Z' },
]

function _vSortItems(items, sort) {
  const list = Array.isArray(items) ? items.slice() : []
  if (!sort) return list
  // Number(null), Number(undefined) and Number('') are 0, NaN and 0 — so a
  // missing year read as the year 0 and sorted first under "oldest". Absence
  // has to be checked before the coercion, not after it.
  const num = v => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const title = i => String((i && (i.title || i.name)) || '').toLowerCase()
  // Anything without the field being sorted on goes last rather than sorting as
  // zero, which would put every untitled or undated item at the top.
  const cmp = {
    rating: (a, b) => _vNullsLast(num(a.rating), num(b.rating), (x, y) => y - x),
    newest: (a, b) => _vNullsLast(num(a.year), num(b.year), (x, y) => y - x),
    oldest: (a, b) => _vNullsLast(num(a.year), num(b.year), (x, y) => x - y),
    title: (a, b) => title(a).localeCompare(title(b)),
  }[sort]
  if (!cmp) return list
  // A stable tie-break on the original position, so two films of the same year
  // do not swap places every time the grid repaints.
  return list
    .map((item, i) => ({ item, i }))
    .sort((x, y) => cmp(x.item, y.item) || x.i - y.i)
    .map(x => x.item)
}

function _vNullsLast(a, b, compare) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return compare(a, b)
}

// `partial` marks a grid that is paged, where a sort can only order what has
// arrived. A filmography is not paged -- every credit is already loaded -- so
// the caveat would be a lie there.
function _vSortControlHtml(current, id, partial) {
  return '<div class="vsort">' +
    '<label class="vsort-label" for="' + id + '">Sort</label>' +
    '<select class="vsort-select" id="' + id + '">' +
      VSORTS.map(function (s) {
        return '<option value="' + s.key + '"' + (s.key === (current || '') ? ' selected' : '') + '>' +
          esc(s.label) + '</option>'
      }).join('') +
    '</select>' +
    // Said plainly: the alternative is a control that looks like it re-queried
    // the shelf and did not.
    (current && partial ? '<span class="vsort-note">of what is loaded</span>' : '') +
  '</div>'
}

async function renderShelf(key) {
  _initVideoUI()
  const ticket = ++_shelfPage.ticket
  // The sort is deliberately not carried across shelves: it belongs to the grid
  // you are looking at, and inheriting it would silently reorder the next
  // curated shelf you opened.
  _shelfPage = { key: key, page: 1, items: [], loading: false, done: false, ticket: ticket, sort: '' }
  setContent('<div class="page vpage cinema">' +
    '<div class="vshelf-head" id="vshelf-head">' +
      '<button class="vshelf-back" id="vshelf-back">&larr; Back</button>' +
      '<h1 class="vshelf-title" id="vshelf-title">Loading…</h1>' +
      '<p class="vrow-note" id="vshelf-note"></p>' +
      _vSortControlHtml('', 'vshelf-sort', true) +
      _hideSeenToggleHtml('vshelf-hide-seen') +
    '</div>' +
    '<div class="vgrid" id="vshelf-grid"></div>' +
    '<div class="vshelf-more" id="vshelf-more"></div>' +
  '</div>')
  document.getElementById('vshelf-back')?.addEventListener('click', function () { navigate('video') })
  document.getElementById('vshelf-sort')?.addEventListener('change', function () {
    _shelfPage.sort = this.value || ''
    _repaintShelfGrid()
  })
  document.getElementById('vshelf-hide-seen')?.addEventListener('change', function () {
    setHideSeen(this.checked)
    _repaintShelfGrid()
  })
  await _loadShelfPage(ticket)
  _bindShelfScroll(ticket)
}

async function _loadShelfPage(ticket) {
  if (_shelfPage.loading || _shelfPage.done) return
  _shelfPage.loading = true
  const more = document.getElementById('vshelf-more')
  if (more) more.innerHTML = '<div class="spin"></div>'
  const res = await window.api.videoShelf({ key: _shelfPage.key, page: _shelfPage.page })
    .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  // A page that arrived after the user left, or after they opened a different
  // shelf, must not append itself to whatever is on screen now.
  if (_shelfPage.ticket !== ticket || state.currentPage !== 'shelf') return
  _shelfPage.loading = false
  if (!res.ok) {
    if (more) more.innerHTML = '<div class="vrow-msg err">' + esc(_videoErrorText(res.error)) + '</div>'
    return
  }
  if (_shelfPage.page === 1 && res.shelf) {
    const t = document.getElementById('vshelf-title')
    if (t) t.textContent = res.shelf.label || 'Shelf'
    const n = document.getElementById('vshelf-note')
    if (n) n.textContent = res.shelf.note || ''
  }
  const fresh = Array.isArray(res.results) ? res.results : []
  // The catalogue repeats titles across page boundaries often enough that
  // appending blindly shows the same poster twice in one grid.
  const have = new Set(_shelfPage.items.map(function (i) { return (i.type || 'movie') + ':' + i.id }))
  const added = fresh.filter(function (i) { return !have.has((i.type || 'movie') + ':' + i.id) })
  _shelfPage.items = _shelfPage.items.concat(added)
  const grid = document.getElementById('vshelf-grid')
  if (grid) {
    if (_shelfPage.sort || _hideSeen) {
      // A sorted grid cannot append: the new page belongs wherever the sort puts
      // it, which is usually not the end. And a filtered grid has to recount how
      // many are hidden, which is a whole-grid question.
      _repaintShelfGrid()
    } else {
      grid.insertAdjacentHTML('beforeend', added.map(_videoCard).join(''))
      _bindVideoCards(grid)
    }
  }
  // An empty page is the end of the shelf; TMDB keeps answering past it with
  // nothing rather than with an error.
  if (!fresh.length) _shelfPage.done = true
  _shelfPage.page += 1
  if (more) more.innerHTML = _shelfPage.done ? '<div class="vshelf-end">That is the whole shelf.</div>' : ''
}

function _repaintShelfGrid() {
  const grid = document.getElementById('vshelf-grid')
  if (!grid) return
  const sorted = _vSortItems(_shelfPage.items, _shelfPage.sort)
  const vis = _hideSeenApply(sorted)
  grid.innerHTML = _hideSeenNote(vis.hidden) + vis.shown.map(_videoCard).join('')
  _bindVideoCards(grid)
  // The note under the control appears and disappears with the sort.
  const note = document.querySelector('#vshelf-head .vsort-note')
  if (_shelfPage.sort && !note) {
    document.querySelector('#vshelf-head .vsort')
      ?.insertAdjacentHTML('beforeend', '<span class="vsort-note">of what is loaded</span>')
  } else if (!_shelfPage.sort && note) {
    note.remove()
  }
}

// Loads the next page as the end of the grid comes into view, rather than
// making the reader find and press a button.
function _bindShelfScroll(ticket) {
  const sentinel = document.getElementById('vshelf-more')
  const root = document.getElementById('content')
  if (!sentinel || !root || typeof IntersectionObserver === 'undefined') return
  const io = new IntersectionObserver(function (entries) {
    if (_shelfPage.ticket !== ticket) { io.disconnect(); return }
    for (const e of entries) if (e.isIntersecting) _loadShelfPage(ticket)
  }, { root: root, rootMargin: '600px' })
  io.observe(sentinel)
}

async function renderVideo() {
  _initVideoUI()
  // Arriving here from Browse or the Diary, the tab state still names that
  // page; the catalog page has no such row set, so fall back to All.
  if (_videoTab === 'browse' || _videoTab === 'diary') _videoTab = 'all'
  const ticket = ++_videoCatalogTicket
  setContent('<div class="page vpage cinema">' +
    _vHeadHtml() +
    '<div id="vhero-mount"></div>' +
    '<div class="vrow vtaste-row" id="vtaste-row"></div>' +
    '<div class="video-search-results" id="video-search-results"></div>' +
    '<div class="vrows" id="vrows"></div>' +
  '</div>')
  _bindVideoHead()
  _renderVideoTab(ticket)
}

function _vHeadHtml() {
  const tabs = _videoTabs.map(function (t) {
    return '<button class="vtab' + (t.key === _videoTab ? ' active' : '') + '" data-vtab="' + t.key + '"' +
      ' role="tab" aria-selected="' + (t.key === _videoTab) + '">' + esc(t.label) + '</button>'
  }).join('')
  return '<div class="vhead">' +
    '<div class="vtabs" role="tablist">' + tabs + '</div>' +
    '<div class="vsearch">' +
      '<div class="vsearch-field">' + _VICON.search +
        '<input id="video-search-input" type="search" placeholder="Search movies, TV &amp; anime…" autocomplete="off" aria-label="Search">' +
        '<button class="vsearch-clear" id="video-search-clear" hidden aria-label="Clear search">&#10005;</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

function _bindVideoHead() {
  document.querySelectorAll('.vtab').forEach(function (b) {
    b.addEventListener('click', function () {
      if (_videoTab === b.dataset.vtab && state.currentPage !== 'browse') return
      _videoTab = b.dataset.vtab
      // Browse and Diary are pages of their own rather than filtered sets of rows.
      if (_videoTab === 'browse') return navigate('browse')
      if (_videoTab === 'diary') return navigate('diary')
      if (state.currentPage === 'browse' || state.currentPage === 'diary') return navigate('video')
      document.querySelectorAll('.vtab').forEach(function (x) {
        const on = x.dataset.vtab === _videoTab
        x.classList.toggle('active', on)
        x.setAttribute('aria-selected', String(on))
      })
      _renderVideoTab(++_videoCatalogTicket)
    })
  })
  _bindVideoSearch()
}

// One tab render: the hero (skipped for My List, which has no editorial
// content to feature) plus the rows that belong to this tab.
async function _renderVideoTab(ticket) {
  const heroMount = document.getElementById('vhero-mount')
  const rows = document.getElementById('vrows')
  if (!rows) return
  _stopVideoHero()

  const tasteRow = document.getElementById('vtaste-row')
  if (_videoTab === 'list') {
    if (heroMount) heroMount.innerHTML = ''
    if (tasteRow) tasteRow.innerHTML = ''
    _renderMyList(rows)
    return
  }
  // Only on All and Movies: the recommendation is built from a film diary, and
  // offering it above a TV or anime tab would be answering a different question.
  if (tasteRow) {
    if (_videoTab === 'all' || _videoTab === 'movie') _renderTasteRow(ticket)
    else tasteRow.innerHTML = ''
  }

  const wanted = _videoRows.filter(function (r) { return r.tabs.indexOf(_videoTab) !== -1 })
  const curated = _curatedRows(_videoTab)
  const personal = _personalRows()

  if (heroMount) heroMount.innerHTML = _vHeroSkeleton()
  // Curated shelves have no label until their results come back, because the
  // label and the curatorial line are defined beside the query that justifies
  // them. The shell goes up with a placeholder so the page does not jump.
  rows.innerHTML = personal.map(function (r) { return _vRowShell(r.key, r.label, r.items.length) }).join('') +
    wanted.map(function (r) { return _vRowShell(r.key, r.label, 0) }).join('') +
    curated.map(function (r) { return _vRowShell(r.key, '', 0, '', true) }).join('')

  _bindShelfExpanders(rows)
  personal.forEach(function (r) { _fillRow(r.key, r.items) })

  // A film is not removed from one shelf because it appears on another. Seven
  // Samurai belongs in the canon, in Japanese cinema and in world cinema, and
  // taking it out of two of them to avoid a repeat makes those two shelves
  // less true to what they claim to be. A shelf's job is to be right about its
  // own category, not to be disjoint from its neighbours.

  // Curated shelves load in parallel with the rest and fill in as they arrive.
  Promise.all(curated.map(async function (row) {
    if (!window.api.videoShelf) return
    const res = await window.api.videoShelf({ key: row.key })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
    if (_videoCatalogTicket !== ticket || state.currentPage !== 'video') return
    if (!res.ok) return _rowError(row.key, res.error)
    const items = Array.isArray(res.results) ? res.results : []
    // A shelf that cannot be filled honestly is not shown at all rather than
    // padded out with whatever else matched.
    if (items.length < 4) return _dropRow(row.key)
    _setRowHead(row.key, res.shelf)
    _fillRow(row.key, items)
  }))

  // Rows load in parallel and each owns its own failure, so one dead section
  // cannot wipe the ones that already arrived.
  await Promise.all(wanted.map(async function (row) {
    const res = await window.api.videoCatalogGet({ section: row.key, page: 1 })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
    if (_videoCatalogTicket !== ticket || state.currentPage !== 'video') return
    if (!res.ok) return _rowError(row.key, res.error)
    const items = Array.isArray(res.results) ? res.results : []
    if (!items.length) return _rowEmpty(row.key, 'Nothing here right now')
    _fillRow(row.key, items)
    if (row.key === wanted[0].key) _startVideoHero(items, ticket)
  }))
}

// Continue Watching and My List come from the local store, which may not be
// loaded yet — both are simply absent until it is.
function _personalRows() {
  const store = _vStore()
  if (!store) return []
  const out = []
  try {
    const cont = store.continueWatching(20) || []
    if (cont.length) out.push({ key: 'continue', label: 'Continue Watching', items: cont })
    const list = store.watchlist() || []
    if (list.length && _videoTab === 'all') out.push({ key: 'mylist', label: 'My List', items: list.slice(0, 20) })
  } catch (_) { /* a broken store must not take the page down */ }
  return out
}

function _vRowShell(key, label, count, note, expandable) {
  return '<section class="vrow" data-row="' + esc(key) + '">' +
    '<div class="vrow-head"><h2 class="vrow-title">' + esc(label) + '</h2>' +
      (count ? '<span class="vrow-count">' + count + '</span>' : '') +
      // A rail is a preview, not a ceiling. Twenty films is where a shelf
      // starts; the canon alone runs to a thousand.
      (expandable ? '<button class="vrow-all" data-shelf-all="' + esc(key) + '">See all</button>' : '') +
      // A row called "Trending" explains nothing. A row called "New Hollywood"
      // with a line under it is a recommendation from someone with a view.
      (note ? '<p class="vrow-note">' + esc(note) + '</p>' : '') + '</div>' +
    '<div class="vrail-wrap">' +
      '<button class="vrail-nav vrail-prev" aria-label="Scroll left" hidden>' + _VICON.left + '</button>' +
      '<div class="vrail" data-rail="' + esc(key) + '">' + _vRailSkeleton() + '</div>' +
      '<button class="vrail-nav vrail-next" aria-label="Scroll right" hidden>' + _VICON.right + '</button>' +
    '</div>' +
  '</section>'
}

function _vRailSkeleton(n) {
  let out = ''
  for (let i = 0; i < (n || 7); i++) {
    out += '<div><div class="vskel vskel-card"></div><div class="vskel vskel-line"></div><div class="vskel vskel-line short"></div></div>'
  }
  return out
}

function _vHeroSkeleton() {
  return '<div class="vhero"><div class="vskel vskel-hero"></div></div>'
}

function _rowMsg(key, html, isError) {
  const row = document.querySelector('.vrow[data-row="' + key + '"] .vrail-wrap')
  if (!row) return
  row.outerHTML = '<div class="vrow-msg' + (isError ? ' err' : '') + '">' + html + '</div>'
}

function _rowEmpty(key, text) { _rowMsg(key, esc(text), false) }

function _rowError(key, error) {
  _rowMsg(key, esc(_videoErrorText(error)) +
    '<div><button class="vbtn" data-retry="' + esc(key) + '">Try again</button></div>', true)
  const btn = document.querySelector('[data-retry="' + key + '"]')
  if (btn) btn.addEventListener('click', function () { _renderVideoTab(++_videoCatalogTicket) })
}

// Delegated once per page rather than bound per shelf, because the buttons are
// created as each shelf's results arrive rather than up front.
function _bindShelfExpanders(root) {
  if (!root || root.dataset.shelfAllBound === '1') return
  root.dataset.shelfAllBound = '1'
  root.addEventListener('click', function (ev) {
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-shelf-all]')
    if (!btn) return
    ev.preventDefault()
    navigate('shelf', btn.getAttribute('data-shelf-all'))
  })
}

// The label and the line beneath it arrive with the results.
function _setRowHead(key, shelf) {
  if (!shelf) return
  const row = document.querySelector('.vrow[data-row="' + key + '"]')
  if (!row) return
  const title = row.querySelector('.vrow-title')
  if (title) title.textContent = shelf.label || ''
  const head = row.querySelector('.vrow-head')
  if (head && shelf.note && !head.querySelector('.vrow-note')) {
    const p = document.createElement('p')
    p.className = 'vrow-note'
    p.textContent = shelf.note
    head.appendChild(p)
  }
}

// An empty shelf is worse than no shelf: it reads as a failure of the app
// rather than as an absence of films.
function _dropRow(key) {
  const row = document.querySelector('.vrow[data-row="' + key + '"]')
  if (row) row.remove()
}

function _fillRow(key, items) {
  const rail = document.querySelector('.vrail[data-rail="' + key + '"]')
  if (!rail) return
  rail.innerHTML = items.map(_videoCard).join('')
  _bindVideoCards(rail)
  _bindRail(rail)
}

// Arrow visibility is driven by actual scroll position, so a rail that fits
// on screen never shows a control that would do nothing.
function _bindRail(rail) {
  const wrap = rail.closest('.vrail-wrap')
  if (!wrap) return
  const prev = wrap.querySelector('.vrail-prev')
  const next = wrap.querySelector('.vrail-next')
  const sync = function () {
    const max = rail.scrollWidth - rail.clientWidth
    if (prev) prev.hidden = rail.scrollLeft <= 4
    if (next) next.hidden = rail.scrollLeft >= max - 4
  }
  const page = function (dir) { rail.scrollBy({ left: dir * Math.max(rail.clientWidth - 120, 200) }) }
  prev?.addEventListener('click', function () { page(-1) })
  next?.addEventListener('click', function () { page(1) })
  rail.addEventListener('scroll', sync, { passive: true })
  requestAnimationFrame(sync)
}

// ── Hero spotlight ──────────────────────────────────────────────────────────
function _startVideoHero(items, ticket) {
  const pool = items.filter(function (i) { return i && i.backdrop })
  if (!pool.length) {
    const mount = document.getElementById('vhero-mount')
    if (mount) mount.innerHTML = ''
    return
  }
  _videoHero.items = pool.slice(0, 5)
  _videoHero.index = 0
  _paintVideoHero()
  _stopVideoHero()
  _videoHero.timer = setInterval(function () {
    if (_videoCatalogTicket !== ticket || state.currentPage !== 'video') return _stopVideoHero()
    _videoHero.index = (_videoHero.index + 1) % _videoHero.items.length
    _paintVideoHero()
  }, 9000)
}

function _stopVideoHero() {
  if (_videoHero.timer) { clearInterval(_videoHero.timer); _videoHero.timer = null }
}

function _paintVideoHero() {
  const mount = document.getElementById('vhero-mount')
  const item = _videoHero.items[_videoHero.index]
  if (!mount || !item) return
  const key = (item.type || 'movie') + ':' + (item.id == null ? '' : item.id)
  const kind = item.type === 'anime' ? 'Anime' : item.type === 'tv' ? 'Series' : 'Film'
  const bits = []
  if (item.year != null) bits.push(esc(String(item.year)))
  bits.push(kind)
  if (item.rating != null) bits.push('★ ' + esc(String(Math.round(item.rating * 10) / 10)))
  const dots = _videoHero.items.map(function (_, i) {
    return '<button class="vhero-dot' + (i === _videoHero.index ? ' active' : '') +
      '" data-hero="' + i + '" aria-label="Feature ' + (i + 1) + '"></button>'
  }).join('')

  mount.innerHTML = '<div class="vhero">' +
    '<img class="vhero-bg" alt="" src="' + esc(item.backdrop) + '">' +
    '<div class="vhero-scrim"></div>' +
    '<div class="vhero-body">' +
      '<div class="vhero-kicker">Featured</div>' +
      '<h1 class="vhero-title">' + esc(item.title || 'Untitled') + '</h1>' +
      '<div class="vhero-meta">' + bits.join(' · ') + '</div>' +
      (item.overview ? '<p class="vhero-overview">' + esc(_stripTags(item.overview)) + '</p>' : '') +
      '<div class="vhero-actions">' +
        '<button class="vbtn vbtn-primary" id="vhero-play">' + _VICON.play + 'Play</button>' +
        '<button class="vbtn" id="vhero-list">' + _VICON.plus + 'My List</button>' +
        '<button class="vbtn" id="vhero-info">' + _VICON.info + 'Details</button>' +
      '</div>' +
    '</div>' +
    '<div class="vhero-dots">' + dots + '</div>' +
  '</div>'

  const img = mount.querySelector('.vhero-bg')
  if (img) {
    if (img.complete) img.classList.add('ready')
    else img.addEventListener('load', function () { img.classList.add('ready') })
    img.addEventListener('error', function () { img.remove() })
  }
  const go = function () { navigate('video-detail', key) }
  document.getElementById('vhero-play')?.addEventListener('click', go)
  document.getElementById('vhero-info')?.addEventListener('click', go)
  document.getElementById('vhero-list')?.addEventListener('click', function () { _toggleWatchlist(item) })
  mount.querySelectorAll('.vhero-dot').forEach(function (d) {
    d.addEventListener('click', function () {
      _videoHero.index = Number(d.dataset.hero) || 0
      _paintVideoHero()
    })
  })
}

// AniList overviews are HTML fragments (<br>, <i>), unlike TMDB's plain text.
function _stripTags(text) {
  return String(text == null ? '' : text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function _toggleWatchlist(item) {
  const store = _vStore()
  if (!store) return showToast('Watchlist is not available yet')
  try {
    const type = item.type || 'movie'
    // toggleWatchlist returns the new list, not a boolean, and an array is
    // always truthy — asking the store afterwards is the only honest answer.
    store.toggleWatchlist({ type: type, id: item.id, title: item.title, poster: item.poster || null })
    const added = store.inWatchlist(type, item.id)
    showToast(added ? 'Added to My List' : 'Removed from My List')
    document.querySelectorAll('.vcard-act-list[data-key="' + (item.type || 'movie') + ':' + item.id + '"]')
      .forEach(function (b) { b.classList.toggle('on', added); b.innerHTML = added ? _VICON.check : _VICON.plus })
  } catch (_) { showToast('Could not update My List') }
}

function _renderMyList(rows) {
  const store = _vStore()
  const list = store ? (store.watchlist() || []) : []
  if (!list.length) {
    rows.innerHTML = '<div class="vempty">' +
      '<div class="vempty-icon">☆</div>' +
      '<div class="vempty-title">Nothing saved yet</div>' +
      '<div class="vempty-text">Add films and series here from any poster or detail page, and they will be waiting for you.</div>' +
      '<button class="vbtn vbtn-primary" id="vempty-browse">Browse</button>' +
    '</div>'
    document.getElementById('vempty-browse')?.addEventListener('click', function () {
      _videoTab = 'all'
      renderVideo()
    })
    return
  }
  rows.innerHTML = _vRowShell('mylist', 'My List', list.length)
  _fillRow('mylist', list)
}

// Search overlays the catalog instead of replacing it, groups results by type,
// and is ticketed so a slow earlier query cannot overwrite a later one.
function _bindVideoSearch() {
  const input = document.getElementById('video-search-input')
  const clear = document.getElementById('video-search-clear')
  if (!input) return
  let timer = null

  const reset = function () {
    _videoSearchTicket++
    const box = document.getElementById('video-search-results')
    if (box) box.innerHTML = ''
    document.getElementById('vrows')?.style.removeProperty('display')
    document.getElementById('vhero-mount')?.style.removeProperty('display')
    if (clear) clear.hidden = true
  }

  const run = function () {
    const query = input.value.trim()
    if (clear) clear.hidden = !query
    if (!query) return reset()
    _runVideoTitleSearch(query)
  }

  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300) })
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      clearTimeout(timer)
      const query = input.value.trim()
      // Enter is the commit. A query that describes a kind of film goes to
      // Browse; anything else is a title and searches as it always did.
      if (query && _actOnParsedQuery(_parseVideoQuery(query))) return
      run()
    }
    if (e.key === 'Escape') { input.value = ''; reset(); input.blur() }
  })
  clear?.addEventListener('click', function () { input.value = ''; reset(); input.focus() })
}

// The title search, unchanged, lifted out so the parsed path can fall back to
// it when a name turns out not to be a person.
function _runVideoTitleSearch(query) {
    const box = document.getElementById('video-search-results')
    if (!box) return
    const ticket = ++_videoSearchTicket
    // Hide rather than unmount, so clearing the query restores the catalog
    // instantly without refetching every row.
    const rows = document.getElementById('vrows')
    const hero = document.getElementById('vhero-mount')
    if (rows) rows.style.display = 'none'
    if (hero) hero.style.display = 'none'
    box.innerHTML = _vRowShell('search', 'Searching…', 0)

    window.api.videoSearch({ query: query, type: 'all' })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
      .then(function (res) {
        if (_videoSearchTicket !== ticket) return
        const target = document.getElementById('video-search-results')
        if (!target) return
        if (!res.ok) {
          target.innerHTML = '<div class="vrow-msg err">' + esc(_videoErrorText(res.error)) + '</div>'
          return
        }
        const results = Array.isArray(res.results) ? res.results : []
        if (!results.length) {
          target.innerHTML = '<div class="vempty">' +
            '<div class="vempty-icon">◎</div>' +
            '<div class="vempty-title">No matches for &ldquo;' + esc(query) + '&rdquo;</div>' +
            '<div class="vempty-text">Check the spelling, or try the original-language title — anime in particular is often indexed under its romaji name.</div>' +
          '</div>'
          return
        }
        // Grouped, because a film, a series and an anime are different answers
        // to the same query and a single flat grid hides that.
        const groups = [
          { key: 'movie', label: 'Films' },
          { key: 'tv',    label: 'Series' },
          { key: 'anime', label: 'Anime' },
        ]
        let html = ''
        for (const g of groups) {
          const items = results.filter(function (r) { return (r.type || 'movie') === g.key })
          if (!items.length) continue
          html += _vRowShell('search-' + g.key, g.label, items.length)
        }
        target.innerHTML = html
        for (const g of groups) {
          const items = results.filter(function (r) { return (r.type || 'movie') === g.key })
          if (items.length) _fillRow('search-' + g.key, items)
        }
      })
}

// ── Parsed search ───────────────────────────────────────────────────────────
// video-query.js has been able to read "1970s thrillers" and "korean films from
// the 90s" since phase 6 and nothing called it. The search box did one thing:
// a title lookup. So a query describing a KIND of film — which is how a
// cinephile actually looks — returned "No matches" for a perfectly good ask.
//
// The parse is offered, never imposed. Typing still runs the title search it
// always did, and when the parse finds something the app says out loud what it
// understood and lets you take it. A search box that silently redirects is
// worse than one that does too little, because you cannot tell it what you
// meant.

// The parser speaks TMDB's sort vocabulary; Browse has its own keys.
const _QUERY_SORTS = {
  'rating.desc': 'rating',
  'popularity.desc': 'popularity',
  'release.desc': 'newest',
  'release.asc': 'oldest',
}

function _parseVideoQuery(text) {
  if (!window.PapaVideoQuery) return null
  try { return window.PapaVideoQuery.parse(text) } catch (_) { return null }
}

// Below this the parse is a guess, and a guess that reroutes the page is worse
// than no guess. Measured against the verified set in the plan: the shapes that
// should act land at 0.85 and above, and every bare title lands at 0.
const QUERY_MIN_CONFIDENCE = 0.6

// What Browse can actually express. movement, keyword, similarTo and minVotes
// are parsed and have nowhere to go yet; they are listed here so the next
// person sees a decision rather than an omission.
const _BROWSE_FILTER_KEYS = [
  'yearFrom', 'yearTo', 'runtimeFrom', 'runtimeTo', 'minRating', 'country', 'genres',
]

function _queryBrowseFilters(parsed) {
  if (!parsed) return null
  const f = parsed.filters || {}
  const out = {}
  let any = false
  for (const k of _BROWSE_FILTER_KEYS) {
    const v = f[k]
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) { if (!v.length) continue }
    out[k] = Array.isArray(v) ? v.slice() : v
    any = true
  }
  const sort = _QUERY_SORTS[f.sort]
  if (sort) { out.sort = sort; any = true }
  if (f.catalog) { out.catalog = f.catalog; any = true }
  return any ? out : null
}

// A one-line statement of what was understood, in the words the app uses
// elsewhere. Written from the intents rather than the filters so it reads in
// the order the query was typed.
function _querySummary(parsed) {
  const f = parsed.filters || {}
  const bits = []
  if (f.catalog) bits.push(f.catalog === 'tv' ? 'series' : f.catalog === 'anime' ? 'anime' : 'films')
  if (f.country) bits.push('from ' + esc(_countryName(f.country)))
  if (Array.isArray(f.genres) && f.genres.length) bits.push(f.genres.map(esc).join(' + '))
  if (f.yearFrom && f.yearTo && f.yearFrom !== f.yearTo) bits.push(f.yearFrom + '\u2013' + f.yearTo)
  else if (f.yearFrom) bits.push(String(f.yearFrom))
  if (f.runtimeTo) bits.push('under ' + f.runtimeTo + ' min')
  if (f.runtimeFrom) bits.push('over ' + f.runtimeFrom + ' min')
  if (f.minRating) bits.push(f.minRating + '+ rated')
  if (_QUERY_SORTS[f.sort]) bits.push(_QUERY_SORTS[f.sort] === 'rating' ? 'best first' : 'newest first')
  return bits.join(' \u00b7 ')
}

function _countryName(code) {
  const list = (_browseVocab && _browseVocab.countries) || null
  if (Array.isArray(list)) {
    const hit = list.find(function (c) { return c && (c.code === code || c.iso_3166_1 === code) })
    if (hit) return hit.name || hit.english_name || code
  }
  return code
}

// Returns true if it took the query somewhere. The caller falls back to the
// title search when it did not.
function _actOnParsedQuery(parsed) {
  if (!parsed || parsed.confidence < QUERY_MIN_CONFIDENCE) return false
  const f = parsed.filters || {}

  // A named person is a page of its own, and it answers the question better
  // than a filtered grid: a director's whole filmography, ranked.
  if (f.personName) { _openPersonByName(f.personName, parsed); return true }

  const filters = _queryBrowseFilters(parsed)
  if (!filters) return false

  // Browse's own defaults for everything the query did not mention, so a
  // previous search's leftovers cannot leak into this one.
  //
  // The genres are carried as NAMES and resolved to ids by renderBrowse once the
  // genre vocabulary has loaded. The parser speaks in names — "Thriller" — and
  // TMDB's with_genres takes numeric ids, so putting the name straight into
  // filters.genres sent `with_genres=Thriller` and the genre half of every
  // parsed query was silently dropped.
  const names = Array.isArray(filters.genres) ? filters.genres.slice() : []
  delete filters.genres
  _browse.filters = Object.assign(_emptyFilters(), filters)
  _browse.pendingGenreNames = names
  _browse.page = 1
  _browse.results = []
  _videoTab = 'browse'
  navigate('browse')
  // Said after the navigation, so it appears over the page it describes.
  const summary = _querySummary(parsed)
  if (summary) showSnackbar('Showing ' + summary, null, null, 4000)
  return true
}

// The parser cannot tell a surname from a title -- "drive" is a film and
// "kurosawa" is a person -- so a bare word stays residual on purpose. A cued
// person ("films by kurosawa") is unambiguous and resolves here.
async function _openPersonByName(name, parsed) {
  const ticket = ++_videoSearchTicket
  const res = await window.api.videoPerson({ query: name })
    .catch(function () { return { ok: false } })
  if (_videoSearchTicket !== ticket) return
  const people = (res && res.ok && Array.isArray(res.people)) ? res.people : []
  if (!people.length) {
    // No such person: the words might still be a title, so hand them back to
    // the search that was already running rather than showing nothing.
    showSnackbar('No one called \u201c' + name + '\u201d \u2014 searching titles instead', null, null, 4000)
    _runVideoTitleSearch(name)
    return
  }
  navigate('person', String(people[0].id))
}

function _videoCard(item) {
  item = item || {}
  const key = (item.type || 'movie') + ':' + (item.id == null ? '' : item.id)
  const img = item.poster
    ? '<img class="vcard-poster" src="' + esc(item.poster) + '" alt="" loading="lazy" decoding="async"' +
      ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
    : ''
  const fb = '<div class="vcard-fallback"' + (item.poster ? ' style="display:none"' : '') + '>' + esc(item.title || '') + '</div>'
  const kind = item.type === 'anime' ? 'Anime' : item.type === 'tv' ? 'TV' : 'Movie'

  const badges = []
  if (item.rating != null && Number(item.rating) > 0) {
    const r = Number(item.rating)
    // AniList scores 0-100, TMDB 0-10. Normalise so one badge means one thing.
    badges.push('<span class="vbadge vbadge-rating">★ ' + esc(String(r > 10 ? Math.round(r / 10 * 10) / 10 : Math.round(r * 10) / 10)) + '</span>')
  }
  badges.push('<span class="vbadge vbadge-type">' + kind + '</span>')

  const pct = item.position && item.duration ? Math.min(100, Math.round(item.position / item.duration * 100)) : 0
  const progress = pct > 1 ? '<div class="vcard-progress"><i style="width:' + pct + '%"></i></div>' : ''

  const inList = (function () {
    const store = _vStore()
    try { return store ? !!store.inWatchlist(item.type || 'movie', item.id) : false } catch (_) { return false }
  })()

  const metaBits = []
  if (item.year != null && item.year !== '') metaBits.push(esc(String(item.year)))
  if (item.season != null && item.episode != null) metaBits.push('S' + item.season + ' · E' + item.episode)

  return '<article class="vcard" data-video="' + esc(key) + '" tabindex="0" role="button"' +
      ' aria-label="' + esc(item.title || 'Untitled') + '">' +
    '<div class="vcard-art">' + img + fb +
      '<div class="vcard-badges">' + badges.join('') + '</div>' +
      progress +
      '<div class="vcard-actions">' +
        '<button class="vcard-act vcard-act-play" data-act="play" aria-label="Play">' + _VICON.play + '</button>' +
        '<button class="vcard-act vcard-act-list' + (inList ? ' on' : '') + '" data-act="list" data-key="' + esc(key) + '"' +
          ' aria-label="' + (inList ? 'Remove from My List' : 'Add to My List') + '">' + (inList ? _VICON.check : _VICON.plus) + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="vcard-title">' + esc(item.title || 'Untitled') + '</div>' +
    '<div class="vcard-meta">' + (metaBits.join(' · ') || kind) + '</div>' +
    // Filled in later, only for cards that reach the screen. The slots exist
    // from the start so a card does not change height when its metadata
    // arrives — a shelf that reflows under the pointer is worse than one that
    // never enriches at all.
    '<div class="vcard-credit" data-credit></div>' +
    _vRatesHtml(null) +
  '</article>'
}

// Three sources on three different scales — IMDb out of ten, Rotten Tomatoes a
// percentage, Metacritic out of a hundred — read as unrelated numbers when they
// sit side by side. Each keeps its own figure against a bar normalised to a
// common scale: the bar answers "is this good" before you read anything, the
// number answers "how good, on what scale". The source initials are always
// drawn, so the colours distinguish the columns without ever being the only
// thing that carries the meaning.
const _VRATE_SOURCES = [
  { key: 'imdb', cls: 'vrate-imdb', src: 'IMDb', max: 10, fmt: v => v.toFixed(1) },
  { key: 'rottenTomatoes', cls: 'vrate-rt', src: 'RT', max: 100, fmt: v => Math.round(v) + '%' },
  { key: 'metacritic', cls: 'vrate-mc', src: 'MC', max: 100, fmt: v => String(Math.round(v)) },
]

function _vRatesHtml(meta) {
  const m = meta || {}
  return '<div class="vcard-rates" data-rates>' + _VRATE_SOURCES.map(function (s) {
    const raw = m[s.key]
    const has = typeof raw === 'number' && isFinite(raw) && raw > 0
    const pct = has ? Math.max(0, Math.min(100, (raw / s.max) * 100)) : 0
    return '<div class="vrate ' + s.cls + (has ? '' : ' is-empty') + '">' +
      '<div class="vrate-head">' +
        '<span class="vrate-src">' + s.src + '</span>' +
        '<span class="vrate-val">' + (has ? esc(s.fmt(raw)) : '—') + '</span>' +
      '</div>' +
      '<div class="vrate-bar"><i style="width:' + pct + '%"></i></div>' +
    '</div>'
  }).join('') + '</div>'
}

// The credit line a cinephile reads first: who made it, how long it is, and
// what it is rated.
function _vCreditHtml(meta) {
  const m = meta || {}
  const bits = []
  if (Array.isArray(m.directors) && m.directors.length) bits.push(esc(m.directors.join(', ')))
  if (m.runtime) bits.push(esc(_vRuntime(m.runtime)))
  const cert = m.certification ? '<span class="vcard-cert">' + esc(m.certification) + '</span>' : ''
  return bits.join('<span class="sep">·</span>') + (bits.length && cert ? '<span class="sep">·</span>' : '') + cert
}

// "1h 55m" rather than "115 min": the question a runtime answers is whether
// tonight is long enough, and hours are how people think about that.
function _vRuntime(mins) {
  const n = Number(mins) || 0
  if (n <= 0) return ''
  const h = Math.floor(n / 60)
  const m = n % 60
  return h ? (m ? h + 'h ' + m + 'm' : h + 'h') : m + 'm'
}

// ── Trailer on hover ────────────────────────────────────────────────────────
// Muted, looping, inside the card, and only after you have clearly stopped on
// it. Three things make this honest rather than annoying:
//
//   1. Dwell, not entry. A pointer crossing a rail passes over eight cards; a
//      preview that starts on mouseenter starts eight of them. HOVER_DWELL_MS
//      is the difference between "the cursor went past" and "you are looking at
//      this".
//
//   2. Resolving a YouTube trailer runs yt-dlp, which takes seconds on a cold
//      cache. So the first hover over a card usually shows nothing and warms
//      the cache instead; the next one is instant. A slow answer is dropped
//      rather than played into a card the pointer has already left — the
//      alternative is a video starting somewhere you are no longer looking.
//
//   3. It is a setting, and it can be off. Autoplay on hover is the kind of
//      thing people either love or want gone immediately, and guessing which
//      is not a decision to make on someone's behalf.
//
// Touch is excluded entirely: there is no hover, and a tap must open the film.
const HOVER_DWELL_MS = 650
const HOVER_TRAILER_KEY = 'papa_hover_trailers'
var _hoverTrailersOn = true
var _hoverTimer = null
var _hoverCard = null
var _hoverTicket = 0

function restoreHoverTrailerPref() {
  try {
    const v = localStorage.getItem(HOVER_TRAILER_KEY)
    // Absent means on: the plan asks for this feature, so it is the default.
    _hoverTrailersOn = v === null ? true : v === '1'
  } catch (_) { _hoverTrailersOn = true }
}

function setHoverTrailers(on) {
  _hoverTrailersOn = !!on
  try { localStorage.setItem(HOVER_TRAILER_KEY, _hoverTrailersOn ? '1' : '0') } catch (_) {}
  if (!_hoverTrailersOn) _stopHoverTrailer()
}

function _hoverTrailerAllowed() {
  if (!_hoverTrailersOn) return false
  // The theatre is modal and has its own audio; a preview behind it is noise.
  const theatre = document.getElementById('vtheatre')
  if (theatre && !theatre.classList.contains('hidden')) return false
  // Nor while the music player is going: two things playing at once is never
  // what anyone meant, even muted, because the preview steals attention.
  if (state.isPlaying) return false
  return true
}

function _stopHoverTrailer() {
  clearTimeout(_hoverTimer)
  _hoverTimer = null
  _hoverTicket++
  if (_hoverCard) {
    const v = _hoverCard.querySelector('.vcard-preview')
    if (v) {
      // Emptying the source as well as pausing: a paused <video> keeps its
      // buffer, and a rail of them would hold several hundred megabytes.
      try { v.pause() } catch (_) {}
      v.removeAttribute('src')
      try { v.load() } catch (_) {}
      v.remove()
    }
    _hoverCard.classList.remove('is-previewing', 'is-preview-loading')
    _hoverCard = null
  }
}

function _bindHoverTrailer(card) {
  if (!card || card.dataset.hoverBound === '1') return
  card.dataset.hoverBound = '1'

  card.addEventListener('pointerenter', function (e) {
    // Mouse and pen only. A touch "hover" is a tap on its way to opening the
    // film, and a preview would fight it.
    if (e.pointerType === 'touch') return
    if (!_hoverTrailerAllowed()) return
    clearTimeout(_hoverTimer)
    _hoverTimer = setTimeout(function () { _startHoverTrailer(card) }, HOVER_DWELL_MS)
  })
  card.addEventListener('pointerleave', function () {
    if (_hoverCard === card || _hoverTimer) _stopHoverTrailer()
  })
  // Opening the film, or moving focus away, both end the preview.
  card.addEventListener('click', function () { _stopHoverTrailer() })
  card.addEventListener('blur', function () { if (_hoverCard === card) _stopHoverTrailer() })
}

async function _startHoverTrailer(card) {
  if (!card.isConnected || !_hoverTrailerAllowed()) return
  const nav = String(card.dataset.video || '')
  const parts = nav.split(':')
  if (parts.length < 2) return
  const ticket = ++_hoverTicket
  _hoverCard = card
  card.classList.add('is-preview-loading')

  const res = await window.api.videoTrailerUrl({ type: parts[0], id: parts.slice(1).join(':') })
    .catch(function () { return { ok: false } })

  // Everything that can have changed while yt-dlp was running.
  if (_hoverTicket !== ticket) return
  card.classList.remove('is-preview-loading')
  if (!card.isConnected || !_hoverTrailerAllowed()) return _stopHoverTrailer()
  if (!res || !res.ok || !res.url) {
    // No trailer, or not resolvable. Nothing to say: a card that flashes an
    // error because you looked at it would be worse than silence.
    _hoverCard = null
    return
  }

  const art = card.querySelector('.vcard-art') || card
  const v = document.createElement('video')
  v.className = 'vcard-preview'
  v.muted = true
  v.loop = true
  v.playsInline = true
  v.preload = 'auto'
  // No controls and no pointer target: the card is still the click surface.
  v.setAttribute('aria-hidden', 'true')
  v.src = res.url
  art.appendChild(v)
  card.classList.add('is-previewing')
  // A rejected play() is normal — an autoplay policy, or the pointer left
  // between appending and playing.
  v.play().catch(function () {
    if (_hoverTicket === ticket) _stopHoverTrailer()
  })
}

function _bindVideoCards(root) {
  // Binding is the one thing every card insertion has in common, so the queue
  // is joined here rather than at each of the half-dozen call sites.
  _observeCards(root)
  ;(root || document).querySelectorAll('.vcard').forEach(function (c) {
    const open = function () { navigate('video-detail', c.dataset.video) }
    c.addEventListener('click', function (e) {
      const act = e.target.closest('[data-act]')
      if (!act) return open()
      e.stopPropagation()
      if (act.dataset.act === 'play') return open()
      const parts = String(c.dataset.video || '').split(':')
      _toggleWatchlist({
        type: parts[0], id: parts.slice(1).join(':'),
        title: c.querySelector('.vcard-title')?.textContent || '',
        poster: c.querySelector('.vcard-poster')?.getAttribute('src') || null,
      })
    })
    // A card is a button, so it must answer to Enter and Space.
    c.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
    })
    _bindHoverTrailer(c)
  })
}

async function renderVideoDetail(navId) {
  _initVideoUI()
  const parts = String(navId || '').split(':')
  const type = parts[0] || 'movie'
  const id = parts.slice(1).join(':')
  const ticket = ++_videoDetailTicket
  _videoDetail = { type, id, d: null }
  _videoState = { season: null, episode: 1, sub: true }
  _videoStreams = []
  _playing = { dub: null, source: null, quality: null }
  _prefetch = { key: null, streams: null, inflight: false }
  setContent('<div class="page"><div class="skeleton skeleton-card" style="height:280px"></div></div>')

  const res = await window.api.videoDetail({ type, id }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  if (_videoDetailTicket !== ticket) return
  if (!res.ok || !res.detail) {
    _videoError(res.error)
    return
  }
  _videoDetail = { type, id, d: res.detail }
  const d = res.detail
  setContent('<div class="page video-detail-page cinema">' + _videoDetailShell(d) + '</div>')

  _bindTrailerButton()
  _renderCastRow(d)
  _renderTasteSection()
  _renderProviders(d)
  _renderSimilar(d)
  _bindPersonLinks()
  _bindGenreJumps()

  // Not awaited: an anime chain is one request per hop, and the source list
  // must not wait on it.
  _renderSeasonChain(ticket)

  if (type === 'tv') {
    const seasons = Array.isArray(d.seasons) ? d.seasons : []
    const pick = seasons.find(function (s) { return s.seasonNumber >= 1 }) || seasons[0] || null
    _videoState.season = pick ? pick.seasonNumber : 1
    _renderVideoControls(type)
    await _refreshTvEpisodes(ticket, ++_videoSeasonTicket)
  } else if (type === 'anime') {
    _renderVideoControls(type)
    await _loadVideoSources(ticket, ++_videoSeasonTicket)
  } else {
    // A film reaches here. It was skipping the controls entirely, which is why
    // an anime film — or any foreign film with a dub — had no way to ask for
    // one even after the toggle was made shared.
    _renderVideoControls(type)
    await _loadVideoSources(ticket, ++_videoSeasonTicket)
  }
}

function _videoDetailShell(d) {
  const backdrop = d.backdrop
  const poster = d.poster
  const genres = Array.isArray(d.genres) ? d.genres : []
  const rating = d.rating != null ? (typeof d.rating === 'number' ? (Math.round(d.rating * 10) / 10) : d.rating) : null
  const kind = d.type === 'anime' ? 'Anime' : d.type === 'tv' ? 'TV Series' : 'Movie'
  const metaBits = []
  if (d.year != null) metaBits.push(esc(String(d.year)))
  metaBits.push(kind)
  if (rating != null) metaBits.push('★ ' + esc(String(rating)))
  const hero = '<div class="video-detail-hero"' + (backdrop ? ' style="background-image:url(\'' + esc(backdrop) + '\')"' : '') + '>' +
    '<div class="video-detail-overlay"></div>' +
    (poster ? '<img class="video-detail-poster" src="' + esc(poster) + '" alt="" onerror="this.style.display=\'none\'">' : '<div class="video-detail-poster video-detail-poster-fallback">' + esc(d.title || '') + '</div>') +
    '<div class="video-detail-info">' +
      '<h1 class="video-detail-title">' + esc(d.title || 'Untitled') + '</h1>' +
      '<div class="video-detail-meta">' + metaBits.join(' · ') + '</div>' +
      (d.tagline ? '<div class="vdet-tagline">' + esc(d.tagline) + '</div>' : '') +
      _externalRatingsHtml(d) +
      _videoFactsHtml(d) +
      (genres.length ? '<div class="video-detail-genres">' + genres.map(function (g) {
        return '<button class="video-genre-chip" data-genre-jump="' + esc(g) + '" title="Browse ' + esc(g) + '">' + esc(g) + '</button>'
      }).join('') + '</div>' : '') +
      (d.overview ? '<p class="video-detail-overview">' + esc(d.overview) + '</p>' : '') +
      _videoCrewHtml(d) +
      (_bestTrailer(d) ? '<div class="vhero-actions" style="margin-top:12px">' +
        '<button class="vbtn" id="video-trailer-btn">' + _VICON.play + 'Trailer</button></div>' : '') +
    '</div>' +
  '</div>'
  return hero +
    '<div class="vseasons" id="vseasons" hidden></div>' +
    '<div id="vcast"></div>' +
    '<div id="vtaste"></div>' +
    '<div id="vwatch"></div>' +
    '<div id="vsimilar"></div>' +
    '<div class="video-controls" id="video-controls"></div>' +
    '<div class="video-sources" id="video-sources"></div>'
}

// The other entries in this series. For anime that is the PREQUEL/SEQUEL chain
// walked from AniList relations, because each season is a separate entry with
// its own id. For a film it is the franchise. TV needs none of this: TMDB
// already nests seasons inside the show, and the season picker handles them.
async function _renderSeasonChain(ticket) {
  const box = document.getElementById('vseasons')
  const detail = _videoDetail
  if (!box || !detail || !detail.d) return

  let items = []
  let label = ''
  let currentId = detail.d.id

  if (detail.type === 'anime') {
    const res = await window.api.videoSeasons({ type: 'anime', id: detail.d.id })
      .catch(function () { return { ok: false } })
    if (_videoDetailTicket !== ticket) return
    items = (res && res.ok && Array.isArray(res.seasons)) ? res.seasons : []
    label = 'Seasons'
  } else if (detail.type === 'movie' && detail.d.collection && detail.d.collection.id) {
    const res = await window.api.videoCollection({ id: detail.d.collection.id })
      .catch(function () { return { ok: false } })
    if (_videoDetailTicket !== ticket) return
    const parts = res && res.ok && res.collection && Array.isArray(res.collection.parts)
      ? res.collection.parts : []
    items = parts.map(function (p) {
      return { id: p.id, title: p.title, year: p.year, poster: p.poster, format: null, episodeCount: null }
    })
    label = detail.d.collection.name || 'Collection'
  }

  // One entry is just this title; a list of one is noise.
  if (items.length < 2) { box.hidden = true; box.innerHTML = ''; return }

  const store = _vStore()
  box.hidden = false
  box.innerHTML = '<div class="vseasons-head">' +
      '<span class="vseasons-title">' + esc(label) + '</span>' +
      '<span class="vseasons-count">' + items.length + '</span>' +
    '</div>' +
    '<div class="vseason-rail">' + items.map(function (item, i) {
      const isCurrent = String(item.id) === String(currentId)
      const bits = []
      if (item.year) bits.push(esc(String(item.year)))
      if (item.format) bits.push(esc(item.format))
      if (item.episodeCount) bits.push(item.episodeCount + ' ep')
      // Watched state comes from whatever has been played of this entry, so
      // the run shows how far through it you are.
      let watched = ''
      try {
        if (store && detail.type === 'movie' && store.get('movie:' + item.id)?.watched) watched = 'Watched'
      } catch (_) { /* a broken store must not break the list */ }
      const art = item.poster
        ? '<img class="vseason-art" src="' + esc(item.poster) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="vseason-art"></div>'
      return '<button type="button" class="vseason' + (isCurrent ? ' current' : '') + '"' +
          ' data-season-id="' + esc(item.id) + '"' +
          (isCurrent ? ' aria-current="true"' : '') +
          ' aria-label="' + esc(item.title || '') + (isCurrent ? ' (current)' : '') + '">' +
        art +
        '<div class="vseason-body">' +
          '<div class="vseason-n">' + (isCurrent ? 'Watching' : 'Part ' + (i + 1)) + '</div>' +
          '<div class="vseason-name">' + esc(item.title || 'Untitled') + '</div>' +
          '<div class="vseason-meta">' + bits.join(' · ') +
            (watched ? ' <span class="vseason-watched">' + watched + '</span>' : '') + '</div>' +
        '</div>' +
      '</button>'
    }).join('') + '</div>'

  box.querySelectorAll('.vseason').forEach(function (b) {
    b.addEventListener('click', function () {
      const id = b.dataset.seasonId
      if (String(id) === String(currentId)) return
      navigate('video-detail', detail.type + ':' + id)
    })
  })
  // Bring the entry being watched into view; in a long run it is often
  // scrolled off the left.
  const cur = box.querySelector('.vseason.current')
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' })
}

// Runtime, certification, studio and language — all fetched with the detail
// and none of it previously shown.
function _videoFactsHtml(d) {
  const facts = []
  if (d.certification) facts.push('<span class="vfact vfact-cert">' + esc(d.certification) + '</span>')
  if (d.runtime) facts.push('<span class="vfact">' + _fmtRuntime(d.runtime) + '</span>')
  if (d.episodeCount) facts.push('<span class="vfact">' + d.episodeCount + ' episodes</span>')
  if (d.status && d.type === 'anime') facts.push('<span class="vfact">' + esc(_animeStatus(d.status)) + '</span>')
  const studios = Array.isArray(d.studios) ? d.studios.slice(0, 2) : []
  for (const st of studios) facts.push('<span class="vfact">' + esc(st) + '</span>')
  const langs = Array.isArray(d.languages) ? d.languages.slice(0, 1) : []
  for (const l of langs) facts.push('<span class="vfact">' + esc(l) + '</span>')
  return facts.length ? '<div class="vdet-facts">' + facts.join('') + '</div>' : ''
}

// Hours and minutes, because "166 min" makes the reader do the arithmetic.
function _fmtRuntime(mins) {
  const n = Number(mins)
  if (!Number.isFinite(n) || n <= 0) return ''
  const h = Math.floor(n / 60)
  const m = n % 60
  return h ? (m ? h + 'h ' + m + 'm' : h + 'h') : m + 'm'
}

function _animeStatus(status) {
  const map = { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming', CANCELLED: 'Cancelled', HIATUS: 'On hiatus' }
  return map[status] || String(status || '').toLowerCase()
}

// Director and writers. Not a full crew list: those are the two credits a
// viewer actually chooses a film by.
function _videoCrewHtml(d) {
  const crew = Array.isArray(d.crew) ? d.crew : []
  if (!crew.length) return ''
  const pick = jobs => {
    const seen = new Set()
    return crew.filter(function (c) {
      if (!c || jobs.indexOf(c.job) === -1 || seen.has(c.id)) return false
      seen.add(c.id)
      return true
    }).slice(0, 3)
  }
  const directors = pick(['Director'])
  const writers = pick(['Screenplay', 'Writer', 'Story'])
  const bits = []
  const link = list => list.map(function (c) {
    return '<b data-person="' + esc(c.id) + '" style="cursor:pointer">' + esc(c.name) + '</b>'
  }).join(', ')
  if (directors.length) bits.push('Directed by ' + link(directors))
  if (writers.length) bits.push('Written by ' + link(writers))
  return bits.length ? '<div class="vdet-crew">' + bits.join(' · ') + '</div>' : ''
}

// The three outside scores, the awards line and the box office. One score
// averaged from one site's users is a thin basis for choosing what to watch;
// where the three disagree is itself information, and "Won 3 Oscars, 31 wins"
// says more than any of them.
function _externalRatingsHtml(d) {
  const e = d && d.external
  if (!e) return ''
  const parts = []
  const score = function (label, value, suffix) {
    if (value == null) return
    parts.push('<span class="vext"><span class="vext-src">' + label + '</span>' +
      '<span class="vext-val">' + esc(String(value)) + (suffix || '') + '</span></span>')
  }
  score('IMDb', e.imdbRating)
  score('Rotten Tomatoes', e.rottenTomatoes, '%')
  score('Metacritic', e.metascore)
  let html = ''
  if (parts.length) html += '<div class="vext-row">' + parts.join('') + '</div>'
  if (e.awards && e.awards.text) {
    // The headline is kept whole because "Won 3 Oscars" reads better than any
    // count of them, and the count is only there to earn the emphasis.
    html += '<div class="vext-awards' + (e.awards.oscars ? ' has-oscars' : '') + '">' +
      esc(e.awards.text) + '</div>'
  }
  if (e.boxOffice) {
    html += '<div class="vext-box">Box office ' + esc('$' + e.boxOffice.toLocaleString('en-US')) + '</div>'
  }
  return html
}

// A person, with their face. The catalogue calls the field profilePath and this
// read c.profile, so every portrait fell through to a grey circle with a letter
// in it — for the whole life of the page, on every film.
function _personTileHtml(p, sub) {
  const photo = p.profilePath
    ? '<img class="vcast-photo" src="' + esc(p.profilePath) + '" alt="" loading="lazy" decoding="async"' +
      ' onerror="this.classList.add(\'is-missing\')">'
    : '<div class="vcast-photo vcast-photo-fallback">' + esc(String(p.name || '?').charAt(0)) + '</div>'
  return '<button class="vcast" data-person="' + esc(p.id) + '" aria-label="' + esc(p.name) + '">' +
    photo +
    '<div class="vcast-name">' + esc(p.name) + '</div>' +
    (sub ? '<div class="vcast-role">' + esc(sub) + '</div>' : '') +
  '</button>'
}

function _renderCastRow(d) {
  const box = document.getElementById('vcast')
  if (!box) return
  const cast = Array.isArray(d.cast) ? d.cast.filter(function (c) { return c && c.name }).slice(0, 20) : []
  const crew = _keyCrewList(d)
  if (!cast.length && !crew.length) { box.innerHTML = ''; return }
  let html = ''
  // Crew first. A cinephile follows a cinematographer the way other people
  // follow an actor, and the page had no way to tell you who shot a film.
  if (crew.length) {
    html += '<div class="vsection"><div class="vsection-title">Made by</div>' +
      '<div class="vcast-rail">' + crew.map(function (p) { return _personTileHtml(p, p._role) }).join('') +
      '</div></div>'
  }
  if (cast.length) {
    html += '<div class="vsection"><div class="vsection-title">Cast</div>' +
      '<div class="vcast-rail">' + cast.map(function (c) { return _personTileHtml(c, c.character) }).join('') +
      '</div></div>'
  }
  box.innerHTML = html
}

// The five credits worth naming, in the order a person would read them. One
// entry per person even when they held two jobs — Coppola directed and wrote
// The Godfather, and listing him twice says less than listing him once with
// both.
var _CREW_ROLES = [
  ['directors', 'Director'],
  ['writers', 'Writer'],
  ['cinematographers', 'Cinematography'],
  ['composers', 'Music'],
  ['editors', 'Editor'],
]

function _keyCrewList(d) {
  const kc = d && d.keyCrew
  if (!kc) return []
  const byId = new Map()
  for (const [key, role] of _CREW_ROLES) {
    for (const p of (Array.isArray(kc[key]) ? kc[key] : [])) {
      if (!p || !p.name) continue
      const id = p.id != null ? String(p.id) : p.name
      const seen = byId.get(id)
      if (seen) { if (seen._role.indexOf(role) === -1) seen._role += ' · ' + role; continue }
      byId.set(id, Object.assign({}, p, { _role: role }))
    }
  }
  return [...byId.values()].slice(0, 12)
}

// Where a title can be streamed legitimately. Shown because knowing a film is
// on a service you already pay for is worth more than a torrent.
function _renderProviders(d) {
  const box = document.getElementById('vwatch')
  if (!box) return
  const providers = d.providers || {}
  const region = providers.GB || providers.US || providers[Object.keys(providers)[0]] || null
  const names = region ? [].concat(region.flatrate || [], region.free || []) : []
  if (!names.length) { box.innerHTML = ''; return }
  box.innerHTML = '<div class="vsection"><div class="vsection-title">Also streaming on</div>' +
    '<div class="vprov">' + [...new Set(names)].slice(0, 8).map(function (n) {
      return '<span class="vprov-chip">' + esc(n) + '</span>'
    }).join('') + '</div></div>'
}

function _renderSimilar(d) {
  const box = document.getElementById('vsimilar')
  if (!box) return
  const items = (Array.isArray(d.recommendations) && d.recommendations.length ? d.recommendations : d.similar) || []
  const list = items.filter(function (x) { return x && x.id && x.poster }).slice(0, 20)
  if (!list.length) { box.innerHTML = ''; return }
  const label = (Array.isArray(d.recommendations) && d.recommendations.length) ? 'More like this' : 'Similar titles'
  box.innerHTML = _vRowShell('similar', label, list.length)
  _fillRow('similar', list)
}

// A genre chip anywhere opens Browse already filtered to it. TMDB genres are
// numeric ids and AniList's are names, so the chip carries the display name
// and the id is looked up in whichever vocabulary applies.
function _bindGenreJumps(root) {
  ;(root || document).querySelectorAll('[data-genre-jump]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation()
      _jumpToGenre(el.dataset.genreJump, _videoDetail ? _videoDetail.type : 'movie')
    })
  })
}

async function _jumpToGenre(name, type) {
  const catalog = type === 'anime' ? 'anime' : type === 'tv' ? 'tv' : 'movie'
  _browse.filters = _emptyFilters()
  _browse.filters.catalog = catalog
  await _loadBrowseVocab(catalog)
  const list = _browseVocab.genres[catalog] || []
  const hit = list.find(function (g) { return String(g.name).toLowerCase() === String(name).toLowerCase() })
  // A genre the target catalog does not have is not an error: Browse opens
  // unfiltered rather than silently doing nothing.
  if (hit) _browse.filters.genres = [hit.id]
  else showToast('No “' + name + '” genre in this catalog')
  _videoTab = 'browse'
  navigate('browse')
}

// Anything carrying a person id opens that person's filmography.
function _bindPersonLinks(root) {
  ;(root || document).querySelectorAll('[data-person]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation()
      const card = el.closest('.vcast')
      _lastPerson = {
        id: el.dataset.person,
        name: card ? (card.querySelector('.vcast-name')?.textContent || '') : (el.textContent || ''),
        photo: card ? (card.querySelector('.vcast-photo')?.getAttribute('src') || null) : null,
      }
      navigate('person', el.dataset.person)
    })
  })
}

// The best available trailer, whichever catalog this came from. TMDB returns
// a ranked list; AniList returns a single {id, site}. Only YouTube is
// resolvable, so anything else is treated as no trailer rather than offering
// a button that cannot work.
function _bestTrailer(d) {
  if (!d) return null
  if (Array.isArray(d.trailers) && d.trailers.length) {
    const hit = d.trailers.find(function (t) { return t && t.key && (!t.site || t.site === 'YouTube') })
    if (hit) return { youtubeId: hit.key, name: hit.name || null }
  }
  if (d.trailer && d.trailer.id && String(d.trailer.site || '').toLowerCase() === 'youtube') {
    return { youtubeId: d.trailer.id, name: null }
  }
  return null
}

function _bindTrailerButton() {
  const btn = document.getElementById('video-trailer-btn')
  if (!btn) return
  btn.addEventListener('click', async function () {
    const d = _videoDetail && _videoDetail.d
    const t = _bestTrailer(d)
    if (!t) return showToast('No trailer available')
    _initVideoUI()
    // A trailer is not the thing you were watching: nothing is written to the
    // watch store while one plays, and nothing is marked watched.
    _watch = { key: null, meta: null, savedAt: 0, resumed: true }
    _player.setSegments([])
    _player.setUpNext(null)
    _player.open({
      hasNext: false,
      title: (d && d.title ? d.title : 'Trailer'),
      subtitle: t.name || 'Trailer',
    })
    _handleVideoEvent({ kind: 'buffering' })
    btn.disabled = true
    const res = await window.api.videoTrailer({ youtubeId: t.youtubeId, title: d && d.title })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
    btn.disabled = false
    if (res && res.ok === false) _handleVideoEvent({ kind: 'error', message: res.error })
  })
}

// A dub is worth asking for whenever the original is not in English, and the
// biggest case by far is anime — which TMDB files as ordinary television, so it
// arrives through the TV tab and through search as often as through Anime.
// The toggle used to exist only on the Anime tab, which meant a show opened any
// other way had no way to ask for a dub at all, and a film never had one.
function _dubbable(d) {
  if (!d) return false
  // A title from the anime catalogue is anime, whatever else it does or does
  // not carry. AniList sets neither isAnime nor originalLanguage — both come
  // back undefined — so a check written against the film catalogue's fields
  // answered "no" for every anime opened from the Anime tab, which is the one
  // place the toggle had always worked. Widening this control to television and
  // film is what removed it from the catalogue it started on.
  if (d.type === 'anime' || d.isAnime === true) return true
  const lang = String(d.originalLanguage || '').toLowerCase()
  return lang !== '' && lang !== 'en'
}

function _dubControl(d) {
  if (!_dubbable(d)) return ''
  return '<label class="video-control">Dub <input type="checkbox" id="video-dub-toggle"' +
    (_videoState.sub ? '' : ' checked') + '></label>'
}

function _bindDubControl() {
  document.getElementById('video-dub-toggle')?.addEventListener('change', function (e) {
    _videoState.sub = !e.target.checked
    // A dubbed release the user picked by hand should not override the checkbox
    // they just moved.
    _playing.dub = null
    _loadVideoSources(_videoDetailTicket, ++_videoSeasonTicket)
  })
}

function _renderVideoControls(type) {
  const box = document.getElementById('video-controls')
  if (!box) return
  if (type === 'tv') {
    const d = _videoDetail.d
    // Season 0 is TMDB's bucket for specials, OVAs and recap episodes. It came
    // first purely because it sorts first, so the picker opened on Specials —
    // never what anyone wants — and pushed Season 1 down the list. It belongs
    // at the end, named for what it is rather than as "Season 0".
    const seasons = (Array.isArray(d.seasons) ? d.seasons.filter(function (s) { return s.seasonNumber != null }) : [])
      .slice()
      .sort(function (a, b) {
        if ((a.seasonNumber === 0) !== (b.seasonNumber === 0)) return a.seasonNumber === 0 ? 1 : -1
        return a.seasonNumber - b.seasonNumber
      })
    const opts = seasons.map(function (s) {
      const label = s.seasonNumber === 0
        ? (s.name ? esc(s.name) : 'Specials')
        // TMDB names most seasons literally "Season 3", which read as
        // "Season 3 — Season 3". Only a real name earns the suffix.
        : 'Season ' + s.seasonNumber +
          (s.name && !/^season\s*\d+$/i.test(String(s.name).trim()) ? ' — ' + esc(s.name) : '')
      return '<option value="' + s.seasonNumber + '"' + (s.seasonNumber === _videoState.season ? ' selected' : '') + '>' + label + '</option>'
    }).join('')
    box.innerHTML = '<div class="video-controls-row">' +
      '<label class="video-control">Season<select class="mcs-set-select video-season-select" id="video-season-select">' + opts + '</select></label>' +
      _dubControl(d) +
      '<div class="video-episode-list" id="video-episode-list"></div></div>'
    document.getElementById('video-season-select')?.addEventListener('change', function (e) {
      _videoState.season = Number(e.target.value) || 1
      _videoState.episode = 1
      _refreshTvEpisodes(_videoDetailTicket, ++_videoSeasonTicket)
    })
    _bindDubControl()
    return
  }
  if (type === 'anime') {
    const n = Number(_videoDetail.d.episodeCount) || 0
    // A grid rather than the dropdown this used to be. The dropdown could say
    // which episode was selected and nothing else -- not which you had already
    // seen, not which you were part way through -- and for a long-running show
    // it was a two-thousand-row list you had to scroll to find your place in.
    // The same grid television uses carries all of that, and means one set of
    // marks rather than two that drift.
    const numbers = []
    for (let i = 1; i <= Math.min(n, 2000); i++) numbers.push(i)
    const prog = _epProgress('anime', _videoDetail.d.id, null, numbers)
    const grid = n > 0
      ? '<div class="video-episode-list" id="video-episode-list">' +
          numbers.map(function (i) { return _epButton(i, null, prog) }).join('') + '</div>'
      // Episode count unknown -- an airing show AniList has no total for, or a
      // long-runner past the cap. A number still has to be typed.
      : '<label class="video-control">Episode <input class="mcs-set-input" id="video-episode-input" type="number" min="1" value="' + _videoState.episode + '" style="width:90px"></label>'
    box.innerHTML = '<div class="video-controls-row">' +
      _epResumeHtml(prog, numbers.length) +
      _dubControl(_videoDetail.d) + grid +
    '</div>'
    const setEp = function (ep) {
      _videoState.episode = ep
      _syncEpisodeSelection(ep)
      _loadVideoSources(_videoDetailTicket, ++_videoSeasonTicket)
    }
    box.querySelectorAll('.video-episode-btn').forEach(function (b) {
      b.addEventListener('click', function () { setEp(Number(b.dataset.ep) || 1) })
    })
    document.getElementById('video-episode-input')?.addEventListener('change', function (e) {
      setEp(Number(e.target.value) || 1)
    })
    _bindEpResume(box)
    _bindDubControl()
    return
  }
  // A film has nothing to choose but the language, so the row appears only when
  // there is a dub worth asking for.
  const dub = _dubControl(_videoDetail.d)
  box.innerHTML = dub ? '<div class="video-controls-row">' + dub + '</div>' : ''
  _bindDubControl()
}

// ── Episode progress ────────────────────────────────────────────────────────
// The store has recorded a position for every episode since the engine work,
// and nothing has ever shown it. Opening a season looked identical whether you
// had watched none of it or all but one, and finding your place meant
// remembering the number yourself.
//
// Two things come out of the same read: a mark on each episode, and one
// sentence saying where to pick up.

// How far into an episode counts as "started". Below this it is almost always
// a mis-click or a few seconds of buffering, and offering to resume from ten
// seconds in is worse than offering nothing.
var _EP_STARTED = 0.02

function _epProgress(type, id, season, epNumbers) {
  const store = _vStore()
  const out = { items: {}, resume: null, next: null, watched: 0 }
  if (!store || !Array.isArray(epNumbers) || !epNumbers.length) return out
  let lastWatched = null
  let started = null
  for (const n of epNumbers) {
    let item = null
    try { item = store.get(_watchKey(type, id, season, n)) } catch (_) { item = null }
    if (!item) continue
    const dur = Number(item.duration) || 0
    const pos = Number(item.position) || 0
    const ratio = dur > 0 ? pos / dur : 0
    const rec = { watched: item.watched === true, position: pos, duration: dur, ratio: ratio }
    out.items[n] = rec
    if (rec.watched) { out.watched++; if (lastWatched == null || n > lastWatched) lastWatched = n }
    // The furthest episode genuinely mid-way through. Furthest rather than most
    // recent: rewatching episode 2 of a season you are eight into should not
    // move your place backwards.
    else if (ratio >= _EP_STARTED && (started == null || n > started)) started = n
  }
  if (started != null) {
    out.resume = { episode: started, position: out.items[started].position, duration: out.items[started].duration }
  } else if (lastWatched != null) {
    const after = epNumbers.filter(function (n) { return n > lastWatched && !(out.items[n] && out.items[n].watched) })
    if (after.length) out.next = { episode: Math.min.apply(null, after) }
  }
  return out
}

// The class and tooltip for one episode button. Kept separate so the anime
// grid and the television grid cannot drift apart.
function _epMark(rec) {
  if (!rec) return { cls: '', title: '' }
  if (rec.watched) return { cls: ' seen', title: 'Watched' }
  if (rec.ratio >= _EP_STARTED) {
    const left = Math.max(0, (rec.duration || 0) - (rec.position || 0))
    return { cls: ' partial', title: 'Started — ' + _vDurText(left) + ' left', pct: Math.round(rec.ratio * 100) }
  }
  return { cls: '', title: '' }
}

function _epButton(n, name, prog) {
  const rec = prog && prog.items ? prog.items[n] : null
  const mark = _epMark(rec)
  const label = name ? esc(name) : ''
  const tip = [label, mark.title].filter(Boolean).join(' — ')
  return '<button class="video-episode-btn' + (n === _videoState.episode ? ' active' : '') + mark.cls +
    '" data-ep="' + n + '"' + (tip ? ' title="' + tip + '"' : '') + '>' + n +
    (mark.pct != null ? '<i class="video-ep-bar" style="width:' + mark.pct + '%"></i>' : '') +
    '</button>'
}

// Seconds -> "42m" / "1h 05m". Short because it sits inside a tooltip and a
// one-line banner, not a table.
function _vDurText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm'
  return m + 'm'
}

// One sentence above the grid: where you were, or what is next. Rendered only
// when there is something to say -- an untouched season gets no banner at all
// rather than an empty box saying so.
function _epResumeHtml(prog, total) {
  if (!prog) return ''
  if (prog.resume) {
    const left = Math.max(0, (prog.resume.duration || 0) - (prog.resume.position || 0))
    return '<div class="video-resume" data-ep="' + prog.resume.episode + '">' +
      '<div class="video-resume-text"><b>Continue episode ' + prog.resume.episode + '</b>' +
      (left > 0 ? '<span>' + esc(_vDurText(left)) + ' left</span>' : '') + '</div>' +
      '<button class="video-resume-go">Resume</button></div>'
  }
  if (prog.next) {
    const done = prog.watched
    return '<div class="video-resume" data-ep="' + prog.next.episode + '">' +
      '<div class="video-resume-text"><b>Next up: episode ' + prog.next.episode + '</b>' +
      (total ? '<span>' + done + ' of ' + total + ' watched</span>' : '') + '</div>' +
      '<button class="video-resume-go">Play</button></div>'
  }
  return ''
}

// Clicking Resume selects that episode and starts it from where it stopped --
// the position itself is already restored by the player's own resume offer, so
// this only has to get the right episode playing.
function _bindEpResume(root) {
  const banner = (root || document).querySelector('.video-resume')
  if (!banner) return
  banner.querySelector('.video-resume-go')?.addEventListener('click', function () {
    const n = Number(banner.dataset.ep) || 1
    _videoState.episode = n
    _syncEpisodeSelection(n)
    _loadVideoSources(_videoDetailTicket, ++_videoSeasonTicket)
  })
}

// The chosen episode has to be reflected in whichever control is on screen,
// and the two catalogues use different ones.
function _syncEpisodeSelection(n) {
  document.querySelectorAll('.video-episode-btn').forEach(function (x) {
    x.classList.toggle('active', Number(x.dataset.ep) === n)
  })
  const sel = document.getElementById('video-episode-select')
  if (sel) sel.value = String(n)
  const inp = document.getElementById('video-episode-input')
  if (inp) inp.value = String(n)
}

// `seasonTicket` is what makes rapid season switching safe. The old code passed
// the live `_videoDetailTicket` into its own guard, so the comparison was
// always true and whichever response happened to land last won — switching
// 1 → 2 → 3 quickly could leave season 3 selected while showing season 1's
// episodes. A ticket captured before the request fixes that.
async function _refreshTvEpisodes(ticket, seasonTicket) {
  const detail = _videoDetail
  if (!detail || detail.type !== 'tv') return
  if (seasonTicket == null) seasonTicket = ++_videoSeasonTicket
  const season = _videoState.season
  const box = document.getElementById('video-episode-list')

  // Episodes already fetched for this season are reused: the payload is stored
  // back onto the detail object, so revisiting a season costs nothing instead
  // of refetching the whole show every time.
  const known = Array.isArray(detail.d && detail.d.seasons)
    ? detail.d.seasons.find(function (x) { return x.seasonNumber === season })
    : null
  let episodes = known && Array.isArray(known.episodes) && known.episodes.length ? known.episodes : null

  if (!episodes) {
    if (box) box.innerHTML = '<div class="yt-status">Loading episodes…</div>'
    const res = await window.api.videoDetail({ type: 'tv', id: detail.id, season: season })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
    if (_videoDetailTicket !== ticket || _videoSeasonTicket !== seasonTicket) return
    episodes = []
    if (res.ok && res.detail && Array.isArray(res.detail.seasons)) {
      const s = res.detail.seasons.find(function (x) { return x.seasonNumber === season })
      if (s && Array.isArray(s.episodes)) episodes = s.episodes
    }
    if (episodes.length && known) known.episodes = episodes
  }

  const target = document.getElementById('video-episode-list')
  if (target) {
    const numbers = episodes.map(function (ep) { return ep.episodeNumber })
    const prog = _epProgress('tv', detail.id, season, numbers)
    target.innerHTML = episodes.length
      ? episodes.map(function (ep) { return _epButton(ep.episodeNumber, ep.name, prog) }).join('')
      : '<div class="yt-status">No episodes</div>'
    target.querySelectorAll('.video-episode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        _videoState.episode = Number(b.dataset.ep) || 1
        _syncEpisodeSelection(_videoState.episode)
        _loadVideoSources(_videoDetailTicket, ++_videoSeasonTicket)
      })
    })
    // The banner sits above the grid, so it is placed on the row rather than
    // inside the list it describes.
    const row = target.closest('.video-controls-row')
    if (row) {
      row.querySelector('.video-resume')?.remove()
      const html = _epResumeHtml(prog, numbers.length)
      if (html) {
        row.insertAdjacentHTML('afterbegin', html)
        _bindEpResume(row)
      }
    }
  }
  await _loadVideoSources(ticket, seasonTicket)
}

function _videoStreamRequest() {
  const d = _videoDetail.d
  const base = { type: _videoDetail.type, title: d.title, year: d.year }
  if (_videoDetail.type === 'movie') {
    // An anime film is anime: it wants nyaa and the romaji title, not the film
    // indexers. The detail was enriched with AniList's titles for exactly this.
    const wantDub = _playing.dub != null ? _playing.dub : !_videoState.sub
    return Object.assign(base, {
      tmdbId: d.id, imdbId: d.imdbId || null,
      isAnime: d.isAnime === true,
      titles: d.titles || null,
      // Sent whenever a dub is worth asking for, which is the same test the
      // toggle uses. Gating this on isAnime alone meant the toggle could be
      // shown for a foreign film and then quietly ignored.
      ...(_dubbable(d) ? { sub: !wantDub, dub: wantDub } : {}),
    })
  }
  if (_videoDetail.type === 'tv') {
    // An anime that TMDB files as television. The detail was enriched with
    // AniList's titles, so the source lookup can use the anime indexer and the
    // romaji name it indexes under — the same sources the Anime tab would give
    // for this show, rather than the TV indexer's thin anime coverage.
    const wantDub = _playing.dub != null ? _playing.dub : !_videoState.sub
    return Object.assign(base, {
      tmdbId: d.id, imdbId: d.imdbId || null,
      season: _videoState.season, episode: _videoState.episode,
      isAnime: d.isAnime === true,
      titles: d.titles || null,
      ...(_dubbable(d) ? { sub: !wantDub, dub: wantDub } : {}),
    })
  }
  // The torrent indexer needs the romaji title, not the English display one,
  // so every variant AniList returned is sent along.
  // Once something is playing, its language is the better signal: a dubbed
  // source picked straight from the list never touches the Dub checkbox.
  const wantDub = _playing.dub != null ? _playing.dub : !_videoState.sub
  return Object.assign(base, {
    anilistId: d.id, titles: d.titles || null, episode: _videoState.episode,
    sub: !wantDub, dub: wantDub,
  })
}

async function _loadVideoSources(ticket, seasonTicket) {
  const box = document.getElementById('video-sources')
  if (!box) return
  if (seasonTicket == null) seasonTicket = _videoSeasonTicket
  box.innerHTML = '<div class="yt-status">Looking for sources…</div>'
  const res = await window.api.videoStreams(_videoStreamRequest()).catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
  if (_videoDetailTicket !== ticket || _videoSeasonTicket !== seasonTicket) return
  const target = document.getElementById('video-sources')
  if (!target) return
  if (!res.ok) {
    // A failed source lookup used to replace the whole page, throwing away the
    // hero, the season picker and the episode list the user was working with.
    // The failure belongs in the sources panel and nowhere else.
    target.innerHTML = '<div class="video-sources-header"><span class="section-title">Sources</span></div>' +
      '<div class="yt-status yt-error">' + esc(_videoErrorText(res.error)) + '</div>' +
      '<button class="secondary" id="video-sources-retry">Try again</button>'
    document.getElementById('video-sources-retry')?.addEventListener('click', function () {
      _loadVideoSources(_videoDetailTicket, ++_videoSeasonTicket)
    })
    return
  }
  const streams = Array.isArray(res.streams) ? res.streams : []
  _videoStreams = streams
  if (!streams.length) {
    target.innerHTML = '<div class="video-sources-header"><span class="section-title">Sources</span></div>' +
      '<div class="yt-status">No sources found for this ' + (_videoDetail.type === 'movie' ? 'film' : 'episode') + '.</div>' +
      '<button class="secondary" id="video-sources-retry">Try again</button>'
    document.getElementById('video-sources-retry')?.addEventListener('click', function () {
      _loadVideoSources(_videoDetailTicket, ++_videoSeasonTicket)
    })
    return
  }
  // Playback status and stopping now live in the theatre, which owns the video
  // for as long as it is open. The sources list is only a picker again.
  target.innerHTML = '<div class="video-sources-header"><span class="section-title">Sources</span></div><div class="video-source-list">' +
    streams.map(_videoStreamRow).join('') + '</div>'
  target.querySelectorAll('.video-source-play').forEach(function (btn) {
    btn.addEventListener('click', function () {
      _videoPlayResult(_videoStreams[Number(btn.dataset.idx)])
    })
  })
}

function _videoStreamRow(s, i) {
  const badge = (s.quality || 'unknown') + ' · ' + (s.audioLayout || 'stereo')
  const torrent = s.kind === 'torrent' ? '<span class="video-torrent-badge">torrent</span>' : ''
  const subDub = (s.sub != null && s.dub != null)
    ? '<span class="video-source-tag">' + (s.sub && !s.dub ? 'sub' : s.dub && !s.sub ? 'dub' : 'sub+dub') + '</span>'
    : ''
  const label = s.label || s.source || (s.kind === 'torrent' ? (s.magnet || '') : (s.url || '')) || ''
  return '<div class="video-source-row" data-idx="' + i + '">' +
    '<span class="video-source-badge">' + esc(badge) + '</span>' +
    torrent + subDub +
    '<span class="video-source-label">' + esc(label) + '</span>' +
    '<button class="video-source-play" data-idx="' + i + '" aria-label="Play ' + esc(badge) + '"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>' +
  '</div>'
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
    <li class="folder-item" title="${esc(f)}">
      <span>${esc(shortPath(f))}</span>
      <button class="folder-item-del" data-folder="${esc(f)}" title="Remove">&#10005;</button>
    </li>`).join('')
  list.querySelectorAll('.folder-item-del').forEach(btn => {
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
        // A silently failed Undo is the user's data not coming back, with the
        // snackbar having promised it would. Two call sites, both restoring a
        // library snapshot after a folder removal.
        var _restored = await window.api.libraryRestoreState({ snapshot: prune.snapshot })
          .then(function () { return true })
          .catch(function (e) {
            console.error('[papa] undo could not restore the library snapshot:', String(e && e.message || e))
            return false
          })
        if (!_restored) showSnackbar('The folder came back, but the library entries could not be restored', '', function () {}, 8000)
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
    const result = await window.api.fetchAlbumArt({ albumId: album.id, artist: album.artist, album: album.name })
    if (result?.artPath) {
      found++
      album.artPath = result.artPath
      patchAlbumArtInDOM(album.id, result.artPath)
    }
    // After the item, not before it. Computed before, the bar read (i)/n while
    // the text beside it read (i+1)/n -- so on a one-album fetch the bar sat at
    // 0% for the whole wait, and it was always one item behind its own label.
    fillEl.style.width = `${Math.round(((i + 1) / missing.length) * 100)}%`
    await sleep(250)
  }
  // Only a completed run is 100%. A cancel used to snap the bar full and then
  // say "Cancelled" underneath it.
  if (!artFetchCancelled) fillEl.style.width = '100%'
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

  // "Made for you" — smart-queue mixes plus Surprise Me and Rediscover. The
  // mix cards are filled in asynchronously by loadMadeForYou() once
  // queueMixes() resolves (mirrors the loadYtHome() pattern below), because
  // clustering the library is real IPC work and must not block the rest of
  // Home from painting.
  var dailyMixHTML = '<div class="section-header"><span class="section-title">Made for you</span></div>' +
    '<div class="scroll-row q-madeforyou" id="q-madeforyou">' +
    '<div class="q-mix-card q-mix-card-surprise" data-q-mode="surprise"><span class="q-mix-card-title">Surprise Me</span><span class="q-mix-card-sub">Something you would not have picked</span></div>' +
    '<div class="q-mix-card q-mix-card-rediscover" data-q-mode="rediscover"><span class="q-mix-card-title">Rediscover</span><span class="q-mix-card-sub">Tracks you used to love</span></div>' +
    '</div>'

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
  document.querySelectorAll('.q-mix-card[data-q-mode]').forEach(card => {
    card.addEventListener('click', () => startSmartQueue(card.dataset.qMode))
  })
  loadMadeForYou()
}

// Mix cards need the library clustered first (real IPC work), so they are
// filled in after the rest of Home has already painted — same pattern as
// loadYtHome(). Named per fix-round-1: mixes must show their dominant-artist
// name (from queue-clusters' nameCluster), never a placeholder "Mix N" —
// otherwise every card is a random draw from the same undifferentiated pool.
async function loadMadeForYou() {
  const container = document.getElementById('q-madeforyou')
  if (!container) return
  const res = await window.api.queueMixes().catch(() => null)
  if (!container.isConnected || state.currentPage !== 'home') return
  if (!res || !res.featuresReady || !res.mixes || !res.mixes.length) {
    // Not enough analysis yet to name real mixes — say so honestly instead of
    // showing five cards that would all build the same undifferentiated queue.
    const unlock = document.createElement('div')
    unlock.className = 'q-mix-card q-mix-card-unlock'
    unlock.innerHTML = '<span class="q-mix-card-title">Mixes unlock after analysis</span>' +
      '<span class="q-mix-card-sub">Analyse your library to get mixes named for your taste</span>' +
      '<button class="q-mix-card-analyse-btn" id="q-mix-analyse-btn">Start analysis</button>'
    container.insertBefore(unlock, container.firstChild)
    document.getElementById('q-mix-analyse-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      window.api.queueAnalysisStart().catch(() => {})
      showSnackbar('Analysis started — mixes will appear once it finishes')
    })
    return
  }
  const wrap = document.createElement('div')
  wrap.innerHTML = res.mixes.map(m =>
    '<div class="q-mix-card" data-q-mode="mix" data-mix-index="' + m.index + '">' +
      '<span class="q-mix-card-title">' + esc(m.name) + '</span>' +
      '<span class="q-mix-card-sub">' + m.size + ' track' + (m.size === 1 ? '' : 's') + '</span>' +
    '</div>').join('')
  const anchor = container.firstChild
  while (wrap.firstChild) container.insertBefore(wrap.firstChild, anchor)
  container.querySelectorAll('.q-mix-card[data-mix-index]').forEach(card => {
    card.addEventListener('click', () => startSmartQueue('mix', null, { mixIndex: parseInt(card.dataset.mixIndex, 10) }))
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

  // Dismissed albums are skipped, so the deck advances. A swipe used to be
  // animation only -- the card was removed after 300ms and reappeared on the
  // next Home render, with nothing recorded either way.
  var _discoverDeck = state.library.filter(function (a) { return !_discoverDismissed.has(a.id) }).slice(0, 10)
  var discoveryHTML = '<div class="section-header"><span class="section-title">Discover</span></div><div class="discovery-swipe" id="discovery-swipe">' + _discoverDeck.map(function(a, i) { return '<div class="discovery-swipe-card" data-album="' + esc(a.id) + '" title="' + esc(a.artist + ' — ' + a.name) + '" style="cursor:pointer;z-index:' + (10 - i) + '"><div style="width:100%;height:100%;background:var(--bg3);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px">' + artImg(a.artPath, '', '') + '<div style="font-size:14px;font-weight:600;padding:0 16px;text-align:center">' + esc(a.name) + '</div><div style="font-size:12px;color:var(--text2)">' + esc(a.artist) + '</div></div></div>' }).join('') + '</div>'

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
  window.api.ytAuthStart().catch(e => ({ ok: false, error: String(e && e.message || e) })).then(res => {
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
  // Native prompt() and confirm() both stop the renderer's event loop.
  _mgPrompt('Save this view as a preset', {
    label: 'Preset name',
    confirmLabel: 'Save',
    onConfirm: function (name) { _saveLibPresetNamed(String(name || '').trim()) },
  })
}

function _saveLibPresetNamed(name) {
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
  function commit() {
    if (existing !== -1) _libPresets[existing] = preset
    else _libPresets.push(preset)
    localStorage.setItem('papa-lib-presets', JSON.stringify(_libPresets))
    showSnackbar('Preset "' + name + (existing !== -1 ? '" replaced' : '" saved'))
    renderLibrary()
  }
  if (existing === -1) { commit(); return }
  _mgConfirm('Replace this preset?',
    '<p>A preset named <strong>' + esc(name) + '</strong> already exists.</p>',
    'Replace', commit)
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
  document.getElementById('lib-delete-preset')?.addEventListener('click', function() {
    var sel = document.getElementById('lib-preset-select')
    var v = sel && sel.value
    if (!v) return
    _mgConfirm('Delete this preset?', '<p><strong>' + esc(v) + '</strong></p>', 'Delete', function () {
      _libPresets = _libPresets.filter(function(p) { return p.name !== v })
      localStorage.setItem('papa-lib-presets', JSON.stringify(_libPresets))
      showSnackbar('Preset "' + v + '" deleted')
      renderLibrary()
    })
  })
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
  _mgPrompt('Edit ' + field, {
    label: field,
    value: currentValue,
    confirmLabel: 'Update',
    onConfirm: function (newVal) {
      if (!newVal || newVal === currentValue) return
      callback(newVal)
      showSnackbar(field + ' updated (visual only — save to file coming soon)')
    },
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
    // A note is prose, so it gets a textarea rather than a one-line prompt.
    _mgPrompt('Notes', {
      label: album.name,
      value: existing,
      multiline: true,
      confirmLabel: 'Save note',
      onConfirm: function (note) {
        state.albumNotes[albumId] = note
        localStorage.setItem('papa-album-notes', JSON.stringify(state.albumNotes))
        renderAlbum(albumId)
      },
    })
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
    // Was an unguarded parse: a bad value aborted the whole click handler, so
    // liking a track did nothing and said nothing.
    var likeHistory = window.PapaLocal.readArray('papa_like_history')
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
    var _hist = window.PapaLocal.readArray('pa_search_history')
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
      runYtSearch((searchText || query).trim(), tab.dataset.scope)
    })
  })

  // Operators are a LOCAL filtering language. Sending them verbatim to slskd or
  // YouTube meant `artist:"Miles Davis" year:1970 bitches brew` was matched
  // against filenames as a literal string, which returns nothing -- so using an
  // operator silently killed online search entirely.
  const onlineQuery = (searchText || '').trim()
  const canSearchOnline = onlineQuery.length >= 2
  const sameQuery  = slsk.lastQuery === onlineQuery
  const hasResults = slsk.results.length > 0
  bindSlskSearchEvents(query)
  if (slsk.status.connected && canSearchOnline) {
    if (!sameQuery || !slsk.searched || (!slsk.searching && !hasResults)) {
      runSlskSearch(onlineQuery)
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
  if (canSearchOnline) runYtSearch(onlineQuery, ytSearchState.scope)
}

// ── YouTube search section ──────────────────────────────────────────────────
// Pause every animation while the window is unfocused. See main.js: this
// machine renders in software, so animation costs a full CPU core.
if (window.api && window.api.onWindowFocus) {
  window.api.onWindowFocus(on => {
    document.body.classList.toggle('app-unfocused', !on)
    // Losing focus with nothing downloading is the clearest case for stopping
    // the poll altogether.
    _appVisible = on || !document.hidden
    retuneDownloadsPolling()
  })
}
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('app-unfocused', document.hidden)
})

// A whole result payload per unique scope::query. 40 is far more than a session
// revisits, and bounded is the point.
const YT_SEARCH_CACHE_CAP = 40
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
  var cached = _cacheGet(ytSearchState.cache, cacheKey)
  if (cached !== undefined) {
    renderYtResults(cached, query)
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
  _cacheSet(ytSearchState.cache, cacheKey, res.results, YT_SEARCH_CACHE_CAP)
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
  box.querySelectorAll('.yt-dl').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation()
    const r = results[parseInt(btn.dataset.i)]
    startYtDownloadFromButton(btn, { videoId: r.videoId, title: r.title, artist: r.artist })
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

// A generation ticket per YouTube render, the same pattern the Soulseek search
// already uses. Guarding on state.currentPage only meant that opening album A and
// then album B before A resolved let A's late response repaint over B — leaving
// the page showing B's title with handlers wired to A's browseId.
const _ytTicket = { album: 0, playlist: 0, artist: 0 }

async function renderYtAlbum(browseId) {
  const _ticket = ++_ytTicket.album
  // Saved albums open instantly from the stored snapshot; a background fetch
  // refreshes the page only if the data actually changed.
  const snap = state.ytSavedAlbums.find(a => a.browseId === browseId)
  if (snap) _paintYtAlbum(snap)
  else setContent(`<div class="page"><div class="skeleton skeleton-header"></div>${Array(6).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>`)
  const res = await window.api.ytAlbum({ browseId }).catch(e => ({ ok: false, error: String(e) }))
  if (_ticket !== _ytTicket.album || state.currentPage !== 'yt-album') return
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
    startYtDownloadFromButton(btn, { videoId: t.videoId, title: t.title, artist: al.artist, subdir: `${al.artist} - ${al.title}` })
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
  const _ticket = ++_ytTicket.playlist
  setContent(`<div class="page"><div class="skeleton skeleton-header"></div>${Array(8).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>`)
  const res = await window.api.ytPlaylist({ playlistId }).catch(e => ({ ok: false, error: String(e) }))
  if (_ticket !== _ytTicket.playlist || state.currentPage !== 'yt-playlist') return
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
  const _ticket = ++_ytTicket.artist
  setContent(`<div class="page"><div class="skeleton skeleton-header"></div>${Array(6).fill(0).map(() => '<div class="skeleton-row"><div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div>`)
  const res = await window.api.ytArtist({ channelId }).catch(e => ({ ok: false, error: String(e) }))
  if (_ticket !== _ytTicket.artist || state.currentPage !== 'yt-artist') return
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
      startYtDownloadFromButton(btn, { videoId: s.videoId, title: s.title, artist: s.artist })
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
    startYtRadio(ar.topSongs[0])
      .then(ok => { if (btn) btn.textContent = ok ? 'Radio ▸' : 'Radio' })
      .catch(e => {
        console.error('[papa] radio failed to start:', String(e && e.message || e))
        if (btn) btn.textContent = 'Radio'
        showSnackbar('Could not start radio', '', function () {}, 4000)
      })
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
  // The blurred backdrop and the portrait at the right are fully styled
  // (.artist-hero-photo, .artist-portrait) and the elements were never created,
  // so loadArtistBio fetched the Wikipedia photo on every artist page and wrote
  // it into two ids that do not exist. They exist now.
  var heroHTML = '<div class="artist-hero">' +
    '<img class="artist-hero-photo" id="artist-hero-bg-img" alt="" style="display:none" onerror="this.style.display=\'none\'">' +
    '<img class="artist-portrait" id="artist-portrait-img" alt="" style="display:none" onerror="this.style.display=\'none\'">' +
    '<div class="artist-hero-art">' + (artistAlbums[0] && artistAlbums[0].artPath ? '<img src="' + esc('file://' + artistAlbums[0].artPath) + '" alt="">' : '<div style="width:100%;height:100%;background:var(--bg4);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:var(--text3)"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>') + '</div><div class="artist-hero-info"><div class="artist-hero-name">' + esc(artistName) + '</div><div class="artist-hero-meta">' + artistAlbums.length + ' albums &middot; ' + totalTracks + ' tracks &middot; ' + artistHours + 'h ' + artistMins + 'm</div><button class="follow-btn' + (isFollowed ? ' following' : '') + '" id="artist-follow-btn">' + (isFollowed ? 'Following' : 'Follow') + '</button></div></div>'

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
  const prev = window.PapaLocal.readObject('followedAlbumCounts')
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

// ── Downloads-page buttons ──────────────────────────────────────────────────
// Every one of these disables itself and relies on the re-render at the end to
// replace it. When that re-render throws -- the daemon going away mid-action is
// exactly when these buttons get pressed -- the button stayed dead with no way
// to retry, on the page whose whole job is retrying. One wrapper, one finally.
async function _dlBtnAction(btn, fn) {
  if (!btn || btn.disabled) return
  btn.disabled = true
  try {
    await fn()
  } catch (e) {
    showSnackbar('That did not work: ' + String(e && e.message || e), null, null, 6000)
  } finally {
    // isConnected: the usual, successful path replaces the button, and there is
    // nothing to re-enable then.
    if (btn.isConnected) btn.disabled = false
  }
}

// ── YouTube download buttons ────────────────────────────────────────────────
// One place that starts a download and reflects the outcome on the button that
// started it. All three call sites used to disable the button, set '…' and
// never touch it again -- so it read '…' forever whether the download worked or
// not, and could not be retried. yt-download returns as soon as the job is
// queued, so the real outcome arrives later on yt-dl-progress; the button is
// looked up by download id when it does.
const _ytBtnById = new Map()
const YT_BTN_MAP_CAP = 100

function _ytBtnDone(id, ok, error) {
  const rec = _ytBtnById.get(id)
  if (!rec) return
  _ytBtnById.delete(id)
  if (ok) rec.restore('\u2713', 'Downloaded')
  else rec.restore('\u21bb', (error || 'Download failed') + ' — click to retry')
}

async function startYtDownloadFromButton(btn, payload) {
  if (!btn || btn.dataset.ytBusy === '1') return
  const original = btn.innerHTML
  const originalTitle = btn.title || ''
  btn.dataset.ytBusy = '1'
  btn.disabled = true
  btn.innerHTML = '\u2026'
  btn.title = 'Downloading…'
  const restore = function (mark, title) {
    // A re-render can replace the button under us; nothing to restore then.
    if (!btn.isConnected) return
    delete btn.dataset.ytBusy
    btn.disabled = false
    btn.innerHTML = mark || original
    btn.title = title || originalTitle
    if (mark === '\u2713') {
      setTimeout(function () {
        if (!btn.isConnected) return
        btn.innerHTML = original
        btn.title = originalTitle
      }, 4000)
    }
  }
  try {
    const res = await window.api.ytDownload(payload)
    if (!res || !res.ok) {
      restore('\u21bb', ((res && res.error) || 'Download failed') + ' — click to retry')
      return
    }
    _ytBtnById.set(res.id, { btn: btn, restore: restore })
    if (_ytBtnById.size > YT_BTN_MAP_CAP) _ytBtnById.delete(_ytBtnById.keys().next().value)
  } catch (e) {
    // The case that used to leave '…' on screen forever with no explanation.
    restore('\u21bb', 'Download failed: ' + String(e && e.message || e) + ' — click to retry')
  }
}

// ── Discover dismissals ─────────────────────────────────────────────────────
// Bounded, because this grows with every swipe and nothing else prunes it.
const DISCOVER_DISMISS_CAP = 300
const _discoverDismissed = new Set()

function restoreDiscoverDismissals() {
  var list = window.PapaLocal.readArray('papa_discover_dismissed', function (e) { return typeof e === 'string' })
  _discoverDismissed.clear()
  ;(list || []).slice(-DISCOVER_DISMISS_CAP).forEach(function (id) { _discoverDismissed.add(id) })
}

function _saveDiscoverDismissals() {
  var list = Array.from(_discoverDismissed).slice(-DISCOVER_DISMISS_CAP)
  try { localStorage.setItem('papa_discover_dismissed', JSON.stringify(list)) } catch (_) {}
}

function _discoverDismiss(albumId) {
  if (!albumId) return
  _discoverDismissed.add(albumId)
  // Insertion-ordered, so the oldest dismissal is the one dropped at the cap.
  if (_discoverDismissed.size > DISCOVER_DISMISS_CAP) {
    _discoverDismissed.delete(_discoverDismissed.values().next().value)
  }
  _saveDiscoverDismissals()
}

function _discoverUndismiss(albumId) {
  if (!albumId) return
  _discoverDismissed.delete(albumId)
  _saveDiscoverDismissals()
}

// ── Sidebar width ───────────────────────────────────────────────────────────
// One source of truth, restored at startup. papa_compact_sidebar was written on
// every right-click toggle and read by nothing, so compact mode reset on every
// launch; the dragged width was not persisted at all.
const SIDEBAR_COMPACT_W = 60
const SIDEBAR_MIN_W = 160
const SIDEBAR_MAX_W = 340
const SIDEBAR_DEFAULT_W = 220
let _sidebarCompact = false
let _sidebarWidth = SIDEBAR_DEFAULT_W

function _applySidebarWidth() {
  const w = _sidebarCompact ? SIDEBAR_COMPACT_W : _sidebarWidth
  document.documentElement.style.setProperty('--sidebar-w', w + 'px')
  document.querySelector('.sidebar')?.classList.toggle('compact', _sidebarCompact)
}

function _saveSidebarPrefs() {
  try {
    localStorage.setItem('papa_compact_sidebar', _sidebarCompact ? '1' : '0')
    localStorage.setItem('papa_sidebar_width', String(_sidebarWidth))
  } catch (_) { /* private mode, quota */ }
}

function setSidebarCompact(on) {
  _sidebarCompact = !!on
  _applySidebarWidth()
  _saveSidebarPrefs()
}

function restoreSidebarPrefs() {
  try {
    _sidebarCompact = localStorage.getItem('papa_compact_sidebar') === '1'
    // Clamped on read: a stored value from an older build, or a hand-edited
    // one, must not be able to render the sidebar unusable.
    const w = parseInt(localStorage.getItem('papa_sidebar_width'), 10)
    if (Number.isFinite(w)) _sidebarWidth = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, w))
  } catch (_) { /* nothing stored, or storage unavailable */ }
  _applySidebarWidth()
}

function restoreStatsRange() {
  try {
    const r = localStorage.getItem('papa_stats_range')
    if (r && r in STATS_RANGE_DAYS) state.statsRange = r
  } catch (_) {}
}

// A play is recorded once it has been listened to for 30 s. Used by both the
// explicit-start path and the gapless auto-advance path — they used to disagree,
// which is what made history and play counts disagree.
const PLAY_RECORD_MS = 30000
let _historyTimer = null
// The history entry is written at the 30 s mark, where the position is always
// ~30 s. Two achievements ask "did you finish it", which needs the position the
// track was LEFT at -- so the last sampled position is remembered and flushed
// when the track is left. Sampled rather than read at flush time because by
// then audio.currentTime already belongs to the next track.
let _recordedPlay = null
let _lastSampledPos = 0

function sampleHistoryPosition(pos) {
  const n = Number(pos)
  if (Number.isFinite(n) && n >= 0) _lastSampledPos = n
}

// Called when a track is left, from every path that leaves one.
function flushPlayHistoryPosition() {
  const rec = _recordedPlay
  _recordedPlay = null
  if (!rec || !rec.filePath) return
  if (_lastSampledPos <= 0) return
  window.api.updatePlayHistoryPosition({ filePath: rec.filePath, position: _lastSampledPos })
}

function recordPlayAfterThreshold(track) {
  // The previous track's real position, before the sampler starts over.
  flushPlayHistoryPosition()
  _lastSampledPos = 0
  clearTimeout(_historyTimer)
  if (!track || !track.filePath) return
  _historyTimer = setTimeout(function () {
    // No ts: main stamps it. It used to store whatever the renderer sent.
    window.api.addPlayHistory({
      filePath: track.filePath,
      title: track.title,
      artist: track.albumArtist || track.artist,
      album: track.albumName,
      artPath: track.artPath || null,
      duration: track.duration || 0,
    })
    _recordedPlay = { filePath: track.filePath }
  }, PLAY_RECORD_MS)
}

// MPRIS Stop, which is not Pause: it ends playback and returns to the start of
// the track. The queue is kept -- Stop is not Clear.
function mediaStop() {
  audio.pause()
  try { audio.currentTime = 0 } catch (_) { /* no source loaded */ }
  state.isPlaying = false
  updatePlayBtn()
  // The bar is painted from timeupdate, which will not fire again while paused,
  // so it is reset here or it keeps showing where the track stopped.
  if (_dom.fill)  _dom.fill.style.width = '0%'
  if (_dom.thumb) _dom.thumb.style.left = '0%'
  if (_dom.modalFill)  _dom.modalFill.style.width = '0%'
  if (_dom.modalThumb) _dom.modalThumb.style.left = '0%'
  if (_dom.timeCur) _dom.timeCur.textContent = _fmtTimeCur(0)
  if (_dom.modalCur) _dom.modalCur.textContent = _fmtTimeCur(0)
  syncExtension()
}

// ── Playback engine state, visible ───────────────────────────────────────────
// A badge in the player bar, shown only while the engine is not healthy. Not a
// dialog: the decided behaviour is a brief non-blocking notice, never a prompt.
function setEngineState(text, recovering) {
  const el = document.getElementById('engine-state')
  if (!el) return
  el.textContent = text || ''
  el.classList.toggle('recovering', !!recovering)
  el.style.display = text ? '' : 'none'
}

// An unexplained stop has no safe automatic policy yet — deciding one is Tier 2
// work. What we can do is offer the single action the user wants and put them
// back exactly where the music stopped.
function resumeAfterStop(d) {
  const pos = Number(d && d.position) || 0
  setEngineState('', false)
  playCurrentTrack()
  // The engine defers a seek issued before mpv reports the file seekable, so
  // this does not race the load.
  if (pos > 1) audio.currentTime = pos
}

let _engineBlockerReason = null
const ENGINE_FAIL_TEXT = {
  'respawn-limit': 'mpv kept crashing, so Papa Audio stopped restarting it.',
  'respawn-error': 'mpv crashed and could not be restarted.',
  'start-error': 'mpv is installed but would not start.',
}

// This blocker used to show the same "install mpv" text for every failure,
// including an audio-device loss on a machine where mpv was installed and fine.
// The message is now written from the reason the engine actually reported, and
// mpv's own last words are shown instead of a guess.
function showEngineBlocker(kind, detail) {
  const el = document.getElementById('mpv-blocker')
  if (!el) return
  _engineBlockerReason = kind
  const missing = kind === 'mpvMissing'
  const title = document.getElementById('mpv-blocker-title')
  const body = document.getElementById('mpv-blocker-body')
  const install = document.getElementById('mpv-blocker-install')
  const log = document.getElementById('mpv-blocker-log')
  const btn = document.getElementById('mpv-recheck-btn')
  if (title) title.textContent = missing ? 'Playback engine required' : 'Playback engine stopped working'
  if (body) {
    // textContent, never markup: detail.detail is text from mpv and from Error
    // messages, and this renderer has window.api on it.
    body.textContent = missing
      ? "Papa Audio plays audio through mpv, which isn't installed."
      : (ENGINE_FAIL_TEXT[detail && detail.reason] || 'The playback engine failed.') +
        (detail && detail.detail ? ` (${detail.detail})` : '')
  }
  if (install) install.style.display = missing ? '' : 'none'
  const lines = detail && Array.isArray(detail.log) ? detail.log.filter(Boolean) : []
  if (log) {
    log.textContent = lines.slice(-8).join('\n')
    log.style.display = lines.length ? '' : 'none'
  }
  if (btn) btn.textContent = missing ? 'I installed it \u2014 check again' : 'Try starting it again'
  el.style.display = 'flex'
}

function hideEngineBlocker() {
  const el = document.getElementById('mpv-blocker')
  if (el) el.style.display = 'none'
  _engineBlockerReason = null
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
        bgImg.style.display = ''
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
  var _bio = _cacheGet(_bioCache, artistName)
  if (_bio !== undefined) { render(_bio); return }
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
    _cacheSet(_bioCache, artistName, data, _BIO_CACHE_CAP)
    if (state.currentPage === 'artist' && state.currentArtistName === artistName) render(data)
  } catch (_) {
    // Don't cache a network failure forever: going offline once used to mean
    // that artist had no bio for the rest of the session, even after recovery.
    if (state.isOnline !== false) _cacheSet(_bioCache, artistName, null, _BIO_CACHE_CAP)
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
  // A toggle, not a one-way door: this used to disable the folder select with
  // nothing re-enabling it, so choosing "New folder" removed any way back to
  // picking an existing one short of closing the dialog.
  overlay.querySelector('#npfm-new-folder-btn')?.addEventListener('click', function() {
    var opening = newFolderRow.style.display === 'none'
    newFolderRow.style.display = opening ? '' : 'none'
    folderSelect.disabled = opening
    this.textContent = opening ? 'Use existing folder' : 'New folder'
    if (opening) newFolderInput.focus()
    else { newFolderInput.value = ''; folderSelect.focus() }
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
    // Was a native confirm(). This action is already undoable from the snackbar
    // below and the tracks themselves are untouched, so the blocking prompt
    // bought nothing.
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

  // Was an unguarded parse: a bad value took out the entire Liked Songs page.
  var likeHistory = window.PapaLocal.readArray('papa_like_history', function (e) { return e && typeof e.ts === 'number' })
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

// state.statsRange was initialised to 'month' and no control anywhere set it,
// so three of its four values were unreachable while the header rendered "This
// Month" over figures computed from a hardcoded rolling 30 days. The range now
// decides the window, and there are buttons.
const STATS_RANGE_DAYS = { week: 7, month: 30, year: 365, all: 0 }

function _statsCutoff(range) {
  const days = STATS_RANGE_DAYS[range]
  return days ? Date.now() - days * 86400000 : 0
}

function renderStats() {
  const all = _allLibraryTracks()
  const byPath = new Map(all.map(t => [t.filePath, t]))
  if (!(state.statsRange in STATS_RANGE_DAYS)) state.statsRange = 'month'
  const cutoff = _statsCutoff(state.statsRange)
  const ranged = (state.playHistory || []).filter(function(h) { return (h.ts || 0) >= cutoff })
  // Achievements keep their own fixed 30-day window on purpose: they must not
  // earn and un-earn themselves as the user changes a view filter.
  const recent = state.statsRange === 'month'
    ? ranged
    : (state.playHistory || []).filter(function(h) { return (h.ts || 0) >= Date.now() - 30 * 86400000 })

  let totalSecs = 0
  for (const h of ranged) {
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

  var rangeText = cutoff ? new Date(cutoff).toLocaleDateString() + ' — Today' : 'All time'
  var rangeLabel = state.statsRange === 'week' ? 'Last 7 days' : state.statsRange === 'month' ? 'Last 30 days' : state.statsRange === 'year' ? 'Last 365 days' : 'All time'

  const artistCounts = {}
  for (const h of ranged) {
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
  for (const h of ranged) {
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
    // Both divided by p.duration while guarding on _histDur(p), the library
    // fallback -- so every entry written before the duration field existed
    // divided by zero and counted as not-finished. And the labels described a
    // different figure from the one computed: this counts tracks played past
    // 80%, not an average.
    { id:'skiphappy', icon:'⏭️', name:'Skip Happy', _needsPosition:true, desc:'Under 60% of tracks played to the end', check:function() { var total=0,full=0;recent.forEach(function(p){var d=_histDur(p)||0;if(d<=0)return;total++;if((p.position||0)/d>.8)full++});return total>10&&(full/total)<.6} },
    { id:'completelistener', icon:'✅', name:'Completionist+', _needsPosition:true, desc:'80%+ of tracks played to the end', check:function() { var total=0,full=0;recent.forEach(function(p){var d=_histDur(p)||0;if(d<=0)return;total++;if((p.position||0)/d>.8)full++});return total>10&&(full/total)>.8} },
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
    <div class="stats-toolbar" style="display:flex;gap:8px;margin-bottom:16px;padding:0 28px;align-items:center;flex-wrap:wrap">
      <div class="stats-range-group" style="display:flex;gap:4px">
        ${['week','month','year','all'].map(function (r) {
          return '<button class="secondary stats-range-btn' + (state.statsRange === r ? ' active' : '') +
            '" data-range="' + r + '" style="padding:6px 12px;font-size:12px">' +
            (r === 'week' ? '7 days' : r === 'month' ? '30 days' : r === 'year' ? '365 days' : 'All time') +
            '</button>'
        }).join('')}
      </div>
      <div style="flex:1"></div>
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
  document.querySelectorAll('.stats-range-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var r = btn.dataset.range
      if (!(r in STATS_RANGE_DAYS) || r === state.statsRange) return
      state.statsRange = r
      // Remembered, so the page does not snap back to 30 days on every visit.
      try { localStorage.setItem('papa_stats_range', r) } catch (_) {}
      renderStats()
    })
  })
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

  // The keydown listener used to be removed only inside the Escape handler, so
  // closing via the overlay, the X, or picking a playlist left it attached
  // forever — each closure holding the modal DOM and the whole track array.
  // Removing it in close() covers every exit, including ones added later.
  const close = () => {
    document.removeEventListener('keydown', onEsc)
    overlay.remove()
  }
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
  // Declared with `function` so close(), defined above it, can refer to it.
  function onEsc(e) { if (e.key === 'Escape') close() }
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

  // A surround-first queue (Task 7) mixes 5.1+ tracks with the occasional
  // stereo one. Once at least one surround track is present, mark the stereo
  // ones so it is obvious why they will not fill the room the same way.
  var hasSurround = state.queue.some(function (t) { return (t.channels || 0) >= 6 })

  list.innerHTML = fromHtml + '<div style="padding:12px;font-size:13px;font-weight:600;display:flex;justify-content:space-between"><span>Queue (' + state.queue.length + ')</span><span style="font-size:11px;color:var(--text3);font-weight:400">' + totalQDstr + '</span></div>' + state.queue.map((t, i) => {
    const isPlaying = i === state.queueIndex
    const art = t.artPath
      ? `<img class="queue-row-art" src="${esc('file://' + t.artPath)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : ''
    const stereoBadge = (hasSurround && (t.channels || 0) < 6) ? '<span class="q-stereo-badge">STEREO</span>' : ''
    return `
      <div class="queue-row ${isPlaying ? 'playing' : ''}" draggable="true" data-queue-idx="${i}">
        <div class="queue-drag-handle">${dragHandleSvg}</div>
        ${art}
        <div class="queue-row-art-fallback" ${art ? 'style="display:none"' : ''}>
          <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
        </div>
        <div class="queue-row-info">
          <div class="queue-row-title">${esc(t.title)}${t.explicit ? '<span class="track-explicit">E</span>' : ''}${stereoBadge}</div>
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
      const rect = row.getBoundingClientRect()
      const insertBefore = e.clientY < rect.top + rect.height / 2
      reorderQueue(dragSrcIdx, destIdx, insertBefore)
      dragSrcIdx = null
    })
  })

  // ── The same reorder by touch ────────────────────────────────────────────
  // The rows above use the native HTML drag-and-drop API, which does not fire
  // at all for touch or pen -- so drag-to-reorder was mouse-only. The handle
  // gets a pointer-driven path to the same reorderQueue() call.
  let _touchDrag = null
  list.querySelectorAll('.queue-drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      // Mouse keeps the native path, which carries a proper drag image.
      if (e.pointerType === 'mouse' || e.button !== 0) return
      const row = handle.closest('.queue-row')
      if (!row) return
      e.preventDefault()
      e.stopPropagation()
      _touchDrag = { srcIdx: parseInt(row.dataset.queueIdx), row: row, id: e.pointerId }
      row.classList.add('dragging')
      try { handle.setPointerCapture(e.pointerId) } catch (_) {}
    })
    handle.addEventListener('pointermove', e => {
      if (!_touchDrag || _touchDrag.id !== e.pointerId) return
      e.preventDefault()
      // With pointer capture the event targets the handle, so the row under the
      // finger has to be found by position.
      const over = _queueRowAt(list, e.clientX, e.clientY)
      list.querySelectorAll('.queue-row').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'))
      if (!over) return
      const rect = over.getBoundingClientRect()
      over.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom')
    })
    function endTouchDrag(e, commit) {
      if (!_touchDrag || _touchDrag.id !== e.pointerId) return
      const drag = _touchDrag
      _touchDrag = null
      try { handle.releasePointerCapture(e.pointerId) } catch (_) {}
      drag.row.classList.remove('dragging')
      list.querySelectorAll('.queue-row').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'))
      if (!commit) return
      const over = _queueRowAt(list, e.clientX, e.clientY)
      if (!over) return
      const rect = over.getBoundingClientRect()
      reorderQueue(drag.srcIdx, parseInt(over.dataset.queueIdx), e.clientY < rect.top + rect.height / 2)
    }
    handle.addEventListener('pointerup', e => endTouchDrag(e, true))
    // Cancelled by the OS taking the gesture: put the row back, change nothing.
    handle.addEventListener('pointercancel', e => endTouchDrag(e, false))
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
          // The one tooltip element is shared with the player bar, where it is
          // absolutely positioned inside .progress-track and centred with a
          // transform. Here it is positioned against the viewport, so the
          // transform and the bar's `bottom` both have to be undone -- stated
          // here rather than guessed at by an attribute-substring selector.
          tooltip.textContent = fmtDur(audio.duration * pct)
          tooltip.style.position = 'fixed'
          tooltip.style.transform = 'none'
          tooltip.style.bottom = 'auto'
          tooltip.style.display = 'block'
          tooltip.style.left = (e.clientX - 50) + 'px'
          tooltip.style.top  = (rect.top - 24) + 'px'
        }
      })
      modalTrack.addEventListener('mouseleave', function() {
        const tooltip = document.getElementById('progress-tooltip')
        if (tooltip) {
          // Every inline override is cleared, or the player bar's tooltip
          // inherits the modal's fixed positioning for the rest of the session.
          tooltip.style.display = 'none'
          tooltip.style.position = ''
          tooltip.style.transform = ''
          tooltip.style.bottom = ''
          tooltip.style.top = ''
          tooltip.style.left = ''
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

// ── Smart queues (radio / mix / surprise / rediscover) ──────────────────────
// All the building happens in the main process (Task 11). The renderer only
// asks for a finished, playable list and starts it — same shape as playAlbum.
var SMART_QUEUE_MODES = ['radio', 'mix', 'surprise', 'rediscover']
async function startSmartQueue(mode, seedFilePath, opts) {
  const mixIndex = opts && Number.isInteger(opts.mixIndex) ? opts.mixIndex : null
  const result = await window.api.queueBuild({ mode: mode, seedFilePath: seedFilePath, mixIndex: mixIndex, length: 40 }).catch(() => null)
  if (!result || !result.tracks || !result.tracks.length) {
    showSnackbar('Still analysing your library — try again shortly')
    return null
  }
  _oldQueue = null
  state.queue = result.tracks
  state.queueIndex = 0
  playCurrentTrack()
  if (state.queuePanelOpen) renderQueuePanel()
  if (!result.featuresReady) {
    showSnackbar('Analysis isn’t finished yet, so this is a general queue for now')
  }
  return result
}

// Mirror of playNext()'s selection, without side effects — used for gapless prefetch
// Deciding the shuffle pick lazily at end-of-track meant there was never a next
// file for mpv to prefetch, so every shuffle transition reloaded from scratch
// and the gap was audible. Committing to the pick in advance costs nothing -
// it is the same random choice, made a few minutes earlier - and is the only
// way shuffle can be gapless at all.
let _pendingShuffle = null

// The saved "Previous Session" queue is capped. The cap itself is fine — it is
// the silence that was not.
const AUTO_QUEUE_CAP = 100

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

// Fire-and-forget across three layers meant the first symptom of a failed
// gapless prefetch was the album stopping at a track boundary. One retry, then
// say so — a silent failure here is the exact bug this round is about.
let _prefetchRetry = null
function updateNextPrefetch(isRetry) {
  const want = state.queue.length ? (() => {
    const idx = computeNextIndex()
    return idx == null ? null : state.queue[idx].filePath
  })() : null
  clearTimeout(_prefetchRetry)
  const result = audio.setNext(want)
  if (!result || typeof result.then !== 'function') return
  result.then(r => {
    if (r && r.ok === false) throw new Error(r.error || 'prefetch rejected')
  }).catch(err => {
    console.error('[papa] gapless prefetch failed:', want, String(err && err.message || err))
    if (isRetry) {
      // Twice is not transient. The album will still play — the renderer's own
      // ended handler advances it — but the transition will have a gap.
      showSnackbar('Could not queue the next track — the gap between tracks may be audible',
        '', function () {}, 5000)
      return
    }
    _prefetchRetry = setTimeout(() => updateNextPrefetch(true), 700)
  })
}

// Bumped on every deliberate start. restorePlaybackState runs 1.2s after
// startup and awaits two IPC round trips inside that; anything the user starts
// in the meantime used to be silently replaced by the restored queue. The
// restore now watches this and abandons rather than overwrite.
var _playbackIntent = 0

function playCurrentTrack() {
  const track = state.queue[state.queueIndex]
  if (!track) return
  _playbackIntent++
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
    var _autoTracks = state.queue.slice(0, AUTO_QUEUE_CAP)
    var _autoQ = {
      id: '_auto',
      name: 'Previous Session',
      tracks: _autoTracks,
      index: Math.min(Math.max(0, state.queueIndex), Math.max(0, _autoTracks.length - 1)),
      savedAt: Date.now(),
      // Recorded so a restore can say so. Silently handing back a different
      // queue is worse than a long one being truncated.
      truncatedFrom: state.queue.length > AUTO_QUEUE_CAP ? state.queue.length : 0,
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
    }, PLAY_RECORD_MS)
    // duration was never written, so every stat derived from it read zero.
    recordPlayAfterThreshold(track)
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

// mpv is playing a file the queue does not contain. mpv is the authority on
// what is audible, so show that rather than leaving the bar describing a track
// that stopped playing. Uses the library entry when there is one, and falls back
// to the filename, which is still truer than the previous track's title.
function updateNowPlayingFromPath(filePath) {
  let track = null
  try {
    track = _allLibraryTracks().find(t => t.filePath === filePath) || null
  } catch (_) { /* library not loaded yet; the fallback below still works */ }
  if (!track) {
    const base = String(filePath || '').split('/').pop() || ''
    track = { title: base.replace(/\.[^.]+$/, '') || 'Unknown track', artist: '', albumName: '' }
  }
  updateNowPlaying(track)
  updateTrackHighlight()
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
  // The fallback used to be a bare random pick with no exclusion, so shuffle
  // could hand back the track that was already playing. On a single-artist
  // album -- this app's primary case, where the artist filter makes every
  // candidate "recent" until attempt 8 -- that measured 0.07% over 200,000
  // runs; on a two-track queue, 12.5%.
  //
  // Picking from the other indices directly rather than retrying: with more
  // than one track there is always a valid answer, so this cannot fail.
  const other = Math.floor(Math.random() * (queue.length - 1))
  return other >= state.queueIndex ? other + 1 : other
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
  }).catch(e => {
    // Not worth a notice — lyrics are optional — but an unhandled rejection
    // here aborted the rest of the callback silently.
    console.error('[papa] lyrics lookup failed for', track.filePath, String(e && e.message || e))
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
// Pointer events, not mouse events. The app registered no touchstart,
// touchmove, touchend, pointerdown or pointerup anywhere, so the progress bar,
// volume slider, queue reorder, both resizers and the Discover swipe worked by
// mouse only -- unusable by touch or stylus even though plain clicks were fine.
// One Pointer Events API covers mouse, touch and pen.
//
// setPointerCapture is the other half of the win: move and up are delivered to
// the element even when the pointer leaves it, so there are no document-level
// listeners left running for the life of the page, and a drag that ends
// off-screen still ends.
// The row under a point, ignoring the dragged row's own handle. Used by the
// touch path, which cannot rely on the event target.
function _queueRowAt(list, x, y) {
  const rows = list.querySelectorAll('.queue-row')
  for (const r of rows) {
    const b = r.getBoundingClientRect()
    if (y >= b.top && y <= b.bottom && x >= b.left && x <= b.right) return r
  }
  return null
}

// One reorder, called by the mouse drop handler and the touch drag alike.
// Extracted rather than duplicated: it carries queueIndex and the shuffle
// prefetch across the move, and two copies of that would drift.
function reorderQueue(srcIdx, destIdx, insertBefore) {
  if (srcIdx == null || !Number.isFinite(srcIdx) || !Number.isFinite(destIdx)) return
  if (srcIdx === destIdx) return
  if (srcIdx < 0 || srcIdx >= state.queue.length) return
  if (destIdx < 0 || destIdx >= state.queue.length) return

  const insertAt = insertBefore ? destIdx : destIdx + 1
  const [moved] = state.queue.splice(srcIdx, 1)
  const adjustedInsert = srcIdx < insertAt ? insertAt - 1 : insertAt
  state.queue.splice(adjustedInsert, 0, moved)

  // Keep queueIndex pointing at the same track
  if (srcIdx === state.queueIndex) {
    state.queueIndex = adjustedInsert
  } else if (srcIdx < state.queueIndex && adjustedInsert >= state.queueIndex) {
    state.queueIndex--
  } else if (srcIdx > state.queueIndex && adjustedInsert <= state.queueIndex) {
    state.queueIndex++
  }
  // computeNextIndex() caches _pendingShuffle as an INDEX and mpv has already
  // been handed that file. After a reorder that index points at a different
  // track, so the wrong song plays next while the highlight says otherwise.
  _pendingShuffle = null
  updateNextPrefetch()
  renderQueuePanel()
}

function makeDraggable(trackEl, fillEl, thumbEl, onChange) {
  if (!trackEl) return
  let activeId = null
  function update(e) {
    const rect = trackEl.getBoundingClientRect()
    if (!rect.width) return
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    if (fillEl)  fillEl.style.width = `${ratio * 100}%`
    if (thumbEl) thumbEl.style.left = `${ratio * 100}%`
    onChange(ratio)
  }
  trackEl.addEventListener('pointerdown', e => {
    // Primary button / primary touch only: a right-click opens the context menu
    // that the progress bar and volume bar both have.
    if (e.button !== 0) return
    activeId = e.pointerId
    // preventDefault stops touch scrolling and the text-selection drag.
    e.preventDefault()
    try { trackEl.setPointerCapture(e.pointerId) } catch (_) {}
    update(e)
  })
  trackEl.addEventListener('pointermove', e => {
    if (activeId !== e.pointerId) return
    update(e)
  })
  function end(e) {
    if (activeId !== e.pointerId) return
    activeId = null
    try { trackEl.releasePointerCapture(e.pointerId) } catch (_) {}
  }
  // pointercancel matters on touch: the OS can take the gesture away (a
  // system edge swipe), and without this the bar stayed latched to the finger.
  trackEl.addEventListener('pointerup', end)
  trackEl.addEventListener('pointercancel', end)
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// A page is built as ONE giant HTML string and assigned in one go, so a single
// bad record -- a null album name reaching localeCompare, say -- throws
// mid-build and leaves #content empty or half-written, with no way back except
// restarting the app. Catch it, keep the shell usable, and say what happened.
function _renderFailure(where, err) {
  console.error('[papa] render failed in ' + where, err)
  var c = document.getElementById('content')
  if (!c) return
  // The stack used to reach devtools and nowhere else, so a report of this card
  // could not be acted on. It is shown collapsed and copyable instead: the
  // person who can fix it is not the person looking at the card.
  var stack = String((err && err.stack) || (err && err.message) || err || 'Unknown error')
  var diagnostics = [
    'Papa Audio render failure',
    'session: ' + (_sessionId || 'unknown'),
    'when: ' + new Date().toISOString(),
    'page: ' + where,
    'app: ' + (_appVersion || 'unknown'),
    '',
    stack,
  ].join('\n')
  c.innerHTML = '<div class="mg-empty" style="padding:48px 24px">' +
    '<p>This page failed to render.</p>' +
    '<span>' + esc(String((err && err.message) || err || 'Unknown error')) + '</span>' +
    '<div style="margin-top:14px">' +
      '<button class="secondary" id="render-fail-home">Go Home</button> ' +
      '<button class="secondary" id="render-fail-copy">Copy diagnostics</button> ' +
      '<button class="secondary" id="render-fail-details">Show details</button>' +
    '</div>' +
    '<pre id="render-fail-stack" style="display:none;text-align:left;max-height:280px;overflow:auto;' +
      'white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5;margin-top:14px;opacity:.85">' +
      esc(diagnostics) + '</pre>' +
    '</div>'
  var b = document.getElementById('render-fail-home')
  if (b) b.addEventListener('click', function () { navigate('home') })
  var d = document.getElementById('render-fail-details')
  var pre = document.getElementById('render-fail-stack')
  if (d && pre) d.addEventListener('click', function () {
    var open = pre.style.display !== 'none'
    pre.style.display = open ? 'none' : ''
    d.textContent = open ? 'Show details' : 'Hide details'
  })
  var cp = document.getElementById('render-fail-copy')
  if (cp) cp.addEventListener('click', function () {
    navigator.clipboard.writeText(diagnostics).then(function () {
      cp.textContent = 'Copied'
    }).catch(function (e) {
      console.error('[papa] could not copy the diagnostics:', String(e && e.message || e))
      cp.textContent = 'Copy failed — the details are below'
      if (pre) { pre.style.display = ''; if (d) d.textContent = 'Hide details' }
    })
  })
}

function setContent(html) {
  // Any page change removes the card a preview is playing in, and a <video>
  // whose element is gone keeps its buffer and its decoder. Stopped explicitly.
  if (typeof _stopHoverTrailer === 'function') _stopHoverTrailer()
  // And every card on the outgoing page is released from the enrichment queue.
  // Without this the queue's observer, and the callback closure each card is
  // registered with, hold a reference to every card ever rendered — so the
  // elements are detached but never collectable.
  //
  // This was invisible to the soak's domNodes metric, which counts attached
  // nodes only, and to its listener count, since an observer is not a listener.
  // What it did show was the renderer's memory floor rising monotonically and
  // never coming down: measured at 0.6MB per navigation, 57.6MB over 96 page
  // changes, against 2.4MB for the same wall-clock sitting idle.
  if (typeof _releaseObservedCards === 'function') _releaseObservedCards()
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

  document.querySelectorAll('#content .album-card,#content .quick-card,#content .artist-card,#content .daily-mix-card,#content .q-mix-card,#content .jumpback-card,#content .folder-tree-item,#content .pl-card,#content .pl-folder-header,#content .genre-tile,#content .mood-card,#content .recent-search-card,#content .artist-pill,#content .discovery-swipe-card,#content .yt-row,#content .yt-album-card,#content .yt-artist-card,#content .yt-playlist-card,#content .dl2-group-toggle,#content .dl2-group-toggle-failed,#content .pl-track-row')
    .forEach(function (c) {
      if (c.hasAttribute('tabindex')) return
      c.setAttribute('tabindex', '0')
      c.setAttribute('role', 'button')
      // A collapsible header has to say whether it is open, and say it correctly
      // from the first render — not only after the first click.
      if (c.classList.contains('dl2-group-toggle') || c.classList.contains('dl2-group-toggle-failed')) {
        var _gi = c.dataset.gi
        var _list = _gi ? document.getElementById('dl2-gfiles-' + _gi) : null
        c.setAttribute('aria-expanded',
          String(!!(_list && _list.classList.contains('dl2-group-files-open'))))
      }
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
    // Pointer events, so this is a swipe by finger as well as by mouse -- which
    // is the gesture it is named after and the one it never supported.
    var _swipeStartX = 0
    var _swipeCard = null
    var _swipeId = null
    swipeEl.addEventListener('pointerdown', function(e) {
      if (e.button !== 0) return
      _swipeCard = e.target.closest('.discovery-swipe-card')
      if (!_swipeCard) return
      _swipeStartX = e.clientX
      _swipeId = e.pointerId
      // Or a touch drag scrolls the page instead of moving the card.
      e.preventDefault()
      try { swipeEl.setPointerCapture(e.pointerId) } catch (_) {}
    })
    // The a11y sweep gives these cards tabindex="0" and role="button", and the
    // delegated Enter/Space handler calls card.click() -- but there was no
    // click listener for this class anywhere, so Enter did nothing. Nineteen of
    // the twenty focusable card classes had one; this was the twentieth.
    // The pointer path handles its own taps and swipes; this exists for the
    // keyboard, where card.click() is dispatched directly on the card. It
    // ignores anything that arrives right after a pointer gesture, because
    // whether pointer capture also produces a synthetic click here is
    // implementation-dependent and must not decide whether a tap works.
    var _swipeHandledAt = 0
    swipeEl.addEventListener('click', function(e) {
      if (Date.now() - _swipeHandledAt < 400) return
      var card = e.target.closest('.discovery-swipe-card')
      if (!card || !card.dataset.album) return
      navigate('album', card.dataset.album)
    })
    swipeEl.addEventListener('pointercancel', function(e) {
      if (_swipeId !== e.pointerId) return
      _swipeCard = null; _swipeId = null
    })
    swipeEl.addEventListener('pointerup', function(e) {
      if (_swipeId !== e.pointerId) { _swipeCard = null; return }
      _swipeId = null
      try { swipeEl.releasePointerCapture(e.pointerId) } catch (_) {}
      // With pointer capture the up event targets the container, so the card is
      // the one recorded on the way down rather than whatever is under the
      // finger now.
      var card = _swipeCard
      if (!card) return
      var diff = e.clientX - _swipeStartX
      _swipeCard = null
      _swipeHandledAt = Date.now()
      if (Math.abs(diff) > 80) {
        var albumId = card.dataset.album
        var right = diff > 0
        card.classList.add(right ? 'swipe-right' : 'swipe-left')
        setTimeout(function() { card.remove() }, 300)
        if (!albumId) return
        var album = state.library.find(function (a) { return a.id === albumId })
        // Right is "yes": the album is queued. Left is "not this one". Either
        // way it leaves the deck, and either way it is undoable -- a gesture
        // that quietly discards a choice is worse than one that does nothing.
        _discoverDismiss(albumId)
        if (right && album) {
          addToQueue(album)
          showSnackbar('Queued ' + (album.name || 'album'), 'Undo', function () {
            _discoverUndismiss(albumId)
            renderHome()
          }, 5000)
        } else {
          showSnackbar('Hidden from Discover', 'Undo', function () {
            _discoverUndismiss(albumId)
            renderHome()
          }, 5000)
        }
        return
      }
      // Not a swipe: a short press opens the album.
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

  // The cover art used to have its own contextmenu handler that stopPropagation'd
  // and copied the artwork path -- so right-clicking the largest and easiest-to-
  // hit part of an album card gave "Path copied" instead of the album menu, the
  // one context-menu surface in the app that behaved differently from its
  // parent. The album menu already offers Copy path, so the special case only
  // diverged; the event now reaches the card like every other click on it.

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

// Two things were wrong here. `!sec` treated 0 as unknown, so the elapsed-time
// readout showed an em dash for the first second of every track, and "-—" as a
// track ended in remaining mode. And there was no hours component, so an
// hour-long file -- a live set, a DJ mix, a single classical movement -- read as
// "60:00", and fmtDur(-1) gave "-1:-1".
//
// Unknown is now only genuinely unknown: null, undefined or not a number. Zero
// is a real duration and formats as 0:00.
function fmtDur(sec) {
  // Number(null) and Number('') are both 0, which would render "unknown" as
  // 0:00 -- the opposite of the bug being fixed.
  if (sec == null || sec === '') return '—'
  const n = Number(sec)
  if (!Number.isFinite(n)) return '—'
  const total = Math.max(0, Math.round(n))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
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
        window.api.slskSearch({ query: v, timeoutMs: 45000, generation: -1 }).then(({ results }) => {
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
    // generation -1: a background search the UI search box must not cancel.
    window.api.slskSearch({ query: q, timeoutMs: 60000, generation: -1 })
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
    const btn = this
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = 'Downloading…'
    // Every enqueue used to be .catch(() => {}) individually, so a run where
    // all of them failed still reported "Queued ✓". Count instead.
    let queued = 0, failed = 0
    try {
      for (const f of best.files) {
        try {
          await window.api.slskDownload({ username: best.username, filename: f.filename, size: f.size || 0 })
          queued++
        } catch (_) { failed++ }
      }
    } finally {
      if (btn.isConnected) {
        if (queued && !failed) btn.textContent = 'Queued ✓'
        else if (queued) { btn.textContent = `Queued ${queued}, ${failed} failed`; btn.disabled = false }
        else { btn.textContent = label; btn.disabled = false; btn.title = 'Nothing could be queued — click to retry' }
      }
    }
    if (queued) _scheduleLibRescan()
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
  await _initVideoSettings()
}

async function _initVideoSettings() {
  const $ = id => document.getElementById(id)
  const keyInput = $('video-tmdb-key')
  if (!keyInput) return
  const res = await window.api.videoSettingsGet().catch(() => ({ ok: false }))
  const s = (res && res.settings) || {}
  $('video-prefer-surround').checked = s.preferSurround !== false
  $('video-quality').value = s.preferredQuality || '1080p'
  if (s.tmdbApiKey) keyInput.placeholder = 'Key saved ✓ — paste new one to change'
  const save = patch => window.api.videoSettingsSet(patch).catch(() => {})
  const saveKey = function () {
    const v = keyInput.value.trim()
    if (!v) return
    save({ tmdbApiKey: v })
    keyInput.value = ''
    keyInput.placeholder = 'Saved ✓'
    setTimeout(function () { keyInput.placeholder = 'Key saved ✓ — paste new one to change' }, 1500)
  }
  keyInput.addEventListener('change', saveKey)
  keyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveKey()
  })
  $('video-prefer-surround').addEventListener('change', e => save({ preferSurround: !!e.target.checked }))
  $('video-quality').addEventListener('change', e => save({ preferredQuality: e.target.value }))
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
  const alsa = devices.filter(d => d.name.startsWith('alsa/'))
  // The saved device string can name a sink that no longer exists — a card
  // removed, a dock unplugged, a PipeWire rename. That used to be discovered at
  // spawn time, as a failure to start playing, with the setting still showing
  // the missing device as if it were fine.
  const savedMissing = !!cfg.alsaDevice && !alsa.some(d => d.name === cfg.alsaDevice)
  $('pb-alsa-device').innerHTML =
    // Keep the missing device in the list, marked, rather than silently
    // selecting a different one: replacing the user's choice without saying so
    // is worse than showing that it is gone.
    (savedMissing
      ? `<option value="${esc(cfg.alsaDevice)}" selected>${esc(cfg.alsaDevice)} — not connected</option>`
      : '') +
    alsa
      // mpv reports these verbatim from the driver; a description containing a
      // quote would break out of the attribute.
      .map(d => `<option value="${esc(d.name)}" ${d.name === cfg.alsaDevice ? 'selected' : ''}>${esc(d.description)}</option>`)
      .join('')
  const devWarn = $('pb-device-warning')
  if (devWarn) {
    devWarn.textContent = savedMissing
      ? `${cfg.alsaDevice} is not connected. Exclusive mode will fail to start until you pick another device.`
      : ''
    devWarn.style.display = savedMissing ? '' : 'none'
  }
  if (savedMissing && cfg.outputMode === 'exclusive') {
    console.error('[papa] the configured ALSA device is not present:', cfg.alsaDevice)
    showSnackbar(`The chosen audio device (${cfg.alsaDevice}) is not connected`, '', function () {}, 8000)
  }

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

  await _initGeneralSettings()
  await _initEqSettings(cfg, apply)
}

// Reads what main will actually consult, not a separate renderer copy — the
// setting is stored once and honoured in main's close handler.
async function _initGeneralSettings() {
  const el = document.getElementById('gen-close-to-tray')
  if (!el) return
  try {
    const gen = await window.api.getGeneralSettings()
    el.checked = gen && gen.closeToTray !== false
  } catch (_) {
    // A failed read must not leave the box showing a value main does not hold.
    el.checked = true
  }
  el.onchange = e => window.api.saveGeneralSettings({ closeToTray: !!e.target.checked })

  const hov = document.getElementById('gen-hover-trailers')
  if (!hov) return
  // Local, not in the main store: it changes nothing outside this window and
  // the renderer is the only thing that reads it.
  hov.checked = _hoverTrailersOn
  hov.onchange = e => setHoverTrailers(!!e.target.checked)
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
    // This one really cannot be undone, so it keeps a confirmation -- the app's
    // own, which does not stop the renderer's event loop.
    _mgConfirm('Clear all assistant memory?',
      '<p>Saved conversations and the taste profile are deleted. This cannot be undone.</p>',
      'Clear memory', async function () {
        await window.api.agentClearMemory()
        _renderMemoryTab()
      })
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
          // slskd sends hasFreeUploadSlot (boolean) and queueLength. It has
          // never sent freeUploadSlots -- confirmed against a live response,
          // whose fields are: fileCount, files, hasFreeUploadSlot,
          // lockedFileCount, lockedFiles, queueLength, token, uploadSpeed,
          // username. main.js:3317 already read the right name; this path did
          // not, so `freeUploadSlots || 0` was always 0 and the availability
          // bonus never once fired.
          hasFreeSlot: !!resp.hasFreeUploadSlot,
          queueLength: resp.queueLength || 0,
          lockedFileCount: resp.lockedFileCount || 0,
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
    // Can we actually download this NOW? For a Soulseek client this is the
    // single most useful signal, and it was dead.
    if (g.hasFreeSlot) s += 25
    // Queue depth matters enormously and was ignored entirely: a peer 1700 deep
    // ranked identically to an idle one. Log-scaled so a short queue is nearly
    // free and a huge one is decisive, but bounded so it cannot swamp format.
    if (g.queueLength > 0) s -= Math.min(Math.log2(g.queueLength + 1) * 3, 30)
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
        _showSurroundOffenders(`Labelled ${label}, but these tracks are not surround`, res.offenders)
      })
    } else {
      showSnackbar(`Warning: labelled ${label} but no track is surround`, 'Show', () => {
        _showSurroundOffenders(`Labelled ${label}, but no track is surround`, res.offenders)
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
  // Precomputed once per group rather than inside the comparator, which ran
  // groupSurround (7 regexes over every filename in the folder) O(n log n)
  // times per sort -- and this sort runs every second while a search is live.
  const _SFpre = window.PapaSlskFilters
  for (const g of rawGroups) {
    g._sur  = _SFpre ? (_SFpre.groupSurround(g) ? 1 : 0) : 0
    g._flac = g.files.filter(f => f.isFlac).length
    g._q    = _qScore(g)
  }
  const groups = rawGroups.sort((a, b) => {
    // Surround first, always. It is the rarest thing in these results and the
    // whole reason for searching; a lossless stereo rip ranking above a 5.1 one
    // buries the only copy worth having.
    if (a._sur !== b._sur) return b._sur - a._sur
    if (b._flac !== a._flac) return b._flac - a._flac
    const qs = b._q - a._q
    if (Math.abs(qs) > 0.15) return qs
    // Between otherwise comparable copies, prefer the one you can actually
    // start downloading. slskd gives us hasFreeUploadSlot and queueLength on
    // every response and neither was used anywhere in ranking, so a peer 1700
    // deep in its own queue ranked identically to an idle one.
    const aAvail = (a.hasFreeSlot ? 1 : 0), bAvail = (b.hasFreeSlot ? 1 : 0)
    if (aAvail !== bAvail) return bAvail - aAvail
    const aQ = Math.min(a.queueLength || 0, 500), bQ = Math.min(b.queueLength || 0, 500)
    if (Math.abs(aQ - bQ) > 25) return aQ - bQ
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
  // The cap keeps the grid usable, but with responseLimit 3000 across six
  // variants the discarded tail routinely contains better sources — and nothing
  // said it existed. The limit is now extensible and the count is stated.
  const displayList   = filtered.slice(0, _slskShowLimit)
  const hiddenCount   = Math.max(0, filtered.length - displayList.length)
  // data-gi is an index into displayList, which is FLAC-partitioned,
  // surround-sorted, filtered and capped at 60. bindSlskSearchEvents used to
  // rebuild its own array from _slskGroupByFolder(), which has none of that --
  // so every handler indexed a different folder from a different peer.
  _slskRendered = displayList
  const filteredNote  = slsk.filter !== 'all'
    ? ` · <span class="slsk-filter-note">${filtered.length} match${filtered.length !== 1 ? 'es' : ''}</span>` : ''
  const cappedNote    = hiddenCount
    ? ` · <span class="slsk-filter-note">showing ${displayList.length} of ${filtered.length}</span>` : ''
  const isUpdating   = slsk.searching && slsk.results.length > 0
  const pending      = slsk.pendingSearches || 0
  const updateNote   = isUpdating ? ` <span class="slsk-updating">· scanning${pending > 0 ? ' ('+pending+' left)' : ''}${_slskElapsed > 0 ? ' ('+_slskElapsed+'s)' : ''}…</span>` : ''
  const summary      = flacGroups.length
    ? `${flacGroups.length} lossless${otherGroups.length > 0 ? ` · ${otherGroups.length} other` : ''} source${groups.length !== 1 ? 's' : ''}${filteredNote}${cappedNote}${updateNote}`
    : `${groups.length} source${groups.length !== 1 ? 's' : ''}${cappedNote}${updateNote}`

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
    ${hiddenCount ? `<div class="slsk-show-more-row">
      <button class="slsk-retry-btn" id="slsk-show-more">Show ${Math.min(hiddenCount, SLSK_SHOW_STEP)} more of ${filtered.length}</button>
    </div>` : ''}
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
  const myRun = ++_slskRun
  const current = () => _slskRun === myRun
  // A different query gets its own retry allowance; the same query re-run by the
  // backoff keeps its latch so it cannot loop.
  if (slsk.lastQuery !== query) { _slskResetThrottleRetry(); _slskShowLimit = SLSK_SHOW_STEP }
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
  // Retire the previous generation's searches at the daemon. Each search runs
  // six variants for up to 30 s, so starting a new one left all six of the old
  // ones competing for the same peers and the daemon's search slots.
  window.api.slskCancelSearches({ keepGeneration: myRun })
    .catch(e => console.error('[papa] could not cancel the superseded searches:', String(e && e.message || e)))

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
  if (!section) {
    // Bailing out here used to leave slsk.searching === true forever, with no
    // timer running. Coming back to the search page then showed a frozen
    // "Searching P2P network… (0s)" that nothing could ever clear.
    slsk.searching = false
    slsk.searched = false
    return
  }

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
  // key -> index in slsk.results, so a later, richer response REPLACES an
  // earlier partial one instead of being discarded.
  const seen = new Map()
  let _flushQueued = false

  const _flush = () => {
    if (_flushQueued) return
    _flushQueued = true
    requestAnimationFrame(() => {
      _flushQueued = false
      if (!current()) return
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
      const at = seen.get(key)
      if (at === undefined) { seen.set(key, slsk.results.length); slsk.results.push(r); continue }
      // slskd pushes CUMULATIVE partial responses every ~2.5s, so the same peer
      // arrives repeatedly with a growing file list under an unchanged key. The
      // old code kept the FIRST, which is the smallest: albums showed as 3 of
      // 12 tracks and "Download all" fetched an incomplete album.
      const prev = slsk.results[at]
      if ((r.files || []).length > (prev.files || []).length) slsk.results[at] = r
    }
  }

  // Progressive results via push events — fires every ~2.5s from main process
  // This gives us intermediate results BEFORE the IPC invoke resolves
  // off() is removeAllListeners on the channel, so this search and the Set up
  // Soulseek button were tearing down each other's listener — starting a setup
  // mid-search silently stopped the results updating. Own the subscription
  // instead.
  if (_slskProgressOff) { _slskProgressOff(); _slskProgressOff = null }
  _slskProgressOff = window.api.on('slsk-progress', (d) => {
    if (d.query && !variants.includes(d.query) && d.query.toLowerCase() !== query.toLowerCase()) return
    if (!current()) return
    _mergeResults(d.results)
    _flush()
  })
  const _unsubscribeProgress = () => { if (_slskProgressOff) { _slskProgressOff(); _slskProgressOff = null } }

  // Run all variants in parallel; each returns after 25s max (or earlier with enough results)
  const TIMEOUT = 25000
  await Promise.all(variants.map(q =>
    window.api.slskSearch({ query: q, timeoutMs: TIMEOUT, noCache: _nocacheQueries.has(q.toLowerCase()), generation: myRun }).then(({ results, cancelled }) => {
      if (!current() || cancelled) return
      _mergeResults(results)
    }).catch((e) => {
      if (!current()) return
      // Was `.catch(() => {})`, so a dead daemon, a 401 or a timeout was
      // indistinguishable from a genuinely empty search: the user was told
      // "Nothing found on the P2P network" and invited to Retry forever.
      slsk.error = _slskErrText(e)
      // Throttling is not a failed search, it is a search that has not happened
      // yet. main already backs off internally; by the time it reaches here it
      // has given up, so the retry belongs at this level — once, per search,
      // with the wait visible rather than the results just never arriving.
      if (_slskIsThrottleError(e)) _slskScheduleThrottleRetry(query)
    }).finally(() => {
      if (!current()) return
      slsk.pendingSearches = Math.max(0, slsk.pendingSearches - 1)
      if (slsk.pendingSearches === 0) {
        slsk.searching = false
        slsk.searched  = true
        // Paint the finished state. The timer is torn down two lines below, so
        // without this the last batch of results -- often ALL of them, when the
        // variants resolve faster than the 1s tick -- was merged into
        // slsk.results and never rendered. The page sat on "Searching…" or an
        // empty grid until some unrelated action repainted the section.
        _slskRepaint(query)
        _unsubscribeProgress()
        if (_slskTimer) { clearInterval(_slskTimer); _slskTimer = null }
      }
      _flush()
    })
  ))

  // Final cleanup in case some variant is still pending (shouldn't happen after Promise.all)
  _unsubscribeProgress()
  slsk.searching = false
  slsk.searched  = true
  if (_slskTimer) { clearInterval(_slskTimer); _slskTimer = null }
  _flush()
}

async function refreshSlskStatus() {
  try { slsk.status = await window.api.slskStatus() } catch (_) {}
}

// Was three bare setTimeout calls with no stored handles, from 19 call sites. A
// burst of downloads or tag edits queued dozens of overlapping full-library
// syncs that could not be throttled or cancelled — and each one walks the whole
// library. One handle per delay: a later call reschedules that delay rather than
// stacking another timer on it.
// Must match main.js's LIB_RESCAN_DELAYS and the cadence CLAUDE.md documents.
// test/rescan-cadence.test.js asserts all three agree.
const _LIB_RESCAN_DELAYS = [15_000, 45_000, 120_000]
const _libRescanTimers = new Map()
function _scheduleLibRescan() {
  for (const delay of _LIB_RESCAN_DELAYS) {
    clearTimeout(_libRescanTimers.get(delay))
    _libRescanTimers.set(delay, setTimeout(() => {
      _libRescanTimers.delete(delay)
      backgroundSync()
    }, delay))
  }
}

// So a navigation away, or a shutdown, can stop work nobody is waiting for.
function _cancelLibRescan() {
  for (const t of _libRescanTimers.values()) clearTimeout(t)
  _libRescanTimers.clear()
}

// ── Downloads page ────────────────────────────────────────────────────────────
let _dlPollTimer        = null
let _dlPollInterval     = 6000
let _dlTab              = 'active'   // 'active' | 'completed' | 'failed'
let _dlLastFiles        = []
let _dlDaemonDown       = false

// Shown OVER the last known list rather than replacing it. Wiping the page on a
// transient poll failure loses real state the user was reading, and slskd
// restarts are routine (main.js restarts it automatically after 3 failures).
function _dlRenderDaemonDown() {
  var list = document.getElementById('dl2-list')
  if (!list || !list.parentNode) return
  var id = 'dl2-daemon-banner'
  var el = document.getElementById(id)
  if (!el) {
    el = document.createElement('div')
    el.id = id
    el.className = 'dl2-daemon-banner'
    list.parentNode.insertBefore(el, list)
  }
  el.textContent = "Can't reach the Soulseek daemon — showing the last known state. "
  var btn = document.createElement('button')
  btn.className = 'dl2-action-btn'
  btn.textContent = 'Retry'
  btn.addEventListener('click', function () { _pollAndRenderDownloads() })
  el.appendChild(btn)
}

function _dlClearDaemonBanner() {
  var el = document.getElementById('dl2-daemon-banner')
  if (el && el.parentNode) el.parentNode.removeChild(el)
}

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
  //
  // The id set alone was deliberate, so progress updates patch in place instead
  // of repainting — but a transition that changed neither the id set nor the
  // count was invisible, and Queued -> InProgress is exactly that. A coarse
  // count-per-state is enough to notice it without repainting on every byte.
  var h = 0
  var byState = {}
  for (var i = 0; i < files.length; i++) {
    var id = String(files[i].id)
    for (var j = 0; j < id.length; j++) h = (h * 31 + id.charCodeAt(j)) | 0
    var st = String(files[i].state || '?')
    byState[st] = (byState[st] || 0) + 1
  }
  var states = Object.keys(byState).sort().map(function (k) { return k + ':' + byState[k] }).join(',')
  return tab + '|' + files.length + '|' + h + '|' + states
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

// One place that decides the rate. The poll fetches the whole transfer list,
// structured-clones it across the IPC bridge in both directions, then flattens
// and hashes it — on the thread that pumps mpv's IPC. It used to run at 6 s for
// the life of the process regardless of what was on screen or whether anything
// was downloading, and stopDownloadsPolling() was never called at all.
const DL_POLL_ON_PAGE_MS = 2000
const DL_POLL_ACTIVE_MS = 20000
const DL_POLL_IDLE_MS = 60000
function _dlHasActive() {
  return (_dlLastFiles || []).some(f => _dlCategory(f.state) === 'active')
}

function retuneDownloadsPolling() {
  // Nobody is looking and nothing is moving: stop entirely. The next transfer
  // starts from a click or from the scheduler, and both repaint the page, which
  // brings the poll back through the paths below.
  if (!_appVisible && !_dlHasActive()) { stopDownloadsPolling(); return }
  if (state.currentPage === 'downloads') { startDownloadsPolling(DL_POLL_ON_PAGE_MS); return }
  startDownloadsPolling(_dlHasActive() ? DL_POLL_ACTIVE_MS : DL_POLL_IDLE_MS)
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
// A poll frame that throws must not become an unhandled rejection every tick,
// and must not leave the page silently frozen on stale data. The _dlWaitLabel
// comment further down records a previous instance of exactly this: a function
// referenced but never defined, throwing on every render of the Downloading tab.
let _dlFrameFailures = 0
const _DL_FRAME_FAILURES_BEFORE_TELLING = 3

async function _pollAndRenderDownloads() {
  // Re-entrancy guard: an older response landing after a newer one used to
  // write stale _dlLastFiles, flickering cancelled rows back into the list.
  if (_dlPollInFlight) return
  _dlPollInFlight = true
  try {
    const r = await _pollAndRenderDownloadsInner()
    _dlFrameFailures = 0
    return r
  } catch (e) {
    _dlFrameFailures++
    console.error(`[papa] downloads poll frame failed (${_dlFrameFailures} in a row):`,
      (e && e.stack) || String(e))
    // Once is a blip. Three times running means the page is showing stale data
    // and will keep doing so, which the user has no way to know otherwise.
    if (_dlFrameFailures === _DL_FRAME_FAILURES_BEFORE_TELLING) {
      showSnackbar('The downloads list stopped updating — see the log for why', '', function () {}, 8000)
    }
  } finally { _dlPollInFlight = false }
}

async function _pollAndRenderDownloadsInner() {
  var _dlReachable = true
  const raw = await window.api.slskGetTransfers().catch(function () { _dlReachable = false; return null })
  _dlDaemonDown = !_dlReachable
  // A single failed poll must not erase the page. Treating an unreachable
  // daemon as "zero transfers" zeroed every tab badge, hid the nav badge,
  // blanked the list, and -- because the active count had just dropped to zero
  // -- fired a "downloads complete" notification mid-download. Keep showing the
  // last known state; the banner says it is stale.
  if (!_dlReachable) {
    _dlRenderDaemonDown()
    return
  }
  _dlClearDaemonBanner()
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
  // A transfer finishing is exactly when the fast poll stops being worth its
  // cost, and a new one starting is when it becomes worth it again.
  retuneDownloadsPolling()

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

// One classifier, shared with main (src/dl-state.js). This one filed
// 'Scheduled' under FAILED while the label table below called it "Waiting", so
// a scheduled transfer appeared in the Failed tab labelled "Waiting".
function _dlCategory(stateStr) {
  return window.PapaDlState.classify(stateStr)
}

function _dlIsActive(stateStr) { return _dlCategory(stateStr) === 'active' }

// The label lives next to the classifier now, so a state can never be labelled
// from one table and filed under another.
function _dlStateLabel(stateStr) {
  return window.PapaDlState.label(stateStr)
}

// The B branch only fired for exactly zero, so a 1-byte file read "0.0 KB",
// and there was no TB unit, so a terabyte read "1024.00 GB" -- which matters
// because the storage report totals a multi-terabyte library.
const _BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
function _fmtBytes(b) {
  const n = Number(b)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let i = 0
  let v = n
  while (v >= 1024 && i < _BYTE_UNITS.length - 1) { v /= 1024; i++ }
  // Whole bytes are whole; everything else keeps enough precision to be useful
  // without pretending to more than it has.
  if (i === 0) return `${Math.round(v)} B`
  return `${v.toFixed(i >= 3 ? 2 : 1)} ${_BYTE_UNITS[i]}`
}

function _fmtSpeed(bps) {
  if (!bps) return ''
  if (bps < 1048576) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1048576).toFixed(1)} MB/s`
}

// slskd is .NET, and a TimeSpan serialises as `[d.]hh:mm:ss[.fffffff]` -- the
// day part only appears past 24 hours, which is exactly when the number matters
// most. Splitting on ':' and calling the first field "hours" made
// "1.02:03:04" (1d 2h 3m 4s = 93,784 s) parse as 3,856 s and display as
// "1h 4m", and "2.00:00:00" display as "2h 0m". A single field was read as
// hours, so "30" became thirty hours.
//
// One parser, used by both readers below.
function _hmsToSecs(hms) {
  const str = String(hms == null ? '' : hms).trim()
  if (!str) return 0
  let days = 0
  let rest = str
  // The day separator is a dot, and so is the fractional-seconds separator, so
  // the day part is only the leading dot-group when a colon follows it.
  const dot = rest.indexOf('.')
  if (dot > 0 && rest.indexOf(':') > dot) {
    const d = Number(rest.slice(0, dot))
    if (Number.isFinite(d)) days = d
    rest = rest.slice(dot + 1)
  }
  const parts = rest.split(':')
  // Fractional seconds are dropped rather than rounded: an ETA to the
  // ten-millionth of a second is noise.
  const nums = parts.map(p => {
    const v = Number(String(p).split('.')[0])
    return Number.isFinite(v) ? v : 0
  })
  // A short value is seconds, then mm:ss, then hh:mm:ss -- counted from the
  // right, which is how every one of these formats works.
  let secs = 0
  let mult = 1
  // Stops after the hours field: anything beyond it is the day part, already
  // taken above, and a fourth colon-group would be malformed.
  for (let i = nums.length - 1; i >= 0 && mult <= 3600; i--) {
    secs += nums[i] * mult
    mult *= 60
  }
  return Math.max(0, days * 86400 + secs)
}

function _fmtEta(s) {
  const secs = _hmsToSecs(s)
  if (!secs) return ''
  return _fmtSecs(secs)
}

function _fmtSecs(secs) {
  const n = Math.floor(Number(secs) || 0)
  if (n <= 0) return ''
  // A days component, because a Soulseek ETA genuinely does exceed a day and
  // "51h 4m" is harder to read than "2d 3h".
  if (n >= 86400) return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`
  if (n >= 3600)  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
  if (n >= 60)    return `${Math.floor(n / 60)}m ${n % 60}s`
  return `${n}s`
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
    btn.addEventListener('click', () => {
      if (btn.disabled) return
      const t = state._torrents?.get(btn.dataset.hash)
      const pct = t && t.progress ? Math.round(t.progress * 100) : 0
      // The last native confirm() in the renderer. Partial progress is worth
      // warning about -- it is thrown away -- so this keeps a confirmation, in
      // the app's own modal.
      _mgConfirm('Remove this torrent?',
        '<p>' + esc((t && t.name) || 'This torrent') + '</p>' +
        (pct ? '<p>It is ' + pct + '% complete. That progress is discarded.</p>' : ''),
        'Remove', async function () {
          btn.disabled = true
          let ok = true
          await window.api.torrentRemove(btn.dataset.hash).catch(() => { ok = false })
          if (!ok) {
            // Was dropped from local state regardless, so a failed remove left
            // the row gone from the UI while the torrent kept running.
            if (btn.isConnected) btn.disabled = false
            showSnackbar("Couldn't remove that torrent")
            return
          }
          state._torrents?.delete(btn.dataset.hash)
          _renderTorrentSection()
        })
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
      const btn = this
      btn.disabled = true
      btn.textContent = 'Retrying…'
      // _pollAndRenderDownloads re-renders on success, replacing this button.
      // When it fails it does not, so without this the only retry control on
      // the page stayed dead and the user was stuck on the error state.
      Promise.resolve(_pollAndRenderDownloads()).catch(() => {}).then(function () {
        if (!btn.isConnected) return
        btn.disabled = false
        btn.textContent = 'Retry'
      })
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
    // f.id comes from slskd. A quote in it made this throw on every tick until
    // the download cleared — and line ~12356 already does this correctly.
    const row = container.querySelector(`.dl2-file[data-dl-id="${CSS.escape(String(f.id))}"]`)
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
    // JSON, not a comma join: slskd ids are file paths and file paths contain
    // commas, so splitting on one tore an id in half and cancelled nothing.
    const groupIds   = JSON.stringify(g.files.map(f => f.id))

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
      let ids = []
      try {
        ids = JSON.parse(btn.dataset.ids || '[]')
      } catch (e) {
        // An older render, or a value that did not survive the attribute.
        console.error('[papa] could not read the transfer ids for this group:', String(e && e.message || e))
      }
      ids = (Array.isArray(ids) ? ids : []).filter(Boolean)
      if (!ids.length) { btn.disabled = false; return }
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
      // Focus and Enter/Space already worked, via the a11y sweep and the
      // delegated keydown handler. What was missing was the state: a screen
      // reader was told this is a button and nothing about what it did.
      hdr.setAttribute('aria-expanded', String(isNowOpen))
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
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      _dlBtnAction(btn, async () => {
        // alreadyDone: this transfer has already finished or failed, so there
        // is no live scheduler intent to cancel -- and skipping that lookup
        // skips a FULL /transfers/downloads fetch (~1 MB) per item.
        await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id, alreadyDone: true }).catch(() => {})
        await _pollAndRenderDownloads()
      })
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

    // JSON, not a comma join — see the note at the other call site.
    const groupIds = JSON.stringify(g.files.map(f => f.id))

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
      hdr.setAttribute('aria-expanded', String(isNowOpen))
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
    btn.addEventListener('click', e => {
      e.stopPropagation()
      _dlBtnAction(btn, async () => {
        const gi = parseInt(btn.dataset.gi)
        const g  = groups[gi]
        // This used to return with the button already disabled, so a stale gi
        // killed the control permanently.
        if (!g) return
        await Promise.all(g.files.map(f =>
          // Failed, so no live intent -- and the re-download below re-creates it.
          window.api.slskCancelTransfer({ username: f.username, id: f.id, alreadyDone: true }).catch(() => {})
        ))
        await Promise.all(g.files.map(f =>
          window.api.slskDownload({ username: f.username, filename: f.filename, size: f.size || 0 }).catch(() => {})
        ))
        _dlTab = 'active'; _dlLastSig = ''
        _setActiveTab('.dl2-tab', document.querySelector('.dl2-tab[data-tab="active"]'))
        await _pollAndRenderDownloads()
      })
    })
  })

  // Clear all files in a group
  container.querySelectorAll('.dl2-clear-group-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      _dlBtnAction(btn, async () => {
        // Each file carries its own peer: a folder group can span several.
        var pairs = []
        try { pairs = JSON.parse(btn.dataset.pairs || '[]') } catch (_) {}
        var results = await Promise.all(pairs.map(function (p) {
          return window.api.slskCancelTransfer({ username: p[0], id: p[1], alreadyDone: true })
            .then(function () { return true }).catch(function () { return false })
        }))
        var failed = results.filter(function (ok) { return !ok }).length
        if (failed) showSnackbar(failed + ' of ' + results.length + " couldn't be cleared")
        await _pollAndRenderDownloads()
      })
    })
  })

  // Retry single file
  container.querySelectorAll('.dl2-retry-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      _dlBtnAction(btn, async () => {
        await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id, alreadyDone: true }).catch(() => {})
        await window.api.slskDownload({ username: btn.dataset.user, filename: btn.dataset.filename, size: Number(btn.dataset.size) }).catch(() => {})
        _dlTab = 'active'; _dlLastSig = ''
        _setActiveTab('.dl2-tab', document.querySelector('.dl2-tab[data-tab="active"]'))
        await _pollAndRenderDownloads()
      })
    })
  })

  // Remove single file
  container.querySelectorAll('.dl2-remove-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      _dlBtnAction(btn, async () => {
        await window.api.slskCancelTransfer({ username: btn.dataset.user, id: btn.dataset.id, alreadyDone: true }).catch(() => {})
        await _pollAndRenderDownloads()
      })
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
    // The confirm used to be gated on the active tab only, so on Completed a
    // single click irreversibly wiped the entire download history -- 1,451
    // records on this machine -- with no warning at all.
    const n = subset.length
    const title = _dlTab === 'active'
      ? 'Cancel ' + n + ' download' + (n === 1 ? '' : 's') + '?'
      : 'Remove ' + n + ' ' + _dlTab + ' item' + (n === 1 ? '' : 's') + ' from the list?'
    const body = _dlTab === 'active'
      ? '<p>Soulseek cannot resume — these have to be queued again.</p>'
      : '<p>This clears the history in slskd. Files already on disk are not touched.</p>'
    _mgConfirm(title, body, _dlTab === 'active' ? 'Cancel them' : 'Remove them', function () {
      return _dlClearAllNow(btn, subset, n)
    })
  })

  async function _dlClearAllNow(btn, subset, n) {
    const originalText = btn.textContent
    btn.disabled = true
    const done = { n: 0 }
    const paint = () => { btn.textContent = (_dlTab === 'active' ? 'Cancelling ' : 'Clearing ') + done.n + '/' + n }
    paint()
    // Was Promise.all over the whole subset. Each cancel makes the main process
    // fetch the FULL transfer list (~1 MB) to resolve the filename, so clearing
    // 1,451 completed items fired ~1.4 GB of concurrent HTTP at slskd plus one
    // synchronous store write each. Bounded concurrency, and completed/failed
    // items skip the filename lookup entirely -- it exists to cancel a live
    // scheduler intent, which a finished transfer does not have.
    const alreadyDone = _dlTab !== 'active'
    const queue = subset.slice()
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift()
        await window.api.slskCancelTransfer({ username: f.username, id: f.id, alreadyDone })
          .catch(() => {})
        done.n++
        if (done.n % 10 === 0 || !queue.length) paint()
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    await _pollAndRenderDownloads()
    if (btn) { btn.disabled = false; btn.textContent = originalText }
  }

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
    _mgConfirm('Stop ' + active.length + ' download' + (active.length === 1 ? '' : 's') + '?',
      '<p>Soulseek cannot resume — these will have to be queued again.</p>',
      'Stop them', function () {
        active.forEach(function(f) {
          window.api.slskCancelTransfer({ username: f.username, id: f.id })
        })
        showSnackbar('Stopped ' + active.length + ' download' + (active.length === 1 ? '' : 's'))
      })
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
    // Its own subscription, removed by its own handle: this used to call
    // off('slsk-progress') and take a running search's listener with it.
    const offSetupProgress = window.api.on('slsk-progress', d => { if (btn) btn.textContent = d.text })
    const res = await window.api.slskSetup()
    offSetupProgress()
    if (res.ok) {
      await refreshSlskStatus()
      if (!slsk.status.configured) showSlskConfigModal(query)
    } else {
      // A snackbar rather than a blocking alert; the section re-renders below
      // and offers the button again either way.
      showSnackbar('slskd install failed: ' + (res.error || 'unknown'), null, null, 8000)
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

  section.querySelector('#slsk-show-more')?.addEventListener('click', () => {
    // Extend rather than replace: the discarded tail routinely contains better
    // sources, and nothing used to say it existed.
    _slskShowLimit += SLSK_SHOW_STEP
    _rerenderSlskSection(query)
  })

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
// The live explorer's own close function. Its close() does remove the keydown
// listener — but opening the explorer for a second user removed the first one's
// DOM directly, so that instance's listener stayed registered forever, holding
// its whole closure: the folder tree, the history and every file list in it.
// Third instance of the same shape as items 73 and 74.
var _slskExplorerClose = null

async function showSlskUserExplorer(username) {
  hideContextMenu()
  if (_slskExplorerClose) { try { _slskExplorerClose() } catch (_) {} }
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

  const close = () => {
    if (_slskExplorerClose === close) _slskExplorerClose = null
    document.removeEventListener('keydown', onKey)
    dlg.remove()
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
      // Restored on success too: the tick used to be permanent, so a file that
      // failed later in the transfer could not be asked for again.
      setTimeout(() => { if (btn.isConnected) { btn.innerHTML = orig; btn.disabled = false } }, 2500)
    } catch (e) {
      btn.textContent = '✕'; btn.title = 'Failed: ' + (e?.message || 'error')
      setTimeout(() => { if (btn.isConnected) { btn.innerHTML = orig; btn.disabled = false } }, 2500)
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
        await _slskEnqueue(files.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
        btn.textContent = `${files.length} queued`
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

    dlg.querySelector('#slskx-dl-tree')?.addEventListener('click', async ev => {
      // Walk every descendant folder, not just this one.
      const collect = (n, out = []) => {
        for (const f of n.files) if (T.AUDIO_RE.test(f.name)) out.push(f)
        for (const c of n.dirs.values()) collect(c, out)
        return out
      }
      const files = collect(l.node)
      const btn = ev.target
      const label = btn.textContent
      btn.disabled = true
      btn.textContent = `Queuing ${files.length}…`
      try {
        await _slskEnqueue(files.map(f => ({ username, filename: f.fullPath, size: f.size || 0 })))
        btn.textContent = `${files.length} queued`
        _scheduleLibRescan()
      } catch (e) {
        btn.disabled = false
        btn.textContent = label
        showSnackbar('Could not queue the tree: ' + String(e && e.message || e), null, null, 6000)
      }
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
    <!-- Errors land here rather than in a blocking alert, and the dialog stays
         usable so the user can correct the password and try again. -->
    <div id="slsk-cfg-error" class="mcs-set-warning" style="display:none;margin-top:10px"></div>
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
    if (!username || !password) {
      const err = dlg.querySelector('#slsk-cfg-error')
      if (err) { err.textContent = 'Username and password are required'; err.style.display = '' }
      return
    }
    const saveBtn = dlg.querySelector('#slsk-cfg-save')
    const saveLabel = saveBtn.textContent
    saveBtn.disabled = true
    saveBtn.textContent = 'Connecting…'
    // A rejection here used to leave the dialog open with a dead button, no
    // error and no way to retry but closing and reopening it.
    try {
      const res = await window.api.slskConfigure({ username, password })
      if (res && res.ok === false) throw new Error(res.error || 'slskd refused the credentials')
    } catch (e) {
      saveBtn.disabled = false
      saveBtn.textContent = saveLabel
      const err = dlg.querySelector('#slsk-cfg-error')
      const msg = 'Could not connect: ' + String(e && e.message || e)
      if (err) { err.textContent = msg; err.style.display = '' }
      else showSnackbar(msg, null, null, 6000)
      return
    }
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

  // This one mattered most. initSearchHistory() is called synchronously from
  // setupListeners(), so an unguarded throw here aborted the rest of the wiring:
  // queue panel, sleep timer, sidebar resize, drag and drop and every keyboard
  // shortcut went unbound for the whole session, with nothing shown.
  let history       = window.PapaLocal.readArray(HISTORY_KEY)
    .map(function(h) { return typeof h === 'string' ? { query: h, ts: Date.now() - 86400000 } : h })
    .filter(function(h) { return h && typeof h.query === 'string' && h.query })
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
      window.api.ytMusicSearch({ query: q }).catch(function (e) {
        console.error('[papa] live YouTube search failed:', String(e && e.message || e))
        return { ok: false }
      }).then(function(res) {
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
  // touch-action:none is not optional: without it a touch drag scrolls the
  // panel instead of resizing it, and the pointermove events never arrive.
  handle.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:10px;cursor:col-resize;z-index:10;touch-action:none'
  var _qrId = null
  var _qrStartX = 0
  var _qrStartWidth = 0
  handle.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return
    e.preventDefault()
    _qrId = e.pointerId
    _qrStartX = e.clientX
    _qrStartWidth = panel.offsetWidth
    try { handle.setPointerCapture(e.pointerId) } catch (_) {}
  })
  handle.addEventListener('pointermove', function(e) {
    if (_qrId !== e.pointerId) return
    var newWidth = _qrStartWidth - (e.clientX - _qrStartX)
    panel.style.width = Math.max(240, Math.min(500, newWidth)) + 'px'
  })
  function _qrEnd(e) {
    if (_qrId !== e.pointerId) return
    _qrId = null
    try { handle.releasePointerCapture(e.pointerId) } catch (_) {}
    try { localStorage.setItem('papa-queue-width', panel.style.width) } catch (_) {}
  }
  handle.addEventListener('pointerup', _qrEnd)
  handle.addEventListener('pointercancel', _qrEnd)
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
    const card = e.target.closest('.album-card,.quick-card,.artist-card,.daily-mix-card,.q-mix-card,.jumpback-card,.folder-tree-item,.pl-card,.pl-folder-header,.genre-tile,.mood-card,.recent-search-card,.artist-pill,.discovery-swipe-card,.yt-row,.yt-album-card,.yt-artist-card,.yt-playlist-card,.dl2-group-toggle,.dl2-group-toggle-failed,.pl-track-row')
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
    _mgPrompt('Set volume', {
      label: '0 to 100',
      value: Math.round(audio.volume * 100),
      confirmLabel: 'Set',
      onConfirm: function (v) {
        var n = parseInt(v, 10)
        if (!Number.isFinite(n)) return
        audio.volume = Math.max(0, Math.min(100, n)) / 100
        state.lastVolume = audio.volume
        setVolDisplay(audio.volume)
        clearTimeout(_volSaveTimer)
        _volSaveTimer = setTimeout(function() { window.api.saveVolume(audio.volume) }, 300)
      },
    })
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

  // Radio context menu — smart-queue radio when we have a seed file, falling
  // back to the old artist/genre radio for surfaces with no single track.
  _ctxOn('ctx-radio', () => {
    if (!ctxTarget) return
    const track = ctxTarget.type === 'track' ? ctxTarget.track : null
    const album = state.library.find(a => a.id === ctxTarget.albumId)
    const artist = ctxTarget.artist || album?.artist || track?.albumArtist
    const genre = album?.genre || (track ? state.library.find(a => a.id === track.albumId)?.genre : null)
    const seedFilePath = (track && track.filePath) || (album && album.tracks && album.tracks[0] && album.tracks[0].filePath)
    if (seedFilePath) startSmartQueue('radio', seedFilePath)
    else startRadio(track, artist, genre)
    hideContextMenu()
  })

  // Playback speed
  document.getElementById('btn-speed')?.addEventListener('click', cycleSpeed)

  // Radio button on the now-playing bar — starts a smart-queue radio seeded
  // from whatever is currently playing.
  document.getElementById('btn-np-radio')?.addEventListener('click', () => {
    const track = state.queue[state.queueIndex]
    if (!track || !track.filePath) { showSnackbar('Nothing is playing to start radio from'); return }
    startSmartQueue('radio', track.filePath)
  })

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

  // Sidebar right-click → toggle compact mode.
  // The toggle used to set sidebar.style.width while the resizer set the
  // --sidebar-w custom property, so the two fought: compacting then dragging
  // left an inline width the drag could not override. Both now write the one
  // property, and papa_compact_sidebar -- written on every toggle and read by
  // nothing -- is restored at startup.
  document.querySelector('.sidebar')?.addEventListener('contextmenu', function(e) {
    e.preventDefault()
    setSidebarCompact(!_sidebarCompact)
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
      }).catch(function (e) {
        console.error('[papa] clipboard write failed:', String(e && e.message || e))
        showSnackbar('Could not copy the path')
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
    sampleHistoryPosition(ct)

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
    // A track that reaches 'ended' was played to the end. Sampled and flushed
    // here because playNext() may find nothing to play, in which case
    // recordPlayAfterThreshold -- the usual flush point -- never runs.
    if (audio.duration) sampleHistoryPosition(audio.duration)
    flushPlayHistoryPosition()
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
    // mpv already switched tracks gaplessly — sync UI state without reloading.
    // The bare `return` here left queueIndex pointing at a track that was not
    // playing, so scrobbling, savePlaybackState, now-playing and playNext's
    // arithmetic all acted on the wrong entry — and prefetch was never re-armed.
    const idx = state.queue.findIndex(t => t.filePath === e.detail)
    if (idx === -1) {
      console.error('[papa] mpv advanced to a file that is not in the queue:', e.detail)
      // mpv is the authority on what is playing. Nothing here can fix the index,
      // but prefetch must still be re-armed or the album stops at the next
      // boundary — which is the whole failure this handler exists to prevent.
      updateNowPlayingFromPath(e.detail)
      updateNextPrefetch()
      return
    }
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
    // Counts were incremented here and history was not written at all, so a
    // 12-track album listened gaplessly recorded twelve counts and one history
    // entry — and every statistic drawn from history under-reported album
    // listening specifically. Same 30 s threshold as the explicit-start path, so
    // counts and history now agree by construction.
    recordPlayAfterThreshold(track)
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

  // ── Reconciling the UI against mpv ────────────────────────────────────────
  // Three copies of playback state exist: mpv's observed properties, the shim's
  // fields (now derived from them), and state.isPlaying here. This makes the
  // last one converge on the first once a second, cheaply — a string compare and
  // a boolean — rather than trusting whatever the last optimistic write left.
  const RECONCILE_MS = 1000
  // A bar that has not moved for this long while unpaused is frozen, not paused.
  const STALE_POSITION_MS = 3000
  let _reconcileWarnedPath = null
  let _barStale = false

  const reconcileTimer = setInterval(() => {
    if (audio.engineDown) return          // already saying so, loudly
    // 185, in practice: mpv's pause property is the authority, and the shim's
    // `paused` is now a view of it with a short-lived optimistic overlay.
    const playing = !audio.paused
    if (state.isPlaying !== playing) {
      state.isPlaying = playing
      updatePlayBtn()
      if (state.modalOpen) syncModalPlayBtn()
    }

    // 127: a frozen progress bar looked exactly like a paused track.
    const stale = playing && audio.positionAgeMs > STALE_POSITION_MS
    if (stale !== _barStale) {
      _barStale = stale
      document.getElementById('progress-track')?.classList.toggle('stale', stale)
      document.getElementById('np-modal-track')?.classList.toggle('stale', stale)
      if (stale) console.error(`[papa] the progress bar has not moved for ${Math.round(audio.positionAgeMs)}ms while unpaused`)
    }

    // 128: what the UI is showing versus what mpv actually has open.
    const shown = state.queue[state.queueIndex]
    const real = audio.mpvPath
    if (!real || !shown || !shown.filePath) return
    if (real === shown.filePath) { _reconcileWarnedPath = null; return }
    // Streams are resolved to a direct URL before mpv sees them, so the paths
    // legitimately differ and comparing them would cry wolf every track.
    if (/^https?:\/\//.test(shown.filePath) || /^https?:\/\//.test(real)) return
    if (_reconcileWarnedPath === real) return
    _reconcileWarnedPath = real
    const idx = state.queue.findIndex(t => t.filePath === real)
    console.error('[papa] the UI and mpv disagree about what is playing:',
      JSON.stringify({ shown: shown.filePath, mpv: real, foundInQueueAt: idx }))
    if (idx >= 0) {
      // mpv is the authority. Resync rather than leave scrobbling, now-playing
      // and playNext's arithmetic all acting on the wrong track.
      state.queueIndex = idx
      updateNowPlaying(state.queue[idx])
      updateTrackHighlight()
      if (state.queuePanelOpen) renderQueuePanel()
      if (state.modalOpen) updateNowPlayingModal()
      updateNextPrefetch()
    } else {
      updateNowPlayingFromPath(real)
    }
  }, RECONCILE_MS)
  reconcileTimer.unref?.()

  // ── Playback engine lifecycle ─────────────────────────────────────────────
  // mpv dying used to be invisible here. main forwarded engineDown, the shim
  // had no case for it, and nothing in the renderer listened — so through the
  // whole respawn the button still said "playing" and the bar still moved.
  audio.addEventListener('enginedown', e => {
    const d = e.detail || {}
    state.isPlaying = false
    updatePlayBtn()
    if (state.modalOpen) syncModalPlayBtn()
    setEngineState(d.willRecover ? 'Reconnecting…' : 'Playback engine stopped', !!d.willRecover)
    console.error('[papa] engine down:', JSON.stringify(d))
  })

  audio.addEventListener('enginerecovered', e => {
    const d = e.detail || {}
    setEngineState('', false)
    state.isPlaying = !!d.wasPlaying
    updatePlayBtn()
    if (state.modalOpen) syncModalPlayBtn()
    // The decided behaviour: resume at the same position, then say so once,
    // briefly, dismissibly. Never a blocking prompt, never silent.
    showSnackbar(
      d.rebuilt
        ? (d.resumed
          ? `Audio settings applied — resumed at ${fmtDur(d.position || 0)}`
          : 'Audio settings applied')
        : (d.resumed
          ? `Playback engine restarted — resumed at ${fmtDur(d.position || 0)}`
          : 'Playback engine restarted'),
      '', function () {}, 4000)
    // The respawn cleared mpv's playlist, and gapless prefetch lives in the
    // renderer's queue — without this the album plays this track and stops.
    updateNextPrefetch()
  })

  // mpv ended the file for a reason that is neither eof nor error. Nothing else
  // is coming: no ended, no autoadvanced, no error. This is the shape of the
  // mid-album stop, and it is no longer silent.
  audio.addEventListener('enginestopped', e => {
    const d = e.detail || {}
    state.isPlaying = false
    updatePlayBtn()
    if (state.modalOpen) syncModalPlayBtn()
    const reason = d.reason || 'unknown'
    setEngineState(`Stopped (${reason})`, false)
    console.error('[papa] playback stopped without eof or error:', JSON.stringify(d))
    showSnackbar(`Playback stopped at ${fmtDur(d.position || 0)} — mpv reported “${reason}”`,
      'Resume', function () { resumeAfterStop(d) }, 8000)
  })

  audio.addEventListener('enginefailed', e => {
    const d = e.detail || {}
    state.isPlaying = false
    updatePlayBtn()
    if (state.modalOpen) syncModalPlayBtn()
    setEngineState('Playback engine failed', false)
    console.error('[papa] engine failed:', JSON.stringify(d))
  })

  // A settings change is about to rebuild the engine mid-track. The audio stops
  // either way; the point is that it stops for a stated reason.
  audio.addEventListener('enginerebuilding', e => {
    const d = e.detail || {}
    const why = (d.because || []).join(', ')
    console.log('[papa] engine rebuilding because of', why || 'a settings change')
    state.isPlaying = false
    updatePlayBtn()
    if (state.modalOpen) syncModalPlayBtn()
    setEngineState('Applying audio settings…', true)
  })

  // main rebuilt the engine on its own after a failure, without the user having
  // to press the recheck button. Say so and take the blocker down.
  audio.addEventListener('enginerestored', e => {
    const d = e.detail || {}
    console.log('[papa] engine restored after', d.after)
    hideEngineBlocker()
    setEngineState('', false)
    state.isPlaying = false
    updatePlayBtn()
    showSnackbar('Playback engine restarted — press play to carry on', '', function () {}, 5000)
  })

  // Position stopped advancing while mpv says it is not paused. mpv was asked
  // what it thought before this was sent, so it is a finding, not a guess.
  audio.addEventListener('enginestalled', e => {
    const d = e.detail || {}
    console.error('[papa] playback stalled:', JSON.stringify(d))
    setEngineState('Stalled', true)
    showSnackbar(`Playback stalled at ${fmtDur(d.position || 0)}`, 'Restart track',
      function () { setEngineState('', false); playCurrentTrack() }, 8000)
  })

  // The output device itself, as opposed to any other mpv complaint. Worth
  // saying plainly: the fix is almost never in this app.
  audio.addEventListener('audiodevicelost', e => {
    const d = e.detail || {}
    console.error('[papa] audio device lost:', d.text || '')
    showSnackbar('The audio device went away — mpv is trying to reopen it', '', function () {}, 6000)
  })

  audio.addEventListener('audiodevicefallback', e => {
    const d = e.detail || {}
    console.error('[papa] falling back to the default audio device, away from', d.from)
    showSnackbar(`Could not use ${d.from || 'the chosen device'} — switched to the default output`,
      '', function () {}, 8000)
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

    // A local file that will not load is USUALLY one that was deleted or moved —
    // but not always, and the old code spliced it out of the queue on a single
    // load error with no check. A transient demuxer or cache error on a large
    // FLAC permanently removed a track that was still on disk. Ask the
    // filesystem first; retry once; only then treat it as gone.
    const failed = (e && e.detail && e.detail.src) || t.filePath
    handleLoadError(failed, t)
  })

  // main has always sent this when the previous session ended without a clean
  // shutdown, and until now the channel was not even in preload's allowlist, so
  // it went nowhere. A crash and a deliberate pause looked identical on restart.
  window.api.on('app-recovered-from-crash', async () => {
    console.error('[papa] the previous session did not shut down cleanly')
    let saved = null
    try { saved = await window.api.getPlaybackState() } catch (_) {}
    if (!saved || !saved.filePath) {
      showSnackbar('Papa Audio did not shut down cleanly last time', '', function () {}, 6000)
      return
    }
    const name = (saved.filePath || '').split('/').pop() || 'the last track'
    // A notice with an action, never a blocking prompt: the same rule as the
    // engine-recovery notice.
    showSnackbar(`Last time ended mid-track — ${name} at ${fmtDur(saved.position || 0)}`,
      'Resume', function () { resumeFromSavedState(saved) }, 12000)
  })

  // Library changed in main (a mutation, or the folder watcher). Until now this
  // event had no listener at all, so the UI silently kept showing stale data.
  window.api.on('library-updated', (payload) => {
    applyLibraryUpdate(payload)
  })

  // Smart-queue background analysis. Read the current status once up front
  // (the pass may already be running or finished from a previous session),
  // then keep the running total live off the progress channel.
  window.api.queueAnalysisStatus().then(function (s) {
    if (s) _queueAnalysis = { analysed: s.analysed || 0, total: s.total || 0, running: !!s.running }
    if (state.currentPage === 'manage') renderManage()
  }).catch(function () {})
  window.api.on('queue-analysis-progress', (d) => {
    if (!d) return
    _queueAnalysis.running = !d.finished
    _queueAnalysis.halted = !!d.halted
    if (typeof d.total === 'number') _queueAnalysis.total = d.total
    if (typeof d.done === 'number') _queueAnalysis.analysed = d.done
    var label = document.querySelector('.q-analysis-progress-label')
    if (label) label.textContent = _mgAnalysisLabel()
    if (d.finished) {
      var btn = document.getElementById('q-analysis-start-btn')
      if (btn) btn.remove()
    }
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

  // Electron-initiated downloads: a link clicked in the Google sign-in window,
  // or a .torrent. main has always emitted these five events and offered a
  // cancel channel; nothing listened, so a file appeared on disk with no
  // indication it had arrived and no way to stop it.
  var _elDownloads = new Map()
  window.api.on('dl-started', function (d) {
    if (!d || !d.id) return
    _elDownloads.set(d.id, d)
    // Bounded: a runaway page could fire these faster than they complete.
    if (_elDownloads.size > 50) {
      var oldest = _elDownloads.keys().next().value
      _elDownloads.delete(oldest)
    }
    showSnackbar('Downloading ' + (d.filename || 'file'), 'Cancel', function () {
      window.api.cancelDownload(d.id)
    }, 8000)
  })
  window.api.on('dl-complete', function (d) {
    if (!d) return
    _elDownloads.delete(d.id)
    showSnackbar('Downloaded ' + (d.filename || 'file'), null, null, 4000)
    // A music file or an extracted archive means the library changed.
    if (d.isMusic) _scheduleLibRescan()
  })
  window.api.on('dl-cancelled', function (d) {
    if (!d) return
    _elDownloads.delete(d.id)
    showSnackbar('Download cancelled' + (d.filename ? ': ' + d.filename : ''), null, null, 3000)
  })
  window.api.on('dl-failed', function (d) {
    if (!d) return
    _elDownloads.delete(d.id)
    // Said out loud rather than swallowed: this is the case that used to leave
    // the user with no file and no explanation.
    showSnackbar('Download failed' + (d.filename ? ': ' + d.filename : ''), null, null, 6000)
  })
  // dl-progress fires several times a second per item. It updates the record so
  // anything that asks can see it, and deliberately raises no UI of its own.
  window.api.on('dl-progress', function (d) {
    if (!d || !d.id) return
    var prev = _elDownloads.get(d.id)
    if (prev) _elDownloads.set(d.id, Object.assign({}, prev, d))
  })

  window.api.on('yt-dl-progress', dl => {
    const prev = state.ytDownloads.get(dl.id)
    state.ytDownloads.set(dl.id, dl)
    // The button that started this download learns how it ended.
    if (dl.state === 'completed' && prev?.state !== 'completed') _ytBtnDone(dl.id, true)
    if (dl.state === 'failed' && prev?.state !== 'failed') _ytBtnDone(dl.id, false, dl.error)
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
    // main sends six commands and this understood three. A desktop applet's
    // dedicated Play, Pause and Stop buttons were all inert -- only the
    // combined toggle worked -- and a headset's play button usually maps to
    // Play, not PlayPause.
    if (key === 'play-pause') togglePlay()
    else if (key === 'next')  playNext()
    else if (key === 'prev')  playPrev()
    else if (key === 'play')  { if (!state.isPlaying) togglePlay() }
    else if (key === 'pause') { if (state.isPlaying) togglePlay() }
    else if (key === 'stop')  mediaStop()
    else console.warn('[papa] unhandled media key:', key)
  })

  // ── Tray menu, MPRIS and the power monitor ────────────────────────────────
  // Every one of these was sent by main and had no listener anywhere — several
  // were not even in preload's allowlist, so nothing could have listened. The
  // tray's Play/Pause/Next/Previous did nothing at all.
  window.api.on('media-playpause', () => togglePlay())
  window.api.on('media-next',      () => playNext())
  window.api.on('media-previous',  () => playPrev())

  // MPRIS sends an absolute position or a relative offset, in seconds.
  window.api.on('media-seek', d => {
    if (!d) return
    if (typeof d.position === 'number') audio.currentTime = Math.max(0, d.position)
    else if (typeof d.offset === 'number') audio.currentTime = Math.max(0, (audio.currentTime || 0) + d.offset)
  })

  window.api.on('media-volume', v => {
    const vol = Math.max(0, Math.min(1, Number(v)))
    if (!Number.isFinite(vol)) return
    audio.volume = vol
    if (vol > 0) state.lastVolume = vol
    setVolDisplay(vol)
  })

  window.api.on('media-shuffle', enabled => {
    state.shuffle = !!enabled
    document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
    document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
    updateNextPrefetch()
  })

  // MPRIS names these None / Track / Playlist.
  window.api.on('media-loop-status', status => {
    const map = { None: 'off', Track: 'one', Playlist: 'all' }
    const next = map[status]
    if (!next) return
    state.repeat = next
    updateRepeatBtns()
    updateNextPrefetch()
  })

  // main pauses mpv before the machine suspends. Without this the UI came back
  // still claiming to be playing.
  window.api.on('system-suspend', () => {
    console.log('[papa] system suspending')
    state.isPlaying = false
    updatePlayBtn()
    if (state.modalOpen) syncModalPlayBtn()
  })

  // The audio device is the thing most likely to have changed underneath us, so
  // ask the engine what is actually true rather than assuming anything.
  window.api.on('system-resume', async () => {
    console.log('[papa] system resumed; reconciling with the engine')
    try {
      const st = await window.api.playerGetStatus()
      if (!st || !st.available) {
        setEngineState('Playback engine unavailable', false)
        return
      }
      if (st.state) {
        state.isPlaying = !st.state.paused
        updatePlayBtn()
        if (state.modalOpen) syncModalPlayBtn()
      }
    } catch (e) {
      console.error('[papa] could not reconcile after resume:', String(e && e.message || e))
    }
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
      // Was a native confirm(), which is the worst possible place for one: this
      // arrives from the browser extension, so a blocking dialog appeared in an
      // app the user was not looking at and froze it until they found it. The
      // action is undoable instead.
      var savedQueue = state.queue.slice(), savedIdx = state.queueIndex
      audio.pause()
      state.queue = []; state.queueIndex = -1; state.isPlaying = false
      state._restoredFromQueue = false
      updateNextPrefetch()
      updatePlayBtn(); updateNowPlaying(null)
      if (state.queuePanelOpen) renderQueuePanel()
      syncExtension()
      pushUndo('Queue cleared (' + savedQueue.length + ' tracks)', function() {
        state.queue = savedQueue; state.queueIndex = savedIdx
        updateNextPrefetch()
        if (state.queuePanelOpen) renderQueuePanel()
        syncExtension()
      })
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

    // Every test below asks matchesShortcut, so rebinding in the dialog works.
    if (matchesShortcut('undo', e) && !inInput) {
      e.preventDefault()
      undoLastAction()
      return
    }

    if (matchesShortcut('focusSearch', e)) {
      e.preventDefault()
      document.getElementById('tb-search')?.focus()
      return
    }
    if (matchesShortcut('commandPalette', e)) {
      e.preventDefault(); toggleCommandPalette(); return
    }
    if (matchesShortcut('likeTrack', e)) {
      e.preventDefault()
      var currentTrack = state.queue[state.queueIndex]
      if (currentTrack && currentTrack.filePath) toggleTrackLike(currentTrack.filePath)
      return
    }
    if (matchesShortcut('sleepTimer', e)) {
      e.preventDefault()
      setSleepTimer(30)
      showSnackbar('Sleep timer: 30 min')
      return
    }
    if (matchesShortcut('skipShort', e)) {
      e.preventDefault()
      state.skipShortTracks = !state.skipShortTracks
      showSnackbar('Auto-skip short tracks: ' + (state.skipShortTracks ? 'on' : 'off'))
      return
    }
    if (matchesShortcut('skipInterludes', e)) {
      e.preventDefault()
      state.skipInterludes = !state.skipInterludes
      showSnackbar('Skip interludes: ' + (state.skipInterludes ? 'on' : 'off'))
      return
    }
    if (matchesShortcut('saveQueue', e)) {
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

    // Play/pause (works in the search input when it is empty)
    if (matchesShortcut('playPause', e)) {
      if (inInput && e.target.id === 'tb-search' && e.target.value.trim() === '') {
        e.preventDefault(); togglePlay(); return
      }
      if (!inInput) { e.preventDefault(); togglePlay(); return }
    }

    if (inInput) return

    // App navigation
    if (e.key === 'ArrowLeft' && e.altKey)  { e.preventDefault(); navigateBack();    return }
    if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); navigateForward(); return }

    // Next and previous had no keyboard binding at all, despite the table
    // claiming one, so they are checked before the seek pair they share arrows
    // with.
    if (matchesShortcut('nextTrack', e)) { e.preventDefault(); playNext(); return }
    if (matchesShortcut('prevTrack', e)) { e.preventDefault(); playPrev(); return }

    // Seek ±10s
    if (matchesShortcut('seekForward', e)) {
      e.preventDefault()
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10)
      return
    }
    if (matchesShortcut('seekBackward', e)) {
      e.preventDefault()
      audio.currentTime = Math.max(0, audio.currentTime - 10)
      return
    }

    // Volume
    if (matchesShortcut('volumeUp', e)) {
      audio.volume = Math.min(1, audio.volume + 0.05)
      state.lastVolume = audio.volume
      setVolDisplay(audio.volume)
      window.api.saveVolume(audio.volume)
      return
    }
    if (matchesShortcut('volumeDown', e)) {
      audio.volume = Math.max(0, audio.volume - 0.05)
      state.lastVolume = audio.volume
      setVolDisplay(audio.volume)
      window.api.saveVolume(audio.volume)
      return
    }
    if (matchesShortcut('toggleMute', e)) {
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
    if (matchesShortcut('fullscreen', e)) {
      if (state.queue.length && state.queueIndex >= 0) { showNowPlayingModal(); return }
    }
    // addToQueue is checked before toggleQueue: their defaults differ only by
    // the modifier, and the bare one used to swallow the pair.
    if (matchesShortcut('addToQueue', e)) {
      e.preventDefault()
      var t = state.queue[state.queueIndex]
      if (t) { state.queue.push(t); showSnackbar('Added to queue again') }
      return
    }
    if (matchesShortcut('toggleQueue', e)) { toggleQueuePanel(); return }
    // Shuffle
    if (matchesShortcut('toggleShuffle', e)) {
      state.shuffle = !state.shuffle
      document.getElementById('btn-shuffle')?.classList.toggle('active', state.shuffle)
      document.getElementById('np-modal-shuffle')?.classList.toggle('active', state.shuffle)
      updateNextPrefetch()
      showSnackbar(state.shuffle ? 'Shuffle on' : 'Shuffle off', '', function(){}, 1500)
      return
    }
    // Repeat
    if (matchesShortcut('cycleRepeat', e)) {
      document.getElementById('btn-repeat')?.click()
      return
    }
    // Playback speed cycle
    if (matchesShortcut('cycleSpeed', e)) { cycleSpeed(); return }
    // Lyrics drawer toggle
    if (matchesShortcut('toggleLyrics', e)) { if (state.queue.length) { toggleLyricsDrawer(); return } }
    // Declared in the table and bound to nothing until now.
    if (matchesShortcut('stopAfter', e)) {
      e.preventDefault()
      state.stopAfterTrack = !state.stopAfterTrack
      document.getElementById('btn-stop-after')?.classList.toggle('active', state.stopAfterTrack)
      showSnackbar(state.stopAfterTrack ? 'Stopping after this track' : 'Stop-after cancelled', '', function () {}, 2000)
      return
    }
    // Ctrl+Shift+, → shortcuts config. Deliberately not rebindable: it is the
    // way back if a binding is set to something unreachable.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === ',') {
      e.preventDefault(); toggleShortcutsConfig(); return
    }
    // Keyboard shortcuts modal
    if (matchesShortcut('shortcuts', e) || e.key === '?') { e.preventDefault(); toggleShortcutsModal(); return }
  })

  // Dropping a file in is not a connection check; it is bound once here.
  _bindFileDrop()

  // ── Connection status bar ─────────────────────────────────────────────────
  var sidebar = document.getElementById('sidebar')
  if (sidebar && !document.getElementById('conn-status')) {
    var bar = document.createElement('div')
    bar.id = 'conn-status'
    bar.style.cssText = 'padding:8px 16px;font-size:11px;display:flex;gap:12px;border-top:1px solid var(--glass-border);margin-top:auto;color:var(--text2)'
    bar.innerHTML = '<span id="conn-slskd" style="display:flex;align-items:center;gap:4px"><span class="conn-dot"></span> Soulseek</span><span id="conn-yt" style="display:flex;align-items:center;gap:4px"><span class="conn-dot"></span> YouTube</span>'
    sidebar.appendChild(bar)
    // Guarded by the !getElementById above, so it cannot double up today — but
    // an interval with no handle can never be stopped, which is the reason for
    // storing it rather than a bug being fixed.
    clearInterval(_connCheckTimer)
    _connCheckTimer = setInterval(checkConnections, 30000)
    checkConnections()
  }

  // ── Sidebar resize ────────────────────────────────────────────────────────
  const sidebarResizer = document.getElementById('sidebar-resizer')
  if (sidebarResizer) {
    let _resizerId = null
    let _resizerStartX = 0
    let _resizerStartW = 0
    sidebarResizer.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      e.preventDefault()
      _resizerId = e.pointerId
      _resizerStartX = e.clientX
      _resizerStartW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || SIDEBAR_DEFAULT_W
      sidebarResizer.classList.add('resizing')
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'
      // Capture, so the two document-level listeners this used to leave running
      // for the life of the page are gone.
      try { sidebarResizer.setPointerCapture(e.pointerId) } catch (_) {}
    })
    sidebarResizer.addEventListener('pointermove', e => {
      if (_resizerId !== e.pointerId) return
      const delta = e.clientX - _resizerStartX
      const newW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, _resizerStartW + delta))
      // Dragging is an explicit choice of width, so it leaves compact mode
      // rather than being silently overridden by it.
      _sidebarCompact = false
      _sidebarWidth = newW
      document.documentElement.style.setProperty('--sidebar-w', newW + 'px')
    })
    const _resizerEnd = e => {
      if (_resizerId !== e.pointerId) return
      _resizerId = null
      try { sidebarResizer.releasePointerCapture(e.pointerId) } catch (_) {}
      sidebarResizer.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // The dragged width was not persisted at all, so it reset every launch.
      _saveSidebarPrefs()
    }
    sidebarResizer.addEventListener('pointerup', _resizerEnd)
    sidebarResizer.addEventListener('pointercancel', _resizerEnd)
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

// ── Drag a file in to play it ───────────────────────────────────────────────
// These two lived at the end of checkConnections(), which runs every thirty
// seconds on an interval. So the app added one dragover and one drop listener
// to document twice a minute for as long as it was open — and every drop event
// runs all of them, so dropping a file after an hour of uptime enqueued it
// about a hundred and twenty times.
//
// Found by the soak harness once its listener probe was made to name the call
// site of each surviving global listener: "7 x checkConnections :: dragover"
// after five minutes. Nothing about this belongs to a connection check.
var _dropBound = false

function _bindFileDrop() {
  if (_dropBound) return
  _dropBound = true
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
    clearInterval(_waveformTimer)
    _waveformTimer = setInterval(drawWaveform, 1000)
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

// The rows used to be built from DEFAULT_SHORTCUTS -- not the user's bindings --
// and were plain <kbd> text with no input, no click handler and no key capture.
// The only working control was "Reset to Defaults", which reset a value nothing
// read.
var _shortcutCapture = null   // { action, btn } while waiting for a keypress

function shortcutConflict(action, combo) {
  var norm = normalizeShortcut(combo)
  var hit = null
  Object.keys(DEFAULT_SHORTCUTS).forEach(function (other) {
    if (other === action) return
    if (normalizeShortcut(getShortcut(other)) === norm) hit = other
  })
  return hit
}

function renderShortcutsConfig() {
  var grid = document.getElementById('shortcuts-config-grid')
  if (!grid) return
  var actions = Object.keys(DEFAULT_SHORTCUTS)
  grid.innerHTML = '<div class="shortcuts-col">' + actions.map(function (action) {
    var combo = getShortcut(action)
    var changed = normalizeShortcut(combo) !== normalizeShortcut(DEFAULT_SHORTCUTS[action])
    return '<div class="shortcut-row">' +
      '<button class="shortcut-key-btn" data-sc-action="' + esc(action) + '" title="Click, then press the keys you want">' +
        '<kbd>' + esc(combo) + '</kbd>' +
      '</button>' +
      '<span>' + esc(SHORTCUT_LABELS[action] || action) + (changed ? ' <em style="opacity:.6;font-style:normal">(changed)</em>' : '') + '</span>' +
      '</div>'
  }).join('') + '</div>' +
    '<p style="font-size:11px;color:var(--text3);margin-top:12px">' +
    'Click a key, then press the combination you want. Escape cancels.</p>'

  grid.querySelectorAll('[data-sc-action]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (_shortcutCapture) _shortcutCapture.btn.classList.remove('capturing')
      _shortcutCapture = { action: btn.dataset.scAction, btn: btn }
      btn.classList.add('capturing')
      btn.innerHTML = '<kbd>Press keys…</kbd>'
    })
  })
}

// Capture runs on the modal, in the capture phase, so a rebind cannot also fire
// the shortcut it is being bound to.
function _onShortcutCaptureKey(e) {
  if (!_shortcutCapture) return
  e.preventDefault()
  e.stopPropagation()
  var action = _shortcutCapture.action
  _shortcutCapture.btn.classList.remove('capturing')
  _shortcutCapture = null
  if (e.key === 'Escape') { renderShortcutsConfig(); return }
  var combo = comboFromEvent(e)
  // A modifier alone is not a binding; keep waiting rather than storing ''.
  if (!combo) { renderShortcutsConfig(); return }
  var clash = shortcutConflict(action, combo)
  if (clash) {
    showSnackbar('That is already ' + (SHORTCUT_LABELS[clash] || clash), null, null, 4000)
    renderShortcutsConfig()
    return
  }
  _shortcuts[action] = combo
  saveShortcuts()
  renderShortcutsConfig()
  showSnackbar((SHORTCUT_LABELS[action] || action) + ' is now ' + combo, null, null, 3000)
}

function toggleShortcutsConfig() {
  // A capture left armed by closing the dialog mid-rebind would swallow the
  // next keypress the next time it opened.
  _shortcutCapture = null
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
  // Capture phase, on the modal: the keypress being recorded must not also run
  // as a shortcut on its way to the document handler.
  m.addEventListener('keydown', _onShortcutCaptureKey, true)
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
const _extSyncTimer = setInterval(() => { if (state.isPlaying) syncExtension() }, 1000)

// ── Recent notices ───────────────────────────────────────────────────────────
// Snackbars were the only failure channel and they expire, so anything that went
// wrong while you were away was gone before you saw it. Every snackbar is kept
// here, bounded, and the player bar shows a count when there is something to
// read. Deliberately small: this is a record of what you missed, not an
// inbox — the design of a fuller notification centre is not mine to choose.
const NOTICE_HISTORY_CAP = 30
const _noticeHistory = []
let _noticesSeen = 0

function recordNotice(msg) {
  const text = String(msg == null ? '' : msg)
  if (!text) return
  _noticeHistory.unshift({ text, at: Date.now() })
  if (_noticeHistory.length > NOTICE_HISTORY_CAP) _noticeHistory.pop()
  updateNoticeBadge()
}

function updateNoticeBadge() {
  const el = document.getElementById('notice-badge')
  if (!el) return
  const unread = Math.max(0, _noticeHistory.length - _noticesSeen)
  el.textContent = unread ? String(unread) : ''
  el.style.display = unread ? '' : 'none'
  el.title = unread === 1 ? '1 recent notice' : `${unread} recent notices`
}

function showNoticeHistory() {
  _noticesSeen = _noticeHistory.length
  updateNoticeBadge()
  const existing = document.getElementById('notice-history-modal')
  if (existing) { existing.remove(); return }
  const dlg = document.createElement('div')
  dlg.id = 'notice-history-modal'
  dlg.className = 'modal-overlay'
  const rows = _noticeHistory.length
    ? _noticeHistory.map(n => '<div class="notice-row"><span class="notice-when">' +
        esc(new Date(n.at).toLocaleTimeString()) + '</span><span class="notice-text">' +
        esc(n.text) + '</span></div>').join('')
    : '<div class="mg-empty" style="padding:24px">Nothing has gone wrong yet.</div>'
  dlg.innerHTML = '<div class="modal-box">' +
    '<div class="modal-header-row"><div class="modal-title">Recent notices</div>' +
    '<button class="modal-close-btn" id="notice-close">✕</button></div>' +
    '<div class="notice-list">' + rows + '</div></div>'
  document.body.appendChild(dlg)
  const close = () => { document.removeEventListener('keydown', onKey); dlg.remove() }
  function onKey(e) { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  dlg.addEventListener('click', e => { if (e.target === dlg) close() })
  dlg.querySelector('#notice-close')?.addEventListener('click', close)
}

// ── Snackbar ─────────────────────────────────────────────────────────────────
function showSnackbar(msg, actionLabel, actionCallback, duration) {
  recordNotice(msg)
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
var _queueAnalysis = { analysed: 0, total: 0, running: false, halted: false }

function _mgAnalysisLabel() {
  var a = _queueAnalysis
  var pct = a.total > 0 ? Math.min(100, Math.round((a.analysed / a.total) * 100)) : 0
  if (a.total === 0) return 'Smart queues: still analysing your library'
  if (a.analysed >= a.total) return 'Smart queues: analysis complete (' + a.total + ' tracks)'
  // A halted run is not done and not an error — it is waiting its turn behind
  // playback, which always wins. Say so honestly rather than looking stalled
  // or, worse, looking finished.
  if (a.halted) return 'Smart queues: paused while you’re listening — will continue automatically (' + a.analysed + ' of ' + a.total + ' tracks)'
  return 'Smart queues: analysing your library — ' + a.analysed + ' of ' + a.total + ' tracks (' + pct + '%)'
}

function _mgAnalysisProgressHtml() {
  var a = _queueAnalysis
  var btn = (!a.running && !a.halted && a.analysed < a.total)
    ? '<button class="mg-btn mg-btn-sm" id="q-analysis-start-btn">' + (a.analysed > 0 ? 'Resume analysis' : 'Start analysis') + '</button>'
    : ''
  return '<div class="q-analysis-progress"><span class="q-analysis-progress-label">' + esc(_mgAnalysisLabel()) + '</span>' + btn + '</div>'
}

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
  document.getElementById('q-analysis-start-btn')?.addEventListener('click', function () {
    _queueAnalysis.running = true
    var label = document.querySelector('.q-analysis-progress-label')
    if (label) label.textContent = 'Smart queues: starting analysis…'
    document.getElementById('q-analysis-start-btn')?.remove()
    window.api.queueAnalysisStart().catch(function () {})
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
    _mgAnalysisProgressHtml() +
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
  var _tabAtStart = _mgState.tab
  setContent(_mgShell('<div class="mg-empty">Measuring…</div>'))
  _mgBindTabs()
  var rep = await window.api.libraryStorageReport().catch(function () { return null })
  // Measuring walks every music root and every trash root, so it takes seconds.
  // Without this the late result repainted over whatever you had switched to —
  // the same bug renderManageHealth already fixed and documented.
  if (_mgState.tab !== _tabAtStart || state.currentPage !== 'manage') return
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
  var _tabAtStart = _mgState.tab
  setContent('<div class="page mg-page"><div class="mg-head"><h2 class="mg-title">Manage Library</h2></div>' +
    _mgTabsHtml() + '<div class="mg-empty">Reading Trash…</div></div>')
  _mgBindTabs()

  var data = await window.api.libraryTrashList().catch(function () { return null })
  // Same guard, same reason: reading the trash sizes every payload folder.
  if (_mgState.tab !== _tabAtStart || state.currentPage !== 'manage') return
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
// The live dialog's own close function. Removing the previous dialog's DOM
// directly — which is what this used to do — left its document keydown listener
// registered forever, holding that dialog's closure. Nine call sites in Manage,
// so the leak compounded with ordinary use.
var _mgConfirmClose = null

function _mgConfirm(title, bodyHtml, confirmLabel, onConfirm) {
  if (_mgConfirmClose) { try { _mgConfirmClose() } catch (_) {} }
  // Belt and braces: if a dialog ever gets into the DOM without registering its
  // close (a throw between the two), the element still goes.
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
  function close() {
    if (_mgConfirmClose === close) _mgConfirmClose = null
    dlg.remove()
    document.removeEventListener('keydown', onKey)
    flushPendingLibraryUpdate()
  }
  function onKey(e) { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  _mgConfirmClose = close
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

// Two native alert()s used to dump this list, blocking the renderer while the
// user read it -- and a long list in an alert is unreadable and uncopyable.
function _showSurroundOffenders(title, offenders) {
  var rows = (offenders || []).map(function (o) {
    return '<li><strong>' + esc(o.name) + '</strong> — ' + esc(String(o.channels)) +
      ' channel' + (o.channels === 1 ? '' : 's') + '</li>'
  }).join('')
  _mgConfirm(title,
    '<ul class="mg-offender-list">' + (rows || '<li>No detail was returned.</li>') + '</ul>',
    'Close', function () {})
}

// The non-blocking prompt. A native prompt() stops the renderer's event loop
// dead: the progress bar freezes, the 1 s reconcile tick stops, the extension
// sync stops, the downloads poll stops and player events queue up. Walk away
// with one open and the UI is frozen until it is answered.
//
// Same shell as _mgConfirm, so Escape, the backdrop and the X all cancel, and
// Enter in the field submits.
function _mgPrompt(title, opts) {
  opts = opts || {}
  var label = opts.label || ''
  var initial = opts.value == null ? '' : String(opts.value)
  var confirmLabel = opts.confirmLabel || 'Save'
  var multiline = !!opts.multiline
  var onConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : function () {}

  if (_mgConfirmClose) { try { _mgConfirmClose() } catch (_) {} }
  document.getElementById('mg-confirm-modal')?.remove()
  var dlg = document.createElement('div')
  dlg.id = 'mg-confirm-modal'
  dlg.className = 'modal-overlay'
  var field = multiline
    ? '<textarea id="mg-pr-input" class="sq-name-input" rows="5" style="resize:vertical"></textarea>'
    : '<input id="mg-pr-input" class="sq-name-input" type="text">'
  dlg.innerHTML = '<div class="modal-box mg-confirm-box">' +
    '<div class="modal-header-row">' +
      '<div class="modal-title">' + esc(title) + '</div>' +
      '<button class="modal-close-btn" id="mg-cf-x">✕</button>' +
    '</div>' +
    '<div class="mg-confirm-body">' +
      (label ? '<label class="sq-label">' + esc(label) + '</label>' : '') + field +
    '</div>' +
    '<div class="mg-confirm-actions">' +
      '<button class="mg-btn" id="mg-cf-cancel">Cancel</button>' +
      '<button class="mg-btn" id="mg-cf-ok">' + esc(confirmLabel) + '</button>' +
    '</div></div>'
  document.body.appendChild(dlg)
  // Assigned rather than interpolated: the value is user text and must never be
  // parsed as markup, and a textarea's content is not attribute-escaped.
  var input = dlg.querySelector('#mg-pr-input')
  input.value = initial

  function close() {
    if (_mgConfirmClose === close) _mgConfirmClose = null
    dlg.remove()
    document.removeEventListener('keydown', onKey)
  }
  function onKey(e) { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  _mgConfirmClose = close

  function submit() {
    var value = input.value
    close()
    // After close(), so a callback that opens another dialog is not closed by
    // this one on its way out.
    onConfirm(value)
  }
  dlg.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return
    // A multiline field needs Enter for newlines; Ctrl+Enter submits.
    if (multiline && !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    submit()
  })
  dlg.addEventListener('click', function (e) { if (e.target === dlg) close() })
  dlg.querySelector('#mg-cf-x').addEventListener('click', close)
  dlg.querySelector('#mg-cf-cancel').addEventListener('click', close)
  dlg.querySelector('#mg-cf-ok').addEventListener('click', submit)
  input.focus()
  input.select()
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
      // A silently failed Undo is the user's data not coming back, with the
      // snackbar having promised it would. Two call sites, both restoring a
      // library snapshot after a folder removal.
      var _restored = await window.api.libraryRestoreState({ snapshot: prune.snapshot })
        .then(function () { return true })
        .catch(function (e) {
          console.error('[papa] undo could not restore the library snapshot:', String(e && e.message || e))
          return false
        })
      if (!_restored) showSnackbar('The folder came back, but the library entries could not be restored', '', function () {}, 8000)
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
  return window.api.slskEnqueueDownloads({ items: list })
    .then(function (res) {
      // A refusal used to be a silent null in main, so asking again for
      // something you had cancelled looked like a button that did nothing.
      // Offer the one thing the user wants: ask again and mean it.
      var refused = (res && res.refused) || []
      if (refused.length) _slskOfferForcedEnqueue(list, refused)
      return res
    })
    .catch(function (e) {
      console.error('[papa] enqueue failed:', String(e && e.message || e))
      showSnackbar('Could not queue those downloads')
      return null
    })
}

// The scheduler refuses a file it has already been told to abandon or that ran
// out of sources. That is correct on its own initiative and wrong when the user
// is standing there asking again, so the decision is handed back to them.
function _slskOfferForcedEnqueue(list, refused) {
  var cancelled = refused.filter(function (r) { return r.reason === 'abandoned' })
  var exhausted = refused.filter(function (r) { return r.reason === 'exhausted' })
  var already = refused.filter(function (r) { return r.reason === 'succeeded' || r.reason === 'inflight' })
  if (already.length && !cancelled.length && !exhausted.length) {
    showSnackbar(already.length === 1
      ? 'That file is already downloaded or downloading'
      : already.length + ' of those are already downloaded or downloading')
    return
  }
  var again = cancelled.concat(exhausted)
  if (!again.length) return
  var names = again.map(function (r) { return String(r.filename).split(/[\\/]/).pop() })
  var label = again.length === 1
    ? '“' + names[0] + '” was cancelled earlier'
    : again.length + ' of those were cancelled or gave up earlier'
  showSnackbar(label, 'Download anyway', function () {
    var forcedPaths = {}
    again.forEach(function (r) { forcedPaths[r.filename] = true })
    var subset = list.filter(function (it) { return forcedPaths[it.filename] })
    window.api.slskEnqueueDownloads({ items: subset, force: true })
      .then(function (r) {
        showSnackbar('Queued ' + ((r && r.added) || subset.length) + ' file' +
          (((r && r.added) || subset.length) === 1 ? '' : 's'))
      })
      .catch(function (e) {
        console.error('[papa] forced enqueue failed:', String(e && e.message || e))
        showSnackbar('Could not queue those downloads')
      })
  }, 10000)
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
