'use strict'
// Install instructions that match the machine (roadmap 008). The blocker used
// to print `sudo dnf install mpv` to everyone, including Mac and Windows users
// for whom that is not a command that exists. One table, keyed by platform,
// read by the engine blocker, the video start-honesty sentences and the
// renderer's own fallback text. Pure; tested in test/install-hints.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaInstallHints = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // `primary` is the one command to show large. `alternatives` are the other
  // routes on that OS, shown small. `note` is a plain sentence when a command
  // alone would mislead (Windows has no single package manager everyone has).
  var TABLE = {
    darwin: {
      mpv:    { primary: 'brew install mpv',    alternatives: ['MacPorts: sudo port install mpv'], note: 'Needs Homebrew (brew.sh).' },
      ffmpeg: { primary: 'brew install ffmpeg', alternatives: ['MacPorts: sudo port install ffmpeg'], note: 'Needs Homebrew (brew.sh).' },
    },
    win32: {
      mpv:    { primary: 'winget install mpv', alternatives: ['Scoop: scoop install mpv', 'Chocolatey: choco install mpv', 'Or download from mpv.io and add it to PATH'], note: 'Run in PowerShell or Terminal.' },
      ffmpeg: { primary: 'winget install ffmpeg', alternatives: ['Scoop: scoop install ffmpeg', 'Chocolatey: choco install ffmpeg', 'Or download from ffmpeg.org and add it to PATH'], note: 'Run in PowerShell or Terminal.' },
    },
    linux: {
      mpv:    { primary: 'sudo dnf install -y mpv',    alternatives: ['Debian/Ubuntu: sudo apt install mpv', 'Arch: sudo pacman -S mpv'], note: '' },
      ffmpeg: { primary: 'sudo dnf install -y ffmpeg', alternatives: ['Debian/Ubuntu: sudo apt install ffmpeg', 'Arch: sudo pacman -S ffmpeg'], note: '' },
    },
  }

  function normalise(platform) {
    var p = String(platform || '').toLowerCase()
    if (p === 'darwin' || p === 'mac' || p === 'macos') return 'darwin'
    if (p === 'win32' || p === 'windows' || p === 'win') return 'win32'
    return 'linux'   // Linux and the BSDs share the same shape of answer
  }

  // The full record for one tool on one platform. Unknown tools get a null.
  function hint(tool, platform) {
    var row = TABLE[normalise(platform)]
    var h = row && row[String(tool || '').toLowerCase()]
    return h ? { primary: h.primary, alternatives: h.alternatives.slice(), note: h.note } : null
  }

  // One short next step for a sentence: "Run: brew install mpv".
  function next(tool, platform) {
    var h = hint(tool, platform)
    return h ? 'Run: ' + h.primary : 'Install ' + tool + ' and try again.'
  }

  // The platform this renderer is on, without needing main to tell it:
  // preload exposes process.platform; a bare browser has only the UA.
  function detect(win) {
    var w = win || (typeof window !== 'undefined' ? window : null)
    if (!w) return 'linux'
    var api = w.api
    if (api && typeof api.platform === 'string') return normalise(api.platform)
    var nav = w.navigator || {}
    var ua = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '')
    if (/mac/i.test(ua)) return 'darwin'
    if (/win/i.test(ua)) return 'win32'
    return 'linux'
  }

  return { hint: hint, next: next, detect: detect, normalise: normalise, PLATFORMS: Object.keys(TABLE) }
})
