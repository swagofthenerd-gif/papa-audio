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

  // Music Chat Agent
  checkOllama:     ()  => ipcRenderer.invoke('check-ollama'),
  getAgentModel:   ()  => ipcRenderer.invoke('get-agent-model'),
  saveAgentModel:  (m) => ipcRenderer.send('save-agent-model', m),
  agentChat:       (p) => ipcRenderer.invoke('agent-chat', p),
  getApiKeys:      ()  => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys:     (p) => ipcRenderer.invoke('save-api-keys', p),
  tasteRecordPlay: (d) => ipcRenderer.send('taste-record-play', d),
  tasteGetProfile: ()  => ipcRenderer.invoke('taste-get-profile'),

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
  ctxMenuShow:        (items) => ipcRenderer.invoke('ctx-menu-show', items),

  // YouTube
  ytMusicSearch:      (p) => ipcRenderer.invoke('yt-music-search', p),
  ytMusicSearchFull:  (p) => ipcRenderer.invoke('yt-music-search-full', p),
  ytAlbum:            (p) => ipcRenderer.invoke('yt-album', p),
  ytArtist:           (p) => ipcRenderer.invoke('yt-artist', p),
  ytSearch:       (p) => ipcRenderer.invoke('yt-search', p),
  ytDownload:     (p) => ipcRenderer.invoke('yt-download', p),
  ytGetDownloads: ()  => ipcRenderer.invoke('yt-get-downloads'),
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
  openExternal:      (u) => ipcRenderer.invoke('open-external', u),

  // Agent memory
  agentGetMemory:    ()    => ipcRenderer.invoke('agent-get-memory'),
  agentSaveConv:     (p)   => ipcRenderer.invoke('agent-save-conv', p),
  agentUpdateProfile:(p)   => ipcRenderer.invoke('agent-update-profile', p),
  agentClearMemory:  ()    => ipcRenderer.invoke('agent-clear-memory'),

  // mpv player engine
  playerLoad:        (p) => ipcRenderer.invoke('player-load', p),
  playerSetNext:     (p) => ipcRenderer.invoke('player-set-next', p),
  playerPlay:        ()  => ipcRenderer.invoke('player-play'),
  playerPause:       ()  => ipcRenderer.invoke('player-pause'),
  playerSeek:        (s) => ipcRenderer.invoke('player-seek', s),
  playerSetVolume:   (v) => ipcRenderer.invoke('player-set-volume', v),
  playerSetSpeed:    (x) => ipcRenderer.invoke('player-set-speed', x),
  playerGetStatus:   ()  => ipcRenderer.invoke('player-get-status'),
  playerGetConfig:   ()  => ipcRenderer.invoke('player-get-config'),
  playerSetConfig:   (c) => ipcRenderer.invoke('player-set-config', c),
  playerListDevices: ()  => ipcRenderer.invoke('player-list-devices'),
  playerRecheck:     ()  => ipcRenderer.invoke('player-recheck'),

  // Events from main process
  on: (channel, cb) => {
    const allowed = [
      'dl-started', 'dl-progress', 'dl-complete', 'dl-cancelled', 'dl-failed',
      'browser-url', 'browser-title', 'browser-loading', 'browser-load-error', 'browser-zoom',
      'media-key', 'ext-cmd', 'slsk-progress', 'player-event', 'media-seek',
      'torrent-progress', 'torrent-done', 'torrent-started', 'do-lib-rescan',
      'yt-dl-progress', 'yt-auth-pending', 'yt-auth-done',
    ]
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, data) => cb(data))
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})
