const { contextBridge, ipcRenderer } = require('electron')

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
  videoCollection:  (p) => ipcRenderer.invoke('video-collection', p),
  videoPerson:      (p) => ipcRenderer.invoke('video-person', p),
  videoTrailerUrl:  (p) => ipcRenderer.invoke('video-trailer-url', p),
  videoTasteShelf:  (p) => ipcRenderer.invoke('video-taste-shelf', p),
  videoTrailer:     (p) => ipcRenderer.invoke('video-trailer', p),
  videoPackSelect:  (p) => ipcRenderer.invoke('video-pack-select', p),
  videoDetail:      (p) => ipcRenderer.invoke('video-detail', p),
  videoStreams:     (p) => ipcRenderer.invoke('video-streams', p),
  videoProbe:       (p) => ipcRenderer.invoke('video-probe', p),
  videoPlay:        (p) => ipcRenderer.invoke('video-play', p),
  videoStop:        ()  => ipcRenderer.invoke('video-stop'),
  videoControl:     (verb, args) => ipcRenderer.invoke('video-control', { verb, args }),
  videoTracks:      ()  => ipcRenderer.invoke('video-tracks'),
  videoChapters:    ()  => ipcRenderer.invoke('video-chapters'),
  videoEnrich:      (p) => ipcRenderer.invoke('video-enrich', p),
  videoShelf:       (p) => ipcRenderer.invoke('video-shelf', p),
  videoCountries:   ()  => ipcRenderer.invoke('video-countries'),
  videoSubOpen:     ()  => ipcRenderer.invoke('video-sub-open'),
  videoSkipSegments:(req) => ipcRenderer.invoke('video-skip-segments', req),
  videoDetectIntro: (req) => ipcRenderer.invoke('video-detect-intro', req),
  videoSurfaceBounds:(rect) => ipcRenderer.invoke('video-surface-bounds', rect),
  videoSurfaceVisible:(visible) => ipcRenderer.invoke('video-surface-visible', { visible }),
  videoFullscreen:  ()  => ipcRenderer.invoke('video-fullscreen'),
  onVideoEvent: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('video-event', h); return () => ipcRenderer.removeListener('video-event', h) },
  onVideoState: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('video-state', h); return () => ipcRenderer.removeListener('video-state', h) },

  // Power management
  setPowerSave: (playing) => ipcRenderer.send('set-power-save', playing),

  // Last.fm
  getLastfmConfig:  ()  => ipcRenderer.invoke('get-lastfm-config'),
  setLastfmConfig:  (c) => ipcRenderer.invoke('set-lastfm-config', c),
  scrobbleTrack:    (t) => ipcRenderer.invoke('scrobble-track', t),

  // Start on boot
  getStartOnBoot: () => ipcRenderer.invoke('get-start-on-boot'),
  setStartOnBoot: (e) => ipcRenderer.invoke('set-start-on-boot', e),

  // Music Chat Agent
  checkOllama:     ()  => ipcRenderer.invoke('check-ollama'),
  getAgentModel:   ()  => ipcRenderer.invoke('get-agent-model'),
  saveAgentModel:  (m) => ipcRenderer.send('save-agent-model', m),
  agentChat:       (p) => ipcRenderer.invoke('agent-chat', p),
  getApiKeys:      ()  => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys:     (p) => ipcRenderer.invoke('save-api-keys', p),
  tasteRecordPlay: (d) => ipcRenderer.send('taste-record-play', d),
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
  slskGetDownloadDir: ()  => ipcRenderer.invoke('slsk-get-download-dir'),
  slskSetDownloadDir: ()  => ipcRenderer.invoke('slsk-set-download-dir'),
  onSlskdStatusChange: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slskd-status-change', h); return () => ipcRenderer.removeListener('slskd-status-change', h) },
  slskResolveFile:    (p) => ipcRenderer.invoke('slsk-resolve-file', p),
  slskVerifyFile:     (p) => ipcRenderer.invoke('slsk-verify-file', p),
  onSlskVerify:       (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-verify', h); return () => ipcRenderer.removeListener('slsk-verify', h) },
  slskShowInFolder:   (p) => ipcRenderer.invoke('slsk-show-in-folder', p),
  slskBrowseUser:     (p) => ipcRenderer.invoke('slsk-browse-user', p),
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
  libraryMigrateAlbumId: (p) => ipcRenderer.invoke('library-migrate-album-id', p),
  libraryPickArtwork:  ()  => ipcRenderer.invoke('library-pick-artwork'),
  librarySetArtwork:   (p) => ipcRenderer.invoke('library-set-artwork', p),

  slskUserStatuses:        ()  => ipcRenderer.invoke('slsk-user-statuses'),
  slskEnqueueDownloads:  (p) => ipcRenderer.invoke('slsk-enqueue-downloads', p),
  slskSchedulerStats:    ()  => ipcRenderer.invoke('slsk-scheduler-stats'),
  slskSchedulerQueue:    ()  => ipcRenderer.invoke('slsk-scheduler-queue'),
  slskSchedulerConfig:   (p) => ipcRenderer.invoke('slsk-scheduler-config', p),
  slskRespreadBacklog:   (p) => ipcRenderer.invoke('slsk-respread-backlog', p),
  onSlskSchedulerStats:  (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-scheduler-stats', h); return () => ipcRenderer.removeListener('slsk-scheduler-stats', h) },
  slskRefreshUserStatuses: ()  => ipcRenderer.invoke('slsk-refresh-user-statuses'),
  onSlskUserStatus:      (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-user-status', h); return () => ipcRenderer.removeListener('slsk-user-status', h) },
  onSlskSavedUsersChange:(cb) => { const h = (_, d) => cb(d); ipcRenderer.on('slsk-saved-users-changed', h); return () => ipcRenderer.removeListener('slsk-saved-users-changed', h) },
  ctxMenuShow:        (items) => ipcRenderer.invoke('ctx-menu-show', items),

  // YouTube
  ytMusicSearch:      (p) => ipcRenderer.invoke('yt-music-search', p),
  ytMusicSearchFull:  (p) => ipcRenderer.invoke('yt-music-search-full', p),
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
  playerGetStatus:   ()  => ipcRenderer.invoke('player-get-status'),
  playerGetConfig:   ()  => ipcRenderer.invoke('player-get-config'),
  playerSetConfig:   (c) => ipcRenderer.invoke('player-set-config', c),
  playerListDevices: ()  => ipcRenderer.invoke('player-list-devices'),
  eqInfo:            ()  => ipcRenderer.invoke('eq-info'),
  eqPreset:          (n) => ipcRenderer.invoke('eq-preset', n),
  playerRecheck:     ()  => ipcRenderer.invoke('player-recheck'),
  playerGetDiagnostics: () => ipcRenderer.invoke('player-get-diagnostics'),
  getHistoryReport:  ()  => ipcRenderer.invoke('get-history-report'),
  getSessionId:      ()  => ipcRenderer.invoke('get-session-id'),
  getAlbumIdRemap:   ()  => ipcRenderer.invoke('get-album-id-remap'),
  trackExists:       (p) => ipcRenderer.invoke('track-exists', p),
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
      'slsk-verify', 'slsk-user-status', 'slsk-saved-users-changed', 'slsk-scheduler-stats',
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
      'system-suspend', 'system-resume',
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
