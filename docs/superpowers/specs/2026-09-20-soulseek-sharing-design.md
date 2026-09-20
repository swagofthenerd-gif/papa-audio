# Soulseek sharing — implementable design

## What this changes

Right now Papa Audio hands strangers whatever folder it picked for you and gives you one dropdown with three choices, and there is no way to stop Soulseek without quitting the app. After this you tick exactly which folders go out, you have a switch that turns Soulseek off and keeps it off, and there is one number that stops it eating your internet. Nothing changes on your machine without you pressing something, and every screen says what is actually happening instead of guessing.

**A correction to the brief before anything else:** your machine is currently set to `downloads`, not `library`. The live `slskd.yml` on this computer shares exactly one folder — `/mnt/data/MUSIC/Downloads`. Your three music folders (`/mnt/data/MUSIC`, `/mnt/windows/Music`, `/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos]…`) are not shared at all today. Every migration sentence below is written so your setting keeps meaning exactly that.

---

## 1. Choosing what to share

### Where it lives

Settings → Soulseek (`#soulseek-settings`, `src/index.html:564-593`), replacing the "Share with other people" row and its hint, which sit between the Download-folder row and the legacy-shop checkbox. Reached by `openSettings('soulseek')`, which two existing error banners already link to. The block stays between `id="soulseek-settings"` and `id="video-settings"` so `test/settings-soulseek-section.test.js` keeps passing.

### What it looks like

```
Share with other people                        Sharing 1 folder

  ☑  Downloads
     /mnt/data/MUSIC/Downloads

  ☐  MUSIC
     /mnt/data/MUSIC

  ☐  Music
     /mnt/windows/Music

  ☐  Aerosmith (1973) [Dolby Atmos]
     /mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}

  [ Add another folder… ]

  [ Apply ]

  Nothing changes until you press Apply.
```

Markup: the header stays a `.mcs-set-row` so the settings search still finds it (`_initSettingsSearch` only inspects `.mcs-set-row`). Each folder is its own `<label class="mcs-set-row mcs-set-row-stack">` with the checkbox as the last child and the path as a `.mcs-set-hint` inside a wrapper — so searching "Aerosmith" in the settings box finds the row. The list container is `#slsk-share-list`, built as HTML strings through `esc()` with a single delegated click handler, exactly like `_initMaintenanceSettings` / `#maint-list` (`src/renderer.js:26640-26720`).

New ids: `#slsk-share-list`, `#slsk-share-add-btn`, `#slsk-share-apply-btn`, `#slsk-share-count`, `#slsk-share-text`. `#slsk-share-text` is kept (same id, same job) so nothing that references it breaks. `#slsk-share-mode` is deleted.

### Where the rows come from

The candidate list is built in main and handed over whole:

1. Every folder in `musicFolders` (three today).
2. The download folder from `_downloadDir()`.
3. Anything already in `slskShareFolders` that is in neither of the above — a folder he picked by hand keeps its row.

Rows are deduplicated by resolved path. A row's label is the folder's own name (`path.basename`); the full path is always on the second line, never truncated, never hidden in a tooltip.

### Adding and removing

**Adding** goes through a new channel `slsk-share-folder-pick`, which opens `dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose a folder to share' })` and then refuses the obviously wrong answers before returning:

- the filesystem root, `/home`, `/mnt`, `/media`, `/run`
- the home directory itself
- `~/Desktop`, `~/Documents`, `~/Downloads`, `~/.config`, `~/.ssh`, any dotfolder
- the slskd working directory

Copy on refusal (snackbar):

> **"That's your whole home folder — sharing it would put everything on this computer on Soulseek. Pick a music folder instead."**

and for the drive-root family:

> **"That's a whole drive. Pick the folder your music is actually in."**

Anything that passes is added to the list as a ticked row, not written anywhere yet. It goes into `slskShareFolders` only on Apply.

**Removing** is unticking. A hand-picked folder (one that is not a music folder and not the download folder) also gets an `✕` that takes its row off the list entirely, because an unticked row for a folder nothing else knows about is clutter. Music-folder and download-folder rows never get an `✕` — they belong to other parts of the app.

**A folder that is no longer there** gets its row painted as:

```
  ⚠  Aerosmith (1973) [Dolby Atmos]
     /mnt/windows/Music/Aerosmith (1973)…   — can't find this folder any more
                                                              [ Take it off the list ]
```

Copy: **"can't find this folder any more"**. Pressing the button drops it from the selection. A missing folder is never silently sent to the daemon; `shareDirs` filters it out and the row says so. This is what covers a removed music folder without a modal interrupting the folder-removal flow.

**A folder inside another ticked folder** is collapsed. This is live on your machine — `/mnt/windows/Music/Aerosmith…` sits inside `/mnt/windows/Music`. If both get ticked, the child's row shows, greyed:

> **"Already covered — this folder is inside /mnt/windows/Music, which you're sharing."**

and only the parent is written to the daemon. The pure module does the collapsing; the UI just repeats what the module decided.

### What happens to the old three-way mode

`slskShareMode` is read exactly once more, by a migration, and is then never written again. It stays in the store untouched so an older build still works if you ever roll back.

