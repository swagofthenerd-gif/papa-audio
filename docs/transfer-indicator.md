# Transfer indicator

The sidebar says what is moving, in both directions, without anyone having to
open a page to find out.

## The downloads pill

The Downloads row in the sidebar carries a small pill: `↓ 3` means three files
are actually coming in, `↓ 3 +12` means twelve more are queued behind them, and
`↓ +12` means everything is still waiting its turn. With nothing coming in the
pill disappears rather than sitting there showing zero. Files the scheduler is
still holding — asked for but not yet handed to slskd — are deliberately not
counted; the pill is about what is in flight, not what is on the wishlist. The
number is painted inside the downloads poll that already runs, from the
snapshot it already fetched, so the pill costs nothing extra.

## The Sharing row

A second sidebar row appears under Downloads only when there is something to
say: `↑ 2` while peers are pulling files out of your library, or a quiet
`14 today` once they have stopped but something went out during the day. On a
day where nobody took anything the row is not there at all. It refreshes every
minute, and that refresh asks the main process for its last upload poll rather
than making it ask the daemon again — so the sidebar never adds traffic of its
own. While the app window is hidden the refresh stops entirely.

## The sharing panel

Clicking the Sharing row slides out a panel, the same kind of slide-over as the
queue. Each line is one upload: who is taking it, the file name with its album
folder in small type underneath, a progress bar, and the speed. Live transfers
sort to the top so the ones being watched do not jump around. Under the list is
the day's sentence — "14 files to 3 people today · 2.1 GB" — and when nobody is
pulling anything the panel says so instead of showing an empty box. Clicking a
peer's name opens their library, because whoever is taking your files is often
worth browsing back. While the panel is open it refreshes every ten seconds so
the bars move; that stops the moment it closes, and Escape closes it.

## The day's counters

"Today" means the local calendar day, and it resets at midnight. Three numbers
are kept: bytes sent, distinct people served, and files delivered. A file counts
as delivered when the daemon reports it finished successfully — a cancelled or
errored transfer does not count — and each peer-and-file pair counts once, so a
finished transfer the daemon keeps reporting is not added again on every poll.
Once counted, a file stays counted for the rest of the day even after the daemon
drops the row.

## Where the code is

`src/transfer-indicator.js` is the pure half: it turns snapshots into the pill
text, the panel rows and the day sentence, and has no DOM or clock in it
(`test/transfer-indicator.test.js`). `src/upload-stats.js` holds the daily
counters and the midnight rollover (`test/upload-stats.test.js`). The main
process polls the daemon and answers the `slsk-upload-stats` channel; the
renderer paints. `test/transfer-indicator-ipc.test.js` pins the wiring on both
sides — that the pill rides the existing poll, that the refreshes are the two
timers they are supposed to be, and that everything a peer controls is escaped.
