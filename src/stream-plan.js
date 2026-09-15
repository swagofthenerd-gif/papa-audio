'use strict'
// The smooth player's decision table (video plan V0/V1): given what ffprobe
// says a source contains and what this Electron's <video> can decode, decide
// how ffmpeg turns it into a browser-playable fragmented MP4.
//
//   remux      copy the streams — nothing is re-encoded (AV1/H.264/VP9 video,
//              AAC/Opus/FLAC audio). Instant and lossless.
//   transcode  the video, the audio, or both are re-encoded (HEVC → H.264 on
//              the GPU; AC-3/E-AC-3/TrueHD/DTS → Opus 5.1). HDR is tone-mapped
//              to SDR and SAID so.
//   refuse     nothing sensible can be done; the caller falls back to mpv.
//
// Measured on the user's machine (RTX 3070, ffmpeg 8.1): 1080p HEVC → H.264
// runs at ~5.5× real time; 4K HDR tone-mapped on the GPU through OpenCL at
// ~2.9× (the CPU chain, kept as the fallback, manages ~0.9×, which is why
// that case asks for a longer pre-roll). Pure and DOM-free; tested in
// test/stream-plan.test.js. Loaded by main via require.

const BROWSER_VIDEO = new Set(['h264', 'av1', 'vp9', 'vp8'])
// Vorbis is left out on purpose: the browser decodes it, but not inside MP4
// through Media Source Extensions, which is how the page now plays.
const BROWSER_AUDIO = new Set(['aac', 'opus', 'flac', 'mp3'])
// Text subtitles ffmpeg can turn into WebVTT sidecars; everything else is
// image-based or styled and is burned in on a transcode.
const TEXT_SUBS = new Set(['subrip', 'srt', 'webvtt', 'mov_text', 'text'])
const STYLED_SUBS = new Set(['ass', 'ssa'])
const SPLIT_SEEK_SEC = 2   // re-encode seeks: this much decoded and discarded after the input seek

function _s(v) { return typeof v === 'string' ? v.toLowerCase() : '' }
function _n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0 }

function isHdr(v) {
  if (!v) return false
  const t = _s(v.color_transfer)
  const p = _s(v.color_primaries)
  if (t === 'smpte2084' || t === 'arib-std-b67') return true
  if (p === 'bt2020' && /10le|12le/.test(_s(v.pix_fmt))) return true
  return false
}

function _bitDepth(v) { return /10le|10be|p010/.test(_s(v && v.pix_fmt)) ? 10 : /12le/.test(_s(v && v.pix_fmt)) ? 12 : 8 }

// Choose the streams: the first video, the preferred audio (most channels,
// then the requested language), text subtitles as sidecars.
function pickStreams(streams, prefs) {
  prefs = prefs || {}
  const list = Array.isArray(streams) ? streams : []
  const video = list.find(s => _s(s.codec_type) === 'video' && !(s.disposition && s.disposition.attached_pic)) || null
  const audios = list.filter(s => _s(s.codec_type) === 'audio')
  const subs = list.filter(s => _s(s.codec_type) === 'subtitle')
  let audio = null
  if (prefs.audioIndex != null) audio = audios.find(a => a.index === prefs.audioIndex) || null
  if (!audio && prefs.lang) audio = audios.find(a => a.tags && _s(a.tags.language) === _s(prefs.lang)) || null
  if (!audio) audio = audios.slice().sort((a, b) => _n(b.channels) - _n(a.channels))[0] || null
  return { video, audio, audios, subs }
}