The migration lives in `src/slsk-share.js` as `fromLegacyMode(mode, musicFolders, downloadDir)` and runs the first time anything asks for `slskShareFolders` and finds it undefined:

| stored `slskShareMode` | migrates to `slskShareFolders` |
|---|---|
| `'library'` | `[musicFolders.filter(Boolean)[0]]` — **the first folder only**, not all of them |
| `'library'` with no music folders | `downloadDir ? [downloadDir] : []` |
| `'downloads'` | `downloadDir ? [downloadDir] : []` |
| `'off'` | `[]` |
| anything unrecognised | same as `'library'` (the old `DEFAULT`) |

Every row of that table reproduces exactly what `shareDirs()` returns today for the same inputs. **The invariant to pin in a test: for all five cases, the `shares.directories` block written after migration is byte-identical to the block written before it.** Nobody's setting changes meaning, and the upgrade itself triggers no rescan, because the file it writes is the file already on disk.

Your machine specifically: `'downloads'` → `['/mnt/data/MUSIC/Downloads']`. One ticked row, the same folder going out, same YAML.

The old `'off'` mode migrates to an empty tick list, which is the honest reading — you were sharing nothing, you still share nothing. It is **not** the same thing as the new off switch in section 2, and the copy under an empty list says so:

> **"You're not sharing anything. Soulseek still works — you can search and download — but a lot of people won't let you download from them if you share nothing back."**

### How the choice reaches the daemon

Unchanged plumbing, one widened function:

1. Apply → `slsk-share-folders-set({ folders })`.
2. `store.set('slskShareFolders', validated)`.
3. `writeSlskdConfig({ ...store.get('slskConfig', {}), downloadDir: _downloadDir() })`.
4. Inside `writeSlskdConfig`, line 1433 becomes `slskShare.shareDirs(store.get('slskShareFolders'), musicFolders, downloadDir)`. The YAML emitter at 1457-1459 already writes a list of N entries and needs no change at all.
5. If `slskdProc || slskdReady`: `stopSlskd()` then `await startSlskd()`.
6. Return `{ ok, folders, text, restarted }`.

`shareDirs` loses its one-directory ceiling. New signature and contract:

```
shareDirs(selection, musicFolders, downloadDir) -> string[]
  - selection is a string[]; anything else (undefined, a legacy mode string)
    is treated as "not migrated yet" and routed through fromLegacyMode
  - resolve, dedupe, drop empties
  - drop any entry nested inside another entry (parent wins)
  - the caller has already dropped missing folders; shareDirs does no I/O
```

The literal call string at `main.js:1433` that `test/music-wave6-ui.test.js:86` pins changes. That test gets edited deliberately in the same commit, with the new literal, plus the new assertion that the old one-folder line is gone.

Also add `slskShareFolders` to `papaRoots()` (`main.js:5511`) so `slsk-show-in-folder` works on a file in a shared folder that isn't a music folder. It goes into `papaRoots()` **only** — not `libRoots()`, not `libDeletableRoots()`, and nowhere near `musicFolders`. A shared folder therefore becomes readable and revealable, and gains no delete or move permission and no visibility to the LAN bridge on port 8765.

### What he is told about the rescan

The Apply button is dead until something is different from what's stored. Pressing it:

Button label while working: **"Reading your folders…"**

Inline under the list, replacing the hint:

> **"Soulseek is reading through the folders you picked so other people can find what's in them. A big library takes a few minutes. You don't have to wait here."**

If anything is downloading when he presses Apply, an extra line appears above the button *before* he presses it, so it is never a surprise:

> **"3 downloads are running. Changing this stops them and starts them again on their own — it can take a couple of minutes."**

(That claim is true and already engineered for: `dlTick` waits for two consecutive empty snapshots and `dlReconcileMissing` re-queues rather than abandoning, precisely because a share change bounces the daemon — see the comment block at `main.js:8892-8926`.)

When it comes back, snackbar:

> **"Sharing 2 folders."** — or **"Sharing 1 folder."** / **"Not sharing anything."**

And `#slsk-share-text` repaints from `describe(dirs)`:

> **"Other people can browse and download anything in these folders: /mnt/data/MUSIC/Downloads, /mnt/windows/Music. Images, logs and text files stay hidden."**

If the daemon does not come back, the honest version rather than a green tick:

> **"Your choice is saved, but Soulseek didn't come back up. It'll try again on its own in a minute."**

**Effort:** two days. Pure module + migration half a day, main-side handlers half a day, the list UI and its states a day.

---

## 2. Turning Soulseek off and on

### The thing it is not

Setting sharing to nothing already exists and does not do this. It empties the share list but leaves slskd running, signed in to the Soulseek network, downloading, answering searches with an empty share and holding the router port open. "Turn Soulseek off" means the app stops using the network.

### Where it lives

The **first row** of Settings → Soulseek, above Account — because it governs everything below it.

```
Use Soulseek                                              [✓]
On — you can search and download, and people can take files you share.
```

```
Use Soulseek                                              [ ]
Off — no searching, no downloading, nobody can take anything from you.
                                              [ Back on in an hour ]
```

```
Use Soulseek                                              [ ]
Off until 21:40 — it comes back on by itself.
                                                      [ Turn it on now ]
```

