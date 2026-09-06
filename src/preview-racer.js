// The Preview Racer's pure brain: two things that must be exactly right and are
// painful to test through the DOM, so they live here as plain functions —
//   1. deriving a clean "<artist> <title>" YouTube query from a swampy remote
//      filename or a parsed shelf track, and
//   2. the race state machine: given events from the two sources (Soulseek file
//      landed on disk / YouTube stream produced audio / a failure / a timeout),
//      decide who wins, who to stand down, and when to give up.
// No DOM, no IPC, no window. The renderer wires the real download/stream calls
// and the player events to this machine and does what the transitions say.

// ── Query derivation ──────────────────────────────────────────────────────────
// Remote track filenames are the same swamp slsk-shelves parses folders out of:
// "01 - Song.flac", "1-04 The Title [FLAC].mp3", "A1. Intro.wav", disc/track
// prefixes, quality tags, extensions. Strip all of that to the bare title, then
// pair it with the album's artist for a music search.

const _AUDIO_EXT_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|m4b|aac|ogg|oga|opus|ape|wv|wma|dsf|dff|mka|ac3|ec3|alac|mpc|tta|shn|dts|spx|caf|w64)$/i
// Bracketed quality/source tags: "[FLAC]", "(24-96)", "{WEB}".
const _TAG_RE = /[\[\{（(][^\]\}）)]*[\]\}）)]/g
// A leading track/disc number in the many shapes people use:
//   "01 ", "01 - ", "01. ", "1-04 ", "A1 ", "A1. ", "04_", "104 " (disc+track).
// The optional first group eats a disc index that prefixes the track, whether
// spelled "CD2/", "Disc 2 " or bare "1-" ("1-04 Title" → disc 1, track 04).
const _LEADING_TRACK_RE = /^\s*(?:(?:cd|dis[ck])\s*\d+\s*[-._ ]*|\d{1,2}-)?(?:[A-Da-d]?\d{1,3})\s*[-._)\]. ]+\s*/
// Bare quality noise words that survive tag-stripping.
const _NOISE_RE = /\b(flac|mp3|wav|aac|alac|ape|wv|24bit|16bit|96khz|192khz|44\.?1khz|48khz|vinyl|web|cd|cdrip|reissue|remaster(?:ed)?|hdtracks|qobuz|lossless|explicit|clean)\b/gi

// Pull just the basename off a remote path (slash or backslash separated).
function baseName(pathOrName) {
  const s = String(pathOrName == null ? '' : pathOrName)
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return cut < 0 ? s : s.slice(cut + 1)
}

// Reduce a remote filename to a bare, human title (no track number, no tags, no
// extension). Used both for the YT query and for the preview pill's label.
function cleanTrackTitle(filenameOrPath) {
  let s = baseName(filenameOrPath)
  s = s.replace(_AUDIO_EXT_RE, ' ')
  s = s.replace(_TAG_RE, ' ')
  s = s.replace(_LEADING_TRACK_RE, '')
  s = s.replace(_NOISE_RE, ' ')
  s = s.replace(/[_]+/g, ' ')
  s = s.replace(/\s{2,}/g, ' ')
  s = s.replace(/^[\s\-–—·.,]+|[\s\-–—·.,]+$/g, '')
  return s.trim()
}

// Build the YouTube search query for a preview: "<artist> <title>", each side
// cleaned and de-duplicated so an artist name already sitting in the filename
// isn't repeated. `track` is { filename|name, title? }; `artist` comes from the
// parsed album (may be empty). Returns a trimmed query string (possibly just the
// title when no artist is known).
function derivePreviewQuery(track, artist) {
  const t = track || {}
  const rawTitle = t.title != null && String(t.title).trim()
    ? String(t.title).trim()
    : cleanTrackTitle(t.filename || t.name || '')
  const title = rawTitle.trim()
  const art = String(artist || '').trim()
  if (!art) return title
  // If the title already leads with the artist ("Radiohead - Creep"), don't
  // prepend it again.
  const lc = title.toLowerCase()
  const alc = art.toLowerCase()
  if (lc === alc || lc.startsWith(alc + ' ') || lc.startsWith(alc + '-')) return title
  return `${art} ${title}`.trim()
}

// ── Race state machine ────────────────────────────────────────────────────────
// A pure reducer. State shape:
//   { status: 'racing'|'won'|'timedout'|'stopped',
//     winner: null|'slsk'|'yt',
//     // which losing source still needs standing down (cancel), consumed once:
//     standDown: null|'slsk'|'yt' }
//
// Events (from the renderer's async callbacks):
//   { type: 'slskReady' }  — the Soulseek file is on disk and about to play
//   { type: 'ytReady' }    — the YouTube stream produced real audio
//   { type: 'slskFailed' } — the Soulseek transfer failed/aborted
//   { type: 'ytFailed' }   — the YouTube search/stream failed
//   { type: 'timeout' }    — the overall deadline elapsed with no winner
//   { type: 'stop' }       — the user (or a new preview) cancelled this one
//
// Rules:
//   • First Ready wins. The other source becomes standDown (cancel the SLSK
//     transfer if YT won; for YT there's nothing on disk, so standing down is
//     just "don't play it" — still reported so the renderer can abort its own
//     pending resolve/search loop).
//   • Once won, further Ready/Failed events are ignored (idempotent) — the loser
//     landing a second later must not hijack playback.
//   • Both sources failing (and none won) → timedout-style give-up ('timedout'
//     with winner null); the renderer shows the friendly toast. A subsequent
//     timeout is a no-op.
//   • stop from any non-terminal state stands down BOTH sources.
function racerInit() {
  return { status: 'racing', winner: null, standDown: null, slskFailed: false, ytFailed: false }
}

function racerReduce(state, event) {
  const s = state || racerInit()
  const type = event && event.type
  // Terminal states absorb everything except an explicit stop, which is always
  // honoured so a caller can force-cancel a finished-but-still-transferring race.
  if (s.status !== 'racing') {
    if (type === 'stop' && s.status === 'won') {
      // Stopping a won preview stands down whatever the winner was, so the
      // caller can cancel a still-running SLSK transfer behind a YT win, etc.
      return { ...s, status: 'stopped', standDown: s.winner }
    }
    if (type === 'stop') return { ...s, status: 'stopped', standDown: null }
    return s
  }

  switch (type) {
    case 'slskReady':
      // SLSK won: stand down YT (don't play its stream).
      return { ...s, status: 'won', winner: 'slsk', standDown: 'yt' }
    case 'ytReady':
      // YT won: stand down SLSK (cancel the transfer).
      return { ...s, status: 'won', winner: 'yt', standDown: 'slsk' }
    case 'slskFailed': {
      const next = { ...s, slskFailed: true }
      if (next.ytFailed) return { ...next, status: 'timedout' }
      return next
    }
    case 'ytFailed': {
      const next = { ...s, ytFailed: true }
      if (next.slskFailed) return { ...next, status: 'timedout' }
      return next
    }
    case 'timeout':
      return { ...s, status: 'timedout', standDown: null }
    case 'stop':
      // Cancel both still-running sources.
      return { ...s, status: 'stopped', standDown: 'both' }
    default:
      return s
  }
}

const previewRacerApi = { derivePreviewQuery, cleanTrackTitle, baseName, racerInit, racerReduce }
if (typeof module !== 'undefined' && module.exports) module.exports = previewRacerApi
if (typeof window !== 'undefined') window.PapaPreviewRacer = previewRacerApi
