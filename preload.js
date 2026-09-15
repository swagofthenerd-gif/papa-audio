const { contextBridge, ipcRenderer, webFrame } = require('electron')

// Per-channel sequence tracking. A gap means events were sent that this
// renderer never received — during a reload, or while the window was going away
// — and the point is that it becomes knowable rather than silently absent.
const _seqSeen = new Map()
const _seqGaps = []

function reportSeq(channel, meta) {
  const prev = _seqSeen.get(channel)
  _seqSeen.set(channel, meta.seq)
  if (prev === undefined) return
  if (meta.seq === prev + 1) return
  const gap = { channel, expected: prev + 1, got: meta.seq, at: Date.now() }
  _seqGaps.push(gap)
  if (_seqGaps.length > 50) _seqGaps.shift()
  // Out of order rather than missing is worth telling apart.
  if (meta.seq > prev + 1) {
    console.error(`[papa][ipc] missed ${meta.seq - prev - 1} event(s) on ${channel} ` +
      `(expected ${prev + 1}, got ${meta.seq})`)
  } else {
    console.error(`[papa][ipc] out-of-order event on ${channel} (expected ${prev + 1}, got ${meta.seq})`)
  }
}

contextBridge.exposeInMainWorld('api', {
  // What this renderer has missed, for a diagnostics copy-out.
  ipcGaps: () => _seqGaps.slice(),
  // The OS, so install instructions match the machine (roadmap 008).
  platform: process.platform,
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),

  // App info
  getAppInfo:      () => ipcRenderer.invoke('get-app-info'),
  getLibraryCache: () => ipcRenderer.invoke('get-library-cache'),
  saveLibraryCache: (albums) => ipcRenderer.send('save-library-cache', albums),

  // Folders
  addMusicFolder:     () => ipcRenderer.invoke('add-music-folder'),
  addMusicFolderPath: (p) => ipcRenderer.invoke('add-music-folder-path', p),
  removeMusicFolder:  (p) => ipcRenderer.invoke('remove-music-folder', p),

  // Library
  scanLibrary:        () => ipcRenderer.invoke('scan-library'),
  saveRecentlyPlayed: (id) => ipcRenderer.send('save-recently-played', id),
  saveVolume:         (v) => ipcRenderer.send('save-volume', v),

  // Artwork
  fetchAlbumArt: (p) => ipcRenderer.invoke('fetch-album-art', p),

  // Extension IPC
  updateNowPlaying:  (data)   => ipcRenderer.send('update-now-playing',  data),
  updateLibraryExt:  (albums) => ipcRenderer.send('update-library-ext',  albums),

  // Playback state (resume across restarts)
  getPlaybackState:  () => ipcRenderer.invoke('get-playback-state'),
  savePlaybackState: (s) => ipcRenderer.send('save-playback-state', s),
  getSessionState:   () => ipcRenderer.invoke('get-session-state'),
  saveSessionState:  (s) => ipcRenderer.send('save-session-state', s),

  // Liked albums
  getLiked:  () => ipcRenderer.invoke('get-liked'),
  saveLiked: (ids) => ipcRenderer.send('save-liked', ids),

  // Liked tracks
  getLikedTracks:   () => ipcRenderer.invoke('get-liked-tracks'),
  saveLikedTracks:  (p) => ipcRenderer.send('save-liked-tracks', p),

  // Play counts & history
  getPlayCounts:      () => ipcRenderer.invoke('get-play-counts'),
  incrementPlayCount: (p) => ipcRenderer.send('increment-play-count', p),
  getPlayHistory:     () => ipcRenderer.invoke('get-play-history'),
  addPlayHistory:     (e) => ipcRenderer.send('add-play-history', e),
  updatePlayHistoryPosition: (e) => ipcRenderer.send('update-play-history-position', e),

  // Followed artists
  getFollowedArtists:  () => ipcRenderer.invoke('get-followed-artists'),
  saveFollowedArtists: (a) => ipcRenderer.send('save-followed-artists', a),

  // Saved queues
  getSavedQueues:   ()         => ipcRenderer.invoke('get-saved-queues'),
  saveQueue:        (q)        => ipcRenderer.send('save-queue', q),
  deleteSavedQueue: (id)       => ipcRenderer.send('delete-saved-queue', id),
  renameSavedQueue: (id, name) => ipcRenderer.send('rename-saved-queue', { id, name }),

  // Playlists
  getPlaylists:   ()     => ipcRenderer.invoke('get-playlists'),
  savePlaylist:   (pl)   => ipcRenderer.send('save-playlist', pl),
  deletePlaylist: (id)   => ipcRenderer.send('delete-playlist', id),

  // Notifications
  notifyTrack: (data) => ipcRenderer.send('notify-track', data),
  notifyDownloadComplete: (d) => ipcRenderer.send('notify-download-complete', d),
  getGeneralSettings: () => ipcRenderer.invoke('get-general-settings'),
  saveGeneralSettings: (s) => ipcRenderer.send('save-general-settings', s),
  // Tray mode (roadmap #21): turn minimize-to-tray on/off. Returns
  // { ok, enabled, hasTray }.
  papaTraySet: ({ enabled } = {}) => ipcRenderer.invoke('papa-tray-set', { enabled }),
  // Interface scale. webFrame lives in the renderer's process, so the zoom is
  // applied here rather than round-tripping through main. Clamped to the range
  // the setting offers so a bad stored value can't shrink the app to nothing.
  setZoomFactor: (f) => {
    const z = Number(f)
    if (!isFinite(z) || z <= 0) return
    webFrame.setZoomFactor(Math.max(0.5, Math.min(2, z)))
  },
  cancelDownload: (id) => ipcRenderer.send('cancel-download', id),

  // Torrents
  torrentAdd:    (p) => ipcRenderer.invoke('torrent-add', p),
  torrentList:   ()  => ipcRenderer.invoke('torrent-list'),
  torrentRemove: (h) => ipcRenderer.invoke('torrent-remove', h),

  // Papa Video
  videoSettingsGet: () => ipcRenderer.invoke('video-settings-get'),
  videoSettingsSet: (patch) => ipcRenderer.invoke('video-settings-set', { patch }),
  videoCatalogGet:  (p) => ipcRenderer.invoke('video-catalog-get', p),
  videoSearch:      (p) => ipcRenderer.invoke('video-search', p),
  videoDiscover:    (p) => ipcRenderer.invoke('video-discover', p),
  videoGenres:      (p) => ipcRenderer.invoke('video-genres', p),
  videoTags:        ()  => ipcRenderer.invoke('video-tags'),
  videoSeasons:     (p) => ipcRenderer.invoke('video-seasons', p),
  videoAnimeEpisodes: (p) => ipcRenderer.invoke('video-anime-episodes', p),
  videoAnimeHome:   () => ipcRenderer.invoke('video-anime-home'),
  videoCollection:  (p) => ipcRenderer.invoke('video-collection', p),
  videoPerson:      (p) => ipcRenderer.invoke('video-person', p),
  videoTrailerUrl:  (p) => ipcRenderer.invoke('video-trailer-url', p),
  videoTasteShelf:  (p) => ipcRenderer.invoke('video-taste-shelf', p),
  videoTrailer:     (p) => ipcRenderer.invoke('video-trailer', p),
  videoPackSelect:  (p) => ipcRenderer.invoke('video-pack-select', p),
  videoSwitchStream:(p) => ipcRenderer.invoke('video-switch-stream', p),
  videoPredownload:         (index) => ipcRenderer.invoke('video-predownload', { index }),
  videoPredownloadCancel:   ()      => ipcRenderer.invoke('video-predownload-cancel'),
  videoPredownloadProgress: ()      => ipcRenderer.invoke('video-predownload-progress'),
  videoKeepFile:            (index, show) => ipcRenderer.invoke('video-keep-file', { index, show }),
  // Offline downloads manager (roadmap #42): list kept files, delete one.
  videoKeepList:            ()   => ipcRenderer.invoke('video-keep-list'),
  videoCacheGet:            (p)  => ipcRenderer.invoke('video-cache-get', p),
  videoCacheList:           ()   => ipcRenderer.invoke('video-cache-list'),
  videoInstantList:         ()   => ipcRenderer.invoke('video-instant-list'),
  videoCacheDelete:         (p)  => ipcRenderer.invoke('video-cache-delete', p),
  videoWarm:                (p)  => ipcRenderer.invoke('video-warm', p),
  videoWarmCancel:          ()   => ipcRenderer.invoke('video-warm-cancel'),
  videoDebridPick:          (p)  => ipcRenderer.invoke('video-debrid-pick', p),
  videoDownloadStart:       (p)  => ipcRenderer.invoke('video-download-start', p),
  videoDownloadCancel:      (p)  => ipcRenderer.invoke('video-download-cancel', p),
  videoDownloadList:        ()   => ipcRenderer.invoke('video-download-list'),
  onVideoDownloadEvent: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('video-download-event', h); return () => ipcRenderer.removeListener('video-download-event', h) },
  videoKeepDelete:          (id) => ipcRenderer.invoke('video-keep-delete', { id }),
  videoDiagnostics: ()  => ipcRenderer.invoke('video-diagnostics'),
  videoDetail:      (p) => ipcRenderer.invoke('video-detail', p),
  videoStreams:     (p) => ipcRenderer.invoke('video-streams', p),
  videoProbe:       (p) => ipcRenderer.invoke('video-probe', p),
  videoThumb:       (p) => ipcRenderer.invoke('video-thumb', p),
  // W4-UI contract name: a frame at a time on the current stream (roadmap #28).
  videoThumbAt:     ({ sec } = {}) => ipcRenderer.invoke('video-thumb', { sec }),
  videoPlay:        (p) => ipcRenderer.invoke('video-play', p),
  videoStop:        ()  => ipcRenderer.invoke('video-stop'),
  videoControl:     (verb, args) => ipcRenderer.invoke('video-control', { verb, args }),
  videoOsd:         (text, durationMs) => ipcRenderer.invoke('video-osd', { text, durationMs }),
  videoStreamStats: ()  => ipcRenderer.invoke('video-stream-stats'),
  videoSubsInTorrent: () => ipcRenderer.invoke('video-subs-in-torrent'),
  videoSubServe:    (p) => ipcRenderer.invoke('video-sub-serve', p),
  videoSubSearch:   (p) => ipcRenderer.invoke('video-sub-search', p),
  videoSubDownload: (p) => ipcRenderer.invoke('video-sub-download', p),
  videoTracks:      ()  => ipcRenderer.invoke('video-tracks'),
  videoChapters:    ()  => ipcRenderer.invoke('video-chapters'),
  // The smooth player's screenshot: a PNG the page drew, saved by main.
  videoSaveFrame:   (p) => ipcRenderer.invoke('video-save-frame', p),
  videoEnrich:      (p) => ipcRenderer.invoke('video-enrich', p),
  videoShelf:       (p) => ipcRenderer.invoke('video-shelf', p),
  videoAiring:      (p) => ipcRenderer.invoke('video-airing', p),
  // Airing calendar month view + my-shows filter (roadmap #36).
  videoAiringCalendar: (p) => ipcRenderer.invoke('video-airing-calendar', p),
  videoCountries:   ()  => ipcRenderer.invoke('video-countries'),
  videoSubOpen:     ()  => ipcRenderer.invoke('video-sub-open'),
  videoSkipSegments:(req) => ipcRenderer.invoke('video-skip-segments', req),
  videoDetectIntro: (req) => ipcRenderer.invoke('video-detect-intro', req),
  videoSurfaceBounds:(rect) => ipcRenderer.invoke('video-surface-bounds', rect),
  videoSurfaceVisible:(visible) => ipcRenderer.invoke('video-surface-visible', { visible }),
  videoFullscreen:  ()  => ipcRenderer.invoke('video-fullscreen'),
  // Picture-in-picture mini player (roadmap #27): move the mpv surface into a
  // corner while browsing, or return it to the theatre stage.
  videoMiniMode:    ({ on, rect } = {}) => ipcRenderer.invoke('video-mini-mode', { on, rect }),
  // Subtitle styling (roadmap #30): size/color/position/background → mpv props,
  // persisted so a new engine spawn re-applies the look.
  videoSubStyle:    ({ size, color, position, background } = {}) =>
    ipcRenderer.invoke('video-sub-style', { size, color, position, background }),
  // Per-show track memory (roadmap #31/#32): remembered audio/subtitle/dub picks.
  videoTrackMemoryGet: ({ showKey } = {}) => ipcRenderer.invoke('video-track-memory-get', { showKey }),
  videoTrackMemorySet: ({ showKey, audioLang, subLang, dubPref } = {}) =>
    ipcRenderer.invoke('video-track-memory-set', { showKey, audioLang, subLang, dubPref }),
  // Debrid status for a future settings surface (roadmap #40).
  debridCheck:      ()  => ipcRenderer.invoke('debrid-check'),
  onVideoEvent: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('video-event', h); return () => ipcRenderer.removeListener('video-event', h) },
  onVideoState: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('video-state', h); return () => ipcRenderer.removeListener('video-state', h) },

  // Backup: export / import everything (App §2-12, the foundation page)
  papaExportAll: ()  => ipcRenderer.invoke('papa-export-all'),
  papaImportAll: (p) => ipcRenderer.invoke('papa-import-all', p),
  // Scheduled backup to ~/Documents/PapaAudioBackups/ (App #23): run one now, or
  // read the schedule status (interval, last run, files on disk).
  papaBackupNow:    () => ipcRenderer.invoke('papa-backup-now'),
  papaBackupStatus: () => ipcRenderer.invoke('papa-backup-status'),

  // yt-dlp self-maintenance: Settings row reads status and can force an update.
  ytdlpStatus:    () => ipcRenderer.invoke('ytdlp-status'),
  ytdlpUpdateNow: () => ipcRenderer.invoke('ytdlp-update-now'),

  // Self-maintenance suite (Maintenance settings panel): one aggregate status
  // read, the master toggle, and per-item check/update actions. Honest degrades
  // are in the payloads, never thrown.
  maintenanceStatus:  () => ipcRenderer.invoke('maintenance-status'),
  maintenanceGetAuto: () => ipcRenderer.invoke('maintenance-get-auto'),
  maintenanceSetAuto: (enabled) => ipcRenderer.invoke('maintenance-set-auto', { enabled }),
  slskdUpdateNow:     () => ipcRenderer.invoke('slskd-update-now'),
  slskdSetAutoUpdate: (enabled) => ipcRenderer.invoke('slskd-set-auto-update', { enabled }),
  trackersRefreshNow: () => ipcRenderer.invoke('trackers-refresh-now'),
  sourcesCanaryNow:   () => ipcRenderer.invoke('sources-canary-now'),
  sysdepsCheckNow:    () => ipcRenderer.invoke('sysdeps-check-now'),
  appUpdateCheckNow:  () => ipcRenderer.invoke('app-update-check-now'),

  // Changelog: user-facing "what's new" (App §7)
  appChangelog: () => ipcRenderer.invoke('app-changelog'),

  // Memory ceiling watchdog (roadmap #63): the last twelve samples + the ceiling.
  papaMemoryStats: () => ipcRenderer.invoke('papa-memory-stats'),

  // Profiler capture (roadmap #70): run the V8 CPU profiler on the main window
  // for a few seconds and write a .cpuprofile to the log dir. Powers a future
  // "report what's slow" button; returns { ok, path, seconds } or { ok:false }.
  papaProfileCapture: ({ seconds } = {}) => ipcRenderer.invoke('papa-profile-capture', { seconds }),

  // Bug reporter: bundle logs + diagnostics + redacted settings into a folder
  // and reveal it (App §97).
  papaBugReport: () => ipcRenderer.invoke('papa-bug-report'),

  // Offline detection (App §11). Main flips this on connectivity transitions;
  // the renderer draws the banner. Returns an unsubscribe function.
  onAppOnlineState: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('app-online-state', h); return () => ipcRenderer.removeListener('app-online-state', h) },

  // Power management
  setPowerSave: (playing) => ipcRenderer.send('set-power-save', playing),

  // Last.fm
  getLastfmConfig:  ()  => ipcRenderer.invoke('get-lastfm-config'),
  setLastfmConfig:  (c) => ipcRenderer.invoke('set-lastfm-config', c),
  scrobbleTrack:    (t) => ipcRenderer.invoke('scrobble-track', t),

  // Artist page: keyless bio (MusicBrainz→Wikipedia) + a similar slot the UI
  // fills from its own library-derived "Fans also like" row (Wave 3 contract).
  artistInfo:       (p) => ipcRenderer.invoke('artist-info', p),

  // Start on boot
  getStartOnBoot: () => ipcRenderer.invoke('get-start-on-boot'),
  setStartOnBoot: (e) => ipcRenderer.invoke('set-start-on-boot', e),

  // Music Chat Agent
  checkOllama:     ()  => ipcRenderer.invoke('check-ollama'),
  getAgentModel:   ()  => ipcRenderer.invoke('get-agent-model'),
  saveAgentModel:  (m) => ipcRenderer.send('save-agent-model', m),
  agentChat:       (p) => ipcRenderer.invoke('agent-chat', p),
  // Roadmap 106: Stop aborts the provider request in flight.
  agentCancel:     ()  => ipcRenderer.invoke('agent-cancel'),
  getApiKeys:      ()  => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys:     (p) => ipcRenderer.invoke('save-api-keys', p),
  tasteRecordPlay: (d) => ipcRenderer.invoke('taste-record-play', d),
  audioFeaturesAll: () => ipcRenderer.invoke('audio-features-all'),
  tasteGetProfile: ()  => ipcRenderer.invoke('taste-get-profile'),

  getDownloadWishlist:  () => ipcRenderer.invoke('get-download-wishlist'),
  saveDownloadWishlist: (w) => ipcRenderer.send('save-download-wishlist', w),

  // Soulseek
  slskStatus:    ()  => ipcRenderer.invoke('slsk-status'),
  slskGetConfig: ()  => ipcRenderer.invoke('slsk-get-config'),
  slskConfigure: (p) => ipcRenderer.invoke('slsk-configure', p),
  slskSetup:     ()  => ipcRenderer.invoke('slsk-setup'),
  slskSearch:    (p) => ipcRenderer.invoke('slsk-search', p),
  slskDownload:       (p) => ipcRenderer.invoke('slsk-download', p),
  slskGetTransfers:   ()  => ipcRenderer.invoke('slsk-get-transfers'),
  slskCancelTransfer: (p) => ipcRenderer.invoke('slsk-cancel-transfer', p),
  // Retry one stuck file: re-request from the same peer AND hunt a fresh source.
  slskRetryTransfer:  (p) => ipcRenderer.invoke('slsk-retry-transfer', p),
  slskGetDownloadDir: ()  => ipcRenderer.invoke('slsk-get-download-dir'),
  slskSetDownloadDir: ()  => ipcRenderer.invoke('slsk-set-download-dir'),
  onSlskdStatusChange: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slskd-status-change', h); return () => ipcRenderer.removeListener('slskd-status-change', h) },
  slskResolveFile:    (p) => ipcRenderer.invoke('slsk-resolve-file', p),
  slskVerifyFile:     (p) => ipcRenderer.invoke('slsk-verify-file', p),
  // Post-download verification verdict for one completed album group (#49).
  slskVerifyStatus:   (p) => ipcRenderer.invoke('slsk-verify-status', p),
  // A completed album group finished verification. Dedicated subscriber, returns
  // an unsubscribe function.
  onSlskVerifyDone:   (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-verify-done', h); return () => ipcRenderer.removeListener('slsk-verify-done', h) },
  slskShowInFolder:   (p) => ipcRenderer.invoke('slsk-show-in-folder', p),
  slskBrowseUser:     (p) => ipcRenderer.invoke('slsk-browse-user', p),
  // A background browse refresh finished for this user: the renderer re-reads via
  // slskBrowseUser (which now serves the fresh cache). Dedicated subscriber like
  // the user-status feed, returning an unsubscribe function.
  onSlskBrowseRefreshed: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-browse-refreshed', h); return () => ipcRenderer.removeListener('slsk-browse-refreshed', h) },
  onWindowFocus:      (cb) => ipcRenderer.on('window-focus', (_, on) => cb(on)),
  verifySurround:       (p) => ipcRenderer.invoke('verify-surround', p),
  verifySurroundFolder: (p) => ipcRenderer.invoke('verify-surround-folder', p),
  slskSavedUsers:     ()  => ipcRenderer.invoke('slsk-saved-users'),
  slskSaveUser:       (p) => ipcRenderer.invoke('slsk-save-user', p),
  slskUnsaveUser:     (p) => ipcRenderer.invoke('slsk-unsave-user', p),
  slskTouchUser:      (p) => ipcRenderer.invoke('slsk-touch-user', p),
  // Library management
  libraryInspectPaths: (p) => ipcRenderer.invoke('library-inspect-paths', p),
  libraryTrashPaths:   (p) => ipcRenderer.invoke('library-trash-paths', p),
  libraryMovePath:     (p) => ipcRenderer.invoke('library-move-path', p),
  libraryWriteTags:    (p) => ipcRenderer.invoke('library-write-tags', p),
  libraryPruneState:   (p) => ipcRenderer.invoke('library-prune-state', p),
  libraryRestoreState: (p) => ipcRenderer.invoke('library-restore-state', p),
  libraryRestoreTrashed: (p) => ipcRenderer.invoke('library-restore-trashed', p),
  libraryTrashList:    ()  => ipcRenderer.invoke('library-trash-list'),
  libraryEmptyTrash:   (p) => ipcRenderer.invoke('library-empty-trash', p),
  libraryScanExtras:   ()  => ipcRenderer.invoke('library-scan-extras'),
  libraryStorageReport:()  => ipcRenderer.invoke('library-storage-report'),
  libraryFreeSpace:    (p) => ipcRenderer.invoke('library-free-space', p),
  manageCacheGet:      ()  => ipcRenderer.invoke('manage-cache-get'),
  manageCacheSet:      (p) => ipcRenderer.invoke('manage-cache-set', p),
  libraryMigrateAlbumId: (p) => ipcRenderer.invoke('library-migrate-album-id', p),
  libraryPickArtwork:  ()  => ipcRenderer.invoke('library-pick-artwork'),
  librarySetArtwork:   (p) => ipcRenderer.invoke('library-set-artwork', p),

  slskUserStatuses:        ()  => ipcRenderer.invoke('slsk-user-statuses'),
  slskEnqueueDownloads:  (p) => ipcRenderer.invoke('slsk-enqueue-downloads', p),
  slskSchedulerStats:    ()  => ipcRenderer.invoke('slsk-scheduler-stats'),
  // Substitution log surface (roadmap #56): the accept/reject decisions the
  // scheduler logged, capped at 200, for the Downloads page to make trust
  // inspectable.
  slskSubLog:            ()  => ipcRenderer.invoke('slsk-scheduler-sublog'),
  slskSchedulerQueue:    ()  => ipcRenderer.invoke('slsk-scheduler-queue'),
  slskSchedulerConfig:   (p) => ipcRenderer.invoke('slsk-scheduler-config', p),
  // Bandwidth schedule (roadmap #51): day/night download throttle.
  slskScheduleGet:       ()  => ipcRenderer.invoke('slsk-schedule-get'),
  slskScheduleSet:       (p) => ipcRenderer.invoke('slsk-schedule-set', p),
  // Upload awareness (roadmap #54): what you're sharing back right now.
  slskUploadStats:       ()  => ipcRenderer.invoke('slsk-upload-stats'),
  onSlskUploadActivity:  (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-upload-activity', h); return () => ipcRenderer.removeListener('slsk-upload-activity', h) },
  // Peer chat (roadmap #55). List/history/send over slskd's /conversations API,
  // and a dedicated subscriber for the 30s poll's new-incoming-message event. The
  // renderer chat UI (parallel work) consumes these.
  slskChatList:          ()  => ipcRenderer.invoke('slsk-chat-list'),
  slskChatHistory:       (p) => ipcRenderer.invoke('slsk-chat-history', p),
  slskChatSend:          (p) => ipcRenderer.invoke('slsk-chat-send', p),
  onSlskChatMessage:     (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-chat-message', h); return () => ipcRenderer.removeListener('slsk-chat-message', h) },
  slskRespreadBacklog:   (p) => ipcRenderer.invoke('slsk-respread-backlog', p),
  slskUnbenchPeers:      ()  => ipcRenderer.invoke('slsk-unbench-peers'),
  // Restamp a whole album group's dispatch priority (#52). { username, folderName,
  // priority } — higher = sent sooner on the next tick.
  slskPrioritizeGroup:   (p) => ipcRenderer.invoke('slsk-prioritize-group', p),
  slskWishlistRun:       ()  => ipcRenderer.invoke('slsk-wishlist-run'),
  slskFriendDiffs:       ()  => ipcRenderer.invoke('slsk-friend-diffs'),
  // A wishlist sweep found and enqueued an album. Dedicated subscriber (like the
  // user-status feed) rather than the generic allowlist, and returns an
  // unsubscribe function so a page teardown does not leave a dangling listener.
  onSlskWishlistHit:     (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-wishlist-hit', h); return () => ipcRenderer.removeListener('slsk-wishlist-hit', h) },
  onSlskSchedulerStats:  (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-scheduler-stats', h); return () => ipcRenderer.removeListener('slsk-scheduler-stats', h) },
  slskRefreshUserStatuses: ()  => ipcRenderer.invoke('slsk-refresh-user-statuses'),
  onSlskUserStatus:      (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-user-status', h); return () => ipcRenderer.removeListener('slsk-user-status', h) },
  onSlskSavedUsersChange:(cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-saved-users-changed', h); return () => ipcRenderer.removeListener('slsk-saved-users-changed', h) },
  ctxMenuShow:        (items) => ipcRenderer.invoke('ctx-menu-show', items),

  // YouTube
  ytMusicSearch:      (p) => ipcRenderer.invoke('yt-music-search', p),
  ytMusicSearchFull:  (p) => ipcRenderer.invoke('yt-music-search-full', p),
  ytSuggest:          (p) => ipcRenderer.invoke('yt-suggest', p),
  ytAlbum:            (p) => ipcRenderer.invoke('yt-album', p),
  ytArtist:           (p) => ipcRenderer.invoke('yt-artist', p),
  ytSearch:       (p) => ipcRenderer.invoke('yt-search', p),
  ytDownload:     (p) => ipcRenderer.invoke('yt-download', p),
  ytGetDownloads: ()  => ipcRenderer.invoke('yt-get-downloads'),
  preResolveYtUrls: (v) => ipcRenderer.invoke('pre-resolve-yt-urls', v),
  ytSearchPage:      (p) => ipcRenderer.invoke('yt-search-page', p),
  ytPlaylist:        (p) => ipcRenderer.invoke('yt-playlist', p),
  ytHome:            ()  => ipcRenderer.invoke('yt-home'),
  getYtLiked:        ()  => ipcRenderer.invoke('get-yt-liked'),
  saveYtLiked:       (a) => ipcRenderer.send('save-yt-liked', a),
  getYtFollowed:     ()  => ipcRenderer.invoke('get-yt-followed'),
  saveYtFollowed:    (a) => ipcRenderer.send('save-yt-followed', a),
  getYtSavedAlbums:  ()  => ipcRenderer.invoke('get-yt-saved-albums'),
  saveYtSavedAlbums: (a) => ipcRenderer.send('save-yt-saved-albums', a),
  getYtRecent:       ()  => ipcRenderer.invoke('get-yt-recent'),
  saveYtRecent:      (a) => ipcRenderer.send('save-yt-recent', a),
  ytRadio:           (p) => ipcRenderer.invoke('yt-radio', p),
  ytFindVideo:       (p) => ipcRenderer.invoke('yt-find-video', p),
  getLyrics:         (p) => ipcRenderer.invoke('get-lyrics', p),
  saveLyrics:        (p) => ipcRenderer.invoke('save-lyrics', p),
  ytAuthStart:       ()  => ipcRenderer.invoke('yt-auth-start'),
  ytAuthSignOut:     ()  => ipcRenderer.invoke('yt-auth-signout'),
  ytAuthStatus:      ()  => ipcRenderer.invoke('yt-auth-status'),
  validateYtCookie:  ()  => ipcRenderer.invoke('validate-yt-cookie'),
  openExternal:      (u) => ipcRenderer.invoke('open-external', u),

  // Agent memory
  agentGetMemory:    ()    => ipcRenderer.invoke('agent-get-memory'),
  agentSaveConv:     (p)   => ipcRenderer.invoke('agent-save-conv', p),
  agentUpdateProfile:(p)   => ipcRenderer.invoke('agent-update-profile', p),
  agentClearMemory:  ()    => ipcRenderer.invoke('agent-clear-memory'),

  // mpv player engine
  playerLoad:        (p) => ipcRenderer.invoke('player-load', p),
  playerSwitch:      (p) => ipcRenderer.invoke('player-switch', p),
  playerPlay:        ()  => ipcRenderer.invoke('player-play'),
  playerPause:       ()  => ipcRenderer.invoke('player-pause'),
  playerSeek:        (s) => ipcRenderer.invoke('player-seek', s),
  playerSetVolume:   (v) => ipcRenderer.invoke('player-set-volume', v),
  playerSetSpeed:    (x) => ipcRenderer.invoke('player-set-speed', x),
  playerSetNext:     (p) => ipcRenderer.invoke('player-set-next', p),
  // W2-UI contract: A–B loop (#5) and runtime ReplayGain mode (#6) on the MUSIC
  // engine.
  mpvAbLoop:         (range) => ipcRenderer.invoke('mpv-ab-loop', range),
  mpvReplaygainMode: (mode) => ipcRenderer.invoke('mpv-replaygain-mode', mode),
  // W2-UI contract: batch tag write (#9). Pure-node FLAC Vorbis-comment writer;
  // non-FLAC files come back in `skipped` with reason 'unsupported'.
  tagWriteBatch:     (edits) => ipcRenderer.invoke('tag-write-batch', { edits }),
  // Wave-2 feature toggles (#34 diary auto-log, #35 airing notifications,
  // #50 auto-organize).
  videoConfigGet:    () => ipcRenderer.invoke('video-config-get'),
  videoConfigSet:    (patch) => ipcRenderer.invoke('video-config-set', patch),
  // ReplayGain scan (App #59) + tag fixer (App #60)
  loudnessScan:      (paths) => ipcRenderer.invoke('loudness-scan', { paths }),
  loudnessGetMap:    ()  => ipcRenderer.invoke('loudness-get-map'),
  musicbrainzCheckAlbum: (p) => ipcRenderer.invoke('musicbrainz-check-album', p),
  playerGetStatus:   ()  => ipcRenderer.invoke('player-get-status'),
  playerGetConfig:   ()  => ipcRenderer.invoke('player-get-config'),
  playerSetConfig:   (c) => ipcRenderer.invoke('player-set-config', c),
  // Global crossfade (#24): { seconds }, 0 = off. Drives all track transitions
  // except same-album gapless and a per-playlist override.
  playerSetCrossfade:(c) => ipcRenderer.invoke('player-set-crossfade', c),
  // Bit-perfect output (#65): { on }, default off. Rebuilds the engine with
  // exclusive device access and no ReplayGain/EQ/crossfade; returns the resolved
  // settings so the UI can reflect the enforced gapless/no-EQ state + note.
  playerSetBitPerfect:(a) => ipcRenderer.invoke('player-set-bit-perfect', a),
  playerListDevices: ()  => ipcRenderer.invoke('player-list-devices'),
  eqInfo:            ()  => ipcRenderer.invoke('eq-info'),
  eqPreset:          (n) => ipcRenderer.invoke('eq-preset', n),
  playerRecheck:     ()  => ipcRenderer.invoke('player-recheck'),
  playerGetDiagnostics: () => ipcRenderer.invoke('player-get-diagnostics'),
  getHistoryReport:  ()  => ipcRenderer.invoke('get-history-report'),
  getSessionId:      ()  => ipcRenderer.invoke('get-session-id'),
  getAlbumIdRemap:   ()  => ipcRenderer.invoke('get-album-id-remap'),
  trackExists:       (p) => ipcRenderer.invoke('track-exists', p),
  // Roadmap 048: point at a missing queue file's new home.
  locateTrackFile:   (p) => ipcRenderer.invoke('locate-track-file', p),
  slskCancelSearches: (p) => ipcRenderer.invoke('slsk-cancel-searches', p),
  getAudioDevices:   ()  => ipcRenderer.invoke('get-audio-devices'),
  setAudioDevice:    (d) => ipcRenderer.invoke('set-audio-device', d),
  getDeviceVolume:            ()  => ipcRenderer.invoke('get-device-volume'),
  saveDeviceVolume:           (v) => ipcRenderer.invoke('save-device-volume', v),
  getStreamingVolumeOffset:   ()  => ipcRenderer.invoke('get-streaming-volume-offset'),
  setStreamingVolumeOffset: (v) => ipcRenderer.send('set-streaming-volume-offset', v),

  transcodeFile: (p) => ipcRenderer.invoke('transcode-file', p),
  batchTranscode: (p) => ipcRenderer.invoke('batch-transcode', p),

  queueBuild:          (opts) => ipcRenderer.invoke('queue-build', opts),
  queueMixes:          () => ipcRenderer.invoke('queue-mixes'),
  queueAnalysisStatus: () => ipcRenderer.invoke('queue-analysis-status'),
  queueAnalysisStart:  () => ipcRenderer.invoke('queue-analysis-start'),

  // Events from main process
  // Returns an unsubscribe function. Without one, callers had to use off(),
  // which is removeAllListeners on the whole channel — so clicking Set up
  // Soulseek during a streaming search tore down the search's listener too and
  // the results silently stopped updating.
  on: (channel, cb) => {
    const allowed = [
      'dl-started', 'dl-progress', 'dl-complete', 'dl-cancelled', 'dl-failed',
      'media-key', 'media-playpause', 'media-next', 'media-previous', 'ext-cmd', 'slsk-progress', 'slskd-status-change', 'player-event', 'media-seek',
      'torrent-progress', 'torrent-done', 'torrent-started', 'do-lib-rescan',
      'yt-dl-progress', 'yt-auth-pending', 'yt-auth-done',
      'slsk-user-status', 'slsk-saved-users-changed', 'slsk-scheduler-stats',
      'library-updated', 'scan-progress', 'app-recovered-from-crash',
      'queue-analysis-progress',
      'video-event',
      'video-state',
      // The tray menu, MPRIS and the power monitor all send these, and none of
      // them was subscribable: Play, Next and Previous in the tray menu did
      // nothing, and seeking or changing volume from a desktop applet did
      // nothing. Note for future edits: no apostrophes inside this array, the
      // wiring test parses it by quote pairs.
      'media-playpause', 'media-next', 'media-previous',
      'media-volume', 'media-shuffle', 'media-loop-status',
      'open-downloaded-album',
      'system-suspend', 'system-resume',
      // Memory ceiling watchdog (roadmap #63): main asks the renderer to trim its
      // caches when the renderer RSS crosses the ceiling twice in a row.
      'papa-memory-pressure',
      // yt-dlp self-maintenance: main pushes these after an automatic update or a
      // playback-error recovery so the renderer can toast "YouTube support was
      // updated — try again".
      'ytdlp-updated', 'ytdlp-recovered',
      // Self-maintenance suite: main pushes these after a verified slskd swap or
      // when a newer app release is found, so the renderer can toast. No
      // apostrophes inside this array — the wiring test parses it by quote pairs.
      'slskd-updated', 'app-update-available',
    ]
    if (!allowed.includes(channel)) return () => {}
    const h = (_, data, meta) => {
      // main stamps a monotonic sequence per channel. Checked here so every
      // consumer benefits without any of them knowing about it, and stripped
      // before the payload reaches the callback so no shape changes.
      if (meta && typeof meta.seq === 'number') reportSeq(channel, meta)
      cb(data)
    }
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})

// The video watch-store bridge (src/video-store.js bridge mode): raw-string
// read/write against a main-process SideStore, so Continue Watching survives
// crashes that Chromium's delayed localStorage commits never would.
contextBridge.exposeInMainWorld('__papaVideoStoreBridge', {
  read:        ()     => ipcRenderer.invoke('video-store-read'),
  write:       (text) => ipcRenderer.invoke('video-store-write', text),
  readBackup:  ()     => ipcRenderer.invoke('video-store-read-backup'),
  writeBackup: (text) => ipcRenderer.invoke('video-store-write-backup', text),
})