New ids: `#slsk-enabled`, `#slsk-enabled-text`, `#slsk-enabled-timer-btn`.

There is exactly one timed option — one hour — and it is a button next to the off state, not a menu. No countdown chips anywhere else.

### Turning it off

Confirm only when something is actually in flight (`_dlHasActive()` or `activeUploads > 0`):

> **"2 downloads are running and 1 person is taking a file from you. Turning Soulseek off stops all of it. Your downloads go back on the list and start again when you turn it back on."**
> `[ Turn it off ]`  `[ Leave it on ]`

Otherwise it just goes off, with the snackbar:

> **"Soulseek is off."** — or **"Soulseek is off. It'll come back on at 21:40."**

### How "off" is actually done

Two mechanisms, chosen by what is running, both ending in the same visible state:

**Daemon is running →** `DELETE /api/v0/server` (slskd's own disconnect: signs out of the Soulseek network, drops every transfer and every peer connection, leaves the process alive with its share index still in memory). Then stop the pollers. Then `safeSend('slskd-status-change', { connected: false, off: true })`.

Why disconnect and not kill: turning it back on in the same session costs about a second instead of the three-minute share rebuild recorded at `main.js:1820-1828`. That is the whole reason the switch is usable.

**The UPnP map at port 2234** stays while disconnected, because nothing is listening on it and re-mapping is the slow part. It is unmapped on a full stop and on quit, as today.

**Fallback, spelled out because it must not be a surprise:** if `DELETE /api/v0/server` is refused or missing on the installed daemon, fall back to `stopSlskd()`. The user sees the identical off state; the only difference is that turning it back on takes the usual few minutes and shows the existing amber "Soulseek starting…". This fallback is not a guess to be discovered in production — **verify the endpoint against the installed slskd 0.26.0 once during the build** (`DELETE` then `PUT /api/v0/server`, watch `GET /api/v0/server`) and, if it does not exist, ship the stop-and-start version only and change the copy to say turning it back on takes a couple of minutes. Do not ship a half-built disconnect path.

**Launch while off:** the daemon is not started at all. `main.js:2567` becomes `if (_slskEnabled() && fs.existsSync(SLSKD_BIN))`. So "off" survives a restart at zero cost, and turning it on after a launch costs the normal startup he already knows.

### Turning it back on

- Process alive → `PUT /api/v0/server`, then `waitForSlskd`-style confirmation via `GET /api/v0/server`, restart the pollers. Snackbar: **"Soulseek is back on."**
- No process → `startSlskd()`, the familiar amber **"Soulseek starting…"**, and: **"Turning Soulseek on. It reads through your shared folders first, which takes a few minutes."**

### What stops and what keeps working while it is off

Stops: searching, downloading, uploading, peer chat, peer presence, the upload-stats poll, the download tick's dispatch, the wishlist sweep's searches, the slskd auto-update check.

Keeps working: everything that isn't Soulseek. Your own library, playback, the queue, video, the LAN bridge for the phone's *library* browsing, Settings, the Sharing panel's record of what went out today.

The pollers get one shared gate rather than six edits. `dlStart()`, `slskUploadPollStart()`, `slskChatPollStart()` and the presence loop each begin with `if (!_slskEnabled()) return`, and `slsk-enabled-set` starts or stops them on the flip. Without this the logs fill with failures for a thing the user deliberately switched off.

### The seven restart paths, all gated

Every one of these currently starts the daemon with no preference consulted. Each gets `if (!_slskEnabled()) return` or the equivalent:

1. **Launch** — `main.js:2567`.
2. **The 60-second health supervisor** — `slskdHealthCheck()` at `main.js:1894`. First line becomes `if (!_slskEnabled()) return 'off'` — no ping, no failure count, no status push, no restart. This is the one that would otherwise resurrect a deliberately-off daemon within three minutes and log "slskd reconnected". The interval itself is never cleared (there is no stored handle), so the gate has to be inside the function.
3. **The weekly auto-updater's `startFn`** — `main.js:2099`. It also must not *check* for updates while off.
4. **`slsk-configure`** — `main.js:7918`. Saving an account while off saves the account and does not start anything.
5. **`slsk-setup`** — `main.js:7931`. Installing the daemon while off installs it and leaves it stopped.
6. **`slsk-set-download-dir`** — `main.js:10578`.
7. **`slsk-share-folders-set`** — the new handler from section 1. Changing what's shared while off saves the choice and applies it next time it comes on. The Apply copy while off reads: **"Saved. It takes effect when you turn Soulseek back on."**

Plus an eighth, which is not a restart but undoes the off just as effectively: **`slskRunSearch`'s self-heal** at `main.js:8098-8103` re-probes `/application` and re-authenticates when `!slskdReady`. It gets the gate too, and throws the off-shaped error instead.

### What every other surface says

The three he will hit within a minute of switching off are **part of this work, not optional**:

**Search (`_slskErrText`, `src/renderer.js:124`)** — a new branch before the existing ones. Instead of "Soulseek is not connected.":

> **"Soulseek is off. Turn it on to search for music."**  `[ Turn Soulseek on ]`

The button flips the switch from where he is standing. He does not get sent to Settings to undo something he just did.

**Downloads page (`_dlRenderDaemonDown`, `src/renderer.js:29032`)** — not the red "Can't reach the Soulseek daemon" with a Retry that retries nothing:

> **"Soulseek is off. Your downloads are waiting — they start again when you turn it back on."**  `[ Turn Soulseek on ]`

**Footer dot (`_setSlskStatus` / `_paintSlskConnDot`, `src/renderer.js:28957-28987)`** — a fourth state. `state.connectionStatus.slskd` gains `'off'`, painted grey (not red), label **" Soulseek off"**. Red means something is wrong; this is not wrong.

Downloads queued while off still enqueue successfully — that behaviour is fine — but the Downloads banner above now tells him why nothing is moving, which is the part that was missing.

**Hub row (`src/renderer.js:31538`)** — its "Connect" button today only re-reads status and opens the account modal. While off it reads **"Off"** and its button becomes **"Turn on"** and actually turns it on.

The quieter seven surfaces are grouped as an optional sweep in section 4.4.

### What is persisted

`slskdEnabled` (boolean, default `true`) and `slskdOffUntil` (epoch ms or `null`). On launch, if `slskdOffUntil` is in the past, it is cleared and `slskdEnabled` flips back to `true` before the launch gate is consulted — so a timed off that expired while the app was closed comes back on, as promised. The one-hour timer is a single `setTimeout` plus that launch check; there is no ticking state to keep in sync.

**Effort:** two days. The switch and the gates a day, the disconnect/reconnect path and its verification half a day, the three mandatory copy branches half a day.

---

## 3. A slow connection

### The single control that is the real answer

**A cap on how fast other people can take files from you, plus a limit on how many can do it at once.** Not the off switch, not an automatic detector.

Why this and not the others: the app writes no `transfers:` block into `slskd.yml` at all, so the daemon runs its own defaults — verified against the installed binary (`slskd 0.26.0.0`, `--help`): **10 upload slots and no speed limit whatsoever** (`--upload-speed-limit` default `2147483647`). Ten strangers pulling FLAC at full tilt will flatten a home upstream, and a flattened upstream slows his *downloads* too, because the acknowledgements his downloads depend on cannot get out. A cap fixes the cause. The off switch is a lever he pulls after he is already annoyed; this stops him being annoyed.

### The control

In Settings → Soulseek, below the folder list:

```
Go easy on my connection

  How many people can take files at once      [ 4 ]
  How fast, all together (MB/s)               [     ]  Unlimited

  Right now: 4 people at a time, no speed limit.
  Lower these if Soulseek is making the rest of your internet slow.
```

New ids: `#slsk-upload-slots`, `#slsk-upload-mbps`, `#slsk-upload-text`.

### The numbers

Stored as `slskUploadLimit: { slots: number, mbps: number }`, default `{ slots: 4, mbps: 0 }` (`0` = no speed cap).

**This default is a deliberate change from today and the reason must be on the record:** slots drop from slskd's 10 to 4. It is strictly gentler than what his machine does now and cannot make anything worse — four people still get files, each of them faster. The speed cap ships **off**, because a wrong number here *can* make things worse: throttled uploads make peers give up on him, which costs him the standing he needs for downloads. A cap is his to choose; a sane slot count is ours to ship. If he would rather nothing at all changed without his say-so, the default is one line to set back to 10.

**Units, settled once, because the app currently contradicts itself in three places:** every speed box in Papa Audio is **MB/s, megabytes per second, 1 MB = 1,000,000 bytes**, shown with one decimal. Conversion at the edges:

- slskd's `speed_limit` is kibibytes/second → `Math.round(mbps * 1000000 / 1024)`.
- The torrent throttle takes bytes/second → `Math.round(mbps * 1000000)`.

No box anywhere says "Kbps" after this.

### Live or restart

Written into `slskd.yml`:

```yaml
transfers:
  upload:
    slots: 4
    speed_limit: 977        # omitted entirely when there is no cap
```

slskd watches its own config file (`flags.no_config_watch` defaults to `false`), so the change should take hold without a restart. **That must be measured, not assumed** — the app already has one lie on screen from assuming the opposite. Build-time check: set a low cap while an upload is running and watch `averageSpeed` in `GET /transfers/uploads`.

Two outcomes, both with their copy written now:

**It takes hold live** — the row's line reads, after a change:

> **"Saved. It's in force now."**

and `slsk-upload-limit-set` returns `{ applied: 'live' }`.

**It does not** — no silent half-measure, no fake tick:

> **"Saved. It takes effect the next time Soulseek starts."**  `[ Restart Soulseek now ]`

and the handler returns `{ applied: 'needsRestart' }`. The button does the usual `stopSlskd()` + `startSlskd()` with the same "reading your folders, a few minutes" warning as Apply in section 1.

### Automatic detection is rejected

The app cannot tell the difference between "his line is choked" and "that peer is slow". The only numbers it holds are per-transfer `averageSpeed` values from `/transfers/uploads`, and those look identical in both cases. An auto-pause built on that fires when nothing is wrong and sits silent when something is — and it acts without being asked, which is the exact behaviour he has been burned by. There is no honest signal, so there is no automatic anything. If he wants Soulseek to back off, he types a number or flips the switch, and it does what he typed.

**Effort:** a day. The YAML block and the two handlers half a day, the row and its two applied-states half a day.

---

## 4. The rest, in order

Each of these is independently buildable and shippable on its own — none depends on another, and none depends on sections 1–3 beyond the plumbing those sections add. Pick any subset, in any order.

### 4.1 Stop the Downloads-page speed box from lying — *independently buildable*

Two false things are on screen today. The box labelled "Day limit (Kbps)" stores kilo**bytes** (`limitToBytesPerSec` multiplies by 1000) while the hint under it divides by 8192 as if it were kilo**bits** — type 1000 and you get a real 1 MB/s cap under a hint saying "≈0.12 MB/s". And the whole panel claims "a Soulseek change needs a restart" while doing nothing for Soulseek in either direction.

**What he sees:** the two boxes are relabelled **"Day limit (MB/s)"** and **"Night limit (MB/s)"** and take a decimal; the hint under each shows the same number back in words. The panel hint becomes: **"Slows video downloads during the day and opens up at night. Soulseek has its own limit in Settings → Soulseek."**

**Where:** `src/renderer.js:31286-31298` (markup), `31126` (the `mbHint` helper), and `main.js:10065` where `slskdNeedsRestart: true` becomes `false`.

**No migration:** the stored key `dayLimitKbps` and its meaning (kilobytes/second) do not change. The box simply shows `stored / 1000` and stores `Math.round(entered * 1000)`. Existing values keep working untouched.

**Effort:** half a day.

### 4.2 Settings re-reads what is actually shared every time it opens — *independently buildable*

`_initSharingSettings()` runs once, at boot, inside `initPlaybackSettings()` (`src/renderer.js:1509 → 27163`). Opening Settings re-reads nothing. So the sentence naming his shared folder can describe a folder he removed weeks ago, and after adding a music folder in the sidebar the Soulseek block is already out of date.

**What he sees:** nothing new — the block is simply correct whenever he looks at it.

**Where:** `_switchMcsTab('settings')` (`src/renderer.js:25448`) already runs `_startStorageHealthPoll()` and `_refreshDiagnostics()` on the settings tab; it gains `_repaintSharingSettings()` — a repaint-only function split out of `_initSharingSettings` that re-reads state and repaints, wiring nothing twice.

**While here, fix the guard trap:** the early return at `src/renderer.js:27217` is the last statement-level guard in the function, and anything wired below it is dead when the API is missing. The file already carries a comment recording that this was hit once. Narrow it so it guards only the share block, and keep new wiring above it.

**Effort:** half a day. It is near-free and everything else in this document reads better on top of it.

### 4.3 Stop handing strangers his documents, videos and archives — *independently buildable*

Only five extensions are hidden from peers today: `.jpg .png .log .cue .txt` (`main.js:1461-1465`). Every PDF, ZIP, MP4, spreadsheet, `.kdbx`, `.sqlite` or stray installer sitting anywhere inside a shared folder is browsable and downloadable by strangers right now. This is a hole he would never guess exists, and closing it needs no new setting and no new UI.

**What he sees:** one changed sentence in the share hint — **"Images, logs, text files, documents, archives and video stay hidden."** — and nothing else.

**Where:** the `filters` list in `writeSlskdConfig`. Two tiers, so the debatable one is a visible decision and not a smuggled-in surprise:

*Not arguable — documents, archives, programs, keys, databases:*
`\.pdf$ \.docx?$ \.xlsx?$ \.pptx?$ \.odt$ \.ods$ \.zip$ \.rar$ \.7z$ \.tar$ \.gz$ \.iso$ \.exe$ \.msi$ \.dmg$ \.deb$ \.rpm$ \.sh$ \.bat$ \.pem$ \.kdbx$ \.sqlite$ \.db$ \.ini$ \.url$ \.lnk$ Thumbs\.db$ \.DS_Store$`

*Arguable — video, and the one line to delete if he wants music videos shared:*
`\.mp4$ \.mkv$ \.avi$ \.mov$ \.m4v$ \.webm$ \.wmv$`

Deliberately **not** done: turning this into an allow-list of "actual music files only". An unusual format he owns would silently stop being shared, which is the precise class of silent failure he hates. The list stays a block-list.

**Note on cost:** changing the filters means a daemon restart and a rescan, so if this ships alongside the folder picker it should ride the same Apply rather than paying its own bounce.

**Effort:** an hour for the list, half a day with the copy and the test.

### 4.4 The quieter screens stop calling a deliberate off a failure — *independently buildable, but only meaningful once section 2 exists*

Section 2 covers the three he hits immediately (search, Downloads, the footer dot). Seven more currently shout red:

Settings account line (`renderer.js:27180` "Could not reach the Soulseek daemon.") → **"Soulseek is off."** · Sharing panel (`renderer.js:29476`) → **"Soulseek is off — nobody can take anything from you right now."** · Sharing row tooltip (`renderer.js:29385`) → **"Soulseek is off."** · Peers list (`main.js:11491` `serverOffline`) → **"Soulseek is off"** instead of everyone showing Unknown · Assistant welcome (`renderer.js:25503`) → **"Soulseek is off, so downloading is off until you turn it back on."** · The auto-updater skips silently instead of reporting a failure · The LAN bridge answers the phone with a sentence instead of a bare `502 slskd unreachable`: **"Soulseek is turned off on the computer."**

That last one matters — the bridge is a separate process on port 8765 and knows nothing about any app-side switch, so it needs its own read of the flag or a small status endpoint.

**Effort:** a day, mostly the bridge.

### 4.5 The Sharing row stops hiding itself and shows one live total — *independently buildable*

`_paintSharingPill` hides the entire `#nav-sharing` row when nothing is moving and nothing went out today (`src/renderer.js:29436-29443`). So a man sharing 30,000 tracks sees exactly what a man sharing nothing sees: an empty space. At the moment he asks "is Soulseek why my internet is slow", there is nothing on screen to answer him.

**What he sees:** the row is always there when sharing is on. Three states, all from the poll that already runs at 60 seconds with `{cachedOk:true}` — no new requests:

- Someone taking something: **↑ 2** (as today)
- Nothing now, something today: **12 today** (as today)
- Nothing at all: **Sharing** — a calm, muted standing line, no number
- Sharing switched off or nothing ticked: **Sharing off** — muted

**Where:** `sharingPill()` in `src/transfer-indicator.js:130` returns an idle object instead of `null`, and `_paintSharingPill` stops setting `row.hidden = true`. All the text stays in the pure module, as now.

**Effort:** half a day.

---

## Data and plumbing

### Stored keys (electron-store, `~/.config/papa-audio/config.json`, mode 0600)

| Key | Shape | Default | Migration |
|---|---|---|---|
| `slskShareFolders` | `string[]` of absolute paths | derived | On first read when undefined: `fromLegacyMode(store.get('slskShareMode'), musicFolders, _downloadDir())`, per the table in section 1. Must produce a byte-identical `shares.directories` block. |
| `slskShareMode` | `'library'｜'downloads'｜'off'` | `'library'` | **Kept, read by the migration, never written again.** Left in place so a rollback still works. |
| `slskdEnabled` | boolean | `true` | Absent = `true` = today's behaviour. |
| `slskdOffUntil` | number (epoch ms) or `null` | `null` | Cleared on launch when in the past, before the launch gate reads `slskdEnabled`. |
| `slskUploadLimit` | `{ slots: number, mbps: number }` | `{ slots: 4, mbps: 0 }` | Absent = the default, which **changes upload slots from slskd's 10 to 4**. Deliberate; reasoned in section 3. |
| `slskSchedulerConfig.schedule.dayLimitKbps` / `.nightLimitKbps` | number, kilobytes/second | unchanged | **No migration.** The stored unit is untouched; only the box's label and arithmetic change (4.1). |

### New IPC handlers

All five carry `if (DRY_RUN) return _dryRunRefusal('…')`, all five get a `0` entry in `IPC_TIMEOUT_OVERRIDES` (`main.js:141`), and all five go into `GATED_CHANNELS` in `test/helpers/lift-ipc.js` and the ARGS/EFFECT maps in `test/dry-run-mode.test.js`. Two of them open a native dialog or restart the daemon, which `test/main-guards.test.js:122-136` enforces automatically.

```
slsk-share-folders-get  ()
  -> { ok: true,
       selected:   string[],
       candidates: [{ path, label, source: 'music'|'download'|'custom',
                      selected: boolean, missing: boolean,
                      coveredBy: string|null }],
       text:       string,
       migrated:   boolean }

slsk-share-folders-set  ({ folders: string[] })
  -> { ok: true, folders: string[], text: string, restarted: boolean }
   |  { ok: false, dryRun: true, error: 'Dry run — changing what is shared was not performed' }
   |  { ok: false, error: string }          // daemon did not come back

slsk-share-folder-pick  ()                   // opens the native folder chooser
  -> { ok: true, path: string }
   |  { ok: false, cancelled: true }
   |  { ok: false, refused: true, error: string }   // home dir, drive root, dotfolder

slsk-enabled-get  ()
  -> { ok: true, enabled: boolean, offUntil: number|null,
       running: boolean, connected: boolean }

slsk-enabled-set  ({ enabled: boolean, forMinutes?: number })
  -> { ok: true, enabled, offUntil: number|null,
       method: 'disconnected'|'stopped'|'reconnected'|'started',
       restarted: boolean }
   |  { ok: false, dryRun: true, error: 'Dry run — turning Soulseek off was not performed' }

slsk-upload-limit-get  ()
  -> { ok: true, slots: number, mbps: number, text: string }

slsk-upload-limit-set  ({ slots?: number, mbps?: number })
  -> { ok: true, slots, mbps, applied: 'live'|'needsRestart', text: string }
   |  { ok: false, dryRun: true, error: '…' }
```

`slsk-share-mode-get` / `slsk-share-mode-set` are deleted, and their preload bindings with them.

### Changed IPC

```
slsk-status  ()
  -> gains `enabled: boolean` and `offUntil: number|null`.
     Renderer's state.connectionStatus.slskd gains a fourth value: 'off'.

slsk-schedule-set  (patch)
  -> slskdNeedsRestart changes from hardcoded `true` to `false`.   (4.1)
```

### New preload bindings (`preload.js`)

`slskShareFoldersGet()`, `slskShareFoldersSet(p)`, `slskShareFolderPick()`, `slskEnabledGet()`, `slskEnabledSet(p)`, `slskUploadLimitGet()`, `slskUploadLimitSet(p)`. `slskShareModeGet` / `slskShareModeSet` removed.

The `slskd-status-change` push payload gains `off: boolean`. The channel is already in the `window.api.on` allow-list at `preload.js:571`, so no new channel is needed — which is deliberate: a new channel that is not added to that list is silently dropped.

### Changes to the generated `slskd.yml`

```yaml
shares:
  directories:
    - "/mnt/data/MUSIC/Downloads"       # now N entries, from slskShareFolders
    - "/mnt/windows/Music"              #   (the emitter at main.js:1457 already
                                        #    handles a list; only shareDirs changes)
  filters:
    - \.jpg$                            # existing five
    - \.png$
    - \.log$
    - \.cue$
    - \.txt$
    - \.pdf$                            # 4.3 — documents, archives, programs,
    - …                                 #       keys, databases, video
transfers:                              # section 3 — entirely new block
  upload:
    slots: 4
    speed_limit: 977                    # kibibytes/s; key omitted when uncapped
```

Nothing else in the file changes. `listen_port`, `web.port`, the 14 rooms, the search throttling, the credentials and the logger level all stay exactly as they are.

### Restart or not

| Change | Daemon restart? |
|---|---|
| The upgrade itself (migration) | **No** — the file it writes is the file already there. |
| Ticking or unticking a folder | **No** — nothing is written until Apply. |
| Pressing Apply on the folder list | **Yes.** Full stop/start + share rescan, minutes on a big library. Warned before the press and during. |
| Changing the filter list (4.3) | **Yes**, same bounce and rescan. Ships with an Apply rather than alone. |
| Turning Soulseek off | **No** — `DELETE /api/v0/server` while the process lives. Falls back to a full stop only if that endpoint is unavailable. |
| Turning it back on, same session | **No** — `PUT /api/v0/server`, about a second. |
| Turning it on after a launch spent off | **Yes** — a normal start, the usual amber "Soulseek starting…". |
| Upload slots / speed cap | **To be measured.** slskd watches its own config file, so it should be live. Verified at build time, and if it is not live the setting says so and offers a restart button instead of pretending. |
| The schedule box relabel (4.1) | **No.** No stored value changes. |

---

## What this deliberately does not do

- **Pause by itself when it thinks the internet is slow** — the app cannot tell a choked line from a slow peer; it would fire when nothing is wrong and stay quiet when something is, without being asked.
- **Let his own downloads automatically take priority over uploads** — flaps several times an hour and is worthless unless changing the limit is free. Build the plain cap; if he still wants this in a month he will say so.
- **A "see yourself as other people see you" browser** — a whole new screen and a new daemon call to answer a question the folder list already answers.
- **Count and preview a folder's contents before sharing it** — counting 400 GB in a modal is a spinner he will learn to hate. Only the cheap half survives: the picker refuses his home folder, desktop and drive roots.
- **A "share music files only" switch** — flipping the block-list into an allow-list means an unusual format he owns silently stops being shared. The block-list gets extended instead.
- **A "never share these" list for sub-folders inside a shared folder** — real, but second-order once he can pick folders, and every entry costs another rescan. Wait until he names the folder he wants kept private.
- **Showing peers a made-up folder name instead of the real one** — over-built for one person's music player, it breaks paths anyone has queued against him, and almost nobody opens it.
- **A "stop sharing now" panic button with save-and-restore** — a third control doing what the folder list and the off switch already do, with hidden saved state to fall out of sync.
- **Undo on a share change** — a second multi-minute daemon bounce dressed up as a free click.
- **"214 new tracks since the last read"** — counting new files across a 400 GB library is harder than the problem it reports.
- **A "remove from sharing too?" prompt when he removes a music folder** — a modal in a flow that has nothing to do with sharing. The row saying "can't find this folder any more" covers it without interrupting him.
- **Countdown chips in the sidebar, Settings and the Sharing panel** — one "back on in an hour" button on the switch; three live countdowns are decoration with three ways to go stale.
- **Moving the day/night schedule under Soulseek and giving it an upload lane** — if the Soulseek half genuinely needs a restart, that is a rescan twice a day, worse than no schedule.
- **"Don't share anything below 320 kbps"** — the daemon filters on file paths, not bitrates. It would ship as a tick box that silently does nothing.
- **An "ease off for an hour" button** — duplicate of the cap plus the off switch, with more timed state to survive a restart.
- **Recording share state in the diagnostics bundle** — support plumbing for an audience of one who can read the setting directly.

---

## Tests

**Pure modules — Node tests with a mutation check on every one.** For each assertion below, revert the fix and confirm it goes red; if nothing goes red the test is decoration.

`test/slsk-share.test.js` — rewritten, not extended:

- `fromLegacyMode` for all five inputs from the section 1 table, including no-music-folders and the unrecognised-mode fallback.
- **The migration invariant, as its own test:** for each of the five legacy states, `shareDirs(fromLegacyMode(...), ...)` deep-equals today's `shareDirs(mode, ...)`. This is the test that proves nobody's setting changed meaning.
- `shareDirs` with many folders returns many; with none returns `[]`.
- Nested collapse: `['/mnt/windows/Music', '/mnt/windows/Music/Aerosmith (1973) [Dolby Atmos] {Aerosmith P&D - Sony}']` → the parent only. Use his real paths, spaces, brackets and braces included.
- Dedupe of `/a` and `/a/` and `/a/../a`.
- `describe()` for zero, one and several folders, and that the zero case carries the sentence about people refusing downloads to non-sharers.

New `test/slsk-share-picker.test.js` — the refusal predicate, pure: home dir, `/`, `/mnt`, `/media`, `~/Desktop`, `~/Documents`, `~/.config`, any dotfolder → refused; `/mnt/data/MUSIC` and a folder deep inside home → allowed.

New `test/slsk-upload-limit.test.js` — the unit conversion. `0 → key omitted`; `1.0 MB/s → 977 KiB/s`; `0.5 → 488`; negative and `NaN` → treated as no cap. And that slots clamp to 1–20.

`test/bandwidth-schedule.test.js` — unchanged (the stored unit does not change). Add one test that the renderer's MB/s hint and `limitToBytesPerSec` agree for the same stored number, which is the assertion that would have caught today's kilobits/kilobytes contradiction.

**IPC and wiring — text-level tests, this repo's existing style.**

`test/music-wave6-ui.test.js` — **edited deliberately in the same commit**, not worked around. The old pinned literal `slskShare.shareDirs(store.get('slskShareMode', slskShare.DEFAULT), musicFolders, downloadDir)` is replaced with the new call string; `id="slsk-share-mode"` and `<option value="off">Nothing</option>` are replaced with `id="slsk-share-list"`, `id="slsk-share-apply-btn"` and `id="slsk-enabled"`; the assertion that the old silent `musicFolders[0]` line is absent stays.

`test/settings-soulseek-section.test.js` — the slice between `id="soulseek-settings"` and `id="video-settings"` must contain `slsk-enabled` **first**, then `slsk-account-btn`, `slsk-folder-btn`, `slsk-share-list`, `slsk-share-apply-btn`, `slsk-upload-slots`.

`test/settings-focus-rings.test.js` — `slsk-share-mode` out; `slsk-enabled`, `slsk-share-apply-btn`, `slsk-share-add-btn`, `slsk-upload-slots`, `slsk-upload-mbps` in.

`test/main-guards.test.js` — already enforces that any handler mentioning `showOpenDialog` carries a `0` in `IPC_TIMEOUT_OVERRIDES`; it catches `slsk-share-folder-pick` for free. Add the explicit list assertion for the other four new channels.

`test/dry-run-mode.test.js` and `test/helpers/lift-ipc.js` — all five new write channels added to `GATED_CHANNELS`, with effect markers (`writeSlskdConfig` for the two share channels and the limit channel, `stopSlskd` for `slsk-enabled-set`). **Without this a dry-run QA twin writes the real `slskd.yml` and disconnects his real daemon** — the twin shares port 5030 with the live app.

New `test/slskd-enabled-gate.test.js` — the important one. Lift each of the seven restart paths plus `slskRunSearch`'s self-heal and assert each consults `_slskEnabled()`. Mutation-check every single one: delete the gate from `slskdHealthCheck` and that test must go red, because that is the path that would resurrect a deliberately-off daemon in three minutes.

New `test/slskd-health-restart.test.js` addition — `slskdHealthCheck()` with `slskdEnabled: false` returns `'off'`, performs no fetch, sends no status push, and leaves `_slskdFailures` untouched. Assert the counter directly, not through a `run` subshell.

New `test/slsk-share-migration.test.js` — a fake store seeded with `slskShareMode: 'downloads'` and his three real music folders, run `writeSlskdConfig` before and after the migration, and assert the two generated YAML strings are byte-identical.

**Live twin pass at the end, before anything is called done.** A green suite here is worth very little — the whole thing is a daemon that has to actually stop, actually come back, and actually re-index. One twin, one stripped profile with no credentials, killed by process group with the zero count printed afterwards:

1. Tick a second folder, Apply, and confirm `shares.directories` on disk has two entries and the daemon comes back.
2. Queue a download, press Apply mid-transfer, and confirm the file re-queues and finishes rather than vanishing.
3. Turn Soulseek off with something in flight; confirm the transfer stops, the footer goes grey not red, and **wait four full minutes** to confirm the health supervisor does not bring it back.
4. Turn it back on in the same session and time it — it should be seconds, not minutes.
5. Turn it off, quit, relaunch: confirm no slskd process starts.
6. Use "back on in an hour" with a shortened timer, quit before it expires, relaunch after: confirm it comes back on by itself.
7. Search while off and confirm the sentence is the off one with a working button, not "Soulseek is not connected."
8. Set an upload cap while someone is pulling a file and watch `averageSpeed` — this is the measurement that decides which of the two copy branches in section 3 ships.