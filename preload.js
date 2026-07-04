const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),

  // App info
  getAppInfo:      () => ipcRenderer.invoke('get-app-info'),
  getLibraryCache: () => ipcRenderer.invoke('get-library-cache'),
  saveLibraryCache: (albums) => ipcRenderer.send('save-library-cache', albums),

  // Folders
  addMusicFolder:    () => ipcRenderer.invoke('add-music-folder'),
  removeMusicFolder: (p) => ipcRenderer.invoke('remove-music-folder', p),

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

  // Followed artists
  getFollowedArtists:  () => ipcRenderer.invoke('get-followed-artists'),
  saveFollowedArtists: (a) => ipcRenderer.send('save-followed-artists', a),

  // Audio output settings
  getAudioSettings:  ()  => ipcRenderer.invoke('get-audio-settings'),
  saveAudioSettings: (s) => ipcRenderer.send('save-audio-settings', s),

  // EQ settings
  getEqSettings:  () => ipcRenderer.invoke('get-eq-settings'),
  saveEqSettings: (s) => ipcRenderer.send('save-eq-settings', s),

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

  // Torrents
  torrentAdd:    (p) => ipcRenderer.invoke('torrent-add', p),
  torrentList:   ()  => ipcRenderer.invoke('torrent-list'),
  torrentRemove: (h) => ipcRenderer.invoke('torrent-remove', h),

  // Power management
  setPowerSave: (playing) => ipcRenderer.send('set-power-save', playing),

  // Sites
  saveSite:   (s)   => ipcRenderer.invoke('save-site', s),
  removeSite: (url) => ipcRenderer.invoke('remove-site', url),

  // Quality Sources
  getQualitySources:        ()      => ipcRenderer.invoke('get-quality-sources'),
  saveQualitySources:       (srcs)  => ipcRenderer.invoke('save-quality-sources', srcs),
  searchOnlineSource:       (p)     => ipcRenderer.invoke('search-online-source', p),
  probeKnownSources:        ()      => ipcRenderer.invoke('probe-known-sources'),
  autoDownloadFromSource:   (p)     => ipcRenderer.invoke('auto-download-from-source', p),

  // Music Chat Agent
  checkOllama:     ()  => ipcRenderer.invoke('check-ollama'),
  getAgentModel:   ()  => ipcRenderer.invoke('get-agent-model'),
  saveAgentModel:  (m) => ipcRenderer.send('save-agent-model', m),
  agentChat:       (p) => ipcRenderer.invoke('agent-chat', p),
  getApiKeys:      ()  => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys:     (p) => ipcRenderer.invoke('save-api-keys', p),
  tasteRecordPlay: (d) => ipcRenderer.send('taste-record-play', d),
  tasteGetProfile: ()  => ipcRenderer.invoke('taste-get-profile'),

  // Browser
  showBrowser:          (url) => ipcRenderer.send('show-browser', url),
  hideBrowser:          ()    => ipcRenderer.send('hide-browser'),
  browserNavigate:      (url) => ipcRenderer.send('browser-navigate', url),
  browserBack:          ()    => ipcRenderer.send('browser-back'),
  browserForward:       ()    => ipcRenderer.send('browser-forward'),
  browserRefresh:       ()    => ipcRenderer.send('browser-refresh'),
  browserStop:          ()    => ipcRenderer.send('browser-stop'),
  browserZoomIn:        ()    => ipcRenderer.send('browser-zoom-in'),
  browserZoomOut:       ()    => ipcRenderer.send('browser-zoom-out'),
  browserZoomReset:     ()    => ipcRenderer.send('browser-zoom-reset'),
  cancelDownload:       (id)  => ipcRenderer.send('cancel-download', id),
  openBrowserDevtools:  ()    => ipcRenderer.send('open-browser-devtools'),

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
  slskResolveFile:    (p) => ipcRenderer.invoke('slsk-resolve-file', p),
  slskShowInFolder:   (p) => ipcRenderer.invoke('slsk-show-in-folder', p),
  slskBrowseUser:     (p) => ipcRenderer.invoke('slsk-browse-user', p),
  saveLyrics:         (p) => ipcRenderer.invoke('save-lyrics', p),
  ctxMenuShow:        (items) => ipcRenderer.invoke('ctx-menu-show', items),

  // Agent memory
  agentGetMemory:    ()    => ipcRenderer.invoke('agent-get-memory'),
  agentSaveConv:     (p)   => ipcRenderer.invoke('agent-save-conv', p),
  agentUpdateProfile:(p)   => ipcRenderer.invoke('agent-update-profile', p),
  agentClearMemory:  ()    => ipcRenderer.invoke('agent-clear-memory'),

  // Events from main process
  on: (channel, cb) => {
    const allowed = [
      'dl-started', 'dl-progress', 'dl-complete', 'dl-cancelled', 'dl-failed',
      'browser-url', 'browser-title', 'browser-loading', 'browser-load-error', 'browser-zoom',
      'media-key', 'ext-cmd', 'slsk-progress',
      'torrent-progress', 'torrent-done', 'torrent-started', 'do-lib-rescan',
    ]
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, data) => cb(data))
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})