// The plan. `caps` overrides the browser capability table (tests, or a future
// build that can do HEVC). `opts.gpu` says NVENC/NVDEC are available.
// The MIME type with codec parameters that Media Source Extensions need to
// open a SourceBuffer for this plan's output. Copied streams describe the
// source (H.264 profile/level, AV1 profile/level/tier/depth, VP9 profile/
// level/depth); re-encoded ones are what ffmpeg is told to produce (H.264
// High, Opus). A string the browser rejects makes the page fall back to a
// plain <video src>, so an approximation is safe, just slower to seek back.
const H264_PROFILES = { baseline: '42', 'constrained baseline': '42', main: '4d', extended: '58', high: '64', 'high 10': '6e', 'high 4:2:2': '7a', 'high 4:4:4': 'f4', 'high 4:4:4 predictive': 'f4' }
function _hex2(n) { const h = Math.max(0, Math.min(255, Math.round(n))).toString(16); return h.length < 2 ? '0' + h : h }
function videoCodecString(v, copy) {
  if (!copy) return 'avc1.640028'
  const c = _s(v && v.codec_name)
  const level = _n(v && v.level)
  if (c === 'h264') {
    const prof = H264_PROFILES[_s(v.profile)] || '64'
    return 'avc1.' + prof + '00' + _hex2(level > 0 ? level : 40)
  }
  if (c === 'av1') {
    const prof = /high/.test(_s(v.profile)) ? '1' : /professional/.test(_s(v.profile)) ? '2' : '0'
    // ffprobe reports -99 / 0 when the level is unknown: assume 4.0 (index 8).
    const lv = level > 0 && level < 32 ? level : 8
    const depth = _bitDepth(v)
    // av01.P.LLT.DD — the level index is two decimal digits, the tier M.
    return 'av01.' + prof + '.' + (lv < 10 ? '0' + lv : String(lv)) + 'M.' + (depth === 12 ? '12' : depth === 10 ? '10' : '08')
  }
  if (c === 'vp9') {
    const prof = /profile ?([0-3])/.exec(_s(v.profile))
    const depth = _bitDepth(v)
    return 'vp09.0' + (prof ? prof[1] : '0') + '.' + _hex2(level > 0 ? level : 40) + '.' + (depth === 12 ? '12' : depth === 10 ? '10' : '08')
  }
  if (c === 'vp8') return 'vp8'
  return 'avc1.640028'
}
function audioCodecString(a, copy) {
  if (!a) return null
  if (!copy) return 'opus'
  const c = _s(a.codec_name)
  if (c === 'aac') return 'mp4a.40.2'
  if (c === 'mp3') return 'mp4a.40.34'
  if (c === 'opus') return 'opus'
  if (c === 'flac') return 'flac'
  return 'opus'
}
function mimeFor(video, audio, videoCopy, audioCopy) {
  const parts = [videoCodecString(video, videoCopy)]
  const ac = audioCodecString(audio, audioCopy)
  if (ac) parts.push(ac)
  return 'video/mp4; codecs="' + parts.join(',') + '"'
}

