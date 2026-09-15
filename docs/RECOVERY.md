# Recovery — when Papa Audio will not start, or an update went wrong

Written 2026-09-15 (roadmap 139). Everything here is a plain file you can copy.

## Where your data lives

| What | Where |
|---|---|
| Settings and every store (likes, playlists, history, queues, watch data) | the app's user-data folder: `~/.config/papa-audio/` on Linux, `~/Library/Application Support/papa-audio/` on macOS, `%APPDATA%\papa-audio\` on Windows |
| Daily logs | `<user-data>/logs/` |
| **Automatic backup taken before each update** | `<user-data>/migration-backups/papa-before-<new>-from-<old>-<date>.json` (newest three kept) |
| Scheduled backups (if turned on in Settings → Backup) | `~/Documents/PapaAudioBackups/` |
| Manual backups | wherever you saved them from Settings → Backup → Export |

Your music files are never inside any of these folders. Nothing here touches them.

## The update backup

The first time a new version launches it writes a complete backup of every
store into `migration-backups/` **before** it migrates or writes anything, then
records the version. If the app is fine after an update you never need it.

## If the app starts but something is missing after an update

1. Settings → Backup → **Restore from backup…**
2. Pick the newest `papa-before-…json` from `migration-backups/`.
3. Before each store is overwritten, a `<store>.<date>.bak` copy of the current
   value is written beside it, so a restore can itself be undone by hand.

## If the app will not start at all

1. Start it from a terminal so the reason is visible:
   `PAPA_LOG_LEVEL=debug ./launch.sh` (Linux) or run the binary directly.
   The last lines of `<user-data>/logs/<today>.log` say what failed.
2. Move — do not delete — the user-data folder aside:
   `mv ~/.config/papa-audio ~/.config/papa-audio.broken`
   The app now starts fresh (the setup wizard appears). Your music is untouched.
3. Restore your data: Settings → Backup → Restore from backup… and pick the
   newest file in `~/.config/papa-audio.broken/migration-backups/`.
4. If the restore itself fails, send `<user-data>/logs/` and the backup file
   with a bug report (Settings → Report a problem writes a scrubbed bundle).

## Going back to the previous version

Install the previous release from the releases page, then restore the newest
`papa-before-…` backup as above. Stores written by the newer version are
forward-compatible only where the migration notes say so; the backup is the
known-good state.