function plan(streams, opts) {
  opts = opts || {}
  const caps = Object.assign({ video: BROWSER_VIDEO, audio: BROWSER_AUDIO, gpu: true, opencl: true }, opts.caps || {})
  const { video, audio, audios, subs } = pickStreams(streams, opts.prefs)
  if (!video) return { mode: 'refuse', reason: 'no video stream' }

  const vcodec = _s(video.codec_name)
  const acodec = audio ? _s(audio.codec_name) : null
  const hdr = isHdr(video)
  const depth = _bitDepth(video)
  const width = _n(video.width), height = _n(video.height)
  const channels = audio ? _n(audio.channels) : 0

  // Video: copy when the browser decodes it AND it is not HDR (the browser
  // would show HDR as washed-out SDR); otherwise re-encode to H.264 8-bit.
  // AV1 10-bit SDR plays natively (measured), so it copies.
  const videoCopy = caps.video.has(vcodec) && !hdr
  const videoArgs = videoCopy
    ? ['-c:v', 'copy']
    : (caps.gpu
      ? (hdr
        ? (caps.opencl
          // GPU decode, OpenCL tone-map on the GPU, GPU encode: ~2.9× at 4K.
          ? ['-vf', 'hwupload,tonemap_opencl=tonemap=hable:format=nv12:desat=0,hwdownload,format=nv12',
             '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', width > 2000 ? '45M' : '25M', '-bufsize', width > 2000 ? '90M' : '50M', '-profile:v', 'high']
          // No OpenCL: CPU tone-map, ~0.9× at 4K.
          : ['-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p',
             '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', width > 2000 ? '45M' : '25M', '-bufsize', width > 2000 ? '90M' : '50M', '-profile:v', 'high'])
        : ['-vf', 'scale_cuda=format=nv12', '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-maxrate', width > 2000 ? '45M' : '25M', '-bufsize', width > 2000 ? '90M' : '50M', '-profile:v', 'high'])
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'])
  // Input-side flags: hardware decode only when the frames stay on the GPU
  // (no tone-map) — the tone-map filter chain needs them in system memory.
  const inputArgs = (!videoCopy && caps.gpu)
    ? (hdr
      ? (caps.opencl ? ['-init_hw_device', 'opencl=ocl', '-filter_hw_device', 'ocl', '-hwaccel', 'cuda'] : ['-hwaccel', 'cuda'])
      : ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'])
    : []

  // Audio: copy when the browser decodes it; else Opus at a bitrate that
  // keeps 5.1/7.1 honest (512k for surround, 192k stereo). Layouts above 5.1
  // fold down to 5.1 — Opus in MP4 stops there in the browser.
  let audioArgs = []
  if (!audio) audioArgs = ['-an']
  else if (caps.audio.has(acodec)) audioArgs = ['-c:a', 'copy']
  else audioArgs = ['-c:a', 'libopus', '-b:a', channels > 2 ? '512k' : '192k', '-ac', String(Math.min(channels || 2, 6))]

  // Subtitles: text ones become WebVTT sidecars; styled or image ones can only
  // be burned in, which forces a transcode when one is selected.
  const sidecars = subs.filter(s => TEXT_SUBS.has(_s(s.codec_name))).map(s => ({ index: s.index, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '' }))
  const burnable = subs.filter(s => STYLED_SUBS.has(_s(s.codec_name)) || /pgs|dvd_subtitle|dvb/.test(_s(s.codec_name))).map(s => ({ index: s.index, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '', styled: STYLED_SUBS.has(_s(s.codec_name)) }))

  const mode = (videoCopy && (!audio || caps.audio.has(acodec))) ? 'remux' : 'transcode'
  // 4K converts slower than 1080p: buffer before playing. HDR without a GPU
  // tone-map runs at about real time and needs the most.
  const prerollSec = (!videoCopy && width > 2000) ? ((hdr && !caps.opencl) ? 8 : 4) : (!videoCopy ? 2 : 0)

  return {
    mode,
    reason: mode === 'remux' ? 'browser decodes it' : (videoCopy ? 'audio re-encoded' : (hdr ? 'HDR tone-mapped to SDR, re-encoded' : 'video re-encoded')),
    video: { index: video.index, codec: vcodec, copy: videoCopy, hdr, depth, width, height },
    audio: audio ? { index: audio.index, codec: acodec, copy: caps.audio.has(acodec), channels, lang: (audio.tags && audio.tags.language) || '' } : null,
    audios: audios.map(a => ({ index: a.index, codec: _s(a.codec_name), channels: _n(a.channels), lang: (a.tags && a.tags.language) || '', title: (a.tags && a.tags.title) || '' })),
    subtitles: { sidecars, burnable },
    inputArgs, videoArgs, audioArgs,
    prerollSec,
    mime: mimeFor(video, audio, videoCopy, !!(audio && caps.audio.has(acodec))),
    // V067: the three transformations are told apart and none is left silent
    // except a true remux, where picture and sound are the file's own. An
    // audio re-encode alone used to carry no badge at all.
    badges: [
      hdr ? 'HDR shown as SDR' : null,
      !videoCopy ? 'video re-encoded' : null,
      (videoCopy && audio && !caps.audio.has(acodec)) ? 'audio re-encoded' : null,
    ].filter(Boolean),
  }
}

// The ffmpeg argv for one stream session from `startSec`, writing fragmented
// MP4 to stdout. `burnIndex` selects a burnable subtitle stream to draw into
// the picture (forces a re-encode even for a remux-able video).
function ffmpegArgs(p, input, startSec, extra) {
  extra = extra || {}
  const start = Math.max(0, _n(startSec))
  let videoArgs = p.videoArgs
  let inputArgs = p.inputArgs
  if (extra.burnIndex != null && p.video.copy) {
    // Burning text into a copied stream needs decoding: software H.264 path.
    videoArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
    inputArgs = []
  }
  // Seeking a re-encode: a single input -ss left the picture stamped from
  // the keyframe before the target while the copied sound was rebased to
  // the target — 2.3 s of lip-sync error on every seek and every resume
  // (measured). Seeking to two seconds before the target on the input and
  // the last two seconds on the output gives both tracks one clock. A copied
  // video stream cannot be cut inside a GOP, so it keeps the input seek.
  const reencode = !(videoArgs[0] === '-c:v' && videoArgs[1] === 'copy')
  const inputSeek = start > 0 ? (reencode ? Math.max(0, start - SPLIT_SEEK_SEC) : start) : 0
  const outputSeek = start > 0 && reencode ? start - inputSeek : 0
  const filters = []
  const vfIdx = videoArgs.indexOf('-vf')
  if (vfIdx !== -1) filters.push(videoArgs[vfIdx + 1])
  // Text/styled subtitles (ASS, SRT) are drawn by the subtitles filter;
  // image subtitles (PGS, DVD, DVB) are bitmaps and must be overlaid from
  // the subtitle stream itself — the subtitles filter cannot read them.
  const imageBurn = extra.burnIndex != null && !!extra.burnImage
  if (extra.burnIndex != null && !imageBurn) filters.push("subtitles='" + String(input).replace(/'/g, "'\\''") + "':si=" + extra.burnSubOrdinal)
  const vArgs = vfIdx !== -1 ? videoArgs.filter((_, i) => i !== vfIdx && i !== vfIdx + 1) : videoArgs.slice()
  if (imageBurn) {
    // Frames must be in system memory for the overlay: the CUDA-only chain
    // (frames kept on the GPU) drops its output-format flag and scale_cuda.
    if (inputArgs.indexOf('-hwaccel_output_format') !== -1) inputArgs = inputArgs.filter(x => x !== '-hwaccel_output_format' && x !== 'cuda').concat(['-hwaccel', 'cuda'])
    const chain = filters.filter(f => !/^scale_cuda/.test(f)).join(',')
    const graph = '[0:' + p.video.index + ']' + (chain ? chain + ',' : '') + 'format=nv12[v];[v][0:' + extra.burnIndex + ']overlay=eof_action=pass:format=auto,format=nv12[out]'
    return ['-hide_banner', '-loglevel', 'error', '-nostdin']
      .concat(inputArgs)
      .concat(inputSeek > 0 ? ['-ss', String(inputSeek)] : [])
      .concat(['-i', input])
      .concat(outputSeek > 0 ? ['-ss', String(outputSeek)] : [])
      .concat(['-filter_complex', graph, '-map', '[out]'])
      .concat(p.audio ? ['-map', '0:' + p.audio.index] : [])
      .concat(vArgs)
      .concat(p.audioArgs)
      .concat(['-sn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'])
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    .concat(inputArgs)
    .concat(inputSeek > 0 ? ['-ss', String(inputSeek)] : [])
    .concat(['-i', input])
    .concat(outputSeek > 0 ? ['-ss', String(outputSeek)] : [])
    // A copied picture starts on a keyframe; the muxer's default timestamp
    // policy then wrote a first sound packet followed by a jump the size of
    // the seek — the copy-picture lip-sync bug. make_non_negative keeps the
    // sound contiguous. The caller starts such a run on the keyframe itself
    // (keyframeAtOrBefore), so both tracks share one origin.
    .concat(!reencode && start > 0 ? ['-avoid_negative_ts', 'make_non_negative'] : [])
    .concat(['-map', '0:' + p.video.index])
    .concat(p.audio ? ['-map', '0:' + p.audio.index] : [])
    .concat(filters.length ? ['-vf', filters.join(',')] : [])
    .concat(vArgs)
    .concat(p.audioArgs)
    .concat(['-sn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'])
  // Text subtitles ride along as extra WebVTT outputs of the same run (one
  // read of the input, which on a torrent-backed source is the whole point):
  // extra.subOutputs = [{ index, file }].
  // -flush_packets: the muxer writes each cue as it comes instead of holding
  // a 32 KiB buffer, so a sidecar read mid-run already has the recent cues.
  for (const o of (extra.subOutputs || [])) args.push('-map', '0:' + o.index, '-c:s', 'webvtt', '-f', 'webvtt', '-flush_packets', '1', '-y', o.file)
  return args
}

// Cues in a WebVTT text, shifted by `shiftSec` (a run started at -ss t has
// cues from 0). Returns [{ start, end, text }].
function parseVtt(text, shiftSec) {
  const out = []
  const shift = Number(shiftSec) || 0
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/)
  for (const b of blocks) {
    const lines = b.split('\n')
    const at = lines.findIndex(l => /-->/.test(l))
    if (at === -1) continue
    const m = /(\d+:)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(\d+:)?(\d{1,2}):(\d{2})\.(\d{3})(.*)/.exec(lines[at])
    if (!m) continue
    const sec = (h, mi, s, ms) => (Number(String(h || '0').replace(':', '')) * 3600) + Number(mi) * 60 + Number(s) + Number(ms) / 1000
    const start = sec(m[1], m[2], m[3], m[4]) + shift
    const end = sec(m[5], m[6], m[7], m[8]) + shift
    out.push({ start, end, settings: (m[9] || '').trim(), text: lines.slice(at + 1).join('\n').replace(/\n+$/, '') })
  }
  return out
}
function _ts(sec) {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000)
  const p2 = n => String(n).padStart(2, '0')
  return p2(h) + ':' + p2(m) + ':' + p2(x) + '.' + String(ms).padStart(3, '0')
}
// Merge cue lists (later runs win on the same start) into one WebVTT text.
function mergeVtt(cueLists) {
  const byStart = new Map()
  for (const list of cueLists) for (const c of list) byStart.set(c.start.toFixed(3), c)
  const cues = Array.from(byStart.values()).sort((a, b) => a.start - b.start)
  return 'WEBVTT\n\n' + cues.map(c => _ts(c.start) + ' --> ' + _ts(c.end) + (c.settings ? ' ' + c.settings : '') + '\n' + c.text).join('\n\n') + (cues.length ? '\n' : '')
}

// The ffprobe argv that lists keyframe times in the window before `sec`, so
// a copied-picture run can start exactly on a keyframe.
function keyframeProbeArgs(input, sec, windowSec) {
  const to = Math.max(0, _n(sec))
  const from = Math.max(0, to - (windowSec || 20))
  return ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-read_intervals', from + '%' + to,
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', input]
}
// The last keyframe time at or before `sec` in ffprobe's output, or null.
function keyframeAtOrBefore(probeOut, sec) {
  const to = _n(sec)
  let best = null
  for (const line of String(probeOut || '').split('\n')) {
    const cell = line.trim().split(',')[0]
    if (!cell) continue
    const t = Number(cell)
    if (Number.isFinite(t) && t <= to + 0.001 && (best == null || t > best)) best = t
  }
  return best
}

// WebVTT sidecar extraction for one text subtitle stream.
function subtitleArgs(input, streamIndex) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', '0:' + streamIndex, '-f', 'webvtt', 'pipe:1']
}

module.exports = { plan, pickStreams, isHdr, ffmpegArgs, subtitleArgs, keyframeProbeArgs, keyframeAtOrBefore, parseVtt, mergeVtt, mimeFor, videoCodecString, audioCodecString, BROWSER_VIDEO, BROWSER_AUDIO }
